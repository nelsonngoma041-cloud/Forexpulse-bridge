// railway-bridge/server.js
// Runs on Railway — connects to Deriv WebSocket and executes trades
// Called by ForexPulse on Vercel via HTTP

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3001;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'forexpulse2024';
const DERIV_APP_ID = process.env.DERIV_APP_ID || '342T8yYeveFOVV6CT9yoV';
const DERIV_WS_URL = wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;

const SYMBOL_MAP = {
EURUSD: 'frxEURUSD', GBPUSD: 'frxGBPUSD', USDJPY: 'frxUSDJPY',
AUDUSD: 'frxAUDUSD', USDCAD: 'frxUSDCAD',
};

// ─── Deriv WebSocket helper ───────────────────────────────────────────────────

function derivWS(messages) {
return new Promise((resolve, reject) => {
const ws = new WebSocket(DERIV_WS_URL);
const responses = [];
let idx = 0;

const timer = setTimeout(() => {
ws.close();
reject(new Error('Deriv WebSocket timed out after 30s'));
}, 30000);

ws.on('open', () => ws.send(JSON.stringify(messages[idx])));

ws.on('message', (data) => {
const msg = JSON.parse(data.toString());
responses.push(msg);
if (msg.error) {
clearTimeout(timer); ws.close();
reject(new Error(Deriv:${msg.error.message ?? JSON.stringify(msg.error)}`));
return;
}
idx++;
if (idx < messages.length) ws.send(JSON.stringify(messages[idx]));
else { clearTimeout(timer); ws.close(); resolve(responses); }
});

ws.on('error', (e) => { clearTimeout(timer); reject(e); });
});
}

async function derivBuy(token, symbol, action, stake, durationMin) {
const derivSym = SYMBOL_MAP[symbol];
if (!derivSym) return { ok: false, error: ${symbol} not supported` };

try {
const propRes = await derivWS([
{ authorize: token },
{ proposal: 1, amount: stake, basis: 'stake',
contract_type: action === 'BUY' ? 'CALL' : 'PUT',
currency: 'USD', duration: durationMin, duration_unit: 'm', symbol: derivSym },
 ]);

const prop = propRes[1]?.proposal;
if (!prop) return { ok: false, error: 'No proposal returned' };

const buyRes = await derivWS([
{ authorize: token },
{ buy: prop.id, price: prop.ask_price },
 ]);

const buy = buyRes[1]?.buy;
if (!buy) return { ok: false, error: 'Buy order failed' };

return { ok: true, contractId: buy.contract_id, buyPrice: buy.buy_price, payout: buy.payout };
} catch (err) {
return { ok: false, error: err.message };
}
}

async function derivBalance(token) {
try {
const res = await derivWS([
{ authorize: token },
{ balance: 1, account: 'current' },
 ]);
const bal = res[1]?.balance;
return bal ? ``${bal.currency} latex
{Number(bal.balance).toFixed(2)}` : 'connected'; } catch (err) { return `Error: 

{err.message}`;
}
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Secret');
res.setHeader('Content-Type', 'application/json');

if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

// Auth
const secret = req.headers['x-bridge-secret'];
if (secret !== BRIDGE_SECRET) {
res.writeHead(401);
res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
return;
}

// Parse body
let body = '';
for await (const chunk of req) body += chunk;

let payload;
try { payload = JSON.parse(body); }
catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }

const token = process.env.DERIV_API_TOKEN;
if (!token) {
res.writeHead(500);
res.end(JSON.stringify({ ok: false, error: 'DERIV_API_TOKEN not set' }));
return;
}

console.log([${new Date().toISOString()}] Command:`, payload.cmd);

try {
if (payload.cmd === 'BUY' || payload.cmd === 'SELL') {
const result = await derivBuy(token, payload.symbol, payload.cmd, payload.stake ?? 10, payload.duration ?? 5);
res.writeHead(200);
res.end(JSON.stringify(result));
} else if (payload.cmd === 'BALANCE') {
const balance = await derivBalance(token);
res.writeHead(200);
res.end(JSON.stringify({ ok: true, balance }));
} else {
res.writeHead(400);
res.end(JSON.stringify({ ok: false, error: Unknown command:${payload.cmd}` }));
}
} catch (err) {
res.writeHead(502);
res.end(JSON.stringify({ ok: false, error: err.message }));
}
});

server.listen(PORT, () => {
console.log(ForexPulse Railway Bridge running on port ${PORT}); console.log(Deriv App ID: ${DERIV_APP_ID});
});
