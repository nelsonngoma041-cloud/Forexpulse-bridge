function fwReport() {
  const closed = fwRecs.filter(function (r) { return r.st === 'closed' && r.r !== null; });
  const open = fwRecs.filter(function (r) { return r.st === 'open'; }).length;
  const L = ['📓 *' + md('Forward tracker (no orders, real prices)') + '*'];
  const first = fwRecs.reduce(function (m, r) { return Math.min(m, r.ts); }, Infinity);
  L.push(md((fwOn ? 'ON' : 'OFF') + ' · ' + fwRecs.length + ' pretend trades recorded, ' + closed.length + ' finished, ' + open + ' open' + (isFinite(first) ? ' · tracking since ' + new Date(first).toISOString().slice(0, 10) : '') + (DB_ON && fwDbOk ? ' · saved in Supabase' : ' · memory only (lost on restart)')));
  if (!closed.length) { L.push(md('No finished trades yet. Signals appear a few per day, and each takes up to 48 hours to finish.')); return L.join('\n'); }
  const f = function (a) { return a.n ? a.n + ' trades, ' + stF(a.exp) + 'R each, PF ' + a.pf.toFixed(2) + ', win ' + Math.round(100 * a.w / a.n) + '%' : 'none'; };
  const vol = closed.filter(function (r) { return r.vol; }), calm = closed.filter(function (r) { return !r.vol; });
  L.push('');
  L.push(md('Volatile hours (all strategies together): ' + f(fwAgg(vol))));
  L.push(md('Other hours (all strategies together): ' + f(fwAgg(calm))));
  L.push('');
  L.push('*' + md('By strategy (volatile | all hours)') + '*');
  Object.keys(FW_NAMES).forEach(function (k) {
    const mine = closed.filter(function (r) { return r.k === k; });
    if (!mine.length) return;
    const av = fwAgg(mine.filter(function (r) { return r.vol; })), aa = fwAgg(mine);
    L.push(md(FW_NAMES[k] + ': ' + (av.n ? av.n + ' at ' + stF(av.exp) : 'none') + ' | ' + aa.n + ' at ' + stF(aa.exp) + 'R'));
  });
  L.push('');
  const av = fwAgg(vol);
  L.push(md(av.n < 100
    ? 'Too early to judge: wait for at least 100 finished trades in the volatile group, and a result that stays positive across weeks. Signals overlap in time, so numbers look steadier than they are.'
    : (av.exp >= 0.05 && av.pf >= 1.15 ? 'Volatile group is positive on ' + av.n + ' trades. Keep watching: only trust it if it stays this way.' : 'Volatile group is not clearly positive on ' + av.n + ' trades. No edge so far.')));
  return L.join('\n');
}

function maybeForwardWeekly() {
  const nowL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }));
  const day = nowL.getDay();
  const key = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lusaka' });
  if (day !== 1 || lusakaHour() !== 8 || fwLastWeek === key || !fwOn) return Promise.resolve();
  fwLastWeek = key;
  return sendLong(fwReport());
}

// ===== Saved settings: switches and news-learning survive a Render restart (Supabase table bot_state) =====
let stateOk = true, stateLast = '';
function stateSnap() {
  return JSON.stringify({
    autoTrade: autoTrade, tradeBroker: tradeBroker, newsOn: newsOn, newsTrade: newsTrade, mirrorOn: mirrorOn, fwOn: fwOn,
    ntStats: ntStats, ntMinAtr: ntMinAtr, ntAll: ntAll, pairResetAt: pairResetAt, pairPausedAt: pairPausedAt,
  });
}
function stateSave() {
  if (!DB_ON || !stateOk) return Promise.resolve();
  const snap = stateSnap();
  if (snap === stateLast) return Promise.resolve();
  const h = dbHeaders(); h.Prefer = 'resolution=merge-duplicates,return=minimal';
  return fetch(SUPABASE_URL + '/rest/v1/bot_state?on_conflict=k', {
    method: 'POST', headers: h, body: JSON.stringify([{ k: 'main', v: JSON.parse(snap) }]),
  }).then(function (r) {
    if (r.ok) { stateLast = snap; return; }
    return r.text().then(function (t) { stateOk = false; console.error('State save ' + r.status + ': ' + t.slice(0, 160) + ' (settings not saved until the bot_state table exists)'); });
  }).catch(function (e) { console.error('State save failed: ' + e.message); });
}
function stateLoad() {
  if (!DB_ON) return Promise.resolve();
  return fetch(SUPABASE_URL + '/rest/v1/bot_state?k=eq.main&select=v', { headers: dbHeaders() }).then(function (r) {
    if (!r.ok) { stateOk = false; return null; }
    return r.json();
  }).then(function (rows) {
    const v = rows && rows[0] && rows[0].v;
    if (!v) return;
    if (typeof v.autoTrade === 'boolean') autoTrade = v.autoTrade;
    if (v.tradeBroker === 'deriv' || v.tradeBroker === 'capital' || v.tradeBroker === 'both') tradeBroker = v.tradeBroker;
    if (typeof v.newsOn === 'boolean') newsOn = v.newsOn;
    if (typeof v.newsTrade === 'boolean') newsTrade = v.newsTrade;
    if (typeof v.mirrorOn === 'boolean') mirrorOn = v.mirrorOn;
    if (typeof v.fwOn === 'boolean') fwOn = v.fwOn;
    if (v.ntStats && typeof v.ntStats === 'object') Object.keys(v.ntStats).forEach(function (k) { ntStats[k] = v.ntStats[k]; });
    if (isFinite(Number(v.ntMinAtr)) && Number(v.ntMinAtr) > 0) ntMinAtr = Number(v.ntMinAtr);
    if (v.ntAll && typeof v.ntAll === 'object') ntAll = v.ntAll;
    if (v.pairResetAt) Object.keys(v.pairResetAt).forEach(function (k) { pairResetAt[k] = v.pairResetAt[k]; });
    if (v.pairPausedAt) Object.keys(v.pairPausedAt).forEach(function (k) { pairPausedAt[k] = v.pairPausedAt[k]; });
    stateLast = stateSnap();
    console.log('Settings restored: auto-trade ' + autoTrade + ', broker ' + tradeBroker + ', mirror ' + mirrorOn);
  }).catch(function (e) { console.error('State load failed: ' + e.message); });
}
setInterval(stateSave, 30000);

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
  if (cmd === '/patterntest') {
    if (patRunning || smcRunning || evoRunning || stratRunning || volRunning) return sendTelegram('⏳ A test is already running\\.');
    patRunning = true;
    return sendTelegram('⏳ Pattern test started: candlestick and chart patterns\\. About 3 to 6 minutes\\.').then(function () {
      return runPatternTest();
    }).then(function (res) {
      patRunning = false;
      return res.msgs.reduce(function (chain, m) { return chain.then(function () { return sendLong(m); }); }, Promise.resolve());
    }).catch(function (e) {
      patRunning = false;
      return sendTelegram('❌ Pattern test failed: ' + md(e.message));
    });
  }
  if (cmd === '/forward') {
    if (arg === 'on' || arg === 'off') fwOn = arg === 'on';
    return sendLong(fwReport());
  }
  if (cmd === '/mirror') {
    if (arg === 'on' || arg === 'off') mirrorOn = arg === 'on';
    return sendTelegram('🪞 Mirror to Deriv: *' + md(mirrorOn ? 'ON' : 'OFF') + '*\\. Copies each Capital\\.com forex and metals trade on Deriv as a Rise/Fall contract\\. Use /mirror on or /mirror off\\.');
  }
  if (cmd === '/panic') {
    return panicStop();
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
  if (cmd === '/poctest') {
    if (pocRunning || smcRunning || evoRunning || stratRunning || volRunning) return sendTelegram('⏳ A test is already running\\.');
    pocRunning = true;
    return sendTelegram('⏳ Volume\\-profile PoC test started\\. About 3 to 6 minutes\\.').then(function () {
      return runPocTest();
    }).then(function (res) {
      pocRunning = false;
      return res.msgs.reduce(function (chain, m) { return chain.then(function () { return sendLong(m); }); }, Promise.resolve());
    }).catch(function (e) {
      pocRunning = false;
      return sendTelegram('❌ PoC test failed: ' + md(e.message));
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
  stateLoad().then(learn).then(capReconcile).then(fwLoad).then(function () {
    if (process.env.BOT_AUTOSTART === 'true') startBot(true);
  });
});
