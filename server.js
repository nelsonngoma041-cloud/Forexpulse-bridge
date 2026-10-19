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
function capitalTrade(symbol, action) {
  return capEpic(symbol).then(function (epic) { return capitalTradeEpic(epic, action); });
}

function capitalTradeEpic(epic, action) {
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
    if (!(sl > 0)) throw new Error('Could not work out a stop distance for ' + epic);
    const tp = sl * capRR;
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
        if (ageMin >= CAP_MAX_HOLD_MIN) {
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
          pendingTrades.splice(pendingTrades.indexOf(t), 1);
          const closedAt = new Date().toISOString();
          memLog.unshift({
            contract_id: String(t.contractId), symbol: t.symbol, action: t.action,
            votes: t.votes || {}, won: won, profit: profit, closed_at: closedAt,
          });
          if (memLog.length > 500) memLog.pop();
          dbCloseTrade(String(t.contractId), { won: won, profit: profit, closed_at: closedAt });
          closedSinceLearn++;
          if (closedSinceLearn >= RECOMPUTE_EVERY) { closedSinceLearn = 0; learn(); }
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
      if (pendingTrades.length >= (tradeBroker === 'both' ? 6 : MAX_OPEN_TRADES)) return null;
      if (tradeBroker !== 'deriv' && pair.type !== 'derived') {
        return capitalTrade(pair.symbol, a.action).then(function (t) {
          signalCount++;
          tradesToday++;
          lastSignalAt[pair.symbol] = Date.now();
          pendingTrades.push({
            contractId: t.dealId, display: pair.display, symbol: pair.symbol, action: a.action,
            placedAt: Date.now(), votes: a.votes || {}, minutes: CAP_MAX_HOLD_MIN, broker: 'capital',
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
  const rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
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
      return sendTelegram('🔀 Trading broker: *' + md(arg) + '*' + (arg === 'capital' ? md(' (Capital demo: forex, metals, indices, oil, crypto)') : arg === 'both' ? md(' (Capital demo for forex, metals, indices, oil, crypto + Deriv for volatility indices)') : md(' (Deriv, all its markets)')) + '\\. Resets if Render re
