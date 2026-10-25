/* 트레이딩 데스크 — 화면 · 시세 · 저장 (engine.js 의 DeskEngine 사용) */
'use strict';
const E = window.DeskEngine;
const DEF_SYMS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'ADA', 'LINK', 'NEAR'];
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
  studies: ['MASimple@tv-basicstudies', 'BB@tv-basicstudies', 'RSI@tv-basicstudies'], chart: 'my', myIv: '240', myInd: { ma: true, bb: true } }, LS.get('desk.cfg', {}));
const saveCfg = () => LS.set('desk.cfg', cfg);
const SYMS = (Array.isArray(cfg.syms) && cfg.syms.length ? cfg.syms : DEF_SYMS).filter((x) => /^[A-Z0-9]{2,12}$/.test(x));
let migratedNote = false;
// v2: 현물을 업비트 원화 → 바이낸스 USDT 로. 예전 계좌는 선물 기록은 살리고 현물만 1만 USDT 로 새로 시작
function migrateMe(m) {
  if (m && m.schema >= E.SCHEMA) return m;
  const n = E.newAccount();
  if (m) {
    LS.set('desk.me.v1', m);
    Object.assign(n, { created: m.created || n.created, setups: m.setups || n.setups, fut: m.fut || n.fut, funding: m.funding || [], lastFunding: m.lastFunding || {},
      trades: (m.trades || []).filter((x) => x.mkt === 'fut'), fills: (m.fills || []).filter((x) => x.mkt === 'fut'), orders: (m.orders || []).filter((x) => x.mkt === 'fut'),
      seen: Object.fromEntries(Object.entries(m.seen || {}).filter(([k]) => k.startsWith('fut:'))), migrated: Date.now() });
    n.init.usdt = m.init?.usdt ?? n.init.usdt;
    n.updated = m.updated || 0;      // 다른 기기가 이미 옮긴 기록이 저장소에 있으면 그쪽이 이기도록
    migratedNote = true;
  } else n.updated = 0;              // 이 기기에 기록이 없으면 저장소 기록이 이기도록 (새 기기에서 빈 계좌로 덮어쓰지 않게)
  return n;
}
let ME = migrateMe(LS.get('desk.me', null));
let ME_SHA = LS.get('desk.me.sha', null);
let CL = null, BRIEFS = [], BRIEF_TXT = {}, BOT = null, MKT = null, REVIEWS = [], REV_TXT = {};
const ui = { acct: 'me', mkt: 'spot', sym: 'BTC', tab: 'pos', side: 'buy', otype: 'market', lev: 10, statMkt: 'fut', brief: null, page: 'trade', rev: null, draw: null, drawA: null };
const P = { spot: {}, fut: {} };
for (const s of SYMS) { P.spot[s] = {}; P.fut[s] = {}; }
let caughtUp = false, catchFail = false, btcFilter = null;

// ───────────────────────────── 형식
function fpx(x) {     // 가격 (USDT): 100 이상 소수 둘째 · 1 이상 넷째 · 그 아래 다섯째
  if (x == null || !isFinite(x)) return '–';
  const a = Math.abs(x);
  return a >= 100 ? x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : a >= 1 ? x.toFixed(4) : x.toFixed(5);
}
const fmoney = (x) => x == null || !isFinite(x) ? '–' : x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fkrw = (x) => x == null || !isFinite(x) ? '–' : Math.round(x).toLocaleString('ko-KR');
const fsign = (x, mkt) => x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + fmoney(x, mkt);
const fpct = (x, d = 2) => x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
const fqty = (x) => x == null ? '–' : x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(4) : x.toPrecision(5);
const cls = (x) => x > 0 ? 'up' : x < 0 ? 'dn' : '';
const ftime = (t) => { if (!t) return '–'; const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const unit = () => 'USDT';
const isPhone = () => matchMedia('(max-width: 760px)').matches;   // 폰: 차트 누르기로 가격 넣지 않음, 키보드 안 띄움
const CHART_TIP = () => isPhone() ? '가격은 주문창 왼쪽 호가를 눌러 넣어요' : '가격은 호가창을 눌러 넣어요';
const futPx = (q) => q.mark > 0 ? q.mark : q.last > 0 ? q.last : (q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : undefined);
const pxOf = (mkt, s) => mkt === 'fut' ? futPx(P.fut[s]) : P.spot[s].last;
const prices = () => ({ spot: Object.fromEntries(SYMS.map((s) => [s, P.spot[s].last])), fut: Object.fromEntries(SYMS.map((s) => [s, futPx(P.fut[s])])) });
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
  const ref = opt.ref || cfg.branch;
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}` + (opt.method ? '' : `?ref=${encodeURIComponent(ref)}`);
  return fetch(url, { method: opt.method || 'GET', headers: { Authorization: `Bearer ${cfg.token}`, Accept: opt.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, body: opt.body, cache: 'no-store' });
}
async function ghApi(path, opt = {}) {      // 브랜치 만들기 등 contents 밖의 API
  return fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/${path}`, { method: opt.method || 'GET', headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, body: opt.body ? JSON.stringify(opt.body) : undefined, cache: 'no-store' });
}
async function ghJSON(path, ref) {
  const r = await gh(path, { ref });
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  if (j.content) return { data: JSON.parse(b64d(j.content)), sha: j.sha };
  const raw = await gh(path, { raw: true, ref });
  return { data: JSON.parse(await raw.text()), sha: j.sha };
}
async function ghText(path, ref) {
  const r = await gh(path, { raw: true, ref });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.text();
}
async function ghPut(path, data, sha, msg, branch) {
  const body = JSON.stringify({ message: msg, content: b64e(JSON.stringify(data, null, 1)), branch: branch || cfg.branch, ...(sha ? { sha } : {}) });
  const r = await gh(path, { method: 'PUT', body });
  if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; throw e; }
  return (await r.json()).content.sha;
}
// 내 계좌 기록(me.json)은 별도 브랜치 desk-me 에 — 저장할 때마다 생기는 커밋이 봇 기록(main)에 섞이지 않게. 없으면 main 에서 갈라 만듦.
const ME_BR = () => cfg.meBranch || 'desk-me';
let meBranchOk = false;
async function ensureMeBranch() {
  if (meBranchOk) return true;
  const r = await ghApi(`git/ref/heads/${ME_BR()}`);
  if (r.ok) return (meBranchOk = true);
  if (r.status !== 404) throw new Error(`GitHub ${r.status}`);
  const m = await ghApi(`git/ref/heads/${encodeURIComponent(cfg.branch)}`);
  if (!m.ok) throw new Error(`GitHub ${m.status}`);
  const c = await ghApi('git/refs', { method: 'POST', body: { ref: `refs/heads/${ME_BR()}`, sha: (await m.json()).object.sha } });
  if (!c.ok && c.status !== 422) throw new Error(`브랜치 만들기 실패 ${c.status}`);
  toast(`내 계좌 기록을 저장소의 ${ME_BR()} 브랜치로 옮겼어요 (봇 기록과 분리)`);
  return (meBranchOk = true);
}
const meGet = async () => { await ensureMeBranch(); return ghJSON('desk/me.json', ME_BR()); };
const mePut = async (sha, msg) => { await ensureMeBranch(); return ghPut('desk/me.json', ME, sha, msg, ME_BR()); };
function setSync(state, text) { const s = $('#syncStat'); s.querySelector('.dot').className = 'dot ' + state; s.querySelector('span:last-child').textContent = text; }

// 기기 사이 동기화 — 저장소(desk-me 브랜치)의 me.json 이 기준.
//  · 이 기기에서 바꾼 게 있으면 '저장 안 됨(dirty)' 표시를 켜 두고, 저장소에 올라갈 때까지 계속 다시 시도 (끊겼다 연결되면 바로)
//  · 이 기기에 저장 안 된 변경이 없을 때 저장소가 바뀌어 있으면 → 저장소 것을 그대로 받음 (일별 자산 기록은 양쪽 합침)
//  · 처음 연결하는 기기는 저장소에 기록이 있으면 무조건 저장소 것을 받음 (이 기기 기록은 보관함으로) — 기기 시각으로 판단하지 않음
//  · 둘 다 바뀐 경우(드묾): 저장소 것을 받고 이 기기 것은 보관함(최근 10개)에 — 설정 탭에서 보기·내려받기·되살리기
let saveTimer = null, saving = false, lastPull = 0, retryMs = 15000;
let dirty = !!LS.get('desk.me.dirty', false);
const msig = (m) => m ? JSON.stringify([m.init, m.spot, m.fut, m.orders, m.fills, m.trades, m.resets || [], m.draw || {}, m.setups]) : '';
const hasData = (m) => !!m && (m.fills.length || m.trades.length || m.orders.length || (m.resets || []).length || Object.keys(m.fut.pos).length || Object.keys(m.spot.hold).length);
let BASE_SIG = LS.get('desk.me.basesig', null);
const setBase = (sig) => { BASE_SIG = sig; LS.set('desk.me.basesig', sig); };
const setDirty = (v) => { dirty = v; LS.set('desk.me.dirty', v); };
function backup(m, why) {
  if (!hasData(m)) return;
  const B = LS.get('desk.me.backups', []);
  B.push({ t: now(), why, me: m }); while (B.length > 10) B.shift();
  LS.set('desk.me.backups', B);
}
function mergeEqHist(a = [], b = []) {     // 날짜별로 합침: 같은 날은 늦게 기록된 값 + 그날 최저·최고
  const M = new Map();
  for (const r of [...a, ...b]) {
    const x = M.get(r.day);
    if (!x) { M.set(r.day, { ...r }); continue; }
    const y = r.t > x.t ? { ...r } : { ...x };
    const lo = Math.min(x.lo ?? x.spot + x.fut, r.lo ?? r.spot + r.fut), hi = Math.max(x.hi ?? x.spot + x.fut, r.hi ?? r.spot + r.fut);
    M.set(r.day, { ...y, lo, hi });
  }
  return [...M.values()].sort((p, q) => p.t - q.t);
}
function save() {
  ME.updated = now();
  LS.set('desk.me', ME); setDirty(true);
  if (!ghOn()) { setSync('', '이 기기에만 저장'); return; }
  setSync('wait', '저장 대기');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushRemote, 1500);
}
function adoptRemote(r, why) {
  const seen = ME.seen, eq = ME.eqHist;
  ME = migrateMe(r.data); ME_SHA = r.sha;
  ME.eqHist = mergeEqHist(ME.eqHist, eq);
  ME.seen = { ...(ME.seen || {}), ...(seen || {}) };      // 어디까지 확인했는지는 기기마다
  LS.set('desk.me', ME); LS.set('desk.me.sha', ME_SHA); setBase(msig(ME)); setDirty(false);
  if (why) toast(why, 9000);
  renderAll(); drawLines(); paintDrawings(); if (ui.page !== 'trade') renderPage();
}
async function pushRemote() {
  saveTimer = null;
  if (!ghOn()) return;
  if (saving) { saveTimer = setTimeout(pushRemote, 1500); return; }
  saving = true;
  try {
    const mine = msig(ME);
    try { ME_SHA = await mePut(ME_SHA, `desk: 내 계좌 ${new Date().toISOString()}`); }
    catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      const cur = await meGet(), rs = cur.data ? msig(migrateMe(cur.data)) : '';
      if (cur.data && rs !== BASE_SIG && rs !== mine) {          // 저장소의 중요한 내용도 바뀜 → 둘 다 바뀜
        backup(ME, '두 기기에서 동시에 바뀜');
        adoptRemote(cur, '두 기기에서 거의 동시에 기록이 바뀌어 저장소 쪽으로 맞췄어요. 이 기기 기록은 설정 → 보관함에 있어요 (되살리기 가능).');
        saving = false; setSync('ok', `저장소와 맞춤 ${ftime(now())}`); return;
      }
      if (cur.data) ME.eqHist = mergeEqHist(ME.eqHist, migrateMe(cur.data).eqHist);   // 저장소 쪽 일별 기록도 살림
      ME_SHA = await mePut(cur.sha, `desk: 내 계좌 ${new Date().toISOString()}`);
    }
    LS.set('desk.me.sha', ME_SHA); setBase(mine); lastPull = now(); retryMs = 15000;
    if (msig(ME) === mine) setDirty(false); else { saveTimer = setTimeout(pushRemote, 1500); }   // 올리는 사이 또 바뀌었으면 한 번 더
    setSync(dirty ? 'wait' : 'ok', dirty ? '저장 대기' : `저장됨 ${ftime(now())}`);
  } catch (e) {
    setSync('bad', `저장 안 됨 (${e.message}) — ${Math.round(retryMs / 1000)}초 뒤 다시 시도 · 이 기기에는 있음`);
    clearTimeout(saveTimer); saveTimer = setTimeout(pushRemote, retryMs); retryMs = Math.min(retryMs * 2, 120000);
  }
  saving = false;
}
async function pullRemote(quiet) {
  if (!ghOn() || saving || saveTimer) return;
  if (dirty) { pushRemote(); return; }                 // 이 기기에 저장 안 된 변경이 먼저
  try {
    const r = await meGet();
    lastPull = now();
    if (saving || saveTimer || dirty) return;
    if (!r.data) { if (hasData(ME)) save(); else setSync('ok', '저장소 준비'); return; }
    if (BASE_SIG == null) {                               // 이 기기의 첫 연결: 저장소 기록이 있으면 저장소 우선
      if (hasData(r.data) || !hasData(ME)) {
        if (hasData(ME) && msig(ME) !== msig(migrateMe(r.data))) backup(ME, '처음 연결할 때 이 기기에 있던 기록');
        adoptRemote(r, hasData(ME) && !quiet ? '저장소의 계좌 기록을 불러왔어요 (이 기기에 있던 기록은 설정 → 보관함)' : '');
      } else { ME_SHA = r.sha; save(); }                  // 저장소는 비어 있고 이 기기에 기록 → 올림
    } else if (r.sha !== ME_SHA) {
      const changed = msig(migrateMe(r.data)) !== msig(ME);
      adoptRemote(r, changed && quiet ? '다른 기기의 거래를 불러왔어요' : '');
    }
    if (ME.migrated && !(r.data?.schema >= E.SCHEMA)) save();
    setSync('ok', `저장소와 맞춤 ${ftime(now())}`);
  } catch (e) { if (!quiet) setSync('bad', `저장소 읽기 실패 (${e.message})`); }
}
window.addEventListener('online', () => { if (dirty) pushRemote(); else pullRemote(true); });
async function loadShared() {
  if (!ghOn()) return;
  try { CL = (await ghJSON('desk/claude/state.json')).data; } catch { /* 아직 없음 */ }
  try { BRIEFS = (await ghJSON('desk/briefings/index.json')).data || []; } catch { BRIEFS = []; }
  try { MKT = (await ghJSON('desk/market.json')).data; } catch { MKT = null; }
  try { REVIEWS = (await ghJSON('desk/reviews/index.json')).data || []; } catch { REVIEWS = []; }
  try { BOT = await loadBot(); } catch { BOT = null; }
  renderTabs(); renderTop(); if (readOnly()) renderForm();
  renderNav();
  const sig = [MKT?.t, BRIEFS.length, REVIEWS.length, CL?.updated, BOT?.rows.map((r) => r.last.time_kst).join()].join('|');
  if (ui.page !== 'trade' && sig !== ui.sig) renderPage();       // 바뀐 게 있을 때만 다시 그림 (읽던 위치 유지)
  ui.sig = sig;
}
async function loadBot() {
  const accts = ['A', 'B', 'C', 'D', 'H', 'F'], out = { rows: [], rec: [] };
  const parse = (txt) => { const L = txt.replace(/^﻿/, '').trim().split(/\r?\n/); const h = L[0].split(','); return L.slice(1).map((l) => { const v = l.split(','); return Object.fromEntries(h.map((k, i) => [k, v[i]])); }); };
  for (const a of accts) {
    const t = await ghText(`paper/${a}/equity.csv`).catch(() => null);
    if (!t) continue;
    const rows = parse(t); const last = rows[rows.length - 1];
    const tt = (r) => Date.parse(String(r.time_utc || '').replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
    const tr = await ghText(`paper/${a}/trades.csv`).catch(() => null), sells = tr ? parse(tr).filter((x) => x.side === '매도') : [];
    out.rows.push({ a, last, hist: rows.map((r) => +r.equity).filter(isFinite), pts: rows.map((r) => ({ t: tt(r), v: +r.equity })).filter((x) => isFinite(x.t) && isFinite(x.v)),
      n: sells.length, win: sells.length ? sells.filter((x) => +x.pnl > 0).length / sells.length : null });
  }
  const rec = await ghText('paper/reconcile.csv').catch(() => null);
  if (rec) { const rr = parse(rec); const lastT = rr.length ? rr[rr.length - 1].time_kst : null; out.rec = rr.filter((r) => r.time_kst === lastT); }
  return out;
}

// ───────────────────────────── 시세 (바이낸스 현물 · 바이낸스 선물)
const tickGate = {};
function onTick(mkt, s, px) {
  if (!(px > 0)) return;
  const k = mkt + s, t = now();
  if (tickGate[k] && t - tickGate[k] < 800) return;
  tickGate[k] = t;
  if (!caughtUp || document.visibilityState !== 'visible') return;     // 안 보이는 기기는 체결하지 않음 (다시 볼 때 캔들로 확인) → 두 기기가 같은 주문을 겹쳐 체결하지 않게
  const ev = E.processCandle(ME, mkt, s, { t, o: px, h: px, l: px, c: px });
  if (!catchFail) ME.seen[`${mkt}:${s}`] = Math.floor(t / 60000) * 60000;
  if (ev.length) { for (const f of ev) toast(fillMsg(f)); save(); renderForm(); renderTabs(); liqHint(ev); }
}
function liqHint(ev) {     // 강제청산 뒤 지갑이 바닥이면 리셋 안내
  if (!ev.some((f) => f.reason === '강제청산') || Object.keys(ME.fut.pos).length) return;
  if (ME.fut.wallet < ME.init.usdt * 0.2) toast('선물 지갑이 많이 줄었어요. <b>거래 → 설정 → 선물 자금 리셋</b>으로 다시 채울 수 있어요. 거래 기록과 손실은 그대로 남고, 수익률은 리셋 전 손실까지 포함해서 계산돼요.', 12000);
}
function fillMsg(f) {
  const mk = f.mkt === 'fut' ? 'fut' : 'spot';
  return `<b>${f.sym}</b> ${esc(f.side)} <span class="num">${fpx(f.price, mk)}</span> · ${esc(f.reason)}` + (f.pnl != null && f.side.includes('청산') || f.side === '매도' ? ` · <span class="${cls(f.pnl)} num">${fsign(f.pnl, mk)} ${unit(mk)}</span>` : '');
}
let feedOk = { spot: false, fut: false };
function setFeed() {
  const s = $('#feedStat'), a = feedOk.spot, b = feedOk.fut;
  s.querySelector('.dot').className = 'dot ' + (a && b ? 'ok' : a || b ? 'wait' : 'bad');
  s.querySelector('span:last-child').textContent = a && b ? '실시간 시세' : `시세: 현물 ${a ? '○' : '×'} · 선물 ${b ? '○' : '×'}`;
}
let spotSeenWS = 0;
function spotWS(delay = 1000) {
  const st = SYMS.flatMap((x) => { x = x.toLowerCase() + 'usdt'; return [`${x}@ticker`, `${x}@bookTicker`, `${x}@depth10@1000ms`]; });
  let ws;
  try { ws = new WebSocket('wss://stream.binance.com:9443/stream?streams=' + st.join('/')); } catch { return setTimeout(() => spotWS(delay * 2), delay); }
  ws.onopen = () => { feedOk.spot = true; setFeed(); delay = 1000; };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    const d = m.data || {}, str = m.stream || '', s = str.split('@')[0].toUpperCase().replace(/USDT$/, '');
    const q = P.spot[s]; if (!q) return;
    if (str.endsWith('@ticker')) {
      spotSeenWS = now();
      Object.assign(q, { last: +d.c, chg: +d.P / 100, high: +d.h, low: +d.l, vol: +d.q });
      onTick('spot', s, +d.c); paintTick('spot', s);
    } else if (str.endsWith('@bookTicker')) { q.bid = +d.b; q.ask = +d.a; }
    else if (str.includes('@depth')) {
      q.asks = (d.asks || []).map((x) => [+x[0], +x[1]]); q.bids = (d.bids || []).map((x) => [+x[0], +x[1]]);
      if (ui.mkt === 'spot' && ui.sym === s) paintOB();
    }
  };
  ws.onclose = () => { feedOk.spot = false; setFeed(); setTimeout(() => spotWS(Math.min(delay * 2, 30000)), delay); };
  ws.onerror = () => ws.close();
}
// 현물 웹소켓이 조용하면 3초마다 REST 로 시세
async function pollSpot() {
  if (document.visibilityState === 'hidden' || now() - spotSeenWS < 5000) return;
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(SYMS.map((x) => x + 'USDT'))), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    for (const d of await r.json()) {
      const s = d.symbol.replace(/USDT$/, ''), q = P.spot[s]; if (!q) continue;
      Object.assign(q, { last: +d.lastPrice, chg: +d.priceChangePercent / 100, high: +d.highPrice, low: +d.lowPrice, vol: +d.quoteVolume, bid: +d.bidPrice || q.bid, ask: +d.askPrice || q.ask });
      onTick('spot', s, +d.lastPrice); paintTick('spot', s);
    }
    feedOk.spot = true; setFeed();
  } catch { /* 다음에 */ }
}
const lastFundT = {}, lastFundR = {};
let markSeenWS = 0, restFutOk = null;
function handleMark(s, mark, T, r) {
  if (!(mark > 0) || !P.fut[s]) return;
  if (lastFundT[s] && T > lastFundT[s] && caughtUp && ME.fut.pos[s]) setTimeout(() => syncFunding(s), 20000);      // 펀딩 시각이 지남 → 실제 정산 내역으로
  if (T) { lastFundT[s] = T; lastFundR[s] = r; }
  Object.assign(P.fut[s], { mark, funding: r, nextFunding: T || P.fut[s].nextFunding });
  onTick('fut', s, mark); paintTick('fut', s);
}
// 웹소켓의 마크 가격이 안 오는 환경 대비: 2초마다 REST 로 마크 가격 · 펀딩, 20초마다 24시간 변동률
async function pollFut() {
  if (document.visibilityState === 'hidden') return;
  if (now() - markSeenWS > 4000) {
    try {
      const r = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      for (const x of await r.json()) { const s = String(x.symbol).replace(/USDT$/, ''); if (P.fut[s] && x.symbol === s + 'USDT') handleMark(s, +x.markPrice, +x.nextFundingTime, +x.lastFundingRate); }
      restFutOk = true; feedOk.fut = true; setFeed();
    } catch { restFutOk = false; }
  }
}
async function pollFutTicker() {
  for (const s of SYMS) {
    try { const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${s}USDT`); const d = await r.json(); Object.assign(P.fut[s], { last: +d.lastPrice, chg: +d.priceChangePercent / 100, high: +d.highPrice, low: +d.lowPrice, vol: +d.quoteVolume }); paintTick('fut', s); } catch { /* 다음에 */ }
  }
}
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
      markSeenWS = now();
      handleMark(s, +d.p, +d.T, +d.r);
    } else if (str.includes('@bookTicker')) {
      P.fut[s].bid = +d.b; P.fut[s].ask = +d.a;
      if (!(P.fut[s].mark > 0)) paintTick('fut', s);
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
const IV_MS = { '1m': 60000, '5m': FIVE, '1h': 3600000 };
async function binanceCandles(s, from, iv, spot, mark) {     // mark = 선물 마크 가격 캔들 (강제청산 판정용)
  const out = []; let start = from - IV_MS[iv];
  const lim = spot ? 1000 : 1500, base = spot ? 'https://api.binance.com/api/v3/klines' : `https://fapi.binance.com/fapi/v1/${mark ? 'markPriceKlines' : 'klines'}`;
  for (let k = 0; k < 40; k++) {
    const r = await fetch(`${base}?symbol=${s}USDT&interval=${iv}&startTime=${start}&limit=${lim}`);
    if (!r.ok) throw new Error('바이낸스 ' + r.status);
    const a = await r.json();
    if (!a.length) break;
    for (const x of a) out.push({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], dur: x[6] + 1 - x[0] });
    start = a[a.length - 1][0] + 1;
    if (a.length < lim) break;
  }
  return out.filter((c) => c.t + c.dur > from);
}
async function fundingHist(s, from) {      // 실제 정산된 펀딩 (시각·비율·마크 가격)
  const r = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}USDT&startTime=${from + 1}&limit=1000`);
  if (!r.ok) throw new Error('바이낸스 펀딩 ' + r.status);
  return (await r.json()).map((x) => ({ t: x.fundingTime, rate: +x.fundingRate, mark: +x.markPrice || null }));
}
// 놓친 구간: 12시간 안쪽은 1분봉, 5일 안쪽은 5분봉, 그 너머 1시간봉. 선물은 마크 가격 캔들(청산 판정)과 펀딩 내역을 같은 시간축에 넣음
async function catchUpAll() {
  const t = now(), need = { spot: new Set(), fut: new Set() };
  for (const o of ME.orders) if (o.status === 'open') need[o.mkt].add(o.sym);
  for (const s of Object.keys(ME.spot.hold)) need.spot.add(s);
  for (const s of Object.keys(ME.fut.pos)) need.fut.add(s);
  const candles = { spot: {}, fut: {} }, funding = {};
  let n = 0;
  try {
    for (const mkt of ['spot', 'fut']) for (const s of need[mkt]) {
      const from = ME.seen[`${mkt}:${s}`] || ME.updated || t;
      if (t - from < 60000) continue;
      const hrs = (t - from) / 36e5, iv = hrs <= 12 ? '1m' : hrs <= 120 ? '5m' : '1h';
      const cs = await binanceCandles(s, from, iv, mkt === 'spot');
      if (mkt === 'fut') {
        const mk = await binanceCandles(s, from, iv, false, true).catch(() => []), M = new Map(mk.map((x) => [x.t, x]));
        for (const c of cs) { const m = M.get(c.t); if (m) { c.mh = m.h; c.ml = m.l; } }
        if (ME.fut.pos[s]) funding[s] = (await fundingHist(s, Math.max(ME.lastFunding[s] || 0, ME.fut.pos[s].opened))).filter((f) => f.t <= t);
      }
      candles[mkt][s] = cs; n += cs.length;
    }
    const ev = E.catchUp(ME, candles, t, funding);
    for (const mkt of ['spot', 'fut']) for (const s of SYMS) ME.seen[`${mkt}:${s}`] = Math.max(ME.seen[`${mkt}:${s}`] || 0, Math.floor(t / 60000) * 60000);
    caughtUp = true; catchFail = false;
    if (ev.length) {
      const fills = ev.filter((f) => !f.funding), fund = ev.filter((f) => f.funding);
      toast(`<b>화면을 닫아 둔 동안${fills.length ? ` ${fills.length}건 체결` : ''}${fund.length ? ` · 펀딩 ${fund.length}회 (${fsign(fund.reduce((a, f) => a + f.amount, 0))} USDT)` : ''}</b> (캔들 ${n}개 확인)<br>` + fills.slice(0, 6).map(fillMsg).join('<br>'), 12000);
      liqHint(fills); save();
    } else LS.set('desk.me', ME);      // 바뀐 게 없으면 저장소에 쓰지 않음
  } catch (e) {
    caughtUp = true; catchFail = true;
    toast(`놓친 구간 확인이 잠시 실패했어요 (${esc(e.message)}) — 1분 뒤 다시 확인해요. 그동안 실시간 체결은 그대로 반영돼요.`, 7000);
    setTimeout(() => { if (catchFail) { caughtUp = false; catchUpAll(); } }, 60000);
  }
  renderTabs(); renderForm();
}
// 실시간 펀딩: 정산 시각이 지나면 잠시 뒤 실제 정산 내역(비율·마크 가격)으로 반영
async function syncFunding(s) {
  const p = ME.fut.pos[s]; if (!p) return;
  try {
    const fs = (await fundingHist(s, Math.max(ME.lastFunding[s] || 0, p.opened))).filter((f) => f.t <= now());
    let sum = 0; for (const f of fs) { const a = E.applyFunding(ME, s, f.t, f.rate, f.mark || p.entry); if (a) sum += a; }
    if (fs.length && sum) { toast(`${s} 펀딩비 <span class="num ${cls(sum)}">${fsign(sum)} USDT</span>`); save(); renderTop(); renderTabs(); }
  } catch { /* 다음 확인 때 (catchUpAll) */ }
}
async function loadBtcFilter() {     // BTC 4시간봉 종가 > 직전 300봉(50일) 평균 (바이낸스 현물 BTCUSDT, 마감된 봉만)
  try {
    const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=302');
    if (!r.ok) throw new Error(r.status);
    const closed = (await r.json()).filter((x) => x[6] < now()).map((x) => +x[4]);
    const last = closed.slice(-300), sma = last.reduce((a, x) => a + x, 0) / last.length, c = last[last.length - 1];
    btcFilter = { on: c > sma, gap: c / sma - 1, src: '바이낸스' };
  } catch {
    try { const m = ghOn() ? (await ghJSON('desk/market.json')).data : null; btcFilter = m?.btc_filter ? { on: m.btc_filter.on, gap: m.btc_filter.gap, src: '봇 스냅샷' } : null; } catch { btcFilter = null; }
  }
  renderTop();
}

// ───────────────────────────── 차트
let tvLoading = null;
function loadTV() {       // 트레이딩뷰 스크립트는 이 보기를 고를 때만 불러옴 (계속 켜 두는 외부 스크립트 줄이기)
  if (typeof TradingView !== 'undefined') return Promise.resolve();
  return tvLoading ||= new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://s3.tradingview.com/tv.js'; sc.onload = res; sc.onerror = () => { tvLoading = null; rej(); }; document.head.appendChild(sc); });
}
async function mountTV() {
  const box = $('#tv'); box.innerHTML = '<div class="empty">트레이딩뷰 불러오는 중…</div>';
  try { await loadTV(); } catch { /* 아래에서 안내 */ }
  if (cfg.chart !== 'tv') return;
  box.innerHTML = '';
  if (typeof TradingView === 'undefined') { box.innerHTML = '<div class="empty">트레이딩뷰 차트를 불러오지 못했어요 (광고 차단기·네트워크 확인)</div>'; return; }
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  new TradingView.widget({
    autosize: true, container_id: 'tv', symbol: ui.mkt === 'fut' ? `BINANCE:${ui.sym}USDT.P` : `BINANCE:${ui.sym}USDT`,
    interval: cfg.interval, timezone: 'Asia/Seoul', theme: dark ? 'dark' : 'light', style: '1', locale: 'kr',
    allow_symbol_change: true, hide_side_toolbar: false, withdateranges: true, studies: cfg.studies, save_image: false,
  });
}

// ───────────────────────────── 포지션 차트 (진입가 · 손절 · 익절 · 청산가 · 대기 주문 · 체결 표시)
const LC = window.LightweightCharts;
const KSTS = 9 * 3600;
const IVS = [['15', '15분'], ['60', '1시간'], ['240', '4시간'], ['D', '일']];
const ivSec = (iv) => iv === 'D' ? 86400 : +iv * 60;
const cssv = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
let mc = null;
const SUBS = [['', '보조 없음'], ['rsi', 'RSI'], ['macd', 'MACD']];
const DRAW_C = '#9b7cf0';
function renderChartBar() {
  const my = cfg.chart === 'my', I = cfg.myInd;
  $('#chartBar').innerHTML = `<div class="seg" id="chartSeg"><button data-c="my" class="${my ? 'on' : ''}">포지션 차트</button><button data-c="tv" class="${!my ? 'on' : ''}">트레이딩뷰</button></div>
    ${my ? `<div class="seg" id="ivSeg">${IVS.map(([k, v]) => `<button data-iv="${k}" class="${cfg.myIv === k ? 'on' : ''}">${v}</button>`).join('')}</div>
    <label><input type="checkbox" id="indMa" ${I.ma ? 'checked' : ''}>이평 20</label><label><input type="checkbox" id="indBb" ${I.bb ? 'checked' : ''}>볼린저</label><label><input type="checkbox" id="indVol" ${I.vol !== false ? 'checked' : ''}>거래량</label>
    <div class="seg" id="subSeg">${SUBS.map(([k, v]) => `<button data-sub="${k}" class="${(I.sub || '') === k ? 'on' : ''}">${v}</button>`).join('')}</div>
    <div class="seg" id="drawSeg"><button data-d="h" class="drawbtn ${ui.draw === 'h' ? 'on' : ''}" title="차트를 누른 가격에 수평선">─ 수평선</button><button data-d="t" class="drawbtn ${ui.draw === 't' ? 'on' : ''}" title="두 점을 눌러 추세선 (오른쪽으로 연장)">╱ 추세선</button><button data-d="undo" title="마지막 선 지우기">↶</button><button data-d="clear" title="이 종목의 내 선 모두 지우기">지우기</button></div>
    <span class="note" id="chartNote">${ui.draw === 'h' ? '수평선을 그을 가격을 누르세요' : ui.draw === 't' ? (ui.drawA ? '두 번째 점을 누르세요' : '추세선 첫 점을 누르세요') : CHART_TIP()}</span>` : '<span class="note">지표·그리기는 트레이딩뷰 · 내 진입선·내 선은 포지션 차트에서</span>'}`;
  $$('#chartSeg button').forEach((b) => b.onclick = () => { cfg.chart = b.dataset.c; saveCfg(); mountChart(); });
  $$('#ivSeg button').forEach((b) => b.onclick = () => { cfg.myIv = b.dataset.iv; saveCfg(); mountChart(); });
  $$('#subSeg button').forEach((b) => b.onclick = () => { cfg.myInd.sub = b.dataset.sub; saveCfg(); mountChart(); });
  $$('#drawSeg button').forEach((b) => b.onclick = () => {
    const d = b.dataset.d, list = (ME.draw ||= {})[ui.sym] ||= [];
    if (d === 'undo') { if (list.length) { list.pop(); save(); paintDrawings(); } else toast('지울 선이 없어요'); return; }
    if (d === 'clear') { if (list.length) { ME.draw[ui.sym] = []; save(); paintDrawings(); toast(`${ui.sym} 의 내 선을 모두 지웠어요`); } return; }
    ui.draw = ui.draw === d ? null : d; ui.drawA = null; renderChartBar();
  });
  if ($('#indMa')) {
    $('#indMa').onchange = (e) => { cfg.myInd.ma = e.target.checked; saveCfg(); calcInd(); };
    $('#indBb').onchange = (e) => { cfg.myInd.bb = e.target.checked; saveCfg(); calcInd(); };
    $('#indVol').onchange = (e) => { cfg.myInd.vol = e.target.checked; saveCfg(); mountChart(); };
  }
}
function mountChart() {
  renderChartBar();
  if (cfg.chart === 'tv') { if (mc) { mc.chart.remove(); mc = null; } $('#mychart').hidden = true; $('#tv').hidden = false; mountTV(); return; }
  $('#tv').hidden = true; $('#tv').innerHTML = ''; $('#mychart').hidden = false;
  if (mc) { mc.chart.remove(); mc = null; }
  const el = $('#mychart'); el.innerHTML = '';
  if (!LC) { el.innerHTML = '<div class="empty">차트 라이브러리를 불러오지 못했어요 (네트워크·광고 차단기 확인)</div>'; return; }
  const up = cssv('--up'), dn = cssv('--dn'), mk = ui.mkt;
  const chart = LC.createChart(el, {
    autoSize: true, layout: { background: { type: 'solid', color: cssv('--panel') }, textColor: cssv('--mute'), fontFamily: cssv('--num'), fontSize: 11 },
    grid: { vertLines: { color: cssv('--line') }, horzLines: { color: cssv('--line') } }, rightPriceScale: { borderColor: cssv('--line') },
    timeScale: { borderColor: cssv('--line'), timeVisible: true, secondsVisible: false, rightOffset: 6 }, crosshair: { mode: 0 }, localization: { locale: 'ko-KR' },
  });
  const cs = chart.addSeries(LC.CandlestickSeries, { upColor: up, downColor: dn, borderVisible: false, wickUpColor: up, wickDownColor: dn, priceFormat: { type: 'custom', formatter: (p) => fpx(p, mk), minMove: 1e-8 } });
  const sub = cfg.myInd.sub || '', showVol = cfg.myInd.vol !== false;
  // 위 칸 = 캔들 + 거래량(아래쪽 겹침), 보조지표는 아래 칸 (자기 가격 축)
  chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: showVol ? 0.16 : 0.04 } });
  const vs = chart.addSeries(LC.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false, visible: showVol });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
  const line = (color, style, pane = 0) => chart.addSeries(LC.LineSeries, { color, lineWidth: 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, pane);
  mc = { chart, cs, vs, mk: LC.createSeriesMarkers(cs, []), ma: line(cssv('--accent'), 0), bbU: line(cssv('--mute'), 2), bbL: line(cssv('--mute'), 2), lines: [], bars: [], key: `${mk}:${ui.sym}:${cfg.myIv}`, indT: 0, dLines: [], dSeries: [] };
  if (sub) {
    const fmt = { type: 'price', precision: sub === 'rsi' ? 1 : 4, minMove: sub === 'rsi' ? 0.1 : 0.0001 };
    mc.sub = { k: sub, a: chart.addSeries(LC.LineSeries, { color: cssv('--accent'), lineWidth: 1, priceLineVisible: false, lastValueVisible: true, priceFormat: fmt }, 1) };
    if (sub === 'macd') { mc.sub.b = line(cssv('--mute'), 0, 1); mc.sub.h = chart.addSeries(LC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: fmt }, 1); }
    if (sub === 'rsi') for (const v of [70, 30]) mc.sub.a.createPriceLine({ price: v, color: cssv('--mute'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
    const P = chart.panes(); if (P.length > 1) { P[0].setStretchFactor(3); P[1].setStretchFactor(1); }
  }
  chart.subscribeClick((p) => {
    if (!p.point || !mc || (p.paneIndex ?? 0) > 0) return;      // 보조지표 칸을 누른 건 무시
    const px = mc.cs.coordinateToPrice(p.point.y); if (!(px > 0)) return;
    if (ui.draw === 'h') { addDrawing({ k: 'h', p: px }); ui.draw = null; renderChartBar(); return; }
    if (ui.draw === 't') {
      let ct = p.time ?? mc.chart.timeScale().coordinateToTime(p.point.x);
      if (ct == null && mc.bars.length) ct = mc.bars[mc.bars.length - 1].t + KSTS;
      if (ct == null) return;
      const t = ct - KSTS;
      if (!ui.drawA) { ui.drawA = [t, px]; renderChartBar(); return; }
      if (Math.abs(t - ui.drawA[0]) < ivSec(cfg.myIv)) { toast('같은 봉이에요 — 다른 봉을 눌러 주세요'); return; }
      addDrawing({ k: 't', a: ui.drawA, b: [t, px] }); ui.draw = null; ui.drawA = null; renderChartBar(); return;
    }
  });      // 차트를 눌러 가격 넣기는 없앰 (사용자 요청 2026-10-25) — 가격은 호가창으로만
  loadBars();
}
const BIV = { 15: '15m', 60: '1h', 240: '4h', D: '1d' };
async function binanceBars(s, iv, spot) {
  const r = await fetch(spot ? `https://api.binance.com/api/v3/klines?symbol=${s}USDT&interval=${BIV[iv]}&limit=400` : `https://fapi.binance.com/fapi/v1/klines?symbol=${s}USDT&interval=${BIV[iv]}&limit=400`);
  if (!r.ok) throw new Error('바이낸스 ' + r.status);
  return (await r.json()).map((x) => ({ t: x[0] / 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[7] }));
}
async function loadBars() {
  if (!mc) return;
  const key = mc.key, [mk, s, iv] = key.split(':');
  let bars = [], note = CHART_TIP();
  try { bars = await binanceBars(s, iv, mk === 'spot'); }
  catch { note = '과거 시세를 불러오지 못했어요 — 30초 뒤 다시 시도'; setTimeout(() => { if (mc && mc.key === key) loadBars(); }, 30000); }
  if (!mc || mc.key !== key) return;
  mc.bars = bars;
  mc.cs.setData(bars.map((b) => ({ time: b.t + KSTS, open: b.o, high: b.h, low: b.l, close: b.c })));
  const ub = cssv('--upbg'), db = cssv('--dnbg');
  mc.vs.setData(bars.map((b) => ({ time: b.t + KSTS, value: b.v, color: b.c >= b.o ? ub : db })));
  if ($('#chartNote')) $('#chartNote').textContent = note;
  calcInd(); drawLines(); paintDrawings(); mc.chart.timeScale().scrollToRealTime();
}
function calcInd() {
  if (!mc) return;
  const B = mc.bars, n = 20, ma = [], up = [], lo = [];
  for (let i = n - 1; i < B.length; i++) {
    let sm = 0, sq = 0; for (let k = i - n + 1; k <= i; k++) { sm += B[k].c; sq += B[k].c * B[k].c; }
    const m = sm / n, sd = Math.sqrt(Math.max(0, sq / n - m * m)), time = B[i].t + KSTS;
    ma.push({ time, value: m }); up.push({ time, value: m + 2 * sd }); lo.push({ time, value: m - 2 * sd });
  }
  mc.ma.setData(cfg.myInd.ma ? ma : []); mc.bbU.setData(cfg.myInd.bb ? up : []); mc.bbL.setData(cfg.myInd.bb ? lo : []);
  if (mc.sub) {
    const C = B.map((b) => b.c), T = B.map((b) => b.t + KSTS);
    if (mc.sub.k === 'rsi') mc.sub.a.setData(rsi(C, 14).map((v, i) => v == null ? null : { time: T[i], value: v }).filter(Boolean));
    else {
      const e12 = ema(C, 12), e26 = ema(C, 26), m = C.map((_, i) => e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
      const sig = ema(m, 9), UP = cssv('--upbg'), DN = cssv('--dnbg');
      mc.sub.a.setData(m.map((v, i) => v == null ? null : { time: T[i], value: v }).filter(Boolean));
      mc.sub.b.setData(sig.map((v, i) => v == null ? null : { time: T[i], value: v }).filter(Boolean));
      mc.sub.h.setData(m.map((v, i) => v == null || sig[i] == null ? null : { time: T[i], value: v - sig[i], color: v - sig[i] >= 0 ? UP : DN }).filter(Boolean));
    }
  }
}
// 보조지표 계산 (값이 없는 앞부분은 null)
function ema(a, n) {
  const out = new Array(a.length).fill(null), k = 2 / (n + 1); let e = null, cnt = 0, sum = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]; if (v == null) continue;
    if (e == null) { sum += v; cnt++; if (cnt === n) { e = sum / n; out[i] = e; } continue; }
    e = v * k + e * (1 - k); out[i] = e;
  }
  return out;
}
function rsi(c, n) {      // 와일더 RSI
  const out = new Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
// 내가 그린 선 (종목별, 내 계좌 기록에 저장 → 다른 기기에서도 보임)
function addDrawing(d) { ((ME.draw ||= {})[ui.sym] ||= []).push(d); save(); paintDrawings(); }
function paintDrawings() {
  if (!mc) return;
  for (const l of mc.dLines) mc.cs.removePriceLine(l);
  for (const x of mc.dSeries) mc.chart.removeSeries(x);
  mc.dLines = []; mc.dSeries = [];
  const list = (ME.draw && ME.draw[ui.sym]) || [], B = mc.bars;
  if (!B.length) return;
  const sec = ivSec(cfg.myIv), first = B[0].t, last = B[B.length - 1].t, snap = (t) => Math.floor(t / sec) * sec;
  for (const d of list) {
    if (d.k === 'h') { mc.dLines.push(mc.cs.createPriceLine({ price: d.p, color: DRAW_C, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '내 선' })); continue; }
    let [ta, pa] = d.a, [tb, pb] = d.b; if (ta > tb) [ta, pa, tb, pb] = [tb, pb, ta, pa];
    ta = snap(ta); tb = snap(tb); if (ta === tb) continue;
    const at = (t) => pa + (pb - pa) * (t - ta) / (tb - ta);
    const t0 = Math.max(ta, first), t1 = Math.max(last, tb);
    if (t1 <= t0) continue;
    const pts = [[t0, at(t0)], ...(tb > t0 && tb < t1 ? [[tb, pb]] : []), [t1, at(t1)]];
    const ser = mc.chart.addSeries(LC.LineSeries, { color: DRAW_C, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null });
    ser.setData(pts.map(([t, v]) => ({ time: t + KSTS, value: v })));
    mc.dSeries.push(ser);
  }
}
function chartTick(mkt, s, px) {
  if (!mc || cfg.chart !== 'my' || mkt !== ui.mkt || s !== ui.sym || !mc.bars.length || !(px > 0)) return;
  const sec = ivSec(cfg.myIv), b0 = Math.floor(now() / 1000 / sec) * sec, L = mc.bars[mc.bars.length - 1];
  if (b0 === L.t) { L.h = Math.max(L.h, px); L.l = Math.min(L.l, px); L.c = px; }
  else if (b0 > L.t) mc.bars.push({ t: b0, o: px, h: px, l: px, c: px, v: 0 });
  else return;
  const X = mc.bars[mc.bars.length - 1];
  mc.cs.update({ time: X.t + KSTS, open: X.o, high: X.h, low: X.l, close: X.c });
  if (now() - mc.indT > 3000) { mc.indT = now(); calcInd(); }
}
function drawLines() {
  if (!mc) return;
  for (const l of mc.lines) mc.cs.removePriceLine(l);
  mc.lines = [];
  const st = view(), mk = ui.mkt, s = ui.sym;
  if (!st) { mc.mk.setMarkers([]); return; }
  const add = (price, color, title, style = 2, w = 1) => { if (price > 0) mc.lines.push(mc.cs.createPriceLine({ price, color, lineWidth: w, lineStyle: style, axisLabelVisible: true, title })); };
  const A = cssv('--accent'), OK = cssv('--ok'), W = cssv('--sl'), UP = cssv('--up'), DN = cssv('--dn'), M = cssv('--mute');
  if (mk === 'fut' && st.fut.pos[s]) {
    const p = st.fut.pos[s];
    add(p.entry, A, `${p.side === 'long' ? '롱' : '숏'} ${p.lev.toFixed(1)}x 진입`, 0, 2); add(p.sl, W, '손절'); add(p.tp, OK, '익절'); add(E.liqPrice(p), p.side === 'long' ? DN : UP, '청산가', 1);
  }
  if (mk === 'spot' && st.spot.hold[s]) { const h = st.spot.hold[s]; add(h.avg, A, '평균 단가', 0, 2); add(h.sl, W, '손절'); add(h.tp, OK, '익절'); }
  for (const o of st.orders) if (o.status === 'open' && o.mkt === mk && o.sym === s) add(o.price, M, `${typeTxt(o)} ${sideTxt(o)}${o.lev ? ' ' + o.lev + 'x' : ''}`, 1);
  const sec = ivSec(cfg.myIv), t0 = mc.bars.length ? mc.bars[0].t : 0;
  const mks = st.fills.filter((f) => f.mkt === mk && f.sym === s && f.t / 1000 >= t0).map((f) => {
    const upish = ['매수', '롱 진입', '숏 청산'].includes(f.side);
    return { time: Math.floor(f.t / 1000 / sec) * sec + KSTS, position: upish ? 'belowBar' : 'aboveBar', color: upish ? UP : DN, shape: upish ? 'arrowUp' : 'arrowDown', text: f.side.replace(' 진입', '').replace('강제청산', '청산!') };
  }).sort((a, b) => a.time - b.time);
  mc.mk.setMarkers(mks);
}
function tickSize(px) {     // 바이낸스 호가 단위 (대략): 선물 BTC 0.1 · 현물 0.01 (예전 업비트 원화 단위표가 남아 있어 호가를 눌러도 반올림돼 안 바뀌던 문제 수정)
  if (ui.mkt === 'fut') return px >= 1000 ? 0.1 : px >= 10 ? 0.01 : px >= 1 ? 0.0001 : 0.00001;
  return px >= 10 ? 0.01 : px >= 1 ? 0.0001 : px >= 0.01 ? 0.00001 : 1e-8;
}
function setPriceField(px, exact) {     // exact = 호가창에서 누른 가격 (이미 호가 단위라 그대로)
  if (exact) {
    if (ui.otype === 'market') { ui.otype = 'limit'; renderForm(); }
    const f = $('#fPrice'); if (f) { f.value = String(px); updateCalc(); if (!isPhone()) f.focus(); flash(f); }
    return;
  }
  const t = tickSize(px), v = Math.round(px / t) * t, d = Math.max(0, -Math.floor(Math.log10(t) + 1e-9));
  if (ui.otype === 'market') { ui.otype = 'limit'; renderForm(); }
  const f = $('#fPrice'); if (f) { f.value = v.toFixed(d); updateCalc(); if (!isPhone()) f.focus(); flash(f); }
}
function flash(el) {     // 값이 들어갔다는 표시 (키보드 없이도 알 수 있게)
  const box = el.closest('.field') || el; box.style.transition = 'box-shadow .15s'; box.style.boxShadow = '0 0 0 2px var(--accent)';
  setTimeout(() => { box.style.boxShadow = ''; }, 350);
}

// ───────────────────────────── 위쪽 띠 · 종목
function renderTop() {
  const st = view();
  if (!st) { $('#eqSpot').textContent = '–'; $('#eqFut').textContent = '–'; }
  else {
    const eq = E.equity(st, prices());
    // % = 총 손익 ÷ 처음 자금 (자금 리셋으로 채운 돈은 손익에서 뺌 → 리셋해도 성적은 이어짐)
    const i0 = st.init.spot ?? st.init.krw, pS = eq.spot - E.deposited(st, 'spot'), pF = eq.fut - E.deposited(st, 'fut');
    const nr = (m) => (st.resets || []).filter((r) => r.mkt === m).length, rs = (m) => nr(m) ? ` <span class="pill" title="자금 리셋 ${nr(m)}회 — 수익률은 리셋 전 손실까지 포함">리셋 ${nr(m)}</span>` : '';
    $('#eqSpot').innerHTML = `${fmoney(eq.spot)} <span class="${cls(pS)}" style="font-size:12px">${fpct(pS / i0)}</span>${rs('spot')}`;
    $('#eqFut').innerHTML = `${fmoney(eq.fut)} <span class="${cls(pF)}" style="font-size:12px">${fpct(pF / st.init.usdt)}</span>${rs('fut')}`;
  }
  $('#btcF').innerHTML = btcFilter ? `<span class="${btcFilter.on ? 'up' : 'dn'}">${btcFilter.on ? '켜짐' : '꺼짐'}</span> <span class="num mute" style="font-size:12px">${fpct(btcFilter.gap, 1)}</span>` : '–';
  $('#btcF').title = btcFilter ? `BTC 4시간봉 종가 vs 50일 평균 · ${btcFilter.src}` : '';
}
function renderChips() {
  $('#chips').innerHTML = SYMS.map((s) => `<button class="chip ${s === ui.sym ? 'on' : ''}" data-sym="${s}"><b>${s}</b><span class="num" data-px="${s}">–</span><span class="num" data-chg="${s}"></span></button>`).join('');
  $$('#chips .chip').forEach((b) => b.onclick = () => { ui.sym = b.dataset.sym; renderChips(); mountChart(); renderForm(); paintOB(); });
  for (const s of SYMS) paintTick(ui.mkt, s);
}
let topTimer = 0, tabTimer = 0;
function paintTick(mkt, s) {
  if (mkt === ui.mkt) {
    const q = P[mkt][s], px = mkt === 'fut' ? futPx(q) : q.last;
    const a = $(`[data-px="${s}"]`), b = $(`[data-chg="${s}"]`);
    if (a) a.textContent = fpx(px, mkt);
    if (b && q.chg != null) { b.textContent = fpct(q.chg); b.className = 'num ' + cls(q.chg); }
    if (s === ui.sym) { updateCalc(); chartTick(mkt, s, px); }
  }
  const t = now();
  if (t - topTimer > 1000) { topTimer = t; renderTop(); }
  if (t - tabTimer > 1500 && ui.tab === 'pos') { tabTimer = t; renderTabBody(); }
}
function paintOB() {
  const q = P[ui.mkt][ui.sym], mk = ui.mkt;
  $('#obSym').textContent = `${ui.sym} · ${mk === 'fut' ? 'USDT 무기한' : 'USDT 현물'}`;
  const asks = (q.asks || []).slice(0, 10), bids = (q.bids || []).slice(0, 10);
  const mx = Math.max(1e-12, ...asks.map((x) => x[1]), ...bids.map((x) => x[1]));
  const row = (x, side) => `<tr data-obpx="${x[0]}" title="이 가격으로 지정가"><td><span class="num ${side === 'a' ? 'dn' : 'up'}">${fpx(x[0], mk)}</span></td><td><i class="bar-${side}" style="width:${(x[1] / mx * 100).toFixed(1)}%"></i><span class="num">${fqty(x[1])}</span></td></tr>`;
  const px = mk === 'fut' ? futPx(q) : q.last;
  $('#ob').innerHTML = `<table>${asks.slice().reverse().map((x) => row(x, 'a')).join('')}</table>
    <div class="mid num ${cls(q.chg)}">${fpx(px, mk)} <span style="font-size:12px">${fpct(q.chg)}</span>${mk === 'fut' && q.funding != null ? `<div class="mute" style="font-size:11px">펀딩 ${fpct(q.funding, 4)} · ${ftime(q.nextFunding)}</div>` : ''}</div>
    <table>${bids.map((x) => row(x, 'b')).join('')}</table>`;
  const mini = $('#obMini');
  if (mini && mini.offsetParent) {
    const N = 7, mr = (x, side) => `<tr data-obpx="${x[0]}"><td><span class="num ${side === 'a' ? 'dn' : 'up'}">${fpx(x[0], mk)}</span></td><td class="num">${fqty(x[1])}</td></tr>`;
    mini.innerHTML = `<table>${asks.slice(0, N).reverse().map((x) => mr(x, 'a')).join('')}</table>
      <div class="mid num ${cls(q.chg)}">${fpx(px, mk)}<div style="font-size:11px">${fpct(q.chg)}</div></div>
      <table>${bids.slice(0, N).map((x) => mr(x, 'b')).join('')}</table>${asks.length ? '' : '<div class="note" style="padding:8px">호가 연결 중…</div>'}`;
  }
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
  const amtUnit = isFut || buy ? 'USDT' : s;
  const avail = isFut ? `가능 ${fmoney(ME.fut.wallet)} USDT` : buy ? `가능 ${fmoney(ME.spot.cash)} USDT` : `보유 ${fqty(holdQty)} ${s}`;
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
    <div class="note">${isFut ? '수수료 시장가 0.05% · 지정가 0.02% · 유지증거금 0.5% · 8시간마다 펀딩비' : '수수료 0.1% (바이낸스 현물) · 최소 주문 5 USDT'}</div></div>`;
  $$('#sideSeg button').forEach((b) => b.onclick = () => { ui.side = b.dataset.side; renderForm(); });
  $$('#typeSeg button').forEach((b) => b.onclick = () => { ui.otype = b.dataset.t; renderForm(); });
  const lev = $('#fLev'), levN = $('#fLevN');
  if (lev) { lev.oninput = () => { ui.lev = +lev.value; levN.value = ui.lev; $('#levTxt').textContent = ui.lev + 'x'; updateCalc(); }; levN.oninput = () => { ui.lev = Math.max(1, Math.min(125, +levN.value || 1)); lev.value = Math.min(100, ui.lev); $('#levTxt').textContent = ui.lev + 'x'; updateCalc(); }; }
  $$('.pcts button').forEach((b) => b.onclick = () => {
    const p = +b.dataset.p / 100;
    const v = isFut ? ME.fut.wallet * p / (1 + ui.lev * E.FEE.futTaker) : buy ? ME.spot.cash * p : holdQty * p;
    $('#fAmt').value = isFut || buy ? Math.floor(v * 100) / 100 : +v.toPrecision(8);
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
    L.push(['예상 수량', `${fqty(qty)} ${s}`], ['수수료', `${fmoney((amt || 0) * E.FEE.spot)} USDT`]);
    if (sl && qty) { const risk = (px - sl) * qty; L.push(['손절 시 손실', `<span class="dn">−${fmoney(risk)} USDT (${fpct(-risk / Math.max(1, E.equity(ME, prices()).spot), 1)})</span>`]); if (tp) L.push(['손익비', ((tp - px) / (px - sl)).toFixed(2)]); }
  } else {
    const h = ME.spot.hold[s];
    L.push(['예상 금액', `${fmoney((amt || 0) * (px || 0) * (1 - E.FEE.spot))} USDT`]);
    if (h) L.push(['예상 손익', `<span class="${cls((px - h.avg))}">${fsign((amt || 0) * ((px || 0) * (1 - E.FEE.spot) - h.avg))} USDT</span>`]);
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
    if (mk === 'spot') { if (side === 'buy') o.quote = amt; else o.qty = amt; } else { o.margin = amt; o.lev = ui.lev; }
    E.placeOrder(ME, o, t);
    toast(`${s} ${sideTxt(o)} ${typeTxt(o)} 주문 접수 · ${fpx(price, mk)}`);
  }
  save(); renderForm(); renderTabs(); renderTop();
}

// ───────────────────────────── 아래 탭
const TABS = [['pos', '포지션'], ['ord', '대기 주문'], ['fill', '체결'], ['jr', '매매 일지'], ['stat', '통계'], ['set', '설정']];
function renderTabs() {
  const st = view();
  const cnt = { pos: st ? Object.keys(st.spot.hold).length + Object.keys(st.fut.pos).length : 0, ord: st ? st.orders.filter((o) => o.status === 'open').length : 0 };
  $('#tabs').innerHTML = TABS.map(([k, v]) => `<button data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${v}${cnt[k] ? `<span class="cnt num">${cnt[k]}</span>` : ''}</button>`).join('');
  $$('#tabs button').forEach((b) => b.onclick = () => { ui.tab = b.dataset.tab; renderTabs(); });
  renderTabBody(); drawLines();
}
function renderTabBody() {
  const st = view(), body = $('#tabBody');
  const needSt = ['pos', 'ord', 'fill', 'jr', 'stat'].includes(ui.tab);
  if (needSt && !st) { body.innerHTML = '<div class="empty">Claude 계좌 기록이 아직 없어요. 설정에서 GitHub 를 연결하면 불러와요.</div>'; return; }
  ({ pos: tabPos, ord: tabOrd, fill: tabFill, jr: tabJr, stat: tabStat, set: tabSet })[ui.tab](body, st);
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
    <td class="num">${fpx(o.price, o.mkt)}</td><td class="num">${(o.quote ?? o.krw) ? fmoney(o.quote ?? o.krw) + ' USDT' : o.margin ? fmoney(o.margin) + ' USDT' + (o.lev ? ` · ${o.lev}x` : '') : fqty(o.qty)}</td>
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
  const inl = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  for (const l of lines) {
    if (/^\|/.test(l)) { if (/^\|[\s:|-]+\|$/.test(l)) continue; if (!inT) { out += '<div class="tw"><table>'; inT = true; } out += '<tr>' + l.split('|').slice(1, -1).map((c) => `<td>${inl(c.trim())}</td>`).join('') + '</tr>'; continue; }
    if (inT) { out += '</table></div>'; inT = false; }
    if (/^\s*[-*] /.test(l)) { if (!inL) { out += '<ul>'; inL = true; } out += `<li>${inl(l.replace(/^\s*[-*] /, ''))}</li>`; continue; }
    if (inL) { out += '</ul>'; inL = false; }
    const m = l.match(/^(#{1,3}) (.*)/);
    if (m) out += `<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`; else if (l.trim()) out += `<p>${inl(l)}</p>`;
  }
  return out + (inT ? '</table></div>' : '') + (inL ? '</ul>' : '');
}
function tabBot(body) {
  if (!ghOn()) { body.innerHTML = '<div class="empty">가상매매 봇(tsb7-paper) 기록을 읽으려면 설정에서 GitHub 를 연결해 주세요.</div>'; return; }
  if (!BOT || !BOT.rows.length) { body.innerHTML = '<div class="empty">봇 기록을 찾지 못했어요 (paper/*/equity.csv).</div>'; return; }
  const NAME = { A: 'TSB7 1/6 (현행)', B: 'TSB7 1/5 + 노출 상한 80%', C: 'TSB7 1/4', D: 'TSB7 + BB20 1/8', H: 'BTC 보유', F: 'BTC 50일선 필터' };
  const rec = Object.fromEntries((BOT.rec || []).map((r) => [r.acct, r]));
  body.innerHTML = `<table class="t"><thead><tr><th class="l">계좌</th><th>평가액 (원)</th><th>수익률</th><th>제때 실행했다면</th><th>놓친 거래</th><th>보유</th><th class="l">BTC 필터</th><th class="l">갱신</th><th>추이</th></tr></thead><tbody>${BOT.rows.map((r) => {
    const x = r.last, c = rec[r.a];
    return `<tr><td class="l"><b>${r.a}</b> <span class="mute">${NAME[r.a] || ''}</span></td><td class="num">${fkrw(+x.equity)}</td><td class="num ${cls(+x.ret)}">${fpct(+x.ret)}</td>
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
      <div class="lbl">종목 (바이낸스 USDT 마켓 이름, 쉼표로 구분 · 바꾸면 새로고침)</div><div class="row"><div class="field" style="flex:1"><input id="sSyms" value="${esc(SYMS.join(', '))}" style="text-align:left"></div><button class="btn2" id="sSymSave">적용</button></div>
      <div class="lbl">셋업 목록 (쉼표로 구분)</div><textarea id="sSetups">${esc(ME.setups.join(', '))}</textarea>
      <div class="row"><div style="flex:1"><div class="lbl">현물 시작 자금 (USDT)</div><div class="field"><input id="sKrw" value="${ME.init.spot ?? 10000}"></div></div><div style="flex:1"><div class="lbl">선물 시작 자금 (USDT)</div><div class="field"><input id="sUsdt" value="${ME.init.usdt}"></div></div></div>
      <div class="row"><button class="btn2" id="sSetSave">저장</button><button class="btn2" id="sExport">기록 내려받기 (JSON)</button></div>
      <div class="lbl">자금 리셋 — 청산 등으로 잔고가 줄었을 때 시작 자금까지 다시 채워요. 거래·일지·손실 기록은 그대로 남고, 채운 돈은 '추가 입금'으로 기록돼 수익률은 리셋 전 손실까지 포함해서 계산돼요.</div>
      <div class="row"><button class="btn2" id="sTopSpot">현물 자금 리셋</button><button class="btn2" id="sTopFut">선물 자금 리셋</button></div>
      ${(ME.resets || []).length ? `<div class="note">${ME.resets.slice(-6).reverse().map((r) => `${ftime(r.t)} ${r.mkt === 'fut' ? '선물' : '현물'} ${fmoney(r.before)} → ${fmoney(r.after)} USDT${r.liq ? ` · 그 사이 강제청산 ${r.liq}회` : ''}${r.why ? ' · ' + esc(r.why) : ''}`).join('<br>')}${ME.resets.length > 6 ? `<br>… 모두 ${ME.resets.length}회` : ''}</div>` : ''}
      ${(() => { const B = LS.get('desk.me.backups', []); return B.length ? `<div class="lbl">보관함 — 기기 사이 충돌·처음 연결 때 덮이지 않게 따로 둔 이 기기의 기록 (최근 10개)</div>` + B.slice().reverse().map((b, i) => `<div class="row note"><span style="flex:1">${ftime(b.t)} · ${esc(b.why)} · 체결 ${b.me.fills.length}건 · 선물 ${fmoney(b.me.fut.wallet)}</span><button class="btn2" data-bk-dl="${B.length - 1 - i}">내려받기</button><button class="btn2" data-bk-use="${B.length - 1 - i}">되살리기</button></div>`).join('') : ''; })()}
      <div class="row"><button class="btn2 danger" id="sReset">모두 지우고 새로 시작</button></div>
      <div class="note">시작 ${ftime(ME.created)} · 거래 ${ME.trades.length}건 · 체결 ${ME.fills.length}건</div></section>
    <section><h3>연결 점검</h3><div class="note">문제가 있을 때 눌러서 결과를 캡처해 주세요.</div><button class="btn2" id="sDiag">점검</button><div id="diag" class="note num"></div></section></div>`;
  $('#sDiag').onclick = async () => {
    const out = [], ok = (b) => b ? '✔' : '✘';
    const tryF = async (u) => { try { const r = await fetch(u, { cache: 'no-store' }); return r.ok; } catch { return false; } };
    out.push(`${ok(now() - spotSeenWS < 5000)} 바이낸스 현물 실시간 (웹소켓)`);
    out.push(`${ok(await tryF('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'))} 바이낸스 현물 REST (놓친 체결 · BTC 필터 · 차트)`);
    out.push(`${ok(feedOk.fut)} 바이낸스 실시간 (웹소켓 호가)`);
    out.push(`${ok(now() - markSeenWS < 5000)} 바이낸스 마크 가격 (웹소켓)`);
    out.push(`${ok(await tryF('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'))} 바이낸스 REST (마크 가격 · 놓친 체결 · 펀딩)`);
    out.push(`${ok(ghOn() && (await gh('').then((r) => r.ok).catch(() => false)))} GitHub 저장소`);
    out.push(`BTC 필터 출처: ${btcFilter ? btcFilter.src : '없음'} · 놓친 구간 확인: ${catchFail ? '실패' : caughtUp ? '완료' : '진행 중'}`);
    $('#diag').innerHTML = out.join('<br>');
  };
  $('#sSave').onclick = async () => {
    Object.assign(cfg, { owner: $('#sOwner').value.trim(), repo: $('#sRepo').value.trim(), branch: $('#sBranch').value.trim() || 'main', token: $('#sToken').value.trim() });
    saveCfg(); $('#sMsg').textContent = '확인 중…';
    try { const r = await gh(''); $('#sMsg').textContent = r.ok ? '연결됨' : `실패 (${r.status}) — 아이디·저장소·토큰 권한 확인`; if (r.ok) { await pullRemote(); await loadShared(); save(); } }
    catch (e) { $('#sMsg').textContent = '실패: ' + e.message; }
  };
  $$('[data-st]', body).forEach((c) => c.onchange = () => { cfg.studies = $$('[data-st]', body).filter((x) => x.checked).map((x) => x.dataset.st); saveCfg(); if (cfg.chart === 'tv') mountTV(); });
  $('#sIv').onchange = (e) => { cfg.interval = e.target.value; saveCfg(); if (cfg.chart === 'tv') mountTV(); };
  $$('#sTheme button').forEach((b) => b.onclick = () => { cfg.theme = b.dataset.th; saveCfg(); applyTheme(); renderTabBody(); mountChart(); });
  $('#sSymSave').onclick = () => { const v = $('#sSyms').value.toUpperCase().split(/[\s,]+/).map((x) => x.replace(/USDT$/, '')).filter((x) => /^[A-Z0-9]{2,12}$/.test(x)); if (!v.length) return toast('종목을 하나 이상 넣어 주세요'); cfg.syms = [...new Set(v)]; saveCfg(); location.reload(); };
  $('#sSetSave').onclick = () => { ME.setups = $('#sSetups').value.split(',').map((x) => x.trim()).filter(Boolean); save(); toast('저장했어요'); };
  $('#sExport').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(ME, null, 1)], { type: 'application/json' })); a.download = `desk-${new Date().toISOString().slice(0, 10)}.json`; a.click(); };
  const doTop = async (mkt) => {
    const name = mkt === 'fut' ? '선물' : '현물', bal = mkt === 'fut' ? ME.fut.wallet : ME.spot.cash, base = mkt === 'fut' ? ME.init.usdt : (ME.init.spot ?? 1e4);
    const open = mkt === 'fut' ? Object.keys(ME.fut.pos).length : Object.keys(ME.spot.hold).length;
    if (open) return toast(`${name} 포지션·보유를 먼저 정리해 주세요`);
    if (bal >= base) return toast(`${name} 잔고가 이미 시작 자금 이상이에요`);
    const ok = await modal(`<b>${name} 자금을 리셋할까요?</b><div class="note">${fmoney(bal)} → ${fmoney(base)} USDT (+${fmoney(base - bal)} 추가 입금으로 기록)<br>${name} 대기 주문은 취소돼요. 거래·일지는 그대로 남아요.</div><div class="lbl">이유 (선택 — 주간 평가에서 함께 봐요)</div><textarea id="topWhy" placeholder="예: 10배 롱 몰빵하다 청산"></textarea>`, [{ label: '취소', ret: null }, { label: '리셋', value: (r) => ({ why: $('#topWhy', r).value.trim() }) }]);
    if (!ok) return;
    const r = E.topUp(ME, mkt, now(), ok.why);
    if (!r.ok) return toast(r.why);
    save(); renderAll(); toast(`${name} 자금을 리셋했어요 (+${fmoney(r.add)} USDT)`);
  };
  $('#sTopSpot').onclick = () => doTop('spot'); $('#sTopFut').onclick = () => doTop('fut');
  $$('[data-bk-dl]').forEach((b) => b.onclick = () => { const x = LS.get('desk.me.backups', [])[+b.dataset.bkDl]; if (!x) return; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(x.me, null, 1)], { type: 'application/json' })); a.download = `desk-backup-${new Date(x.t).toISOString().slice(0, 16)}.json`; a.click(); });
  $$('[data-bk-use]').forEach((b) => b.onclick = async () => {
    const B = LS.get('desk.me.backups', []), x = B[+b.dataset.bkUse]; if (!x) return;
    const ok = await modal(`<b>보관본(${ftime(x.t)})으로 되돌릴까요?</b><div class="note">지금 계좌는 보관함에 넣고, 보관본을 현재 계좌로 저장소에 올려요. 다른 기기도 20초 안에 따라와요.</div>`, [{ label: '취소', ret: false }, { label: '되살리기', ret: true }]);
    if (!ok) return;
    backup(ME, '되살리기 전 계좌'); ME = migrateMe(x.me); save(); renderAll(); paintDrawings(); toast('보관본으로 되돌렸어요');
  });
  $('#sReset').onclick = async () => {
    const ok = await modal('<b>계좌를 초기화할까요?</b><div class="note">지금까지의 포지션·주문·체결·일지가 모두 지워지고 시작 자금으로 새로 시작해요. 저장소의 이전 기록은 GitHub 커밋 기록에 남아 있어요.</div>', [{ label: '취소', ret: false }, { label: '초기화', ret: true, cls: 'danger' }]);
    if (!ok) return;
    const setups = ME.setups;
    ME = E.newAccount({ spot: +$('#sKrw').value || 10_000, usdt: +$('#sUsdt').value || 10_000 }); ME.setups = setups;
    for (const mkt of ['spot', 'fut']) for (const s of SYMS) ME.seen[`${mkt}:${s}`] = Math.floor(now() / FIVE) * FIVE;
    save(); renderAll(); toast('새 계좌로 시작했어요');
  };
}

// ───────────────────────────── 페이지 (거래 · 시황 · 성과 · 봇) — 위쪽 탭으로 넘김, 주소 #mkt 처럼 남아서 새로고침해도 그 페이지
const PAGES = ['trade', 'mkt', 'perf', 'bot'];
function setPage(p) {
  if (!PAGES.includes(p)) p = 'trade';
  ui.page = p;
  for (const k of PAGES) $('#pg-' + k).hidden = k !== p;
  $$('#pnav button').forEach((b) => b.classList.toggle('on', b.dataset.page === p));
  if (p === 'mkt' && BRIEFS.length) { cfg.seenBrief = Math.max(...BRIEFS.map((x) => x.t)); saveCfg(); }
  if (p === 'perf' && REVIEWS.length) { cfg.seenRev = Math.max(...REVIEWS.map((x) => x.t)); saveCfg(); }
  renderNav(); renderPage(); window.scrollTo({ top: 0 });
}
function renderNav() {
  const nb = BRIEFS.filter((x) => x.t > (cfg.seenBrief || 0)).length, nr = REVIEWS.filter((x) => x.t > (cfg.seenRev || 0)).length;
  const lab = { trade: '거래', mkt: '시황', perf: '성과', bot: '봇' }, cnt = { mkt: ui.page === 'mkt' ? 0 : nb, perf: ui.page === 'perf' ? 0 : nr };
  $$('#pnav button').forEach((b) => { const k = b.dataset.page; b.innerHTML = lab[k] + (cnt[k] ? `<span class="badge" title="새 글">${cnt[k]}</span>` : ''); });
}
function renderPage() {
  if (ui.page === 'mkt') pageMkt($('#pg-mkt'));
  else if (ui.page === 'perf') pagePerf($('#pg-perf'));
  else if (ui.page === 'bot') { const el = $('#pg-bot'); el.innerHTML = '<div class="pg"><h2 class="pt">TSB7 가상매매 봇 <small>업비트 원화 · 4시간봉 마감마다</small></h2><div class="tbody" style="padding:0" id="botBody"></div></div>'; tabBot($('#botBody')); }
}
const needGH = (el, what) => { el.innerHTML = `<div class="pg"><div class="empty">${what}은(는) GitHub 저장소에서 읽어요. 거래 → 설정에서 GitHub 를 연결해 주세요.</div></div>`; };
const KIND = { morning: '아침', evening: '저녁', review: '주간' };
const moodCls = (m) => m === '강세' ? 'up' : m === '약세' ? 'dn' : 'acc';
const pc1 = (v) => v == null || !isFinite(v) ? '–' : `<span class="${cls(v)}">${(v > 0 ? '+' : '') + (v * 100).toFixed(1)}%</span>`;
const usdShort = (v) => v == null || !isFinite(v) ? '–' : v >= 1e12 ? (v / 1e12).toFixed(2) + '조$' : v >= 1e8 ? Math.round(v / 1e8).toLocaleString('ko-KR') + '억$' : v >= 1e6 ? Math.round(v / 1e6) + '백만$' : Math.round(v) + '$';

// ── 시황
function numTiles() {
  if (!MKT) return '<div class="empty">숫자 시황이 아직 없어요. 가상매매 봇이 다음에 돌 때(4시간마다) 만들어져요.</div>';
  const x = MKT.extra || {}, b = MKT.coins?.BTC || {}, f = MKT.btc_filter, T = [];
  if (x.fng) T.push(`<div class="tile"><small>공포·탐욕</small><b>${x.fng.now} <em>${esc(x.fng.label)}</em></b><div class="gauge"><i style="left:calc(${x.fng.now}% - 1px)"></i></div><em>어제 ${x.fng.yday}${x.fng.week ? ' · 1주 전 ' + x.fng.week : ''}</em></div>`);
  if (b.usd) T.push(`<div class="tile"><small>BTC (바이낸스)</small><b class="num">${fpx(b.usd)}</b><em>24시간 ${pc1(b.chg24h)} · 7일 ${pc1(b.chg7d)}</em></div>`);
  if (f) T.push(`<div class="tile"><small>BTC 50일선 필터</small><b class="${f.on ? 'up' : 'dn'}">${f.on ? '켜짐' : '꺼짐'}</b><em>50일선 대비 ${pc1(f.gap)}</em></div>`);
  if (x.global) T.push(`<div class="tile"><small>BTC 점유율</small><b class="num">${(x.global.btcDom * 100).toFixed(1)}%</b><em>전체 ${usdShort(x.global.mcap)} ${pc1(x.global.chg24h)}</em></div>`);
  if (x.movers) T.push(`<div class="tile"><small>오른 종목 비율</small><b class="num ${x.movers.breadth >= 0.5 ? 'up' : 'dn'}">${Math.round(x.movers.breadth * 100)}%</b><em>바이낸스 ${x.movers.n}개 중</em></div>`);
  if (x.kimp && b.usd && x.kimp.coins.BTC) { const k = x.kimp.coins.BTC / (b.usd * x.kimp.fx) - 1; T.push(`<div class="tile"><small>김프 (BTC)</small><b class="num">${pc1(k)}</b><em>테더 ${Math.round(x.kimp.usdt).toLocaleString('ko-KR')}원 · 환율 ${x.kimp.fx.toFixed(0)}</em></div>`); }
  return `<div class="tiles">${T.join('')}</div>`;
}
function numTables() {
  if (!MKT) return '<div class="empty">숫자 시황이 아직 없어요.</div>';
  const x = MKT.extra; if (!x) return `<div class="md">${md(MKT.brief_md || '')}</div>`;
  const perp = x.perp?.majors || {}, out = [];
  out.push(`<h3>메이저</h3><div class="tbody" style="padding:0"><table class="t"><thead><tr><th class="l">종목</th><th>가격 ($)</th><th>24시간</th><th>7일</th><th title="TSB7 진입선 = 직전 20일 최고가">20일 고점까지</th><th>펀딩 (8h)</th><th>미결제약정</th></tr></thead><tbody>${Object.entries(MKT.coins || {}).map(([s, c]) => c.error ? `<tr><td class="l"><b>${s}</b></td><td colspan="6" class="mute">못 가져옴</td></tr>` :
    `<tr><td class="l"><b>${s}</b></td><td class="num">${fpx(c.usd)}</td><td class="num">${pc1(c.chg24h)}</td><td class="num">${pc1(c.chg7d)}</td><td class="num">${c.tsb7.gap_to_entry <= 0 ? '<span class="tag up sm">돌파</span>' : (c.tsb7.gap_to_entry * 100).toFixed(1) + '%'}</td><td class="num">${perp[s] ? (perp[s].f8 * 100).toFixed(3) + '%' : '–'}</td><td class="num">${perp[s] ? usdShort(perp[s].oi) : '–'}</td></tr>`).join('')}</tbody></table></div>`);
  if (x.movers) {
    const li = (a) => a.map((d) => `<tr><td class="l"><b>${esc(d.sym)}</b></td><td class="num">${pc1(d.chg)}</td><td class="num mute">${usdShort(d.vol)}</td></tr>`).join('');
    out.push(`<h3>24시간 등락 상위 <small class="mute">바이낸스 현물, 거래대금 5백만$ 이상</small></h3><div class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))"><table class="t"><thead><tr><th class="l">상승</th><th>24시간</th><th>거래대금</th></tr></thead><tbody>${li(x.movers.up.slice(0, 8))}</tbody></table><table class="t"><thead><tr><th class="l">하락</th><th>24시간</th><th>거래대금</th></tr></thead><tbody>${li(x.movers.down.slice(0, 8))}</tbody></table></div>
      <p class="note">거래대금 상위: ${x.movers.vol.map((d) => `<span class="tag sm ${cls(d.chg)}">${esc(d.sym)} ${(d.chg > 0 ? '+' : '') + (d.chg * 100).toFixed(1)}%</span>`).join('')}</p>`);
  }
  const T = MKT.sectorTrend;
  if (T) {
    const st = (n) => !n ? '–' : `<span class="${n > 0 ? 'up' : 'dn'}">${n > 0 ? '▲' : '▼'}${Math.abs(n)}일</span>`;
    const tb = (a, lab) => `<table class="t"><thead><tr><th class="l">${lab}</th><th>24시간</th><th>3일</th><th>7일</th><th>연속</th><th>시총</th></tr></thead><tbody>${a.map((r) => `<tr><td class="l">${esc(r.name)}</td><td class="num">${pc1(r.c1)}</td><td class="num">${pc1(r.c3)}</td><td class="num">${pc1(r.c7)}</td><td class="num">${st(r.streak)}</td><td class="num mute">${usdShort(r.mcap)}</td></tr>`).join('')}</tbody></table>`;
    out.push(`<h3>섹터 <small class="mute">CoinGecko 테마 · ${T.key === 'c3' ? '3일 변화 순' : '24시간 변화 순'} · 기록 ${T.days}일째</small></h3><div class="tbody" style="padding:0">${tb(T.up.slice(0, 6), '강한 섹터')}</div><div class="tbody" style="padding:0;margin-top:8px">${tb(T.down.slice(0, 6), '약한 섹터')}</div>${T.days < 4 ? `<p class="note">3일·7일 변화와 연속 일수는 하루 한 줄씩 쌓는 기록으로 계산해요 (지금 ${T.days}일째).</p>` : ''}`);
  }
  if (x.perp) out.push(`<h3>펀딩 쏠림 <small class="mute">Hyperliquid, 미결제약정 2천만$ 이상, 8시간 환산</small></h3><p>${x.perp.hot.map((d) => `<span class="tag up">${esc(d.sym)} ${(d.f8 * 100).toFixed(3)}%</span>`).join('')}</p><p>${x.perp.cold.map((d) => `<span class="tag dn">${esc(d.sym)} ${(d.f8 * 100).toFixed(3)}%</span>`).join('')}</p><p class="note">빨강 = 롱이 돈을 내며 버티는 쪽(롱 과열), 파랑 = 숏 과열</p>`);
  const err = Object.keys(x.errors || {}); if (err.length) out.push(`<p class="note">못 가져온 항목: ${err.join(', ')} (다음 실행 때 다시 시도)</p>`);
  return `<div class="md" style="max-width:none">${out.join('')}</div>`;
}
function splitMd(txt) {      // '# 제목' + '## 절' 들로 나눔
  const L = String(txt || '').replace(/\r/g, '').split('\n'), secs = []; let title = '', cur = null;
  for (const l of L) {
    const h1 = l.match(/^# (.+)/), h2 = l.match(/^## (.+)/);
    if (h1 && !title) { title = h1[1]; continue; }
    if (h2) { cur = { h: h2[1].trim(), body: [] }; secs.push(cur); continue; }
    if (cur) cur.body.push(l); else if (l.trim()) (secs[0]?.h === '' ? secs[0] : (secs.unshift({ h: '', body: [] }), secs[0])).body.push(l);
  }
  return { title, secs: secs.map((x) => ({ h: x.h, body: x.body.join('\n').trim() })) };
}
function heroHtml(e, doc) {
  const S = e.summary || {}, glance = doc.secs.find((x) => /한눈에/.test(x.h));
  const pts = S.points?.length ? S.points : glance ? glance.body.split('\n').filter((l) => /^\s*[-*] /.test(l)).map((l) => l.replace(/^\s*[-*] /, '')) : [];
  const inl = (t) => md(t).replace(/^<p>|<\/p>$/g, '');
  const rows = [];
  if (S.mood) rows.push(['분위기', `<span class="tag ${moodCls(S.mood)}">${esc(S.mood)}</span>`]);
  if (S.strong?.length) rows.push(['강한 쪽', S.strong.map((x) => `<span class="tag up">${esc(x)}</span>`).join('')]);
  if (S.weak?.length) rows.push(['약한 쪽', S.weak.map((x) => `<span class="tag dn">${esc(x)}</span>`).join('')]);
  if (S.watch?.length) rows.push(['볼 것', S.watch.map((x) => `<div>· ${esc(x)}</div>`).join('')]);
  if (S.claude) rows.push(['Claude 계좌', `<span class="tag acc">${esc(S.claude)}</span> ${esc(S.claude_note || '')}`]);
  if (S.grade) rows.push(['과정 점수', `<span class="tag acc">${esc(S.grade)}</span>`]);
  if (S.focus) rows.push(['다음 주 과제', `<b>${esc(S.focus)}</b>`]);
  return `<div class="hero ${S.mood ? 'm-' + moodCls(S.mood) : ''}"><div class="note">${KIND[e.kind] || ''} · ${ftime(e.t)}</div><h2>${esc(S.headline || doc.title || e.title || '')}</h2>
    ${S.headline && doc.title ? `<div class="note">${esc(doc.title)}</div>` : ''}
    ${pts.length ? `<ul>${pts.map((p) => `<li>${inl(p)}</li>`).join('')}</ul>` : ''}
    ${rows.length ? `<div class="hrow">${rows.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('')}</div>` : ''}</div>`;
}
function docHtml(e, txt) {
  const doc = splitMd(txt);
  const pre = doc.secs.find((x) => x.h === ''), secs = doc.secs.filter((x) => x.h && x.body && !/한눈에/.test(x.h));
  return heroHtml(e, doc) + (pre && pre.body ? `<div class="md note" style="margin:4px 2px 8px">${md(pre.body)}</div>` : '') + secs.map((x) => `<details class="sec" ${/출처/.test(x.h) ? '' : 'open'}><summary>${esc(x.h || '본문')}</summary><div class="md">${md(x.body)}</div></details>`).join('');
}
function listItem(e, on) {
  if (e.id === 'num') return `<button data-b="num" class="${on ? 'on' : ''}"><div class="when"><span class="tag acc sm">표</span>${MKT ? ftime(MKT.t) : ''}</div><div class="hl">숫자 시황 자세히 — 메이저·등락·섹터·펀딩</div></button>`;
  const S = e.summary || {};
  return `<button data-b="${esc(e.id)}" class="${on ? 'on' : ''}"><div class="when"><span class="tag sm">${KIND[e.kind] || '글'}</span>${ftime(e.t)}${S.mood ? `<span class="tag sm ${moodCls(S.mood)}">${esc(S.mood)}</span>` : ''}${S.claude && S.claude !== '관망' ? `<span class="tag sm acc">Claude ${esc(S.claude)}</span>` : ''}</div><div class="hl">${esc(S.headline || e.title || '')}</div></button>`;
}
async function pageMkt(el) {
  if (!ghOn()) return needGH(el, '시황');
  const list = BRIEFS.slice().sort((a, b) => b.t - a.t);
  if (!ui.brief || (ui.brief !== 'num' && !list.some((x) => x.id === ui.brief))) ui.brief = list[0]?.id || 'num';
  el.innerHTML = `<div class="pg"><h2 class="pt">숫자 시황 <small>${MKT ? ftime(MKT.t) + ' 기준 · 4시간마다 자동' : ''}</small></h2>${numTiles()}</div>
    <div class="pg mk"><div class="blist2" id="blist">${[{ id: 'num' }].concat(list).slice(0, 61).map((x) => listItem(x, x.id === ui.brief)).join('')}</div><div id="bview" style="min-width:0;max-width:820px"></div></div>
    ${list.length ? '' : '<div class="pg"><div class="empty">글 브리핑은 매일 09:20 (아침) · 21:20 (저녁)에 올라와요.</div></div>'}`;
  $$('#blist [data-b]').forEach((b) => b.onclick = () => { ui.brief = b.dataset.b; pageMkt(el); });
  const v = $('#bview');
  if (ui.brief === 'num') { v.innerHTML = numTables(); return; }
  const e = list.find((x) => x.id === ui.brief);
  v.innerHTML = '<div class="empty">불러오는 중…</div>';
  if (BRIEF_TXT[e.id] == null) BRIEF_TXT[e.id] = await ghText(e.path).catch(() => null);
  if (ui.brief !== e.id || !$('#bview')) return;
  $('#bview').innerHTML = BRIEF_TXT[e.id] == null ? '<div class="empty">불러오지 못했어요</div>' : docHtml(e, BRIEF_TXT[e.id]);
}

// ── 성과: 세 계좌 비교 + 주간 평가
function mdd(vals) { let pk = -Infinity, m = 0; for (const v of vals) { if (v == null) continue; pk = Math.max(pk, v); if (pk > 0) m = Math.min(m, Math.max(-1, v / pk - 1)); } return m; }
const ddPts = (pts) => pts.flatMap((p) => p.lo != null ? [p.lo, p.v] : [p.v]);     // 그날 최저까지 넣어 낙폭 계산
function acctSeries(st, hist, livePx) {     // 합계(현물+선물) 평가액 시계열 + 지금
  if (!st) return null;
  const init = (st.init.spot ?? st.init.krw ?? 0) + (st.init.usdt ?? 0);
  const extra = (t) => E.deposited(st, 'spot', t) + E.deposited(st, 'fut', t) - init;     // 자금 리셋으로 넣은 돈은 빼고 = 처음 자금 + 총 손익
  const pts = [{ t: st.created || 0, v: init }].concat((hist || []).map((r) => ({ t: r.t, v: r.spot + r.fut - extra(r.t), lo: r.lo != null ? r.lo - extra(r.t) : null })));
  const eq = E.equity(st, livePx), cur = eq.spot + eq.fut - extra(now());
  if (isFinite(cur)) pts.push({ t: now(), v: cur });
  return { init, pts: pts.filter((p) => isFinite(p.t) && isFinite(p.v)).sort((a, b) => a.t - b.t), eq };
}
function recordEq() {     // 내 계좌 하루 한 줄 (그날 안에서는 마지막 값으로 덮어씀, 날이 바뀔 때만 저장소에 저장)
  if (!caughtUp || document.visibilityState !== 'visible' || (ghOn() && now() - lastPull > 60000)) return;   // 오래 안 맞춘 기기는 쓰지 않음
  const px = prices();
  for (const s of Object.keys(ME.spot.hold)) if (!(px.spot[s] > 0)) return;
  for (const s of Object.keys(ME.fut.pos)) if (!(px.fut[s] > 0)) return;
  const eq = E.equity(ME, px), day = new Date(now() + 9 * 3600e3).toISOString().slice(0, 10);
  const v = Math.round((eq.spot + eq.fut) * 100) / 100;
  const row = { day, t: now(), spot: Math.round(eq.spot * 100) / 100, fut: Math.round(eq.fut * 100) / 100, lo: v, hi: v };
  const H = ME.eqHist ||= [], L = H[H.length - 1];
  if (L && L.day === day) { Object.assign(L, row, { lo: Math.min(L.lo ?? v, v), hi: Math.max(L.hi ?? v, v) }); LS.set('desk.me', ME); }   // 그날 최저·최고도 남김 (낙폭 계산)
  else { H.push(row); save(); }
}
let perfChart = null;
async function pagePerf(el) {
  if (perfChart) { perfChart.remove(); perfChart = null; }
  const px = prices(), me = acctSeries(ME, ME.eqHist, px), cl = CL ? acctSeries(CL, CL.equityHist, px) : null;
  const sm = E.stats(ME).all, sc = CL ? E.stats(CL).all : null;
  const ret = (a) => a ? a.pts[a.pts.length - 1].v / a.init - 1 : null;
  const NAME = { A: 'TSB7 1/6 (현행)', B: 'TSB7 1/5 + 상한 80%', C: 'TSB7 1/4', D: 'TSB7 + BB20', H: 'BTC 보유', F: 'BTC 50일선 필터' };
  const rows = [
    { k: 'me', name: '나', sub: '재량 · 바이낸스 USDT' + ((ME.resets || []).length ? ` · 자금 리셋 ${ME.resets.length}회 (+${fmoney(ME.resets.reduce((a, r) => a + r.add, 0))})` : ''), r: ret(me), spot: me ? (me.eq.spot - E.deposited(ME, 'spot')) / (ME.init.spot ?? 1e4) : null, fut: me ? (me.eq.fut - E.deposited(ME, 'fut')) / ME.init.usdt : null, dd: me ? mdd(ddPts(me.pts)) : null, n: sm.n, win: sm.win, R: sm.expR, since: ME.created, pts: me?.pts, base: me?.init, color: cssv('--accent') },
    { k: 'cl', name: 'Claude', sub: '재량 · 하루 2번 판단', r: ret(cl), spot: cl ? (cl.eq.spot - E.deposited(CL, 'spot')) / CL.init.spot : null, fut: cl ? (cl.eq.fut - E.deposited(CL, 'fut')) / CL.init.usdt : null, dd: cl ? mdd(ddPts(cl.pts)) : null, n: sc?.n, win: sc?.win, R: sc?.expR, since: CL?.created, pts: cl?.pts, base: cl?.init, color: '#7c6bd6' },
  ];
  const BC = { A: cssv('--ok'), B: '#2a9d8f', H: cssv('--mute') };
  for (const b of (BOT?.rows || []).filter((r) => ['A', 'B', 'C', 'D', 'H'].includes(r.a))) {
    const v = b.pts.map((p) => p.v), base = 1e7;
    rows.push({ k: b.a, name: `봇 ${b.a}`, sub: NAME[b.a], r: +b.last.ret, spot: null, fut: null, dd: mdd([base, ...v]), n: b.n, win: b.win, R: null, since: b.pts[0]?.t, pts: [{ t: b.pts[0]?.t, v: base }, ...b.pts], base, color: BC[b.a] || null });
  }
  const tp = (v) => v == null || !isFinite(v) ? '–' : Math.round(v * 100) + '%';
  const prog = Math.min(100, sm.n);
  el.innerHTML = `<div class="pg"><h2 class="pt">내 재량 연습 <small>셋업 하나로 100회 → 셋업별 기대값으로 판정</small></h2>
      <div class="tiles"><div class="tile"><small>끝난 거래</small><b class="num">${sm.n} <em>/ 100</em></b><div class="prog" style="margin-top:6px"><i style="width:${prog}%"></i></div></div>
      <div class="tile"><small>승률</small><b class="num">${tp(sm.win)}</b><em>손익비 ${sm.payoff ? sm.payoff.toFixed(2) : '–'}</em></div>
      <div class="tile"><small>거래당 기대값</small><b class="num ${cls(sm.expR)}">${sm.expR != null ? sm.expR.toFixed(2) + 'R' : '–'}</b><em>${fsign(sm.exp)} USDT</em></div>
      <div class="tile"><small>규칙 준수</small><b class="num">${tp(sm.rule)}</b><em>돌아보기를 남긴 거래 기준</em></div></div></div>
    <div class="pg"><h2 class="pt">세 계좌 비교 <small>시작일이 달라 같은 기간 비교는 아니에요 · 봇은 업비트 원화 · 누적 손익률 = 총 손익 ÷ 처음 자금 (리셋 전 손실 포함 — 전액 손실 두 번이면 −200%) · 체결 조건도 달라요: Claude 선물은 근사 가격·펀딩 없음</small></h2>
      <div class="tbody" style="padding:0"><table class="t cmp"><thead><tr><th class="l">계좌</th><th title="총 손익 ÷ 처음 자금. 자금 리셋으로 채운 돈은 손익이 아님">누적 손익률</th><th>현물</th><th>선물</th><th title="일별 기록(그날 최저 포함) 기준">최대 낙폭</th><th>끝난 거래</th><th>승률</th><th>평균 R</th><th class="l">시작</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="l">${r.color ? `<i style="display:inline-block;width:10px;height:3px;background:${r.color};vertical-align:middle;margin-right:6px"></i>` : ''}<b>${r.name}</b> <span class="mute">${esc(r.sub)}</span></td><td class="num"><b>${pc1(r.r)}</b></td><td class="num">${pc1(r.spot)}</td><td class="num">${pc1(r.fut)}</td><td class="num">${pc1(r.dd)}</td><td class="num">${r.n ?? '–'}</td><td class="num">${tp(r.win)}</td><td class="num">${r.R != null ? r.R.toFixed(2) : '–'}</td><td class="l num mute">${r.since ? ftime(r.since).slice(0, 5) : '–'}</td></tr>`).join('')}
      </tbody></table></div>
      <div id="perfChart"></div><div class="legend" id="perfLeg"></div></div>
    <div class="pg"><h2 class="pt">주간 매매 평가 <small>매주 일요일 20:40, Claude 가 내 일지를 읽고 코칭</small></h2><div id="revBox"></div></div>`;
  // 수익률 곡선
  if (LC) {
    const box = $('#perfChart');
    perfChart = LC.createChart(box, { autoSize: true, layout: { background: { type: 'solid', color: cssv('--panel') }, textColor: cssv('--mute'), fontFamily: cssv('--num'), fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: cssv('--line') } }, rightPriceScale: { borderColor: cssv('--line') }, timeScale: { borderColor: cssv('--line'), timeVisible: true }, localization: { locale: 'ko-KR', priceFormatter: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + '%' } });
    const leg = [];
    for (const r of rows.filter((x) => x.color && x.pts && x.pts.length >= 2)) {
      const ser = perfChart.addSeries(LC.LineSeries, { color: r.color, lineWidth: r.k === 'me' || r.k === 'cl' ? 2 : 1, priceLineVisible: false, lastValueVisible: true });
      const m = new Map(); for (const p of r.pts) if (p.t) m.set(Math.floor(p.t / 1000) + KSTS, (p.v / r.base - 1) * 100);
      ser.setData([...m.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value })));
      leg.push(`<span><i style="background:${r.color}"></i>${r.name}${r.k.length === 1 ? ' ' + esc(r.sub) : ''}</span>`);
    }
    perfChart.timeScale().fitContent();
    $('#perfLeg').innerHTML = leg.join('') + '<span>세로축 = 시작 대비 수익률 (%)</span>';
  }
  // 주간 평가
  const rb = $('#revBox');
  if (!ghOn()) { rb.innerHTML = '<div class="empty">GitHub 를 연결하면 보여요.</div>'; return; }
  const list = REVIEWS.slice().sort((a, b) => b.t - a.t);
  if (!list.length) { rb.innerHTML = '<div class="empty">첫 평가는 이번 일요일 20:40에 올라와요. 거래할 때 셋업·감정·이유를 남겨 두면 평가가 구체적이 돼요.</div>'; return; }
  if (!ui.rev || !list.some((x) => x.id === ui.rev)) ui.rev = list[0].id;
  rb.innerHTML = `<div class="mk"><div class="blist2" id="rlist">${list.map((x) => `<button data-r="${esc(x.id)}" class="${x.id === ui.rev ? 'on' : ''}"><div class="when"><span class="tag sm">주간</span>${ftime(x.t)}${x.summary?.grade ? `<span class="tag sm acc">${esc(x.summary.grade)}</span>` : ''}</div><div class="hl">${esc(x.summary?.headline || x.title)}</div></button>`).join('')}</div><div id="rview" style="min-width:0;max-width:820px"></div></div>`;
  $$('#rlist [data-r]').forEach((b) => b.onclick = () => { ui.rev = b.dataset.r; pagePerf(el); });
  const e = list.find((x) => x.id === ui.rev);
  if (REV_TXT[e.id] == null) REV_TXT[e.id] = await ghText(e.path).catch(() => null);
  if ($('#rview')) $('#rview').innerHTML = REV_TXT[e.id] == null ? '<div class="empty">불러오지 못했어요</div>' : docHtml(e, REV_TXT[e.id]);
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
  $$('#mktSeg button').forEach((b) => b.onclick = () => { ui.mkt = b.dataset.mkt; if (ui.mkt === 'fut') ui.side = 'buy'; $$('#mktSeg button').forEach((x) => x.classList.toggle('on', x === b)); renderAll(); mountChart(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (cfg.theme === 'system') mountChart(); });
  for (const id of ['#ob', '#obMini']) $(id).addEventListener('pointerdown', (e) => {     // 호가는 0.5초마다 다시 그려져서 click 이 끊길 수 있음 → 누르는 순간 반영
    const tr = e.target.closest('[data-obpx]'); if (!tr || readOnly()) return;
    e.preventDefault(); setPriceField(tr.dataset.obpx, true);
  });
  matchMedia('(max-width: 760px)').addEventListener?.('change', () => { paintOB(); renderChartBar(); });
  $$('#pnav button').forEach((b) => b.onclick = () => { const p = b.dataset.page; if (p === ui.page) return; history.pushState(null, '', p === 'trade' ? location.pathname + location.search : '#' + p); setPage(p); });
  window.addEventListener('popstate', () => setPage(location.hash.slice(1) || 'trade'));
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible') { await pullRemote(true); if (caughtUp) { caughtUp = false; catchUpAll(); } } });
  setInterval(() => { if (document.visibilityState === 'visible') pullRemote(true); }, 20000);
}
async function start() {
  applyTheme(); bind(); renderAll(); mountChart(); setPage(location.hash.slice(1) || 'trade');
  setSync(ghOn() ? 'wait' : '', ghOn() ? '저장소 확인 중' : '이 기기에만 저장 (설정에서 GitHub 연결)');
  spotWS(); binanceWS();
  pollFut(); pollFutTicker(); setInterval(pollFut, 2000); setInterval(pollFutTicker, 20000); setInterval(pollSpot, 3000);
  if (migratedNote) toast('현물 계좌를 바이낸스 USDT 기준(1만 USDT)으로 새로 시작했어요. 선물 기록은 그대로예요.', 9000);
  await pullRemote();
  renderAll();
  await catchUpAll();
  loadShared(); loadBtcFilter();
  setInterval(loadShared, 5 * 60000); setInterval(loadBtcFilter, 30 * 60000); setInterval(recordEq, 60000); setTimeout(recordEq, 5000);
}
start();
