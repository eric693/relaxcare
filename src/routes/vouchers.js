// 團購券：建檔、查詢、核銷、作廢、月結對帳。
const express = require('express');
const { db, today, audit, yuan, getList } = require('../db');
const { requireStaff, requireAny } = require('../auth');
const V = require('../vouchers');

const router = express.Router();

router.get('/vouchers', requireAny('vouchers', 'tickets'), (req, res) => {
  const where = [], args = [];
  for (const k of ['platform', 'status', 'batch', 'store_id', 'service_id']) {
    if (req.query[k]) { where.push(`v.${k} = ?`); args.push(req.query[k]); }
  }
  const q = (req.query.q || '').trim();
  if (q) {
    where.push('(v.code LIKE ? OR v.title LIKE ? OR v.buyer_name LIKE ? OR v.buyer_phone LIKE ? OR v.batch LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (req.query.from) { where.push('v.expiry_date >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('v.expiry_date <= ?'); args.push(req.query.to); }
  const rows = db.prepare(`SELECT v.*, s.name AS service_name, t.ticket_no, st.name AS store_name
    FROM vouchers v
    LEFT JOIN services s ON s.id = v.service_id
    LEFT JOIN tickets t ON t.id = v.ticket_id
    LEFT JOIN stores st ON st.id = v.store_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY v.id DESC LIMIT 500`).all(...args);
  res.json(rows.map(v => ({
    ...v, real_status: V.realStatus(v),
    days_left: v.expiry_date ? require('../db').dateDiff(today(), v.expiry_date) : null
  })));
});

// 櫃檯輸入券號查券：這是結帳畫面最常用的一支
router.get('/vouchers/lookup', requireAny('vouchers', 'tickets'), (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: '請輸入券號' });
  const rows = db.prepare(`SELECT v.*, s.name AS service_name FROM vouchers v
    LEFT JOIN services s ON s.id = v.service_id
    WHERE v.code = ?${req.query.platform ? ' AND v.platform = ?' : ''}`)
    .all(...(req.query.platform ? [code, req.query.platform] : [code]));
  if (!rows.length) return res.status(404).json({ error: `查無券號 ${code}，請確認平台與券號` });
  res.json(rows.map(v => ({
    ...v, real_status: V.realStatus(v),
    issues: V.checkUse(v, { serviceId: req.query.service_id })
  })));
});

router.post('/vouchers', requireStaff('vouchers'), (req, res) => {
  res.json(V.create(req.body || {}, req.user.name));
});

// 批次建檔：平台給的是一整張 CSV，一張一張打會打到天亮。
// 貼上「券號,面額,到期日」每行一筆即可。
router.post('/vouchers/bulk', requireStaff('vouchers'), (req, res) => {
  const b = req.body || {};
  const lines = String(b.lines || '').split('\n').map(x => x.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: '請貼上券號清單' });
  const out = { created: 0, skipped: [] };
  for (const line of lines) {
    const [code, face, expiry] = line.split(/[,\t]/).map(x => (x || '').trim());
    if (!code) continue;
    try {
      V.create({ ...b, code, face_value: face || b.face_value, expiry_date: expiry || b.expiry_date }, req.user.name);
      out.created++;
    } catch (e) { out.skipped.push({ code, reason: e.message }); }
  }
  audit('staff', req.user.id, req.user.name, `批次建立團購券：成功 ${out.created} 張，略過 ${out.skipped.length} 張`);
  res.json(out);
});

router.put('/vouchers/:id', requireStaff('vouchers'), (req, res) => {
  const v = V.voucherOf(req.params.id);
  if (!v) return res.status(404).json({ error: '找不到這張券' });
  if (v.status === 'used' || v.status === 'settled') {
    return res.status(400).json({ error: '已核銷的券不能修改，需要更正請先「取消核銷」' });
  }
  const b = req.body || {};
  const fields = ['batch', 'title', 'buyer_name', 'buyer_phone', 'issued_date', 'expiry_date', 'note'];
  const sets = [], args = [];
  for (const f of fields) if (b[f] !== undefined) { sets.push(`${f} = ?`); args.push(String(b[f])); }
  for (const f of ['face_value', 'net_receivable', 'commission_pct']) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); args.push(Number(b[f]) || 0); }
  }
  for (const f of ['service_id', 'store_id']) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); args.push(b[f] ? Number(b[f]) : null); }
  }
  if (sets.length) db.prepare(`UPDATE vouchers SET ${sets.join(', ')} WHERE id = ?`).run(...args, v.id);
  audit('staff', req.user.id, req.user.name, `修改團購券 ${v.platform} ${v.code}`);
  res.json(V.voucherOf(v.id));
});

// 作廢：不是真刪。券號是對外憑證，刪掉之後客人拿券來就查無此券，說不清楚。
router.delete('/vouchers/:id', requireStaff('vouchers'), (req, res) => {
  const v = V.voucherOf(req.params.id);
  if (!v) return res.status(404).json({ error: '找不到這張券' });
  if (v.status === 'used' || v.status === 'settled') {
    return res.status(400).json({ error: '已核銷的券不能作廢' });
  }
  db.prepare("UPDATE vouchers SET status = 'void' WHERE id = ?").run(v.id);
  audit('staff', req.user.id, req.user.name, `作廢團購券 ${v.platform} ${v.code}`);
  res.json({ ok: true });
});

// 取消核銷：櫃檯掃錯券是會發生的
router.post('/vouchers/:id/unuse', requireStaff('vouchers'), (req, res) => {
  const v = V.voucherOf(req.params.id);
  if (!v) return res.status(404).json({ error: '找不到這張券' });
  if (v.status !== 'used') return res.status(400).json({ error: '只有已核銷（未月結）的券可以取消核銷' });
  if (!String(req.body?.reason || '').trim()) return res.status(400).json({ error: '取消核銷必須填寫原因' });
  db.prepare("UPDATE vouchers SET status = 'unused', ticket_id = NULL, used_at = '' WHERE id = ?").run(v.id);
  audit('staff', req.user.id, req.user.name, `取消核銷團購券 ${v.platform} ${v.code}：${req.body.reason}`);
  res.json(V.voucherOf(v.id));
});

router.post('/vouchers/settle', requireStaff('vouchers'), (req, res) => {
  const n = V.settle({ ids: req.body?.ids || [], settledAt: req.body?.settled_at, actor: req.user.name });
  res.json({ settled: n });
});

router.get('/vouchers/reconcile', requireStaff('vouchers'), (req, res) => {
  res.json(V.reconcile({ from: req.query.from, to: req.query.to, platform: req.query.platform }));
});

module.exports = router;
