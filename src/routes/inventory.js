// 進退貨、盤點、調撥與庫存流水。
const express = require('express');
const { db, audit, today, yuan } = require('../db');
const { requireStaff, requireAny } = require('../auth');
const inventory = require('../inventory');
const storage = require('../storage');

const router = express.Router();
const actorOf = req => req.user.name;

// 庫存總表（含各店分布與快取是否對得上）
router.get('/stock', requireAny('purchase', 'retail'), (req, res) => {
  const rows = inventory.overview({ storeId: req.query.store_id });
  res.json({
    rows,
    total_cost_value: rows.reduce((s, r) => s + r.cost_value, 0),
    low_count: rows.filter(r => r.low).length,
    mismatch_count: rows.filter(r => !r.cache_ok).length
  });
});

// 單一商品的流水（點進去看「這罐精油怎麼變成剩三瓶的」）
router.get('/stock/txns', requireAny('purchase', 'retail'), (req, res) => {
  res.json(inventory.txns({
    productId: req.query.product_id ? Number(req.query.product_id) : null,
    storeId: req.query.store_id ? Number(req.query.store_id) : null,
    kind: req.query.kind, from: req.query.from, to: req.query.to,
    limit: Math.min(Number(req.query.limit) || 500, 2000)
  }));
});

router.get('/stock/movement', requireAny('purchase', 'retail', 'finance'), (req, res) => {
  const from = req.query.from || today().slice(0, 8) + '01';
  const to = req.query.to || today();
  const { shiftDate } = require('../db');
  res.json(inventory.movement(from, shiftDate(to, 1), req.query.store_id ? Number(req.query.store_id) : null));
});

// 進貨。items: [{product_id, qty, unit_cost, note}]
router.post('/stock/purchase', requireStaff('purchase'), (req, res) => {
  const b = req.body || {};
  const r = inventory.purchase({
    storeId: b.store_id ? Number(b.store_id) : null,
    vendor: b.vendor, items: b.items, note: b.note, actor: actorOf(req)
  });
  // 單據照片（發票、送貨單）跟著進貨單一起存。存檔失敗要講出來，不能默默吞掉 ——
  // 進貨單據是日後對帳與報稅要調的東西。
  const files = [];
  const errors = [];
  for (const f of (b.attachments || [])) {
    try {
      files.push(storage.save({ dataUrl: f.data, filename: f.name, ownerType: 'stock',
        ownerId: null, kind: 'doc', note: `進貨單 ${r.doc_no}`, actor: actorOf(req) }));
    } catch (e) { errors.push(`${f.name || '檔案'}：${e.message}`); }
  }
  res.json({ ...r, attachments: files, attachment_errors: errors });
});

router.post('/stock/return', requireStaff('purchase'), (req, res) => {
  const b = req.body || {};
  res.json(inventory.vendorReturn({
    storeId: b.store_id ? Number(b.store_id) : null,
    vendor: b.vendor, items: b.items, note: b.note, actor: actorOf(req)
  }));
});

// 盤點。items: [{product_id, counted}]
router.post('/stock/count', requireStaff('purchase'), (req, res) => {
  const b = req.body || {};
  res.json(inventory.stocktake({
    storeId: b.store_id ? Number(b.store_id) : null,
    items: b.items, reason: b.reason, actor: actorOf(req)
  }));
});

router.post('/stock/transfer', requireStaff('purchase'), (req, res) => {
  const b = req.body || {};
  res.json(inventory.transfer({
    productId: Number(b.product_id), fromStoreId: b.from_store_id, toStoreId: b.to_store_id,
    qty: b.qty, note: b.note, actor: actorOf(req)
  }));
});

router.post('/stock/adjust', requireStaff('purchase'), (req, res) => {
  const b = req.body || {};
  res.json(inventory.adjust({
    productId: Number(b.product_id), storeId: b.store_id ? Number(b.store_id) : null,
    qty: b.qty, reason: b.reason, actor: actorOf(req)
  }));
});

// 快取重算。庫存欄位跟流水對不上時（只可能是有人直接改資料庫）才會用到。
router.post('/stock/reconcile', requireStaff('purchase'), (req, res) => {
  const r = inventory.reconcile({ fix: !!req.body?.fix, actor: actorOf(req) });
  if (req.body?.fix) audit('staff', req.user.id, req.user.name, `庫存快取重算：修正 ${r.fixed} 項`);
  res.json(r);
});

module.exports = router;
