// Open a demo position with stop loss and take profit
function capitalTrade(symbol, action, opts) {
  return capEpic(symbol).then(function (epic) { return capitalTradeEpic(epic, action, opts); });
}

function capitalTradeEpic(epic, action, opts) {
  return Promise.all([capCall('GET', '/markets/' + epic), capAtr(epic)]).then(function (res) {
    const m = res[0];
    const atr = res[1];
    const snap = m.snapshot || {};
    if (snap.marketStatus && snap.marketStatus !== 'TRADEABLE') throw new Error('Market closed: ' + epic);
    const bid = Number(snap.bid), ask = Number(snap.offer);
    const price = action === 'BUY' ? ask : bid;
    const rules = m.dealingRules || {};
    const minD = rules.minNormalStopOrLimitDistance || rules.minStopOrProfitDistance || {};
    let minDist = Number(minD.value || 0);
    if (minD.unit === 'PERCENTAGE') minDist = price * minDist / 100;
    const spread = Math.abs(ask - bid);
    let sl = Math.max(atr * capSlAtr, minDist * 1.2, spread * 4);
    if (opts && opts.sl > 0) sl = Math.max(opts.sl, minDist * 1.2, spread * 4);
    if (!(sl > 0)) throw new Error('Could not work out a stop distance for ' + epic);
    const tp = sl * ((opts && opts.rr) || capRR);
    const minSize = Number((rules.minDealSize || {}).value || 0.01);
    const step = Number((rules.minSizeIncrement || {}).value || minSize);
    const maxSize = Number((rules.maxDealSize || {}).value || 1e9);
    let size = capRisk / sl;
    size = Math.floor(size / step) * step;
    size = Math.max(minSize, Math.min(maxSize, Number(size.toFixed(6))));
    if (size * sl > capRisk * 2.5) throw new Error('Too big for your risk setting: ' + epic + ' (smallest trade would risk $' + (size * sl).toFixed(2) + ')');
    const body = {
      epic: epic, direction: action === 'BUY' ? 'BUY' : 'SELL', size: size,
      stopDistance: Number(sl.toPrecision(6)), profitDistance: Number(tp.toPrecision(6)),
    };
    return capCall('POST', '/positions', body).then(function (o) {
      const ref = o.dealReference;
      if (!ref) throw new Error('Capital gave no deal reference');
      return new Promise(function (r) { setTimeout(r, 1200); }).then(function () {
        return capCall('GET', '/confirms/' + encodeURIComponent(ref));
      }).then(function (c) {
        if (c.dealStatus && c.dealStatus !== 'ACCEPTED') throw new Error('Order rejected: ' + (c.reason || c.dealStatus));
        const deal = (c.affectedDeals && c.affectedDeals[0] && c.affectedDeals[0].dealId) || c.dealId;
        if (!deal) throw new Error('Order accepted but no deal id came back');
        return { dealId: deal, size: size, level: c.level || price, sl: sl, tp: tp, riskUsd: size * sl, epic: epic };
      });
    });
  });
}

// Find out how a closed position ended (profit in account currency)
function capClosedProfit(dealId, lastUpl) {
  const to = new Date();
  const from = new Date(Date.now() - 24 * 3600 * 1000);
  const f = function (d) { return d.toISOString().slice(0, 19); };
  return capCall('GET', '/history/transactions?type=TRADE&from=' + f(from) + '&to=' + f(to)).then(function (j) {
    const list = j.transactions || [];
    for (let i = 0; i < list.length; i++) {
      if (JSON.stringify(list[i]).indexOf(dealId) >= 0) {
        const v = Number(String(list[i].size).replace(/[^0-9.\-]/g, ''));
        if (!isNaN(v) && String(list[i].size).length) return v;
      }
    }
    return lastUpl;
  }).catch(function () { return lastUpl; });
}

function checkCapitalTrades() {
  const mine = pendingTrades.filter(function (t) { return t.broker === 'capital'; });
  return mine.reduce(function (chain, t) {
    return chain.then(function () {
      return capCall('GET', '/positions/' + encodeURIComponent(t.contractId)).then(function (p) {
        if (p && p.position && p.position.upl !== undefined) t.lastUpl = Number(p.position.upl);
        const ageMin = (Date.now() - t.placedAt) / 60000;
        if (ageMin >= (t.holdMin || CAP_MAX_HOLD_MIN)) {
          // too long open: close it at market, the result is picked up on the next check
          return capCall('DELETE', '/positions/' + encodeURIComponent(t.contractId)).catch(function () { return null; });
        }
        return null;
      }).catch(function (e) {
        if (e.status !== 404) { console.error('Capital check: ' + e.message); return null; }
        return capClosedProfit(t.contractId, t.lastUpl || 0).then(function (profit) {
          const won = profit > 0;
          if (won) dailyWins++; else dailyLosses++;
          recordResult(won, profit);
          if (t.newsTitle) newsLearn(t, profit);
          if (t.volTrade) volLearn(t, profit);
          if (t.evoId) evoLearn(t, profit);
          pendingTrades.splice(pendingTrades.indexOf(t), 1);
          const closedAt = new Date().toISOString();
          memLog.unshift({
            contract_id: String(t.contractId), symbol: t.symbol, action: t.action,
            votes: t.votes || {}, won: won, profit: profit, closed_at: closedAt,
          });
          if (memLog.length > 500) memLog.pop();
          dbCloseTrade(String(t.contractId), { won: won, profit: profit, closed_at: closedAt });
          closedSinceLearn++;
          if (closedSinceLearn >= RECOMPUTE_EVERY) { closedSinceLearn = 0; learn(true); }
          return sendTelegram(
            (won ? '✅ *WIN*' : '❌ *LOSS*') + ' — ' + md(t.display) + ' ' + md(t.action) + ' \\(Capital demo\\)\n' +
            'Profit: ' + md(profit.toFixed(2)) + '\n' +
            'Total: ' + md(dailyWins) + 'W/' + md(dailyLosses) + 'L'
          );
        });
      });
    });
  }, Promise.resolve());
}

// /capital : check the login, balance and one market
function capitalDiag() {
  return capLogin().then(function () { return capBalance(); }).then(function (a) {
    const bal = a.balance || {};
    return capCall('GET', '/markets/EURUSD').then(function (m) {
      const rules = m.dealingRules || {};
      const minD = rules.minNormalStopOrLimitDistance || rules.minStopOrProfitDistance || {};
      const snap = m.snapshot || {};
      return [
        '✅ Capital.com demo connected',
        'Account: ' + (a.accountName || '') + ' ' + (a.accountType || '') + ' ' + (a.currency || ''),
        'Balance: ' + bal.balance + ' · Available: ' + bal.available,
        'EURUSD: ' + snap.marketStatus + ' bid ' + snap.bid + ' ask ' + snap.offer,
        'Min size: ' + ((rules.minDealSize || {}).value) + ' · Min stop: ' + minD.value + ' ' + (minD.unit || ''),
        'Broker now: ' + tradeBroker + ' · Risk $' + capRisk + ' per trade · Stop ' + capSlAtr + 'xATR · Target ' + capRR + 'x stop',
      ].join('\n');
    });
  });
}

function lusakaTime() {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Africa/Lusaka', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function lusakaHour() {
  return parseInt(new Date().toLocaleString('en-GB', {
    timeZone: 'Africa/Lusaka', hour: 'numeric', hour12: false,
  }), 10);
}

function getSession() {
  const h = lusakaHour();
  if (h >= 15 && h < 19) return { emoji: '🔥', message: 'Prime window, HIGH liquidity', quality: 3 };
  if (h >= 10 && h < 15) return { emoji: '✅', message: 'Good liquidity', quality: 2 };
  if (h >= 19 && h < 22) return { emoji: '⚠️', message: 'Low liquidity, be careful', quality: 1 };
  return { emoji: '😴', message: 'Very low volume', quality: 0 };
}

function availablePairs() {
  const day = new Date().getUTCDay();
  if (tradeBroker === 'both') {
    if (day === 0 || day === 6) return PAIRS.filter(function (p) { return p.crypto || p.type === 'derived'; });
    return PAIRS;
  }
  if (tradeBroker === 'capital') {
    if (day === 0 || day === 6) return PAIRS.filter(function (p) { return p.crypto; });
    return PAIRS.filter(function (p) { return p.type !== 'derived'; });
  }
  if (day === 0 || day === 6) return PAIRS.filter(function (p) { return p.type === 'derived'; });
  return PAIRS.filter(function (p) { return p.type !== 'cfd'; });
}

function analyseSymbol(symbol) {
  const pp = PAIRS.filter(function (x) { return x.symbol === symbol; })[0];
  if (tradeBroker !== 'deriv' && pp && pp.type !== 'derived') {
    return capEpic(symbol).then(capCloses).then(function (prices) { return analyze(prices); })
      .catch(function (e) { console.error('Analyze ' + symbol + ' (Capital): ' + e.message); return null; });
  }
  return fetchCandles(SYMBOL_MAP[symbol], 80)
    .then(function (prices) { return analyze(prices); })
    .catch(function (e) { console.error('Analyze ' + symbol + ': ' + e.message); return null; });
}

// ---------- Trade log + learning ----------
// Trades are saved in Supabase (survives Render restarts).
// If SUPABASE_URL / SUPABASE_KEY are not set, it keeps them in memory only.

const SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL).replace(/\/+$/, '');
const SUPABASE_KEY = cleanEnv(process.env.SUPABASE_KEY);
const DB_ON = !!(SUPABASE_URL && SUPABASE_KEY);
const MIN_LEARN_TRADES = 10;   // need this many samples before changing anything
const RECOMPUTE_EVERY = 1;
const PAIR_PAUSE_MIN = 8;     // re-learn after this many closed trades
const memLog = [];             // closed trades kept in memory as a fallback
const pausedPairs = {};        // symbol -> win rate that got it paused
let closedSinceLearn = 0;
let lastLearnInfo = 'No learning yet';

function dbHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
}

function dbInsertTrade(row) {
  if (!DB_ON) return Promise.resolve();
  return fetch(SUPABASE_URL + '/rest/v1/bot_trades', {
    method: 'POST', headers: dbHeaders(), body: JSON.stringify(row),
  }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { console.error('DB insert ' + r.status + ': ' + t.slice(0, 200)); });
  }).catch(function (e) { console.error('DB insert failed: ' + e.message); });
}

function dbCloseTrade(contractId, patch) {
  if (!DB_ON) return Promise.resolve();
  return fetch(SUPABASE_URL + '/rest/v1/bot_trades?contract_id=eq.' + encodeURIComponent(contractId), {
    method: 'PATCH', headers: dbHeaders(), body: JSON.stringify(patch),
  }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { console.error('DB update ' + r.status + ': ' + t.slice(0, 200)); });
  }).catch(function (e) { console.error('DB update failed: ' + e.message); });
}

function dbLoadClosed() {
  if (!DB_ON) return Promise.resolve(memLog.slice());
  return fetch(SUPABASE_URL + '/rest/v1/bot_trades?won=not.is.null&order=closed_at.desc&limit=500', {
    headers: dbHeaders(),
  }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error('DB load ' + r.status + ': ' + t.slice(0, 200)); });
    return r.json();
  }).catch(function (e) { console.error(e.message); return memLog.slice(); });
}

// Look at past results and adjust strategy weights and pair pauses
const PAUSE_HOURS = 24;
const pairResetAt = {};   // symbol -> time after which its trades count again
const pairPausedAt = {};

// Score of one closed trade: profit in units of the amount risked (about -1 for a loss, +1 or +2 for a win)
function tradeScore(t) {
  const stake = Number(t.stake || 0);
  const profit = Number(t.profit);
  if (stake > 0 && !isNaN(profit)) return Math.max(-1, Math.min(2, profit / stake));
  return t.won ? 1 : -1;
}

// Learn from every closed trade. Newer trades count more (half-life 40 trades).
// Steps are small until there are enough trades, so one result cannot swing the bot.
function learn(announce) {
  return dbLoadClosed().then(function (rows) {
    const old = {};
    STRATEGIES.forEach(function (k) { old[k] = weights[k]; });
    const stats = {};
    STRATEGIES.forEach(function (k) { stats[k] = { n: 0, ws: 0, wn: 0 }; });
    const pairStats = {};

    rows.forEach(function (t, idx) {
      const dir = t.action === 'BUY' ? 1 : -1;
      const votes = t.votes || {};
      const rw = Math.pow(0.5, idx / 40);
      const sc = tradeScore(t);
      STRATEGIES.forEach(function (k) {
        if (votes[k] === dir) { stats[k].n++; stats[k].ws += sc * rw; stats[k].wn += rw; }
      });
      const closed = Date.parse(t.closed_at || '') || 0;
      if (closed > (pairResetAt[t.symbol] || 0)) {
        const p = pairStats[t.symbol] || (pairStats[t.symbol] = { n: 0, ws: 0, wn: 0 });
        p.n++; p.ws += sc * rw; p.wn += rw;
      }
    });

    const lines = [];
    STRATEGIES.forEach(function (k) {
      const s = stats[k];
      if (s.n >= MIN_LEARN_TRADES) {
        const avg = s.ws / s.wn;                    // average score, recent trades weighted more
        const trust = Math.min(1, s.n / 60);
        weights[k] = Math.max(0.2, Math.min(2, 1 + Math.max(-0.6, Math.min(0.6, avg)) * trust));
      } else {
        weights[k] = 1;
      }
      lines.push(STRAT_NAMES[k] + ': ' + s.n + ' trades' + (s.n ? ', avg ' + (s.ws / s.wn).toFixed(2) + 'R' : '') +
        ' weight ' + weights[k].toFixed(2));
    });

    // Pause a market whose recent average result is clearly negative; retry after PAUSE_HOURS
    const now = Date.now();
    Object.keys(pausedPairs).forEach(function (k) { delete pausedPairs[k]; });
    Object.keys(pairStats).forEach(function (sym) {
      const p = pairStats[sym];
      if (p.n >= PAIR_PAUSE_MIN && p.ws / p.wn < -0.4) {
        if (!pairPausedAt[sym]) pairPausedAt[sym] = now;
        if (now - pairPausedAt[sym] > PAUSE_HOURS * 3600000) {
          delete pairPausedAt[sym];
          pairResetAt[sym] = now;            // fresh start: old losses no longer count
        } else {
          pausedPairs[sym] = Math.round(p.ws / p.wn * 100) / 100;
        }
      } else {
        delete pairPausedAt[sym];
      }
    });

    lastLearnInfo = 'Trades studied: ' + rows.length + '\n' + lines.join('\n') +
      (Object.keys(pausedPairs).length ? '\nPaused markets: ' + Object.keys(pausedPairs).join(', ') : '');
    console.log('Learned from ' + rows.length + ' trades');

    if (announce) {
      const ch = [];
      STRATEGIES.forEach(function (k) {
        if (Math.abs(weights[k] - old[k]) >= 0.01) ch.push(STRAT_NAMES[k] + ' ' + old[k].toFixed(2) + ' to ' + weights[k].toFixed(2));
      });
      const pz = Object.keys(pausedPairs);
      return sendTelegram('🧠 *Learned from that trade*\n' +
        md(rows.length < MIN_LEARN_TRADES ? 'Only ' + rows.length + ' trades so far. Weights stay at 1.00 until ' + MIN_LEARN_TRADES + ' trades.' :
          (ch.length ? 'Weights: ' + ch.join(', ') : 'No weight change.')) +
        (pz.length ? '\n' + md('Paused markets: ' + pz.join(', ')) : ''));
    }
    return null;
  }).catch(function (e) { console.error('Learn failed: ' + e.message); });
}

function recordResult(won, profit) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== pnlDay) { pnlDay = day; dayPnl = 0; consecLosses = 0; circuitOpen = false; circuitReason = ''; }
  dayPnl += profit;
  consecLosses = won ? 0 : consecLosses + 1;
  if (!circuitOpen && consecLosses >= MAX_CONSEC_LOSSES) {
    circuitOpen = true;
    circuitReason = consecLosses + ' losses in a row';
  } else if (!circuitOpen && dayPnl <= -MAX_DAILY_LOSS) {
    circuitOpen = true;
    circuitReason = 'lost $' + Math.abs(dayPnl).toFixed(2) + ' today';
  }
  if (circuitOpen && !circuitNotified) {
    circuitNotified = true;
    sendTelegram('🛑 *Auto\\-trading paused*: ' + md(circuitReason) + '\\.\nNo new trades until tomorrow, or send /resume\\.');
  }
}
let circuitNotified = false;

function checkPendingTrades() {
  const now = Date.now();
  const due = pendingTrades.filter(function (t) { return now - t.placedAt >= ((t.minutes || 15) + 0.5) * 60 * 1000; });
  return due.reduce(function (chain, t) {
    return chain.then(function () {
      return checkContract(t.contractId).then(function (r) {
        if (!r.is_sold && now - t.placedAt < ((t.minutes || 15) + 10) * 60 * 1000) return null;
        const profit = Number(r.profit || 0);
        const won = r.status === 'won' || profit > 0;
        if (won) dailyWins++; else dailyLosses++;
        recordResult(won, profit);
        pendingTrades.splice(pendingTrades.indexOf(t), 1);
        const closedRow = {
          contract_id: String(t.contractId), symbol: t.symbol, action: t.action,
          votes: t.votes || {}, won: won, profit: profit, closed_at: new Date().toISOString(),
        };
        memLog.unshift(closedRow);
        if (memLog.length > 500) memLog.pop();
        dbCloseTrade(String(t.contractId), { won: won, profit: profit, closed_at: closedRow.closed_at });
        closedSinceLearn++;
        if (closedSinceLearn >= RECOMPUTE_EVERY) { closedSinceLearn = 0; learn(true); }
        return sendTelegram(
          (won ? '✅ *WIN*' : '❌ *LOSS*') + ' — ' + md(t.display) + ' ' + md(t.action) + '\n' +
          'Profit: ' + md(profit.toFixed(2)) + '\n' +
          'Total: ' + md(dailyWins) + 'W/' + md(dailyLosses) + 'L'
        );
      }).catch(function (e) { console.error('Check failed: ' + e.message); });
    });
  }, Promise.resolve());
}

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
        if (pendingTrades.length >= 6) return null;
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

