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

