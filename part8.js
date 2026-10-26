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

// candle anatomy of bar i (hammer / shooting star / engulfing), as in the Python candle_reader
function pocPat(D, i) {
  const o = D.o[i], h = D.h[i], l = D.l[i], c = D.c[i];
  const rng = Math.max(h - l, 1e-12), body = Math.abs(c - o);
  const upper = h - Math.max(o, c), lower = Math.min(o, c) - l, cp = (c - l) / rng;
  const po = D.o[i - 1], pc = D.c[i - 1], pb = Math.abs(pc - po);
  return {
    cp: cp, bullish: c > o, bearish: c < o,
    hammer: lower >= 2 * body && upper / rng <= 0.35 && cp >= 0.55,
    star: upper >= 2 * body && lower / rng <= 0.35 && cp <= 0.45,
    bullEng: pc < po && c > o && c >= po && o <= pc && body > pb,
    bearEng: pc > po && c < o && c <= po && o >= pc && body > pb,
  };
}

// confirm = true: the "candle confirmation" version. A trade needs 4 of 5 points: PoC tapped and held,
// a hammer / engulfing candle, a strong close, volume above 1.2x its 20-bar average, and the EMA50/EMA200 trend agreeing.
// Exits are 1.5 ATR stop and 3 ATR target.
function stPocSignals(D, confirm) {
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
    if (confirm) {
      const pp = pocPat(D, i);
      let vs = 0;
      for (let k = i - 19; k <= i; k++) vs += D.bars[k].v || 0;
      const vexp = (D.bars[i].v || 0) >= 1.2 * (vs / 20) && vs > 0;
      if (cand.dir > 0) {
        if (!(l[i] <= poc + tol && c[i] >= poc - tol)) continue;
        let sc = 1;
        if (pp.hammer || pp.bullEng) sc++;
        if (pp.cp >= 0.6 && pp.bullish) sc++;
        if (vexp) sc++;
        if (D.ema50[i] > D.ema200[i] && c[i] > D.ema200[i]) sc++;
        if (sc >= 4) { sig[i] = 1; slA[i] = c[i] - 1.5 * aa; tpA[i] = c[i] + 3 * aa; }
      } else {
        if (!(h[i] >= poc - tol && c[i] <= poc + tol)) continue;
        let sc = 1;
        if (pp.star || pp.bearEng) sc++;
        if (pp.cp <= 0.4 && pp.bearish) sc++;
        if (vexp) sc++;
        if (D.ema50[i] < D.ema200[i] && c[i] < D.ema200[i]) sc++;
        if (sc >= 4) { sig[i] = -1; slA[i] = c[i] + 1.5 * aa; tpA[i] = c[i] - 3 * aa; }
      }
      continue;
    }
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

function runPocTest(confirm) {
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
        const S = stPocSignals(D, confirm);
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
    const m1 = ['📊 *' + md(confirm ? 'PoC retest + candle confirmation test' : 'Volume-profile PoC retest test') + '*',
      md(used + ' markets, hourly. Box of 20 bars, breakout, 1.5 ATR move, profile of the move, entry on the PoC retest. ' + (confirm ? 'Needs 4 of 5: PoC held, hammer or engulfing candle, strong close, volume 1.2x average, EMA50/200 trend agrees. Stop 1.5 ATR, target 3 ATR. ' : 'Stop beyond the zone, target at the move extreme, reward at least ' + SMC_MIN_RR + 'x risk. ') + 'Real spread + ' + STRAT_SLIP + 'x slippage. Same train / validation / out-of-sample split.'),
      md('Volume here is Capital.com tick count, not real exchange volume, so this is a proxy of your strategy.')].join('\n');
    const m2 = [md(confirm ? 'PoC retest + candle confirmation' : 'Wyckoff PoC retest'),
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
  o.m_poc = 'Wyckoff volume-profile PoC retest'; o.m_poc2 = 'PoC retest + candle confirmation'; o.m_fvg = SMC_NAMES.fvg; o.m_struct = SMC_NAMES.struct;
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
  try { const S2 = stPocSignals(D, true); if (S2.sig[i]) add('m_poc2', S2.sig[i], S2.sl[i], S2.tp[i]); } catch (err) { /* skip */ }
  return out;
}

function maybeForward() {
  if (!fwOn || !CAP_ON) return Promise.resolve();
  const now = new Date();
  const hourId = Math.floor(now.getTime() / 3600000);
  if (now.getUTCMinutes() < 1 || now.getUTCMinutes() > 30 || hourId === fwLastHour) return Promise.resolve();
  fwLastHour = hourId;
  let added = 0, closed = 0;
  return ST_MARKETS.reduce(function (chain, sym) {
    return chain.then(function () {
      return fwBars(sym).then(function (bars) {
        if (bars.length < 300) return null;
        const D = stBuild(bars);
        if (Date.now() - bars[D.n - 2].t > 2.5 * 3600000) return null;   // market closed or stale
        fwRecs.filter(function (r) { return r.m === sym && r.st === 'open'; }).forEach(function (r) {
          if (fwResolve(r, D)) {
            closed++;
            fwDb('PATCH', '?id=eq.' + encodeURIComponent(r.id), { st: r.st, r: r.r, tc: r.tc });
          }
        });
        const fresh = fwNewSignals(sym, D, bars);
        fresh.forEach(function (r) { fwSeen[r.id] = true; fwRecs.push(r); added++; });
        if (fresh.length) return fwDb('POST', '', fresh);
        return null;
      }).catch(function (e) { console.log('Forward ' + sym + ': ' + e.message); return null; });
    });
  }, Promise.resolve()).then(function () {
    // keep memory bounded
    const cl = fwRecs.filter(function (r) { return r.st !== 'open'; });
    if (cl.length > FW_MAX_CLOSED) { const drop = {}; cl.slice(0, cl.length - FW_MAX_CLOSED).forEach(function (r) { drop[r.id] = true; }); fwRecs = fwRecs.filter(function (r) { return !drop[r.id]; }); }
    console.log('Forward tracker: +' + added + ' signals, ' + closed + ' closed, ' + fwRecs.length + ' records');
  });
}

