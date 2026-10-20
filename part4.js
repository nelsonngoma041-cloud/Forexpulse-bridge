// ----- signal generators: +1 buy, -1 sell, 0 nothing. Signal at close of bar i. -----
function stSignals(key, D, seed) {
  const n = D.n, sig = new Int8Array(n);
  const c = D.c, o = D.o, h = D.h, l = D.l;
  let st = null, rngSeed = seed;
  const rnd = function () { rngSeed = (rngSeed * 1103515245 + 12345) & 0x7fffffff; return rngSeed / 0x7fffffff; };
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

// ---------- HTTP ----------

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(function (req, res) {
  // Keep-alive ping (no secret needed). Point a free pinger here every 10 minutes.
  if (req.method === 'GET') {
    send(res, 200, { ok: true, running: botRunning, time: new Date().toISOString() });
    return;
  }

  let body = '';
  req.on('data', function (c) { body += c; });
  req.on('end', function () {
    let p;
    try { p = JSON.parse(body); }
    catch (e) { send(res, 400, { ok: false, error: 'Invalid JSON' }); return; }

    // Telegram webhook: only your own chat is allowed
    if (req.url && req.url.indexOf('/telegram') === 0) {
      const m = p.message;
      send(res, 200, { ok: true });
      if (m && m.text && m.chat && String(m.chat.id) === String(TELEGRAM_CHAT_ID)) {
        handleTelegramCommand(m.text).catch(function (e) { console.error('Command error: ' + e.message); });
      }
      return;
    }

    // Everything else needs the bridge secret
    if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) {
      send(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    console.log('[' + new Date().toISOString() + '] ' + p.cmd + ' ' + (p.symbol || ''));

    if (p.cmd === 'ANALYZE') {
      const derivSym = SYMBOL_MAP[p.symbol];
      if (!derivSym) { send(res, 400, { ok: false, error: 'Unknown symbol' }); return; }
      fetchCandles(derivSym, 80).then(function (prices) {
        send(res, 200, { ok: true, symbol: p.symbol, analysis: analyze(prices) });
      }).catch(function (err) {
        send(res, 200, { ok: false, symbol: p.symbol, error: err.message });
      });
      return;
    }

    if (p.cmd === 'ACCOUNTS') {
      listAccounts().then(function (j) { send(res, 200, { ok: true, accounts: j }); })
        .catch(function (err) { send(res, 200, { ok: false, error: err.message }); });
      return;
    }

    if (p.cmd === 'BALANCE') {
      derivBalance().then(function (b) { send(res, 200, { ok: true, balance: b }); })
        .catch(function (err) { send(res, 200, { ok: false, error: err.message }); });
      return;
    }

    if (p.cmd === 'BUY') {
      placeTrade(p.symbol, p.action, p.stake).then(function (t) { send(res, 200, { ok: true, trade: t }); })
        .catch(function (err) { send(res, 200, { ok: false, error: err.message }); });
      return;
    }

    if (p.cmd === 'CHECK') {
      checkContract(p.contract_id).then(function (r) { send(res, 200, { ok: true, result: r }); })
        .catch(function (err) { send(res, 200, { ok: false, error: err.message }); });
      return;
    }

    // Dashboard controls
    if (p.cmd === 'BOT_STATUS') { send(res, 200, Object.assign({ ok: true }, botStatus())); return; }
    if (p.cmd === 'BOT_START') {
      const started = startBot(true);
      send(res, 200, { ok: true, success: started, message: started ? 'Started' : 'Already running' });
      return;
    }
    if (p.cmd === 'BOT_STOP') {
      const stopped = stopBot();
      if (stopped) sendTelegram('⏸️ Stopped\\. ' + md(signalCount) + ' signals · ' + md(dailyWins) + 'W/' + md(dailyLosses) + 'L');
      send(res, 200, { ok: true, success: stopped, signalCount: signalCount, dailyWins: dailyWins, dailyLosses: dailyLosses });
      return;
    }
    if (p.cmd === 'BOT_TEST') {
      const pair = availablePairs()[0] || PAIRS[0];
      analyseSymbol(pair.symbol).then(function (a) {
        if (!a) { send(res, 200, { ok: false, error: 'Deriv feed unreachable' }); return null; }
        return sendTelegram(
          '🔔 *Test — ' + md(pair.display) + '*\n\n' +
          'Action: *' + md(a.action) + '*\n' +
          'Price: ' + md(a.price.toFixed(pair.decimals)) + '\n' +
          'RSI: ' + md(a.rsi.toFixed(1)) + '\n' +
          'Reason: ' + md(a.reason) + '\n\n' +
          '✅ Live Deriv feed working\\!'
        ).then(function (ok) {
          send(res, 200, { ok: true, success: ok, signal: { symbol: pair.display, action: a.action, rsi: a.rsi } });
        });
      });
      return;
    }

    send(res, 400, { ok: false, error: 'Unknown command: ' + p.cmd });
  });
});

server.listen(PORT, function () {
  console.log('ForexPulse Bridge on port ' + PORT);
  console.log('App ID set: ' + (DERIV_APP_ID ? 'yes' : 'NO') + ' | Token set: ' + (DERIV_API_TOKEN ? 'yes' : 'NO') +
    ' | Telegram set: ' + (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID ? 'yes' : 'NO') +
    ' | Auto-trade: ' + autoTrade + ' | Demo account: ' + isDemoAccount());
  // Restart-proof: Render restarts the server now and then, so resume by itself
  console.log('Trade log: ' + (DB_ON ? 'Supabase' : 'memory only (set SUPABASE_URL and SUPABASE_KEY)'));
  learn().then(function () {
    if (process.env.BOT_AUTOSTART === 'true') startBot(true);
  });
});
