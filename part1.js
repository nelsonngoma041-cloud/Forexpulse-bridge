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
  GOLD: 'frxXAUUSD', SILVER: 'frxXAGUSD',
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
const MIN_AGREE = Number(process.env.MIN_AGREE || 3); // strategies that must agree
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
  if (nBuy >= MIN_AGREE && buyW > sellW) { action = 'BUY'; dir = 1; confidence = Math.min(95, Math.round(50 + 50 * (buyW - sellW) / total)); }
  else if (nSell >= MIN_AGREE && sellW > buyW) { action = 'SELL'; dir = -1; confidence = Math.min(95, Math.round(50 + 50 * (sellW - buyW) / total)); }

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
function fetchCandles(derivSymbol, count, timeoutMs) {
  return wsRequest(PUBLIC_WS, {
    ticks_history: derivSymbol,
    adjust_start_time: 1,
    count: count,
    end: 'latest',
    start: 1,
    style: 'candles',
    granularity: 60,
  }, timeoutMs).then(function (msg) {
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
const MAX_CONSEC_LOSSES = Number(process.env.MAX_CONSEC_LOSSES || 4);
const MAX_DAILY_LOSS = Number(process.env.MAX_DAILY_LOSS || 5); // in dollars
let consecLosses = 0;
let dayPnl = 0;
let pnlDay = '';
let circuitOpen = false;
let circuitReason = '';
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
      if (!j.ok) {
        console.error('Telegram error:', j.description);
        if (/parse entities/i.test(String(j.description))) {
          const plain = String(text).replace(/\\(.)/g, '$1').replace(/\*/g, '');
          return fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: plain }),
          }).then(function (r2) { return r2.json(); }).then(function (j2) { return j2.ok === true; });
        }
      }
      return j.ok === true;
    })
    .catch(function (e) { console.error('Telegram failed:', e.message); return false; });
}

// ---------- Bot ----------

const STAKE = Number(process.env.DERIV_STAKE || 1);
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 75);
const COOLDOWN_MS = 15 * 60 * 1000;
const MAX_OPEN_TRADES = 3;

const PAIRS = [
  { symbol: 'EURUSD', display: 'EUR/USD', type: 'forex', decimals: 5 },
  { symbol: 'GBPUSD', display: 'GBP/USD', type: 'forex', decimals: 5 },
  { symbol: 'USDJPY', display: 'USD/JPY', type: 'forex', decimals: 3 },
  { symbol: 'AUDUSD', display: 'AUD/USD', type: 'forex', decimals: 5 },
  { symbol: 'USDCAD', display: 'USD/CAD', type: 'forex', decimals: 5 },
  { symbol: 'GOLD', display: 'Gold/USD', type: 'forex', decimals: 2 },
  { symbol: 'SILVER', display: 'Silver/USD', type: 'forex', decimals: 3 },
  { symbol: 'US100', display: 'US Tech 100', type: 'cfd', decimals: 1, epic: 'US100', term: 'US Tech 100' },
  { symbol: 'US500', display: 'US 500', type: 'cfd', decimals: 1, epic: 'US500', term: 'US 500' },
  { symbol: 'DE40', display: 'Germany 40', type: 'cfd', decimals: 1, epic: 'DE40', term: 'Germany 40' },
  { symbol: 'J225', display: 'Japan 225', type: 'cfd', decimals: 1, epic: 'J225', term: 'Japan 225' },
  { symbol: 'OIL', display: 'Crude Oil', type: 'cfd', decimals: 2, epic: 'OIL_CRUDE', term: 'Oil - Crude' },
  { symbol: 'BTC', display: 'Bitcoin', type: 'cfd', crypto: true, decimals: 0, epic: 'BTCUSD', term: 'Bitcoin' },
  { symbol: 'ETH', display: 'Ethereum', type: 'cfd', crypto: true, decimals: 1, epic: 'ETHUSD', term: 'Ethereum' },
  { symbol: 'V75', display: 'Volatility 75', type: 'derived', decimals: 2 },
  { symbol: 'V25', display: 'Volatility 25', type: 'derived', decimals: 3 },
  { symbol: 'V50', display: 'Volatility 50', type: 'derived', decimals: 4 },
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

// ---------- Capital.com (DEMO only) with stop loss and take profit ----------
// Set TRADE_BROKER=capital (or send /broker capital) to trade forex and metals
// on the Capital.com demo account. Volatility indices stay on Deriv.
// Needs CAPITAL_API_KEY, CAPITAL_API_PASSWORD, CAPITAL_EMAIL in Render.

const CAP_BASE = 'https://demo-api-capital.backend-capital.com/api/v1';
const CAP_KEY = cleanEnv(process.env.CAPITAL_API_KEY);
const CAP_PASS = cleanEnv(process.env.CAPITAL_API_PASSWORD);
const CAP_EMAIL = cleanEnv(process.env.CAPITAL_EMAIL);
const CAP_ON = !!(CAP_KEY && CAP_PASS && CAP_EMAIL);
let tradeBroker = (function () { const b = (process.env.TRADE_BROKER || 'deriv').toLowerCase(); return (b === 'capital' || b === 'both') ? b : 'deriv'; })();
let capRisk = Number(process.env.CAP_RISK || 3);              // dollars risked per trade (the stop loss)
let capSlAtr = Number(process.env.CAP_SL_ATR || 3);           // stop loss = this many 1-min ATRs
let capRR = Number(process.env.CAP_RR || 2);                  // take profit = stop loss x this
const CAP_MAX_HOLD_MIN = Number(process.env.CAP_MAX_HOLD_MIN || 120);
const CAP_RESOLVED = {};   // symbol -> real Capital.com epic
let capNext = 0;
function capThrottle() {   // stay under the 10 requests per second limit
  const now = Date.now();
  const at = Math.max(now, capNext);
  capNext = at + 150;
  return new Promise(function (r) { setTimeout(r, at - now); });
}

// Find the real market name (epic) on Capital.com, by guess first, then by search
function capEpic(symbol) {
  const p = PAIRS.filter(function (x) { return x.symbol === symbol; })[0];
  if (!p) return Promise.reject(new Error('Not offered on Capital.com: ' + symbol));
  if (CAP_RESOLVED[symbol]) return Promise.resolve(CAP_RESOLVED[symbol]);
  const guess = p.epic || p.symbol;
  return capCall('GET', '/markets/' + encodeURIComponent(guess)).then(function () {
    CAP_RESOLVED[symbol] = guess;
    return guess;
  }).catch(function (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
    return capCall('GET', '/markets?searchTerm=' + encodeURIComponent(p.term || p.display)).then(function (j) {
      const m = (j.markets || [])[0];
      if (!m || !m.epic) {
        blockedUntil[symbol] = Date.now() + 6 * 60 * 60 * 1000;
        throw new Error('Not offered on Capital.com: ' + symbol);
      }
      CAP_RESOLVED[symbol] = m.epic;
      return m.epic;
    });
  });
}

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

