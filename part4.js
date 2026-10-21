function runDeepTest() {
  const keys = Object.keys(SYMBOL_MAP);
  const agg = emptyAgg();
  const errors = [];
  let markets = 0;
  let maxSpan = 0;
  return keys.reduce(function (chain, key) {
    return chain.then(function () {
      return fetchPaged(key, DEEP_PAGES, errors).then(function (c) {
        if (!c || c.length < 500) return null;
        markets++;
        maxSpan = Math.max(maxSpan, (c[c.length - 1].t - c[0].t) / 86400);
        deepProcess(key, c, agg);
        return new Promise(function (r) { setImmediate(r); });
      });
    });
  }, Promise.resolve()).then(function () {
    if (markets === 0) throw new Error('No market data could be loaded. ' + (errors[0] || ''));
    if (errors.length) console.error('Deep test notes: ' + errors.slice(0, 3).join(' | '));
    return deepReport(agg, { markets: markets, days: Math.round(maxSpan) });
  });
}

// ---------- Strategy research (/strategytest) ----------
// Tests 15 strategy modules one at a time, plus a random-entry control, on hourly
// Capital.com candles. Same data, costs and rules for every module.
//  - Signal is read at the close of a bar; the trade enters at the NEXT bar open (no look-ahead).
//  - One trade at a time per module and market (no duplicate or overlapping signals).
//  - Stop loss = ATR x multiple, take profit = stop x RR, forced exit after 48 bars.
//  - If stop and target are both inside one bar, the stop is assumed to hit first.
//  - Cost per trade = the real bid/ask spread at entry, plus an assumed slippage (STRAT_SLIP).
//  - Swap is NOT known; set STRAT_SWAP_R (R per night) if you want to model it.
//  - Periods are chronological: first 50% train, next 25% validation, last 25% out-of-sample.
// Nothing is optimised on the data: parameters are fixed in advance. Sensitivity runs only
// show how results change if the stop and target are changed.

let stratRunning = false;
const STRAT_PAGES = Number(process.env.STRAT_PAGES || 8);        // 1000 hourly bars per page
const STRAT_SLIP = Number(process.env.STRAT_SLIP || 0.5);        // extra slippage as a share of the spread
const STRAT_SWAP_R = Number(process.env.STRAT_SWAP_R || 0);      // swap cost in R per night held
const ST_WARM = 210;
const ST_MAXHOLD = 48;
const ST_MARKETS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'GOLD'];
const ST_VARIANTS = [
  { sl: 1.5, rr: 2, name: 'SL1.5 RR2' },   // the default, listed first
  { sl: 1.0, rr: 2, name: 'SL1.0 RR2' },
  { sl: 2.0, rr: 2, name: 'SL2.0 RR2' },
  { sl: 1.5, rr: 1.5, name: 'SL1.5 RR1.5' },
  { sl: 1.5, rr: 3, name: 'SL1.5 RR3' },
];
const ST_STRATS = [
  ['ema', 'EMA trend'], ['mtf', 'Multi-timeframe trend'], ['pull', 'Trend pullback'],
  ['adx', 'ADX trend'], ['donch', 'Donchian breakout'], ['srb', 'S/R breakout'],
  ['retest', 'Breakout retest'], ['asian', 'Asian range breakout'], ['bbmr', 'Bollinger reversion'],
  ['rsimr', 'RSI reversion'], ['macd', 'MACD momentum'], ['candle', 'Candle reversal'],
  ['pday', 'Prev-day breakout'], ['atrb', 'ATR breakout'], ['ichi', 'Ichimoku trend'],
  ['rand', 'RANDOM (control)'],
];

function stIso(ms) { return new Date(ms).toISOString().slice(0, 19); }

// Hourly candles from Capital.com, newest pages first, joined oldest to newest
function stFetchHistory(symbol, pages, errors) {
  return capEpic(symbol).then(function (epic) {
    let all = [];
    const step = function (p, to) {
      if (p >= pages) return Promise.resolve(all);
      return capCall('GET', '/prices/' + epic + '?resolution=HOUR&max=1000' + (to ? '&to=' + to : '')).then(function (j) {
        const arr = (j.prices || []).map(function (x) {
          const m = function (o) { return (Number(o.bid) + Number(o.ask)) / 2; };
          return {
            t: Date.parse((x.snapshotTimeUTC || x.snapshotTime) + 'Z'),
            o: m(x.openPrice), h: m(x.highPrice), l: m(x.lowPrice), c: m(x.closePrice),
            sp: Math.abs(Number(x.openPrice.ask) - Number(x.openPrice.bid)),
          };
        }).filter(function (b) { return !isNaN(b.t) && b.h > 0; });
        if (!arr.length) return all;
        arr.sort(function (a, b) { return a.t - b.t; });
        all = arr.concat(all);
        return step(p + 1, stIso(arr[0].t - 1000));
      }).catch(function (e) {
        errors.push(symbol + ' page ' + (p + 1) + ': ' + e.message);
        return all;
      });
    };
    return step(0, null);
  }).then(function (all) {
    const seen = {};
    return all.filter(function (b) { if (seen[b.t]) return false; seen[b.t] = true; return true; })
      .sort(function (a, b) { return a.t - b.t; });
  });
}

// ----- indicators over arrays -----
function stEma(a, p) {
  const out = new Array(a.length);
  const k = 2 / (p + 1);
  out[0] = a[0];
  for (let i = 1; i < a.length; i++) out[i] = a[i] * k + out[i - 1] * (1 - k);
  return out;
}
function stWilder(a, p, start) {
  const out = new Array(a.length).fill(NaN);
  let sum = 0;
  for (let i = start; i < start + p; i++) sum += a[i];
  out[start + p - 1] = sum / p;
  for (let i = start + p; i < a.length; i++) out[i] = (out[i - 1] * (p - 1) + a[i]) / p;
  return out;
}
function stBuild(bars) {
  const n = bars.length;
  const o = bars.map(function (b) { return b.o; }), h = bars.map(function (b) { return b.h; });
  const l = bars.map(function (b) { return b.l; }), c = bars.map(function (b) { return b.c; });
  const D = { n: n, bars: bars, o: o, h: h, l: l, c: c, sp: bars.map(function (b) { return b.sp; }) };
  const tr = [0], pdm = [0], mdm = [0];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  D.atr = stWilder(tr, 14, 1);
  const str = stWilder(tr, 14, 1), sp = stWilder(pdm, 14, 1), sm = stWilder(mdm, 14, 1);
  D.pdi = new Array(n).fill(NaN); D.mdi = new Array(n).fill(NaN);
  const dx = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (str[i] > 0) {
      D.pdi[i] = 100 * sp[i] / str[i]; D.mdi[i] = 100 * sm[i] / str[i];
      const sum = D.pdi[i] + D.mdi[i];
      dx[i] = sum > 0 ? 100 * Math.abs(D.pdi[i] - D.mdi[i]) / sum : 0;
    }
  }
  D.adx = stWilder(dx, 14, 14);
  D.ema20 = stEma(c, 20); D.ema50 = stEma(c, 50); D.ema200 = stEma(c, 200);
  // RSI (Wilder)
  const gain = [0], loss = [0];
  for (let i = 1; i < n; i++) { const d = c[i] - c[i - 1]; gain.push(d > 0 ? d : 0); loss.push(d < 0 ? -d : 0); }
  const ag = stWilder(gain, 14, 1), al = stWilder(loss, 14, 1);
  D.rsi = ag.map(function (g, i) { return al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i]); });
  // MACD histogram
  const e12 = stEma(c, 12), e26 = stEma(c, 26);
  const macdLine = e12.map(function (v, i) { return v - e26[i]; });
  const sig9 = stEma(macdLine, 9);
  D.hist = macdLine.map(function (v, i) { return v - sig9[i]; });
  // Bollinger (20, 2)
  D.bbU = new Array(n).fill(NaN); D.bbL = new Array(n).fill(NaN);
  for (let i = 19; i < n; i++) {
    let s = 0;
    for (let k = i - 19; k <= i; k++) s += c[k];
    const mean = s / 20;
    let v = 0;
    for (let k = i - 19; k <= i; k++) v += (c[k] - mean) * (c[k] - mean);
    const sd = Math.sqrt(v / 20);
    D.bbU[i] = mean + 2 * sd; D.bbL[i] = mean - 2 * sd;
  }
  // Donchian 20 of the PRIOR bars, and the 10 prior bars' extremes
  D.dHi = new Array(n).fill(NaN); D.dLo = new Array(n).fill(NaN);
  D.p10Hi = new Array(n).fill(NaN); D.p10Lo = new Array(n).fill(NaN);
  for (let i = 20; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let k = i - 20; k < i; k++) { if (h[k] > hi) hi = h[k]; if (l[k] < lo) lo = l[k]; }
    D.dHi[i] = hi; D.dLo[i] = lo;
    let hi2 = -Infinity, lo2 = Infinity;
    for (let k = i - 10; k < i; k++) { if (h[k] > hi2) hi2 = h[k]; if (l[k] < lo2) lo2 = l[k]; }
    D.p10Hi[i] = hi2; D.p10Lo[i] = lo2;
  }
  // Ichimoku (cloud shifted 26 bars forward, so no look-ahead)
  const hl = function (i, p) {
    let hi = -Infinity, lo = Infinity;
    for (let k = i - p + 1; k <= i; k++) { if (h[k] > hi) hi = h[k]; if (l[k] < lo) lo = l[k]; }
    return (hi + lo) / 2;
  };
  D.tenkan = new Array(n).fill(NaN); D.kijun = new Array(n).fill(NaN);
  D.cloudTop = new Array(n).fill(NaN); D.cloudBot = new Array(n).fill(NaN);
  for (let i = 51; i < n; i++) { D.tenkan[i] = hl(i, 9); D.kijun[i] = hl(i, 26); }
  for (let i = 51 + 26; i < n; i++) {
    const j = i - 26;
    const a = (D.tenkan[j] + D.kijun[j]) / 2, b = hl(j, 52);
    D.cloudTop[i] = Math.max(a, b); D.cloudBot[i] = Math.min(a, b);
  }
  // Higher timeframe (4h) trend, using only completed 4h bars
  D.h4up = new Array(n).fill(0);
  let h4ema = NaN, h4state = 0, curId = null;
  const k4 = 2 / 51;
  for (let i = 0; i < n; i++) {
    const id = Math.floor(bars[i].t / 14400000);
    if (curId !== null && id !== curId) {
      const closed = c[i - 1];
      h4ema = isNaN(h4ema) ? closed : closed * k4 + h4ema * (1 - k4);
      h4state = closed > h4ema ? 1 : -1;
    }
    curId = id;
    D.h4up[i] = h4state;
  }
  // Previous UTC day high and low, and today's Asian range (00:00 to 07:00 UTC)
  D.pdH = new Array(n).fill(NaN); D.pdL = new Array(n).fill(NaN);
  let day = null, dH = -Infinity, dL = Infinity, pH = NaN, pL = NaN;
  for (let i = 0; i < n; i++) {
    const d = new Date(bars[i].t).toISOString().slice(0, 10);
    if (d !== day) { if (day !== null) { pH = dH; pL = dL; } day = d; dH = -Infinity; dL = Infinity; }
    D.pdH[i] = pH; D.pdL[i] = pL;
    if (h[i] > dH) dH = h[i];
    if (l[i] < dL) dL = l[i];
  }
  // typical spread, to reject abnormal spreads
  const sps = D.sp.filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
  D.medSp = sps.length ? sps[Math.floor(sps.length / 2)] : 0;
  return D;
}

// ----- signal generators: +1 buy, -1 sell, 0 nothing. Signal at close of bar i. -----
function stSignals(key, D, seed) {
  const n = D.n, sig = new Int8Array(n);
  const c = D.c, o = D.o, h = D.h, l = D.l;
  let st = null, rngSeed = seed;
  const rnd = function () { rngSeed = (rngSeed + 0x6D2B79F5) | 0; let t = Math.imul(rngSeed ^ (rngSeed >>> 15), 1 | rngSeed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let res = NaN, sup = NaN;
  let aDay = null, aHi = -Infinity, aLo = Infinity, aFiredUp = false, aFiredDn = false;
  for (let i = ST_WARM; i < n; i++) {
    const atr = D.atr[i];
    let s = 0;
    if (key === 'ema') {
      if (D.ema20[i - 1] <= D.ema50[i - 1] && D.ema20[i] > D.ema50[i] && c[i] > D.ema200[i]) s = 1;
      else if (D.ema20[i - 1] >= D.ema50[i - 1] && D.ema20[i] < D.ema50[i] && c[i] < D.ema200[i]) s = -1;
    } else if (key === 'mtf') {
      if (D.ema20[i - 1] <= D.ema50[i - 1] && D.ema20[i] > D.ema50[i] && D.h4up[i] === 1) s = 1;
      else if (D.ema20[i - 1] >= D.ema50[i - 1] && D.ema20[i] < D.ema50[i] && D.h4up[i] === -1) s = -1;
    } else if (key === 'pull') {
      let minR = 100, maxR = 0;
      for (let k = i - 5; k < i; k++) { if (D.rsi[k] < minR) minR = D.rsi[k]; if (D.rsi[k] > maxR) maxR = D.rsi[k]; }
      if (D.ema50[i] > D.ema200[i] && c[i] > D.ema200[i] && D.adx[i] > 20 && minR < 40 &&
          D.rsi[i] > D.rsi[i - 1] && l[i] <= D.ema50[i] + 0.5 * atr && c[i] > D.ema50[i] && c[i] > o[i]) s = 1;
      else if (D.ema50[i] < D.ema200[i] && c[i] < D.ema200[i] && D.adx[i] > 20 && maxR > 60 &&
          D.rsi[i] < D.rsi[i - 1] && h[i] >= D.ema50[i] - 0.5 * atr && c[i] < D.ema50[i] && c[i] < o[i]) s = -1;
    } else if (key === 'adx') {
      if (D.adx[i] > 20 && D.pdi[i - 1] <= D.mdi[i - 1] && D.pdi[i] > D.mdi[i] && D.ema20[i] > D.ema50[i]) s = 1;
      else if (D.adx[i] > 20 && D.pdi[i - 1] >= D.mdi[i - 1] && D.pdi[i] < D.mdi[i] && D.ema20[i] < D.ema50[i]) s = -1;
    } else if (key === 'donch') {
      if (c[i] > D.dHi[i]) s = 1; else if (c[i] < D.dLo[i]) s = -1;
    } else if (key === 'srb') {
      const k = i - 5;
      if (k >= 5) {
        let isH = true, isL = true;
        for (let m = k - 5; m <= k + 5; m++) { if (h[m] > h[k]) isH = false; if (l[m] < l[k]) isL = false; }
        if (isH) res = h[k];
        if (isL) sup = l[k];
      }
      if (!isNaN(res) && c[i] > res && c[i - 1] <= res) { s = 1; res = NaN; }
      else if (!isNaN(sup) && c[i] < sup && c[i - 1] >= sup) { s = -1; sup = NaN; }
    } else if (key === 'retest') {
      if (st && i - st.bar > 12) st = null;
      if (st) {
        if (st.dir === 1) {
          if (c[i] < st.level - atr) st = null;
          else if (l[i] <= st.level + 0.3 * atr && c[i] > st.level && c[i] > o[i]) { s = 1; st = null; }
        } else {
          if (c[i] > st.level + atr) st = null;
          else if (h[i] >= st.level - 0.3 * atr && c[i] < st.level && c[i] < o[i]) { s = -1; st = null; }
        }
      }
      if (!st && s === 0) {
        if (c[i] > D.dHi[i]) st = { dir: 1, level: D.dHi[i], bar: i };
        else if (c[i] < D.dLo[i]) st = { dir: -1, level: D.dLo[i], bar: i };
      }
    } else if (key === 'asian') {
      const dt = new Date(D.bars[i].t);
      const d = dt.toISOString().slice(0, 10), hr = dt.getUTCHours();
      if (d !== aDay) { aDay = d; aHi = -Infinity; aLo = Infinity; aFiredUp = false; aFiredDn = false; }
      if (hr < 7) { if (h[i] > aHi) aHi = h[i]; if (l[i] < aLo) aLo = l[i]; }
      else if (hr < 12 && aHi > aLo && (aHi - aLo) > 0.5 * atr) {
        if (c[i] > aHi && !aFiredUp) { s = 1; aFiredUp = true; }
        else if (c[i] < aLo && !aFiredDn) { s = -1; aFiredDn = true; }
      }
    } else if (key === 'bbmr') {
      if (D.adx[i] < 22) {
        if (c[i - 1] < D.bbL[i - 1] && c[i] > D.bbL[i]) s = 1;
        else if (c[i - 1] > D.bbU[i - 1] && c[i] < D.bbU[i]) s = -1;
      }
    } else if (key === 'rsimr') {
      if (D.adx[i] < 22) {
        if (D.rsi[i - 1] < 30 && D.rsi[i] >= 30) s = 1;
        else if (D.rsi[i - 1] > 70 && D.rsi[i] <= 70) s = -1;
      }
    } else if (key === 'macd') {
      if (D.hist[i - 1] <= 0 && D.hist[i] > 0 && c[i] > D.ema200[i]) s = 1;
      else if (D.hist[i - 1] >= 0 && D.hist[i] < 0 && c[i] < D.ema200[i]) s = -1;
    } else if (key === 'candle') {
      if (c[i - 1] < o[i - 1] && c[i] > o[i] && c[i] >= o[i - 1] && o[i] <= c[i - 1] && l[i] <= D.p10Lo[i]) s = 1;
      else if (c[i - 1] > o[i - 1] && c[i] < o[i] && c[i] <= o[i - 1] && o[i] >= c[i - 1] && h[i] >= D.p10Hi[i]) s = -1;
    } else if (key === 'pday') {
      if (!isNaN(D.pdH[i])) {
        if (c[i] > D.pdH[i] && c[i - 1] <= D.pdH[i]) s = 1;
        else if (c[i] < D.pdL[i] && c[i - 1] >= D.pdL[i]) s = -1;
      }
    } else if (key === 'atrb') {
      const prevAtr = D.atr[i - 1];
      if (c[i] - c[i - 1] > 1.5 * prevAtr && c[i] > D.ema50[i]) s = 1;
      else if (c[i - 1] - c[i] > 1.5 * prevAtr && c[i] < D.ema50[i]) s = -1;
    } else if (key === 'ichi') {
      if (!isNaN(D.cloudTop[i])) {
        if (c[i] > D.cloudTop[i] && D.tenkan[i - 1] <= D.kijun[i - 1] && D.tenkan[i] > D.kijun[i]) s = 1;
        else if (c[i] < D.cloudBot[i] && D.tenkan[i - 1] >= D.kijun[i - 1] && D.tenkan[i] < D.kijun[i]) s = -1;
      }
    } else if (key === 'rand') {
      if (rnd() < 0.03) s = rnd() < 0.5 ? 1 : -1;
    }
    sig[i] = s;
  }
  return sig;
}

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

