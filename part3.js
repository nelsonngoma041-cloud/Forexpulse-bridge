function maybeDailySummary() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lusaka' });
  if (lusakaHour() === 8 && lastSummaryDate !== today) {
    lastSummaryDate = today;
    const total = dailyWins + dailyLosses;
    const wr = total > 0 ? Math.round(dailyWins / total * 100) : 0;
    return sendTelegram(
      '📈 *Daily Summary*\n\n' +
      'Signals: ' + md(signalCount) + '\n' +
      'Wins: ' + md(dailyWins) + ' · Losses: ' + md(dailyLosses) + '\n' +
      'Win rate: ' + md(wr) + '%'
    ).then(function () { dailyWins = 0; dailyLosses = 0; signalCount = 0; });
  }
  return Promise.resolve();
}

// ---------- News filter ----------
// Pauses NEW trades on markets that are hit by high-impact economic news,
// from NEWS_BEFORE_MIN minutes before to NEWS_AFTER_MIN minutes after the release.
// Volatility indices (Deriv) are synthetic, so news does not apply to them.
// Calendar source: the free Forex Factory weekly feed. If it cannot be loaded, trading goes on.

const NEWS_URL = process.env.NEWS_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
let newsOn = process.env.NEWS_FILTER !== 'off';
const NEWS_BEFORE_MIN = Number(process.env.NEWS_BEFORE_MIN || 30);
const NEWS_AFTER_MIN = Number(process.env.NEWS_AFTER_MIN || 30);
const NEWS_IMPACT = (process.env.NEWS_IMPACT || 'High').toLowerCase();   // High, or Medium to include medium news
const NEWS_CCY = {
  EURUSD: ['EUR', 'USD'], GBPUSD: ['GBP', 'USD'], USDJPY: ['USD', 'JPY'], AUDUSD: ['AUD', 'USD'],
  USDCAD: ['USD', 'CAD'], GOLD: ['USD'], SILVER: ['USD'], US100: ['USD'], US500: ['USD'],
  DE40: ['EUR'], J225: ['JPY', 'USD'], OIL: ['USD'], BTC: ['USD'], ETH: ['USD'],
};
let newsEvents = [];
let newsLoadedAt = 0;
let newsLastTry = 0;
let newsStatus = 'not loaded yet';
const newsNotified = {};

function loadNews() {
  newsLastTry = Date.now();
  return fetch(NEWS_URL, { headers: { 'User-Agent': 'Mozilla/5.0 ForexPulse' } }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function (list) {
    if (!Array.isArray(list)) throw new Error('unexpected format');
    const want = NEWS_IMPACT === 'medium' ? ['high', 'medium'] : ['high'];
    newsEvents = list.filter(function (e) {
      return e && want.indexOf(String(e.impact || '').toLowerCase()) >= 0 && !isNaN(Date.parse(e.date));
    }).map(function (e) {
      return { t: Date.parse(e.date), ccy: String(e.country || '').toUpperCase(), title: String(e.title || ''), impact: String(e.impact || '') };
    }).sort(function (a, b) { return a.t - b.t; });
    newsLoadedAt = Date.now();
    newsStatus = 'loaded ' + newsEvents.length + ' events';
    console.log('News calendar: ' + newsStatus);
  }).catch(function (e) {
    newsStatus = 'could not load (' + e.message + '), trading without news filter';
    console.error('News calendar: ' + newsStatus);
  });
}

function ensureNews() {
  if (!newsOn) return Promise.resolve();
  const age = Date.now() - newsLoadedAt;
  const sinceTry = Date.now() - newsLastTry;
  if ((newsLoadedAt === 0 || age > 6 * 3600 * 1000) && sinceTry > 30 * 60 * 1000) return loadNews();
  return Promise.resolve();
}

// returns the news event that blocks this market right now, or null
function newsBlock(symbol) {
  if (!newsOn) return null;
  const ccys = NEWS_CCY[symbol];
  if (!ccys) return null;
  const now = Date.now();
  for (let i = 0; i < newsEvents.length; i++) {
    const e = newsEvents[i];
    if (ccys.indexOf(e.ccy) < 0) continue;
    if (now >= e.t - NEWS_BEFORE_MIN * 60000 && now <= e.t + NEWS_AFTER_MIN * 60000) return e;
  }
  return null;
}

function lusakaStamp(ms) {
  return new Date(ms).toLocaleString('en-GB', {
    timeZone: 'Africa/Lusaka', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function newsReport() {
  const now = Date.now();
  const next = newsEvents.filter(function (e) { return e.t + NEWS_AFTER_MIN * 60000 >= now; }).slice(0, 8);
  const lines = [
    '📰 News filter: ' + (newsOn ? 'ON' : 'OFF'),
    'Rule: no new trades from ' + NEWS_BEFORE_MIN + ' min before to ' + NEWS_AFTER_MIN + ' min after ' + NEWS_IMPACT + '-impact news',
    'Calendar: ' + newsStatus,
  ];
  if (next.length) {
    lines.push('', 'Coming up (Zambia time):');
    next.forEach(function (e) { lines.push(lusakaStamp(e.t) + '  ' + e.ccy + '  ' + e.title); });
  } else if (newsLoadedAt) {
    lines.push('', 'No more ' + NEWS_IMPACT + '-impact news this week.');
  }
  return lines.join('\n');
}

// ---------- News trading (Capital.com demo) ----------
// After a high-impact release, wait a few minutes, then trade in the direction the
// price moved if the move is big and still holding. Stop loss and take profit are
// the same as other Capital trades. Experimental: there is no proof this has an edge.
let newsTrade = process.env.NEWS_TRADE !== 'off';
const NT_WAIT_MIN = Number(process.env.NT_WAIT_MIN || 3);       // wait after the release
const NT_WINDOW_MIN = Number(process.env.NT_WINDOW_MIN || 20);  // stop looking after this
const NT_MARKETS = { USD: ['EURUSD', 'GOLD'], EUR: ['EURUSD'], GBP: ['GBPUSD'], JPY: ['USDJPY'], AUD: ['AUDUSD'], CAD: ['USDCAD'] };
const newsTraded = {};
let ntMinAtr = Number(process.env.NT_MIN_ATR || 2);
const ntStats = {};        // event title -> { n, sum, since }
let ntAll = { n: 0, sum: 0 };
const NT_AVOID_AFTER = 5;  // trades before an event type can be avoided
const NT_COOLDOWN_MS = 7 * 24 * 3600 * 1000;

function ntAvoid(title) {
  const s = ntStats[title];
  if (!s || s.n < NT_AVOID_AFTER || s.sum >= 0) return false;
  if (Date.now() - s.last > NT_COOLDOWN_MS) { ntStats[title] = { n: 0, sum: 0, last: Date.now() }; return false; }   // try again after a week
  return true;
}

// Called when a news trade closes: learn, but slowly (small samples are noise)
function newsLearn(t, profit) {
  const s = ntStats[t.newsTitle] || (ntStats[t.newsTitle] = { n: 0, sum: 0, last: 0 });
  s.n++; s.sum += profit; s.last = Date.now();
  ntAll.n++; ntAll.sum += profit;
  const msgs = [];
  if (s.n === NT_AVOID_AFTER && s.sum < 0) msgs.push('Stopped trading "' + t.newsTitle + '": ' + s.n + ' trades, net $' + s.sum.toFixed(2) + '. Will retry in a week.');
  if (ntAll.n % 10 === 0) {
    if (ntAll.sum < 0 && ntMinAtr < 4) { ntMinAtr += 0.5; msgs.push('Last 10 news trades lost overall, so I now ask for a bigger move: ' + ntMinAtr + 'x.'); }
    ntAll = { n: 0, sum: 0 };
  }
  if (msgs.length) sendTelegram('🧠 *News learning*\n' + md(msgs.join('\n')));
}

function ntReport() {
  const lines = ['📰 News trading: ' + (newsTrade ? 'ON' : 'OFF') + ' · needs a move of ' + ntMinAtr + 'x normal', ''];
  const keys = Object.keys(ntStats);
  if (!keys.length) lines.push('No news trades closed yet.');
  keys.forEach(function (k) {
    const s = ntStats[k];
    lines.push(k + ': ' + s.n + ' trades, net $' + s.sum.toFixed(2) + (ntAvoid(k) ? ' (avoiding)' : ''));
  });
  return lines.join('\n');
}

function newsMove(epic, eventT) {
  return capCall('GET', '/prices/' + epic + '?resolution=MINUTE&max=60').then(function (j) {
    const p = j.prices || [];
    const mid = function (o) { return (Number(o.bid) + Number(o.ask)) / 2; };
    const ts = function (x) { return Date.parse((x.snapshotTimeUTC || x.snapshotTime) + 'Z'); };
    let i0 = -1;
    for (let i = 0; i < p.length; i++) { if (ts(p[i]) >= eventT - 60000) { i0 = i; break; } }
    if (i0 < 15 || i0 >= p.length - 1) return null;
    let sum = 0;
    for (let i = i0 - 14; i < i0; i++) sum += mid(p[i].highPrice) - mid(p[i].lowPrice);
    const atr = sum / 14;
    const start = mid(p[i0].openPrice);
    const last = p[p.length - 1];
    const now = mid(last.closePrice);
    const move = now - start;
    let hi = -Infinity, lo = Infinity;
    for (let i = i0; i < p.length; i++) { hi = Math.max(hi, mid(p[i].highPrice)); lo = Math.min(lo, mid(p[i].lowPrice)); }
    return { atr: atr, move: move, now: now, hi: hi, lo: lo, start: start };
  });
}

function maybeNewsTrade() {
  if (!newsTrade || !newsOn || !autoTrade || !CAP_ON || tradeBroker === 'deriv' || circuitOpen) return Promise.resolve();
  const now = Date.now();
  const due = newsEvents.filter(function (e) {
    return now >= e.t + NT_WAIT_MIN * 60000 && now <= e.t + NT_WINDOW_MIN * 60000 && NT_MARKETS[e.ccy];
  });
  return due.reduce(function (chain, e) {
    return NT_MARKETS[e.ccy].reduce(function (c2, sym) {
      const key = e.t + e.ccy + e.title + sym;
      if (newsTraded[key]) return c2;
      return c2.then(function () {
        const pair = PAIRS.filter(function (p) { return p.symbol === sym; })[0];
        if (!pair) return null;
        if (pendingTrades.some(function (t) { return t.display === pair.display; })) return null;
        if (openCount() >= 6) return null;
        if (ntAvoid(e.title)) return null;
        newsTraded[key] = true;   // one try per event and market
        return capEpic(sym).then(function (epic) { return newsMove(epic, e.t); }).then(function (m) {
          if (!m || !(m.atr > 0)) return null;
          const size = Math.abs(m.move);
          if (size < ntMinAtr * m.atr) {
            console.log('News trade skip ' + sym + ': move too small');
            return null;
          }
          const action = m.move > 0 ? 'BUY' : 'SELL';
          // still holding: price must be in the outer 40% of the range since the release
          const rng = m.hi - m.lo;
          const pos = rng > 0 ? (m.now - m.lo) / rng : 0.5;
          if ((action === 'BUY' && pos < 0.6) || (action === 'SELL' && pos > 0.4)) {
            console.log('News trade skip ' + sym + ': move already fading');
            return null;
          }
          return capitalTrade(sym, action).then(function (t) {
            tradesToday++;
            pendingTrades.push({
              contractId: t.dealId, display: pair.display, symbol: sym, action: action,
              placedAt: Date.now(), votes: { news: action === 'BUY' ? 1 : -1 }, minutes: CAP_MAX_HOLD_MIN, broker: 'capital', newsTitle: e.title,
            });
            dbInsertTrade({
              contract_id: String(t.dealId), symbol: sym, action: action, confidence: 0,
              votes: { news: action === 'BUY' ? 1 : -1 }, rsi: 0, hour: lusakaHour(),
              stake: Number(t.riskUsd.toFixed(2)), demo: true,
            });
            return sendTelegram(
              '📰 *NEWS TRADE — ' + md(pair.display) + '* \\(Capital demo\\)\n\n' +
              md(e.ccy + ' ' + e.title) + '\n' +
              md(action) + ' · moved ' + md((size / m.atr).toFixed(1)) + 'x normal since the release\n' +
              'Size ' + md(t.size) + ' · risk about $' + md(t.riskUsd.toFixed(2)) + '\n' +
              'Stop loss: ' + md(t.sl.toPrecision(4)) + ' away · Take profit: ' + md(t.tp.toPrecision(4)) + ' away\n' +
              '\nExperimental, no proven edge\\.'
            );
          });
        }).catch(function (err) {
          console.log('News trade ' + sym + ': ' + err.message);
          return null;
        });
      });
    }, chain);
  }, Promise.resolve());
}

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
      if (openCount() >= (tradeBroker === 'both' ? 6 : MAX_OPEN_TRADES)) return null;
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
    .then(maybeSmcTrade)
    .then(mirrorSync)
    .then(maybeForward)
    .then(maybeForwardWeekly)
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

