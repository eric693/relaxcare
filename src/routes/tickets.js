// 鐘單：開單 → 上鐘 → 加鐘／賣商品 → 結帳。
//
// 這是全系統唯一會同時動到「輪序、床位、預收餘額、抽成、庫存」的地方，
// 所以幾個原則寫在這裡一次講清楚：
//   · 開單前一律跑 gates.checkAll，硬衝突要填理由才放行，理由寫進 gate_note 與稽核。
//   · 結帳時把抽成算好寫死（見 commission.js 開頭的說明）。
//   · 付款順序固定：次卡 → 儲值 → 現金。先用會過期的東西，客人比較不會有損失感。
//   · 取消要把吃掉的輪次、扣掉的儲值、核銷掉的次數全部還回去，一件都不能漏。
const express = require('express');
const { db, today, nowStamp, addMinutes, minutesBetween, nextSerial, audit, num, getSetting, money, yuan } = require('../db');
const { requireStaff, requireAny } = require('../auth');
const gates = require('../gates');
const rotation = require('../rotation');
const prepaid = require('../prepaid');
const commission = require('../commission');
const notify = require('../notify');

const router = express.Router();
const actorOf = req => req.user.name;

const TICKET_FIELDS = ['store_id', 'member_id', 'guest_name', 'guest_phone', 'pax', 'therapist_id', 'room_id',
  'service_id', 'minutes', 'start_at', 'assign_type', 'source', 'discount', 'note'];

function pick(b) {
  const o = {};
  for (const f of TICKET_FIELDS) {
    if (b[f] === undefined) continue;
    if (['store_id', 'member_id', 'therapist_id', 'room_id', 'service_id'].includes(f)) {
      o[f] = (b[f] === '' || b[f] === null) ? null : (Number(b[f]) || null);
    } else if (['pax', 'minutes', 'discount'].includes(f)) o[f] = Number(b[f]) || 0;
    else o[f] = String(b[f]).trim();
  }
  return o;
}

function fullTicket(id) {
  const t = db.prepare(`
    SELECT t.*, m.name AS member_name, m.phone AS member_phone, m.line_uid AS member_line,
           m.pressure_pref, m.avoid_parts, m.conditions, m.health_note, m.health_updated_at,
           th.name AS therapist_name, th.code AS therapist_code, th.level AS therapist_level,
           r.name AS room_name, r.rtype AS room_type, st.name AS store_name, s.category AS service_category
    FROM tickets t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN therapists th ON th.id = t.therapist_id
    LEFT JOIN rooms r ON r.id = t.room_id
    LEFT JOIN stores st ON st.id = t.store_id
    LEFT JOIN services s ON s.id = t.service_id
    WHERE t.id = ?`).get(id);
  if (!t) return null;
  t.items = db.prepare(`SELECT i.*, th.name AS therapist_name FROM ticket_items i
    LEFT JOIN therapists th ON th.id = i.therapist_id WHERE i.ticket_id = ? ORDER BY i.id`).all(id);
  t.pass_txns = db.prepare('SELECT * FROM pass_txns WHERE ticket_id = ? ORDER BY id').all(id);
  t.wallet_txns = db.prepare('SELECT * FROM wallet_txns WHERE ticket_id = ? ORDER BY id').all(id);
  return t;
}

// 依主項與明細重算金額。任何一次改動之後都呼叫這個，金額才不會各處各算一套。
function recalc(id) {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  const items = db.prepare('SELECT * FROM ticket_items WHERE ticket_id = ?').all(id);
  const svc = t.service_id ? db.prepare('SELECT * FROM services WHERE id = ?').get(t.service_id) : null;
  const basePrice = t.service_id ? yuan(svc?.price) : yuan(t.amount);
  const addService = items.filter(i => i.kind !== 'retail').reduce((s, i) => s + yuan(i.amount), 0);
  const retail = items.filter(i => i.kind === 'retail').reduce((s, i) => s + yuan(i.amount), 0);
  const addMin = items.filter(i => i.kind !== 'retail').reduce((s, i) => s + (Number(i.minutes) || 0), 0);
  const baseMin = t.service_id ? (Number(svc?.minutes) || t.minutes) : t.minutes;
  const amount = basePrice + addService;
  const net = Math.max(0, amount + retail + yuan(t.designate_fee) - yuan(t.discount));
  const minutes = baseMin + addMin;
  db.prepare(`UPDATE tickets SET amount = ?, retail_amount = ?, net_amount = ?, minutes = ?,
              end_at = CASE WHEN start_at <> '' THEN ? ELSE end_at END WHERE id = ?`)
    .run(amount, retail, net, minutes, t.start_at ? addMinutes(t.start_at, minutes) : '', id);
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

// ---- 查詢 ----

router.get('/tickets', requireAny('tickets', 'board', 'dashboard', 'finance'), (req, res) => {
  const where = [], args = [];
  const dateExpr = "substr(COALESCE(NULLIF(t.actual_start,''), t.start_at),1,10)";
  if (req.query.date) { where.push(`${dateExpr} = ?`); args.push(req.query.date); }
  if (req.query.from) { where.push(`${dateExpr} >= ?`); args.push(req.query.from); }
  if (req.query.to) { where.push(`${dateExpr} <= ?`); args.push(req.query.to); }
  for (const k of ['status', 'therapist_id', 'room_id', 'member_id', 'store_id', 'assign_type', 'service_id']) {
    if (req.query[k]) { where.push(`t.${k} = ?`); args.push(req.query[k]); }
  }
  const q = (req.query.q || '').trim();
  if (q) { where.push('(t.ticket_no LIKE ? OR t.guest_name LIKE ? OR m.name LIKE ? OR m.phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(`
    SELECT t.*, COALESCE(m.name, t.guest_name) AS customer, m.phone AS member_phone,
           th.name AS therapist_name, r.name AS room_name, st.name AS store_name
    FROM tickets t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN therapists th ON th.id = t.therapist_id
    LEFT JOIN rooms r ON r.id = t.room_id
    LEFT JOIN stores st ON st.id = t.store_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.start_at DESC, t.id DESC LIMIT 500`).all(...args);
  res.json(rows);
});

router.get('/tickets/:id', requireAny('tickets', 'board'), (req, res) => {
  const t = fullTicket(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張鐘單' });
  res.json(t);
});

// 開單前的閘門預檢。前端在選完技師／項目／時間之後就呼叫，先把問題攤開來給人看。
router.post('/tickets/check', requireStaff('tickets'), (req, res) => {
  const b = req.body || {};
  const svc = b.service_id ? db.prepare('SELECT * FROM services WHERE id = ?').get(b.service_id) : null;
  const minutes = Number(b.minutes) || Number(svc?.minutes) || 60;
  const start = b.start_at || nowStamp();
  res.json({
    ...gates.checkAll({
      ...b, minutes, start_at: start, end_at: addMinutes(start, minutes),
      net_amount: b.net_amount !== undefined ? b.net_amount : yuan(svc?.price)
    }),
    queue: rotation.board(start.slice(0, 10), b.store_id ? Number(b.store_id) : null)
  });
});

// ---- 開單 ----

const createTicket = db.transaction((d, opts) => {
  const svc = d.service_id ? db.prepare('SELECT * FROM services WHERE id = ?').get(d.service_id) : null;
  const minutes = d.minutes || Number(svc?.minutes) || 60;
  const start = d.start_at || nowStamp();
  const designated = d.assign_type === 'designated';
  // 向客人加收的指名費。設定為 0 就是不加收（很多店只在技師端給指名獎金，不向客人收）。
  const fee = designated ? num('designate_fee_charge', 0) : 0;
  const no = nextSerial('T', start.slice(0, 10));
  const info = db.prepare(`INSERT INTO tickets(ticket_no,store_id,member_id,guest_name,guest_phone,pax,
      therapist_id,room_id,service_id,service_name,minutes,start_at,end_at,assign_type,designate_fee,
      status,source,amount,net_amount,discount,note,gate_note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(no, d.store_id || null, d.member_id || null, d.guest_name || '', d.guest_phone || '', d.pax || 1,
      d.therapist_id || null, d.room_id || null, d.service_id || null, svc?.name || d.service_name || '',
      minutes, start, addMinutes(start, minutes), d.assign_type || 'rotation', fee,
      opts.status || 'booked', d.source || '現場', yuan(svc?.price), 0, d.discount || 0,
      d.note || '', opts.gateNote || '', opts.actor);
  recalc(info.lastInsertRowid);
  // 立刻開始服務的單（現場客人）才推進輪序；預約單等到真的上鐘再推
  if (opts.status === 'serving' && d.therapist_id) {
    rotation.consume({ therapistId: d.therapist_id, workDate: start.slice(0, 10),
      assignType: d.assign_type || 'rotation', ticketId: info.lastInsertRowid, actor: opts.actor });
    db.prepare('UPDATE tickets SET actual_start = ? WHERE id = ?').run(nowStamp(), info.lastInsertRowid);
  }
  return info.lastInsertRowid;
});

router.post('/tickets', requireStaff('tickets'), (req, res) => {
  const d = pick(req.body || {});
  if (!d.service_id) return res.status(400).json({ error: '請選擇服務項目' });
  if (!d.member_id && !d.guest_name) return res.status(400).json({ error: '請選擇會員或填寫客人姓名' });
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(d.service_id);
  const minutes = d.minutes || svc.minutes;
  const start = d.start_at || nowStamp();
  const check = gates.checkAll({ ...d, minutes, start_at: start, end_at: addMinutes(start, minutes) });
  // 硬衝突要嘛不要開，要嘛填理由。理由會留在單子上，日後出事查得到是誰放行的。
  if (!check.ok && !String(req.body.gate_note || '').trim()) {
    return res.status(400).json({ error: '有硬衝突，若確定要開單請填寫放行理由', check });
  }
  const startNow = req.body.start_now ? 'serving' : 'booked';
  const id = createTicket({ ...d, minutes, start_at: start },
    { status: startNow, gateNote: String(req.body.gate_note || '').trim(), actor: actorOf(req) });
  const t = fullTicket(id);
  audit('staff', req.user.id, req.user.name,
    `開立鐘單 ${t.ticket_no}：${t.customer_name || t.member_name || t.guest_name} ${t.service_name} ${t.assign_type === 'designated' ? '（指名）' : ''}`
    + (check.ok ? '' : `｜強制放行：${req.body.gate_note}`));
  res.json({ ticket: t, check });
});

router.put('/tickets/:id', requireStaff('tickets'), (req, res) => {
  const cur = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這張鐘單' });
  if (cur.status === 'done') return res.status(400).json({ error: '已完成的鐘單不能修改，請改用退單或客訴處理' });
  const d = pick(req.body || {});
  const merged = { ...cur, ...d, ticket_id: cur.id };
  const check = gates.checkAll(merged);
  if (!check.ok && !String(req.body.gate_note || '').trim()) {
    return res.status(400).json({ error: '有硬衝突，若確定要修改請填寫放行理由', check });
  }
  if (d.service_id && d.service_id !== cur.service_id) {
    const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(d.service_id);
    d.service_name = svc?.name || '';
    if (!d.minutes) d.minutes = svc?.minutes || cur.minutes;
  }
  // 改成指名／改回輪鐘，加收的指名費要跟著變
  if (d.assign_type && d.assign_type !== cur.assign_type) {
    d.designate_fee = d.assign_type === 'designated' ? num('designate_fee_charge', 0) : 0;
  }
  if (req.body.gate_note) d.gate_note = String(req.body.gate_note).trim();
  const keys = Object.keys(d);
  if (keys.length) {
    db.prepare(`UPDATE tickets SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map(k => d[k]), req.params.id);
  }
  recalc(req.params.id);
  audit('staff', req.user.id, req.user.name, `修改鐘單 ${cur.ticket_no}`);
  res.json({ ticket: fullTicket(req.params.id), check });
});

// 上鐘：把預約單推成服務中，這一刻才吃輪序。
router.post('/tickets/:id/start', requireStaff('tickets'), (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張鐘單' });
  if (t.status !== 'booked') return res.status(400).json({ error: `目前狀態為「${t.status}」，不能上鐘` });
  if (!t.therapist_id) return res.status(400).json({ error: '請先指派技師' });
  const check = gates.checkAll({ ...t, ticket_id: t.id });
  if (!check.ok && !String(req.body?.gate_note || '').trim()) {
    return res.status(400).json({ error: '有硬衝突，若確定要上鐘請填寫放行理由', check });
  }
  const now = nowStamp();
  db.prepare(`UPDATE tickets SET status = 'serving', actual_start = ?,
              gate_note = CASE WHEN ? <> '' THEN ? ELSE gate_note END WHERE id = ?`)
    .run(now, String(req.body?.gate_note || ''), String(req.body?.gate_note || ''), t.id);
  rotation.consume({ therapistId: t.therapist_id, workDate: (t.start_at || now).slice(0, 10),
    assignType: t.assign_type, ticketId: t.id, actor: actorOf(req) });
  audit('staff', req.user.id, req.user.name, `${t.ticket_no} 上鐘`);
  res.json({ ticket: fullTicket(t.id), check });
});

// ---- 明細（加鐘、加項、商品）----

router.post('/tickets/:id/items', requireStaff('tickets'), (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張鐘單' });
  if (t.status === 'done') return res.status(400).json({ error: '已結帳的鐘單不能再加項目' });
  const b = req.body || {};
  const kind = ['service', 'addon', 'retail'].includes(b.kind) ? b.kind : 'service';
  let name = String(b.name || '').trim(), unit = Number(b.unit_price) || 0, minutes = Number(b.minutes) || 0;
  const qty = Number(b.qty) || 1;
  const refId = b.ref_id ? Number(b.ref_id) : null;
  if (kind === 'retail' && refId) {
    const p = db.prepare('SELECT * FROM retail_products WHERE id = ?').get(refId);
    if (!p) return res.status(400).json({ error: '找不到這項商品' });
    if (p.stock < qty) return res.status(400).json({ error: `${p.name} 庫存只剩 ${p.stock} 件` });
    name = name || p.name; unit = unit || yuan(p.price);
  } else if (kind !== 'retail' && refId) {
    const s = db.prepare('SELECT * FROM services WHERE id = ?').get(refId);
    if (s) { name = name || s.name; unit = unit || yuan(s.price); minutes = minutes || s.minutes; }
  }
  if (!name) return res.status(400).json({ error: '請填寫項目名稱' });
  const amount = money(unit * qty);
  const info = db.prepare(`INSERT INTO ticket_items(ticket_id,kind,ref_id,name,minutes,qty,unit_price,amount,therapist_id,note)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(t.id, kind, refId, name, minutes, qty, unit, amount,
      b.therapist_id ? Number(b.therapist_id) : null, String(b.note || ''));
  // 商品出貨即扣庫存。結帳失敗要回沖，所以取消鐘單時也要記得加回去（見下方 cancel）。
  if (kind === 'retail' && refId) db.prepare('UPDATE retail_products SET stock = stock - ? WHERE id = ?').run(qty, refId);
  recalc(t.id);
  // 加鐘會讓結束時間往後，可能撞到下一張單；順手檢查，不擋，但要講
  const after = db.prepare('SELECT * FROM tickets WHERE id = ?').get(t.id);
  const check = kind !== 'retail'
    ? gates.checkAll({ ...after, ticket_id: after.id })
    : { issues: [], conflicts: [], warnings: [], ok: true };
  audit('staff', req.user.id, req.user.name, `${t.ticket_no} 新增${kind === 'retail' ? '商品' : '加鐘／加項'}：${name} x${qty}`);
  res.json({ ticket: fullTicket(t.id), item_id: info.lastInsertRowid, check });
});

router.delete('/tickets/:id/items/:itemId', requireStaff('tickets'), (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  const i = db.prepare('SELECT * FROM ticket_items WHERE id = ? AND ticket_id = ?').get(req.params.itemId, req.params.id);
  if (!t || !i) return res.status(404).json({ error: '找不到這個項目' });
  if (t.status === 'done') return res.status(400).json({ error: '已結帳的鐘單不能刪除項目' });
  if (i.kind === 'retail' && i.ref_id) db.prepare('UPDATE retail_products SET stock = stock + ? WHERE id = ?').run(i.qty, i.ref_id);
  db.prepare('DELETE FROM ticket_items WHERE id = ?').run(i.id);
  recalc(t.id);
  audit('staff', req.user.id, req.user.name, `${t.ticket_no} 刪除項目：${i.name}`);
  res.json(fullTicket(t.id));
});

// ---- 結帳 ----

// 結帳試算：付款怎麼拆、抽成多少，先算給人看再按確定。
function quote(ticketId, body = {}) {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  const items = db.prepare('SELECT * FROM ticket_items WHERE ticket_id = ?').all(ticketId);
  const discount = body.discount !== undefined ? yuan(body.discount) : yuan(t.discount);
  const net = Math.max(0, yuan(t.amount) + yuan(t.retail_amount) + yuan(t.designate_fee) - discount);

  // 付款順序：次卡 → 儲值 → 現金
  let remain = net, paidPass = 0, paidWallet = 0;
  const passId = body.pass_id ? Number(body.pass_id) : null;
  let passInfo = null;
  if (passId) {
    const p = prepaid.passOf(passId);
    if (p) {
      const times = Number(body.pass_times) || 1;
      const value = money(prepaid.passUnitValue(p) * times);
      // 次卡只抵服務，不抵商品：商品是另外買的東西
      const serviceOnly = Math.max(0, net - yuan(t.retail_amount));
      paidPass = Math.min(value, serviceOnly);
      remain = Math.max(0, net - paidPass);
      passInfo = { pass_no: p.pass_no, times, unit_value: prepaid.passUnitValue(p), value,
        remain_after: p.total_times - p.used_times - times };
    }
  }
  let walletInfo = null;
  if (body.use_wallet && t.member_id) {
    const b = prepaid.walletBalance(t.member_id);
    const want = body.wallet_amount !== undefined && body.wallet_amount !== ''
      ? Math.min(yuan(body.wallet_amount), remain) : remain;
    paidWallet = Math.min(want, b.total);
    remain = Math.max(0, remain - paidWallet);
    walletInfo = { balance: b, use_bonus: Math.min(b.bonus, paidWallet), use_cash: Math.max(0, paidWallet - b.bonus) };
  }
  const comm = commission.computeTicket({ ...t, discount }, items);
  return {
    ticket: t, items, discount, net_amount: net,
    paid_pass: paidPass, paid_wallet: paidWallet, paid_cash: remain,
    pass: passInfo, wallet: walletInfo, commission: comm,
    // 店裡實際留下的：營收扣掉技師抽成
    store_margin: money(net - comm.total)
  };
}

router.post('/tickets/:id/quote', requireStaff('tickets'), (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張鐘單' });
  res.json(quote(t.id, req.body || {}));
});

const doCheckout = db.transaction((ticketId, body, actor) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  const q = quote(ticketId, body);

  if (q.pass) {
    prepaid.usePass({ passId: Number(body.pass_id), ticketId, times: Number(body.pass_times) || 1,
      note: `${t.ticket_no} 核銷`, actor });
  }
  if (q.paid_wallet > 0) {
    prepaid.consume({ memberId: t.member_id, amount: q.paid_wallet, ticketId, storeId: t.store_id,
      note: `${t.ticket_no} 消費扣款`, actor });
  }

  const comm = q.commission;
  const now = nowStamp();
  db.prepare(`UPDATE tickets SET status='done', actual_start = COALESCE(NULLIF(actual_start,''), ?),
      actual_end = ?, discount = ?, net_amount = ?, paid_cash = ?, paid_wallet = ?, paid_pass = ?,
      pay_method = ?, comm_service = ?, comm_retail = ?, comm_designate = ?, comm_pct_used = ?,
      rating = ?, feedback = ? WHERE id = ?`)
    .run(t.actual_start || now, now, q.discount, q.net_amount, q.paid_cash, q.paid_wallet, q.paid_pass,
      String(body.pay_method || (q.paid_cash > 0 ? '現金' : q.paid_pass > 0 ? '次卡核銷' : '儲值扣款')),
      comm.comm_service, comm.comm_retail, comm.comm_designate, comm.pct_used,
      Number(body.rating) || 0, String(body.feedback || ''), ticketId);

  // 明細的抽成逐項寫回，薪資頁要能一筆一筆攤開來看
  for (const d of comm.detail) {
    if (d.item_id) {
      db.prepare('UPDATE ticket_items SET comm_pct = ?, comm_amount = ? WHERE id = ?')
        .run(d.pct, d.amount, d.item_id);
    }
  }

  if (t.therapist_id) {
    rotation.release({ therapistId: t.therapist_id, workDate: (t.actual_start || t.start_at || now).slice(0, 10),
      ticketId, actor });
  }
  return q;
});

router.post('/tickets/:id/checkout', requireStaff('tickets'), (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張鐘單' });
  if (t.status === 'done') return res.status(400).json({ error: '這張鐘單已經結帳了' });
  if (t.status === 'cancelled') return res.status(400).json({ error: '已取消的鐘單不能結帳' });
  const b = req.body || {};
  const check = gates.checkPayment({
    memberId: t.member_id, serviceId: t.service_id,
    useWallet: b.use_wallet, walletAmount: b.wallet_amount, passId: b.pass_id, amount: t.net_amount
  });
  if (check.some(i => i.level === 'conflict')) {
    return res.status(400).json({ error: check.find(i => i.level === 'conflict').message, check: { issues: check } });
  }
  const q = doCheckout(t.id, b, actorOf(req));
  audit('staff', req.user.id, req.user.name,
    `${t.ticket_no} 結帳 ${q.net_amount} 元（現金 ${q.paid_cash}／儲值 ${q.paid_wallet}／次卡 ${q.paid_pass}），技師抽成 ${q.commission.total} 元`);
  res.json({ ticket: fullTicket(t.id), quote: q });
});

// ---- 取消 ----
// 要還的東西：輪次、儲值扣款、次卡核銷、商品庫存。漏掉任何一項都會有人來吵。
const doCancel = db.transaction((ticketId, reason, status, actor) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (t.member_id) {
    prepaid.refundConsume({ memberId: t.member_id, ticketId, note: `${t.ticket_no} ${status === 'noshow' ? '未到' : '取消'}回沖`, actor });
  }
  prepaid.voidPassUse({ ticketId, actor });
  for (const i of db.prepare("SELECT * FROM ticket_items WHERE ticket_id = ? AND kind = 'retail'").all(ticketId)) {
    if (i.ref_id) db.prepare('UPDATE retail_products SET stock = stock + ? WHERE id = ?').run(i.qty, i.ref_id);
  }
  if (t.therapist_id && ['serving', 'done'].includes(t.status)) {
    rotation.rollback({ therapistId: t.therapist_id, workDate: (t.actual_start || t.start_at).slice(0, 10),
      ticketId, assignType: t.assign_type, actor, reason: `${t.ticket_no} 取消` });
  }
  db.prepare(`UPDATE tickets SET status = ?, paid_cash = 0, paid_wallet = 0, paid_pass = 0,
      comm_service = 0, comm_retail = 0, comm_designate = 0,
      note = TRIM(note || ' ｜' || ?) WHERE id = ?`)
    .run(status, `${status === 'noshow' ? '未到' : '取消'}：${reason}`, ticketId);
  db.prepare('UPDATE ticket_items SET comm_amount = 0 WHERE ticket_id = ?').run(ticketId);
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
});

router.post('/tickets/:id/cancel', requireStaff('tickets'), (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張鐘單' });
  if (t.status === 'cancelled') return res.status(400).json({ error: '這張鐘單已經取消了' });
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: '請填寫取消原因' });
  const status = req.body?.noshow ? 'noshow' : 'cancelled';
  doCancel(t.id, reason, status, actorOf(req));
  audit('staff', req.user.id, req.user.name, `${t.ticket_no} ${status === 'noshow' ? '標記未到' : '取消'}：${reason}`);
  res.json(fullTicket(t.id));
});

// ---- 排鐘看板 ----
// 一天之內每位技師與每個床位的時間軸。調度看這張圖決定下一個客人塞哪裡。
router.get('/board', requireAny('board', 'tickets', 'dashboard'), (req, res) => {
  const d = req.query.date || today();
  const sid = req.query.store_id ? Number(req.query.store_id) : null;
  const store = sid ? db.prepare('SELECT * FROM stores WHERE id = ?').get(sid) : null;
  const rows = db.prepare(`
    SELECT t.*, COALESCE(m.name, t.guest_name) AS customer, th.name AS therapist_name, r.name AS room_name
    FROM tickets t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN therapists th ON th.id = t.therapist_id
    LEFT JOIN rooms r ON r.id = t.room_id
    WHERE substr(t.start_at,1,10) = ? AND t.status IN ('booked','serving','done')
      AND (? IS NULL OR t.store_id = ?)
    ORDER BY t.start_at`).all(d, sid, sid);
  res.json({
    date: d,
    open_time: store?.open_time || getSetting('board_open', '10:00'),
    close_time: store?.close_time || getSetting('board_close', '23:00'),
    slot_min: num('slot_min', 15),
    therapists: db.prepare(`SELECT t.id, t.code, t.name, t.level, s.status AS shift_status, s.queue_seq, s.rounds
      FROM therapists t LEFT JOIN shifts s ON s.therapist_id = t.id AND s.work_date = ?
      WHERE t.active = 1 AND (? IS NULL OR t.store_id = ?) ORDER BY s.queue_seq, t.code`).all(d, sid, sid),
    rooms: db.prepare(`SELECT * FROM rooms WHERE active = 1 AND (? IS NULL OR store_id = ?)
      ORDER BY seq, name`).all(sid, sid),
    tickets: rows
  });
});

// 發預約確認／班表通知
router.post('/tickets/:id/notify', requireStaff('tickets'), async (req, res) => {
  const t = fullTicket(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張鐘單' });
  const built = notify.bookingText(t.id);
  const r = await notify.send({
    targetType: 'member', targetId: t.member_id, targetName: t.member_name || t.guest_name,
    lineUid: t.member_line, title: '預約確認', body: built.text, ticketId: t.id, memberId: t.member_id
  });
  audit('staff', req.user.id, req.user.name, `${t.ticket_no} 發送預約確認（${r.status}）`);
  res.json({ ...r, text: built.text });
});

router.get('/tickets/:id/notify-preview', requireStaff('tickets'), (req, res) => {
  const built = notify.bookingText(req.params.id);
  if (!built) return res.status(404).json({ error: '找不到這張鐘單' });
  res.json({ text: built.text });
});

module.exports = router;
