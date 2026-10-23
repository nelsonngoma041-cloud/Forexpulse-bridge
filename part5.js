function stRegime(D, i) {
  let sum = 0, cnt = 0;
  for (let k = Math.max(0, i - 100); k <= i; k++) { if (D.atr[k] > 0) { sum += D.atr[k]; cnt++; } }
  const avg = cnt ? sum / cnt : D.atr[i];
  if (D.atr[i] > 1.5 * avg) return 'volatile';
  if (D.adx[i] > 25) return 'trending';
  if (D.adx[i] < 20) return 'ranging';
  return 'mixed';
}

function stNewAcc() { return { n: 0, w: 0, sumR: 0, gp: 0, gl: 0 }; }
function stAdd(a, r) { a.n++; if (r > 0) { a.w++; a.gp += r; } else a.gl += -r; a.sumR += r; }

// One strategy, one market, one stop/target setting
function stSim(D, sig, v, split, accP, rej, rows, regAcc, mkt, sname) {
  let i = ST_WARM;
  while (i < D.n - 2) {
    const s = sig[i];
    if (s === 0) { i++; continue; }
    const e = i + 1;
    const atr = D.atr[i];
    if (!(atr > 0)) { rej.noAtr++; i++; continue; }
    if (D.sp[e] > 3 * D.medSp && D.medSp > 0) { rej.wideSpread++; i++; continue; }
    const entry = D.o[e];
    const sl = v.sl * atr, tp = sl * v.rr;
    const stop = s > 0 ? entry - sl : entry + sl;
    const target = s > 0 ? entry + tp : entry - tp;
    const last = Math.min(e + ST_MAXHOLD, D.n - 1);
    let R = null, j = e;
    for (; j <= last; j++) {
      if (s > 0) {
        if (j > e && D.o[j] <= stop) { R = (D.o[j] - entry) / sl; break; }
        if (D.l[j] <= stop) { R = -1; break; }
        if (D.h[j] >= target) { R = v.rr; break; }
      } else {
        if (j > e && D.o[j] >= stop) { R = (entry - D.o[j]) / sl; break; }
        if (D.h[j] >= stop) { R = -1; break; }
        if (D.l[j] <= target) { R = v.rr; break; }
      }
    }
    if (R === null) { j = last; R = ((D.c[j] - entry) * s) / sl; }
    const nights = Math.floor((j - e) / 24);
    const net = R - (D.sp[e] * (1 + STRAT_SLIP)) / sl - nights * STRAT_SWAP_R;
    const period = i < split[0] ? 0 : (i < split[1] ? 1 : 2);
    stAdd(accP[period], net);
    for (let k = i + 1; k <= j; k++) if (sig[k] !== 0) rej.overlap++;
    if (rows) {
      rows.push({
        s: sname, m: mkt, p: period, t: D.bars[e].t, x: D.bars[j].t, d: s, r: net,
        g: stRegime(D, i),
      });
    }
    if (regAcc) stAdd(regAcc[stRegime(D, i)], net);
    i = j + 1;
  }
}

function stPF(a) { return a.gl > 0 ? a.gp / a.gl : (a.gp > 0 ? 99 : 0); }
function stExp(a) { return a.n ? a.sumR / a.n : 0; }
function stF(x, d) { return (x >= 0 ? '+' : '') + x.toFixed(d === undefined ? 2 : d); }

function stMaxDD(trades) {
  const t = trades.slice().sort(function (a, b) { return a.x - b.x; });
  let eq = 0, peak = 0, dd = 0;
  t.forEach(function (r) { eq += r.r; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; });
  return dd;
}

function stSendCsv(rows) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return Promise.resolve(false);
  const head = 'strategy,market,period,entry_time_utc,exit_time_utc,direction,net_R,regime\n';
  const names = ['train', 'validation', 'out_of_sample'];
  const body = rows.map(function (r) {
    return [r.s, r.m, names[r.p], new Date(r.t).toISOString(), new Date(r.x).toISOString(), r.d > 0 ? 'BUY' : 'SELL', r.r.toFixed(3), r.g].join(',');
  }).join('\n');
  const fd = new FormData();
  fd.append('chat_id', String(TELEGRAM_CHAT_ID));
  fd.append('caption', 'Every simulated trade (default stop and target)');
  fd.append('document', new Blob([head + body], { type: 'text/csv' }), 'strategy_trades.csv');
  return fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendDocument', { method: 'POST', body: fd })
    .then(function (r) { return r.json(); }).then(function (j) { return j.ok === true; })
    .catch(function () { return false; });
}

function runStrategyTest() {
  if (!CAP_ON) return Promise.reject(new Error('Capital.com keys are missing. This test uses Capital.com hourly candles.'));
  const errors = [];
  const rej = {};
  const acc = {};      // key -> variant -> period -> acc
  const reg = {};      // key -> regime -> acc (default variant)
  const allRows = [];
  const rowsByStrat = {};
  ST_STRATS.forEach(function (s) {
    acc[s[0]] = ST_VARIANTS.map(function () { return [stNewAcc(), stNewAcc(), stNewAcc()]; });
    reg[s[0]] = { trending: stNewAcc(), ranging: stNewAcc(), volatile: stNewAcc(), mixed: stNewAcc() };
    rej[s[0]] = { overlap: 0, wideSpread: 0, noAtr: 0 };
    rowsByStrat[s[0]] = [];
  });
  let usedMarkets = [], totalBars = 0, minT = Infinity, maxT = 0;

  return ST_MARKETS.reduce(function (chain, sym) {
    return chain.then(function () {
      return stFetchHistory(sym, STRAT_PAGES, errors).then(function (bars) {
        if (bars.length < 1000) { errors.push(sym + ': only ' + bars.length + ' bars'); return null; }
        usedMarkets.push(sym);
        totalBars += bars.length;
        minT = Math.min(minT, bars[0].t); maxT = Math.max(maxT, bars[bars.length - 1].t);
        const D = stBuild(bars);
        const split = [Math.floor(D.n * 0.5), Math.floor(D.n * 0.75)];
        ST_STRATS.forEach(function (s, si) {
          const sig = stSignals(s[0], D, 1000 + si * 77 + sym.length);
          ST_VARIANTS.forEach(function (v, vi) {
            const first = vi === 0;
            const rows = first ? [] : null;
            stSim(D, sig, v, split, acc[s[0]][vi], first ? rej[s[0]] : { overlap: 0, wideSpread: 0, noAtr: 0 },
              rows, first ? reg[s[0]] : null, sym, s[1]);
            if (rows) { rows.forEach(function (r) { rowsByStrat[s[0]].push(r); allRows.push(r); }); }
          });
        });
        return new Promise(function (r) { setImmediate(r); });
      });
    });
  }, Promise.resolve()).then(function () {
    if (usedMarkets.length === 0) throw new Error('No history could be loaded. ' + (errors[0] || ''));
    const days = Math.round((maxT - minT) / 86400000);
    const msgs = [];
    const head = [];
    head.push('📊 *' + md('Strategy research') + '*');
    head.push(md(usedMarkets.length + ' markets (' + usedMarkets.join(', ') + '), ' + totalBars + ' hourly bars, up to ' + days + ' days.'));
    head.push(md('Chronological split: train 50% / validation 25% / out-of-sample 25%. Costs: real spread + ' + STRAT_SLIP + 'x slippage' + (STRAT_SWAP_R ? ', swap ' + STRAT_SWAP_R + 'R/night' : '; swap not modeled') + '.'));
    head.push(md('Expectancy is net R per trade (1R = the stop distance). Parameters were fixed in advance, nothing was tuned on this data.'));
    if (errors.length) head.push(md('Notes: ' + errors.slice(0, 3).join(' | ')));
    msgs.push(head.join('\n'));

    const randOos = acc.rand[0][2];
    const randExp = stExp(randOos);
    const lines = ['*' + md('Net expectancy (R/trade): train | validation | out-of-sample') + '*'];
    const cands = [];
    ST_STRATS.forEach(function (s) {
      const k = s[0];
      const a = acc[k][0];
      const tot = a[0].n + a[1].n + a[2].n;
      const exps = a.map(stExp);
      const oosPF = stPF(a[2]);
      const dd = stMaxDD(rowsByStrat[k]);
      let posVar = 0;
      ST_VARIANTS.forEach(function (v, vi) { if (stExp(acc[k][vi][2]) > 0) posVar++; });
      let verdict;
      if (k === 'rand') verdict = 'control';
      else if (a[0].n < 30 || a[1].n < 30 || a[2].n < 30) verdict = 'too few trades';
      else if (exps[0] >= 0.05 && exps[1] >= 0.05 && exps[2] >= 0.05 && oosPF >= 1.15 && posVar >= 3 && exps[2] - randExp >= 0.05) {
        verdict = 'CANDIDATE'; cands.push(k);
      } else verdict = 'reject';
      const mark = verdict === 'CANDIDATE' ? ' ✅' : '';
      lines.push(md(s[1] + ': ' + stF(exps[0]) + ' | ' + stF(exps[1]) + ' | ' + stF(exps[2]) +
        '  (n ' + a[0].n + '/' + a[1].n + '/' + a[2].n + ')  OOS PF ' + oosPF.toFixed(2) + ', win ' + (a[2].n ? Math.round(100 * a[2].w / a[2].n) : 0) +
        '%, max DD ' + dd.toFixed(1) + 'R, ' + posVar + '/5 settings positive -> ' + verdict) + mark);
    });
    msgs.push(lines.join('\n'));

    // Regime split and rejections
    const rl = ['*' + md('Results by market condition (net R/trade, trades)') + '*'];
    ST_STRATS.forEach(function (s) {
      const r = reg[s[0]];
      const f = function (x) { return x.n ? stF(stExp(x)) + ' (' + x.n + ')' : 'none'; };
      rl.push(md(s[1] + ': trending ' + f(r.trending) + ' | ranging ' + f(r.ranging) + ' | volatile ' + f(r.volatile) + ' | mixed ' + f(r.mixed)));
    });
    rl.push('');
    rl.push(md('Rejected signals (all strategies): ' + (function () {
      let ov = 0, ws = 0, na = 0;
      Object.keys(rej).forEach(function (k) { ov += rej[k].overlap; ws += rej[k].wideSpread; na += rej[k].noAtr; });
      return ov + ' overlapping a trade, ' + ws + ' with spread over 3x normal, ' + na + ' with no ATR.';
    })()));
    msgs.push(rl.join('\n'));

    const fin = [];
    if (cands.length) {
      fin.push('*' + md('Worth demo testing next (not proven):') + '*');
      cands.forEach(function (k) {
        const a = acc[k][0];
        const net = a[0].sumR + a[1].sumR + a[2].sumR;
        fin.push(md('• ' + ST_STRATS.filter(function (x) { return x[0] === k; })[0][1] + ': total ' + stF(net, 1) + 'R, about ' + stF(net * capRisk, 0) + ' dollars at $' + capRisk + ' risk per trade'));
      });
      fin.push(md('Out-of-sample is a single period, so even candidates can be luck. Confirm on demo before trusting them.'));
    } else {
      fin.push('*' + md('Verdict: no module passed all tests (positive in train, validation and out-of-sample, profit factor 1.15+, stable across settings, and better than random entries).') + '*');
      fin.push(md('Do not use win rate alone to judge any of these. Nothing here supports going live.'));
    }
    msgs.push(fin.join('\n'));
    return { msgs: msgs, rows: allRows };
  });
}

// ---------- Volatile-market mode ----------
// "Volatile" = the hourly ATR is more than VOL_MULT times its average over the last 100 hours.
// /volatiletest checks, on history, whether trading only in those conditions helps.
// /volatile on makes the Capital.com demo trades wait for volatile conditions (off by default).
let volatileMode = process.env.VOLATILE_MODE === 'on';
const VOL_MULT = Number(process.env.VOL_MULT || 1.5);
let volRunning = false;
const volStats = { n: 0, sum: 0, w: 0 };

function stIsVol(D, i, mult) {
  let sum = 0, cnt = 0;
  for (let k = Math.max(0, i - 100); k <= i; k++) { if (D.atr[k] > 0) { sum += D.atr[k]; cnt++; } }
  const avg = cnt ? sum / cnt : D.atr[i];
  return D.atr[i] > mult * avg;
}

// Live check for one Capital.com market
function volatileNow(symbol) {
  return capEpic(symbol).then(function (epic) {
    return capCall('GET', '/prices/' + epic + '?resolution=HOUR&max=130');
  }).then(function (j) {
    const p = j.prices || [];
    const mid = function (o) { return (Number(o.bid) + Number(o.ask)) / 2; };
    if (p.length < 120) return { ok: false, ratio: 0 };
    const tr = [];
    for (let i = 1; i < p.length; i++) {
      const h = mid(p[i].highPrice), l = mid(p[i].lowPrice), pc = mid(p[i - 1].closePrice);
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const atrAt = function (end) { let s = 0; for (let k = end - 13; k <= end; k++) s += tr[k]; return s / 14; };
    const now = atrAt(tr.length - 1);
    let s2 = 0, c2 = 0;
    for (let e = tr.length - 100; e < tr.length; e++) { s2 += atrAt(e); c2++; }
    const ratio = now / (s2 / c2);
    return { ok: ratio > VOL_MULT, ratio: ratio };
  });
}

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

