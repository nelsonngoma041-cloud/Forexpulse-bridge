function dispatchSignal() {
  return ensureNews().then(dispatchSignalInner);
}

// true if this pair is on hold for news (and tells you once per event)
function newsHold(p) {
  if (p.type === 'derived') return false;
  const e = newsBlock(p.symbol);
  if (!e) return false;
  const key = e.t + e.ccy + e.title;
  if (!newsNotified[key]) {
    newsNotified[key] = true;
    sendTelegram('📰 *News hold*: ' + md(e.ccy + ' ' + e.title) + ' at ' + md(lusakaStamp(e.t)) + '\\. No new ' + md(e.ccy) + ' trades from ' + md(NEWS_BEFORE_MIN) + ' min before to ' + md(NEWS_AFTER_MIN) + ' min after\\.');
  }
  return true;
}

function dispatchSignalInner() {
  if (autoTrade && circuitOpen) {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== pnlDay) { pnlDay = d; dayPnl = 0; consecLosses = 0; circuitOpen = false; circuitNotified = false; }
    else return Promise.resolve();
  }
  // Daily limit: say it once, then stay quiet until the next day
  if (autoTrade) {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== tradeDay) { tradeDay = day; tradesToday = 0; }
    if (tradesToday >= maxTradesPerDay) {
      if (limitNotifiedDay === day) return Promise.resolve();
      limitNotifiedDay = day;
      return sendTelegram('🛑 Daily limit of ' + md(maxTradesPerDay) + ' trades reached\. No more trades until tomorrow \(02:00 Zambia time\)\. Use /limit 40 to raise it\.');
    }
  }
  const session = getSession();
  if (process.env.SKIP_LOW_SESSION === 'true' && session.quality === 0) return Promise.resolve();

  const pairs = availablePairs().filter(function (p) {
    return Date.now() - (lastSignalAt[p.symbol] || 0) > COOLDOWN_MS &&
      Date.now() > (blockedUntil[p.symbol] || 0) &&
      !(p.symbol in pausedPairs) &&
      !newsHold(p);
  });

  return Promise.all(pairs.map(function (p) {
    return analyseSymbol(p.symbol).then(function (a) { return { pair: p, a: a }; });
  })).then(function (results) {
    const valid = results.filter(function (r) {
      return r.a && r.a.action !== 'WAIT' && r.a.confidence >= MIN_CONFIDENCE;
    }).sort(function (x, y) { return y.a.confidence - x.a.confidence; });

    if (valid.length === 0) { console.log('No clear setup this round'); return null; }

    const place = function (pick) {
    const pair = pick.pair;
    const a = pick.a;
    const time = lusakaTime();
    const emoji = a.action === 'BUY' ? '🟢📈' : '🔴📉';
    const direction = a.action === 'BUY' ? 'Rise' : 'Fall';
    const price = a.price.toFixed(pair.decimals);

    const record = function () {
      recentSignals.unshift({
        id: String(Date.now()), symbol: pair.display, action: a.action,
        confidence: a.confidence, rsi: a.rsi, time: time.slice(0, 5),
        type: pair.type, priceSource: 'live',
      });
      if (recentSignals.length > 20) recentSignals.pop();
    };

    // ----- Auto trade -----
    if (autoTrade) {
      if (pendingTrades.some(function (t) { return t.display === pair.display; })) return null;
      if (pendingTrades.length >= (tradeBroker === 'both' ? 6 : MAX_OPEN_TRADES)) return null;
      if (tradeBroker !== 'deriv' && pair.type !== 'derived') {
        const gate = volatileMode ? volatileNow(pair.symbol).catch(function () { return { ok: false, ratio: 0 }; }) : Promise.resolve({ ok: true });
        return gate.then(function (vg) {
          if (!vg.ok) { console.log('Volatile mode: skip ' + pair.symbol + ' (ratio ' + (vg.ratio || 0).toFixed(2) + ')'); return null; }
          return capitalTrade(pair.symbol, a.action).then(function (t) {
          signalCount++;
          tradesToday++;
          lastSignalAt[pair.symbol] = Date.now();
          pendingTrades.push({
            contractId: t.dealId, display: pair.display, symbol: pair.symbol, action: a.action,
            placedAt: Date.now(), votes: a.votes || {}, minutes: CAP_MAX_HOLD_MIN, broker: 'capital', volTrade: volatileMode,
          });
          dbInsertTrade({
            contract_id: String(t.dealId), symbol: pair.symbol, action: a.action,
            confidence: a.confidence, votes: a.votes || {}, rsi: a.rsi,
            hour: lusakaHour(), stake: Number(t.riskUsd.toFixed(2)), demo: true,
          });
          record();
          return sendTelegram(
            emoji + ' *TRADE PLACED — ' + md(pair.display) + '* \\(Capital demo\\)\n\n' +
            md(a.action) + ' · size ' + md(t.size) + ' · risk about $' + md(t.riskUsd.toFixed(2)) + '\n' +
            'Entry: ' + md(Number(t.level).toFixed(pair.decimals)) + '\n' +
            'Stop loss: ' + md(t.sl.toPrecision(4)) + ' away · Take profit: ' + md(t.tp.toPrecision(4)) + ' away\n' +
            'Confidence: ' + md(a.confidence) + '% · Why: ' + md(a.reason) + '\n' +
            '\n🤖 Auto\\-trading · ⏰ ' + md(time)
          );
        }).catch(function (e) {
          if (/closed|not offered|not tradeable|not available|too big/i.test(e.message)) {
            blockedUntil[pair.symbol] = Date.now() + 60 * 60 * 1000;
            console.log('Capital skip ' + pair.symbol + ': ' + e.message);
            return null;
          }
          lastSignalAt[pair.symbol] = Date.now();
          return sendTelegram('⚠️ Capital trade blocked on ' + md(pair.display) + ': ' + md(e.message));
        });
        });
      }
      if (tradeBroker === 'capital') return null;
      return placeTrade(pair.symbol, a.action, STAKE).then(function (t) {
        signalCount++;
        lastSignalAt[pair.symbol] = Date.now();
        pendingTrades.push({
          contractId: t.contract_id, display: pair.display, symbol: pair.symbol,
          action: a.action, placedAt: Date.now(), votes: a.votes || {}, minutes: t.minutes || durationMin,
        });
        dbInsertTrade({
          contract_id: String(t.contract_id), symbol: pair.symbol, action: a.action,
          confidence: a.confidence, votes: a.votes || {}, rsi: a.rsi,
          hour: lusakaHour(), stake: STAKE, demo: isDemoAccount(),
        });
        record();
        return sendTelegram(
          emoji + ' *TRADE PLACED — ' + md(pair.display) + '*\n\n' +
          direction + ' · ' + md(t.minutes || durationMin) + ' min · stake $' + md(STAKE) + '\n' +
          'Price: ' + md(price) + ' · Confidence: ' + md(a.confidence) + '%\n' +
          'Why: ' + md(a.reason) + '\n' +
          'Contract: ' + md(t.contract_id) + '\n' +
          (t.balance_after !== undefined ? 'Balance: ' + md(t.balance_after) + '\n' : '') +
          '\n🤖 Auto\\-trading \\(' + md(isDemoAccount() ? 'demo' : 'REAL') + '\\) · ⏰ ' + md(time)
        );
      }).catch(function (e) {
        if (/not offered|duration|closed|not available/i.test(e.message)) {
          blockedUntil[pair.symbol] = Date.now() + 6 * 60 * 60 * 1000;
        } else {
          lastSignalAt[pair.symbol] = Date.now();
        }
        return sendTelegram('⚠️ Auto\\-trade blocked on ' + md(pair.display) + ': ' + md(e.message));
      });
    }

    // ----- Manual signal -----
    signalCount++;
    lastSignalAt[pair.symbol] = Date.now();
    record();
    return sendTelegram([
      emoji + ' *' + md(a.action) + ' — ' + md(pair.display) + '*',
      pair.type === 'derived' ? '🎲 Derived Index' : '💱 Forex',
      '',
      'Price: ' + md(price),
      'Trade: *' + direction + '* · ' + durationMin + ' min',
      'Confidence: ' + md(a.confidence) + '%',
      '',
      'RSI: ' + md(a.rsi.toFixed(1)) + ' · MACD: ' + (a.macd > 0 ? 'Bullish' : 'Bearish'),
      'Why: ' + md(a.reason),
      '',
      '💰 Stake: $' + md(STAKE),
      '⏳ *Execute within 2–5 mins*',
      '⚠️ Do NOT execute after 5 mins',
      '',
      session.emoji + ' ' + md(session.message),
      '⏰ ' + md(time) + ' · 🤖 ForexPulse PRO',
    ].join('\n')).then(function () {
      setTimeout(function () {
        if (!botRunning) return;
        sendTelegram('⏰ *Execute now — ' + md(pair.display) + '*\n' + emoji + ' *' + direction + '* · ' + durationMin + ' min\n⚠️ Signal expires in 3 minutes');
      }, 2 * 60 * 1000);
    });
    };
    // Both brokers: one Capital.com trade and one Deriv trade per round, so neither starves the other
    if (tradeBroker === 'both' && autoTrade) {
      const capPick = valid.filter(function (r) { return r.pair.type !== 'derived'; })[0];
      const derPick = valid.filter(function (r) { return r.pair.type === 'derived'; })[0];
      return Promise.resolve(capPick ? place(capPick) : null).then(function () { return derPick ? place(derPick) : null; });
    }
    return place(valid[0]);
  });
}

function tick() {
  if (!botRunning || scanning) return;
  scanning = true;
  Promise.resolve()
    .then(checkPendingTrades)
    .then(checkCapitalTrades)
    .then(maybeDailySummary)
    .then(dispatchSignal)
    .then(function () { return ensureNews().then(maybeNewsTrade); })
    .then(maybeEvolvedTrade)
    .catch(function (e) { console.error('Tick error: ' + e.message); })
    .then(function () { scanning = false; });
}

function startBot(announce) {
  if (botRunning) return false;
  botRunning = true;
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = setInterval(tick, 60000);
  tick();
  if (announce) {
    const s = getSession();
    sendTelegram(
      '🤖 *ForexPulse PRO running*\n\n' +
      '✅ Real Deriv candles, RSI \\+ MACD \\+ MA20\n' +
      '✅ Runs on the server, not your phone\n' +
      (autoTrade ? '🤖 Auto\\-trading: *ON*' : '✋ Auto\\-trading: *OFF* \\(manual signals\\)') + '\n\n' +
      '📱 /status /stop /auto on /auto off /balance\n\n' +
      s.emoji + ' ' + md(s.message)
    );
  }
  return true;
}

function stopBot() {
  if (!botRunning) return false;
  botRunning = false;
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  return true;
}

function botStatus() {
  return {
    running: botRunning,
    autoTrade: autoTrade,
    signalCount: signalCount,
    dailyWins: dailyWins,
    dailyLosses: dailyLosses,
    openTrades: pendingTrades.length,
    mt5Connected: false,
    derivConnected: !!(DERIV_API_TOKEN && DERIV_ACCOUNT_ID),
    recentSignals: recentSignals,
    message: botRunning
      ? 'Running — ' + signalCount + ' signals' + (autoTrade ? ' (auto-trading)' : '')
      : 'Bot stopped',
  };
}

// ---------- Backtest ----------
// Replays the strategies on past 1-minute candles and counts wins.
// Trades never overlap (after a trade, skip until it would have ended).

let backtesting = false;
const BT_LENGTHS = [5, 15];

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

