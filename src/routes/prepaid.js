// 儲值金與次卡的操作端點。每一支都會寫流水與稽核 —— 預收的錢是最容易出爭議的部分。
const express = require('express');
const { db, audit, today, yuan, num } = require('../db');
const { requireStaff, requireAny } = require('../auth');
const prepaid = require('../prepaid');

const router = express.Router();
const actorOf = req => req.user.name;

// ---- 儲值 ----

router.get('/wallets', requireAny('wallets', 'liability'), (req, res) => {
  const q = (req.query.q || '').trim();
  const rows = db.prepare(`
    SELECT w.*, m.name, m.member_no, m.phone, m.store_id, s.name AS store_name,
           (SELECT MAX(created_at) FROM wallet_txns x WHERE x.member_id = m.id) AS last_txn
    FROM wallets w JOIN members m ON m.id = w.member_id
    LEFT JOIN stores s ON s.id = m.store_id
    WHERE (w.cash_balance <> 0 OR w.bonus_balance <> 0 OR ? <> '')
      AND (? = '' OR m.name LIKE ? OR m.phone LIKE ? OR m.member_no LIKE ?)
    ORDER BY (w.cash_balance + w.bonus_balance) DESC`)
    .all(q, q, `%${q}%`, `%${q}%`, `%${q}%`);
  const t = today();
  res.json(rows.map(r => ({
    ...r, total: yuan(r.cash_balance + r.bonus_balance),
    bonus_expired: !!(r.expiry_date && r.expiry_date < t && r.bonus_balance > 0)
  })));
});

router.get('/wallets/:memberId', requireAny('wallets', 'members', 'tickets'), (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.memberId);
  if (!m) return res.status(404).json({ error: '找不到這位客人' });
  res.json({
    member: m,
    balance: prepaid.walletBalance(m.id),
    txns: db.prepare(`SELECT x.*, t.ticket_no, th.name AS therapist_name, p.name AS peer_name
      FROM wallet_txns x
      LEFT JOIN tickets t ON t.id = x.ticket_id
      LEFT JOIN therapists th ON th.id = x.therapist_id
      LEFT JOIN members p ON p.id = x.peer_member_id
      WHERE x.member_id = ? ORDER BY x.id DESC LIMIT 200`).all(m.id)
  });
});

router.post('/wallets/topup', requireStaff('wallets'), (req, res) => {
  const b = req.body || {};
  if (!b.member_id) return res.status(400).json({ error: '請選擇客人' });
  const r = prepaid.topup({
    memberId: Number(b.member_id), amount: b.amount, bonus: b.bonus || 0,
    payMethod: b.pay_method, therapistId: b.therapist_id ? Number(b.therapist_id) : null,
    storeId: b.store_id ? Number(b.store_id) : null, note: b.note, actor: actorOf(req)
  });
  const m = db.prepare('SELECT name FROM members WHERE id = ?').get(b.member_id);
  audit('staff', req.user.id, req.user.name,
    `${m.name} 儲值 ${yuan(b.amount)} 元${b.bonus ? `（贈送 ${yuan(b.bonus)}）` : ''}，餘額 ${r.total}`);
  res.json(r);
});

router.post('/wallets/refund', requireStaff('wallets'), (req, res) => {
  const b = req.body || {};
  if (!b.member_id) return res.status(400).json({ error: '請選擇客人' });
  if (!String(b.note || '').trim()) return res.status(400).json({ error: '退款必須填寫原因' });
  const r = prepaid.refund({ memberId: Number(b.member_id), amount: b.amount,
    storeId: b.store_id ? Number(b.store_id) : null, note: b.note, actor: actorOf(req) });
  const m = db.prepare('SELECT name FROM members WHERE id = ?').get(b.member_id);
  audit('staff', req.user.id, req.user.name,
    `${m.name} 儲值退款 ${r.refunded} 元${r.fee ? `（手續費 ${r.fee}）` : ''}${r.bonus_void ? `，贈送金 ${r.bonus_void} 元作廢` : ''}：${b.note}`);
  res.json(r);
});

// 退款試算：先看清楚能退多少、贈送金會不會作廢，再按確定
router.get('/wallets/:memberId/refund-quote', requireStaff('wallets'), (req, res) => {
  const b = prepaid.walletBalance(req.params.memberId);
  const feePct = num('wallet_refund_fee_pct', 0);
  const want = req.query.amount ? Math.min(yuan(req.query.amount), b.cash) : b.cash;
  const fee = yuan(want * feePct / 100);
  res.json({
    balance: b, refundable_cash: b.cash, bonus_void: want >= b.cash ? b.bonus : 0,
    fee_pct: feePct, fee, payout: Math.max(0, want - fee),
    note: '贈送金不予退還；全額退款時剩餘贈送金一併作廢。'
  });
});

router.post('/wallets/transfer', requireStaff('wallets'), (req, res) => {
  const b = req.body || {};
  const r = prepaid.transfer({ fromId: Number(b.from_id), toId: Number(b.to_id), amount: b.amount,
    note: b.note, actor: actorOf(req) });
  audit('staff', req.user.id, req.user.name, `儲值轉讓 ${yuan(b.amount)} 元：#${b.from_id} → #${b.to_id}`);
  res.json(r);
});

router.post('/wallets/adjust', requireStaff('wallets'), (req, res) => {
  const b = req.body || {};
  if (!String(b.note || '').trim()) return res.status(400).json({ error: '人工調整必須填寫原因' });
  const memberId = Number(b.member_id);
  const w = prepaid.wallet(memberId);
  const cash = yuan(b.cash_delta), bonus = yuan(b.bonus_delta);
  const cashAfter = w.cash_balance + cash, bonusAfter = w.bonus_balance + bonus;
  if (cashAfter < 0 || bonusAfter < 0) return res.status(400).json({ error: '調整後餘額不能為負數' });
  db.prepare('UPDATE wallets SET cash_balance = ?, bonus_balance = ? WHERE member_id = ?')
    .run(cashAfter, bonusAfter, memberId);
  db.prepare(`INSERT INTO wallet_txns(member_id,kind,cash_delta,bonus_delta,amount,cash_after,bonus_after,note,actor)
    VALUES(?,'adjust',?,?,?,?,?,?,?)`)
    .run(memberId, cash, bonus, Math.abs(cash) + Math.abs(bonus), cashAfter, bonusAfter, b.note, actorOf(req));
  audit('staff', req.user.id, req.user.name, `人工調整儲值 #${memberId}：現金 ${cash >= 0 ? '+' : ''}${cash}／贈送 ${bonus >= 0 ? '+' : ''}${bonus}（${b.note}）`);
  res.json(prepaid.walletBalance(memberId));
});

// ---- 次卡 ----

router.get('/passes', requireAny('passes', 'liability'), (req, res) => {
  const where = [], args = [];
  if (req.query.member_id) { where.push('p.member_id = ?'); args.push(req.query.member_id); }
  if (req.query.status) { where.push('p.status = ?'); args.push(req.query.status); }
  if (req.query.store_id) { where.push('p.store_id = ?'); args.push(req.query.store_id); }
  const q = (req.query.q || '').trim();
  if (q) { where.push('(p.pass_no LIKE ? OR m.name LIKE ? OR m.phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(`
    SELECT p.*, m.name AS member_name, m.phone, s.name AS service_name, th.name AS sold_by_name
    FROM passes p
    LEFT JOIN members m ON m.id = p.member_id
    LEFT JOIN services s ON s.id = p.service_id
    LEFT JOIN therapists th ON th.id = p.sold_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.id DESC LIMIT 500`).all(...args);
  res.json(rows.map(p => ({
    ...p, remain: p.total_times - p.used_times,
    unit_value: prepaid.passUnitValue(p), real_status: prepaid.passStatus(p),
    days_left: p.expiry_date ? require('../db').dateDiff(today(), p.expiry_date) : null
  })));
});

router.get('/passes/:id', requireAny('passes', 'members'), (req, res) => {
  const p = prepaid.passOf(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到這張卡' });
  res.json({
    pass: { ...p, remain: p.total_times - p.used_times, unit_value: prepaid.passUnitValue(p), real_status: prepaid.passStatus(p) },
    txns: db.prepare(`SELECT x.*, t.ticket_no, m.name AS peer_name FROM pass_txns x
      LEFT JOIN tickets t ON t.id = x.ticket_id
      LEFT JOIN members m ON m.id = x.peer_member_id
      WHERE x.pass_id = ? ORDER BY x.id DESC`).all(p.id),
    refund_quote: prepaid.refundQuote(p.id)
  });
});

// 開單畫面用：這位客人現在能用哪幾張卡
router.get('/passes/usable/:memberId', requireAny('passes', 'tickets'), (req, res) => {
  res.json(prepaid.activePasses(req.params.memberId, req.query.service_id));
});

router.post('/passes', requireStaff('passes'), (req, res) => {
  const b = req.body || {};
  if (!b.member_id) return res.status(400).json({ error: '請選擇客人' });
  const p = prepaid.buyPass({
    memberId: Number(b.member_id), serviceId: b.service_id ? Number(b.service_id) : null,
    name: b.name, totalTimes: b.total_times, pricePaid: b.price_paid, listValue: b.list_value,
    expiryDate: b.expiry_date, soldBy: b.sold_by ? Number(b.sold_by) : null,
    storeId: b.store_id ? Number(b.store_id) : null,
    transferable: b.transferable === undefined ? 1 : Number(b.transferable), note: b.note, actor: actorOf(req)
  });
  const m = db.prepare('SELECT name FROM members WHERE id = ?').get(b.member_id);
  audit('staff', req.user.id, req.user.name, `${m.name} 購買次卡 ${p.pass_no}：${p.name} ${p.total_times} 次／${yuan(p.price_paid)} 元`);
  res.json(p);
});

router.post('/passes/:id/use', requireStaff('passes'), (req, res) => {
  const r = prepaid.usePass({ passId: Number(req.params.id), ticketId: req.body?.ticket_id || null,
    times: req.body?.times || 1, note: req.body?.note, actor: actorOf(req) });
  const p = prepaid.passOf(req.params.id);
  audit('staff', req.user.id, req.user.name, `次卡 ${p.pass_no} 核銷 ${req.body?.times || 1} 次，尚餘 ${r.remain} 次`);
  res.json(r);
});

router.get('/passes/:id/refund-quote', requireStaff('passes'), (req, res) => {
  res.json(prepaid.refundQuote(req.params.id, req.query.mode || 'unit'));
});

router.post('/passes/:id/refund', requireStaff('passes'), (req, res) => {
  if (!String(req.body?.note || '').trim()) return res.status(400).json({ error: '退卡必須填寫原因' });
  const q = prepaid.refundPass({ passId: Number(req.params.id), mode: req.body?.mode || 'unit',
    note: req.body.note, actor: actorOf(req) });
  audit('staff', req.user.id, req.user.name, `次卡 ${q.pass.pass_no} 退卡，退還 ${q.payout} 元：${req.body.note}`);
  res.json(q);
});

router.post('/passes/:id/transfer', requireStaff('passes'), (req, res) => {
  const p = prepaid.transferPass({ passId: Number(req.params.id), toMemberId: Number(req.body?.to_member_id),
    note: req.body?.note, actor: actorOf(req) });
  audit('staff', req.user.id, req.user.name, `次卡 ${p.pass_no} 轉讓給客人 #${req.body.to_member_id}`);
  res.json(p);
});

router.post('/passes/:id/extend', requireStaff('passes'), (req, res) => {
  const p = prepaid.extendPass({ passId: Number(req.params.id), newExpiry: req.body?.expiry_date,
    months: req.body?.months, note: req.body?.note, actor: actorOf(req) });
  audit('staff', req.user.id, req.user.name, `次卡 ${p.pass_no} 展延至 ${p.expiry_date}`);
  res.json(p);
});

// ---- 預收負債 ----
router.get('/liability', requireStaff('liability'), (req, res) => {
  const sid = req.query.store_id ? Number(req.query.store_id) : null;
  const l = prepaid.liability(sid);
  // 快到期的預收：這些是「差一點就變成店裡的錢」，也是最該打電話請客人回來用的
  const soon = require('../db').shiftDate(today(), 60);
  res.json({
    ...l,
    expiring_passes: db.prepare(`SELECT p.*, m.name AS member_name, m.phone FROM passes p
      LEFT JOIN members m ON m.id = p.member_id
      WHERE p.status = 'active' AND p.expiry_date <> '' AND p.expiry_date <= ?
      ORDER BY p.expiry_date`).all(soon)
      .map(p => ({ ...p, remain: p.total_times - p.used_times, unit_value: prepaid.passUnitValue(p) }))
      .filter(p => p.remain > 0),
    expiring_bonus: db.prepare(`SELECT w.*, m.name AS member_name, m.phone FROM wallets w
      JOIN members m ON m.id = w.member_id
      WHERE w.bonus_balance > 0 AND w.expiry_date <> '' AND w.expiry_date <= ?
      ORDER BY w.expiry_date`).all(soon)
  });
});

module.exports = router;
