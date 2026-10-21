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
      if (!pair || pendingTrades.some(function (t) { return t.display === pair.display; }) || openCount() >= 6) return null;
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

// ---------- Pattern test: candlestick and chart patterns from the infographic ----------
// Candlestick patterns (hammer / shooting star, engulfing, morning / evening star, piercing / dark cloud)
// are taken only against a trend. Chart patterns (double top / bottom, head and shoulders, flags,
// triangles) use confirmed swing points (3 bars late), break of the neckline or boundary as the trigger,
// a stop beyond the pattern and the classic measured-move target. Reward at least 1.5x risk (0.9x for double tops and bottoms, whose target is about equal to their risk).

let patRunning = false;
const PAT_CANDLE = [['hammer', 'Hammer / Shooting star'], ['engulf', 'Engulfing'], ['star', 'Morning / Evening star'], ['pierce', 'Piercing / Dark cloud']];
const PAT_CHART = [['dbl', 'Double top / bottom'], ['hs', 'Head and shoulders'], ['flag', 'Flags'], ['tri', 'Triangles']];

function patCandle(D, key) {
  const n = D.n, o = D.o, h = D.h, l = D.l, c = D.c, sig = new Int8Array(n);
  for (let i = 60; i < n; i++) {
    const rng = h[i] - l[i];
    if (!(rng > 0) || !(D.atr[i] > 0)) continue;
    const body = Math.abs(c[i] - o[i]);
    const down = c[i - 1] < D.ema50[i - 1] && D.ema20[i - 1] < D.ema50[i - 1];
    const up = c[i - 1] > D.ema50[i - 1] && D.ema20[i - 1] > D.ema50[i - 1];
    let s = 0;
    if (key === 'hammer') {
      const lw = Math.min(o[i], c[i]) - l[i], uw = h[i] - Math.max(o[i], c[i]);
      if (down && body <= 0.35 * rng && lw >= 2 * Math.max(body, 0.05 * rng) && uw <= 0.3 * rng) s = 1;
      else if (up && body <= 0.35 * rng && uw >= 2 * Math.max(body, 0.05 * rng) && lw <= 0.3 * rng) s = -1;
    } else if (key === 'engulf') {
      const pb = Math.abs(c[i - 1] - o[i - 1]);
      if (down && c[i - 1] < o[i - 1] && c[i] > o[i] && o[i] <= c[i - 1] && c[i] >= o[i - 1] && body > pb) s = 1;
      else if (up && c[i - 1] > o[i - 1] && c[i] < o[i] && o[i] >= c[i - 1] && c[i] <= o[i - 1] && body > pb) s = -1;
    } else if (key === 'star') {
      const r2 = h[i - 2] - l[i - 2], r1 = h[i - 1] - l[i - 1];
      if (!(r2 > 0) || !(r1 > 0)) continue;
      const b2 = Math.abs(c[i - 2] - o[i - 2]), b1 = Math.abs(c[i - 1] - o[i - 1]);
      const mid2 = (c[i - 2] + o[i - 2]) / 2;
      if (c[i - 2] < ema50At(D, i - 2) && c[i - 2] < o[i - 2] && b2 >= 0.6 * r2 && b1 <= 0.3 * r1 && c[i] > o[i] && c[i] > mid2) s = 1;
      else if (c[i - 2] > ema50At(D, i - 2) && c[i - 2] > o[i - 2] && b2 >= 0.6 * r2 && b1 <= 0.3 * r1 && c[i] < o[i] && c[i] < mid2) s = -1;
    } else if (key === 'pierce') {
      const r1 = h[i - 1] - l[i - 1];
      if (!(r1 > 0)) continue;
      const b1 = Math.abs(c[i - 1] - o[i - 1]), mid1 = (c[i - 1] + o[i - 1]) / 2;
      if (down && c[i - 1] < o[i - 1] && b1 >= 0.6 * r1 && c[i] > o[i] && o[i] <= c[i - 1] && c[i] > mid1 && c[i] < o[i - 1]) s = 1;
      else if (up && c[i - 1] > o[i - 1] && b1 >= 0.6 * r1 && c[i] < o[i] && o[i] >= c[i - 1] && c[i] < mid1 && c[i] > o[i - 1]) s = -1;
    }
    sig[i] = s;
  }
  return sig;
}
function ema50At(D, i) { return D.ema50[i]; }

function patChart(D, key) {
  const n = D.n, h = D.h, l = D.l, c = D.c;
  const sig = new Int8Array(n), slA = new Float64Array(n), tpA = new Float64Array(n);
  const PH = [], PL = [];
  let cool = 0;
  const put = function (i, s, stop, tgt, minRR) {
    const risk = s > 0 ? c[i] - stop : stop - c[i];
    const reward = s > 0 ? tgt - c[i] : c[i] - tgt;
    if (risk > 0 && reward / risk >= (minRR || SMC_MIN_RR) && i >= cool) { sig[i] = s; slA[i] = stop; tpA[i] = tgt; cool = i + 6; }
  };
  const minLow = function (a, b) { let m = Infinity; for (let t = a; t <= b; t++) if (l[t] < m) m = l[t]; return m; };
  const maxHigh = function (a, b) { let m = -Infinity; for (let t = a; t <= b; t++) if (h[t] > m) m = h[t]; return m; };
  const used = {};
  for (let i = 60; i < n; i++) {
    const k = i - 3;
    let isH = true, isL = true;
    for (let j = 1; j <= 3; j++) {
      if (!(h[k] > h[k - j]) || !(h[k] >= h[k + j])) isH = false;
      if (!(l[k] < l[k - j]) || !(l[k] <= l[k + j])) isL = false;
    }
    if (isH) PH.push({ k: k, p: h[k] });
    if (isL) PL.push({ k: k, p: l[k] });
    const atr = D.atr[i];
    if (!(atr > 0)) continue;
    if (key === 'dbl') {
      if (PL.length >= 2) {
        const L2 = PL[PL.length - 1], L1 = PL[PL.length - 2], id = 'b' + L1.k + '_' + L2.k;
        if (!used[id] && Math.abs(L1.p - L2.p) <= 0.5 * atr && L2.k - L1.k >= 6 && L2.k - L1.k <= 60 && i - L2.k <= 40) {
          const neck = maxHigh(L1.k, L2.k), low = Math.min(L1.p, L2.p);
          if (neck - low >= 2 * atr && c[i] > neck && c[i - 1] <= neck) { used[id] = true; put(i, 1, low - 0.1 * atr, neck + (neck - low), 0.9); }
        }
      }
      if (PH.length >= 2) {
        const H2 = PH[PH.length - 1], H1 = PH[PH.length - 2], id = 't' + H1.k + '_' + H2.k;
        if (!used[id] && Math.abs(H1.p - H2.p) <= 0.5 * atr && H2.k - H1.k >= 6 && H2.k - H1.k <= 60 && i - H2.k <= 40) {
          const neck = minLow(H1.k, H2.k), hi = Math.max(H1.p, H2.p);
          if (hi - neck >= 2 * atr && c[i] < neck && c[i - 1] >= neck) { used[id] = true; put(i, -1, hi + 0.1 * atr, neck - (hi - neck), 0.9); }
        }
      }
    } else if (key === 'hs') {
      if (PH.length >= 3) {
        const P3 = PH[PH.length - 1], P2 = PH[PH.length - 2], P1 = PH[PH.length - 3], id = 'h' + P1.k + '_' + P3.k;
        if (!used[id] && P2.p > P1.p && P2.p > P3.p && Math.abs(P1.p - P3.p) <= atr && P2.p - Math.max(P1.p, P3.p) >= atr && P3.k - P1.k <= 80 && i - P3.k <= 40) {
          const neck = minLow(P1.k, P3.k);
          if (c[i] < neck && c[i - 1] >= neck) { used[id] = true; put(i, -1, P3.p + 0.1 * atr, neck - (P2.p - neck)); }
        }
      }
      if (PL.length >= 3) {
        const P3 = PL[PL.length - 1], P2 = PL[PL.length - 2], P1 = PL[PL.length - 3], id = 'i' + P1.k + '_' + P3.k;
        if (!used[id] && P2.p < P1.p && P2.p < P3.p && Math.abs(P1.p - P3.p) <= atr && Math.min(P1.p, P3.p) - P2.p >= atr && P3.k - P1.k <= 80 && i - P3.k <= 40) {
          const neck = maxHigh(P1.k, P3.k);
          if (c[i] > neck && c[i - 1] <= neck) { used[id] = true; put(i, 1, P3.p - 0.1 * atr, neck + (neck - P2.p)); }
        }
      }
    } else if (key === 'flag') {
      for (let m = 5; m <= 12; m++) {
        const j = i - m;
        if (j < 10) break;
        const pole = c[j] - c[j - 5];
        const hiC = maxHigh(j + 1, i - 1), loC = minLow(j + 1, i - 1);
        if (pole >= 3 * atr && hiC - loC <= 0.5 * pole && hiC <= h[j] + 0.3 * atr && c[i] > hiC && c[i - 1] <= hiC) { put(i, 1, loC - 0.1 * atr, c[i] + pole); break; }
        if (-pole >= 3 * atr && hiC - loC <= 0.5 * -pole && loC >= l[j] - 0.3 * atr && c[i] < loC && c[i - 1] >= loC) { put(i, -1, hiC + 0.1 * atr, c[i] + pole); break; }
      }
    } else if (key === 'tri') {
      if (PH.length >= 2 && PL.length >= 2) {
        const H2 = PH[PH.length - 1], H1 = PH[PH.length - 2], L2 = PL[PL.length - 1], L1 = PL[PL.length - 2];
        const span = Math.max(H2.k, L2.k) - Math.min(H1.k, L1.k);
        if (span >= 10 && span <= 60 && i - Math.max(H2.k, L2.k) <= 30) {
          const res = Math.max(H1.p, H2.p), sup = Math.min(L1.p, L2.p);
          if (Math.abs(H1.p - H2.p) <= 0.3 * atr && L2.p > L1.p + 0.2 * atr && c[i] > res && c[i - 1] <= res) put(i, 1, L2.p - 0.1 * atr, c[i] + (res - L1.p));
          else if (Math.abs(L1.p - L2.p) <= 0.3 * atr && H2.p < H1.p - 0.2 * atr && c[i] < sup && c[i - 1] >= sup) put(i, -1, H2.p + 0.1 * atr, c[i] - (H1.p - sup));
        }
      }
    }
  }
  return { sig: sig, sl: slA, tp: tpA };
}

function runPatternTest() {
  if (!CAP_ON) return Promise.reject(new Error('Capital.com keys are missing.'));
  const errors = [], all = PAT_CANDLE.concat(PAT_CHART);
  const acc = {}, ctl = {}, per = {}, rows = {};
  all.forEach(function (p) { acc[p[0]] = [stNewAcc(), stNewAcc(), stNewAcc()]; ctl[p[0]] = [stNewAcc(), stNewAcc(), stNewAcc()]; per[p[0]] = []; rows[p[0]] = []; });
  let used = 0;
  const addTo = function (dst, src) { for (let p = 0; p < 3; p++) { dst[p].n += src[p].n; dst[p].w += src[p].w; dst[p].sumR += src[p].sumR; dst[p].gp += src[p].gp; dst[p].gl += src[p].gl; } };
  return ST_MARKETS.reduce(function (chain, sym) {
    return chain.then(function () {
      return stFetchHistory(sym, STRAT_PAGES, errors).then(function (b) {
        if (b.length < 1000) { errors.push(sym + ': only ' + b.length + ' bars'); return null; }
        used++;
        const D = stBuild(b);
        const split = [Math.floor(D.n * 0.5), Math.floor(D.n * 0.75)];
        const rsig = stSignals('rand', D, 777 + sym.length);
        PAT_CANDLE.forEach(function (p) {
          const sig = patCandle(D, p[0]);
          const a = [stNewAcc(), stNewAcc(), stNewAcc()], c = [stNewAcc(), stNewAcc(), stNewAcc()];
          stSim(D, sig, ST_VARIANTS[0], split, a, { overlap: 0, wideSpread: 0, noAtr: 0 }, rows[p[0]], null, sym, p[0]);
          // control: random entries with the same number of trades and same stop and target rule
          const cs = new Int8Array(D.n), R = { s: 31 + sym.length };
          let cnt = 0; for (let i = 0; i < D.n; i++) if (sig[i] !== 0) cnt++;
          for (let q = 0; q < cnt; q++) cs[ST_WARM + Math.floor(evoRand(R) * (D.n - ST_WARM - 4))] = evoRand(R) < 0.5 ? 1 : -1;
          stSim(D, cs, ST_VARIANTS[0], split, c, { overlap: 0, wideSpread: 0, noAtr: 0 }, null, null, sym, 'ctl');
          addTo(acc[p[0]], a); addTo(ctl[p[0]], c); per[p[0]].push(a[2]);
        });
        PAT_CHART.forEach(function (p, pi) {
          const S = patChart(D, p[0]);
          const a = [stNewAcc(), stNewAcc(), stNewAcc()], c = [stNewAcc(), stNewAcc(), stNewAcc()];
          stSimLv(D, S, split, a, rows[p[0]], sym, p[0]);
          stSimLv(D, stSmcControl(D, S, 9100 + pi * 17 + sym.length), split, c, null, sym, 'ctl');
          addTo(acc[p[0]], a); addTo(ctl[p[0]], c); per[p[0]].push(a[2]);
        });
        return new Promise(function (r) { setImmediate(r); });
      });
    });
  }, Promise.resolve()).then(function () {
    if (!used) throw new Error('No history could be loaded. ' + (errors[0] || ''));
    const msgs = [['📐 *' + md('Pattern test') + '*',
      md(used + ' markets, hourly. Candlestick patterns (against a trend, stop 1.5x ATR, target 2x) and chart patterns (neckline or boundary break, stop beyond the pattern, measured-move target, reward at least ' + SMC_MIN_RR + 'x risk, 0.9x for double tops and bottoms). Real spread + ' + STRAT_SLIP + 'x slippage, same train / validation / out-of-sample split.'),
      md('Control = random entries, same number of trades and same stop and target rule.')].join('\n')];
    const lines = [];
    const pass = [];
    all.forEach(function (p) {
      const a = acc[p[0]], c = ctl[p[0]], exps = a.map(stExp);
      const posM = per[p[0]].filter(function (x) { return stExp(x) > 0; }).length;
      const t = evoTstat(rows[p[0]], 2);
      let verdict;
      if (a[0].n < 30 || a[1].n < 30 || a[2].n < 30) verdict = 'too few trades';
      else if (exps[0] >= 0.05 && exps[1] >= 0.05 && exps[2] >= 0.05 && stPF(a[2]) >= 1.15 && t >= 2 && exps[2] - stExp(c[2]) >= 0.05 && posM >= Math.ceil(used * 2 / 3)) { verdict = 'PASS ✅'; pass.push(p[1]); }
      else verdict = 'fail';
      lines.push(md(p[1] + ': ' + stF(exps[0]) + ' | ' + stF(exps[1]) + ' | ' + stF(exps[2]) + 'R (n ' + a[0].n + '/' + a[1].n + '/' + a[2].n + '), OOS PF ' + stPF(a[2]).toFixed(2) + ', win ' + (a[2].n ? Math.round(100 * a[2].w / a[2].n) : 0) + '%, ' + posM + '/' + used + ' markets +, control ' + stF(stExp(c[2])) + ' -> ' + verdict));
    });
    msgs.push(['*' + md('Net R per trade: train | validation | out-of-sample') + '*'].concat(lines).join('\n'));
    msgs.push(pass.length
      ? '*' + md('Passed: ' + pass.join(', ') + '. One test period, so treat it as a lead and confirm on new data before any live use. Tell me and I will wire it to the demo trading.') + '*'
      : '*' + md('Verdict: no pattern passed every check. None of these are enabled, and none are worth trading on this evidence.') + '*');
    return { msgs: msgs };
  });
}

