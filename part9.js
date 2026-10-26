function fwAgg(list) {
  const a = { n: 0, w: 0, sum: 0, gp: 0, gl: 0 };
  list.forEach(function (r) { a.n++; a.sum += r.r; if (r.r > 0) { a.w++; a.gp += r.r; } else a.gl += -r.r; });
  a.pf = a.gl > 0 ? a.gp / a.gl : (a.gp > 0 ? 99 : 0);
  a.exp = a.n ? a.sum / a.n : 0;
  return a;
}

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
    autoTrade: autoTrade, tradeBroker: tradeBroker, newsOn: newsOn, newsTrade: newsTrade, mirrorOn: mirrorOn, fwOn: fwOn, gateOn: gateOn, capRiskPct: capRiskPct, ddPct: ddPct,
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
    if (typeof v.gateOn === 'boolean') gateOn = v.gateOn;
    if (isFinite(Number(v.capRiskPct)) && Number(v.capRiskPct) >= 0) capRiskPct = Number(v.capRiskPct);
    if (isFinite(Number(v.ddPct)) && Number(v.ddPct) >= 0) ddPct = Number(v.ddPct);
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

// ===== Market read before every Capital.com trade: reads the real hourly candles and can say "skip" =====
// Not proven to improve results. It removes bad-looking entries (wide spread, dead or wild market, strong
// counter-trend, exhausted move, no room to the day's high or low, opposite candle). Switch with /gate on|off.
let gateOn = process.env.GATE !== 'off';
const gateCache = {};
const gateStats = { pass: 0, block: 0, why: {} };
const gateNotified = {};

function gateRead(symbol) {
  const c = gateCache[symbol];
  if (c && Date.now() - c.t < 5 * 60000) return Promise.resolve(c.D);
  return fwBars(symbol).then(function (bars) {
    if (bars.length < 260) throw new Error('only ' + bars.length + ' candles');
    const D = stBuild(bars);
    D._pc = {};
    PAT_CANDLE.forEach(function (p) { D._pc[p[0]] = patCandle(D, p[0]); });
    gateCache[symbol] = { t: Date.now(), D: D };
    return D;
  });
}

// returns { ok, reasons[], facts[] } for a BUY (s=1) or SELL (s=-1)
function gateJudge(D, s, at) {
  const n = D.n, i = at === undefined ? n - 2 : at, e = i + 1;           // i = last finished candle, e = the one forming now
  const why = [], facts = [];
  const atr = D.atr[i];
  if (!(atr > 0)) return { ok: true, reasons: [], facts: ['not enough data'] };
  const price = D.o[e];

  // 1. spread
  const sp = D.sp[e], med = D.medSp;
  if (med > 0) {
    facts.push('spread ' + (sp / med).toFixed(1) + 'x normal');
    if (sp > 2 * med) why.push('spread is ' + (sp / med).toFixed(1) + 'x normal');
  }
  // 2. volatility versus the last 100 hours
  const arr = [];
  for (let k = Math.max(20, i - 100); k <= i; k++) if (D.atr[k] > 0) arr.push(D.atr[k]);
  arr.sort(function (a, b) { return a - b; });
  const ma = arr.length ? arr[Math.floor(arr.length / 2)] : atr;
  const vr = atr / ma;
  facts.push('movement ' + vr.toFixed(2) + 'x normal');
  if (vr < 0.6) why.push('market is dead (movement ' + vr.toFixed(2) + 'x normal)');
  if (vr > 2.5) why.push('market is too wild (movement ' + vr.toFixed(2) + 'x normal)');
  // 3. trend
  const up200 = D.c[i] > D.ema200[i], up50 = D.ema50[i] > D.ema200[i], h4 = D.h4up[i];
  const trend = (up200 && up50 && h4 >= 0) ? 1 : (!up200 && !up50 && h4 <= 0) ? -1 : 0;
  facts.push('trend ' + (trend > 0 ? 'up' : trend < 0 ? 'down' : 'mixed') + ', ADX ' + (D.adx[i] || 0).toFixed(0));
  if (trend === -s && (D.adx[i] || 0) >= 25) why.push('trading against a strong ' + (trend > 0 ? 'up' : 'down') + 'trend');
  // 4. exhausted move
  const rsi = D.rsi[i];
  facts.push('RSI ' + (rsi || 0).toFixed(0));
  if (s > 0 && rsi > 75) why.push('already stretched up (RSI ' + rsi.toFixed(0) + ')');
  if (s < 0 && rsi < 25) why.push('already stretched down (RSI ' + rsi.toFixed(0) + ')');
  // 5. room to run before the previous day's high / low
  const wall = s > 0 ? D.pdH[i] : D.pdL[i];
  if (wall > 0) {
    const room = s > 0 ? wall - price : price - wall;
    if (room > 0) {
      facts.push('room to day level ' + (room / atr).toFixed(1) + ' ATR');
      if (room < 0.5 * atr) why.push('price is right at yesterday\'s ' + (s > 0 ? 'high' : 'low'));
    }
  }
  // 6. what the last finished candle says
  const body = D.c[i] - D.o[i];
  facts.push('last candle ' + (body > 0 ? 'up' : 'down') + ' ' + (Math.abs(body) / atr).toFixed(1) + ' ATR');
  if (-s * body >= 1.2 * atr) why.push('last candle is a strong ' + (body > 0 ? 'up' : 'down') + ' move against the trade');
  let patAgainst = null;
  PAT_CANDLE.forEach(function (p) {
    try { if ((D._pc ? D._pc[p[0]] : patCandle(D, p[0]))[i] === -s) patAgainst = p[1]; } catch (err) { /* skip */ }
  });
  if (patAgainst) why.push('last candle shows ' + patAgainst + ' against the trade');
  return { ok: why.length === 0, reasons: why, facts: facts };
}

// used before a Capital trade is placed. If the candles cannot be read, the trade is allowed.
function gateCheck(symbol, action, display) {
  if (!gateOn) return Promise.resolve({ ok: true, reasons: [] });
  const s = action === 'BUY' ? 1 : -1;
  return gateRead(symbol).then(function (D) {
    const r = gateJudge(D, s);
    if (r.ok) { gateStats.pass++; return r; }
    gateStats.block++;
    r.reasons.forEach(function (w) { const k = w.replace(/[0-9.]+/g, '#'); gateStats.why[k] = (gateStats.why[k] || 0) + 1; });
    const key = symbol + ':' + Math.floor(Date.now() / 3600000);
    console.log('Gate skip ' + symbol + ' ' + action + ': ' + r.reasons.join('; '));
    if (!gateNotified[key]) {
      gateNotified[key] = true;
      sendTelegram('🔍 *Skipped ' + md(display || symbol) + ' ' + md(action) + '*\n' + md(r.reasons.join('; ') + '.'));
    }
    return r;
  }).catch(function (err) { console.log('Gate could not read ' + symbol + ': ' + err.message); return { ok: true, reasons: [] }; });
}

function gateReport() {
  const L = ['🔍 Pre-trade market read: ' + (gateOn ? 'ON' : 'OFF'),
    'Before each Capital.com trade the bot reads the last hourly candles: spread, movement size, trend, stretched RSI, room to the day high/low, and the last candle.',
    'Passed: ' + gateStats.pass + ' · Skipped: ' + gateStats.block + ' (since restart)'];
  Object.keys(gateStats.why).sort(function (a, b) { return gateStats.why[b] - gateStats.why[a]; }).slice(0, 6).forEach(function (k) {
    L.push('  ' + gateStats.why[k] + 'x ' + k);
  });
  L.push('Not proven to improve results. Deriv synthetic indices are random, so candles are not read there.');
  L.push('/analyze EURUSD shows the full read of one market.');
  return L.join('\n');
}

function analyzeMarket(sym) {
  const known = {};
  PAIRS.forEach(function (p) { if (p.type !== 'derived') known[p.symbol] = p; });
  if (!known[sym]) return Promise.resolve('Unknown market. Try: ' + Object.keys(known).slice(0, 12).join(', '));
  return gateRead(sym).then(function (D) {
    const b = gateJudge(D, 1), sl = gateJudge(D, -1);
    const f = function (r) { return r.ok ? 'OK' : 'skip: ' + r.reasons.join('; '); };
    return ['🔍 ' + sym + ' (hourly candles, last finished ' + new Date(D.bars[D.n - 2].t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC)',
      b.facts.join(' · '), '', 'A BUY now: ' + f(b), 'A SELL now: ' + f(sl)].join('\n');
  }).catch(function (e) { return 'Could not read ' + sym + ': ' + e.message; });
}

// ===== Percent risk, drawdown pause, rolling walk-forward test, market-read A/B test =====
let capRiskPct = Number(process.env.CAP_RISK_PCT || 0);      // 0 = use the fixed dollar risk
let ddPct = Number(process.env.DD_PCT || 0);                 // 0 = only the dollar daily limit
let capBalCache = { v: 0, t: 0 };
let xtRunning = false;

function capBalFresh() {
  if (!CAP_ON) return Promise.resolve(capBalCache.v);
  if (capBalCache.v > 0 && Date.now() - capBalCache.t < 10 * 60000) return Promise.resolve(capBalCache.v);
  return capBalance().then(function (a) {
    const v = Number(a.balance && a.balance.balance) || 0;
    if (v > 0) capBalCache = { v: v, t: Date.now() };
    return capBalCache.v;
  }).catch(function () { return capBalCache.v; });
}
function capRiskNow() {
  if (!(capRiskPct > 0)) return Promise.resolve(capRisk);
  return capBalFresh().then(function (v) { return v > 0 ? Math.max(0.5, v * capRiskPct / 100) : capRisk; });
}
function ddLimitNow() {
  let lim = MAX_DAILY_LOSS;
  if (ddPct > 0 && capBalCache.v > 0) lim = Math.min(lim, capBalCache.v * ddPct / 100);
  if (ddPct > 0) capBalFresh();
  return lim;
}

// run fn(sym, D) on each market's hourly history
function xtEach(fn) {
  const errors = [];
  let used = 0, minT = Infinity, maxT = 0;
  return ST_MARKETS.reduce(function (chain, sym) {
    return chain.then(function () {
      return stFetchHistory(sym, STRAT_PAGES, errors).then(function (bars) {
        if (bars.length < 1000) { errors.push(sym + ': only ' + bars.length + ' bars'); return null; }
        used++;
        minT = Math.min(minT, bars[0].t); maxT = Math.max(maxT, bars[bars.length - 1].t);
        fn(sym, stBuild(bars));
        return new Promise(function (r) { setImmediate(r); });
      });
    });
  }, Promise.resolve()).then(function () { return { used: used, errors: errors, minT: minT, maxT: maxT }; });
}
function xtTrades(D, sym, keys) {
  const out = [];
  keys.forEach(function (k) {
    const si = ST_STRATS.findIndex(function (s) { return s[0] === k; });
    const sig = stSignals(k, D, 1000 + si * 77 + sym.length);
    stSim(D, sig, ST_VARIANTS[0], [D.n, D.n], [stNewAcc(), stNewAcc(), stNewAcc()], { overlap: 0, wideSpread: 0, noAtr: 0 }, out, null, sym, k);
  });
  out.forEach(function (r) { r.k = r.s; });
  return out;
}
function xtLine(a) { return a.n ? a.n + ' trades, ' + stF(stExp(a)) + 'R each, PF ' + stPF(a).toFixed(2) + ', win ' + Math.round(100 * a.w / a.n) + '%' : 'no trades'; }

// Rolling walk-forward: pick the best strategy on 150 days, trade it for the next 30 days, roll forward.
function runWalkForward() {
  if (!CAP_ON) return Promise.reject(new Error('Capital.com keys are missing.'));
  const keys = ST_STRATS.map(function (s) { return s[0]; });
  const names = {}; ST_STRATS.forEach(function (s) { names[s[0]] = s[1]; });
  const DAY = 86400000, TR = 150 * DAY, TE = 30 * DAY;
  let all = [];
  return xtEach(function (sym, D) { all = all.concat(xtTrades(D, sym, keys)); }).then(function (meta) {
    if (!meta.used || !all.length) throw new Error('No usable history. ' + (meta.errors[0] || ''));
    const t0 = all.reduce(function (m, r) { return Math.min(m, r.t); }, Infinity);
    const sel = stNewAcc(), base = stNewAcc(), rnd = stNewAcc();
    const lines = [], selR = [];
    let wins = 0, traded = 0, nW = 0;
    for (let ws = t0; ws + TR + TE <= meta.maxT; ws += TE) {
      nW++;
      const a = ws + TR, b = a + TE;
      const tr = {}, te = {};
      keys.forEach(function (k) { tr[k] = stNewAcc(); te[k] = stNewAcc(); });
      all.forEach(function (r) {
        if (r.t >= ws && r.x < a) stAdd(tr[r.k], r.r);
        else if (r.t >= a && r.t < b) stAdd(te[r.k], r.r);
      });
      let best = null;
      keys.forEach(function (k) {
        if (k === 'rand' || tr[k].n < 20) return;
        if (stExp(tr[k]) > 0 && (!best || stExp(tr[k]) > stExp(tr[best]))) best = k;
      });
      keys.forEach(function (k) {
        const x = te[k];
        if (k === 'rand') { rnd.n += x.n; rnd.w += x.w; rnd.sumR += x.sumR; rnd.gp += x.gp; rnd.gl += x.gl; }
        else { base.n += x.n; base.w += x.w; base.sumR += x.sumR; base.gp += x.gp; base.gl += x.gl; }
      });
      const d0 = new Date(a).toISOString().slice(0, 10);
      if (!best) { lines.push('Test month from ' + d0 + ': no strategy was positive in training, stayed out'); continue; }
      const x = te[best];
      sel.n += x.n; sel.w += x.w; sel.sumR += x.sumR; sel.gp += x.gp; sel.gl += x.gl;
      if (x.n) { traded++; if (x.sumR > 0) wins++; }
      lines.push('Test month from ' + d0 + ': picked ' + names[best] + ' (train ' + stF(stExp(tr[best])) + 'R), then ' + (x.n ? x.n + ' trades at ' + stF(stExp(x)) + 'R' : 'no trades'));
    }
    if (nW < 3) throw new Error('Only ' + nW + ' windows fit in the history, not enough for a walk-forward.');
    let verdict;
    if (sel.n < 30) verdict = 'too few trades';
    else if (stExp(sel) >= 0.05 && stPF(sel) >= 1.15 && wins >= Math.ceil(traded * 0.6) && stExp(sel) - stExp(base) >= 0.05 && stExp(sel) > stExp(rnd)) verdict = 'PASS ✅';
    else verdict = 'fail';
    const m1 = ['📊 *' + md('Rolling walk-forward test') + '*',
      md(meta.used + ' markets, ' + nW + ' rolling windows. Each window: pick the best of 14 strategies on 150 days of data, then trade only that one on the next 30 days it has never seen. Real spread + slippage. Strategies and costs are the same as /strategytest.')].join('\n');
    const m2 = [md('Out-of-sample months only:'),
      md('  Picked strategy: ' + xtLine(sel) + ', positive in ' + wins + ' of ' + traded + ' traded months'),
      md('  Average of all strategies: ' + xtLine(base)),
      md('  Random control: ' + xtLine(rnd)),
      md('  -> ' + verdict), ''].concat(lines.map(md)).join('\n');
    const m3 = '*' + md(verdict.indexOf('PASS') === 0 ? 'Passed on this history. Treat it as a lead only; the forward tracker is the real test.' : 'Verdict: picking the best recent strategy does not beat chance after costs here. Do not trade it.') + '*';
    return { msgs: [m1, m2, m3] };
  });
}

// Does the market read (/gate) help? Same trades, split into ones it would allow and ones it would skip.
function runGateTest() {
  if (!CAP_ON) return Promise.reject(new Error('Capital.com keys are missing.'));
  const keys = ST_STRATS.map(function (s) { return s[0]; }).filter(function (k) { return k !== 'rand'; });
  const tot = stNewAcc(), pass = stNewAcc(), blk = stNewAcc();
  const half = [{ p: stNewAcc(), b: stNewAcc() }, { p: stNewAcc(), b: stNewAcc() }];
  const rp = [], rb = [], why = {};
  return xtEach(function (sym, D) {
    D._pc = {};
    PAT_CANDLE.forEach(function (p) { D._pc[p[0]] = patCandle(D, p[0]); });
    const idx = new Map();
    D.bars.forEach(function (b, i) { idx.set(b.t, i); });
    xtTrades(D, sym, keys).forEach(function (r) {
      const e = idx.get(r.t);
      if (e === undefined || e < 1) return;
      const g = gateJudge(D, r.d, e - 1);
      const h = e < D.n * 0.5 ? 0 : 1;
      stAdd(tot, r.r);
      if (g.ok) { stAdd(pass, r.r); stAdd(half[h].p, r.r); rp.push(r.r); }
      else {
        stAdd(blk, r.r); stAdd(half[h].b, r.r); rb.push(r.r);
        g.reasons.forEach(function (w) {
          const k = w.replace(/[0-9.]+x?/g, '#').replace(/\(.*?\)/g, '').trim();
          (why[k] || (why[k] = stNewAcc()));
          stAdd(why[k], r.r);
        });
      }
    });
  }).then(function (meta) {
    if (!meta.used || tot.n < 100) throw new Error('Not enough trades to test (' + tot.n + '). ' + (meta.errors[0] || ''));
    const mv = function (a) { const m = a.reduce(function (s, x) { return s + x; }, 0) / (a.length || 1); const v = a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / Math.max(1, a.length - 1); return { m: m, v: v, n: a.length }; };
    const P = mv(rp), B = mv(rb);
    const t = (P.n > 1 && B.n > 1) ? (P.m - B.m) / Math.sqrt(P.v / P.n + B.v / B.n) : 0;
    const consistent = [0, 1].every(function (h) { return half[h].p.n && half[h].b.n && stExp(half[h].p) > stExp(half[h].b); });
    let verdict;
    if (pass.n < 100 || blk.n < 50) verdict = 'too few trades';
    else if (stExp(pass) - stExp(tot) >= 0.03 && t >= 2 && consistent) verdict = 'HELPS ✅';
    else if (stExp(pass) <= stExp(blk)) verdict = 'does not help';
    else verdict = 'unclear';
    const m1 = ['📊 *' + md('Market-read (/gate) test') + '*',
      md(meta.used + ' markets, 14 strategies, the same trades as /strategytest (stop 1.5 ATR, target 3 ATR, real spread + slippage). Each trade is judged by the market read at its entry candle: allowed or skipped. Approximation: skipping a trade can change which later trades happen.')].join('\n');
    const lines = Object.keys(why).sort(function (a, b) { return why[b].n - why[a].n; }).slice(0, 6).map(function (k) { return '  ' + k + ': ' + why[k].n + ' trades, ' + stF(stExp(why[k])) + 'R each'; });
    const m2 = [md('All trades:     ' + xtLine(tot)),
      md('Gate allows:    ' + xtLine(pass)),
      md('Gate skips:     ' + xtLine(blk)),
      md('Difference allowed minus skipped: ' + stF(P.m - B.m) + 'R per trade, t ' + t.toFixed(1)),
      md('First half: allowed ' + stF(stExp(half[0].p)) + 'R vs skipped ' + stF(stExp(half[0].b)) + 'R | second half: allowed ' + stF(stExp(half[1].p)) + 'R vs skipped ' + stF(stExp(half[1].b)) + 'R'),
      md('-> ' + verdict), '', md('Reasons for skipping (trades it removed):')].concat(lines.map(md)).join('\n');
    const m3 = '*' + md(verdict.indexOf('HELPS') === 0 ? 'The market read removed worse-than-average trades in both halves. Keep /gate on, but remember the strategies themselves are still not proven.' : (verdict === 'does not help' ? 'The skipped trades were no worse than the allowed ones, so /gate adds nothing here. Consider /gate off.' : 'No clear effect. Do not rely on /gate to make the bot profitable.')) + '*';
    return { msgs: [m1, m2, m3] };
  });
}

