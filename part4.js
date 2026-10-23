function comboVote(votes) {
  let nBuy = 0, nSell = 0;
  STRATEGIES.forEach(function (k) {
    if (votes[k] > 0) nBuy++; else if (votes[k] < 0) nSell++;
  });
  const conf = function (d) { return Math.min(95, Math.round(50 + 50 * d / STRATEGIES.length)); };
  if (nBuy >= MIN_AGREE && nBuy > nSell && conf(nBuy - nSell) >= MIN_CONFIDENCE) return 1;
  if (nSell >= MIN_AGREE && nSell > nBuy && conf(nSell - nBuy) >= MIN_CONFIDENCE) return -1;
  return 0;
}

// data: { SYMBOLKEY: [close, close, ...] }  ->  stats per trade length
function backtestFromData(data) {
  const out = {};
  BT_LENGTHS.forEach(function (N) {
    const st = { strat: {}, pairs: {} };
    STRATEGIES.concat(['combo']).forEach(function (k) { st.strat[k] = { n: 0, w: 0 }; });
    out[N] = st;
  });

  Object.keys(data).forEach(function (sym) {
    const prices = data[sym];
    if (prices.length < 120) return;
    const votesAt = [];
    for (let i = 79; i < prices.length; i++) {
      votesAt[i] = getVotes(prices.slice(i - 79, i + 1)).votes;
    }
    BT_LENGTHS.forEach(function (N) {
      STRATEGIES.concat(['combo']).forEach(function (k) {
        let i = 79;
        while (i < prices.length - N) {
          const v = k === 'combo' ? comboVote(votesAt[i]) : votesAt[i][k];
          if (v !== 0) {
            const up = prices[i + N] > prices[i];
            const down = prices[i + N] < prices[i];
            const won = (v > 0 && up) || (v < 0 && down);
            out[N].strat[k].n++;
            if (won) out[N].strat[k].w++;
            if (k === 'combo') {
              const p = out[N].pairs[sym] || (out[N].pairs[sym] = { n: 0, w: 0 });
              p.n++;
              if (won) p.w++;
            }
            i += N;
          } else {
            i++;
          }
        }
      });
    });
  });
  return out;
}

function btLine(label, s) {
  if (!s || s.n === 0) return md(label) + ': no trades';
  const wr = Math.round(s.w / s.n * 100);
  const mark = s.n < 50 ? ' ⚠️' : (wr >= 55 && s.n >= 100 ? ' ✅' : '');
  return md(label) + ': ' + md(wr) + '% \\(' + md(s.n) + ' trades\\)' + mark;
}

function btReport(res, pairCount) {
  const lines = ['📊 *Backtest*', 'Past 1\\-min candles, ' + md(pairCount) + ' markets\\. Break\\-even is about 53%\\.', '⚠️ \\= too few trades  ✅ \\= 55%\\+ with 100\\+ trades', ''];
  BT_LENGTHS.forEach(function (N) {
    lines.push('*' + N + ' min trades*');
    STRATEGIES.forEach(function (k) { lines.push(btLine(STRAT_NAMES[k], res[N].strat[k])); });
    lines.push(btLine('Combined rule', res[N].strat.combo));
    const best = Object.keys(res[N].pairs)
      .filter(function (s) { return res[N].pairs[s].n >= 15; })
      .sort(function (a, b) { return res[N].pairs[b].w / res[N].pairs[b].n - res[N].pairs[a].w / res[N].pairs[a].n; })
      .slice(0, 3);
    if (best.length) lines.push('Best markets: ' + best.map(function (s) { return md(s) + ' ' + md(Math.round(res[N].pairs[s].w / res[N].pairs[s].n * 100)) + '%'; }).join(', '));
    lines.push('');
  });
  return lines.join('\n');
}

function fetchHistory(key, errors) {
  const sizes = [5000, 2000, 1000];
  const attempt = function (i) {
    return fetchCandles(SYMBOL_MAP[key], sizes[i], 45000).then(function (p) {
      if (p.length < 120) throw new Error('only ' + p.length + ' candles');
      return p;
    }).catch(function (e) {
      errors.push(key + ' (' + sizes[i] + '): ' + e.message);
      if (i + 1 < sizes.length) return attempt(i + 1);
      return null;
    });
  };
  return attempt(0);
}

function runBacktest() {
  const keys = Object.keys(SYMBOL_MAP);
  const data = {};
  const errors = [];
  return keys.reduce(function (chain, key) {
    return chain.then(function () {
      return fetchHistory(key, errors).then(function (p) { if (p) data[key] = p; });
    });
  }, Promise.resolve()).then(function () {
    const got = Object.keys(data);
    if (got.length === 0) {
      throw new Error('No market data could be loaded. ' + (errors[0] || ''));
    }
    return btReport(backtestFromData(data), got.length);
  });
}

// ---------- Deep test: months of history + stop loss / take profit ----------
// /deeptest downloads many pages of 1-min candles, then tests
//  (a) plain Rise/Fall wins, and (b) trades with a stop loss and take profit.
// Results in R units: 1R = the amount risked on one trade.

let deepRunning = false;
const DEEP_PAGES = Number(process.env.DEEP_PAGES || 8);   // 5000 candles per page
const COST_R = 0.1;        // assumed cost per trade, in R (spread / commission)
const MAX_HOLD = 60;       // close a trade after 60 candles if no stop or target hit
const SLTP_CONFIGS = [{ sl: 1, tp: 2, name: '1:2' }, { sl: 1, tp: 3, name: '1:3' }];
const DEEP_STRATS = STRATEGIES.concat(['combo', 'random']);
const DEEP_NAMES = { rsi: 'RSI', macd: 'MACD', trend: 'Trend', bands: 'Bollinger', breakout: 'Breakout', combo: 'Combined', random: 'Random' };
const REAL_KEYS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'GOLD', 'SILVER'];

function fetchCandlesFull(derivSymbol, count, endEpoch) {
  return wsRequest(PUBLIC_WS, {
    ticks_history: derivSymbol,
    adjust_start_time: 1,
    count: count,
    end: endEpoch || 'latest',
    start: 1,
    style: 'candles',
    granularity: 60,
  }, 45000).then(function (msg) {
    return (msg.candles || []).map(function (c) {
      return { t: Number(c.epoch), h: Number(c.high), l: Number(c.low), c: Number(c.close) };
    });
  });
}

// Download several pages, newest first, and join them oldest to newest
function fetchPaged(key, pages, errors) {
  let all = [];
  const step = function (p, end) {
    if (p >= pages) return Promise.resolve(all);
    return fetchCandlesFull(SYMBOL_MAP[key], 5000, end).then(function (chunk) {
      if (!chunk.length) return all;
      all = chunk.concat(all);
      return step(p + 1, chunk[0].t - 1);
    }).catch(function (e) {
      errors.push(key + ' page ' + (p + 1) + ': ' + e.message);
      return all;
    });
  };
  return step(0, null);
}

function atrAt(c, i) {
  let sum = 0;
  for (let j = i - 13; j <= i; j++) {
    const pc = c[j - 1].c;
    sum += Math.max(c[j].h - c[j].l, Math.abs(c[j].h - pc), Math.abs(c[j].l - pc));
  }
  return sum / 14;
}

// One stop loss / take profit simulation for one strategy on one market
function simSLTP(c, voteAt, cfg, out) {
  let i = 79;
  while (i < c.length - 2) {
    const v = voteAt(i);
    if (v === 0) { i++; continue; }
    const atr = atrAt(c, i);
    if (!(atr > 0)) { i++; continue; }
    const entry = c[i].c;
    const sl = cfg.sl * atr;
    const tp = cfg.tp * atr;
    const last = Math.min(i + MAX_HOLD, c.length - 1);
    let R = null;
    let j = i + 1;
    for (; j <= last; j++) {
      const hitSL = v > 0 ? c[j].l <= entry - sl : c[j].h >= entry + sl;
      const hitTP = v > 0 ? c[j].h >= entry + tp : c[j].l <= entry - tp;
      if (hitSL) { R = -1; break; }          // if both hit in one candle, assume the stop came first
      if (hitTP) { R = cfg.tp / cfg.sl; break; }
    }
    if (R === null) {
      j = last;
      const move = v > 0 ? c[last].c - entry : entry - c[last].c;
      R = Math.max(-1, Math.min(cfg.tp / cfg.sl, move / sl));
    }
    out.n++;
    if (R > 0) out.w++;
    out.sumR += R - COST_R;
    i = j + 1;
  }
}

function emptyAgg() {
  const a = { rf: {}, sl: {} };
  ['real', 'synth'].forEach(function (g) {
    a.rf[g] = {};
    [5, 15].forEach(function (N) {
      a.rf[g][N] = {};
      DEEP_STRATS.forEach(function (k) { a.rf[g][N][k] = { n: 0, w: 0 }; });
    });
    a.sl[g] = {};
    SLTP_CONFIGS.forEach(function (cfg) {
      a.sl[g][cfg.name] = {};
      DEEP_STRATS.forEach(function (k) { a.sl[g][cfg.name][k] = { n: 0, w: 0, sumR: 0 }; });
    });
  });
  return a;
}

// Test one market and add its results to the totals
function deepProcess(key, c, agg) {
  const g = REAL_KEYS.indexOf(key) >= 0 ? 'real' : 'synth';
  const cl = c.map(function (x) { return x.c; });
  const votesAt = [];
  for (let i = 79; i < cl.length; i++) votesAt[i] = getVotes(cl.slice(i - 79, i + 1)).votes;

  let seed = 12345 + key.length * 977;
  const rnd = function () { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const voteFor = function (k) {
    if (k === 'random') return function () { return rnd() < 0.5 ? 1 : -1; };
    if (k === 'combo') return function (i) { return comboVote(votesAt[i]); };
    return function (i) { return votesAt[i][k]; };
  };

  DEEP_STRATS.forEach(function (k) {
    [5, 15].forEach(function (N) {
      const vf = voteFor(k);
      const o = agg.rf[g][N][k];
      let i = 79;
      while (i < cl.length - N) {
        const v = vf(i);
        if (v === 0) { i++; continue; }
        const won = (v > 0 && cl[i + N] > cl[i]) || (v < 0 && cl[i + N] < cl[i]);
        o.n++;
        if (won) o.w++;
        i += N;
      }
    });
    SLTP_CONFIGS.forEach(function (cfg) {
      simSLTP(c, voteFor(k), cfg, agg.sl[g][cfg.name][k]);
    });
  });
}

function pct(o) { return o.n ? Math.round(o.w / o.n * 100) : 0; }

function deepReport(agg, info) {
  const GL = { real: 'Forex and metals', synth: 'Volatility indices' };
  const L = [];
  L.push('📊 *' + md('Deep test') + '*');
  L.push(md(info.markets + ' markets, about ' + info.days + ' days of 1-min candles.'));
  L.push(md('Stop-loss tests assume a cost of ' + COST_R + 'R per trade.'));
  L.push('');
  L.push('*' + md('Rise/Fall (break-even about 53%)') + '*');
  ['real', 'synth'].forEach(function (g) {
    [5, 15].forEach(function (N) {
      const parts = DEEP_STRATS.map(function (k) {
        const o = agg.rf[g][N][k];
        if (!o.n) return DEEP_NAMES[k] + ' none';
        const mark = o.n < 100 ? ' ⚠️' : (pct(o) >= 55 && o.n >= 300 ? ' ✅' : '');
        return DEEP_NAMES[k] + ' ' + pct(o) + '% (' + o.n + ')' + mark;
      });
      L.push(md(GL[g] + ', ' + N + ' min: ' + parts.join(' | ')));
    });
  });
  L.push('');
  L.push('*' + md('Stop loss and take profit (average R per trade)') + '*');
  const found = [];
  SLTP_CONFIGS.forEach(function (cfg) {
    ['real', 'synth'].forEach(function (g) {
      const base = agg.sl[g][cfg.name].random;
      const baseR = base.n ? base.sumR / base.n : 0;
      const parts = DEEP_STRATS.map(function (k) {
        const o = agg.sl[g][cfg.name][k];
        if (!o.n) return DEEP_NAMES[k] + ' none';
        const r = o.sumR / o.n;
        const good = k !== 'random' && o.n >= 300 && r >= 0.1 && r - baseR >= 0.08;
        if (good) found.push(DEEP_NAMES[k] + ' on ' + GL[g] + ' with ' + cfg.name + ' (' + (r >= 0 ? '+' : '') + r.toFixed(2) + 'R, ' + o.n + ' trades)');
        return DEEP_NAMES[k] + ' ' + (r >= 0 ? '+' : '') + r.toFixed(2) + 'R ' + pct(o) + '% (' + o.n + ')' + (good ? ' ✅' : (o.n < 100 ? ' ⚠️' : ''));
      });
      L.push(md(GL[g] + ', stop ' + cfg.name + ': ' + parts.join(' | ')));
    });
  });
  L.push('');
  if (found.length) {
    L.push('*' + md('Possible edge:') + '*');
    found.slice(0, 4).forEach(function (f) { L.push(md('• ' + f)); });
    L.push(md('Still treat this as a lead to confirm on demo, not proof.'));
  } else {
    L.push('*' + md('Verdict: no strategy clearly beats random entries.') + '*');
  }
  return L.join('\n');
}

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
            v: Number(x.lastTradedVolume) || 0,
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

