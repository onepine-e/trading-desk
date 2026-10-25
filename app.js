/* 트레이딩 데스크 — 화면 · 시세 · 저장 (engine.js 의 DeskEngine 사용) */
'use strict';
const E = window.DeskEngine;
const SYMS = E.SYMS;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now();
const FIVE = 300000;

// ───────────────────────────── 저장소 (로컬)
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 (사생활 보호 모드 등) */ } },
};
const cfg = Object.assign({ owner: '', repo: 'tsb7-paper', branch: 'main', token: '', theme: 'system', interval: '240',
  studies: ['MASimple@tv-basicstudies', 'BB@tv-basicstudies', 'RSI@tv-basicstudies'] }, LS.get('desk.cfg', {}));
const saveCfg = () => LS.set('desk.cfg', cfg);
let ME = LS.get('desk.me', null) || E.newAccount();
let ME_SHA = LS.get('desk.me.sha', null);
let CL = null, BRIEFS = [], BRIEF_TXT = {}, BOT = null;
const ui = { acct: 'me', mkt: 'spot', sym: 'BTC', tab: 'pos', side: 'buy', otype: 'market', lev: 10, statMkt: 'fut', brief: null };
const P = { spot: {}, fut: {} };
for (const s of SYMS) { P.spot[s] = {}; P.fut[s] = {}; }
let caughtUp = false, catchFail = false, btcFilter = null;

// ───────────────────────────── 형식
function fpx(x, mkt) {
  if (x == null || !isFinite(x)) return '–';
  if (mkt === 'fut') return x >= 1000 ? x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : x >= 10 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toFixed(5);
  return x >= 100 ? Math.round(x).toLocaleString('ko-KR') : x >= 1 ? x.toFixed(2) : x.toPrecision(4);
}
const fmoney = (x, mkt) => x == null || !isFinite(x) ? '–' : mkt === 'fut' ? x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(x).toLocaleString('ko-KR');
const fsign = (x, mkt) => x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + fmoney(x, mkt);
const fpct = (x, d = 2) => x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
const fqty = (x) => x == null ? '–' : x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(4) : x.toPrecision(5);
const cls = (x) => x > 0 ? 'up' : x < 0 ? 'dn' : '';
const ftime = (t) => { if (!t) return '–'; const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const unit = (mkt) => mkt === 'fut' ? 'USDT' : '원';
const pxOf = (mkt, s) => mkt === 'fut' ? (P.fut[s].mark ?? P.fut[s].last) : P.spot[s].last;
const prices = () => ({ spot: Object.fromEntries(SYMS.map((s) => [s, P.spot[s].last])), fut: Object.fromEntries(SYMS.map((s) => [s, P.fut[s].mark ?? P.fut[s].last])) });
const view = () => ui.acct === 'me' ? ME : CL;
const readOnly = () => ui.acct !== 'me';

// ───────────────────────────── 알림 · 모달
function toast(msg, ms = 5000) {
  const d = document.createElement('div'); d.innerHTML = msg; $('#toast').appendChild(d);
  setTimeout(() => d.remove(), ms);
}
function modal(html, buttons) {
  return new Promise((res) => {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal"><div>${html}<div class="row" style="justify-content:flex-end">${buttons.map((b, i) => `<button class="btn2 ${b.cls || ''}" data-i="${i}">${b.label}</button>`).join('')}</div></div></div>`;
    $$('button[data-i]', root).forEach((b) => b.onclick = () => { const i = +b.dataset.i; const v = buttons[i].value?.(root); root.innerHTML = ''; res(v ?? buttons[i].ret); });
    $('.modal', root).onclick = (e) => { if (e.target.classList.contains('modal')) { root.innerHTML = ''; res(null); } };
  });
}

// ───────────────────────────── GitHub 동기화
const b64e = (str) => { const b = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const b64d = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
const ghOn = () => !!(cfg.token && cfg.owner && cfg.repo);
async function gh(path, opt = {}) {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}` + (opt.method ? '' : `?ref=${encodeURIComponent(cfg.branch)}`);
  const r = await fetch(url, { method: opt.method || 'GET', headers: { Authorization: `Bearer ${cfg.token}`, Accept: opt.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, body: opt.body, cache: 'no-store' });
  return r;
}
async function ghJSON(path) {
  const r = await gh(path);
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  if (j.content) return { data: JSON.parse(b64d(j.content)), sha: j.sha };
  const raw = await gh(path, { raw: true });
  return { data: JSON.parse(await raw.text()), sha: j.sha };
}
async function ghText(path) {
  const r = await gh(path, { raw: true });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.text();
}
async function ghPut(path, data, sha, msg) {
  const body = JSON.stringify({ message: msg, content: b64e(JSON.stringify(data, null, 1)), branch: cfg.branch, ...(sha ? { sha } : {}) });
  const r = await gh(path, { method: 'PUT', body });
  if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; throw e; }
  return (await r.json()).content.sha;
}
function setSync(state, text) { const s = $('#syncStat'); s.querySelector('.dot').className = 'dot ' + state; s.querySelector('span:last-child').textContent = text; }

let saveTimer = null, saving = false;
function save() {
  ME.updated = now();
  LS.set('desk.me', ME);
  if (!ghOn()) { setSync('', '이 기기에만 저장'); return; }
  setSync('wait', '저장 대기');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushRemote, 3000);
}
async function pushRemote() {
  if (saving) { saveTimer = setTimeout(pushRemote, 2000); return; }
  saving = true;
  try {
    try { ME_SHA = await ghPut('desk/me.json', ME, ME_SHA, `desk: 내 계좌 ${new Date().toISOString()}`); }
    catch (e) {
      if (e.status === 409 || e.status === 422) { const cur = await ghJSON('desk/me.json'); ME_SHA = await ghPut('desk/me.json', ME, cur.sha, 'desk: 내 계좌 (덮어씀)'); }
      else throw e;
    }
    LS.set('desk.me.sha', ME_SHA);
    setSync('ok', `저장됨 ${ftime(now())}`);
  } catch (e) { setSync('bad', `저장 실패 (${e.message}) — 이 기기에는 저장됨`); }
  saving = false;
}
async function pullRemote() {
  if (!ghOn()) return;
  try {
    const r = await ghJSON('desk/me.json');
    if (r.data && (r.data.updated || 0) > (ME.updated || 0)) { ME = r.data; LS.set('desk.me', ME); toast('저장소에 더 최근 기록이 있어 불러왔어요'); }
    ME_SHA = r.sha; LS.set('desk.me.sha', ME_SHA);
    setSync('ok', '저장소와 맞춤');
  } catch (e) { setSync('bad', `저장소 읽기 실패 (${e.message})`); }
}
async function loadShared() {
  if (!ghOn()) return;
  try { CL = (await ghJSON('desk/claude/state.json')).data; } catch { /* 아직 없음 */ }
  try { BRIEFS = (await ghJSON('desk/briefings/index.json')).data || []; } catch { BRIEFS = []; }
  try { BOT = await loadBot(); } catch { BOT = null; }
  renderTabs(); renderTop(); if (readOnly()) renderForm();
}
async function loadBot() {
  const accts = ['A', 'B', 'C', 'D', 'H', 'F'], out = { rows: [], rec: [] };
  const parse = (txt) => { const L = txt.replace(/^﻿/, '').trim().split(/\r?\n/); const h = L[0].split(','); return L.slice(1).map((l) => { const v = l.split(','); return Object.fromEntries(h.map((k, i) => [k, v[i]])); }); };
  for (const a of accts) {
    const t = await ghText(`paper/${a}/equity.csv`).catch(() => null);
    if (!t) continue;
    const rows = parse(t); const last = rows[rows.length - 1];
    out.rows.push({ a, last, hist: rows.map((r) => +r.equity).filter(isFinite) });
  }
  const rec = await ghText('paper/reconcile.csv').catch(() => null);
  if (rec) { const rr = parse(rec); const lastT = rr.length ? rr[rr.length - 1].time_kst : null; out.rec = rr.filter((r) => r.time_kst === lastT); }
  return out;
}

// ───────────────────────────── 시세 (업비트 · 바이낸스 선물)
const tickGate = {};
function onTick(mkt, s, px) {
  if (!(px > 0)) return;
  const k = mkt + s, t = now();
  if (tickGate[k] && t - tickGate[k] < 800) return;
  tickGate[k] = t;
  if (!caughtUp) return;
  const ev = E.processCandle(ME, mkt, s, { t, o: px, h: px, l: px, c: px });
  if (!catchFail) ME.seen[`${mkt}:${s}`] = Math.floor(t / FIVE) * FIVE;
  if (ev.length) { for (const f of ev) toast(fillMsg(f)); save(); renderForm(); renderTabs(); }
}
function fillMsg(f) {
  const mk = f.mkt === 'fut' ? 'fut' : 'spot';
  return `<b>${f.sym}</b> ${esc(f.side)} <span class="num">${fpx(f.price, mk)}</span> · ${esc(f.reason)}` + (f.pnl != null && f.side.includes('청산') || f.side === '매도' ? ` · <span class="${cls(f.pnl)} num">${fsign(f.pnl, mk)} ${unit(mk)}</span>` : '');
}
let feedOk = { spot: false, fut: false };
function setFeed() {
  const s = $('#feedStat'), a = feedOk.spot, b = feedOk.fut;
  s.querySelector('.dot').className = 'dot ' + (a && b ? 'ok' : a || b ? 'wait' : 'bad');
  s.querySelector('span:last-child').textContent = a && b ? '실시간 시세' : `시세: 업비트 ${a ? '○' : '×'} · 바이낸스 ${b ? '○' : '×'}`;
}
function upbitWS(delay = 1000) {
  let ws;
  try { ws = new WebSocket('wss://api.upbit.com/websocket/v1'); } catch { return setTimeout(() => upbitWS(delay * 2), delay); }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    const codes = SYMS.map((s) => 'KRW-' + s);
    ws.send(JSON.stringify([{ ticket: 'desk-' + Math.random().toString(36).slice(2) }, { type: 'ticker', codes }, { type: 'orderbook', codes }, { format: 'DEFAULT' }]));
    feedOk.spot = true; setFeed(); delay = 1000;
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)); } catch { return; }
    const s = (m.code || '').replace('KRW-', '');
    if (!P.spot[s]) return;
    if (m.type === 'ticker') {
      Object.assign(P.spot[s], { last: m.trade_price, chg: m.signed_change_rate, high: m.high_price, low: m.low_price, vol: m.acc_trade_price_24h });
      onTick('spot', s, m.trade_price); paintTick('spot', s);
    } else if (m.type === 'orderbook') {
      const u = m.orderbook_units || [];
      P.spot[s].asks = u.map((x) => [x.ask_price, x.ask_size]); P.spot[s].bids = u.map((x) => [x.bid_price, x.bid_size]);
      if (u[0]) { P.spot[s].ask = u[0].ask_price; P.spot[s].bid = u[0].bid_price; }
      if (ui.mkt === 'spot' && ui.sym === s) paintOB();
    }
  };
  ws.onclose = () => { feedOk.spot = false; setFeed(); setTimeout(() => upbitWS(Math.min(delay * 2, 30000)), delay); };
  ws.onerror = () => ws.close();
}
const lastFundT = {}, lastFundR = {};
function binanceWS(delay = 1000) {
  const st = SYMS.flatMap((s) => { const x = s.toLowerCase() + 'usdt'; return [`${x}@markPrice@1s`, `${x}@bookTicker`, `${x}@depth10@500ms`, `${x}@ticker`]; });
  let ws;
  try { ws = new WebSocket('wss://fstream.binance.com/stream?streams=' + st.join('/')); } catch { return setTimeout(() => binanceWS(delay * 2), delay); }
  ws.onopen = () => { feedOk.fut = true; setFeed(); delay = 1000; };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    const d = m.data || {}, str = m.stream || '';
    const s = (d.s || str.split('usdt')[0]).toUpperCase().replace('USDT', '');
    if (!P.fut[s]) return;
    if (str.includes('@markPrice')) {
      const mark = +d.p, T = +d.T, r = +d.r;
      if (lastFundT[s] && T > lastFundT[s] && caughtUp && ME.fut.pos[s]) {      // 펀딩 시각이 지남 → 직전 비율로 정산
        const amt = E.applyFunding(ME, s, lastFundT[s], lastFundR[s], mark);
        if (amt) { toast(`${s} 펀딩비 <span class="num ${cls(amt)}">${fsign(amt, 'fut')} USDT</span> (비율 ${fpct(lastFundR[s], 4)})`); save(); }
      }
      lastFundT[s] = T; lastFundR[s] = r;
      Object.assign(P.fut[s], { mark, funding: r, nextFunding: T });
      onTick('fut', s, mark); paintTick('fut', s);
    } else if (str.includes('@bookTicker')) {
      P.fut[s].bid = +d.b; P.fut[s].ask = +d.a;
    } else if (str.includes('@depth')) {
      P.fut[s].asks = (d.a || []).map((x) => [+x[0], +x[1]]); P.fut[s].bids = (d.b || []).map((x) => [+x[0], +x[1]]);
      if (ui.mkt === 'fut' && ui.sym === s) paintOB();
    } else if (str.includes('@ticker')) {
      Object.assign(P.fut[s], { last: +d.c, chg: +d.P / 100, high: +d.h, low: +d.l, vol: +d.q });
    }
  };
  ws.onclose = () => { feedOk.fut = false; setFeed(); setTimeout(() => binanceWS(Math.min(delay * 2, 30000)), delay); };
  ws.onerror = () => ws.close();
}

// ───────────────────────────── 놓친 구간 (화면을 닫아 둔 동안)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function upbitCandles(s, from, unitMin) {
  const out = []; let to = null;
  for (let k = 0; k < 60; k++) {
    const q = `market=KRW-${s}&count=200` + (to ? `&to=${encodeURIComponent(to)}` : '');
    const r = await fetch(`https://api.upbit.com/v1/candles/minutes/${unitMin}?${q}`);
    if (!r.ok) throw new Error('업비트 ' + r.status);
    const a = await r.json();
    if (!a.length) break;
    for (const x of a) out.push({ t: Date.parse(x.candle_date_time_utc + 'Z'), o: x.opening_price, h: x.high_price, l: x.low_price, c: x.trade_price, dur: unitMin * 60000 });
    const oldest = Date.parse(a[a.length - 1].candle_date_time_utc + 'Z');
    if (oldest <= from) break;
    to = new Date(oldest).toISOString().replace('.000Z', 'Z');
    await sleep(130);
  }
  return out.filter((c) => c.t + c.dur > from).sort((a, b) => a.t - b.t);
}
async function binanceCandles(s, from, iv) {
  const out = []; let start = from - (iv === '5m' ? FIVE : 3600000);
  for (let k = 0; k < 40; k++) {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}USDT&interval=${iv}&startTime=${start}&limit=1500`);
    if (!r.ok) throw new Error('바이낸스 ' + r.status);
    const a = await r.json();
    if (!a.length) break;
    for (const x of a) out.push({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], dur: x[6] + 1 - x[0] });
    start = a[a.length - 1][0] + 1;
    if (a.length < 1500) break;
  }
  return out.filter((c) => c.t + c.dur > from);
}
async function catchUpAll() {
  const t = now(), need = { spot: new Set(), fut: new Set() };
  for (const o of ME.orders) if (o.status === 'open') need[o.mkt].add(o.sym);
  for (const s of Object.keys(ME.spot.hold)) need.spot.add(s);
  for (const s of Object.keys(ME.fut.pos)) need.fut.add(s);
  const candles = { spot: {}, fut: {} };
  let n = 0;
  try {
    for (const mkt of ['spot', 'fut']) for (const s of need[mkt]) {
      const from = ME.seen[`${mkt}:${s}`] || ME.updated || t;
      if (t - from < 60000) continue;
      const days = (t - from) / 864e5;
      candles[mkt][s] = mkt === 'spot' ? await upbitCandles(s, from, days > 3 ? 60 : 5) : await binanceCandles(s, from, days > 5 ? '1h' : '5m');
      n += candles[mkt][s].length;
    }
    const ev = E.catchUp(ME, candles, t);
    for (const s of Object.keys(ME.fut.pos)) await fundingCatchUp(s);
    for (const mkt of ['spot', 'fut']) for (const s of SYMS) ME.seen[`${mkt}:${s}`] = Math.floor(t / FIVE) * FIVE;
    caughtUp = true; catchFail = false;
    if (ev.length) { toast(`<b>화면을 닫아 둔 동안 ${ev.length}건 체결</b> (캔들 ${n}개 확인)<br>` + ev.slice(0, 6).map(fillMsg).join('<br>'), 12000); }
    save();
  } catch (e) {
    caughtUp = true; catchFail = true;
    toast(`놓친 구간 확인 실패 (${esc(e.message)}) — 지금부터의 실시간 체결만 반영해요. 다음에 열 때 다시 확인합니다.`, 9000);
  }
  renderTabs(); renderForm();
}
async function fundingCatchUp(s) {
  const p = ME.fut.pos[s]; if (!p) return;
  const from = Math.max(ME.lastFunding[s] || 0, p.opened) + 1;
  const r = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}USDT&startTime=${from}&limit=1000`);
  if (!r.ok) return;
  for (const x of await r.json()) E.applyFunding(ME, s, x.fundingTime, +x.fundingRate, +x.markPrice || p.entry);
}
async function loadBtcFilter() {
  try {
    const a = []; let to = null;
    for (let k = 0; k < 2; k++) {
      const r = await fetch('https://api.upbit.com/v1/candles/minutes/240?market=KRW-BTC&count=200' + (to ? '&to=' + encodeURIComponent(to) : ''));
      const j = await r.json(); a.push(...j); to = j[j.length - 1].candle_date_time_utc + 'Z';
    }
    const closed = a.filter((x) => Date.parse(x.candle_date_time_utc + 'Z') + 4 * 3600000 <= now()).sort((x, y) => x.timestamp - y.timestamp).map((x) => x.trade_price);
    const last = closed.slice(-300), sma = last.reduce((s, x) => s + x, 0) / last.length, c = last[last.length - 1];
    btcFilter = { on: c > sma, gap: c / sma - 1 };
  } catch { btcFilter = null; }
  renderTop();
}

// ───────────────────────────── 차트
function mountTV() {
  const box = $('#tv'); box.innerHTML = '';
  if (typeof TradingView === 'undefined') { box.innerHTML = '<div class="empty">트레이딩뷰 차트를 불러오지 못했어요 (광고 차단기·네트워크 확인)</div>'; return; }
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  new TradingView.widget({
    autosize: true, container_id: 'tv', symbol: ui.mkt === 'fut' ? `BINANCE:${ui.sym}USDT.P` : `UPBIT:${ui.sym}KRW`,
    interval: cfg.interval, timezone: 'Asia/Seoul', theme: dark ? 'dark' : 'light', style: '1', locale: 'kr',
    allow_symbol_change: true, hide_side_toolbar: false, withdateranges: true, studies: cfg.studies, save_image: false,
  });
}

// ───────────────────────────── 위쪽 띠 · 종목
function renderTop() {
  const st = view();
  if (!st) { $('#eqSpot').textContent = '–'; $('#eqFut').textContent = '–'; }
  else {
    const eq = E.equity(st, prices());
    $('#eqSpot').innerHTML = `${fmoney(eq.spot)} <span class="${cls(eq.spot - st.init.krw)}" style="font-size:12px">${fpct(eq.spot / st.init.krw - 1)}</span>`;
    $('#eqFut').innerHTML = `${fmoney(eq.fut, 'fut')} <span class="${cls(eq.fut - st.init.usdt)}" style="font-size:12px">${fpct(eq.fut / st.init.usdt - 1)}</span>`;
  }
  $('#btcF').innerHTML = btcFilter ? `<span class="${btcFilter.on ? 'up' : 'dn'}">${btcFilter.on ? '켜짐' : '꺼짐'}</span> <span class="num mute" style="font-size:12px">${fpct(btcFilter.gap, 1)}</span>` : '–';
}
function renderChips() {
  $('#chips').innerHTML = SYMS.map((s) => `<button class="chip ${s === ui.sym ? 'on' : ''}" data-sym="${s}"><b>${s}</b><span class="num" data-px="${s}">–</span><span class="num" data-chg="${s}"></span></button>`).join('');
  $$('#chips .chip').forEach((b) => b.onclick = () => { ui.sym = b.dataset.sym; renderChips(); mountTV(); renderForm(); paintOB(); });
  for (const s of SYMS) paintTick(ui.mkt, s);
}
let topTimer = 0, tabTimer = 0;
function paintTick(mkt, s) {
  if (mkt === ui.mkt) {
    const q = P[mkt][s], px = mkt === 'fut' ? q.mark : q.last;
    const a = $(`[data-px="${s}"]`), b = $(`[data-chg="${s}"]`);
    if (a) a.textContent = fpx(px, mkt);
    if (b && q.chg != null) { b.textContent = fpct(q.chg); b.className = 'num ' + cls(q.chg); }
    if (s === ui.sym) updateCalc();
  }
  const t = now();
  if (t - topTimer > 1000) { topTimer = t; renderTop(); }
  if (t - tabTimer > 1500 && ui.tab === 'pos') { tabTimer = t; renderTabBody(); }
}
function paintOB() {
  const q = P[ui.mkt][ui.sym], mk = ui.mkt;
  $('#obSym').textContent = `${ui.sym} · ${mk === 'fut' ? 'USDT 무기한' : 'KRW'}`;
  const asks = (q.asks || []).slice(0, 10), bids = (q.bids || []).slice(0, 10);
  const mx = Math.max(1e-12, ...asks.map((x) => x[1]), ...bids.map((x) => x[1]));
  const row = (x, side) => `<tr><td><span class="num ${side === 'a' ? 'dn' : 'up'}">${fpx(x[0], mk)}</span></td><td><i class="bar-${side}" style="width:${(x[1] / mx * 100).toFixed(1)}%"></i><span class="num">${fqty(x[1])}</span></td></tr>`;
  const px = mk === 'fut' ? q.mark : q.last;
  $('#ob').innerHTML = `<table>${asks.slice().reverse().map((x) => row(x, 'a')).join('')}</table>
    <div class="mid num ${cls(q.chg)}">${fpx(px, mk)} <span style="font-size:12px">${fpct(q.chg)}</span>${mk === 'fut' && q.funding != null ? `<div class="mute" style="font-size:11px">펀딩 ${fpct(q.funding, 4)} · ${ftime(q.nextFunding)}</div>` : ''}</div>
    <table>${bids.map((x) => row(x, 'b')).join('')}</table>`;
}

// ───────────────────────────── 주문창
function renderForm() {
  const box = $('#formPane'), mk = ui.mkt, s = ui.sym;
  if (readOnly()) {
    const st = CL;
    const open = st ? st.orders.filter((o) => o.status === 'open') : [];
    box.innerHTML = `<div class="form"><div class="ro">Claude 계좌는 Claude 가 브리핑 때 주문을 넣고, 가상매매 봇이 실행될 때마다 15분봉 고가·저가로 그 사이 체결을 계산해요. 여기서는 보기만 할 수 있어요.</div>
      ${st ? `<div class="lbl">대기 주문 ${open.length}건</div>` + (open.slice(0, 6).map((o) => `<div class="note"><span class="pill ${o.side === 'buy' || o.side === 'long' ? 'long' : 'short'}">${sideTxt(o)}</span> ${o.sym} ${typeTxt(o)} ${o.price ? fpx(o.price, o.mkt) : ''}<br>${esc(o.note || '')}</div>`).join('') || '<div class="note">없음</div>')
        : '<div class="note">아직 Claude 계좌 기록이 없어요. 설정에서 GitHub 를 연결하고, Claude 브리핑 예약 작업이 켜지면 나타나요.</div>'}</div>`;
    return;
  }
  const isFut = mk === 'fut', buy = ui.side === 'buy';
  const px = pxOf(mk, s);
  const holdQty = ME.spot.hold[s]?.qty || 0;
  const sideSeg = isFut ? '' : `<div class="seg" id="sideSeg" style="display:grid;grid-template-columns:1fr 1fr"><button data-side="buy" class="${buy ? 'on' : ''}">매수</button><button data-side="sell" class="${!buy ? 'on' : ''}">매도</button></div>`;
  const typeSeg = `<div class="seg" id="typeSeg" style="display:grid;grid-template-columns:repeat(3,1fr)">${[['market', '시장가'], ['limit', '지정가'], ['stop', '조건']].map(([k, v]) => `<button data-t="${k}" class="${ui.otype === k ? 'on' : ''}">${v}</button>`).join('')}</div>`;
  const priceF = ui.otype === 'market' ? '' : `<div><div class="lbl">${ui.otype === 'stop' ? '조건 가격 (돌파 시 매수·롱 / 이탈 시 매도·숏)' : '지정 가격'}</div><div class="field"><input id="fPrice" inputmode="decimal" value="${px ? fpx(px, mk).replace(/,/g, '') : ''}"><span>${unit(mk)}</span></div></div>`;
  const amtLbl = isFut ? '증거금' : buy ? '주문 금액' : '매도 수량';
  const amtUnit = isFut ? 'USDT' : buy ? '원' : s;
  const avail = isFut ? `가능 ${fmoney(ME.fut.wallet, 'fut')} USDT` : buy ? `가능 ${fmoney(ME.spot.cash)} 원` : `보유 ${fqty(holdQty)} ${s}`;
  const levF = isFut ? `<div><div class="row" style="justify-content:space-between"><span class="lbl">레버리지 (격리)</span><span class="num acc" id="levTxt">${ui.lev}x</span></div><div class="lev"><input type="range" id="fLev" min="1" max="100" value="${ui.lev}"><div class="field" style="width:70px"><input id="fLevN" inputmode="numeric" value="${ui.lev}"><span>x</span></div></div></div>` : '';
  const entry = isFut || buy;
  const sltp = entry ? `<div class="row"><div style="flex:1"><div class="lbl">손절가 (선택)</div><div class="field"><input id="fSL" inputmode="decimal" placeholder="없음"></div></div><div style="flex:1"><div class="lbl">익절가 (선택)</div><div class="field"><input id="fTP" inputmode="decimal" placeholder="없음"></div></div></div>` : '';
  const jr = entry ? `<details class="jr" id="jr"><summary>매매 일지 (진입 이유를 남기면 셋업별 기대값이 계산돼요)</summary><div class="jrin">
      <div class="row"><div class="field" style="flex:1"><select id="fSetup"><option value="">셋업 선택</option>${ME.setups.map((x) => `<option>${esc(x)}</option>`).join('')}</select></div>
      <div class="field" style="flex:1"><select id="fEmo"><option value="">지금 감정</option>${['차분', '확신', '조급', '불안', '본전 생각', '욕심'].map((x) => `<option>${x}</option>`).join('')}</select></div></div>
      <textarea id="fReason" placeholder="왜 지금 들어가나요? (예: 4시간봉 박스 상단 거래량 돌파, 손절은 박스 안 복귀)"></textarea></div></details>` : '';
  const btns = isFut ? `<div class="big"><button class="btn buy" id="goLong">롱 / 매수</button><button class="btn sell" id="goShort">숏 / 매도</button></div>`
    : `<button class="btn ${buy ? 'buy' : 'sell'}" id="goSpot">${buy ? '매수' : '매도'}</button>`;
  box.innerHTML = `<div class="form">${sideSeg}${typeSeg}${levF}${priceF}
    <div><div class="row" style="justify-content:space-between"><span class="lbl">${amtLbl}</span><span class="note num">${avail}</span></div>
      <div class="field"><input id="fAmt" inputmode="decimal" placeholder="0"><span>${amtUnit}</span></div></div>
    <div class="pcts">${[10, 25, 50, 100].map((p) => `<button data-p="${p}">${p}%</button>`).join('')}</div>
    ${sltp}<div class="calc num" id="calc"></div>${jr}${btns}
    <div class="note">${isFut ? '수수료 시장가 0.05% · 지정가 0.02% · 유지증거금 0.5% · 8시간마다 펀딩비' : '수수료 0.05% (업비트) · 최소 주문 5,000원'}</div></div>`;
  $$('#sideSeg button').forEach((b) => b.onclick = () => { ui.side = b.dataset.side; renderForm(); });
  $$('#typeSeg button').forEach((b) => b.onclick = () => { ui.otype = b.dataset.t; renderForm(); });
  const lev = $('#fLev'), levN = $('#fLevN');
  if (lev) { lev.oninput = () => { ui.lev = +lev.value; levN.value = ui.lev; $('#levTxt').textContent = ui.lev + 'x'; updateCalc(); }; levN.oninput = () => { ui.lev = Math.max(1, Math.min(125, +levN.value || 1)); lev.value = Math.min(100, ui.lev); $('#levTxt').textContent = ui.lev + 'x'; updateCalc(); }; }
  $$('.pcts button').forEach((b) => b.onclick = () => {
    const p = +b.dataset.p / 100;
    const v = isFut ? ME.fut.wallet * p / (1 + ui.lev * E.FEE.futTaker) : buy ? ME.spot.cash * p : holdQty * p;
    $('#fAmt').value = isFut ? Math.floor(v * 100) / 100 : buy ? Math.floor(v) : +v.toPrecision(8);
    updateCalc();
  });
  $$('#formPane input').forEach((i) => i.addEventListener('input', updateCalc));
  if ($('#goSpot')) $('#goSpot').onclick = () => submit(buy ? 'buy' : 'sell');
  if ($('#goLong')) $('#goLong').onclick = () => submit('long');
  if ($('#goShort')) $('#goShort').onclick = () => submit('short');
  updateCalc();
}
const numIn = (id) => { const e = $('#' + id); if (!e) return null; const v = parseFloat(String(e.value).replace(/,/g, '')); return isFinite(v) && v > 0 ? v : null; };
function updateCalc() {
  const c = $('#calc'); if (!c || readOnly()) return;
  const mk = ui.mkt, s = ui.sym, isFut = mk === 'fut';
  const px = ui.otype === 'market' ? pxOf(mk, s) : numIn('fPrice') ?? pxOf(mk, s);
  const amt = numIn('fAmt'), sl = numIn('fSL'), tp = numIn('fTP');
  const L = [];
  if (isFut) {
    const nominal = (amt || 0) * ui.lev, qty = px ? nominal / px : 0;
    const liqL = px && amt ? E.liqPrice({ side: 'long', qty, entry: px, margin: amt }) : null, liqS = px && amt ? E.liqPrice({ side: 'short', qty, entry: px, margin: amt }) : null;
    L.push(['명목 금액', `${fmoney(nominal, 'fut')} USDT`], ['수량', `${fqty(qty)} ${s}`], ['예상 청산가 롱 / 숏', `<span class="up">${fpx(liqL, 'fut')}</span> / <span class="dn">${fpx(liqS, 'fut')}</span>`]);
    if (sl && qty) { const risk = Math.abs(px - sl) * qty; L.push(['손절 시 손실', `<span class="dn">−${fmoney(risk, 'fut')} USDT (${fpct(-risk / Math.max(1, E.equity(ME, prices()).fut), 1)})</span>`]); if (tp) L.push(['손익비', (Math.abs(tp - px) / Math.abs(px - sl)).toFixed(2)]); }
  } else if (ui.side === 'buy') {
    const qty = px && amt ? amt * (1 - E.FEE.spot) / px : 0;
    L.push(['예상 수량', `${fqty(qty)} ${s}`], ['수수료', `${fmoney((amt || 0) * E.FEE.spot)} 원`]);
    if (sl && qty) { const risk = (px - sl) * qty; L.push(['손절 시 손실', `<span class="dn">−${fmoney(risk)} 원 (${fpct(-risk / Math.max(1, E.equity(ME, prices()).spot), 1)})</span>`]); if (tp) L.push(['손익비', ((tp - px) / (px - sl)).toFixed(2)]); }
  } else {
    const h = ME.spot.hold[s];
    L.push(['예상 금액', `${fmoney((amt || 0) * (px || 0) * (1 - E.FEE.spot))} 원`]);
    if (h) L.push(['예상 손익', `<span class="${cls((px - h.avg))}">${fsign((amt || 0) * ((px || 0) * (1 - E.FEE.spot) - h.avg))} 원</span>`]);
  }
  c.innerHTML = L.map(([a, b]) => `<span class="mute">${a}</span><span>${b}</span>`).join('');
}
function sideTxt(o) { return { buy: '매수', sell: '매도', long: '롱', short: '숏' }[o.side] + (o.reduce ? ' 청산' : ''); }
function typeTxt(o) { return { market: '시장가', limit: '지정가', stop: '조건' }[o.type] || o.type; }

async function submit(side) {
  const mk = ui.mkt, s = ui.sym, t = now();
  const amt = numIn('fAmt'); if (!amt) return toast('수량(금액)을 넣어 주세요');
  const sl = numIn('fSL'), tp = numIn('fTP');
  const meta = { sl, tp, setup: $('#fSetup')?.value || null, emotion: $('#fEmo')?.value || null, reason: $('#fReason')?.value?.trim() || '', by: 'manual' };
  const ref = pxOf(mk, s);
  if (!ref) return toast('아직 시세를 받지 못했어요');
  const dirLong = side === 'buy' || side === 'long';
  if (sl && (dirLong ? sl >= ref : sl <= ref) && ui.otype === 'market') return toast(`손절가가 ${dirLong ? '현재가보다 낮아야' : '현재가보다 높아야'} 해요`);
  let r;
  if (ui.otype === 'market') {
    const q = P[mk][s];
    if (mk === 'spot') r = side === 'buy' ? E.spotBuy(ME, s, amt, q.ask || ref, t, '시장가', meta) : E.spotSell(ME, s, amt, q.bid || ref, t, '시장가');
    else {
      if (ui.lev >= 20 && !(await modal(`<b>${ui.lev}배</b> 레버리지예요. 가격이 ${(100 / ui.lev).toFixed(1)}% 만 반대로 가도 증거금을 거의 다 잃어요. 진행할까요?`, [{ label: '취소', ret: false }, { label: '진행', ret: true, cls: 'danger' }]))) return;
      r = E.futOpen(ME, s, side, amt, ui.lev, side === 'long' ? (q.ask || ref) : (q.bid || ref), t, '시장가', meta);
    }
    if (!r.ok) return toast(esc(r.why));
    toast(fillMsg(r.fill));
  } else {
    const price = numIn('fPrice'); if (!price) return toast('가격을 넣어 주세요');
    if (ui.otype === 'stop' && (dirLong ? price <= ref : price >= ref)) return toast(`조건 주문은 ${dirLong ? '현재가보다 높은 돌파 가격' : '현재가보다 낮은 이탈 가격'}이어야 해요`);
    const o = { mkt: mk, sym: s, side, type: ui.otype, price, ...meta };
    if (mk === 'spot') { if (side === 'buy') o.krw = amt; else o.qty = amt; } else { o.margin = amt; o.lev = ui.lev; }
    E.placeOrder(ME, o, t);
    toast(`${s} ${sideTxt(o)} ${typeTxt(o)} 주문 접수 · ${fpx(price, mk)}`);
  }
  save(); renderForm(); renderTabs(); renderTop();
}

// ───────────────────────────── 아래 탭
const TABS = [['pos', '포지션'], ['ord', '대기 주문'], ['fill', '체결'], ['jr', '매매 일지'], ['stat', '통계'], ['brief', '브리핑'], ['bot', '봇 계좌'], ['set', '설정']];
function renderTabs() {
  const st = view();
  const cnt = { pos: st ? Object.keys(st.spot.hold).length + Object.keys(st.fut.pos).length : 0, ord: st ? st.orders.filter((o) => o.status === 'open').length : 0, brief: BRIEFS.length };
  $('#tabs').innerHTML = TABS.map(([k, v]) => `<button data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${v}${cnt[k] ? `<span class="cnt num">${cnt[k]}</span>` : ''}</button>`).join('');
  $$('#tabs button').forEach((b) => b.onclick = () => { ui.tab = b.dataset.tab; renderTabs(); });
  renderTabBody();
}
function renderTabBody() {
  const st = view(), body = $('#tabBody');
  const needSt = ['pos', 'ord', 'fill', 'jr', 'stat'].includes(ui.tab);
  if (needSt && !st) { body.innerHTML = '<div class="empty">Claude 계좌 기록이 아직 없어요. 설정에서 GitHub 를 연결하면 불러와요.</div>'; return; }
  ({ pos: tabPos, ord: tabOrd, fill: tabFill, jr: tabJr, stat: tabStat, brief: tabBrief, bot: tabBot, set: tabSet })[ui.tab](body, st);
}
function tabPos(body, st) {
  const pr = prices(), ro = readOnly();
  const hs = Object.entries(st.spot.hold), fs = Object.entries(st.fut.pos);
  if (!hs.length && !fs.length) { body.innerHTML = '<div class="empty">보유 중인 포지션이 없어요. 위 주문창에서 시작하세요.</div>'; return; }
  let h = '';
  if (hs.length) {
    h += `<table class="t"><thead><tr><th class="l">현물</th><th>수량</th><th>평균 단가</th><th>현재가</th><th>평가 금액</th><th>평가 손익</th><th>손절 / 익절</th>${ro ? '' : '<th></th>'}</tr></thead><tbody>`;
    for (const [s, x] of hs) {
      const p = pr.spot[s] ?? x.avg, v = x.qty * p, pnl = v * (1 - E.FEE.spot) - x.qty * x.avg;
      h += `<tr><td class="l"><b>${s}</b></td><td class="num">${fqty(x.qty)}</td><td class="num">${fpx(x.avg)}</td><td class="num">${fpx(p)}</td><td class="num">${fmoney(v)}</td>
        <td class="num ${cls(pnl)}">${fsign(pnl)} (${fpct(pnl / (x.qty * x.avg))})</td><td class="num">${fpx(x.sl)} / ${fpx(x.tp)}</td>
        ${ro ? '' : `<td><button class="btn2" data-edit="spot:${s}">손절·익절</button> <button class="btn2" data-cs="${s}:0.5">50%</button> <button class="btn2 danger" data-cs="${s}:1">전량 매도</button></td>`}</tr>`;
    }
    h += '</tbody></table>';
  }
  if (fs.length) {
    h += `<table class="t" style="margin-top:10px"><thead><tr><th class="l">선물</th><th>수량</th><th>진입가</th><th>마크 가격</th><th>청산가</th><th>증거금</th><th>미실현 손익 (ROE)</th><th>손절 / 익절</th>${ro ? '' : '<th></th>'}</tr></thead><tbody>`;
    for (const [s, x] of fs) {
      const p = pr.fut[s] ?? x.entry, u = E.upnl(x, p), liq = E.liqPrice(x);
      h += `<tr><td class="l"><b>${s}</b> <span class="pill ${x.side}">${x.side === 'long' ? '롱' : '숏'} ${x.lev.toFixed(1)}x</span></td><td class="num">${fqty(x.qty)}</td><td class="num">${fpx(x.entry, 'fut')}</td><td class="num">${fpx(p, 'fut')}</td>
        <td class="num acc">${fpx(liq, 'fut')}</td><td class="num">${fmoney(x.margin, 'fut')}</td><td class="num ${cls(u)}">${fsign(u, 'fut')} (${fpct(u / x.margin)})</td>
        <td class="num">${fpx(x.sl, 'fut')} / ${fpx(x.tp, 'fut')}</td>
        ${ro ? '' : `<td><button class="btn2" data-edit="fut:${s}">손절·익절</button> <button class="btn2" data-cf="${s}:0.5">50%</button> <button class="btn2 danger" data-cf="${s}:1">전량 청산</button></td>`}</tr>`;
    }
    h += '</tbody></table>';
  }
  body.innerHTML = h;
  $$('[data-cs]', body).forEach((b) => b.onclick = () => { const [s, f] = b.dataset.cs.split(':'); const x = ME.spot.hold[s]; const r = E.spotSell(ME, s, x.qty * +f, P.spot[s].bid || P.spot[s].last, now(), '시장가 매도'); if (r.ok) { toast(fillMsg(r.fill)); afterTrade(r.fill); } });
  $$('[data-cf]', body).forEach((b) => b.onclick = () => { const [s, f] = b.dataset.cf.split(':'); const x = ME.fut.pos[s]; const q = P.fut[s]; const r = E.futClose(ME, s, x.qty * +f, x.side === 'long' ? (q.bid || q.mark) : (q.ask || q.mark), now(), '시장가 청산'); if (r.ok) { toast(fillMsg(r.fill)); afterTrade(r.fill); } });
  $$('[data-edit]', body).forEach((b) => b.onclick = () => editSLTP(...b.dataset.edit.split(':')));
}
function afterTrade(f) {
  save(); renderTabs(); renderForm(); renderTop();
  const tr = E.trOf(ME, f.tradeId);
  if (tr && tr.status === 'closed') reviewTrade(tr);
}
async function editSLTP(mkt, s) {
  const x = mkt === 'fut' ? ME.fut.pos[s] : ME.spot.hold[s]; if (!x) return;
  const v = await modal(`<b>${s} 손절 · 익절</b><div class="row"><div style="flex:1"><div class="lbl">손절가</div><div class="field"><input id="mSL" value="${x.sl ?? ''}" placeholder="없음"></div></div><div style="flex:1"><div class="lbl">익절가</div><div class="field"><input id="mTP" value="${x.tp ?? ''}" placeholder="없음"></div></div></div><div class="note">비우면 해제. 화면을 닫아 둬도 다음에 열 때 그 사이 캔들로 확인해요.</div>`,
    [{ label: '취소', ret: null }, { label: '저장', value: (r) => ({ sl: parseFloat($('#mSL', r).value), tp: parseFloat($('#mTP', r).value) }) }]);
  if (!v) return;
  x.sl = isFinite(v.sl) && v.sl > 0 ? v.sl : null; x.tp = isFinite(v.tp) && v.tp > 0 ? v.tp : null;
  const tr = E.trOf(ME, x.tradeId); if (tr && !tr.sl0 && x.sl) { tr.sl0 = x.sl; const q = x.qty; tr.risk = Math.abs((x.entry ?? x.avg) - x.sl) * q; }
  save(); renderTabBody();
}
function tabOrd(body, st) {
  const os = st.orders.filter((o) => o.status === 'open').concat(st.orders.filter((o) => o.status !== 'open').slice(-20).reverse());
  if (!os.length) { body.innerHTML = '<div class="empty">대기 중인 주문이 없어요. 지정가·조건 주문은 화면을 닫아 둬도 다음에 열 때 그 사이 가격으로 체결돼요.</div>'; return; }
  body.innerHTML = `<table class="t"><thead><tr><th class="l">접수</th><th class="l">종목</th><th class="l">구분</th><th>가격</th><th>금액 / 수량</th><th>손절 / 익절</th><th class="l">상태</th><th class="l">메모</th><th></th></tr></thead><tbody>${os.map((o) => `<tr>
    <td class="l num">${ftime(o.created)}</td><td class="l"><b>${o.sym}</b> <span class="mute">${o.mkt === 'fut' ? '선물' : '현물'}</span></td>
    <td class="l"><span class="pill ${o.side === 'buy' || o.side === 'long' ? 'long' : 'short'}">${sideTxt(o)}</span> ${typeTxt(o)}${o.lev ? ` ${o.lev}x` : ''}</td>
    <td class="num">${fpx(o.price, o.mkt)}</td><td class="num">${o.krw ? fmoney(o.krw) + ' 원' : o.margin ? fmoney(o.margin, 'fut') + ' USDT' : fqty(o.qty)}</td>
    <td class="num">${fpx(o.sl, o.mkt)} / ${fpx(o.tp, o.mkt)}</td>
    <td class="l">${o.status === 'open' ? '<span class="pill acc">대기</span>' : `<span class="pill">${{ filled: '체결', canceled: '취소', expired: '만료', rejected: '거절' }[o.status]}</span> <span class="mute">${esc(o.why || '')}</span>`}</td>
    <td class="wrap2">${esc(o.note || o.reason || '')}</td>
    <td>${o.status === 'open' && !readOnly() ? `<button class="btn2" data-cancel="${o.id}">취소</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  $$('[data-cancel]', body).forEach((b) => b.onclick = () => { E.cancelOrder(ME, b.dataset.cancel, now()); save(); renderTabs(); });
}
function tabFill(body, st) {
  const fs = st.fills.slice(-200).reverse();
  if (!fs.length) { body.innerHTML = '<div class="empty">체결 기록이 없어요.</div>'; return; }
  body.innerHTML = `<table class="t"><thead><tr><th class="l">시각</th><th class="l">종목</th><th class="l">구분</th><th>가격</th><th>수량</th><th>금액</th><th>수수료</th><th>손익</th><th class="l">사유</th></tr></thead><tbody>${fs.map((f) => `<tr>
    <td class="l num">${ftime(f.t)}</td><td class="l"><b>${f.sym}</b> <span class="mute">${f.mkt === 'fut' ? '선물' : '현물'}</span></td><td class="l">${esc(f.side)}</td>
    <td class="num">${fpx(f.price, f.mkt)}</td><td class="num">${fqty(f.qty)}</td><td class="num">${fmoney(f.amount, f.mkt)}</td><td class="num mute">${fmoney(f.fee, f.mkt)}</td>
    <td class="num ${cls(f.pnl)}">${f.pnl == null ? '' : fsign(f.pnl, f.mkt)}</td><td class="l">${esc(f.reason)}</td></tr>`).join('')}</tbody></table>`;
}
function tabJr(body, st) {
  const ts = st.trades.slice().reverse();
  if (!ts.length) { body.innerHTML = '<div class="empty">아직 거래가 없어요. 진입할 때 주문창의 \'매매 일지\'에 셋업·이유·감정을 남기면, 청산 뒤 여기서 돌아보기를 적을 수 있어요.</div>'; return; }
  body.innerHTML = `<table class="t"><thead><tr><th class="l">진입</th><th class="l">청산</th><th class="l">종목</th><th class="l">셋업</th><th class="l">감정</th><th>진입 → 청산</th><th>손익</th><th>R</th><th class="l">이유 · 돌아보기</th><th></th></tr></thead><tbody>${ts.map((x) => `<tr>
    <td class="l num">${ftime(x.openT)}</td><td class="l num">${x.status === 'open' ? '<span class="pill acc">보유 중</span>' : ftime(x.closeT)}</td>
    <td class="l"><b>${x.sym}</b> <span class="pill ${x.dir}">${x.mkt === 'fut' ? (x.dir === 'long' ? '롱' : '숏') + ' ' + Math.round(x.lev) + 'x' : '현물'}</span>${x.liquidated ? ' <span class="pill short">청산당함</span>' : ''}</td>
    <td class="l">${esc(x.setup || '–')}</td><td class="l">${esc(x.emotion || '–')}</td>
    <td class="num">${fpx(x.entry, x.mkt)} → ${fpx(x.exit, x.mkt)}</td><td class="num ${cls(x.pnl)}">${x.status === 'closed' ? fsign(x.pnl, x.mkt) : ''}</td>
    <td class="num ${cls(x.R)}">${x.R == null ? '–' : x.R.toFixed(2)}</td>
    <td class="wrap2">${esc(x.reason || x.note || '')}${x.review ? `<br><span class="mute">↳ ${esc(x.review)}</span>` : ''}${x.ruleOk != null ? ` <span class="pill ${x.ruleOk ? 'acc' : 'short'}">${x.ruleOk ? '규칙 지킴' : '규칙 어김'}</span>` : ''}</td>
    <td>${readOnly() ? '' : `<button class="btn2" data-rv="${x.id}">기록</button>`}</td></tr>`).join('')}</tbody></table>`;
  $$('[data-rv]', body).forEach((b) => b.onclick = () => reviewTrade(E.trOf(ME, b.dataset.rv)));
}
async function reviewTrade(tr) {
  if (!tr) return;
  const v = await modal(`<b>${tr.sym} ${tr.mkt === 'fut' ? (tr.dir === 'long' ? '롱' : '숏') : '현물'} 거래 기록</b>
    ${tr.status === 'closed' ? `<div class="num ${cls(tr.pnl)}">손익 ${fsign(tr.pnl, tr.mkt)} ${unit(tr.mkt)}${tr.R != null ? ` · ${tr.R.toFixed(2)}R` : ''}</div>` : ''}
    <div class="row"><div class="field" style="flex:1"><select id="rSetup"><option value="">셋업</option>${ME.setups.map((x) => `<option ${x === tr.setup ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
    <div class="field" style="flex:1"><select id="rEmo"><option value="">진입 때 감정</option>${['차분', '확신', '조급', '불안', '본전 생각', '욕심'].map((x) => `<option ${x === tr.emotion ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
    <div class="lbl">진입 이유</div><textarea id="rReason">${esc(tr.reason)}</textarea>
    <div class="lbl">돌아보기 (잘한 점 · 아쉬운 점)</div><textarea id="rReview">${esc(tr.review)}</textarea>
    <div class="row"><span class="lbl">계획한 규칙대로 했나요?</span><div class="seg" id="rRule"><button data-v="1" class="${tr.ruleOk === true ? 'on' : ''}">지킴</button><button data-v="0" class="${tr.ruleOk === false ? 'on' : ''}">어김</button></div></div>`,
    [{ label: '나중에', ret: null }, { label: '저장', value: (r) => ({ setup: $('#rSetup', r).value || null, emotion: $('#rEmo', r).value || null, reason: $('#rReason', r).value, review: $('#rReview', r).value, rule: $('#rRule .on', r)?.dataset.v }) }]);
  if (!v) return;
  Object.assign(tr, { setup: v.setup, emotion: v.emotion, reason: v.reason, review: v.review, ruleOk: v.rule == null ? tr.ruleOk : v.rule === '1' });
  save(); renderTabBody();
}
// 모달이 열린 뒤 버튼 연결 (modal() 이 innerHTML 로 그린 직후)
new MutationObserver(() => $$('#rRule button').forEach((b) => b.onclick = () => { $$('#rRule button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); })).observe(document.getElementById('modalRoot'), { childList: true });

function tabStat(body, st) {
  const mk = ui.statMkt, S = E.stats(st, { mkt: mk }), a = S.all;
  const done = st.trades.filter((x) => x.status === 'closed' && x.mkt === mk).sort((x, y) => x.closeT - y.closeT);
  const u = unit(mk);
  const card = (k, v, c = '') => `<div class="card"><small>${k}</small><b class="num ${c}">${v}</b></div>`;
  const grp = (obj) => Object.entries(obj).sort((x, y) => y[1].n - x[1].n).map(([k, g]) => `<tr><td class="l">${esc(k)}</td><td class="num">${g.n}</td><td class="num">${g.win == null ? '–' : (g.win * 100).toFixed(0) + '%'}</td>
    <td class="num">${g.payoff == null ? '–' : g.payoff.toFixed(2)}</td><td class="num ${cls(g.exp)}">${fsign(g.exp, mk)}</td><td class="num ${cls(g.expR)}">${g.expR == null ? '–' : g.expR.toFixed(2) + 'R'}</td><td class="num ${cls(g.total)}">${fsign(g.total, mk)}</td></tr>`).join('');
  const head = `<thead><tr><th class="l"></th><th>거래</th><th>승률</th><th>손익비</th><th>거래당 기대값 (${u})</th><th>기대값 (R)</th><th>합계</th></tr></thead>`;
  body.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:10px"><div class="seg" id="statSeg"><button data-m="spot" class="${mk === 'spot' ? 'on' : ''}">현물</button><button data-m="fut" class="${mk === 'fut' ? 'on' : ''}">선물</button></div>
    <div style="flex:1;max-width:320px"><div class="row" style="justify-content:space-between"><span class="lbl">기대값 판정까지 (100회)</span><span class="num lbl">${a.n} / 100</span></div><div class="prog"><i style="width:${Math.min(100, a.n)}%"></i></div></div></div>
    <div class="cards">${card('끝난 거래', a.n)}${card('승률', a.win == null ? '–' : (a.win * 100).toFixed(0) + '%')}${card('손익비 (평균 이익 ÷ 평균 손실)', a.payoff == null ? '–' : a.payoff.toFixed(2))}
    ${card(`거래당 기대값 (${u})`, fsign(a.exp, mk), cls(a.exp))}${card('기대값 (R, 손절 기준)', a.expR == null ? '–' : a.expR.toFixed(2) + 'R', cls(a.expR))}${card('규칙 지킨 비율', a.rule == null ? '–' : (a.rule * 100).toFixed(0) + '%')}${card(`누적 손익 (${u})`, fsign(a.total, mk), cls(a.total))}</div>
    <canvas id="cum" height="160"></canvas>
    <div class="set" style="margin-top:12px"><section><h3>셋업별</h3><div style="overflow-x:auto"><table class="t">${head}<tbody>${grp(S.setups) || '<tr><td class="l mute" colspan="7">없음</td></tr>'}</tbody></table></div></section>
    <section><h3>진입 때 감정별</h3><div style="overflow-x:auto"><table class="t">${head}<tbody>${grp(S.emotions) || '<tr><td class="l mute" colspan="7">없음</td></tr>'}</tbody></table></div></section></div>
    <p class="note">기대값(R) = 손익 ÷ 진입 때 정한 손절까지의 손실. 손절가를 넣은 거래만 계산돼요. 100회가 쌓였을 때 셋업별 기대값이 플러스인 것만 남기세요.</p>`;
  $$('#statSeg button').forEach((b) => b.onclick = () => { ui.statMkt = b.dataset.m; renderTabBody(); });
  drawCum($('#cum'), done.map((x) => x.pnl), mk);
}
function drawCum(cv, pnls, mk) {
  const w = Math.max(280, cv.parentElement.clientWidth - 4), h = 160, dpr = devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px';
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement), col = (k) => css.getPropertyValue(k).trim();
  g.fillStyle = col('--mute'); g.font = '12px ' + col('--num');
  if (pnls.length < 2) { g.fillText('끝난 거래가 2건 이상이면 누적 손익 곡선이 그려져요', 8, 20); return; }
  let s = 0; const ys = [0, ...pnls.map((p) => (s += p))];
  const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys), pad = 24, L = 70;
  const X = (i) => L + (i / (ys.length - 1)) * (w - L - 10), Y = (v) => pad + (1 - (v - lo) / (hi - lo || 1)) * (h - pad * 2);
  g.strokeStyle = col('--line'); g.beginPath(); g.moveTo(L, Y(0)); g.lineTo(w - 10, Y(0)); g.stroke();
  g.fillText(fmoney(hi, mk), 4, Y(hi) + 4); g.fillText(fmoney(lo, mk), 4, Y(lo) + 4); g.fillText('0', 4, Y(0) + 4);
  g.strokeStyle = col(s >= 0 ? '--up' : '--dn'); g.lineWidth = 2; g.beginPath();
  ys.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))); g.stroke();
  g.fillStyle = g.strokeStyle; g.beginPath(); g.arc(X(ys.length - 1), Y(s), 3.5, 0, 7); g.fill();
}
function md(t) {
  const lines = String(t).replace(/\r/g, '').split('\n'); let out = '', inT = false, inL = false;
  const inl = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  for (const l of lines) {
    if (/^\|/.test(l)) { if (/^\|[\s:|-]+\|$/.test(l)) continue; if (!inT) { out += '<table>'; inT = true; } out += '<tr>' + l.split('|').slice(1, -1).map((c) => `<td>${inl(c.trim())}</td>`).join('') + '</tr>'; continue; }
    if (inT) { out += '</table>'; inT = false; }
    if (/^\s*[-*] /.test(l)) { if (!inL) { out += '<ul>'; inL = true; } out += `<li>${inl(l.replace(/^\s*[-*] /, ''))}</li>`; continue; }
    if (inL) { out += '</ul>'; inL = false; }
    const m = l.match(/^(#{1,3}) (.*)/);
    if (m) out += `<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`; else if (l.trim()) out += `<p>${inl(l)}</p>`;
  }
  return out + (inT ? '</table>' : '') + (inL ? '</ul>' : '');
}
async function tabBrief(body) {
  if (!ghOn()) { body.innerHTML = '<div class="empty">브리핑은 GitHub 저장소(desk/briefings)에서 읽어요. 설정에서 GitHub 를 연결해 주세요.</div>'; return; }
  if (!BRIEFS.length) { body.innerHTML = '<div class="empty">아직 브리핑이 없어요. Claude 브리핑 예약 작업이 켜지면 하루 3번 여기에 쌓여요.</div>'; return; }
  const list = BRIEFS.slice().sort((a, b) => b.t - a.t);
  ui.brief = ui.brief || list[0].id;
  const cur = list.find((x) => x.id === ui.brief) || list[0];
  body.innerHTML = `<div class="brief"><div class="blist">${list.slice(0, 40).map((x) => `<button data-b="${x.id}" class="${x.id === cur.id ? 'on' : ''}"><div class="num" style="font-size:12px">${ftime(x.t)}</div>${esc(x.title || '')}</button>`).join('')}</div><div class="md" id="briefMd">불러오는 중…</div></div>`;
  $$('[data-b]', body).forEach((b) => b.onclick = () => { ui.brief = b.dataset.b; renderTabBody(); });
  if (!BRIEF_TXT[cur.id]) BRIEF_TXT[cur.id] = await ghText(cur.path).catch(() => '불러오지 못했어요');
  if ($('#briefMd')) $('#briefMd').innerHTML = md(BRIEF_TXT[cur.id]);
}
function tabBot(body) {
  if (!ghOn()) { body.innerHTML = '<div class="empty">가상매매 봇(tsb7-paper) 기록을 읽으려면 설정에서 GitHub 를 연결해 주세요.</div>'; return; }
  if (!BOT || !BOT.rows.length) { body.innerHTML = '<div class="empty">봇 기록을 찾지 못했어요 (paper/*/equity.csv).</div>'; return; }
  const NAME = { A: 'TSB7 1/6 (현행)', B: 'TSB7 1/5 + 노출 상한 80%', C: 'TSB7 1/4', D: 'TSB7 + BB20 1/8', H: 'BTC 보유', F: 'BTC 50일선 필터' };
  const rec = Object.fromEntries((BOT.rec || []).map((r) => [r.acct, r]));
  body.innerHTML = `<table class="t"><thead><tr><th class="l">계좌</th><th>평가액</th><th>수익률</th><th>제때 실행했다면</th><th>놓친 거래</th><th>보유</th><th class="l">BTC 필터</th><th class="l">갱신</th><th>추이</th></tr></thead><tbody>${BOT.rows.map((r) => {
    const x = r.last, c = rec[r.a];
    return `<tr><td class="l"><b>${r.a}</b> <span class="mute">${NAME[r.a] || ''}</span></td><td class="num">${fmoney(+x.equity)}</td><td class="num ${cls(+x.ret)}">${fpct(+x.ret)}</td>
      <td class="num ${c ? cls(+c.ontime_ret) : ''}">${c ? fpct(+c.ontime_ret) : '–'}</td><td class="num">${c ? c.ontime_only : '–'}</td><td class="l">${esc(x.holdings || '–')}</td>
      <td class="l">${x.btc_filter_4h === 'True' ? '<span class="up">켜짐</span>' : '<span class="dn">꺼짐</span>'}</td><td class="l num">${esc(x.time_kst)}</td><td>${spark(r.hist)}</td></tr>`;
  }).join('')}</tbody></table><p class="note">'제때 실행했다면' = 하루 한 번 대조 실행이 놓친 매수·늦은 매도를 다음 봉 시가로 반영한 값.</p>`;
}
function spark(v) {
  if (!v || v.length < 2) return '';
  const w = 90, h = 22, lo = Math.min(...v), hi = Math.max(...v);
  const pts = v.map((y, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - 2 - (y - lo) / ((hi - lo) || 1) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="var(--${v[v.length - 1] >= v[0] ? 'up' : 'dn'})" stroke-width="1.5"/></svg>`;
}
function tabSet(body) {
  const ST = [['MASimple@tv-basicstudies', '이동평균'], ['MAExp@tv-basicstudies', '지수이동평균'], ['BB@tv-basicstudies', '볼린저밴드'], ['RSI@tv-basicstudies', 'RSI'], ['MACD@tv-basicstudies', 'MACD'], ['Volume@tv-basicstudies', '거래량'], ['VWAP@tv-basicstudies', 'VWAP'], ['IchimokuCloud@tv-basicstudies', '일목균형표'], ['StochasticRSI@tv-basicstudies', '스토캐스틱 RSI'], ['ATR@tv-basicstudies', 'ATR']];
  body.innerHTML = `<div class="set">
    <section><h3>GitHub 연결 (기록 저장 · 브리핑 · Claude 계좌 · 봇 계좌)</h3>
      <div class="lbl">저장소 주인 (GitHub 아이디)</div><div class="field"><input id="sOwner" value="${esc(cfg.owner)}" style="text-align:left" autocomplete="off"></div>
      <div class="row"><div style="flex:2"><div class="lbl">저장소</div><div class="field"><input id="sRepo" value="${esc(cfg.repo)}" style="text-align:left"></div></div><div style="flex:1"><div class="lbl">브랜치</div><div class="field"><input id="sBranch" value="${esc(cfg.branch)}" style="text-align:left"></div></div></div>
      <div class="lbl">토큰 (Fine-grained · 이 저장소만 · Contents 읽기·쓰기)</div><div class="field"><input id="sToken" type="password" value="${esc(cfg.token)}" style="text-align:left" autocomplete="off"></div>
      <div class="note">토큰은 이 기기의 브라우저에만 저장돼요. 공용 PC 에서는 넣지 마세요.</div>
      <div class="row"><button class="btn2" id="sSave">저장하고 연결</button><span class="note" id="sMsg"></span></div></section>
    <section><h3>차트</h3>
      <div class="lbl">기본 봉</div><div class="field"><select id="sIv">${[['15', '15분'], ['60', '1시간'], ['240', '4시간'], ['D', '일봉']].map(([k, v]) => `<option value="${k}" ${cfg.interval === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="lbl">기본 지표 (차트 안에서도 추가·설정 가능)</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">${ST.map(([k, v]) => `<label class="note"><input type="checkbox" data-st="${k}" ${cfg.studies.includes(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div>
      <div class="lbl">화면 테마</div><div class="seg" id="sTheme">${[['system', '시스템'], ['light', '밝게'], ['dark', '어둡게']].map(([k, v]) => `<button data-th="${k}" class="${cfg.theme === k ? 'on' : ''}">${v}</button>`).join('')}</div></section>
    <section><h3>내 계좌</h3>
      <div class="lbl">셋업 목록 (쉼표로 구분)</div><textarea id="sSetups">${esc(ME.setups.join(', '))}</textarea>
      <div class="row"><div style="flex:1"><div class="lbl">현물 시작 자금 (원)</div><div class="field"><input id="sKrw" value="${ME.init.krw}"></div></div><div style="flex:1"><div class="lbl">선물 시작 자금 (USDT)</div><div class="field"><input id="sUsdt" value="${ME.init.usdt}"></div></div></div>
      <div class="row"><button class="btn2" id="sSetSave">저장</button><button class="btn2" id="sExport">기록 내려받기 (JSON)</button><button class="btn2 danger" id="sReset">계좌 초기화</button></div>
      <div class="note">시작 ${ftime(ME.created)} · 거래 ${ME.trades.length}건 · 체결 ${ME.fills.length}건</div></section></div>`;
  $('#sSave').onclick = async () => {
    Object.assign(cfg, { owner: $('#sOwner').value.trim(), repo: $('#sRepo').value.trim(), branch: $('#sBranch').value.trim() || 'main', token: $('#sToken').value.trim() });
    saveCfg(); $('#sMsg').textContent = '확인 중…';
    try { const r = await gh(''); $('#sMsg').textContent = r.ok ? '연결됨' : `실패 (${r.status}) — 아이디·저장소·토큰 권한 확인`; if (r.ok) { await pullRemote(); await loadShared(); save(); } }
    catch (e) { $('#sMsg').textContent = '실패: ' + e.message; }
  };
  $$('[data-st]', body).forEach((c) => c.onchange = () => { cfg.studies = $$('[data-st]', body).filter((x) => x.checked).map((x) => x.dataset.st); saveCfg(); mountTV(); });
  $('#sIv').onchange = (e) => { cfg.interval = e.target.value; saveCfg(); mountTV(); };
  $$('#sTheme button').forEach((b) => b.onclick = () => { cfg.theme = b.dataset.th; saveCfg(); applyTheme(); renderTabBody(); mountTV(); });
  $('#sSetSave').onclick = () => { ME.setups = $('#sSetups').value.split(',').map((x) => x.trim()).filter(Boolean); save(); toast('저장했어요'); };
  $('#sExport').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(ME, null, 1)], { type: 'application/json' })); a.download = `desk-${new Date().toISOString().slice(0, 10)}.json`; a.click(); };
  $('#sReset').onclick = async () => {
    const ok = await modal('<b>계좌를 초기화할까요?</b><div class="note">지금까지의 포지션·주문·체결·일지가 모두 지워지고 시작 자금으로 새로 시작해요. 저장소의 이전 기록은 GitHub 커밋 기록에 남아 있어요.</div>', [{ label: '취소', ret: false }, { label: '초기화', ret: true, cls: 'danger' }]);
    if (!ok) return;
    const setups = ME.setups;
    ME = E.newAccount({ krw: +$('#sKrw').value || 10_000_000, usdt: +$('#sUsdt').value || 10_000 }); ME.setups = setups;
    for (const mkt of ['spot', 'fut']) for (const s of SYMS) ME.seen[`${mkt}:${s}`] = Math.floor(now() / FIVE) * FIVE;
    save(); renderAll(); toast('새 계좌로 시작했어요');
  };
}

// ───────────────────────────── 시작
function applyTheme() { if (cfg.theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = cfg.theme; }
function renderAll() {
  $$('#acctSeg button').forEach((x) => x.classList.toggle('on', x.dataset.acct === ui.acct));
  $$('#mktSeg button').forEach((x) => x.classList.toggle('on', x.dataset.mkt === ui.mkt));
  renderTop(); renderChips(); renderForm(); paintOB(); renderTabs();
}
function bind() {
  $$('#acctSeg button').forEach((b) => b.onclick = () => { ui.acct = b.dataset.acct; $$('#acctSeg button').forEach((x) => x.classList.toggle('on', x === b)); renderAll(); });
  $$('#mktSeg button').forEach((b) => b.onclick = () => { ui.mkt = b.dataset.mkt; if (ui.mkt === 'fut') ui.side = 'buy'; $$('#mktSeg button').forEach((x) => x.classList.toggle('on', x === b)); renderAll(); mountTV(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (cfg.theme === 'system') mountTV(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && caughtUp) { caughtUp = false; catchUpAll(); } });
}
async function start() {
  applyTheme(); bind(); renderAll(); mountTV();
  setSync(ghOn() ? 'wait' : '', ghOn() ? '저장소 확인 중' : '이 기기에만 저장 (설정에서 GitHub 연결)');
  upbitWS(); binanceWS();
  await pullRemote();
  renderAll();
  await catchUpAll();
  loadShared(); loadBtcFilter();
  setInterval(loadShared, 5 * 60000); setInterval(loadBtcFilter, 30 * 60000);
}
start();
