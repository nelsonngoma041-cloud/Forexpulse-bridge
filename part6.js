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
      const pair = availablePairs()[0] || PAIRS[0];
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
