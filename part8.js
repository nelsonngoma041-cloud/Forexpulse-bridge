function patChart(D, key) {
  const n = D.n, h = D.h, l = D.l, c = D.c;
  const sig = new Int8Array(n), slA = new Float64Array(n), tpA = new Float64Array(n);
  const PH = [], PL = [];
  let cool = 0;
  const put = function (i, s, stop, tgt, minRR) {
    const risk = s > 0 ? c[i] - stop : stop - c[i];
    const reward = s > 0 ? tgt - c[i] : c[i] - tgt;
    if (risk > 0 && reward / risk >= (minRR || SMC_MIN_RR) && i >= cool) { sig[i] = s; slA[i] = stop; tpA[i] = tgt; cool = i + 6; }
  };
  const minLow = function (a, b) { let m = Infinity; for (let t = a; t <= b; t++) if (l[t] < m) m = l[t]; return m; };
  const maxHigh = function (a, b) { let m = -Infinity; for (let t = a; t <= b; t++) if (h[t] > m) m = h[t]; return m; };
  const used = {};
  for (let i = 60; i < n; i++) {
    const k = i - 3;
    let isH = true, isL = true;
    for (let j = 1; j <= 3; j++) {
      if (!(h[k] > h[k - j]) || !(h[k] >= h[k + j])) isH = false;
      if (!(l[k] < l[k - j]) || !(l[k] <= l[k + j])) isL = false;
    }
    if (isH) PH.push({ k: k, p: h[k] });
    if (isL) PL.push({ k: k, p: l[k] });
    const atr = D.atr[i];
    if (!(atr > 0)) continue;
    if (key === 'dbl') {
      if (PL.length >= 2) {
        const L2 = PL[PL.length - 1], L1 = PL[PL.length - 2], id = 'b' + L1.k + '_' + L2.k;
        if (!used[id] && Math.abs(L1.p - L2.p) <= 0.5 * atr && L2.k - L1.k >= 6 && L2.k - L1.k <= 60 && i - L2.k <= 40) {
          const neck = maxHigh(L1.k, L2.k), low = Math.min(L1.p, L2.p);
          if (neck - low >= 2 * atr && c[i] > neck && c[i - 1] <= neck) { used[id] = true; put(i, 1, low - 0.1 * atr, neck + (neck - low), 0.9); }
        }
      }
      if (PH.length >= 2) {
        const H2 = PH[PH.length - 1], H1 = PH[PH.length - 2], id = 't' + H1.k + '_' + H2.k;
        if (!used[id] && Math.abs(H1.p - H2.p) <= 0.5 * atr && H2.k - H1.k >= 6 && H2.k - H1.k <= 60 && i - H2.k <= 40) {
          const neck = minLow(H1.k, H2.k), hi = Math.max(H1.p, H2.p);
          if (hi - neck >= 2 * atr && c[i] < neck && c[i - 1] >= neck) { used[id] = true; put(i, -1, hi + 0.1 * atr, neck - (hi - neck), 0.9); }
        }
      }
    } else if (key === 'hs') {
      if (PH.length >= 3) {
        const P3 = PH[PH.length - 1], P2 = PH[PH.length - 2], P1 = PH[PH.length - 3], id = 'h' + P1.k + '_' + P3.k;
        if (!used[id] && P2.p > P1.p && P2.p > P3.p && Math.abs(P1.p - P3.p) <= atr && P2.p - Math.max(P1.p, P3.p) >= atr && P3.k - P1.k <= 80 && i - P3.k <= 40) {
          const neck = minLow(P1.k, P3.k);
          if (c[i] < neck && c[i - 1] >= neck) { used[id] = true; put(i, -1, P3.p + 0.1 * atr, neck - (P2.p - neck)); }
        }
      }
      if (PL.length >= 3) {
        const P3 = PL[PL.length - 1], P2 = PL[PL.length - 2], P1 = PL[PL.length - 3], id = 'i' + P1.k + '_' + P3.k;
        if (!used[id] && P2.p < P1.p && P2.p < P3.p && Math.abs(P1.p - P3.p) <= atr && Math.min(P1.p, P3.p) - P2.p >= atr && P3.k - P1.k <= 80 && i - P3.k <= 40) {
          const neck = maxHigh(P1.k, P3.k);
          if (c[i] > neck && c[i - 1] <= neck) { used[id] = true; put(i, 1, P3.p - 0.1 * atr, neck + (neck - P2.p)); }
        }
      }
    } else if (key === 'flag') {
      for (let m = 5; m <= 12; m++) {
        const j = i - m;
        if (j < 10) break;
        const pole = c[j] - c[j - 5];
        const hiC = maxHigh(j + 1, i - 1), loC = minLow(j + 1, i - 1);
        if (pole >= 3 * atr && hiC - loC <= 0.5 * pole && hiC <= h[j] + 0.3 * atr && c[i] > hiC && c[i - 1] <= hiC) { put(i, 1, loC - 0.1 * atr, c[i] + pole); break; }
        if (-pole >= 3 * atr && hiC - loC <= 0.5 * -pole && loC >= l[j] - 0.3 * atr && c[i] < loC && c[i - 1] >= loC) { put(i, -1, hiC + 0.1 * atr, c[i] + pole); break; }
      }
    } else if (key === 'tri') {
      if (PH.length >= 2 && PL.length >= 2) {
        const H2 = PH[PH.length - 1], H1 = PH[PH.length - 2], L2 = PL[PL.length - 1], L1 = PL[PL.length - 2];
        const span = Math.max(H2.k, L2.k) - Math.min(H1.k, L1.k);
        if (span >= 10 && span <= 60 && i - Math.max(H2.k, L2.k) <= 30) {
          const res = Math.max(H1.p, H2.p), sup = Math.min(L1.p, L2.p);
          if (Math.abs(H1.p - H2.p) <= 0.3 * atr && L2.p > L1.p + 0.2 * atr && c[i] > res && c[i - 1] <= res) put(i, 1, L2.p - 0.1 * atr, c[i] + (res - L1.p));
          else if (Math.abs(L1.p - L2.p) <= 0.3 * atr && H2.p < H1.p - 0.2 * atr && c[i] < sup && c[i - 1] >= sup) put(i, -1, H2.p + 0.1 * atr, c[i] - (H1.p - sup));
        }
      }
    }
  }
  return { sig: sig, sl: slA, tp: tpA };
}

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
let fwLastHour = 0;
let fwLastWeek = '';
let fwDbOk = true;
const FW_MAX_CLOSED = 20000;
const FW_NAMES = (function () {
  const o = {};
  ST_STRATS.forEach(function (s) { if (s[0] !== 'rand') o[s[0]] = s[1]; });
  PAT_CANDLE.forEach(function (p) { o['c_' + p[0]] = p[1]; });
  PAT_CHART.forEach(function (p) { o['p_' + p[0]] = p[1]; });
  o.m_fvg = SMC_NAMES.fvg; o.m_struct = SMC_NAMES.struct;
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
      return { t: Date.parse((x.snapshotTimeUTC || x.snapshotTime) + 'Z'), o: m(x.openPrice), h: m(x.highPrice), l: m(x.lowPrice), c: m(x.closePrice), sp: Math.abs(Number(x.openPrice.ask) - Number(x.openPrice.bid)) };
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
  return out;
}

