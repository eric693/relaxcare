// 並發測試：兩個人同時做同一件事，會不會生出兩筆帳？
//
// 這套系統跑在 better-sqlite3 上，而 better-sqlite3 的每一次呼叫都是**同步**的 ——
// 它會擋住 Node 的事件迴圈直到做完。所以在**單一行程**裡，`db.transaction(...)` 中間
// 不可能插進另一個請求：兩個櫃檯同時按下日結，第二個請求根本還沒開始跑。
//
// 這件事讓人很容易得出錯誤的結論：「反正是同步的，不會有並發問題」。不對，有兩個破口：
//
//   1. **多行程**。pm2 開 cluster、或有人在伺服器還跑著的時候執行 `npm run seed`、
//      跑一支修資料的腳本、開 sqlite3 CLI 改東西 —— 那都是第二個行程，
//      它們之間只剩資料庫本身的鎖在擋。「先 SELECT 檢查、再 INSERT」在這裡會漏。
//   2. **使用者的重複送出**。網路慢的時候櫃檯會連按兩下、或按了沒反應就重新整理再按一次。
//      這兩個請求在伺服器裡是排隊執行的，所以第二個看得到第一個的結果 ——
//      前提是「檢查」這件事真的做對了。這一支就是在驗那個前提。
//
// 對策也是兩層：資料庫層的 UNIQUE 約束（跨行程唯一有效的防線），
// 加上程式層的檢查（給使用者看得懂的錯誤訊息，而不是一句 SQLITE_CONSTRAINT）。
process.env.TZ = 'Asia/Taipei';
const { execFileSync } = require('child_process');
const path = require('path');
const { db, today, bizDate, yuan } = require('../src/db');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3460';
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? ' → ' + detail : ''}`); }
  else { fail++; fails.push(`${name}${detail ? '：' + detail : ''}`); console.log(`❌ ${name}${detail ? '：' + detail : ''}`); }
}

// ---- 登入拿 cookie ----
let cookie = '';
async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'admin123' })
  });
  if (!r.ok) throw new Error('登入失敗，請確認伺服器有在跑：' + BASE);
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
}
async function api(pathname, opts = {}) {
  const r = await fetch(BASE + '/api' + pathname, {
    method: opts.method || 'GET',
    headers: { cookie, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}
// 同時送出 n 個一模一樣的請求（模擬連按 n 下）
function burst(n, fn) { return Promise.all(Array.from({ length: n }, (_, i) => fn(i))); }

(async () => {
  await login();
  console.log(`並發測試（對象 ${BASE}）\n`);

  // ---- 1. 同時日結同一班 ----
  // 只能成功一張。多出來的那張會讓短溢被算兩次，而且事後沒有人分得出哪張才是真的。
  await (async () => {
    const day = bizDate();
    const label = '並發測試班';
    db.prepare('DELETE FROM closings WHERE shift_label = ?').run(label);
    const pv = await api('/closing/preview');
    const denom = {};
    let left = Math.max(0, pv.d.expected_cash);
    for (const dn of pv.d.denoms) { const k = Math.floor(left / dn); if (k) { denom[dn] = k; left -= k * dn; } }
    const rs = await burst(5, () => api('/closing', { method: 'POST',
      body: { biz_date: day, shift_label: label, denom, handover_to: '並發測試' } }));
    const good = rs.filter(r => r.ok);
    const rows = db.prepare('SELECT * FROM closings WHERE shift_label = ? AND status = ?').all(label, 'confirmed');
    ok('同時按 5 次日結只會成立一張', good.length === 1 && rows.length === 1,
      `成功 ${good.length} 次、資料庫 ${rows.length} 張`);
    ok('被擋下的日結有看得懂的訊息',
      rs.filter(r => !r.ok).every(r => /已經結過/.test(r.d.error || '')),
      rs.filter(r => !r.ok).map(r => r.d.error).find(Boolean) || '(無訊息)');
    db.prepare('DELETE FROM closings WHERE shift_label = ?').run(label);
  })();

  // ---- 2. 同時盤點同一項商品 ----
  // 盤點是「把庫存設成實盤數」，兩個人同時盤同一項，後送的那筆會用過期的帳面數算差異。
  await (async () => {
    const st = await api('/stock');
    const p = st.d.rows[0];
    const before = p.real_stock;
    const rs = await burst(4, i => api('/stock/count', { method: 'POST',
      body: { items: [{ product_id: p.id, counted: before + 1 + i }], reason: '並發測試' } }));
    const after = (await api('/stock')).d.rows.find(r => r.id === p.id);
    const okCount = rs.filter(r => r.ok).length;
    // 不論成功幾次，最後的庫存一定要等於最後一次成功的實盤數，而且流水加總要對得上
    ok('盤點並發後庫存仍等於流水加總', after.cache_ok,
      `快取 ${after.stock} vs 流水 ${after.real_stock}`);
    ok('盤點並發後庫存落在合理範圍',
      after.real_stock >= before + 1 && after.real_stock <= before + 4,
      `${before} → ${after.real_stock}（成功 ${okCount} 次）`);
    // 還原
    await api('/stock/count', { method: 'POST',
      body: { items: [{ product_id: p.id, counted: before }], reason: '並發測試還原' } });
  })();

  // ---- 3. 同時出庫到庫存不足 ----
  // 架上剩 3 件，5 個人同時買 —— 只能成功 3 次，庫存不能變成負數。
  await (async () => {
    const st = await api('/stock');
    const p = st.d.rows.find(r => r.real_stock > 5) || st.d.rows[0];
    const before = p.real_stock;
    // 先調到剛好 3 件
    await api('/stock/count', { method: 'POST',
      body: { items: [{ product_id: p.id, counted: 3 }], reason: '並發測試：壓到 3 件' } });
    const rs = await burst(5, () => api('/stock/adjust', { method: 'POST',
      body: { product_id: p.id, qty: -1, reason: '並發測試出庫' } }));
    const after = (await api('/stock')).d.rows.find(r => r.id === p.id);
    ok('庫存不足時只會成功 3 次', rs.filter(r => r.ok).length === 3,
      `成功 ${rs.filter(r => r.ok).length} 次`);
    ok('庫存不會變成負數', after.real_stock === 0, `剩 ${after.real_stock}`);
    ok('超領的請求訊息看得懂',
      rs.filter(r => !r.ok).every(r => /庫存不足/.test(r.d.error || '')),
      rs.filter(r => !r.ok).map(r => r.d.error).find(Boolean) || '(無訊息)');
    await api('/stock/count', { method: 'POST',
      body: { items: [{ product_id: p.id, counted: before }], reason: '並發測試還原' } });
  })();

  // ---- 4. 同一張鐘單同時開發票 ----
  await (async () => {
    const iv = await api('/invoices');
    if (!iv.d.missing.length) { console.log('⏭  沒有待開發票，略過發票並發測試'); return; }
    const tk = iv.d.missing[0];
    const rs = await burst(4, () => api('/invoices', { method: 'POST', body: { ticket_id: tk.id } }));
    const rows = db.prepare("SELECT * FROM invoices WHERE ticket_id = ? AND status <> 'void'").all(tk.id);
    ok('同一張鐘單只開得出一張發票', rs.filter(r => r.ok).length === 1 && rows.length === 1,
      `成功 ${rs.filter(r => r.ok).length} 次、資料庫 ${rows.length} 張`);
    for (const r of rows) {
      await api(`/invoices/${r.id}/void`, { method: 'POST', body: { reason: '並發測試，用完作廢' } });
    }
  })();

  // ---- 5. 同時兌換點數 ----
  // 有 300 點卻按了 5 次「兌換 300 點」，只能扣一次；否則點數會變成負的、贈送金憑空多出來。
  await (async () => {
    const m = db.prepare('SELECT * FROM members WHERE active = 1 ORDER BY id LIMIT 1').get();
    const cur = db.prepare('SELECT COALESCE(SUM(points),0) v FROM point_txns WHERE member_id = ?').get(m.id).v;
    await api('/loyalty/adjust', { method: 'POST',
      body: { member_id: m.id, points: 300 - cur, reason: '並發測試：調到 300 點' } });
    const w0 = await api(`/wallets/${m.id}`);
    const rs = await burst(5, () => api('/loyalty/redeem', { method: 'POST',
      body: { member_id: m.id, points: 300 } }));
    const after = db.prepare('SELECT COALESCE(SUM(points),0) v FROM point_txns WHERE member_id = ?').get(m.id).v;
    const w1 = await api(`/wallets/${m.id}`);
    ok('同時兌換 5 次只會扣一次', rs.filter(r => r.ok).length === 1,
      `成功 ${rs.filter(r => r.ok).length} 次`);
    ok('點數不會變成負數', after >= 0, `餘 ${after} 點`);
    ok('贈送金只增加一次', w1.d.balance.bonus - w0.d.balance.bonus === 300,
      `贈送金 +${w1.d.balance.bonus - w0.d.balance.bonus}`);
    await api('/loyalty/adjust', { method: 'POST',
      body: { member_id: m.id, points: -after, reason: '並發測試還原' } });
  })();

  // ---- 6. 同時對同一張鐘單結帳 ----
  // 這是最貴的一種重複：儲值會被扣兩次、次卡核銷兩次、技師的抽成算兩遍。
  await (async () => {
    const booked = db.prepare(`SELECT * FROM tickets WHERE status = 'serving' ORDER BY id DESC LIMIT 1`).get()
      || db.prepare(`SELECT * FROM tickets WHERE status = 'booked' ORDER BY id DESC LIMIT 1`).get();
    if (!booked) { console.log('⏭  沒有未結帳的鐘單，略過結帳並發測試'); return; }
    if (booked.status === 'booked') await api(`/tickets/${booked.id}/start`, { method: 'POST', body: {} });
    const rs = await burst(4, () => api(`/tickets/${booked.id}/checkout`, { method: 'POST',
      body: { pay_method: '現金' } }));
    const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(booked.id);
    ok('同一張鐘單只結得了一次帳', rs.filter(r => r.ok).length === 1,
      `成功 ${rs.filter(r => r.ok).length} 次`);
    ok('結帳後收款拆解 = 應收',
      Math.abs((t.paid_cash + t.paid_wallet + t.paid_pass + t.paid_voucher) - t.net_amount) < 1,
      `拆解 ${t.paid_cash + t.paid_wallet + t.paid_pass + t.paid_voucher} vs 應收 ${t.net_amount}`);
    const pts = db.prepare("SELECT COUNT(*) n FROM point_txns WHERE ticket_id = ? AND kind = 'earn'").get(t.id).n;
    ok('點數只累一次', pts <= 1, `${pts} 筆累點`);
    await api(`/tickets/${booked.id}/cancel`, { method: 'POST', body: { reason: '並發測試，用完取消' } });
  })();

  // ---- 7. 同時簽到（輪序不能發出兩個相同號碼）----
  await (async () => {
    const absent = await api('/queue/absent');
    if (!absent.d.length) { console.log('⏭  今天所有技師都簽到了，略過簽到並發測試'); return; }
    const th = absent.d[0];
    const rs = await burst(5, () => api('/queue/checkin', { method: 'POST',
      body: { therapist_id: th.id, store_id: th.store_id } }));
    const shifts = db.prepare('SELECT * FROM shifts WHERE work_date = ? AND therapist_id = ?')
      .all(today(), th.id);
    ok('同時簽到 5 次只會有一筆班', shifts.length === 1, `${shifts.length} 筆`);
    // 簽到號碼是「各店各自從 1 號編」（rotation.checkin 取 MAX 時有帶 store 條件），
    // 所以兩家店各有一個 1 號是對的 —— 要驗的是同一家店裡不會有兩個 1 號。
    const seqs = db.prepare(`SELECT store_id, queue_seq, COUNT(*) n FROM shifts
      WHERE work_date = ? GROUP BY store_id, queue_seq HAVING n > 1`).all(today());
    ok('同一家店裡沒有兩個人拿到同一個簽到號碼', seqs.length === 0,
      seqs.map(s => `門市 ${s.store_id} 的第 ${s.queue_seq} 號有 ${s.n} 人`).join('、'));
  })();

  // ---- 8. 跨行程：另一個 Node 行程同時寫入 ----
  // 前面幾項都在同一個伺服器行程裡排隊，這一項才是真正的跨行程競爭 ——
  // pm2 開 cluster、或有人在伺服器跑著的時候執行腳本，就是這個情境。
  await (async () => {
    const worker = path.join(__dirname, 'concurrency-worker.js');
    const day = bizDate();
    const label = '跨行程測試班';
    db.prepare('DELETE FROM closings WHERE shift_label = ?').run(label);
    const outs = [];
    // 同時開 4 個行程，各自嘗試日結同一班
    const procs = Array.from({ length: 4 }, () => new Promise(resolve => {
      const { spawn } = require('child_process');
      const c = spawn(process.execPath, [worker, 'closing', day, label], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', d => { out += d; });
      c.stderr.on('data', d => { out += d; });
      c.on('close', () => { outs.push(out.trim()); resolve(); });
    }));
    await Promise.all(procs);
    const rows = db.prepare("SELECT * FROM closings WHERE shift_label = ? AND status = 'confirmed'").all(label);
    ok('4 個行程同時日結，也只會成立一張', rows.length === 1,
      `${rows.length} 張｜${outs.map(o => o.split('\n').pop()).join(' / ')}`);
    db.prepare('DELETE FROM closings WHERE shift_label = ?').run(label);
  })();

  // ---- 9. 跨行程：同時扣同一項商品的庫存 ----
  await (async () => {
    const st = await api('/stock');
    const p = st.d.rows.find(r => r.real_stock > 5) || st.d.rows[0];
    const before = p.real_stock;
    await api('/stock/count', { method: 'POST',
      body: { items: [{ product_id: p.id, counted: 3 }], reason: '跨行程測試：壓到 3 件' } });
    const worker = path.join(__dirname, 'concurrency-worker.js');
    const outs = [];
    await Promise.all(Array.from({ length: 6 }, () => new Promise(resolve => {
      const { spawn } = require('child_process');
      const c = spawn(process.execPath, [worker, 'stock', String(p.id)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', d => { out += d; });
      c.stderr.on('data', d => { out += d; });
      c.on('close', () => { outs.push(out.trim()); resolve(); });
    })));
    const real = db.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_txns WHERE product_id = ?').get(p.id).v;
    const cached = db.prepare('SELECT stock FROM retail_products WHERE id = ?').get(p.id).stock;
    ok('跨行程扣庫存不會變成負數', real >= 0, `剩 ${real}`);
    ok('跨行程扣庫存後快取仍等於流水', Math.abs(cached - real) < 0.001, `快取 ${cached} vs 流水 ${real}`);
    const okN = outs.filter(o => o.includes('OK')).length;
    ok('只有 3 個行程扣得到貨', okN === 3, `${okN} 個成功｜${outs.map(o => o.split('\n').pop()).join(' / ')}`);
    await api('/stock/count', { method: 'POST',
      body: { items: [{ product_id: p.id, counted: before }], reason: '跨行程測試還原' } });
  })();

  console.log(`\n並發測試：${pass} 項通過，${fail} 項失敗`);
  if (fail) {
    console.log('\n失敗項目：');
    fails.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('✓ 全部通過');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
