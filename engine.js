/* 가상 거래소 체결 엔진 (브라우저 · node 공용) — desk engine v2
 * 계좌 하나 = 현물(USDT, 바이낸스 현물 기준) + 선물(USDT, 바이낸스 USDT 무기한 기준, 격리 마진)
 * v2: 현물을 업비트 원화 → 바이낸스 USDT 로 (수수료 0.1%, 최소 주문 5 USDT). 현물 매수 금액 필드는 quote (예전 krw 도 읽음)
 * 실시간: 시장가는 즉시 호가로, 대기 주문·손절·익절·청산은 들어오는 가격(틱 = 고저가 같은 캔들)으로 확인
 * 놓친 체결: 마지막 확인 이후 캔들의 시가·고가·저가로 순서대로 확인 (한 캔들에 손절·익절이 다 닿으면 손절 먼저 = 보수적)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DeskEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SYMS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'ADA', 'LINK', 'NEAR'];
  const FEE = { spot: 0.001, futTaker: 0.0005, futMaker: 0.0002 };
  const MMR = 0.005;                 // 유지증거금률 (단순화: 모든 코인 0.5%)
  const MIN_SPOT = 5;                // USDT
  const SCHEMA = 2;
  const MIN_FUT_USDT = 5;

  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const r8 = (x) => Math.round(x * 1e8) / 1e8;

  function newAccount(opt = {}) {
    const spot = opt.spot ?? 10_000, usdt = opt.usdt ?? 10_000;
    return {
      schema: SCHEMA, ccy: 'USDT', created: opt.now ?? Date.now(), name: opt.name || '내 계좌',
      init: { spot, usdt },
      spot: { cash: spot, hold: {} },         // hold[sym] = {qty, avg, sl, tp, tradeId}
      fut: { wallet: usdt, pos: {} },          // pos[sym] = {side, qty, entry, margin, lev, sl, tp, tradeId, opened}
      orders: [], fills: [], trades: [], funding: [], seen: {}, lastFunding: {},
      setups: ['돌파', '눌림목', '추세 이어가기', '반전', '뉴스·이벤트', '기타'],
      updated: opt.now ?? Date.now(),
    };
  }

  // ───────────────────────────── 기본 계산
  function liqPrice(p) {
    if (!p || !p.qty) return null;
    const m = p.margin / p.qty;
    return p.side === 'long' ? Math.max(0, (p.entry - m) / (1 - MMR)) : (p.entry + m) / (1 + MMR);
  }
  function upnl(p, px) { return p.side === 'long' ? p.qty * (px - p.entry) : p.qty * (p.entry - px); }
  function equity(st, px) {
    // px: {spot: {BTC: usdt}, fut: {BTC: usdt}}
    let spot = st.spot.cash;
    for (const [s, h] of Object.entries(st.spot.hold)) spot += h.qty * (px.spot?.[s] ?? h.avg);
    let fut = st.fut.wallet;
    for (const [s, p] of Object.entries(st.fut.pos)) fut += p.margin + upnl(p, px.fut?.[s] ?? p.entry);
    // 미체결 선물 주문에 묶인 증거금은 지갑에서 빼지 않음 (체결 때 차감)
    return { spot, fut };
  }

  // ───────────────────────────── 거래 기록 (진입~청산 한 묶음 = 일지 단위)
  function openTrade(st, mkt, sym, dir, t, price, meta) {
    const tr = {
      id: uid('T'), mkt, sym, dir, status: 'open', openT: t, closeT: null, entry: price, exit: null, qtyMax: 0, pnl: 0, fees: 0,
      sl0: meta?.sl ?? null, risk: null, R: null, setup: meta?.setup ?? null, reason: meta?.reason ?? '', emotion: meta?.emotion ?? null,
      review: '', ruleOk: null, lev: meta?.lev ?? 1, by: meta?.by ?? 'manual', note: meta?.note ?? '',
    };
    st.trades.push(tr);
    return tr;
  }
  const trOf = (st, id) => st.trades.find((x) => x.id === id);

  function closeTrade(st, tr, t, exitPx) {
    tr.status = 'closed'; tr.closeT = t; tr.exit = exitPx;
    if (tr.risk && tr.risk > 0) tr.R = tr.pnl / tr.risk;
  }

  function addFill(st, f) {
    f.id = f.id || uid('F');
    st.fills.push(f);
    if (st.fills.length > 3000) st.fills.splice(0, st.fills.length - 3000);
    st.updated = Date.now();
    return f;
  }

  // ───────────────────────────── 현물
  function spotBuy(st, sym, krw, price, t, reason, meta = {}, fee = FEE.spot) {     // krw = 매수 금액 (USDT, 이름만 예전 그대로)
    krw = Math.min(krw, st.spot.cash);
    if (!(krw >= MIN_SPOT) || !(price > 0)) return { ok: false, why: `주문 금액 부족 (최소 ${MIN_SPOT} USDT, 현금 ${st.spot.cash.toFixed(2)} USDT)` };
    const qty = r8((krw * (1 - fee)) / price);
    let h = st.spot.hold[sym];
    let tr;
    if (!h || h.qty <= 0) {
      tr = openTrade(st, 'spot', sym, 'long', t, price, meta);
      h = st.spot.hold[sym] = { qty: 0, avg: 0, sl: meta.sl ?? null, tp: meta.tp ?? null, tradeId: tr.id, opened: t };
    } else {
      tr = trOf(st, h.tradeId);
      if (meta.sl != null) h.sl = meta.sl;
      if (meta.tp != null) h.tp = meta.tp;
    }
    // 위험액(R 의 분모) = 이번에 산 금액 × (진입가 − 손절가)/진입가 + 사고팔 때 수수료. 추가 매수도 더함 (선물과 같은 정의)
    const sl = meta.sl ?? h.sl;
    if (tr && sl != null && sl < price) { tr.risk = (tr.risk || 0) + krw * (price - sl) / price + krw * fee * 2; if (tr.sl0 == null) tr.sl0 = sl; }
    h.avg = (h.avg * h.qty + krw) / (h.qty + qty);       // 평균 단가 = 수수료 포함 원가
    h.qty = r8(h.qty + qty);
    st.spot.cash -= krw;
    if (tr) { tr.qtyMax = Math.max(tr.qtyMax, h.qty); tr.fees += krw * fee; }
    return { ok: true, fill: addFill(st, { t, mkt: 'spot', sym, side: '매수', price, qty, amount: krw, fee: krw * fee, pnl: null, reason, tradeId: h.tradeId }) };
  }

  function spotSell(st, sym, qty, price, t, reason, fee = FEE.spot) {
    const h = st.spot.hold[sym];
    if (!h || h.qty <= 0) return { ok: false, why: '보유 수량 없음' };
    qty = Math.min(qty, h.qty);
    if (h.qty - qty < 1e-9 || (h.qty - qty) * price < MIN_SPOT) qty = h.qty;   // 자투리는 전량
    const gross = qty * price, krw = gross * (1 - fee);
    const pnl = krw - h.avg * qty;
    st.spot.cash += krw;
    h.qty = r8(h.qty - qty);
    const tr = trOf(st, h.tradeId);
    if (tr) { tr.pnl += pnl; tr.fees += gross * fee; }
    const f = addFill(st, { t, mkt: 'spot', sym, side: '매도', price, qty, amount: krw, fee: gross * fee, pnl, reason, tradeId: h.tradeId });
    if (h.qty <= 1e-12) {
      if (tr) closeTrade(st, tr, t, price);
      delete st.spot.hold[sym];
      cancelWhere(st, (o) => o.mkt === 'spot' && o.sym === sym && o.side === 'sell' && o.reduce);
    }
    return { ok: true, fill: f };
  }

  // ───────────────────────────── 선물 (격리, 코인당 한 방향 포지션)
  function futOpen(st, sym, side, marginUsdt, lev, price, t, reason, meta = {}, fee = FEE.futTaker) {
    lev = Math.max(1, Math.min(125, Math.round(lev || 1)));
    let p = st.fut.pos[sym];
    if (p && p.side !== side) {
      // 반대 방향 = 먼저 줄이거나 청산, 남는 금액으로 반대 포지션
      const notional = marginUsdt * lev, q = notional / price;
      const cq = Math.min(q, p.qty);
      const r = futClose(st, sym, cq, price, t, reason, fee);
      const left = q - cq;
      if (left * price < MIN_FUT_USDT) return r;
      return futOpen(st, sym, side, (left * price) / lev, lev, price, t, reason, meta, fee);
    }
    const feeAmt = marginUsdt * lev * fee;
    if (!(marginUsdt >= 1) || marginUsdt + feeAmt > st.fut.wallet + 1e-9) {
      return { ok: false, why: `증거금 부족 (필요 ${(marginUsdt + feeAmt).toFixed(2)} USDT, 가능 ${st.fut.wallet.toFixed(2)} USDT)` };
    }
    const qty = (marginUsdt * lev) / price;
    let tr;
    if (!p) {
      tr = openTrade(st, 'fut', sym, side, t, price, { ...meta, lev });
      p = st.fut.pos[sym] = { side, qty: 0, entry: price, margin: 0, lev, sl: meta.sl ?? null, tp: meta.tp ?? null, tradeId: tr.id, opened: t };
    } else {
      tr = trOf(st, p.tradeId);
      if (meta.sl != null) p.sl = meta.sl;
      if (meta.tp != null) p.tp = meta.tp;
    }
    p.entry = (p.entry * p.qty + price * qty) / (p.qty + qty);
    p.qty += qty; p.margin += marginUsdt; p.lev = (p.qty * p.entry) / p.margin;
    st.fut.wallet -= marginUsdt + feeAmt;
    if (tr) {
      tr.qtyMax = Math.max(tr.qtyMax, p.qty); tr.fees += feeAmt; tr.pnl -= feeAmt;
      if (tr.sl0 && !tr.risk) tr.risk = Math.abs(price - tr.sl0) * qty + feeAmt * 2;
      else if (tr.sl0 && tr.risk) tr.risk += Math.abs(price - tr.sl0) * qty;
    }
    return { ok: true, fill: addFill(st, { t, mkt: 'fut', sym, side: side === 'long' ? '롱 진입' : '숏 진입', price, qty, amount: marginUsdt, lev: Math.round(p.lev * 10) / 10, fee: feeAmt, pnl: -feeAmt, reason, tradeId: p.tradeId }) };
  }

  function futClose(st, sym, qty, price, t, reason, fee = FEE.futTaker) {
    const p = st.fut.pos[sym];
    if (!p) return { ok: false, why: '포지션 없음' };
    qty = Math.min(qty ?? p.qty, p.qty);
    if ((p.qty - qty) * price < MIN_FUT_USDT) qty = p.qty;
    const frac = qty / p.qty;
    const rel = p.margin * frac;
    const pnl = p.side === 'long' ? qty * (price - p.entry) : qty * (p.entry - price);
    const feeAmt = qty * price * fee;
    const realized = Math.max(-rel, pnl - feeAmt);      // 격리: 그 몫의 증거금보다 더 잃을 수 없음 → 지갑 변화와 일지 손익을 똑같이
    st.fut.wallet += rel + realized;
    p.qty -= qty; p.margin -= rel;
    const tr = trOf(st, p.tradeId);
    if (tr) { tr.pnl += realized; tr.fees += feeAmt; }
    const f = addFill(st, { t, mkt: 'fut', sym, side: p.side === 'long' ? '롱 청산' : '숏 청산', price, qty, amount: rel, fee: feeAmt, pnl: realized, reason, tradeId: p.tradeId });
    if (p.qty <= 1e-12 || frac >= 0.999999) {
      if (tr) closeTrade(st, tr, t, price);
      delete st.fut.pos[sym];
      cancelWhere(st, (o) => o.mkt === 'fut' && o.sym === sym && o.reduce);
    }
    return { ok: true, fill: f };
  }

  function futLiquidate(st, sym, price, t) {
    const p = st.fut.pos[sym];
    if (!p) return null;
    const tr = trOf(st, p.tradeId);
    const loss = -p.margin;
    if (tr) { tr.pnl += loss; closeTrade(st, tr, t, price); tr.liquidated = true; }
    const f = addFill(st, { t, mkt: 'fut', sym, side: p.side === 'long' ? '롱 강제청산' : '숏 강제청산', price, qty: p.qty, amount: p.margin, fee: 0, pnl: loss, reason: '강제청산', tradeId: p.tradeId });
    delete st.fut.pos[sym];
    cancelWhere(st, (o) => o.mkt === 'fut' && o.sym === sym && o.reduce);
    return f;
  }

  // ───────────────────────────── 자금 리셋 (청산 등으로 바닥났을 때 시작 자금으로 다시 채움 — 거래 기록은 그대로, '추가 입금' 으로 남김)
  const baseOf = (st, mkt) => mkt === 'fut' ? st.init.usdt : (st.init.spot ?? st.init.krw);
  function deposited(st, mkt, t = Infinity) {      // 그 시각까지 넣은 돈 = 시작 자금 + 리셋으로 채운 돈
    return baseOf(st, mkt) + (st.resets || []).filter((r) => r.mkt === mkt && r.t <= t).reduce((a, r) => a + r.add, 0);
  }
  function topUp(st, mkt, t, why = '') {
    if (mkt === 'fut' && Object.keys(st.fut.pos).length) return { ok: false, why: '열린 선물 포지션을 먼저 정리해 주세요' };
    if (mkt === 'spot' && Object.keys(st.spot.hold).length) return { ok: false, why: '보유 중인 현물을 먼저 정리해 주세요' };
    const target = baseOf(st, mkt), before = mkt === 'fut' ? st.fut.wallet : st.spot.cash, add = r8(target - before);
    if (!(add > 0)) return { ok: false, why: '잔고가 시작 자금 이상이에요' };
    cancelWhere(st, (o) => o.mkt === mkt);
    const last = (st.resets || []).filter((r) => r.mkt === mkt).reduce((a, r) => Math.max(a, r.t), st.created || 0);
    const liq = st.trades.filter((x) => x.mkt === mkt && x.liquidated && x.closeT > last).length;
    if (mkt === 'fut') st.fut.wallet = target; else st.spot.cash = target;
    (st.resets ||= []).push({ t, mkt, before: r8(before), after: target, add, liq, why });
    st.updated = Date.now();
    return { ok: true, add, liq };
  }

  // ───────────────────────────── 주문 (지정가 · 조건(돌파/이탈) · 시장가 예약)
  // o = {mkt:'spot'|'fut', sym, side:'buy'|'sell'|'long'|'short', type:'limit'|'stop'|'market', price, quote (현물 매수 USDT), qty (현물 매도·선물 청산), margin, lev, sl, tp, reduce, expires, note, setup, reason, emotion, by}
  function placeOrder(st, o, t) {
    o.id = o.id || uid('O');
    o.created = o.created ?? t;
    o.status = 'open';
    st.orders.push(o);
    st.updated = Date.now();
    return o;
  }
  function cancelOrder(st, id, t, why = '취소') {
    const o = st.orders.find((x) => x.id === id && x.status === 'open');
    if (o) { o.status = 'canceled'; o.closed = t ?? Date.now(); o.why = why; st.updated = Date.now(); }
    return o;
  }
  function cancelWhere(st, pred) {
    for (const o of st.orders) if (o.status === 'open' && pred(o)) { o.status = 'canceled'; o.closed = Date.now(); o.why = '포지션 종료로 자동 취소'; }
  }

  function execOrder(st, o, price, t, how) {
    const fee = o.type === 'limit' ? (o.mkt === 'fut' ? FEE.futMaker : FEE.spot) : (o.mkt === 'fut' ? FEE.futTaker : FEE.spot);
    const meta = { sl: o.sl ?? null, tp: o.tp ?? null, setup: o.setup, reason: o.reason, emotion: o.emotion, by: o.by, note: o.note };
    const why = how || (o.type === 'limit' ? '지정가 체결' : o.type === 'stop' ? '조건(돌파·이탈) 체결' : '시장가');
    let r;
    if (o.mkt === 'spot') {
      if (o.side === 'buy') r = spotBuy(st, o.sym, o.quote ?? o.krw, price, t, why, meta, fee);
      else r = spotSell(st, o.sym, o.qty ?? Infinity, price, t, why, fee);
    } else {
      const p = st.fut.pos[o.sym];
      if (o.reduce) r = p ? futClose(st, o.sym, o.qty ?? p.qty, price, t, why, fee) : { ok: false, why: '포지션 없음' };
      else r = futOpen(st, o.sym, o.side, o.margin, o.lev, price, t, why, meta, fee);
    }
    o.status = r.ok ? 'filled' : 'rejected';
    o.closed = t; o.fillPrice = r.ok ? price : null; o.why = r.ok ? why : r.why;
    return r;
  }

  // 캔들 하나 처리 (실시간 틱도 o=h=l=c 캔들로 넣음). c = {t (캔들 시작 ms), o, h, l, c, mh?, ml? (마크 가격 고가·저가 — 선물 강제청산 판정용, 없으면 h·l)}
  // 순서: ① 이미 있던 포지션 — 시가에서 이미 정해지는 것(갭) 먼저, 그다음 캔들 안에서는 불리한 쪽(손절·청산) 먼저
  //       ② 대기 주문 체결 → 같은 캔들 안에서 새 포지션의 손절·청산도 확인 (보수적으로: 체결 뒤 저가/고가에 닿았다고 봄, 익절은 다음 캔들부터)
  function guardFut(st, sym, c, full) {
    const p = st.fut.pos[sym]; if (!p) return null;
    const L = p.side === 'long', liq = liqPrice(p), mh = c.mh ?? c.h, ml = c.ml ?? c.l;
    const slOk = p.sl != null && (L ? p.sl > liq : p.sl < liq);       // 손절이 청산가보다 먼저 오는 위치일 때만 손절이 의미 있음
    if (full) {   // 시가 갭
      if (slOk && (L ? c.o <= p.sl : c.o >= p.sl)) return (L ? c.o <= liq : c.o >= liq) ? futLiquidate(st, sym, liq, c.t) : futClose(st, sym, p.qty, c.o, c.t, '손절 (갭)', FEE.futTaker).fill;
      if (p.tp != null && (L ? c.o >= p.tp : c.o <= p.tp)) return futClose(st, sym, p.qty, c.o, c.t, '익절 (갭)', FEE.futTaker).fill;
    }
    if (slOk && (L ? c.l <= p.sl : c.h >= p.sl)) return futClose(st, sym, p.qty, p.sl, c.t, '손절', FEE.futTaker).fill;
    if (L ? ml <= liq : mh >= liq) return futLiquidate(st, sym, liq, c.t);
    if (full && p.tp != null && (L ? c.h >= p.tp : c.l <= p.tp)) return futClose(st, sym, p.qty, p.tp, c.t, '익절', FEE.futMaker).fill;
    return null;
  }
  function guardSpot(st, sym, c, full) {
    const h = st.spot.hold[sym]; if (!h) return null;
    if (full) {
      if (h.sl != null && c.o <= h.sl) return spotSell(st, sym, h.qty, c.o, c.t, '손절 (갭)').fill;
      if (h.tp != null && c.o >= h.tp) return spotSell(st, sym, h.qty, c.o, c.t, '익절 (갭)').fill;
    }
    if (h.sl != null && c.l <= h.sl) return spotSell(st, sym, h.qty, h.sl, c.t, '손절').fill;
    if (full && h.tp != null && c.h >= h.tp) return spotSell(st, sym, h.qty, h.tp, c.t, '익절').fill;
    return null;
  }
  function processCandle(st, mkt, sym, c) {
    const ev = [], t = c.t;
    // ① 이 캔들이 시작되기 전부터 있던 포지션
    if (mkt === 'fut' && st.fut.pos[sym] && t >= st.fut.pos[sym].opened) ev.push(guardFut(st, sym, c, true));
    if (mkt === 'spot' && st.spot.hold[sym] && t >= (st.spot.hold[sym].opened ?? 0)) ev.push(guardSpot(st, sym, c, true));
    // ② 대기 주문 (만든 시각 이후 시작한 캔들부터)
    for (const o of st.orders) {
      if (o.status !== 'open' || o.mkt !== mkt || o.sym !== sym) continue;
      if (o.expires && t >= o.expires) { o.status = 'expired'; o.closed = o.expires; o.why = '기한 만료'; continue; }
      if (t < o.created) continue;
      const buyish = o.side === 'buy' || o.side === 'long';
      let px = null;
      if (o.type === 'market') px = c.o;
      else if (o.type === 'limit') {
        if (buyish && c.l <= o.price) px = Math.min(o.price, c.o);
        if (!buyish && c.h >= o.price) px = Math.max(o.price, c.o);
      } else if (o.type === 'stop') {
        if (buyish && c.h >= o.price) px = Math.max(o.price, c.o);
        if (!buyish && c.l <= o.price) px = Math.min(o.price, c.o);
      }
      if (px == null) continue;
      const had = mkt === 'fut' ? !!st.fut.pos[sym] : !!st.spot.hold[sym];
      const r = execOrder(st, o, px, t);
      if (!r.ok) continue;
      ev.push(r.fill);
      // 체결된 캔들 안에서 새로/늘어난 포지션의 손절·청산 (틱이면 o=h=l=c 라 영향 없음). 시가 체결(시장가)이면 캔들 전체가 진입 뒤라 익절도 확인
      const atOpen = px === c.o;
      if (!o.reduce && (mkt === 'fut' ? st.fut.pos[sym] : st.spot.hold[sym])) ev.push(mkt === 'fut' ? guardFut(st, sym, c, atOpen && !had) : guardSpot(st, sym, c, atOpen && !had));
    }
    return ev.filter(Boolean);
  }

  // 놓친 구간 처리: candles = {spot: {BTC: [...]}, fut: {BTC: [...]}} 각 캔들 {t,o,h,l,c}; 시간 순으로 섞어서 처리
  // funding = {BTC: [{t, rate, mark}]} — 그 시각의 포지션으로 정산되도록 캔들과 같은 시간축에서 처리 (같은 시각이면 펀딩 먼저)
  function catchUp(st, candles, upto, funding = {}) {
    const all = [];
    for (const mkt of ['spot', 'fut']) {
      for (const [sym, arr] of Object.entries(candles[mkt] || {})) {
        const from = st.seen[`${mkt}:${sym}`] ?? 0;
        for (const c of arr) if (c.t >= from && (!upto || c.t < upto)) all.push([c.t, 1, mkt, sym, c]);
      }
    }
    for (const [sym, arr] of Object.entries(funding)) for (const f of arr) if (!upto || f.t < upto) all.push([f.t, 0, 'fund', sym, f]);
    all.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1));
    const ev = [];
    for (const [, , mkt, sym, c] of all) {
      if (mkt === 'fund') { const a = applyFunding(st, sym, c.t, c.rate, c.mark); if (a) ev.push({ t: c.t, mkt: 'fut', sym, side: '펀딩', price: c.mark, qty: 0, amount: a, fee: 0, pnl: a, reason: '펀딩비', funding: true }); continue; }
      ev.push(...processCandle(st, mkt, sym, c));
      st.seen[`${mkt}:${sym}`] = c.t + (c.dur || 0);
    }
    return ev;
  }

  // 펀딩비: rate > 0 이면 롱이 냄, 숏이 받음 (명목가 × rate)
  function applyFunding(st, sym, t, rate, price) {
    const p = st.fut.pos[sym];
    const key = sym;
    if ((st.lastFunding[key] ?? 0) >= t) return null;
    st.lastFunding[key] = t;
    if (!p || t < p.opened) return null;
    const amt = p.qty * price * rate * (p.side === 'long' ? -1 : 1);
    st.fut.wallet += amt;
    if (st.fut.wallet < 0) { p.margin += st.fut.wallet; st.fut.wallet = 0; }   // 가용 잔고가 모자라면 포지션 증거금에서 (청산가가 가까워짐)
    const tr = trOf(st, p.tradeId);
    if (tr) tr.pnl += amt;
    st.funding.push({ t, sym, rate, amount: amt });
    if (st.funding.length > 2000) st.funding.splice(0, st.funding.length - 2000);
    return amt;
  }

  // ───────────────────────────── 일지 통계
  function stats(st, filter = {}) {
    const done = st.trades.filter((x) => x.status === 'closed' && (!filter.mkt || x.mkt === filter.mkt) && (!filter.by || x.by === filter.by));
    const group = (arr) => {
      const n = arr.length, w = arr.filter((x) => x.pnl > 0), l = arr.filter((x) => x.pnl <= 0);
      const sum = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
      const Rs = arr.filter((x) => x.R != null);
      return {
        n, win: n ? w.length / n : null, avgWin: w.length ? sum(w, 'pnl') / w.length : null, avgLoss: l.length ? sum(l, 'pnl') / l.length : null,
        payoff: w.length && l.length && sum(l, 'pnl') !== 0 ? (sum(w, 'pnl') / w.length) / Math.abs(sum(l, 'pnl') / l.length) : null,
        exp: n ? sum(arr, 'pnl') / n : null, expR: Rs.length ? sum(Rs, 'R') / Rs.length : null, nR: Rs.length,
        total: sum(arr, 'pnl'), rule: arr.filter((x) => x.ruleOk != null).length ? arr.filter((x) => x.ruleOk).length / arr.filter((x) => x.ruleOk != null).length : null,
      };
    };
    const bySetup = {};
    for (const x of done) (bySetup[x.setup || '미분류'] ||= []).push(x);
    const byEmotion = {};
    for (const x of done) (byEmotion[x.emotion || '미기록'] ||= []).push(x);
    const out = { all: group(done), setups: {}, emotions: {} };
    for (const [k, v] of Object.entries(bySetup)) out.setups[k] = group(v);
    for (const [k, v] of Object.entries(byEmotion)) out.emotions[k] = group(v);
    return out;
  }

  return { SYMS, FEE, MMR, SCHEMA, MIN_SPOT, newAccount, deposited, topUp, liqPrice, upnl, equity, spotBuy, spotSell, futOpen, futClose, futLiquidate, placeOrder, cancelOrder, execOrder, processCandle, catchUp, applyFunding, stats, trOf };
});
