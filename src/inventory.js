// 庫存：進貨、退貨、銷售出庫、盤點、跨店調撥。
//
// 原本 retail_products.stock 是一個「用手改的數字」：進貨後直接把庫存欄位加上去。
// 那等於庫存沒有任何流水，於是三件事同時成立：
//   · 損益表上的商品成本不可稽核（沒有人知道那批貨進了多少錢）
//   · 少了幾罐精油，查不出是賣掉、破了、還是被拿走
//   · 跟儲值金「餘額是快取、流水才是真相」的原則自相矛盾
//
// 這個模組把庫存改成跟儲值金同一套形狀：
//   stock_txns 是真相，retail_products.stock 是它的加總快取，
//   每一筆異動都記下當下的 stock_after，對不上時以流水為準。
//
// 成本用「移動加權平均」：進貨時把新舊庫存的成本混合成一個單價，
// 銷售出庫就用當下的那個單價記成本。先進先出更精確，但要逐批追蹤，
// 對一家賣十幾樣保養品的按摩店來說，多出來的準確度換不回那個複雜度。
const { db, nowStamp, today, nextSerial, money, yuan, audit } = require('./db');

const KINDS = {
  init: '期初', purchase: '進貨', return: '退貨', sale: '銷售出庫', sale_void: '銷售回沖',
  count: '盤點調整', transfer_out: '調出', transfer_in: '調入', adjust: '人工調整'
};

// 既有資料庫的期初補正：有庫存卻沒有任何流水的商品，補一筆「期初」。
// 不補的話，一致性測試的「庫存 = 流水加總」從第一天就是紅的，
// 而那個紅字跟使用者無關 —— 是我們自己把功能加晚了。
function ensureOpening(actor = '系統') {
  const rows = db.prepare(`SELECT p.* FROM retail_products p
    WHERE NOT EXISTS (SELECT 1 FROM stock_txns x WHERE x.product_id = p.id)`).all();
  if (!rows.length) return 0;
  const ins = db.prepare(`INSERT INTO stock_txns(product_id,store_id,kind,qty,unit_cost,amount,stock_after,
      doc_no,note,actor,created_at) VALUES(?,NULL,'init',?,?,?,?,'',?,?,?)`);
  const tx = db.transaction(list => {
    for (const p of list) {
      ins.run(p.id, p.stock, money(p.cost), money(p.stock * p.cost), p.stock,
        '啟用庫存流水前的既有庫存', actor, nowStamp());
    }
  });
  tx(rows);
  return rows.length;
}
ensureOpening();

function productOf(id) {
  const p = db.prepare('SELECT * FROM retail_products WHERE id = ?').get(id);
  if (!p) throw new Error('找不到這項商品');
  return p;
}

// 流水加總＝真實庫存。快取對不上時用這個重算。
function stockOf(productId) {
  return db.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_txns WHERE product_id = ?').get(productId).v;
}

// 各分店手上有多少。調撥靠這個判斷「A 店真的有貨可以調出去嗎」。
// 沒有指定門市的異動（期初、早期的銷售）歸在 null，畫面上顯示為「未分店」。
function stockByStore(productId) {
  return db.prepare(`SELECT store_id, COALESCE(SUM(qty),0) qty FROM stock_txns
    WHERE product_id = ? GROUP BY store_id ORDER BY store_id`).all(productId);
}
function storeStock(productId, storeId) {
  const r = db.prepare(`SELECT COALESCE(SUM(qty),0) v FROM stock_txns
    WHERE product_id = ? AND store_id IS ?`).get(productId, storeId ?? null);
  return r.v;
}

// 寫一筆異動。所有進出都必須經過這裡，快取才不會有第二個更新路徑。
const record = db.transaction((r) => {
  const p = productOf(r.productId);
  const qty = Number(r.qty) || 0;
  if (!KINDS[r.kind]) throw new Error(`不認得的異動類型：${r.kind}`);
  if (!qty) throw new Error('異動數量不能是 0');
  const after = stockOf(p.id) + qty;
  if (after < 0) throw new Error(`${p.name} 庫存不足：目前 ${stockOf(p.id)}，本次要出 ${-qty}`);
  const unitCost = r.unitCost === undefined || r.unitCost === '' ? money(p.cost) : money(r.unitCost);
  db.prepare(`INSERT INTO stock_txns(product_id,store_id,kind,qty,unit_cost,amount,stock_after,
      vendor,doc_no,ticket_id,peer_store_id,note,actor)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.id, r.storeId || null, r.kind, qty, unitCost, money(qty * unitCost), after,
      String(r.vendor || ''), String(r.docNo || ''), r.ticketId || null, r.peerStoreId || null,
      String(r.note || ''), String(r.actor || ''));
  db.prepare('UPDATE retail_products SET stock = ? WHERE id = ?').run(after, p.id);
  return after;
});

// 進貨。同一張單可以有多項商品，單號一次產生。
// 成本用移動加權平均更新：((舊庫存×舊成本)+(進貨量×進貨單價)) ÷ 新庫存。
const purchase = db.transaction(({ storeId, vendor, items, note, actor, docNo }) => {
  if (!items || !items.length) throw new Error('請至少填一項進貨商品');
  const no = docNo || nextSerial('PO');
  const out = [];
  for (const it of items) {
    const p = productOf(it.product_id);
    const qty = Number(it.qty) || 0;
    if (qty <= 0) throw new Error(`${p.name} 的進貨數量要大於 0`);
    const unitCost = money(it.unit_cost);
    if (unitCost < 0) throw new Error(`${p.name} 的進貨單價不能是負數`);
    const before = stockOf(p.id);
    record({ productId: p.id, storeId, kind: 'purchase', qty, unitCost, vendor, docNo: no,
      note: it.note || note, actor });
    // 舊庫存是負數（歷史上超賣過）時不做加權，直接採用這次的進價，
    // 否則會算出一個負的分母，成本變成天文數字。
    const newCost = before > 0
      ? money((before * money(p.cost) + qty * unitCost) / (before + qty))
      : unitCost;
    db.prepare('UPDATE retail_products SET cost = ?, last_cost = ?, last_purchase_date = ? WHERE id = ?')
      .run(newCost, unitCost, today(), p.id);
    out.push({ product_id: p.id, name: p.name, qty, unit_cost: unitCost, amount: money(qty * unitCost),
      cost_before: money(p.cost), cost_after: newCost, stock_after: stockOf(p.id) });
  }
  const total = money(out.reduce((s, x) => s + x.amount, 0));
  audit('staff', null, actor || '', `進貨 ${no}：${out.length} 項、${total} 元（${vendor || '未填廠商'}）`);
  return { doc_no: no, vendor: vendor || '', items: out, total };
});

// 退貨給廠商。單價用當下成本，避免退貨反而把成本拉高或壓低。
const vendorReturn = db.transaction(({ storeId, vendor, items, note, actor }) => {
  if (!items || !items.length) throw new Error('請至少填一項退貨商品');
  const no = nextSerial('PR');
  const out = [];
  for (const it of items) {
    const p = productOf(it.product_id);
    const qty = Number(it.qty) || 0;
    if (qty <= 0) throw new Error(`${p.name} 的退貨數量要大於 0`);
    record({ productId: p.id, storeId, kind: 'return', qty: -qty, unitCost: money(p.cost),
      vendor, docNo: no, note: it.note || note, actor });
    out.push({ product_id: p.id, name: p.name, qty, unit_cost: money(p.cost), amount: money(qty * p.cost) });
  }
  const total = money(out.reduce((s, x) => s + x.amount, 0));
  audit('staff', null, actor || '', `退貨 ${no}：${out.length} 項、${total} 元（${vendor || '未填廠商'}）`);
  return { doc_no: no, items: out, total };
});

// 盤點。送進來的是「實際數到幾個」，系統自己算差異並寫調整流水。
// 差異一律要填原因：盤盈盤虧沒有理由，等於帳面被人隨手改過。
const stocktake = db.transaction(({ storeId, items, reason, actor }) => {
  if (!items || !items.length) throw new Error('請至少盤點一項商品');
  if (!String(reason || '').trim()) throw new Error('盤點差異必須填寫原因');
  const no = nextSerial('ST');
  const out = [];
  for (const it of items) {
    const p = productOf(it.product_id);
    const counted = Number(it.counted);
    if (!Number.isFinite(counted) || counted < 0) throw new Error(`${p.name} 的實盤數量不正確`);
    const book = storeId ? storeStock(p.id, storeId) : stockOf(p.id);
    const diff = counted - book;
    out.push({ product_id: p.id, name: p.name, book, counted, diff,
      amount: money(diff * p.cost) });
    if (!diff) continue;
    record({ productId: p.id, storeId, kind: 'count', qty: diff, unitCost: money(p.cost),
      docNo: no, note: `盤點：帳面 ${book} → 實盤 ${counted}｜${reason}`, actor });
  }
  const diffItems = out.filter(x => x.diff);
  audit('staff', null, actor || '',
    `盤點 ${no}：${out.length} 項，${diffItems.length} 項有差異，損益 ${money(diffItems.reduce((s, x) => s + x.amount, 0))} 元（${reason}）`);
  return { doc_no: no, items: out, diff_count: diffItems.length,
    diff_amount: money(diffItems.reduce((s, x) => s + x.amount, 0)) };
});

// 跨店調撥：一出一進，總量不變。
// 兩筆流水互指對方門市，日後對帳才知道這批貨去了哪裡、從哪裡來。
const transfer = db.transaction(({ productId, fromStoreId, toStoreId, qty, note, actor }) => {
  const p = productOf(productId);
  const n = Number(qty) || 0;
  if (n <= 0) throw new Error('調撥數量要大於 0');
  if (!fromStoreId || !toStoreId) throw new Error('請選擇調出與調入門市');
  if (String(fromStoreId) === String(toStoreId)) throw new Error('調出與調入不能是同一家店');
  const have = storeStock(p.id, Number(fromStoreId));
  if (have < n) throw new Error(`調出門市的 ${p.name} 只有 ${have} 件`);
  const no = nextSerial('TF');
  const names = Object.fromEntries(db.prepare('SELECT id,name FROM stores').all().map(s => [s.id, s.name]));
  record({ productId: p.id, storeId: Number(fromStoreId), kind: 'transfer_out', qty: -n,
    unitCost: money(p.cost), docNo: no, peerStoreId: Number(toStoreId),
    note: `調撥至 ${names[toStoreId] || toStoreId}${note ? `｜${note}` : ''}`, actor });
  record({ productId: p.id, storeId: Number(toStoreId), kind: 'transfer_in', qty: n,
    unitCost: money(p.cost), docNo: no, peerStoreId: Number(fromStoreId),
    note: `由 ${names[fromStoreId] || fromStoreId} 調入${note ? `｜${note}` : ''}`, actor });
  audit('staff', null, actor || '',
    `調撥 ${no}：${p.name} x${n}，${names[fromStoreId] || fromStoreId} → ${names[toStoreId] || toStoreId}`);
  return { doc_no: no, product: p.name, qty: n, stock_after: stockOf(p.id) };
});

// 人工調整（破損、贈品、試用）。同樣一定要填原因。
const adjust = db.transaction(({ productId, storeId, qty, reason, actor }) => {
  if (!String(reason || '').trim()) throw new Error('庫存調整必須填寫原因');
  const p = productOf(productId);
  const after = record({ productId, storeId, kind: 'adjust', qty: Number(qty),
    unitCost: money(p.cost), note: reason, actor });
  audit('staff', null, actor || '', `庫存調整：${p.name} ${Number(qty) > 0 ? '+' : ''}${Number(qty)}（${reason}）`);
  return { stock_after: after };
});

// ---- 銷售出庫（由鐘單呼叫）----
// 出庫單價記「當下的成本」，這樣商品毛利才算得出來，
// 而且日後成本再變也不會回頭改到已經賣掉的那幾件。
function sell({ productId, storeId, qty, ticketId, note, actor }) {
  const p = productOf(productId);
  return record({ productId, storeId, kind: 'sale', qty: -Math.abs(Number(qty) || 0),
    unitCost: money(p.cost), ticketId, note: note || '鐘單銷售', actor });
}
// 退掉一筆銷售（刪明細、取消鐘單）。回沖的單價用當初出庫的那個，不是現在的成本。
function sellVoid({ productId, storeId, qty, ticketId, note, actor }) {
  const orig = db.prepare(`SELECT * FROM stock_txns WHERE product_id = ? AND ticket_id = ? AND kind = 'sale'
    ORDER BY id DESC LIMIT 1`).get(productId, ticketId);
  return record({ productId, storeId, kind: 'sale_void', qty: Math.abs(Number(qty) || 0),
    unitCost: orig ? orig.unit_cost : undefined, ticketId, note: note || '鐘單銷售回沖', actor });
}

// ---- 查詢 ----

function txns({ productId, storeId, kind, from, to, limit = 500 } = {}) {
  const where = [], args = [];
  if (productId) { where.push('x.product_id = ?'); args.push(productId); }
  if (storeId) { where.push('x.store_id = ?'); args.push(storeId); }
  if (kind) { where.push('x.kind = ?'); args.push(kind); }
  if (from) { where.push('substr(x.created_at,1,10) >= ?'); args.push(from); }
  if (to) { where.push('substr(x.created_at,1,10) <= ?'); args.push(to); }
  return db.prepare(`SELECT x.*, p.name AS product_name, p.sku, s.name AS store_name,
      ps.name AS peer_store_name, t.ticket_no
    FROM stock_txns x
    LEFT JOIN retail_products p ON p.id = x.product_id
    LEFT JOIN stores s ON s.id = x.store_id
    LEFT JOIN stores ps ON ps.id = x.peer_store_id
    LEFT JOIN tickets t ON t.id = x.ticket_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY x.id DESC LIMIT ?`).all(...args, limit)
    .map(r => ({ ...r, kind_label: KINDS[r.kind] || r.kind }));
}

// 庫存總表：帳面、各店分布、成本市值、低於安全庫存
function overview({ storeId } = {}) {
  const rows = db.prepare('SELECT * FROM retail_products WHERE active = 1 ORDER BY category, name').all();
  return rows.map(p => {
    const real = stockOf(p.id);
    const byStore = stockByStore(p.id);
    return {
      ...p,
      stock: p.stock, real_stock: real,
      // 快取跟流水對不上就把它講出來。悄悄修掉會讓「為什麼庫存自己變了」永遠查不到。
      cache_ok: Math.abs(real - p.stock) < 0.001,
      store_stock: storeId ? storeStock(p.id, Number(storeId)) : null,
      by_store: byStore,
      cost_value: money(real * p.cost),
      low: real <= p.safety_stock
    };
  });
}

// 期間內的進銷存與商品毛利。損益頁的「商品成本」就是這裡的 cogs。
function movement(start, end, storeId) {
  const f = storeId ? ' AND x.store_id = ?' : '';
  const args = storeId ? [storeId] : [];
  const rows = db.prepare(`SELECT x.kind, COALESCE(SUM(x.qty),0) qty, COALESCE(SUM(x.amount),0) amount
    FROM stock_txns x WHERE substr(x.created_at,1,10) >= ? AND substr(x.created_at,1,10) < ?${f}
    GROUP BY x.kind`).all(start, end, ...args);
  const m = Object.fromEntries(rows.map(r => [r.kind, r]));
  const get = (k, field) => Math.abs((m[k] || {})[field] || 0);
  const cogs = money(get('sale', 'amount') - get('sale_void', 'amount'));
  return {
    purchase_qty: get('purchase', 'qty'), purchase_amount: money(get('purchase', 'amount')),
    return_qty: get('return', 'qty'), return_amount: money(get('return', 'amount')),
    sold_qty: get('sale', 'qty') - get('sale_void', 'qty'),
    cogs,
    count_diff_qty: (m.count || {}).qty || 0, count_diff_amount: money((m.count || {}).amount || 0),
    adjust_qty: (m.adjust || {}).qty || 0
  };
}

// 快取與流水對帳。一致性測試與畫面上的「重算」都用它。
function reconcile({ fix = false, actor = '' } = {}) {
  const bad = [];
  for (const p of db.prepare('SELECT * FROM retail_products').all()) {
    const real = stockOf(p.id);
    if (Math.abs(real - p.stock) < 0.001) continue;
    bad.push({ id: p.id, name: p.name, cached: p.stock, real });
    if (fix) {
      db.prepare('UPDATE retail_products SET stock = ? WHERE id = ?').run(real, p.id);
      audit('staff', null, actor, `庫存快取重算：${p.name} ${p.stock} → ${real}`);
    }
  }
  return { ok: bad.length === 0, mismatched: bad, fixed: fix ? bad.length : 0 };
}

module.exports = {
  KINDS, stockOf, stockByStore, storeStock, record, purchase, vendorReturn, stocktake, transfer,
  adjust, sell, sellVoid, txns, overview, movement, reconcile, ensureOpening
};
