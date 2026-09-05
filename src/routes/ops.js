// 日結交班、班表、同意書、點數與介紹、發票、附件檔案。
const express = require('express');
const { db, audit, today, thisMonth, bizDate, yuan, getSetting } = require('../db');
const { requireStaff, requireAny } = require('../auth');
const closing = require('../closing');
const roster = require('../roster');
const consent = require('../consent');
const loyalty = require('../loyalty');
const invoicing = require('../invoicing');
const storage = require('../storage');

const router = express.Router();
const actorOf = req => req.user.name;

// ================= 日結與交班 =================

// 試算：這一班應該有多少現金。點鈔之前先看這個數字。
router.get('/closing/preview', requireStaff('closing'), (req, res) => {
  res.json({
    ...closing.compute({
      storeId: req.query.store_id ? Number(req.query.store_id) : null,
      bizDate: req.query.biz_date, fromAt: req.query.from_at, toAt: req.query.to_at,
      openFloat: req.query.open_float
    }),
    denoms: closing.DENOMS,
    shift_labels: closing.shiftLabels(),
    cash_methods: closing.cashMethods(),
    card_methods: closing.cardMethods()
  });
});

router.get('/closing', requireStaff('closing'), (req, res) => {
  res.json({
    rows: closing.list(req.query || {}),
    unclosed: closing.unclosed({ storeId: req.query.store_id ? Number(req.query.store_id) : null }),
    summary: closing.summary({ from: req.query.from, to: req.query.to,
      storeId: req.query.store_id ? Number(req.query.store_id) : null })
  });
});

router.get('/closing/:id', requireStaff('closing'), (req, res) => {
  const c = closing.get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到這張日結單' });
  res.json(c);
});

router.post('/closing', requireStaff('closing'), (req, res) => {
  res.json(closing.create({ ...(req.body || {}), actor: actorOf(req) }));
});

router.post('/closing/:id/void', requireStaff('closing'), (req, res) => {
  res.json(closing.voidClosing({ id: Number(req.params.id), reason: req.body?.reason, actor: actorOf(req) }));
});

// ================= 班表 =================

router.get('/roster', requireAny('roster', 'attendance', 'queue'), (req, res) => {
  res.json(roster.grid({ from: req.query.from, to: req.query.to,
    storeId: req.query.store_id ? Number(req.query.store_id) : null }));
});

router.get('/roster/compare', requireAny('roster', 'attendance'), (req, res) => {
  res.json(roster.compare({ from: req.query.from, to: req.query.to,
    storeId: req.query.store_id ? Number(req.query.store_id) : null }));
});

router.get('/roster/demand', requireAny('roster', 'attendance', 'dashboard'), (req, res) => {
  res.json(roster.demand({ from: req.query.from, to: req.query.to,
    storeId: req.query.store_id ? Number(req.query.store_id) : null }));
});

router.put('/roster', requireStaff('roster'), (req, res) => {
  const b = req.body || {};
  if (Array.isArray(b.cells)) {
    return res.json(roster.bulkSet({ cells: b.cells,
      storeId: b.store_id ? Number(b.store_id) : null, actor: actorOf(req) }));
  }
  res.json(roster.set({ workDate: b.work_date, therapistId: Number(b.therapist_id),
    shiftCode: b.shift_code, startTime: b.start_time, endTime: b.end_time,
    storeId: b.store_id ? Number(b.store_id) : null, note: b.note, actor: actorOf(req) }));
});

router.post('/roster/copy', requireStaff('roster'), (req, res) => {
  const b = req.body || {};
  res.json(roster.copyWeek({ fromStart: b.from_start, toStart: b.to_start,
    storeId: b.store_id ? Number(b.store_id) : null, overwrite: !!b.overwrite, actor: actorOf(req) }));
});

// ================= 同意書 =================

router.get('/consents', requireAny('compliance', 'members'), (req, res) => {
  if (req.query.member_id) {
    return res.json({
      text: consent.currentText(),
      status: consent.statusOf(Number(req.query.member_id)),
      rows: consent.listFor(Number(req.query.member_id))
    });
  }
  res.json({
    text: consent.currentText(),
    valid_months: consent.validMonths(),
    rows: consent.audit_list({ storeId: req.query.store_id ? Number(req.query.store_id) : null })
  });
});

router.get('/consents/:id', requireAny('compliance', 'members'), (req, res) => {
  const c = consent.get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到這張同意書' });
  res.json(c);
});

router.post('/consents', requireAny('members', 'tickets', 'compliance'), (req, res) => {
  const b = req.body || {};
  res.json(consent.sign({
    memberId: Number(b.member_id), ticketId: b.ticket_id ? Number(b.ticket_id) : null,
    storeId: b.store_id ? Number(b.store_id) : null,
    signature: b.signature, signerName: b.signer_name, note: b.note, actor: actorOf(req)
  }));
});

// ================= 點數與介紹 =================

router.get('/loyalty', requireStaff('loyalty'), (req, res) => {
  res.json({ ...loyalty.summary(), referrals: loyalty.referrals({}) });
});

router.get('/loyalty/member/:id', requireAny('loyalty', 'members'), (req, res) => {
  const id = Number(req.params.id);
  res.json({
    balance: loyalty.balanceOf(id),
    txns: loyalty.txnsOf(id),
    referrals: loyalty.referrals({ memberId: id }),
    rules: loyalty.summary().rules
  });
});

router.post('/loyalty/redeem', requireStaff('loyalty'), (req, res) => {
  const b = req.body || {};
  res.json(loyalty.redeem({ memberId: Number(b.member_id), points: b.points, note: b.note, actor: actorOf(req) }));
});

router.post('/loyalty/adjust', requireStaff('loyalty'), (req, res) => {
  const b = req.body || {};
  res.json(loyalty.adjustPoints({ memberId: Number(b.member_id), points: b.points,
    reason: b.reason, actor: actorOf(req) }));
});

router.post('/loyalty/reconcile', requireStaff('loyalty'), (req, res) => {
  res.json(loyalty.reconcile({ fix: !!req.body?.fix, actor: actorOf(req) }));
});

// ================= 發票與折讓 =================

router.get('/invoices', requireStaff('invoices'), (req, res) => {
  res.json({
    rows: invoicing.list(req.query || {}),
    summary: invoicing.summary(req.query.period || thisMonth(),
      req.query.store_id ? Number(req.query.store_id) : null),
    missing: invoicing.missing({ from: req.query.from, to: req.query.to,
      storeId: req.query.store_id ? Number(req.query.store_id) : null }),
    settings: {
      enabled: invoicing.enabled(), track: getSetting('invoice_track', ''),
      next_no: invoicing.peekNumber(), rate: invoicing.rate()
    }
  });
});

router.post('/invoices', requireStaff('invoices'), (req, res) => {
  const b = req.body || {};
  const inv = b.ticket_id
    ? invoicing.issueForTicket({ ticketId: Number(b.ticket_id), actor: actorOf(req), ...b })
    : invoicing.issue({ ...b, actor: actorOf(req) });
  res.json(inv);
});

router.post('/invoices/:id/void', requireStaff('invoices'), (req, res) => {
  res.json(invoicing.voidInvoice({ id: Number(req.params.id), reason: req.body?.reason, actor: actorOf(req) }));
});

router.post('/invoices/:id/allowance', requireStaff('invoices'), (req, res) => {
  const b = req.body || {};
  res.json(invoicing.allowance({ id: Number(req.params.id), amount: b.amount,
    reason: b.reason, date: b.date, actor: actorOf(req) }));
});

// ================= 附件（照片與檔案）=================
//
// 上傳一律走「存檔 → 回讀 → 比對指紋」，storage.save 驗不過就會丟例外，
// 這裡照實回 400。**絕對不回「上傳成功」給一個沒有真的落盤的檔案。**

router.post('/files', requireStaff(), (req, res) => {
  const b = req.body || {};
  if (!storage.OWNER_TYPES.includes(b.owner_type)) {
    return res.status(400).json({ error: '請指定檔案要掛在哪一種資料上' });
  }
  const a = storage.save({
    dataUrl: b.data, filename: b.filename, ownerType: b.owner_type,
    ownerId: b.owner_id ? Number(b.owner_id) : null, kind: b.kind || 'photo',
    note: b.note, actor: actorOf(req)
  });
  audit('staff', req.user.id, req.user.name,
    `上傳檔案：${a.filename || a.stored_name}（${(a.bytes / 1024).toFixed(0)}KB，已通過完整性驗證）`);
  res.json(a);
});

router.get('/files', requireStaff(), (req, res) => {
  if (!req.query.owner_type) return res.status(400).json({ error: '請指定 owner_type' });
  res.json(storage.listFor(req.query.owner_type, req.query.owner_id ? Number(req.query.owner_id) : null));
});

// 取檔。每次讀出來都會重驗一次指紋，壞掉的檔案回 410 而不是送出爛資料。
router.get('/files/:id', requireStaff(), (req, res) => {
  let f;
  try { f = storage.read(Number(req.params.id)); }
  catch (e) { return res.status(410).json({ error: e.message }); }
  if (!f) return res.status(404).json({ error: '找不到這個檔案' });
  res.setHeader('Content-Type', f.meta.mime);
  res.setHeader('Content-Length', f.meta.bytes);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition',
    `inline; filename="${encodeURIComponent(f.meta.filename || f.meta.stored_name)}"`);
  res.send(f.buffer);
});

router.delete('/files/:id', requireStaff(), (req, res) => {
  const ok = storage.remove(Number(req.params.id), actorOf(req));
  if (!ok) return res.status(404).json({ error: '找不到這個檔案' });
  res.json({ ok: true });
});

// 全部檔案的完整性檢查。每日維護會自動跑，這支是讓人手動按的。
router.get('/files-check', requireStaff('backup'), (req, res) => {
  const r = storage.verifyAll({ limit: Number(req.query.limit) || 5000 });
  res.json({ ...r, orphans: storage.orphanFiles() });
});

// 清掉沒有任何資料指向的檔案。這是刪除客人的照片，所以要明確送出 confirm。
router.post('/files-purge', requireStaff('backup'), (req, res) => {
  if (!req.body || req.body.confirm !== true) {
    return res.json(storage.purgeOrphans({ dryRun: true }));
  }
  res.json(storage.purgeOrphans({ dryRun: false, actor: actorOf(req) }));
});

module.exports = router;
