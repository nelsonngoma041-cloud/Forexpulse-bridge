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

function analyze(prices) {
  if (prices.length < 35) {
    return { action: 'WAIT', confidence: 0, reason: 'Not enough data', rsi: 50, macd: 0, price: prices[prices.length - 1] || 0 };
  }
  const rsi = calcRSI(prices, 14);
  const macd = calcMACD(prices);
  const ma20 = calcEMA(prices, 20);
  const price = prices[prices.length - 1];

  let buy = 0, sell = 0;
  const why = [];

  if (rsi < 35) { buy += 35; why.push('RSI oversold ' + rsi.toFixed(1)); }
  else if (rsi > 65) { sell += 35; why.push('RSI overbought ' + rsi.toFixed(1)); }

  if (macd.prevHistogram <= 0 && macd.histogram > 0) { buy += 35; why.push('MACD bullish cross'); }
  else if (macd.prevHistogram >= 0 && macd.histogram < 0) { sell += 35; why.push('MACD bearish cross'); }
  else if (macd.histogram > 0) buy += 10;
  else if (macd.histogram < 0) sell += 10;

  if (price > ma20) { buy += 20; if (buy > sell) why.push('Price above MA20'); }
  else { sell += 20; if (sell > buy) why.push('Price below MA20'); }

  let action = 'WAIT';
  let confidence = 0;
  if (buy >= 55 && buy > sell) { action = 'BUY'; confidence = Math.round(buy / (buy + sell) * 100); }
  else if (sell >= 55 && sell > buy) { action = 'SELL'; confidence = Math.round(sell / (buy + sell) * 100); }

  return {
    action: action,
    confidence: confidence,
    rsi: Math.round(rsi * 10) / 10,
    macd: Math.round(macd.histogram * 10000) / 10000,
    price: price,
    reason: why.join(' + ') || 'No clear setup',
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

// ---------- HTTP ----------

function send(res, code, obj) {
  res.writeHead(code);
  res.end(JSON.stringify(obj));
}

const server = http.createServer(function (req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) {
    send(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  let body = '';
  req.on('data', function (c) { body += c; });
  req.on('end', function () {
    let p;
    try { p = JSON.parse(body); }
    catch (e) { send(res, 400, { ok: false, error: 'Invalid JSON' }); return; }

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
      listAccounts().then(function (j) {
        send(res, 200, { ok: true, accounts: j });
      }).catch(function (err) {
        send(res, 200, { ok: false, error: err.message });
      });
      return;
    }

    if (p.cmd === 'BALANCE') {
      derivBalance().then(function (b) {
        send(res, 200, { ok: true, balance: b });
      }).catch(function (err) {
        send(res, 200, { ok: false, error: err.message });
      });
      return;
    }

    send(res, 400, { ok: false, error: 'Unknown command: ' + p.cmd });
  });
});

server.listen(PORT, function () {
  console.log('ForexPulse Bridge on port ' + PORT);
  console.log('App ID set: ' + (DERIV_APP_ID ? 'yes' : 'NO') + ' | Token set: ' + (DERIV_API_TOKEN ? 'yes' : 'NO'));
});
