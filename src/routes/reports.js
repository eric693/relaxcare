// 報表類端點：薪資、損益、費用、稅、回購、合規、到期、儀表板。
const express = require('express');
const { db, today, thisMonth, monthRange, shiftDate, audit, yuan, money, num, nowStamp } = require('../db');
const { requireStaff, requireAny } = require('../auth');
const payroll = require('../payroll');
const finance = require('../finance');
const compliance = require('../compliance');
const prepaid = require('../prepaid');
const rotation = require('../rotation');
const notify = require('../notify');
const { attach } = require('../crud');

const router = express.Router();

// ---- 儀表板 ----
router.get('/dashboard', requireStaff('dashboard'), (req, res) => {
  const d = req.query.date || today();
  const sid = req.query.store_id ? Number(req.query.store_id) : null;
  const period = d.slice(0, 7);
  const { start, end } = monthRange(period);
  const dayRev = finance.serviceRevenue(d, shiftDate(d, 1), sid);
  const monRev = finance.serviceRevenue(start, end, sid);
  const board = rotation.board(d, sid);
  const exp = compliance.expiry();
  res.json({
    date: d, period,
    today: {
      ...dayRev,
      cash: finance.cashFlow(d, shiftDate(d, 1), sid),
      booked: db.prepare("SELECT COUNT(*) n FROM tickets WHERE biz_date = ? AND status = 'booked'").get(d).n,
      serving: board.list.filter(x => x.status === 'serving').length,
      waiting: board.list.filter(x => x.status === 'waiting').length,
      on_duty: board.list.filter(x => x.status !== 'off').length,
      next: board.next ? { name: board.next.name, queue_seq: board.next.queue_seq, rounds: board.next.rounds } : null
    },
    month: { ...monRev, expenses: finance.expenses(start, end, sid).total },
    liability: prepaid.liability(sid),
    alerts: {
      cert_expired: exp.summary.expired, cert_soon: exp.summary.soon, cert_missing: exp.summary.missing,
      open_issues: db.prepare("SELECT COUNT(*) n FROM issues WHERE status <> 'closed'").get().n,
      new_bookings: db.prepare("SELECT COUNT(*) n FROM bookings WHERE status = 'new'").get().n,
      low_stock: db.prepare('SELECT COUNT(*) n FROM retail_products WHERE active = 1 AND stock <= safety_stock').get().n,
      // 漏結的營業日事後幾乎查不出短少是誰的班，所以它跟證照過期一樣要放在最前面
      unclosed_days: require('../closing').unclosed({ storeId: sid, days: 14 }).length,
      missing_invoices: require('../invoicing').enabled()
        ? require('../invoicing').missing({ from: shiftDate(d, -31), to: d, storeId: sid }).length : 0,
      consent_missing: require('../consent').audit_list({ storeId: sid })
        .filter(x => x.visits > 0 && x.status !== 'ok').length,
      repurchase: finance.repurchase({ storeId: sid }).length,
      expiring_passes: db.prepare(`SELECT COUNT(*) n FROM passes WHERE status='active'
        AND expiry_date <> '' AND expiry_date <= ? AND used_times < total_times`).get(shiftDate(d, 30)).n
    },
    trend: finance.daily(shiftDate(d, -29), shiftDate(d, 1), sid),
    top_therapists: finance.therapistRank(start, end, sid).slice(0, 8),
    top_services: finance.serviceRank(start, end, sid).slice(0, 8)
  });
});

// ---- 薪資 ----

router.get('/payroll', requireStaff('payroll'), (req, res) => {
  const period = req.query.period || thisMonth();
  const rows = db.prepare(`SELECT p.*, t.name, t.code, t.level, t.employ_type, s.name AS store_name
    FROM payrolls p JOIN therapists t ON t.id = p.therapist_id
    LEFT JOIN stores s ON s.id = p.store_id
    WHERE p.period = ? ORDER BY p.total DESC`).all(period);
  res.json({ period, rows, total: yuan(rows.reduce((s, r) => s + r.total, 0)) });
});

// 試算：不寫入資料庫，純粹算給人看
router.get('/payroll/preview/:therapistId', requireStaff('payroll'), (req, res) => {
  res.json(payroll.preview(Number(req.params.therapistId), req.query.period || thisMonth()));
});

router.get('/payroll/breakdown/:therapistId', requireStaff('payroll'), (req, res) => {
  res.json(payroll.breakdown(Number(req.params.therapistId), req.query.period || thisMonth()));
});

router.post('/payroll/generate', requireStaff('payroll'), (req, res) => {
  const period = req.body?.period || thisMonth();
  const out = payroll.generate({ period, therapistIds: req.body?.therapist_ids, actor: req.user.name });
  res.json(out);
});

router.put('/payroll/:id', requireStaff('payroll'), (req, res) => {
  const p = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到這筆薪資單' });
  if (p.status === 'paid') return res.status(400).json({ error: '已發放的薪資單不能修改' });
  const b = req.body || {};
  db.prepare('UPDATE payrolls SET adjust = ?, deduction = ?, note = ? WHERE id = ?')
    .run(yuan(b.adjust), yuan(b.deduction), String(b.note || ''), p.id);
  const out = payroll.recalcTotal(p.id);
  audit('staff', req.user.id, req.user.name, `調整薪資單 #${p.id}（${p.period}）：加項 ${yuan(b.adjust)}／扣項 ${yuan(b.deduction)}`);
  res.json(out);
});

// 確認與發放。確認之後重新產生就不會覆蓋 —— 確認過的數字就是對技師的承諾。
router.post('/payroll/:id/status', requireStaff('payroll'), (req, res) => {
  const p = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到這筆薪資單' });
  const st = req.body?.status;
  if (!['draft', 'confirmed', 'paid'].includes(st)) return res.status(400).json({ error: '狀態不正確' });
  db.prepare(`UPDATE payrolls SET status = ?, confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END,
              paid_at = CASE WHEN ? = 'paid' THEN ? ELSE paid_at END WHERE id = ?`)
    .run(st, st, nowStamp(), st, nowStamp(), p.id);
  audit('staff', req.user.id, req.user.name, `薪資單 #${p.id}（${p.period}）狀態改為 ${st}`);
  res.json(db.prepare('SELECT * FROM payrolls WHERE id = ?').get(p.id));
});

// ---- 抽成級距設定 ----
attach(router, {
  table: 'commission_tiers', module: 'commission', label: '業績級距',
  fields: ['level', 'min_amount', 'max_amount', 'bonus_pct', 'label'],
  nums: ['min_amount', 'max_amount', 'bonus_pct'], search: ['label', 'level'], order: 'level, min_amount'
});

// 級別預設抽成表（存在 settings 的 level_rates，這裡提供結構化的讀寫）
router.get('/commission/levels', requireStaff('commission'), (req, res) => {
  const { levelRates, getList } = require('../db');
  const rates = levelRates();
  res.json({
    levels: getList('therapist_levels').map(lv => ({ level: lv, ...(rates[lv] || { normal: 0, designated: 0, retail: 0, fee: 0 }) })),
    designate_fee_charge: num('designate_fee_charge', 0),
    prepaid_commission_pct: num('prepaid_commission_pct', 5)
  });
});

router.put('/commission/levels', requireStaff('commission'), (req, res) => {
  const { setSetting } = require('../db');
  const rows = req.body?.levels || [];
  const text = rows.map(r => `${r.level}=${Number(r.normal) || 0}|${Number(r.designated) || 0}|${Number(r.retail) || 0}|${Number(r.fee) || 0}`).join('\n');
  setSetting('level_rates', text);
  if (req.body.designate_fee_charge !== undefined) setSetting('designate_fee_charge', yuan(req.body.designate_fee_charge));
  if (req.body.prepaid_commission_pct !== undefined) setSetting('prepaid_commission_pct', Number(req.body.prepaid_commission_pct) || 0);
  audit('staff', req.user.id, req.user.name, '更新級別抽成設定');
  res.json({ ok: true });
});

// ---- 損益 ----

router.get('/finance', requireStaff('finance'), (req, res) => {
  const period = req.query.period || thisMonth();
  const sid = req.query.store_id ? Number(req.query.store_id) : null;
  const m = finance.monthly(period, sid);
  const { start, end } = monthRange(period);
  res.json({
    ...m,
    daily: finance.daily(start, end, sid),
    therapists: finance.therapistRank(start, end, sid),
    services: finance.serviceRank(start, end, sid),
    rooms: finance.roomUsage(start, end, sid)
  });
});

router.get('/tax', requireStaff('tax'), (req, res) => {
  res.json(finance.tax(req.query.period || thisMonth(), req.query.store_id ? Number(req.query.store_id) : null));
});

// 費用清單自己寫：expenses 沒有 active 欄位，crud 產生的預設篩選（active = 1）會直接爆，
// 而且費用要查的是期間，不是啟用與否。這支必須註冊在 attach 之前才會被優先命中。
router.get('/expenses', requireStaff('expenses'), (req, res) => {
  const where = [], args = [];
  if (req.query.from) { where.push('e.spend_date >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('e.spend_date <= ?'); args.push(req.query.to); }
  if (req.query.category) { where.push('e.category = ?'); args.push(req.query.category); }
  if (req.query.store_id) { where.push('e.store_id = ?'); args.push(req.query.store_id); }
  const q = (req.query.q || '').trim();
  if (q) { where.push('(e.vendor LIKE ? OR e.note LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  res.json(db.prepare(`SELECT e.*, s.name AS store_name FROM expenses e
    LEFT JOIN stores s ON s.id = e.store_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.spend_date DESC, e.id DESC LIMIT 500`).all(...args));
});

// 費用是流水帳，刪掉就是刪掉（沒有歷史單據會參照它），所以這裡是真刪，
// 不是 crud 預設的「停用」—— expenses 根本沒有 active 欄位。
router.delete('/expenses/:id', requireStaff('expenses'), (req, res) => {
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: '找不到這筆費用' });
  db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
  audit('staff', req.user.id, req.user.name, `刪除費用：${e.spend_date} ${e.category} ${yuan(e.amount)} 元`);
  res.json({ ok: true });
});

attach(router, {
  table: 'expenses', module: 'expenses', label: '費用',
  fields: ['store_id', 'spend_date', 'category', 'vendor', 'amount', 'pay_method', 'note'],
  nums: ['amount'], ids: ['store_id'], search: ['vendor', 'note', 'category'], order: 'spend_date DESC, id DESC'
});
// ---- 回購 ----
router.get('/repurchase', requireStaff('repurchase'), (req, res) => {
  res.json(finance.repurchase({
    days: req.query.days, storeId: req.query.store_id ? Number(req.query.store_id) : null,
    therapistId: req.query.therapist_id ? Number(req.query.therapist_id) : null
  }));
});

router.post('/repurchase/notify', requireStaff('repurchase'), async (req, res) => {
  const ids = req.body?.member_ids || [];
  if (!ids.length) return res.status(400).json({ error: '請選擇要推播的客人' });
  const list = finance.repurchase({ days: 0 });
  const map = Object.fromEntries(list.map(m => [m.id, m]));
  const out = [];
  for (const id of ids) {
    const m = map[id] || db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!m) continue;
    const text = notify.repurchaseText(m);
    const r = await notify.send({ targetType: 'member', targetId: m.id, targetName: m.name,
      lineUid: m.line_uid, title: '回訪問候', body: text, memberId: m.id });
    out.push({ member_id: m.id, name: m.name, ...r });
  }
  audit('staff', req.user.id, req.user.name, `回購推播 ${out.length} 位客人`);
  res.json({ sent: out });
});

router.get('/repurchase/preview/:memberId', requireStaff('repurchase'), (req, res) => {
  const m = finance.repurchase({ days: 0 }).find(x => String(x.id) === String(req.params.memberId))
    || db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.memberId);
  if (!m) return res.status(404).json({ error: '找不到這位客人' });
  res.json({ text: notify.repurchaseText(m) });
});

// ---- 法遵 ----
router.get('/compliance/scan', requireStaff('compliance'), (req, res) => res.json(compliance.scanAll()));
router.post('/compliance/check-text', requireStaff('compliance'), (req, res) => {
  res.json({ hits: compliance.scanText(req.body?.text || '') });
});
router.get('/compliance/consent', requireStaff('compliance'), (req, res) => res.json(compliance.consentAudit()));
router.get('/expiry', requireStaff('expiry'), (req, res) => res.json(compliance.expiry({ days: req.query.days })));

// 到期日就地編輯：只允許改到期相關欄位。
// 走專用端點是因為只有 expiry 權限的帳號沒有技師主檔的寫入權，不能叫他們去打 /therapists。
router.put('/expiry/:therapistId', requireStaff('expiry'), (req, res) => {
  const t = db.prepare('SELECT * FROM therapists WHERE id = ?').get(req.params.therapistId);
  if (!t) return res.status(404).json({ error: '找不到這位技師' });
  const b = req.body || {};
  const allowed = ['cert_no', 'cert_expiry', 'health_check_date', 'health_check_expiry'];
  const d = {};
  for (const f of allowed) if (b[f] !== undefined) d[f] = String(b[f]).trim();
  const keys = Object.keys(d);
  if (!keys.length) return res.status(400).json({ error: '沒有可更新的欄位' });
  db.prepare(`UPDATE therapists SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => d[k]), t.id);
  audit('staff', req.user.id, req.user.name, `更新 ${t.name} 的證照／健檢到期日`);
  res.json(db.prepare('SELECT * FROM therapists WHERE id = ?').get(t.id));
});

module.exports = router;
