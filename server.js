const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3001;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'forexpulse2024';
const DERIV_APP_ID = process.env.DERIV_APP_ID || '342T8yYeveFOVV6CT9yoV';
const DERIV_WS_URL = 'wss://ws.derivws.com/websockets/v3?app_id=' + DERIV_APP_ID;

const SYMBOL_MAP = {
  EURUSD: 'frxEURUSD', GBPUSD: 'frxGBPUSD', USDJPY: 'frxUSDJPY',
  AUDUSD: 'frxAUDUSD', USDCAD: 'frxUSDCAD',
};

function derivWS(messages) {
  return new Promise(function(resolve, reject) {
    const ws = new WebSocket(DERIV_WS_URL);
    const responses = [];
    let idx = 0;

    const timer = setTimeout(function() {
      ws.close();
      reject(new Error('Deriv WebSocket timed out after 30s'));
    }, 30000);

    ws.on('open', function() {
      ws.send(JSON.stringify(messages[idx]));
    });

    ws.on('message', function(data) {
      const msg = JSON.parse(data.toString());
      responses.push(msg);
      if (msg.error) {
        clearTimeout(timer);
        ws.close();
        const errMsg = msg.error.message || JSON.stringify(msg.error);
        reject(new Error('Deriv: ' + errMsg));
        return;
      }
      idx++;
      if (idx < messages.length) {
        ws.send(JSON.stringify(messages[idx]));
      } else {
        clearTimeout(timer);
        ws.close();
        resolve(responses);
      }
    });

    ws.on('error', function(e) {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function derivBuy(token, symbol, action, stake, durationMin) {
  const derivSym = SYMBOL_MAP[symbol];
  if (!derivSym) return Promise.resolve({ ok: false, error: symbol + ' not supported' });

  return derivWS([
    { authorize: token },
    {
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: action === 'BUY' ? 'CALL' : 'PUT',
      currency: 'USD',
      duration: durationMin,
      duration_unit: 'm',
      symbol: derivSym,
    },
  ]).then(function(propRes) {
    const prop = propRes[1] && propRes[1].proposal;
    if (!prop) return { ok: false, error: 'No proposal returned' };

    return derivWS([
      { authorize: token },
      { buy: prop.id, price: prop.ask_price },
    ]).then(function(buyRes) {
      const buy = buyRes[1] && buyRes[1].buy;
      if (!buy) return { ok: false, error: 'Buy order failed' };
      return { ok: true, contractId: buy.contract_id, buyPrice: buy.buy_price, payout: buy.payout };
    });
  }).catch(function(err) {
    return { ok: false, error: err.message };
  });
}

function derivBalance(token) {
  return derivWS([
    { authorize: token },
    { balance: 1, account: 'current' },
  ]).then(function(res) {
    const bal = res[1] && res[1].balance;
    return bal ? bal.currency + ' ' + Number(bal.balance).toFixed(2) : 'connected';
  }).catch(function(err) {
    return 'Error: ' + err.message;
  });
}

const server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Secret');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const secret = req.headers['x-bridge-secret'];
  if (secret !== BRIDGE_SECRET) {
    res.writeHead(401);
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', function() {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }

    const token = process.env.DERIV_API_TOKEN;
    if (!token) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: 'DERIV_API_TOKEN not set' }));
      return;
    }

    console.log('[' + new Date().toISOString() + '] Command:', payload.cmd);

    if (payload.cmd === 'BUY' || payload.cmd === 'SELL') {
      derivBuy(token, payload.symbol, payload.cmd, payload.stake || 10, payload.duration || 5)
        .then(function(result) {
          res.writeHead(200);
          res.end(JSON.stringify(result));
        });
    } else if (payload.cmd === 'BALANCE') {
      derivBalance(token).then(function(balance) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, balance: balance }));
      });
    } else {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'Unknown command: ' + payload.cmd }));
    }
  });
});

server.listen(PORT, function() {
  console.log('ForexPulse Bridge running on port ' + PORT);
  console.log('Deriv App ID: ' + DERIV_APP_ID);
});
