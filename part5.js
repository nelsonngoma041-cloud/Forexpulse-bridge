function volLearn(t, profit) {
  volStats.n++; volStats.sum += profit; if (profit > 0) volStats.w++;
}

function volReport() {
  return '🌪 Volatile mode: ' + (volatileMode ? 'ON' : 'OFF') + ' (hourly ATR above ' + VOL_MULT + 'x its 100-hour average)\n' +
    (volStats.n ? 'Closed volatile-mode trades: ' + volStats.n + ', wins ' + volStats.w + ', net $' + volStats.sum.toFixed(2) : 'No volatile-mode trades closed yet.') +
    '\nUse /volatile on, /volatile off, or /volatiletest.';
}

function runVolatileTest() {
  if (!CAP_ON) return Promise.reject(new Error('Capital.com keys are missing.'));
  const errors = [];
  const MULTS = [1.5, 2.0];
  const strats = ST_STRATS;
  // acc[mult][strat] -> [train, val, oos]
  const acc = {};
  MULTS.forEach(function (m) {
    acc[m] = {};
    strats.forEach(function (s) { acc[m][s[0]] = [stNewAcc(), stNewAcc(), stNewAcc()]; });
  });
  const allRows = [];
  let used = [], bars = 0, hoursVol = 0, hoursAll = 0;
  return ST_MARKETS.reduce(function (chain, sym) {
    return chain.then(function () {
      return stFetchHistory(sym, STRAT_PAGES, errors).then(function (b) {
        if (b.length < 1000) { errors.push(sym + ': only ' + b.length + ' bars'); return null; }
        used.push(sym); bars += b.length;
        const D = stBuild(b);
        const split = [Math.floor(D.n * 0.5), Math.floor(D.n * 0.75)];
        for (let i = ST_WARM; i < D.n; i++) { hoursAll++; if (stIsVol(D, i, 1.5)) hoursVol++; }
        strats.forEach(function (s, si) {
          const sig = stSignals(s[0], D, 1000 + si * 77 + sym.length);
          MULTS.forEach(function (m) {
            const g = new Array(sig.length);
            for (let i = 0; i < sig.length; i++) g[i] = (i >= ST_WARM && sig[i] !== 0 && stIsVol(D, i, m)) ? sig[i] : 0;
            const rows = m === 1.5 ? [] : null;
            stSim(D, g, ST_VARIANTS[0], split, acc[m][s[0]], { overlap: 0, wideSpread: 0, noAtr: 0 }, rows, null, sym, s[1]);
            if (rows) rows.forEach(function (r) { allRows.push(r); });
          });
        });
        return new Promise(function (r) { setImmediate(r); });
      });
    });
  }, Promise.resolve()).then(function () {
    if (!used.length) throw new Error('No history could be loaded. ' + (errors[0] || ''));
    const msgs = [];
    msgs.push(['🌪 *' + md('Volatile-market test') + '*',
      md(used.length + ' markets, ' + bars + ' hourly bars. Only signals taken while hourly ATR is above 1.5x (and 2.0x) its 100-hour average. Same costs, stops (SL1.5 RR2) and train / validation / out-of-sample split as /strategytest.'),
      md('Volatile hours: ' + Math.round(100 * hoursVol / Math.max(1, hoursAll)) + '% of all hours (at 1.5x).')].join('\n'));
    const out = [];
    let lead = false;
    MULTS.forEach(function (m) {
      out.push('*' + md('ATR above ' + m + 'x: net R per trade, train | validation | out-of-sample') + '*');
      const pool = [stNewAcc(), stNewAcc(), stNewAcc()];
      strats.forEach(function (s) {
        const a = acc[m][s[0]];
        if (s[0] !== 'rand') for (let p = 0; p < 3; p++) { pool[p].n += a[p].n; pool[p].w += a[p].w; pool[p].sumR += a[p].sumR; pool[p].gp += a[p].gp; pool[p].gl += a[p].gl; }
        const f = function (x) { return x.n ? stF(stExp(x)) : 'none'; };
        out.push(md(s[1] + ': ' + f(a[0]) + ' | ' + f(a[1]) + ' | ' + f(a[2]) + '  (n ' + a[0].n + '/' + a[1].n + '/' + a[2].n + ')'));
      });
      const r = acc[m].rand;
      const pe = pool.map(stExp);
      const enough = pool[0].n >= 60 && pool[1].n >= 30 && pool[2].n >= 30;
      const good = enough && pe[0] >= 0.05 && pe[1] >= 0.05 && pe[2] >= 0.05 && stPF(pool[2]) >= 1.15 && pe[2] - stExp(r[2]) >= 0.05;
      if (good) lead = true;
      out.push(md('All 15 strategies pooled: ' + stF(pe[0]) + ' | ' + stF(pe[1]) + ' | ' + stF(pe[2]) + ' (n ' + pool[0].n + '/' + pool[1].n + '/' + pool[2].n + '), OOS PF ' + stPF(pool[2]).toFixed(2) + '. Random control OOS ' + stF(stExp(r[2])) + ' (n ' + r[2].n + '). ' + (enough ? (good ? 'LEAD ✅' : 'no edge') : 'too few trades to say')));
      out.push(md('Pooled trades overlap in time, so they are not independent.'));
      out.push('');
    });
    msgs.push(out.join('\n'));
    msgs.push(lead
      ? '*' + md('A lead was found. It is one test period, so confirm it with /volatile on for several weeks on demo before trusting it.') + '*'
      : '*' + md('Verdict: trading only in volatile conditions does not give a proven edge in this data. Samples are small, so this is also not proof it never works.') + '*');
    return { msgs: msgs, rows: allRows };
  });
}

// ---------- Strategy search: the bot builds and tests its own rules ----------
// /strategysearch combines simple conditions (trend, RSI, MACD, breakouts, hours...) into rules,
// evolves them on the TRAIN period only, picks finalists using the VALIDATION period, and tests
// the finalists once on the untouched OUT-OF-SAMPLE period. Only rules that pass every check
// are saved as "evolved" strategies. /evolved on lets the bot trade them on the Capital.com demo.
// The result can be "nothing found". That is an honest answer.

let evoRunning = false;
let evoOn = false;
let evoWinners = [];           // [{ id, c: [cond ids], m: 1|-1, name }]
const evoStats = { n: 0, w: 0, sum: 0 };
const evoSeen = {};            // market:hour already checked live
const EVO_POP = Number(process.env.EVO_POP || 80);
const EVO_GENS = Number(process.env.EVO_GENS || 10);
const EVO_SL = 1.5, EVO_RR = 2;
const EVO_HOLD_MIN = ST_MAXHOLD * 60;

// condition value at bar i: 1 = bullish only, -1 = bearish only, 2 = true for both sides, 0 = neither
const EVO_CONDS = [
  ['Price vs EMA200', function (D, i) { return D.c[i] > D.ema200[i] ? 1 : (D.c[i] < D.ema200[i] ? -1 : 0); }],
  ['EMA20 vs EMA50', function (D, i) { return D.ema20[i] > D.ema50[i] ? 1 : (D.ema20[i] < D.ema50[i] ? -1 : 0); }],
  ['4h trend', function (D, i) { return D.h4up[i]; }],
  ['RSI extreme 30/70', function (D, i) { return D.rsi[i] < 30 ? 1 : (D.rsi[i] > 70 ? -1 : 0); }],
  ['RSI zone 40/60', function (D, i) { return D.rsi[i] < 40 ? 1 : (D.rsi[i] > 60 ? -1 : 0); }],
  ['RSI vs 50', function (D, i) { return D.rsi[i] > 50 ? 1 : (D.rsi[i] < 50 ? -1 : 0); }],
  ['MACD histogram sign', function (D, i) { return D.hist[i] > 0 ? 1 : (D.hist[i] < 0 ? -1 : 0); }],
  ['MACD histogram rising', function (D, i) { return D.hist[i] > D.hist[i - 1] ? 1 : (D.hist[i] < D.hist[i - 1] ? -1 : 0); }],
  ['ADX above 20', function (D, i) { return D.adx[i] > 20 ? 2 : 0; }],
  ['ADX below 20', function (D, i) { return D.adx[i] < 20 ? 2 : 0; }],
  ['ATR rising', function (D, i) { return D.atr[i] > D.atr[i - 5] ? 2 : 0; }],
  ['Volatile (ATR 1.5x)', function (D, i) { return stIsVol(D, i, 1.5) ? 2 : 0; }],
  ['Close outside Bollinger (trend)', function (D, i) { return D.c[i] > D.bbU[i] ? 1 : (D.c[i] < D.bbL[i] ? -1 : 0); }],
  ['Close outside Bollinger (revert)', function (D, i) { return D.c[i] < D.bbL[i] ? 1 : (D.c[i] > D.bbU[i] ? -1 : 0); }],
  ['Donchian 20 breakout', function (D, i) { return D.c[i] > D.dHi[i] ? 1 : (D.c[i] < D.dLo[i] ? -1 : 0); }],
  ['Pullback to EMA50', function (D, i) {
    if (D.l[i] <= D.ema50[i] + 0.5 * D.atr[i] && D.c[i] > D.ema50[i]) return 1;
    if (D.h[i] >= D.ema50[i] - 0.5 * D.atr[i] && D.c[i] < D.ema50[i]) return -1;
    return 0; }],
  ['Candle direction', function (D, i) { return D.c[i] > D.o[i] ? 1 : (D.c[i] < D.o[i] ? -1 : 0); }],
  ['Strong candle body', function (D, i) {
    const r = D.h[i] - D.l[i]; if (!(r > 0)) return 0;
    if (Math.abs(D.c[i] - D.o[i]) / r < 0.6) return 0;
    return D.c[i] > D.o[i] ? 1 : -1; }],
  ['London and New York hours', function (D, i) { const h = new Date(D.bars[i].t).getUTCHours(); return h >= 7 && h < 17 ? 2 : 0; }],
  ['Asian hours', function (D, i) { const h = new Date(D.bars[i].t).getUTCHours(); return h < 7 ? 2 : 0; }],
  ['Ichimoku cloud', function (D, i) { return D.c[i] > D.cloudTop[i] ? 1 : (D.c[i] < D.cloudBot[i] ? -1 : 0); }],
  ['Previous-day break', function (D, i) { return D.c[i] > D.pdH[i] ? 1 : (D.c[i] < D.pdL[i] ? -1 : 0); }],
  ['Price vs Kijun', function (D, i) { return D.c[i] > D.kijun[i] ? 1 : (D.c[i] < D.kijun[i] ? -1 : 0); }],
  ['Momentum bar (1 ATR)', function (D, i) { const d = D.c[i] - D.c[i - 1]; return d > D.atr[i] ? 1 : (d < -D.atr[i] ? -1 : 0); }],
  ['10-bar breakout', function (D, i) { return D.c[i] > D.p10Hi[i] ? 1 : (D.c[i] < D.p10Lo[i] ? -1 : 0); }],
  ['5-bar momentum', function (D, i) { return D.c[i] > D.c[i - 5] ? 1 : (D.c[i] < D.c[i - 5] ? -1 : 0); }],
];

function evoName(g) {
  return (g.m > 0 ? 'FOLLOW: ' : 'FADE: ') + g.c.map(function (k) { return EVO_CONDS[k][0]; }).join(' + ');
}
function evoKey(g) { return g.m + ':' + g.c.slice().sort(function (a, b) { return a - b; }).join(','); }

// signal of a rule at bar i: +1 buy, -1 sell, 0 none
function evoSignalAt(D, g, i) {
  let bull = true, bear = true;
  for (let q = 0; q < g.c.length; q++) {
    const v = EVO_CONDS[g.c[q]][1](D, i);
    if (!(v === 1 || v === 2)) bull = false;
    if (!(v === -1 || v === 2)) bear = false;
    if (!bull && !bear) return 0;
  }
  if (bull && !bear) return g.m;
  if (bear && !bull) return -g.m;
  return 0;
}

function evoRand(o) { o.s = (o.s + 0x6D2B79F5) | 0; let t = Math.imul(o.s ^ (o.s >>> 15), 1 | o.s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }

function evoRandomGenome(R) {
  const size = evoRand(R) < 0.6 ? 2 : 3;
  const set = {};
  while (Object.keys(set).length < size) set[Math.floor(evoRand(R) * EVO_CONDS.length)] = true;
  return { c: Object.keys(set).map(Number).sort(function (a, b) { return a - b; }), m: evoRand(R) < 0.5 ? 1 : -1 };
}

function evoBreed(a, b, R) {
  const pool = {};
  a.c.concat(b.c).forEach(function (k) { pool[k] = true; });
  let keys = Object.keys(pool).map(Number);
  const size = Math.max(2, Math.min(3, evoRand(R) < 0.5 ? a.c.length : b.c.length));
  const out = {};
  while (Object.keys(out).length < Math.min(size, keys.length)) out[keys[Math.floor(evoRand(R) * keys.length)]] = true;
  let c = Object.keys(out).map(Number);
  if (evoRand(R) < 0.35) c[Math.floor(evoRand(R) * c.length)] = Math.floor(evoRand(R) * EVO_CONDS.length);
  c = c.filter(function (v, i) { return c.indexOf(v) === i; });
  while (c.length < 2) { const k = Math.floor(evoRand(R) * EVO_CONDS.length); if (c.indexOf(k) < 0) c.push(k); }
  return { c: c.sort(function (x, y) { return x - y; }), m: evoRand(R) < 0.1 ? -(evoRand(R) < 0.5 ? a.m : b.m) : (evoRand(R) < 0.5 ? a.m : b.m) };
}

// run one rule on every market; returns per-market accumulators [train, validation, oos]
function evoEval(g, mk, withRows) {
  const per = [], rows = [];
  mk.forEach(function (M) {
    const D = M.D;
    const sig = new Int8Array(D.n);
    for (let i = ST_WARM; i < D.n; i++) sig[i] = evoSignalAt(D, g, i);
    const acc = [stNewAcc(), stNewAcc(), stNewAcc()];
    const r = withRows ? [] : null;
    stSim(D, sig, { sl: EVO_SL, rr: EVO_RR }, M.split, acc, { overlap: 0, wideSpread: 0, noAtr: 0 }, r, null, M.sym, 'evo');
    per.push(acc);
    if (r) r.forEach(function (x) { rows.push(x); });
  });
  const pool = [stNewAcc(), stNewAcc(), stNewAcc()];
  per.forEach(function (acc) {
    for (let p = 0; p < 3; p++) { pool[p].n += acc[p].n; pool[p].w += acc[p].w; pool[p].sumR += acc[p].sumR; pool[p].gp += acc[p].gp; pool[p].gl += acc[p].gl; }
  });
  return { pool: pool, per: per, rows: rows };
}

function evoTstat(rows, period) {
  const xs = rows.filter(function (r) { return r.p === period; }).map(function (r) { return r.r; });
  if (xs.length < 2) return 0;
  const m = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
  const v = xs.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (xs.length - 1);
  return v > 0 ? m / Math.sqrt(v / xs.length) : 0;
}

function runStrategySearch() {
  if (!CAP_ON) return Promise.reject(new Error('Capital.com keys are missing.'));
  const errors = [], mk = [];
  return ST_MARKETS.reduce(function (chain, sym) {
    return chain.then(function () {
      return stFetchHistory(sym, STRAT_PAGES, errors).then(function (b) {
        if (b.length < 1000) { errors.push(sym + ': only ' + b.length + ' bars'); return null; }
        const D = stBuild(b);
        mk.push({ sym: sym, D: D, split: [Math.floor(D.n * 0.5), Math.floor(D.n * 0.75)] });
        return new Promise(function (r) { setImmediate(r); });
      });
    });
  }, Promise.resolve()).then(function () {
    if (!mk.length) throw new Error('No history could be loaded. ' + (errors[0] || ''));
    const R = { s: 4242 };
    const cache = {};
    const evalG = function (g) {
      const k = evoKey(g);
      if (!cache[k]) cache[k] = { g: g, e: evoEval(g, mk, false) };
      return cache[k];
    };
    // fitness uses the TRAIN period only
    const fit = function (r) { const t = r.e.pool[0]; return t.n < 60 ? -9 : stExp(t) - 0.01 * (r.g.c.length - 2); };
    let pop = [];
    for (let i = 0; i < EVO_POP; i++) pop.push(evalG(evoRandomGenome(R)));
    for (let gen = 0; gen < EVO_GENS; gen++) {
      pop.sort(function (a, b) { return fit(b) - fit(a); });
      const keep = pop.slice(0, Math.floor(EVO_POP / 2));
      const kids = [];
      while (kids.length < EVO_POP - keep.length) {
        const a = keep[Math.floor(evoRand(R) * keep.length)], b = keep[Math.floor(evoRand(R) * keep.length)];
        kids.push(evalG(evoBreed(a.g, b.g, R)));
      }
      pop = keep.concat(kids);
    }
    const all = Object.keys(cache).map(function (k) { return cache[k]; });
    const tried = all.length;
    all.sort(function (a, b) { return fit(b) - fit(a); });
    const top = all.filter(function (r) { return fit(r) > -9; }).slice(0, 15);
    const avg = function (list, p) { return list.length ? list.reduce(function (s, r) { return s + stExp(r.e.pool[p]); }, 0) / list.length : 0; };
    // random-entry control, pooled
    const ctl = stNewAcc();
    mk.forEach(function (M, si) {
      const sig = stSignals('rand', M.D, 999 + si);
      const acc = [stNewAcc(), stNewAcc(), stNewAcc()];
      stSim(M.D, sig, { sl: EVO_SL, rr: EVO_RR }, M.split, acc, { overlap: 0, wideSpread: 0, noAtr: 0 }, null, null, M.sym, 'rand');
      ctl.n += acc[2].n; ctl.sumR += acc[2].sumR;
    });
    const ctlExp = stExp(ctl);
    // finalists: chosen with train and validation only
    const fin = top.filter(function (r) { return r.e.pool[1].n >= 30 && stExp(r.e.pool[1]) >= 0.03 && stExp(r.e.pool[0]) >= 0.03; })
      .sort(function (a, b) { return (stExp(b.e.pool[0]) + stExp(b.e.pool[1])) - (stExp(a.e.pool[0]) + stExp(a.e.pool[1])); }).slice(0, 3);

    const msgs = [];
    msgs.push(['🧬 *' + md('Strategy search') + '*',
      md(mk.length + ' markets, hourly. ' + tried + ' rules tried (' + EVO_GENS + ' generations of ' + EVO_POP + '), evolved on the train period only.'),
      md('Fixed stop 1.5x ATR, target 2x the stop. Real spread + ' + STRAT_SLIP + 'x slippage. Rules are 2 or 3 simple conditions.')].join('\n'));
    msgs.push(['*' + md('Honesty check: the 15 best rules on train, how they did on data they never saw') + '*',
      md('Train ' + stF(avg(top, 0)) + 'R | validation ' + stF(avg(top, 1)) + 'R | out-of-sample ' + stF(avg(top, 2)) + 'R per trade'),
      md('If the later two are far below train, the search is mostly finding luck. Random entries out-of-sample: ' + stF(ctlExp) + 'R.')].join('\n'));
    const lines = [];
    const passed = [];
    if (!fin.length) {
      lines.push('*' + md('No rule held up on validation (needed at least +0.03R in train and validation with 30+ trades). Nothing to test out-of-sample.') + '*');
    } else {
      lines.push('*' + md('Finalists (picked without looking at out-of-sample)') + '*');
      fin.forEach(function (r) {
        const full = evoEval(r.g, mk, true);
        const o = full.pool[2], t = evoTstat(full.rows, 2);
        const posM = full.per.filter(function (acc) { return stExp(acc[2]) > 0; }).length;
        const ok = o.n >= 30 && stExp(o) >= 0.05 && stPF(o) >= 1.15 && t >= 2 && stExp(o) - ctlExp >= 0.05 && posM >= Math.ceil(mk.length * 2 / 3);
        lines.push(md(evoName(r.g)));
        lines.push(md('  train ' + stF(stExp(full.pool[0])) + ' | validation ' + stF(stExp(full.pool[1])) + ' | out-of-sample ' + stF(stExp(o)) + 'R (n ' + full.pool[0].n + '/' + full.pool[1].n + '/' + o.n + '), OOS PF ' + stPF(o).toFixed(2) + ', t ' + t.toFixed(1) + ', ' + posM + '/' + mk.length + ' markets positive -> ' + (ok ? 'PASS ✅' : 'fail')));
        if (ok) passed.push(r.g);
      });
    }
    msgs.push(lines.join('\n'));
    if (passed.length) {
      evoWinners = passed.map(function (g, i) { return { id: 'E' + (i + 1), c: g.c, m: g.m, name: evoName(g) }; });
      msgs.push('*' + md('Saved ' + evoWinners.length + ' evolved rule(s). Send /evolved on to let the bot trade them on the Capital.com demo. They are forgotten if Render restarts unless you re-run /strategysearch. This is one test period, so treat it as a lead and watch the demo results.') + '*');
    } else {
      msgs.push('*' + md('Verdict: nothing passed every check. No evolved strategy was saved. Do not trade these results.') + '*');
    }
    return { msgs: msgs };
  });
}

// ----- live use of evolved rules (Capital.com demo only) -----
function evoReport() {
  const l = ['🧬 Evolved strategies: ' + (evoOn ? 'ON' : 'OFF')];
  if (!evoWinners.length) l.push('No saved rules. Run /strategysearch first.');
  evoWinners.forEach(function (w) { l.push(w.id + ': ' + w.name); });
  l.push(evoStats.n ? 'Closed trades: ' + evoStats.n + ', wins ' + evoStats.w + ', net $' + evoStats.sum.toFixed(2) : 'No evolved trades closed yet.');
  l.push('Use /evolved on or /evolved off. Stop 1.5x hourly ATR, target 2x, held up to ' + ST_MAXHOLD + ' hours.');
  return l.join('\n');
}

function evoLearn(t, profit) {
  evoStats.n++; evoStats.sum += profit; if (profit > 0) evoStats.w++;
}

function evoLiveBars(symbol) {
  return capEpic(symbol).then(function (epic) { return capCall('GET', '/prices/' + epic + '?resolution=HOUR&max=300'); }).then(function (j) {
    const m = function (o) { return (Number(o.bid) + Number(o.ask)) / 2; };
    const arr = (j.prices || []).map(function (x) {
      return { t: Date.parse((x.snapshotTimeUTC || x.snapshotTime) + 'Z'), o: m(x.openPrice), h: m(x.highPrice), l: m(x.lowPrice), c: m(x.closePrice), sp: Math.abs(Number(x.openPrice.ask) - Number(x.openPrice.bid)) };
    }).filter(function (b) { return !isNaN(b.t) && b.h > 0; }).sort(function (a, b) { return a.t - b.t; });
    return arr;
  });
}

function maybeEvolvedTrade() {
  if (!evoOn || !evoWinners.length || !autoTrade || !CAP_ON || tradeBroker === 'deriv' || circuitOpen) return Promise.resolve();
  const now = new Date();
  if (now.getUTCMinutes() < 1 || now.getUTCMinutes() > 20) return Promise.resolve();   // act just after the hour closes
  const hourId = Math.floor(now.getTime() / 3600000);
  return ST_MARKETS.reduce(function (chain, sym) {
    return chain.then(function () {
      const key = sym + ':' + hourId;
      if (evoSeen[key]) return null;
      evoSeen[key] = true;
      const pair = PAIRS.filter(function (p) { return p.symbol === sym; })[0];
      if (!pair || pendingTrades.some(function (t) { return t.display === pair.display; }) || pendingTrades.length >= 6) return null;
      if (newsBlock(sym)) return null;
      return evoLiveBars(sym).then(function (bars) {
        if (bars.length < 260) return null;
        const D = stBuild(bars);
        const i = D.n - 2;   // last completed hour
        if (Date.now() - bars[i].t > 2.5 * 3600000) return null;   // stale data
        if (D.medSp > 0 && D.sp[D.n - 1] > 3 * D.medSp) return null;
        let hit = null, dir = 0;
        for (let q = 0; q < evoWinners.length && !hit; q++) {
          const s = evoSignalAt(D, evoWinners[q], i);
          if (s !== 0) { hit = evoWinners[q]; dir = s; }
        }
        if (!hit || !(D.atr[i] > 0)) return null;
        const action = dir > 0 ? 'BUY' : 'SELL';
        return capitalTrade(sym, action, { sl: EVO_SL * D.atr[i], rr: EVO_RR }).then(function (t) {
          tradesToday++;
          pendingTrades.push({
            contractId: t.dealId, display: pair.display, symbol: sym, action: action,
            placedAt: Date.now(), votes: {}, minutes: EVO_HOLD_MIN, holdMin: EVO_HOLD_MIN, broker: 'capital', evoId: hit.id,
          });
          dbInsertTrade({
            contract_id: String(t.dealId), symbol: sym, action: action, confidence: 0, votes: {}, rsi: 0,
            hour: lusakaHour(), stake: Number(t.riskUsd.toFixed(2)), demo: true,
          });
          return sendTelegram(
            '🧬 *EVOLVED TRADE — ' + md(pair.display) + '* \\(Capital demo\\)\n\n' +
            md(hit.name) + '\n' + md(action) + ' · size ' + md(t.size) + ' · risk about $' + md(t.riskUsd.toFixed(2)) + '\n' +
            'Stop loss: ' + md(t.sl.toPrecision(4)) + ' away · Take profit: ' + md(t.tp.toPrecision(4)) + ' away'
          );
        });
      }).catch(function (e) { console.log('Evolved ' + sym + ': ' + e.message); return null; });
    });
  }, Promise.resolve());
}

function sendLong(text) {
  if (text.length <= 3800) return sendTelegram(text);
  const lines = text.split('\n');
  let chunk = '', chain = Promise.resolve();
  lines.forEach(function (ln) {
    if ((chunk + '\n' + ln).length > 3800) { const c = chunk; chain = chain.then(function () { return sendTelegram(c); }); chunk = ln; }
    else chunk = chunk ? chunk + '\n' + ln : ln;
  });
  return chain.then(function () { return sendTelegram(chunk); });
}

function handleTelegramCommand(text) {
  const parts = String(text).trim().toLowerCase().split(/\s+/);
  const cmd = parts[0].split('@')[0];
  const arg = parts[1] || '';

  if (cmd === '/start') {
    if (botRunning) return sendTelegram('⚠️ Already running\\. Use /status');
    startBot(true);
    return Promise.resolve();
  }
  if (cmd === '/stop') {
    stopBot();
    return sendTelegram('⏸️ Stopped\\. ' + md(signalCount) + ' signals · ' + md(dailyWins) + 'W/' + md(dailyLosses) + 'L');
  }
  if (cmd === '/status') {
    const s = getSession();
    return sendTelegram(
      '📊 *Status*\n\n' +
      'Bot: ' + (botRunning ? '🟢 Running' : '🔴 Stopped') + '\n' +
      'Auto\\-trading: ' + (autoTrade ? '🤖 ON' : '✋ OFF') + '\n' +
      'Broker: ' + md(tradeBroker) + '\n' +
      (circuitOpen ? '🛑 Paused: ' + md(circuitReason) + '\n' : '') +
      'Open trades: ' + md(pendingTrades.length) + '\n' +
      'Signals: ' + md(signalCount) + '\n' +
      'Wins: ' + md(dailyWins) + ' · Losses: ' + md(dailyLosses) + '\n' +
      s.emoji + ' ' + md(s.message) + '\n' +
      'Time: ' + md(lusakaTime()) + ' CAT'
    );
  }
  if (cmd === '/auto') {
    if (arg === 'on') { autoTrade = true; return sendTelegram('🤖 Auto\\-trading *ON* \\(' + md(isDemoAccount() ? 'demo' : 'REAL account') + '\\)'); }
    if (arg === 'off') { autoTrade = false; return sendTelegram('✋ Auto\\-trading *OFF*\\. Manual signals only\\.'); }
    return sendTelegram('Use /auto on or /auto off');
  }
  if (cmd === '/deeptest') {
    if (deepRunning) return sendTelegram('⏳ Deep test is already running\\.');
    deepRunning = true;
    return sendTelegram('⏳ Deep test started\\. It takes about 5 to 8 minutes\\. I will message you when done\\.').then(function () {
      return runDeepTest();
    }).then(function (txt) {
      deepRunning = false;
      return sendTelegram(txt);
    }).catch(function (e) {
      deepRunning = false;
      return sendTelegram('❌ Deep test failed: ' + md(e.message));
    });
  }
  if (cmd === '/backtest') {
    if (backtesting) return sendTelegram('⏳ Backtest is already running\\.');
    backtesting = true;
    return sendTelegram('⏳ Backtest started\\. This takes about a minute\\.').then(function () {
      return runBacktest();
    }).then(function (txt) {
      backtesting = false;
      return sendTelegram(txt);
    }).catch(function (e) {
      backtesting = false;
      return sendTelegram('❌ Backtest failed: ' + md(e.message));
    });
  }
  if (cmd === '/resume') {
    circuitOpen = false; circuitNotified = false; consecLosses = 0; dayPnl = 0;
    return sendTelegram('▶️ Auto\\-trading resumed\\.');
  }
  if (cmd === '/limit') {
    const n = parseInt(arg, 10);
    if (!(n >= 1 && n <= 200)) return sendTelegram('🛑 Daily limit: ' + md(maxTradesPerDay) + ' trades \(' + md(tradesToday) + ' today\)\nUse /limit 40');
    maxTradesPerDay = n;
    limitNotifiedDay = '';
    return sendTelegram('🛑 Daily limit set to *' + md(n) + ' trades*\.');
  }
  if (cmd === '/duration') {
    const m = parseInt(arg, 10);
    if ([1, 2, 3, 5, 10, 15, 30].indexOf(m) === -1) {
      return sendTelegram('⏱ Trade length: ' + md(durationMin) + ' min\nUse /duration 1, 2, 3, 5, 10, 15 or 30');
    }
    durationMin = m;
    return sendTelegram('⏱ Trade length set to *' + md(m) + ' min*\. Resets to ' + md(process.env.DURATION_MIN || 15) + ' min if Render restarts\.');
  }
  if (cmd === '/newstrade') {
    if (arg === 'on' || arg === 'off') newsTrade = arg === 'on';
    return sendTelegram(md(ntReport()) + '\n\nUse /newstrade on or off\\.');
  }
  if (cmd === '/news') {
    if (arg === 'on' || arg === 'off') {
      newsOn = arg === 'on';
      return (newsOn ? loadNews() : Promise.resolve()).then(function () {
        return sendTelegram('📰 News filter *' + md(arg.toUpperCase()) + '*');
      });
    }
    return ensureNews().then(function () { return sendTelegram(md(newsReport())); });
  }
  if (cmd === '/evolved') {
    if (arg === 'on' || arg === 'off') evoOn = arg === 'on';
    return sendTelegram(md(evoReport()));
  }
  if (cmd === '/strategysearch') {
    if (evoRunning || stratRunning || volRunning) return sendTelegram('⏳ A test is already running\\.');
    evoRunning = true;
    return sendTelegram('⏳ Strategy search started: the bot is building and testing its own rules\\. About 5 to 10 minutes\\.').then(function () {
      return runStrategySearch();
    }).then(function (res) {
      evoRunning = false;
      return res.msgs.reduce(function (chain, m) { return chain.then(function () { return sendLong(m); }); }, Promise.resolve());
    }).catch(function (e) {
      evoRunning = false;
      return sendTelegram('❌ Strategy search failed: ' + md(e.message));
    });
  }
  if (cmd === '/volatile') {
    if (arg === 'on' || arg === 'off') volatileMode = arg === 'on';
    return sendTelegram(md(volReport()));
  }
  if (cmd === '/volatiletest') {
    if (volRunning || stratRunning) return sendTelegram('⏳ A test is already running\\.');
    volRunning = true;
    return sendTelegram('⏳ Volatile\\-market test started\\. About 3 to 6 minutes\\.').then(function () {
      return runVolatileTest();
    }).then(function (res) {
      volRunning = false;
      return res.msgs.reduce(function (chain, m) { return chain.then(function () { return sendLong(m); }); }, Promise.resolve());
    }).catch(function (e) {
      volRunning = false;
      return sendTelegram('❌ Volatile test failed: ' + md(e.message));
    });
  }
  if (cmd === '/strategytest') {
    if (stratRunning) return sendTelegram('⏳ Strategy test is already running\\.');
    stratRunning = true;
    return sendTelegram('⏳ Strategy test started: 16 modules on hourly Capital\\.com candles\\. It takes about 3 to 6 minutes\\. I will message you when it is done\\.').then(function () {
      return runStrategyTest();
    }).then(function (res) {
      stratRunning = false;
      return res.msgs.reduce(function (chain, m) { return chain.then(function () { return sendLong(m); }); }, Promise.resolve()).then(function () { return stSendCsv(res.rows); });
    }).catch(function (e) {
      stratRunning = false;
      return sendTelegram('❌ Strategy test failed: ' + md(e.message));
    });
  }
  if (cmd === '/capital') {
    return capitalDiag().then(function (t) { return sendTelegram(md(t)); })
      .catch(function (e) { return sendTelegram('❌ ' + md(e.message)); });
  }
  if (cmd === '/broker') {
    if (arg === 'capital' || arg === 'deriv' || arg === 'both') {
      if (arg !== 'deriv' && !CAP_ON) return sendTelegram('❌ Capital\\.com keys are missing in Render\\.');
      tradeBroker = arg;
      return sendTelegram('🔀 Trading broker: *' + md(arg) + '*' + (arg === 'capital' ? md(' (Capital demo: forex, metals, indices, oil, crypto)') : arg === 'both' ? md(' (Capital demo for forex, metals, indices, oil, crypto + Deriv for volatility indices)') : md(' (Deriv, all its markets)')) + '\\. Resets if Render restarts unless TRADE_BROKER is set\\.');
    }
    return sendTelegram('Broker now: ' + md(tradeBroker) + '\nUse /broker capital, /broker deriv or /broker both');
  }
  if (cmd === '/risk') {
    const v = Number(arg);
    if (!(v >= 0.5 && v <= 50)) return sendTelegram('💵 Capital risk per trade: $' + md(capRisk) + '\nUse /risk 3 \\(between 0\\.5 and 50\\)');
    capRisk = v;
    return sendTelegram('💵 Risk per trade set to *$' + md(v) + '*');
  }
  if (cmd === '/learn') {
    return learn().then(function () {
      return sendTelegram('🧠 *Learning*\n\n' + md(lastLearnInfo) + '\n\nStorage: ' + md(DB_ON ? 'Supabase' : 'memory only'));
    });
  }
  if (cmd === '/win') { dailyWins++; return sendTelegram('✅ Win recorded: ' + md(dailyWins) + 'W/' + md(dailyLosses) + 'L'); }
  if (cmd === '/loss') { dailyLosses++; return sendTelegram('❌ Loss recorded: ' + md(dailyWins) + 'W/' + md(dailyLosses) + 'L'); }
  if (cmd === '/balance') {
    return derivBalance()
      .then(function (b) { return sendTelegram('💰 Balance: ' + md(b)); })
      .catch(function (e) { return sendTelegram('❌ ' + md(e.message)); });
  }
  if (cmd === '/accounts') {
    return listAccounts()
      .then(function (j) { return sendTelegram('🧾 ' + md(JSON.stringify(j).slice(0, 900))); })
      .catch(function (e) { return sendTelegram('❌ ' + md(e.message.slice(0, 600))); });
  }
  return Promise.resolve();
}

