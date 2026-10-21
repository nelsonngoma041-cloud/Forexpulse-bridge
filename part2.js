// Recent 1-minute closes from Capital.com, for the signal analysis
function capCloses(epic) {
  return capCall('GET', '/prices/' + epic + '?resolution=MINUTE&max=100').then(function (j) {
    return (j.prices || []).map(function (x) { return (Number(x.closePrice.bid) + Number(x.closePrice.ask)) / 2; });
  });
}

let capTokens = null;      // { cst, sec, at }
let capLastLogin = 0;

function capLogin() {
  if (!CAP_ON) return Promise.reject(new Error('Capital.com is not set up. Add CAPITAL_API_KEY, CAPITAL_API_PASSWORD, CAPITAL_EMAIL in Render.'));
  const wait = Math.max(0, 1200 - (Date.now() - capLastLogin));   // limit: 1 login per second
  return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
    capLastLogin = Date.now();
    return fetch(CAP_BASE + '/session', {
      method: 'POST',
      headers: { 'X-CAP-API-KEY': CAP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: CAP_EMAIL, password: CAP_PASS, encryptedPassword: false }),
    });
  }).then(function (r) {
    if (!r.ok) {
      return r.text().then(function (t) { throw new Error('Capital login ' + r.status + ': ' + t.slice(0, 160)); });
    }
    const cst = r.headers.get('cst');
    const sec = r.headers.get('x-security-token');
    if (!cst || !sec) throw new Error('Capital login gave no session tokens');
    capTokens = { cst: cst, sec: sec, at: Date.now() };
    return r.json().catch(function () { return {}; });
  });
}

let capLoginP = null;
function capEnsure() {
  if (capTokens && Date.now() - capTokens.at < 8 * 60 * 1000) return Promise.resolve();
  if (!capLoginP) {
    capLoginP = capLogin().then(function () { capLoginP = null; }, function (e) { capLoginP = null; throw e; });
  }
  return capLoginP;
}

// method, path like '/positions', optional JSON body
function capCall(method, path, body, retried) {
  return capEnsure().then(function () { return capThrottle(); }).then(function () {
    const opt = {
      method: method,
      headers: { 'X-SECURITY-TOKEN': capTokens.sec, CST: capTokens.cst, 'Content-Type': 'application/json' },
    };
    if (body) opt.body = JSON.stringify(body);
    return fetch(CAP_BASE + path, opt);
  }).then(function (r) {
    if (r.status === 401 && !retried) { capTokens = null; return capCall(method, path, body, true); }
    return r.text().then(function (t) {
      let j = {};
      try { j = JSON.parse(t); } catch (e) { j = { raw: t }; }
      if (!r.ok) {
        const err = new Error('Capital ' + r.status + ': ' + (j.errorCode || j.raw || t).toString().slice(0, 160));
        err.status = r.status;
        throw err;
      }
      return j;
    });
  });
}

function capBalance() {
  return capCall('GET', '/accounts').then(function (j) {
    const a = (j.accounts || []).filter(function (x) { return x.preferred; })[0] || (j.accounts || [])[0];
    if (!a) throw new Error('No Capital.com account found');
    return a;
  });
}

function capAtr(epic) {
  return capCall('GET', '/prices/' + epic + '?resolution=MINUTE&max=30').then(function (j) {
    const p = j.prices || [];
    const mid = function (o) { return (Number(o.bid) + Number(o.ask)) / 2; };
    if (p.length < 16) throw new Error('Not enough price data for ' + epic);
    let sum = 0, n = 0;
    for (let i = p.length - 14; i < p.length; i++) {
      const h = mid(p[i].highPrice), l = mid(p[i].lowPrice), pc = mid(p[i - 1].closePrice);
      sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      n++;
    }
    return sum / n;
  });
}

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
          if (t.smcId) smcLearn(t, profit);
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

