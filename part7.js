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
  if (cmd === '/smc') {
    if (arg === 'on' || arg === 'off') smcOn = arg === 'on';
    return sendTelegram(md(smcReport()));
  }
  if (cmd === '/smctest') {
    if (smcRunning || evoRunning || stratRunning || volRunning) return sendTelegram('⏳ A test is already running\\.');
    smcRunning = true;
    return sendTelegram('⏳ Market\\-structure test started \\(BOS, FVG, pullback entries\\)\\. About 3 to 6 minutes\\.').then(function () {
      return runSmcTest();
    }).then(function (res) {
      smcRunning = false;
      return res.msgs.reduce(function (chain, m) { return chain.then(function () { return sendLong(m); }); }, Promise.resolve());
    }).catch(function (e) {
      smcRunning = false;
      return sendTelegram('❌ Market\\-structure test failed: ' + md(e.message));
    });
  }
  if (cmd === '/evolved') {
    if (arg === 'on' || arg === 'off') evoOn = arg === 'on';
    return sendTelegram(md(evoReport()));
  }
  if (cmd === '/strategysearch') {
    if (evoRunning || stratRunning || volRunning) return sendTelegram('⏳ A test is already running\\.');
    evoRunning = true;
    return sendTelegram('⏳ Strategy search started: the bot is building and testing its own rules\\. About 5 to 10 minutes\\.').then(function () {
      return runStrategySearch();
    }).then(function (res) {
      evoRunning = false;
      return res.msgs.reduce(function (chain, m) { return chain.then(function () { return sendLong(m); }); }, Promise.resolve());
    }).catch(function (e) {
      evoRunning = false;
      return sendTelegram('❌ Strategy search failed: ' + md(e.message));
    });
  }
  if (cmd === '/volatile') {
    if (arg === 'on' || arg === 'off') volatileMode = arg === 'on';
    return sendTelegram(md(volReport()));
  }
  if (cmd === '/volatiletest') {
    if (volRunning || stratRunning) return sendTelegram('⏳ A test is already running\\.');
    volRunning = true;
    return sendTelegram('⏳ Volatile\\-market test started\\. About 3 to 6 minutes\\.').then(function () {
      return runVolatileTest();
    }).then(function (res) {
      volRunning = false;
      return res.msgs.reduce(function (chain, m) { return chain.then(function () { return sendLong(m); }); }, Promise.resolve());
    }).catch(function (e) {
      volRunning = false;
      return sendTelegram('❌ Volatile test failed: ' + md(e.message));
    });
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
      return sendTelegram('🔀 Trading broker: *' + md(arg) + '*' + (arg === 'capital' ? md(' (Capital demo: forex, metals, indices, oil, crypto)') : arg === 'both' ? md(' (Capital demo for forex, metals, indices, oil, crypto + Deriv for volatility indices)') : md(' (Deriv, all its markets)')) + '\\. Resets if Render restarts unless TRADE_BROKER is set\\.');
    }
    return sendTelegram('Broker now: ' + md(tradeBroker) + '\nUse /broker capital, /broker deriv or /broker both');
  }
  if (cmd === '/risk') {
    const v = Number(arg);
    if (!(v >= 0.5 && v <= 50)) return sendTelegram('💵 Capital risk per trade: $' + md(capRisk) + '\nUse /risk 3 \\(between 0\\.5 and 50\\)');
    capRisk = v;
    return sendTelegram('💵 Risk per trade set to *$' + md(v) + '*');
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
