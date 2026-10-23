function runPatternTest() {
  if (!CAP_ON) return Promise.reject(new Error('Capital.com keys are missing.'));
  const errors = [], all = PAT_CANDLE.concat(PAT_CHART);
  const acc = {}, ctl = {}, per = {}, rows = {};
  all.forEach(function (p) { acc[p[0]] = [stNewAcc(), stNewAcc(), stNewAcc()]; ctl[p[0]] = [stNewAcc(), stNewAcc(), stNewAcc()]; per[p[0]] = []; rows[p[0]] = []; });
  let used = 0;
  const addTo = function (dst, src) { for (let p = 0; p < 3; p++) { dst[p].n += src[p].n; dst[p].w += src[p].w; dst[p].sumR += src[p].sumR; dst[p].gp += src[p].gp; dst[p].gl += src[p].gl; } };
  return ST_MARKETS.reduce(function (chain, sym) {
    return chain.then(function () {
      return stFetchHistory(sym, STRAT_PAGES, errors).then(function (b) {
        if (b.length < 1000) { errors.push(sym + ': only ' + b.length + ' bars'); return null; }
        used++;
        const D = stBuild(b);
        const split = [Math.floor(D.n * 0.5), Math.floor(D.n * 0.75)];
        const rsig = stSignals('rand', D, 777 + sym.length);
        PAT_CANDLE.forEach(function (p) {
          const sig = patCandle(D, p[0]);
          const a = [stNewAcc(), stNewAcc(), stNewAcc()], c = [stNewAcc(), stNewAcc(), stNewAcc()];
          stSim(D, sig, ST_VARIANTS[0], split, a, { overlap: 0, wideSpread: 0, noAtr: 0 }, rows[p[0]], null, sym, p[0]);
          // control: random entries with the same number of trades and same stop and target rule
          const cs = new Int8Array(D.n), R = { s: 31 + sym.length };
          let cnt = 0; for (let i = 0; i < D.n; i++) if (sig[i] !== 0) cnt++;
          for (let q = 0; q < cnt; q++) cs[ST_WARM + Math.floor(evoRand(R) * (D.n - ST_WARM - 4))] = evoRand(R) < 0.5 ? 1 : -1;
          stSim(D, cs, ST_VARIANTS[0], split, c, { overlap: 0, wideSpread: 0, noAtr: 0 }, null, null, sym, 'ctl');
          addTo(acc[p[0]], a); addTo(ctl[p[0]], c); per[p[0]].push(a[2]);
        });
        PAT_CHART.forEach(function (p, pi) {
          const S = patChart(D, p[0]);
          const a = [stNewAcc(), stNewAcc(), stNewAcc()], c = [stNewAcc(), stNewAcc(), stNewAcc()];
          stSimLv(D, S, split, a, rows[p[0]], sym, p[0]);
          stSimLv(D, stSmcControl(D, S, 9100 + pi * 17 + sym.length), split, c, null, sym, 'ctl');
          addTo(acc[p[0]], a); addTo(ctl[p[0]], c); per[p[0]].push(a[2]);
        });
        return new Promise(function (r) { setImmediate(r); });
      });
    });
  }, Promise.resolve()).then(function () {
    if (!used) throw new Error('No history could be loaded. ' + (errors[0] || ''));
    const msgs = [['📐 *' + md('Pattern test') + '*',
      md(used + ' markets, hourly. Candlestick patterns (against a trend, stop 1.5x ATR, target 2x) and chart patterns (neckline or boundary break, stop beyond the pattern, measured-move target, reward at least ' + SMC_MIN_RR + 'x risk, 0.9x for double tops and bottoms). Real spread + ' + STRAT_SLIP + 'x slippage, same train / validation / out-of-sample split.'),
      md('Control = random entries, same number of trades and same stop and target rule.')].join('\n')];
    const lines = [];
    const pass = [];
    all.forEach(function (p) {
      const a = acc[p[0]], c = ctl[p[0]], exps = a.map(stExp);
      const posM = per[p[0]].filter(function (x) { return stExp(x) > 0; }).length;
      const t = evoTstat(rows[p[0]], 2);
      let verdict;
      if (a[0].n < 30 || a[1].n < 30 || a[2].n < 30) verdict = 'too few trades';
      else if (exps[0] >= 0.05 && exps[1] >= 0.05 && exps[2] >= 0.05 && stPF(a[2]) >= 1.15 && t >= 2 && exps[2] - stExp(c[2]) >= 0.05 && posM >= Math.ceil(used * 2 / 3)) { verdict = 'PASS ✅'; pass.push(p[1]); }
      else verdict = 'fail';
      lines.push(md(p[1] + ': ' + stF(exps[0]) + ' | ' + stF(exps[1]) + ' | ' + stF(exps[2]) + 'R (n ' + a[0].n + '/' + a[1].n + '/' + a[2].n + '), OOS PF ' + stPF(a[2]).toFixed(2) + ', win ' + (a[2].n ? Math.round(100 * a[2].w / a[2].n) : 0) + '%, ' + posM + '/' + used + ' markets +, control ' + stF(stExp(c[2])) + ' -> ' + verdict));
    });
    msgs.push(['*' + md('Net R per trade: train | validation | out-of-sample') + '*'].concat(lines).join('\n'));
    msgs.push(pass.length
      ? '*' + md('Passed: ' + pass.join(', ') + '. One test period, so treat it as a lead and confirm on new data before any live use. Tell me and I will wire it to the demo trading.') + '*'
      : '*' + md('Verdict: no pattern passed every check. None of these are enabled, and none are worth trading on this evidence.') + '*');
    return { msgs: msgs };
  });
}

// ---------- Restart safety and emergency stop ----------
// After a restart the bot forgets its open trades. This reads the open positions from Capital.com
// and adopts them again, so wins and losses are still recorded and the time limit still applies.
// The stop loss and take profit are already stored at the broker, so they work even while the bot is down.
function capReconcile() {
  if (!CAP_ON || tradeBroker === 'deriv') return Promise.resolve();
  return capCall('GET', '/positions').then(function (j) {
    let n = 0;
    (j.positions || []).forEach(function (x) {
      const p = x.position || {}, m = x.market || {};
      const dealId = p.dealId;
      if (!dealId || pendingTrades.some(function (t) { return String(t.contractId) === String(dealId); })) return;
      const epic = m.epic;
      const pair = PAIRS.filter(function (q) { return q.epic === epic || q.symbol === epic || CAP_RESOLVED[q.symbol] === epic; })[0];
      pendingTrades.push({
        contractId: dealId, display: pair ? pair.display : (m.instrumentName || epic), symbol: pair ? pair.symbol : epic,
        action: p.direction === 'BUY' ? 'BUY' : 'SELL',
        placedAt: Date.parse((p.createdDateUTC || '') + 'Z') || Date.now(), votes: {}, minutes: 2880, holdMin: 2880, broker: 'capital', recovered: true,
      });
      n++;
    });
    if (n) return sendTelegram('🔄 Restart check: picked up ' + md(n) + ' open Capital\\.com trade\\(s\\)\\. Their stop loss and take profit are still active at the broker\\.');
    return null;
  }).catch(function (e) { console.error('Reconcile: ' + e.message); });
}

// /panic : stop new trades and close every Capital.com trade the bot knows about
function panicStop() {
  autoTrade = false;
  evoOn = false; smcOn = false;
  const mine = pendingTrades.filter(function (t) { return t.broker === 'capital'; });
  let closed = 0;
  return mine.reduce(function (chain, t) {
    return chain.then(function () {
      return capCall('DELETE', '/positions/' + encodeURIComponent(t.contractId)).then(function () { closed++; }).catch(function (e) { console.error('Panic close: ' + e.message); });
    });
  }, Promise.resolve()).then(function () {
    return sendTelegram('🚨 *PANIC*: auto\\-trading is OFF\\. Closing ' + md(closed) + ' of ' + md(mine.length) + ' Capital\\.com trade\\(s\\)\\. Results are reported as they settle\\. Deriv trades finish on their own timer\\. Use /auto on to restart\\.');
  });
}

// ---------- Mirror: copy every Capital.com trade onto Deriv ----------
// With /mirror on, each new Capital.com trade on a market Deriv also offers (forex pairs, gold, silver)
// is copied on Deriv in the same direction, as a Rise/Fall contract with the usual stake and duration.
// It is not the same instrument: Deriv's contract has no stop loss or take profit and ends after its
// duration, while the Capital.com trade stays open until its stop, target or time limit.
let mirrorOn = process.env.MIRROR === 'on';
const mirrorWarned = {};

function openCount() { return pendingTrades.filter(function (t) { return !t.mirrorOf; }).length; }

function mirrorSync() {
  if (!mirrorOn || !autoTrade || circuitOpen) return Promise.resolve();
  const todo = pendingTrades.filter(function (t) {
    return t.broker === 'capital' && !t.mirrored && !t.recovered && SYMBOL_MAP[t.symbol];
  });
  return todo.reduce(function (chain, t) {
    return chain.then(function () {
      t.mirrored = true;
      if (pendingTrades.some(function (x) { return x.mirrorOf && x.symbol === t.symbol; })) return null;
      return placeTrade(t.symbol, t.action, STAKE).then(function (r) {
        pendingTrades.push({
          contractId: r.contract_id, display: t.display, symbol: t.symbol, action: t.action,
          placedAt: Date.now(), votes: {}, minutes: r.minutes || durationMin, mirrorOf: t.contractId,
        });
        return sendTelegram('🪞 *Mirrored on Deriv*: ' + md(t.display) + ' ' + md(t.action) + ' · ' + md(r.minutes || durationMin) + ' min · stake $' + md(STAKE));
      }).catch(function (e) {
        const key = t.symbol + ':' + new Date().toISOString().slice(0, 13);
        if (mirrorWarned[key]) return null;
        mirrorWarned[key] = true;
        return sendTelegram('🪞 Mirror skipped for ' + md(t.display) + ': ' + md(e.message));
      });
    });
  }, Promise.resolve());
}

// ---------- Forward tracker: paper-record every strategy signal on new prices ----------
// No orders are placed. Every hour the bot looks at the last completed hourly candle on 6 markets,
// writes down a pretend trade for each strategy that fires (15 strategies, 4 candlestick patterns,
// 4 chart patterns, 2 structure strategies), then follows each one to its stop, target or the
// 48-hour limit using real prices and the same costs as the tests. Each pretend trade is tagged
// volatile or not, so we can see whether volatile hours really are better.
// Records are saved in Supabase table forward_signals if it exists (see the SQL in the chat),
// otherwise they live in memory and are lost when Render restarts.

let fwOn = process.env.FORWARD !== 'off';
let fwRecs = [];
let fwSeen = {};
// ===== Volume-profile PoC retest (Wyckoff): accumulation box -> breakout -> fixed-range volume profile -> PoC retest =====
// Capital.com gives tick counts, not real volume, so the profile is a proxy. Tested like every other idea with /poctest.
let pocRunning = false;
const POC = { acc: 20, scan: 90, boxAtr: 3.0, buf: 0.10, imp: 1.5, bins: 50, tol: 0.25, minAfter: 2, rej: 0.5 };

function pocFrp(D, a, b) {                      // point of control over bars a..b
  let mn = Infinity, mx = -Infinity, tot = 0;
  for (let k = a; k <= b; k++) { if (D.l[k] < mn) mn = D.l[k]; if (D.h[k] > mx) mx = D.h[k]; tot += D.bars[k].v || 0; }
  if (!(tot > 0) || !(mx > mn)) return null;
  const nb = POC.bins, w = (mx - mn) / nb, prof = new Float64Array(nb);
  for (let k = a; k <= b; k++) {
    const v = D.bars[k].v || 0;
    if (v <= 0) continue;
    const lo = Math.min(nb - 1, Math.max(0, Math.floor((D.l[k] - mn) / w)));
    const hi = Math.min(nb - 1, Math.max(0, Math.floor((D.h[k] - mn) / w)));
    const sp = hi - lo + 1;
    for (let q = lo; q <= hi; q++) prof[q] += v / sp;
  }
  let best = 0;
  for (let q = 1; q < nb; q++) if (prof[q] > prof[best]) best = q;
  return mn + best * w + w / 2;
}

function stPocSignals(D) {
  const n = D.n, h = D.h, l = D.l, c = D.c, o = D.o;
  const sig = new Int8Array(n), slA = new Float64Array(n), tpA = new Float64Array(n);
  for (let i = POC.scan; i < n; i++) {
    const w0 = i - POC.scan + 1;                  // window start
    let cand = null;
    for (let s = w0; s <= i - POC.acc - 3; s++) {
      const e = s + POC.acc - 1;
      const atr = D.atr[e];
      if (!(atr > 0)) continue;
      let bh = -Infinity, bl = Infinity;
      for (let k = s; k <= e; k++) { if (h[k] > bh) bh = h[k]; if (l[k] < bl) bl = l[k]; }
      if (bh - bl > POC.boxAtr * atr) continue;
      const buf = POC.buf * atr;
      let up = -1, dn = -1;
      for (let k = e + 1; k <= i; k++) {
        if (up < 0 && c[k] > bh + buf) up = k;
        if (dn < 0 && c[k] < bl - buf) dn = k;
        if (up >= 0 && dn >= 0) break;
      }
      if (up < 0 && dn < 0) continue;
      let dir, bo, legEnd, impulse, swLo, swHi;
      if (up >= 0 && (dn < 0 || up <= dn)) {
        dir = 1; bo = up;
        legEnd = e + 1;
        for (let k = e + 1; k <= i; k++) if (h[k] > h[legEnd]) legEnd = k;
        impulse = h[legEnd] - bl;
        swLo = s; for (let k = s; k <= legEnd; k++) if (l[k] < l[swLo]) swLo = k;
        swHi = legEnd;
      } else {
        dir = -1; bo = dn;
        legEnd = e + 1;
        for (let k = e + 1; k <= i; k++) if (l[k] < l[legEnd]) legEnd = k;
        impulse = bh - l[legEnd];
        swHi = s; for (let k = s; k <= legEnd; k++) if (h[k] > h[swHi]) swHi = k;
        swLo = legEnd;
      }
      if (impulse < POC.imp * atr) continue;
      if (i - bo < POC.minAfter) continue;
      cand = { dir: dir, bo: bo, legEnd: legEnd, a: Math.min(swLo, swHi), b: Math.max(swLo, swHi), atr: atr };
    }
    if (!cand || i <= cand.legEnd) continue;
    const poc = pocFrp(D, cand.a, cand.b);
    if (poc === null) continue;
    const tol = POC.tol * cand.atr, rng = Math.max(h[i] - l[i], 1e-12);
    const aa = D.atr[i];
    if (!(aa > 0)) continue;
    if (cand.dir > 0) {
      if (c[i - 1] <= poc) continue;
      let ok = false;
      for (let k = cand.bo; k < i; k++) if (c[k] > poc + tol) { ok = true; break; }
      if (!ok) continue;
      if (l[i] <= poc + tol && c[i] >= poc - tol && (c[i] - l[i]) >= POC.rej * rng) {
        const stop = Math.min(l[i], poc - tol) - 0.1 * aa, tgt = h[cand.legEnd];
        const risk = c[i] - stop, rew = tgt - c[i];
        if (risk > 0 && rew / risk >= SMC_MIN_RR) { sig[i] = 1; slA[i] = stop; tpA[i] = tgt; }
      }
    } else {
      if (c[i - 1] >= poc) continue;
      let ok = false;
      for (let k = cand.bo; k < i; k++) if (c[k] < poc - tol) { ok = true; break; }
      if (!ok) continue;
      if (h[i] >= poc - tol && c[i] <= poc + tol && (h[i] - c[i]) >= POC.rej * rng) {
        const stop = Math.max(h[i], poc + tol) + 0.1 * aa, tgt = l[cand.legEnd];
        const risk = stop - c[i], rew = c[i] - tgt;
        if (risk > 0 && rew / risk >= SMC_MIN_RR) { sig[i] = -1; slA[i] = stop; tpA[i] = tgt; }
      }
    }
  }
  return { sig: sig, sl: slA, tp: tpA };
}

function runPocTest() {
  if (!CAP_ON) return Promise.reject(new Error('Capital.com keys are missing.'));
  const errors = [], rows = [];
  const acc = [stNewAcc(), stNewAcc(), stNewAcc()], ctl = [stNewAcc(), stNewAcc(), stNewAcc()], per = [];
  let used = 0, noVol = 0;
  return ST_MARKETS.reduce(function (chain, sym) {
    return chain.then(function () {
      return stFetchHistory(sym, STRAT_PAGES, errors).then(function (b) {
        if (b.length < 1000) { errors.push(sym + ': only ' + b.length + ' bars'); return null; }
        if (!b.some(function (x) { return x.v > 0; })) { noVol++; return null; }
        used++;
        const D = stBuild(b);
        const split = [Math.floor(D.n * 0.5), Math.floor(D.n * 0.75)];
        const S = stPocSignals(D);
        const a = [stNewAcc(), stNewAcc(), stNewAcc()];
        stSimLv(D, S, split, a, rows, sym, 'poc');
        const c = [stNewAcc(), stNewAcc(), stNewAcc()];
        stSimLv(D, stSmcControl(D, S, 7000 + sym.length), split, c, null, sym, 'ctl');
        for (let p = 0; p < 3; p++) [[acc[p], a[p]], [ctl[p], c[p]]].forEach(function (pr) {
          pr[0].n += pr[1].n; pr[0].w += pr[1].w; pr[0].sumR += pr[1].sumR; pr[0].gp += pr[1].gp; pr[0].gl += pr[1].gl;
        });
        per.push(a[2]);
        return new Promise(function (r) { setImmediate(r); });
      });
    });
  }, Promise.resolve()).then(function () {
    if (!used) throw new Error('No usable history (' + noVol + ' markets had no volume). ' + (errors[0] || ''));
    const exps = acc.map(stExp), dd = stMaxDD(rows), t = evoTstat(rows, 2);
    const posM = per.filter(function (x) { return stExp(x) > 0; }).length;
    let verdict;
    if (acc[0].n < 30 || acc[1].n < 30 || acc[2].n < 30) verdict = 'too few trades';
    else if (exps[0] >= 0.05 && exps[1] >= 0.05 && exps[2] >= 0.05 && stPF(acc[2]) >= 1.15 && t >= 2 && exps[2] - stExp(ctl[2]) >= 0.05 && posM >= Math.ceil(used * 2 / 3)) verdict = 'PASS ✅';
    else verdict = 'fail';
    const m1 = ['📊 *' + md('Volume-profile PoC retest test') + '*',
      md(used + ' markets, hourly. Box of 20 bars, breakout, 1.5 ATR move, profile of the move, entry on the PoC retest. Stop beyond the zone, target at the move extreme, reward at least ' + SMC_MIN_RR + 'x risk. Real spread + ' + STRAT_SLIP + 'x slippage. Same train / validation / out-of-sample split.'),
      md('Volume here is Capital.com tick count, not real exchange volume, so this is a proxy of your strategy.')].join('\n');
    const m2 = [md('Wyckoff PoC retest'),
      md('  net R per trade: train ' + stF(exps[0]) + ' | validation ' + stF(exps[1]) + ' | out-of-sample ' + stF(exps[2]) + '  (n ' + acc[0].n + '/' + acc[1].n + '/' + acc[2].n + ')'),
      md('  OOS PF ' + stPF(acc[2]).toFixed(2) + ', win ' + (acc[2].n ? Math.round(100 * acc[2].w / acc[2].n) : 0) + '%, t ' + t.toFixed(1) + ', max DD ' + dd.toFixed(1) + 'R, ' + posM + '/' + used + ' markets positive'),
      md('  random control: ' + stF(stExp(ctl[0])) + ' | ' + stF(stExp(ctl[1])) + ' | ' + stF(stExp(ctl[2])) + ' -> ' + verdict)].join('\n');
    const m3 = '*' + md(verdict.indexOf('PASS') === 0 ? 'Passed every check on one test period. Treat it as a lead only; the forward tracker is now recording it on live prices.' : 'Verdict: not proven. Do not trade it. The forward tracker keeps recording it on live prices.') + '*';
    return { msgs: [m1, m2, m3] };
  });
}

let fwLastHour = 0;
let fwLastWeek = '';
let fwDbOk = true;
const FW_MAX_CLOSED = 20000;
const FW_NAMES = (function () {
  const o = {};
  ST_STRATS.forEach(function (s) { if (s[0] !== 'rand') o[s[0]] = s[1]; });
  PAT_CANDLE.forEach(function (p) { o['c_' + p[0]] = p[1]; });
  PAT_CHART.forEach(function (p) { o['p_' + p[0]] = p[1]; });
  o.m_poc = 'Wyckoff volume-profile PoC retest'; o.m_fvg = SMC_NAMES.fvg; o.m_struct = SMC_NAMES.struct;
  return o;
})();

function fwDb(method, path, body) {
  if (!DB_ON || !fwDbOk) return Promise.resolve(null);
  return fetch(SUPABASE_URL + '/rest/v1/forward_signals' + path, {
    method: method, headers: dbHeaders(), body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) {
      if (fwDbOk) { fwDbOk = false; console.error('Forward DB ' + r.status + ': ' + t.slice(0, 160) + ' (memory only until fixed)'); }
      return null;
    });
    return method === 'GET' ? r.json() : true;
  }).catch(function (e) { console.error('Forward DB failed: ' + e.message); return null; });
}

function fwLoad() {
  if (!DB_ON) return Promise.resolve();
  const h = dbHeaders();
  return fetch(SUPABASE_URL + '/rest/v1/forward_signals?select=*&order=ts.desc&limit=20000', { headers: h })
    .then(function (r) {
      if (!r.ok) { fwDbOk = false; return null; }
      return r.json();
    }).then(function (rows) {
      if (!Array.isArray(rows)) return;
      fwRecs = rows.map(function (x) {
        return { id: x.id, k: x.k, m: x.m, vol: !!x.vol, s: Number(x.s), ts: Number(x.ts), te: Number(x.te), entry: Number(x.entry), stop: Number(x.stop), tgt: Number(x.tgt), st: x.st, r: x.r === null ? null : Number(x.r), tc: x.tc ? Number(x.tc) : 0 };
      });
      fwRecs.forEach(function (x) { fwSeen[x.id] = true; });
      console.log('Forward tracker: loaded ' + fwRecs.length + ' records');
    }).catch(function () { fwDbOk = false; });
}

function fwBars(symbol) {
  return capEpic(symbol).then(function (epic) { return capCall('GET', '/prices/' + epic + '?resolution=HOUR&max=500'); }).then(function (j) {
    const m = function (o) { return (Number(o.bid) + Number(o.ask)) / 2; };
    return (j.prices || []).map(function (x) {
      return { t: Date.parse((x.snapshotTimeUTC || x.snapshotTime) + 'Z'), o: m(x.openPrice), h: m(x.highPrice), l: m(x.lowPrice), c: m(x.closePrice), sp: Math.abs(Number(x.openPrice.ask) - Number(x.openPrice.bid)), v: Number(x.lastTradedVolume) || 0 };
    }).filter(function (b) { return !isNaN(b.t) && b.h > 0; }).sort(function (a, b) { return a.t - b.t; });
  });
}

// follow one open record on the latest completed bars
function fwResolve(rec, D) {
  const last = D.n - 2;                       // last completed bar
  let e = -1;
  for (let i = D.n - 1; i >= 0; i--) { if (D.bars[i].t === rec.te) { e = i; break; } if (D.bars[i].t < rec.te) break; }
  if (e < 0) { if (Date.now() - rec.te > 72 * 3600000) { rec.st = 'expired'; rec.tc = Date.now(); return true; } return false; }
  const s = rec.s, entry = rec.entry, stop = rec.stop, target = rec.tgt;
  const dist = s > 0 ? entry - stop : stop - entry;
  const reach = s > 0 ? target - entry : entry - target;
  if (!(dist > 0) || !(reach > 0)) { rec.st = 'expired'; rec.tc = Date.now(); return true; }
  const rr = reach / dist;
  const maxJ = Math.min(e + ST_MAXHOLD, last);
  let R = null, j = e;
  for (; j <= maxJ; j++) {
    if (s > 0) {
      if (j > e && D.o[j] <= stop) { R = (D.o[j] - entry) / dist; break; }
      if (D.l[j] <= stop) { R = -1; break; }
      if (D.h[j] >= target) { R = rr; break; }
    } else {
      if (j > e && D.o[j] >= stop) { R = (entry - D.o[j]) / dist; break; }
      if (D.h[j] >= stop) { R = -1; break; }
      if (D.l[j] <= target) { R = rr; break; }
    }
  }
  if (R === null) {
    if (e + ST_MAXHOLD <= last) { j = e + ST_MAXHOLD; R = ((D.c[j] - entry) * s) / dist; }
    else return false;                        // still open
  }
  rec.r = R - (D.sp[e] * (1 + STRAT_SLIP)) / dist;
  rec.st = 'closed';
  rec.tc = Date.now();
  return true;
}

function fwNewSignals(sym, D, bars) {
  const i = D.n - 2, e = D.n - 1;
  const out = [];
  if (!(D.atr[i] > 0) || (D.medSp > 0 && D.sp[e] > 3 * D.medSp)) return out;
  const vol = stIsVol(D, i, 1.5);
  const add = function (k, s, stop, tgt) {
    const id = k + ':' + sym + ':' + bars[i].t;
    if (fwSeen[id] || s === 0) return;
    const entry = D.o[e];
    const ok = s > 0 ? (entry > stop && tgt > entry) : (entry < stop && tgt < entry);
    if (!ok) return;
    out.push({ id: id, k: k, m: sym, vol: vol, s: s, ts: bars[i].t, te: bars[e].t, entry: entry, stop: stop, tgt: tgt, st: 'open', r: null, tc: 0 });
  };
  const atr = D.atr[i];
  const atrExit = function (k, s) { if (s !== 0) add(k, s, D.o[e] - s * 1.5 * atr, D.o[e] + s * 3 * atr); };
  ST_STRATS.forEach(function (st) {
    if (st[0] === 'rand') return;
    try { atrExit(st[0], stSignals(st[0], D, 1)[i]); } catch (err) { /* skip */ }
  });
  PAT_CANDLE.forEach(function (p) { try { atrExit('c_' + p[0], patCandle(D, p[0])[i]); } catch (err) { /* skip */ } });
  PAT_CHART.forEach(function (p) { try { const S = patChart(D, p[0]); if (S.sig[i]) add('p_' + p[0], S.sig[i], S.sl[i], S.tp[i]); } catch (err) { /* skip */ } });
  ['fvg', 'struct'].forEach(function (k) { try { const S = stSmcSignals(D, k); if (S.sig[i]) add('m_' + k, S.sig[i], S.sl[i], S.tp[i]); } catch (err) { /* skip */ } });
  try { const S = stPocSignals(D); if (S.sig[i]) add('m_poc', S.sig[i], S.sl[i], S.tp[i]); } catch (err) { /* skip */ }
  return out;
}

