const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3001;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'forexpulse2024';
// Strip spaces, quotes, newlines and an accidental "Bearer " prefix
function cleanEnv(v) {
  return String(v || '').trim().replace(/^bearer\s+/i, '').replace(/^["']+|["']+$/g, '').trim();
}
const DERIV_APP_ID = cleanEnv(process.env.DERIV_APP_ID);
const DERIV_API_TOKEN = cleanEnv(process.env.DERIV_API_TOKEN);
const DERIV_ACCOUNT_ID = cleanEnv(process.env.DERIV_ACCOUNT_ID);

// Safe description of the credentials (never the full token)
function credInfo() {
  return 'token len ' + DERIV_API_TOKEN.length +
    ', starts "' + DERIV_API_TOKEN.slice(0, 4) + '", ends "' + DERIV_API_TOKEN.slice(-4) + '"' +
    ' | appId len ' + DERIV_APP_ID.length + ', starts "' + DERIV_APP_ID.slice(0, 3) + '"';
}

// New Deriv API
const REST_BASE = 'https://api.derivws.com/trading/v1/options';
const PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';

const SYMBOL_MAP = {
  EURUSD: 'frxEURUSD', GBPUSD: 'frxGBPUSD', USDJPY: 'frxUSDJPY',
  AUDUSD: 'frxAUDUSD', USDCAD: 'frxUSDCAD',
  V75: 'R_75', V25: 'R_25', V50: 'R_50', V10: 'R_10',
  CRASH: 'CRASH500', BOOM: 'BOOM500',
};

// ---------- Indicators ----------

function calcRSI(prices, period) {
  period = period || 14;
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce(function (a, b) { return a + b; }, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcMACD(prices) {
  if (prices.length < 35) return { histogram: 0, prevHistogram: 0 };
  const series = [];
  for (let i = 26; i <= prices.length; i++) {
    const s = prices.slice(0, i);
    series.push(calcEMA(s, 12) - calcEMA(s, 26));
  }
  const signal = calcEMA(series, 9);
  const prevSignal = calcEMA(series.slice(0, -1), 9);
  return {
    histogram: series[series.length - 1] - signal,
    prevHistogram: series[series.length - 2] - prevSignal,
  };
}

// ---------- Multi-strategy voting ----------
// Each strategy votes +1 (buy), -1 (sell) or 0 (no opinion).
// Weights start at 1 and are adjusted by the learning step.

const STRATEGIES = ['rsi', 'macd', 'trend', 'bands', 'breakout'];
const STRAT_NAMES = { rsi: 'RSI', macd: 'MACD', trend: 'Trend', bands: 'Bollinger', breakout: 'Breakout' };
const weights = { rsi: 1, macd: 1, trend: 1, bands: 1, breakout: 1 };

function calcBands(prices, period, mult) {
  const s = prices.slice(-period);
  const mean = s.reduce(function (a, b) { return a + b; }, 0) / s.length;
  const variance = s.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / s.length;
  const sd = Math.sqrt(variance);
  return { upper: mean + mult * sd, lower: mean - mult * sd };
}

function getVotes(prices) {
  const price = prices[prices.length - 1];
  const rsi = calcRSI(prices, 14);
  const macd = calcMACD(prices);
  const ema9 = calcEMA(prices, 9);
  const ema21 = calcEMA(prices, 21);
  const bands = calcBands(prices, 20, 2);
  const prior = prices.slice(-21, -1);
  const hi = Math.max.apply(null, prior);
  const lo = Math.min.apply(null, prior);

  const votes = { rsi: 0, macd: 0, trend: 0, bands: 0, breakout: 0 };
  if (rsi < 35) votes.rsi = 1; else if (rsi > 65) votes.rsi = -1;
  if (macd.prevHistogram <= 0 && macd.histogram > 0) votes.macd = 1;
  else if (macd.prevHistogram >= 0 && macd.histogram < 0) votes.macd = -1;
  if (price > ema21 && ema9 > ema21) votes.trend = 1;
  else if (price < ema21 && ema9 < ema21) votes.trend = -1;
  if (price <= bands.lower) votes.bands = 1; else if (price >= bands.upper) votes.bands = -1;
  if (price > hi) votes.breakout = 1; else if (price < lo) votes.breakout = -1;

  return { votes: votes, rsi: rsi, macd: macd };
}

function analyze(prices) {
  if (prices.length < 35) {
    return { action: 'WAIT', confidence: 0, reason: 'Not enough data', rsi: 50, macd: 0, price: prices[prices.length - 1] || 0, votes: {} };
  }
  const price = prices[prices.length - 1];
  const g = getVotes(prices);

  let buyW = 0, sellW = 0, nBuy = 0, nSell = 0, total = 0;
  STRATEGIES.forEach(function (k) {
    const w = weights[k];
    total += w;
    if (g.votes[k] > 0) { buyW += w; nBuy++; }
    else if (g.votes[k] < 0) { sellW += w; nSell++; }
  });

  let action = 'WAIT';
  let confidence = 0;
  let dir = 0;
  // At least 2 strategies must agree, and agreement must beat disagreement
  if (nBuy >= 2 && buyW > sellW) { action = 'BUY'; dir = 1; confidence = Math.min(95, Math.round(50 + 50 * (buyW - sellW) / total)); }
  else if (nSell >= 2 && sellW > buyW) { action = 'SELL'; dir = -1; confidence = Math.min(95, Math.round(50 + 50 * (sellW - buyW) / total)); }

  const names = STRATEGIES.filter(function (k) { return dir !== 0 && g.votes[k] === dir; })
    .map(function (k) { return STRAT_NAMES[k]; });

  return {
    action: action,
    confidence: confidence,
    rsi: Math.round(g.rsi * 10) / 10,
    macd: Math.round(g.macd.histogram * 10000) / 10000,
    price: price,
    votes: g.votes,
    reason: names.length ? names.join(' + ') + ' agree' : 'No clear setup',
  };
}

// ---------- Deriv helpers ----------

// One request, one reply, over any WebSocket URL
function wsRequest(url, message, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const ws = new WebSocket(url);
    const timer = setTimeout(function () { ws.close(); reject(new Error('Deriv WS timed out')); }, timeoutMs || 20000);
    ws.on('open', function () { ws.send(JSON.stringify(message)); });
    ws.on('message', function (data) {
      clearTimeout(timer);
      ws.close();
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { reject(e); return; }
      if (msg.error) { reject(new Error(msg.error.message || JSON.stringify(msg.error))); return; }
      resolve(msg);
    });
    ws.on('error', function (e) { clearTimeout(timer); reject(e); });
  });
}

// Public market data: no login needed
function fetchCandles(derivSymbol, count) {
  return wsRequest(PUBLIC_WS, {
    ticks_history: derivSymbol,
    adjust_start_time: 1,
    count: count,
    end: 'latest',
    start: 1,
    style: 'candles',
    granularity: 60,
  }).then(function (msg) {
    return (msg.candles || []).map(function (c) { return Number(c.close); });
  });
}

function authHeaders() {
  const h = { Authorization: 'Bearer ' + DERIV_API_TOKEN, 'Content-Type': 'application/json' };
  if (DERIV_APP_ID) h['Deriv-App-ID'] = DERIV_APP_ID;
  return h;
}

// List your Options accounts (demo + real)
function listAccounts() {
  if (!DERIV_API_TOKEN) return Promise.reject(new Error('DERIV_API_TOKEN not set'));
  return fetch(REST_BASE + '/accounts', { method: 'GET', headers: authHeaders() })
    .then(function (r) {
      return r.text().then(function (t) {
        let j;
        try { j = JSON.parse(t); } catch (e) { j = { raw: t }; }
        if (!r.ok) {
          return runDiag().then(function (d) {
            throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 120) + ' [' + credInfo() + '] DIAG: ' + d);
          });
        }
        return j;
      });
    });
}

// Tries several ways to call Deriv and reports only the HTTP status of each
function runDiag() {
  function probe(label, url, method, headers) {
    return fetch(url, { method: method, headers: headers })
      .then(function (r) { return label + '=' + r.status; })
      .catch(function (e) { return label + '=ERR'; });
  }
  const withApp = { Authorization: 'Bearer ' + DERIV_API_TOKEN, 'Deriv-App-ID': DERIV_APP_ID };
  const noApp = { Authorization: 'Bearer ' + DERIV_API_TOKEN };
  const noAuth = { 'Deriv-App-ID': DERIV_APP_ID };
  return Promise.all([
    probe('health', 'https://api.derivws.com/v1/health', 'GET', {}),
    probe('getWithApp', REST_BASE + '/accounts', 'GET', withApp),
    probe('getNoApp', REST_BASE + '/accounts', 'GET', noApp),
    probe('getNoToken', REST_BASE + '/accounts', 'GET', noAuth),
  ]).then(function (a) { return a.join(' '); });
}

// Get a one-time WebSocket URL for an account
function getOtpUrl(accountId) {
  return fetch(REST_BASE + '/accounts/' + accountId + '/otp', { method: 'POST', headers: authHeaders() })
    .then(function (r) {
      return r.text().then(function (t) {
        let j;
        try { j = JSON.parse(t); } catch (e) { j = {}; }
        if (!r.ok) throw new Error('OTP HTTP ' + r.status + ': ' + t.slice(0, 300));
        if (!j.data || !j.data.url) throw new Error('No WebSocket URL in reply');
        return j.data.url;
      });
    });
}

function derivBalance() {
  if (!DERIV_API_TOKEN) return Promise.reject(new Error('DERIV_API_TOKEN not set'));
  if (!DERIV_ACCOUNT_ID) return Promise.reject(new Error('DERIV_ACCOUNT_ID not set. Run ACCOUNTS first'));
  return getOtpUrl(DERIV_ACCOUNT_ID).then(function (url) {
    return wsRequest(url, { balance: 1 }, 20000);
  }).then(function (msg) {
    const b = msg.balance;
    return b ? (b.currency || '') + ' ' + Number(b.balance).toFixed(2) : JSON.stringify(msg).slice(0, 200);
  });
}

// ---------- Auto trading (demo only unless ALLOW_REAL=true) ----------

const MAX_STAKE = Number(process.env.MAX_STAKE || 5);
let maxTradesPerDay = Number(process.env.MAX_TRADES_PER_DAY || 20);
let limitNotifiedDay = '';
const ALLOW_REAL = process.env.ALLOW_REAL === 'true';
let durationMin = Number(process.env.DURATION_MIN || 15); // trade length in minutes
const FALLBACK_DURATIONS = [5, 3, 1];
let tradeDay = '';
let tradesToday = 0;

function isDemoAccount() {
  // Deriv demo IDs start with DOT or VRT. Real ones start with ROT or CR.
  return /^(DOT|VRT)/i.test(DERIV_ACCOUNT_ID);
}

function placeTrade(symbol, action, stake) {
  if (!DERIV_API_TOKEN) return Promise.reject(new Error('DERIV_API_TOKEN not set'));
  if (!DERIV_ACCOUNT_ID) return Promise.reject(new Error('DERIV_ACCOUNT_ID not set'));
  if (!isDemoAccount() && !ALLOW_REAL) {
    return Promise.reject(new Error('Blocked: account is not demo. Set ALLOW_REAL=true to trade real money'));
  }
  const derivSym = SYMBOL_MAP[symbol];
  if (!derivSym) return Promise.reject(new Error('Unknown symbol ' + symbol));
  if (action !== 'BUY' && action !== 'SELL') return Promise.reject(new Error('Bad action ' + action));

  const today = new Date().toISOString().slice(0, 10);
  if (today !== tradeDay) { tradeDay = today; tradesToday = 0; }
  if (tradesToday >= maxTradesPerDay) {
    return Promise.reject(new Error('Daily trade limit reached (' + maxTradesPerDay + ')'));
  }

  let amount = Number(stake);
  if (!(amount > 0)) amount = 1;
  if (amount > MAX_STAKE) amount = MAX_STAKE;

  // Try the chosen duration first. If Deriv says it is not offered, try shorter ones.
  const tries = [durationMin].concat(FALLBACK_DURATIONS.filter(function (d) { return d < durationMin; }));
  const attempt = function (i) {
    const mins = tries[i];
    return getOtpUrl(DERIV_ACCOUNT_ID).then(function (url) {
      return wsRequest(url, {
        buy: '1',
        price: amount,
        parameters: {
          contract_type: action === 'BUY' ? 'CALL' : 'PUT',
          currency: 'USD',
          underlying_symbol: derivSym,
          amount: amount,
          basis: 'stake',
          duration: mins,
          duration_unit: 'm',
        },
      }, 25000);
    }).then(function (msg) { msg.usedMinutes = mins; return msg; })
      .catch(function (e) {
        if (i + 1 < tries.length && /not offered|duration/i.test(e.message)) return attempt(i + 1);
        throw e;
      });
  };
  return attempt(0).then(function (msg) {
    tradesToday++;
    const b = msg.buy || {};
    return {
      contract_id: b.contract_id,
      buy_price: b.buy_price,
      longcode: b.longcode,
      minutes: msg.usedMinutes,
      balance_after: b.balance_after,
      account: DERIV_ACCOUNT_ID,
      tradesToday: tradesToday,
    };
  });
}

function checkContract(contractId) {
  if (!contractId) return Promise.reject(new Error('contract_id missing'));
  return getOtpUrl(DERIV_ACCOUNT_ID).then(function (url) {
    return wsRequest(url, { proposal_open_contract: 1, contract_id: Number(contractId) }, 20000);
  }).then(function (msg) {
    const c = msg.proposal_open_contract || {};
    return {
      is_sold: !!c.is_sold,
      status: c.status,
      profit: c.profit,
      sell_price: c.sell_price,
    };
  });
}


// ---------- Telegram ----------

const TELEGRAM_TOKEN = cleanEnv(process.env.TELEGRAM_TOKEN);
const TELEGRAM_CHAT_ID = cleanEnv(process.env.TELEGRAM_CHAT_ID);

const BACKTICK = String.fromCharCode(96);
const MD_CHARS = '_*[]()~' + BACKTICK + '>#+-=|{}.!\\';

// Escape text for Telegram MarkdownV2
function md(v) {
  const s = String(v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (MD_CHARS.indexOf(s[i]) >= 0) out += '\\';
    out += s[i];
  }
  return out;
}

function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Telegram not configured');
    return Promise.resolve(false);
  }
  return fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'MarkdownV2' }),
  }).then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) console.error('Telegram error:', j.description);
      return j.ok === true;
    })
    .catch(function (e) { console.error('Telegram failed:', e.message); return false; });
}

// ---------- Bot ----------

const STAKE = Number(process.env.DERIV_STAKE || 1);
const MIN_CONFIDENCE = 65;
const COOLDOWN_MS = 15 * 60 * 1000;
const MAX_OPEN_TRADES = 3;

const PAIRS = [
  { symbol: 'EURUSD', display: 'EUR/USD', type: 'forex', decimals: 5 },
  { symbol: 'GBPUSD', display: 'GBP/USD', type: 'forex', decimals: 5 },
  { symbol: 'USDJPY', display: 'USD/JPY', type: 'forex', decimals: 3 },
  { symbol: 'AUDUSD', display: 'AUD/USD', type: 'forex', decimals: 5 },
  { symbol: 'USDCAD', display: 'USD/CAD', type: 'forex', decimals: 5 },
  { symbol: 'V75', display: 'Volatility 75', type: 'derived', decimals: 2 },
  { symbol: 'V25', display: 'Volatility 25', type: 'derived', decimals: 3 },
  { symbol: 'V50', display: 'Volatility 50', type: 'derived', decimals: 4 },
  { symbol: 'CRASH', display: 'Crash 500', type: 'derived', decimals: 3 },
  { symbol: 'BOOM', display: 'Boom 500', type: 'derived', decimals: 3 },
];

let botRunning = false;
let autoTrade = process.env.AUTO_TRADE === 'true';
let signalCount = 0;
let dailyWins = 0;
let dailyLosses = 0;
let scanning = false;
let loopTimer = null;
let lastSummaryDate = '';
const lastSignalAt = {};
const blockedUntil = {};
const pendingTrades = [];
const recentSignals = [];

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
  if (day === 0 || day === 6) return PAIRS.filter(function (p) { return p.type === 'derived'; });
  return PAIRS;
}

function analyseSymbol(symbol) {
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
const MIN_LEARN_TRADES = 20;   // need this many samples before changing anything
const RECOMPUTE_EVERY = 5;     // re-learn after this many closed trades
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
function learn() {
  return dbLoadClosed().then(function (rows) {
    const stats = {};
    STRATEGIES.forEach(function (k) { stats[k] = { n: 0, w: 0 }; });
    const pairStats = {};

    rows.forEach(function (t) {
      const dir = t.action === 'BUY' ? 1 : -1;
      const votes = t.votes || {};
      STRATEGIES.forEach(function (k) {
        if (votes[k] === dir) { stats[k].n++; if (t.won) stats[k].w++; }
      });
      const p = pairStats[t.symbol] || (pairStats[t.symbol] = { n: 0, w: 0 });
      p.n++; if (t.won) p.w++;
    });

    const lines = [];
    STRATEGIES.forEach(function (k) {
      const s = stats[k];
      if (s.n >= MIN_LEARN_TRADES) {
        const wr = s.w / s.n;
        const trust = Math.min(1, s.n / 60);
        weights[k] = Math.max(0.2, Math.min(2, 1 + (wr - 0.5) * 4 * trust));
      } else {
        weights[k] = 1;
      }
      lines.push(STRAT_NAMES[k] + ': ' + s.w + '/' + s.n + (s.n ? ' (' + Math.round(s.w / s.n * 100) + '%)' : '') +
        ' weight ' + weights[k].toFixed(2));
    });

    Object.keys(pausedPairs).forEach(function (k) { delete pausedPairs[k]; });
    Object.keys(pairStats).forEach(function (sym) {
      const p = pairStats[sym];
      if (p.n >= MIN_LEARN_TRADES && p.w / p.n < 0.35) pausedPairs[sym] = Math.round(p.w / p.n * 100);
    });

    lastLearnInfo = 'Trades studied: ' + rows.length + '\n' + lines.join('\n') +
      (Object.keys(pausedPairs).length ? '\nPaused pairs: ' + Object.keys(pausedPairs).join(', ') : '');
    console.log('Learned from ' + rows.length + ' trades');
  }).catch(function (e) { console.error('Learn failed: ' + e.message); });
}

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
        pendingTrades.splice(pendingTrades.indexOf(t), 1);
        const closedRow = {
          contract_id: String(t.contractId), symbol: t.symbol, action: t.action,
          votes: t.votes || {}, won: won, profit: profit, closed_at: new Date().toISOString(),
        };
        memLog.unshift(closedRow);
        if (memLog.length > 500) memLog.pop();
        dbCloseTrade(String(t.contractId), { won: won, profit: profit, closed_at: closedRow.closed_at });
        closedSinceLearn++;
        if (closedSinceLearn >= RECOMPUTE_EVERY) { closedSinceLearn = 0; learn(); }
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

function dispatchSignal() {
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
      !(p.symbol in pausedPairs);
  });

  return Promise.all(pairs.map(function (p) {
    return analyseSymbol(p.symbol).then(function (a) { return { pair: p, a: a }; });
  })).then(function (results) {
    const valid = results.filter(function (r) {
      return r.a && r.a.action !== 'WAIT' && r.a.confidence >= MIN_CONFIDENCE;
    }).sort(function (x, y) { return y.a.confidence - x.a.confidence; });

    if (valid.length === 0) { console.log('No clear setup this round'); return null; }

    const pair = valid[0].pair;
    const a = valid[0].a;
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
      if (pendingTrades.length >= MAX_OPEN_TRADES) return null;
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
  });
}

function tick() {
  if (!botRunning || scanning) return;
  scanning = true;
  Promise.resolve()
    .then(checkPendingTrades)
    .then(maybeDailySummary)
    .then(dispatchSignal)
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
      const pair = availablePairs()[0];
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
