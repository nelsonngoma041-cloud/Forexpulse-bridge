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

// ---------- Market-structure ("smart money") strategies from the videos ----------
// Swing highs and lows are confirmed 3 bars late, so nothing looks into the future.
//  BOS = a close beyond the last swing high (up) or swing low (down).
//  FVG = a 3-candle gap left by a strong move. Entry when price returns into it.
// Strategy 'fvg':    after a BOS, buy the pullback into the FVG; stop just beyond the FVG;
//                    target = the impulse extreme. (Video 2. The inducement step is left out.)
// Strategy 'struct': after a BOS, buy the pullback into the discount half (below 50% of the
//                    move) with a candle in our direction; stop beyond the strong low; target = impulse extreme. (Video 1)
// Both need a reward of at least 1.5x the risk. Shorts are the mirror image.
// /smctest tests them like every other idea. Rules that pass can be saved and traded with /smc on.

let smcRunning = false, smcOn = false;
let smcWinners = [];           // ['fvg'] and/or ['struct']
const smcStats = { n: 0, w: 0, sum: 0 };
const SMC_NAMES = { fvg: 'Structure break + FVG pullback', struct: 'Structure break + discount pullback' };
const SMC_MIN_RR = 1.5;

function stSmcSignals(D, kind) {
  const n = D.n, h = D.h, l = D.l, c = D.c, o = D.o;
  const sig = new Int8Array(n), slA = new Float64Array(n), tpA = new Float64Array(n);
  let sh = null, sl = null;          // last confirmed swing high / low {p, k}
  let shBroken = true, slBroken = true;
  let setup = null;
  for (let i = 12; i < n; i++) {
    const k = i - 3;                  // pivot candidate, confirmed now
    let isH = true, isL = true;
    for (let j = 1; j <= 3; j++) {
      if (!(h[k] > h[k - j]) || !(h[k] >= h[k + j])) isH = false;
      if (!(l[k] < l[k - j]) || !(l[k] <= l[k + j])) isL = false;
    }
    if (isH) { sh = { p: h[k], k: k }; shBroken = false; }
    if (isL) { sl = { p: l[k], k: k }; slBroken = false; }
    const atr = D.atr[i];
    if (!(atr > 0)) continue;
    // new break of structure creates a setup
    if (sh && !shBroken && c[i] > sh.p && sl && sl.k < sh.k + 1000 && sl.p < sh.p) {
      shBroken = true;
      const lowK = sl.k;
      let fvg = null, hi = -Infinity;
      for (let t = Math.max(lowK + 2, 2); t <= i; t++) {
        if (l[t] > h[t - 2] && (l[t] - h[t - 2]) > 0.1 * atr) fvg = { top: l[t], bot: h[t - 2] };
      }
      for (let t = lowK; t <= i; t++) if (h[t] > hi) hi = h[t];
      if (kind === 'struct' || fvg) setup = { dir: 1, born: i, ext: hi, strong: sl.p, fvg: fvg };
    } else if (sl && !slBroken && c[i] < sl.p && sh && sh.p > sl.p) {
      slBroken = true;
      const hiK = sh.k;
      let fvg = null, lo = Infinity;
      for (let t = Math.max(hiK + 2, 2); t <= i; t++) {
        if (h[t] < l[t - 2] && (l[t - 2] - h[t]) > 0.1 * atr) fvg = { top: l[t - 2], bot: h[t] };
      }
      for (let t = hiK; t <= i; t++) if (l[t] < lo) lo = l[t];
      if (kind === 'struct' || fvg) setup = { dir: -1, born: i, ext: lo, strong: sh.p, fvg: fvg };
    } else if (setup && i > setup.born) {
      // entry search on later bars
      if (i - setup.born > 40) { setup = null; continue; }
      if (setup.dir === 1) {
        if (c[i] < setup.strong) { setup = null; continue; }
        if (h[i] > setup.ext) setup.ext = h[i];
        const zoneTop = kind === 'fvg' ? setup.fvg.top : (setup.strong + setup.ext) / 2;
        const zoneBot = kind === 'fvg' ? setup.fvg.bot : setup.strong;
        if (l[i] <= zoneTop && c[i] > zoneBot && c[i] > o[i]) {
          const stop = (kind === 'fvg' ? setup.fvg.bot : setup.strong) - 0.1 * atr;
          const risk = c[i] - stop, reward = setup.ext - c[i];
          if (risk > 0 && reward / risk >= SMC_MIN_RR) { sig[i] = 1; slA[i] = stop; tpA[i] = setup.ext; }
          setup = null;
        }
      } else {
        if (c[i] > setup.strong) { setup = null; continue; }
        if (l[i] < setup.ext) setup.ext = l[i];
        const zoneBot = kind === 'fvg' ? setup.fvg.bot : (setup.strong + setup.ext) / 2;
        const zoneTop = kind === 'fvg' ? setup.fvg.top : setup.strong;
        if (h[i] >= zoneBot && c[i] < zoneTop && c[i] < o[i]) {
          const stop = (kind === 'fvg' ? setup.fvg.top : setup.strong) + 0.1 * atr;
          const risk = stop - c[i], reward = c[i] - setup.ext;
          if (risk > 0 && reward / risk >= SMC_MIN_RR) { sig[i] = -1; slA[i] = stop; tpA[i] = setup.ext; }
          setup = null;
        }
      }
    }
  }
  return { sig: sig, sl: slA, tp: tpA };
}

// Simulation with a price stop and price target per signal. R = result in units of the stop distance.
function stSimLv(D, S, split, accP, rows, mkt, sname) {
  let i = ST_WARM;
  while (i < D.n - 2) {
    const s = S.sig[i];
    if (s === 0) { i++; continue; }
    const e = i + 1;
    if (D.sp[e] > 3 * D.medSp && D.medSp > 0) { i++; continue; }
    const entry = D.o[e], stop = S.sl[i], target = S.tp[i];
    const dist = s > 0 ? entry - stop : stop - entry;
    const reach = s > 0 ? target - entry : entry - target;
    if (!(dist > 0) || !(reach > 0)) { i++; continue; }     // gapped through the levels
    const rr = reach / dist;
    const last = Math.min(e + ST_MAXHOLD, D.n - 1);
    let R = null, j = e;
    for (; j <= last; j++) {
      if (s > 0) {
        if (j > e && D.o[j] <= stop) { R = (D.o[j] - entry) / dist; break; }
        if (D.l[j] <= stop) { R = -1; break; }
        if (D.h[j] >= target) { R = rr; break; }
      } else {
        if (j > e && D.o[j] >= stop) { R = (entry - D.o[j]) / dist; break; }
        if (D.h[j] >= stop) { R = -1; break; }
        if (D.l[j] <= target) { R = rr; break; }
      }
    }
    if (R === null) { j = last; R = ((D.c[j] - entry) * s) / dist; }
    const net = R - (D.sp[e] * (1 + STRAT_SLIP)) / dist;
    const period = i < split[0] ? 0 : (i < split[1] ? 1 : 2);
    stAdd(accP[period], net);
    if (rows) rows.push({ s: sname, m: mkt, p: period, t: D.bars[e].t, x: D.bars[j].t, d: s, r: net, g: stRegime(D, i) });
    i = j + 1;
  }
}

// control: same number of trades at random bars, random direction, same stop and target distances
function stSmcControl(D, S, seed) {
  const dists = [];
  for (let i = 0; i < D.n; i++) if (S.sig[i] !== 0) dists.push([Math.abs(D.c[i] - S.sl[i]), Math.abs(S.tp[i] - D.c[i])]);
  const out = { sig: new Int8Array(D.n), sl: new Float64Array(D.n), tp: new Float64Array(D.n) };
  const R = { s: seed };
  dists.forEach(function (d) {
    const i = ST_WARM + Math.floor(evoRand(R) * (D.n - ST_WARM - 4));
    const dir = evoRand(R) < 0.5 ? 1 : -1;
    out.sig[i] = dir; out.sl[i] = D.c[i] - dir * d[0]; out.tp[i] = D.c[i] + dir * d[1];
  });
  return out;
}

function runSmcTest() {
  if (!CAP_ON) return Promise.reject(new Error('Capital.com keys are missing.'));
  const errors = [], kinds = ['fvg', 'struct'];
  const acc = {}, ctl = {}, per = {}, rows = {};
  kinds.forEach(function (k) { acc[k] = [stNewAcc(), stNewAcc(), stNewAcc()]; ctl[k] = [stNewAcc(), stNewAcc(), stNewAcc()]; per[k] = []; rows[k] = []; });
  let used = 0;
  return ST_MARKETS.reduce(function (chain, sym) {
    return chain.then(function () {
      return stFetchHistory(sym, STRAT_PAGES, errors).then(function (b) {
        if (b.length < 1000) { errors.push(sym + ': only ' + b.length + ' bars'); return null; }
        used++;
        const D = stBuild(b);
        const split = [Math.floor(D.n * 0.5), Math.floor(D.n * 0.75)];
        kinds.forEach(function (k, ki) {
          const S = stSmcSignals(D, k);
          const a = [stNewAcc(), stNewAcc(), stNewAcc()];
          stSimLv(D, S, split, a, rows[k], sym, k);
          const c = [stNewAcc(), stNewAcc(), stNewAcc()];
          stSimLv(D, stSmcControl(D, S, 5000 + ki * 31 + sym.length), split, c, null, sym, 'ctl');
          for (let p = 0; p < 3; p++) {
            [[acc[k][p], a[p]], [ctl[k][p], c[p]]].forEach(function (pr) {
              pr[0].n += pr[1].n; pr[0].w += pr[1].w; pr[0].sumR += pr[1].sumR; pr[0].gp += pr[1].gp; pr[0].gl += pr[1].gl;
            });
          }
          per[k].push(a[2]);
        });
        return new Promise(function (r) { setImmediate(r); });
      });
    });
  }, Promise.resolve()).then(function () {
    if (!used) throw new Error('No history could be loaded. ' + (errors[0] || ''));
    const msgs = [['🧱 *' + md('Market-structure test') + '*',
      md(used + ' markets, hourly. Strategies from your two videos: break of structure, then a pullback entry. Stop beyond the zone, target at the move high, reward at least ' + SMC_MIN_RR + 'x risk. Real spread + ' + STRAT_SLIP + 'x slippage. Same train / validation / out-of-sample split.'),
      md('Simplified: the inducement step is not included. Control = random entries with the same stop and target sizes.')].join('\n')];
    const lines = [];
    smcWinners = [];
    kinds.forEach(function (k) {
      const a = acc[k], c = ctl[k];
      const exps = a.map(stExp);
      const dd = stMaxDD(rows[k]);
      const posM = per[k].filter(function (x) { return stExp(x) > 0; }).length;
      const t = evoTstat(rows[k], 2);
      let verdict;
      if (a[0].n < 30 || a[1].n < 30 || a[2].n < 30) verdict = 'too few trades';
      else if (exps[0] >= 0.05 && exps[1] >= 0.05 && exps[2] >= 0.05 && stPF(a[2]) >= 1.15 && t >= 2 && exps[2] - stExp(c[2]) >= 0.05 && posM >= Math.ceil(used * 2 / 3)) { verdict = 'PASS ✅'; smcWinners.push(k); }
      else verdict = 'fail';
      lines.push(md(SMC_NAMES[k]));
      lines.push(md('  net R per trade: train ' + stF(exps[0]) + ' | validation ' + stF(exps[1]) + ' | out-of-sample ' + stF(exps[2]) + '  (n ' + a[0].n + '/' + a[1].n + '/' + a[2].n + ')'));
      lines.push(md('  OOS PF ' + stPF(a[2]).toFixed(2) + ', win ' + (a[2].n ? Math.round(100 * a[2].w / a[2].n) : 0) + '%, t ' + t.toFixed(1) + ', max DD ' + dd.toFixed(1) + 'R, ' + posM + '/' + used + ' markets positive'));
      lines.push(md('  random control: ' + stF(stExp(c[0])) + ' | ' + stF(stExp(c[1])) + ' | ' + stF(stExp(c[2])) + ' -> ' + verdict));
    });
    msgs.push(lines.join('\n'));
    msgs.push(smcWinners.length
      ? '*' + md('Passed. Saved for /smc on (Capital.com demo, stop at the zone, target at the move high). Forgotten if Render restarts, so re-run /smctest. One test period, so treat it as a lead and watch the demo results.') + '*'
      : '*' + md('Verdict: nothing passed every check, so these are not enabled. Do not trade them on this evidence.') + '*');
    return { msgs: msgs };
  });
}

function smcReport() {
  return '🧱 Market-structure trading: ' + (smcOn ? 'ON' : 'OFF') + '\n' +
    (smcWinners.length ? 'Saved: ' + smcWinners.map(function (k) { return SMC_NAMES[k]; }).join(', ') : 'No saved strategies. Run /smctest first.') + '\n' +
    (smcStats.n ? 'Closed trades: ' + smcStats.n + ', wins ' + smcStats.w + ', net $' + smcStats.sum.toFixed(2) : 'No trades closed yet.') + '\nUse /smc on or /smc off.';
}

function smcLearn(t, profit) { smcStats.n++; smcStats.sum += profit; if (profit > 0) smcStats.w++; }

function maybeSmcTrade() {
  if (!smcOn || !smcWinners.length || !autoTrade || !CAP_ON || tradeBroker === 'deriv' || circuitOpen) return Promise.resolve();
  const now = new Date();
  if (now.getUTCMinutes() < 1 || now.getUTCMinutes() > 20) return Promise.resolve();
  const hourId = Math.floor(now.getTime() / 3600000);
  return ST_MARKETS.reduce(function (chain, sym) {
    return chain.then(function () {
      const key = 'smc:' + sym + ':' + hourId;
      if (evoSeen[key]) return null;
      evoSeen[key] = true;
      const pair = PAIRS.filter(function (p) { return p.symbol === sym; })[0];
      if (!pair || pendingTrades.some(function (t) { return t.display === pair.display; }) || pendingTrades.length >= 6) return null;
      if (newsBlock(sym)) return null;
      return evoLiveBars(sym).then(function (bars) {
        if (bars.length < 260) return null;
        const D = stBuild(bars);
        const i = D.n - 2;
        if (Date.now() - bars[i].t > 2.5 * 3600000) return null;
        if (D.medSp > 0 && D.sp[D.n - 1] > 3 * D.medSp) return null;
        let pick = null;
        smcWinners.forEach(function (k) {
          if (pick) return;
          const S = stSmcSignals(D, k);
          if (S.sig[i] !== 0) pick = { k: k, S: S };
        });
        if (!pick) return null;
        const s = pick.S.sig[i];
        const px = D.c[i];
        const dist = s > 0 ? px - pick.S.sl[i] : pick.S.sl[i] - px;
        const reach = s > 0 ? pick.S.tp[i] - px : px - pick.S.tp[i];
        if (!(dist > 0) || !(reach / dist >= 1.2)) return null;
        const action = s > 0 ? 'BUY' : 'SELL';
        return capitalTrade(sym, action, { sl: dist, rr: reach / dist }).then(function (t) {
          tradesToday++;
          pendingTrades.push({
            contractId: t.dealId, display: pair.display, symbol: sym, action: action,
            placedAt: Date.now(), votes: {}, minutes: EVO_HOLD_MIN, holdMin: EVO_HOLD_MIN, broker: 'capital', smcId: pick.k,
          });
          dbInsertTrade({ contract_id: String(t.dealId), symbol: sym, action: action, confidence: 0, votes: {}, rsi: 0, hour: lusakaHour(), stake: Number(t.riskUsd.toFixed(2)), demo: true });
          return sendTelegram(
            '🧱 *STRUCTURE TRADE — ' + md(pair.display) + '* \\(Capital demo\\)\n\n' + md(SMC_NAMES[pick.k]) + '\n' +
            md(action) + ' · size ' + md(t.size) + ' · risk about $' + md(t.riskUsd.toFixed(2)) + '\n' +
            'Stop loss: ' + md(t.sl.toPrecision(4)) + ' away · Take profit: ' + md(t.tp.toPrecision(4)) + ' away'
          );
        });
      }).catch(function (e) { console.log('SMC ' + sym + ': ' + e.message); return null; });
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

