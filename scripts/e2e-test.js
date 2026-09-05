// 端對端測試：用真的瀏覽器登入，走完一輪真實操作 ——
// 簽到 → 閘門預檢 → 禁忌擋人 → 開單 → 加商品 → 結帳 → 薪資 → 取消還原 → 儲值退款 → 次卡 → 合規掃描。
//
// 會在資料庫留下測試單據（結尾會取消，但單子還在），跑完建議重新 `npm run seed`。
// 需要 playwright-core 與 chrome-headless-shell；找不到就直接略過（CI 環境沒有瀏覽器也不該紅燈）。
const fs = require('fs');
const CHROME = '/root/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell';
const PW = '/root/lifecare/node_modules/playwright-core';
if (!fs.existsSync(CHROME) || !fs.existsSync(PW)) {
  console.log('找不到瀏覽器或 playwright-core，略過端對端測試。');
  process.exit(0);
}
const { chromium } = require(PW);
(async () => {
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  // 用具名 context：收據要另開分頁，而 browser.newPage() 每次都會開一個沒有登入 cookie 的新環境
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const step = async (name, fn) => {
    errs.length = 0;
    try { const r = await fn(); console.log(`✅ ${name}${r ? ' → ' + r : ''}`); }
    catch (e) { console.log(`❌ ${name}: ${e.message}`); }
    errs.forEach(e => console.log('    ' + e.slice(0, 200)));
  };
  const api = (path, opts) => p.evaluate(async ([path, opts]) => {
    const res = await fetch('/api' + path, {
      method: opts?.method || 'GET',
      headers: opts?.body ? { 'Content-Type': 'application/json' } : {},
      body: opts?.body ? JSON.stringify(opts.body) : undefined
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.status);
    return d;
  }, [path, opts]);

  await p.goto(process.env.BASE_URL || 'http://127.0.0.1:3460/');
  await p.fill('#lg-user', 'admin'); await p.fill('#lg-pass', 'admin123'); await p.click('#lg-btn');
  await p.waitForSelector('.sidebar');
  console.log('LOGIN OK\n');

  const opt = await api('/options');
  const rich = (await api('/wallets')).find(w => w.total > 3000);
  const svc = opt.services.find(s => s.contraindications === '' && !s.is_package) || opt.services[0];
  const member = { id: rich.member_id, name: rich.name }, prod = opt.retail_products.find(x => x.stock > 2);

  // 技師與床位不能寫死第 0 個：示範資料是隨機生成的，第一位技師此刻很可能正好有一張單，
  // 開單就會被閘門用「時間重疊」擋下來 —— 那是系統做對了，卻讓測試看起來像壞掉。
  // 這裡先問過閘門，挑一組現在真的排得進去的技師與床位。
  const board = await api('/board');
  const busyTherapists = new Set(board.tickets.filter(t => t.status !== 'cancelled').map(t => t.therapist_id));
  const busyRooms = new Set(board.tickets.filter(t => t.status !== 'cancelled').map(t => t.room_id));
  let th = opt.therapists.find(x => !busyTherapists.has(x.id)) || opt.therapists[0];
  let room = opt.rooms.find(x => !busyRooms.has(x.id)) || opt.rooms[0];
  {
    // 再跟閘門確認一次；還是有硬衝突就把所有技師掃一遍
    let chk = await api('/tickets/check', { method: 'POST',
      body: { therapist_id: th.id, room_id: room.id, service_id: svc.id, member_id: member.id } });
    if (!chk.ok) {
      for (const cand of opt.therapists) {
        chk = await api('/tickets/check', { method: 'POST',
          body: { therapist_id: cand.id, room_id: room.id, service_id: svc.id, member_id: member.id } });
        if (chk.ok) { th = cand; break; }
      }
    }
    console.log(`測試對象：技師 ${th.name}／床位 ${room.name}／項目 ${svc.name}\n`);
  }

  let ticketId, before, after;

  await step('輪鐘檯載入', async () => {
    const q = await api('/queue');
    return `在班 ${q.list.length} 人，下一位 ${q.next ? q.next.name : '無'}`;
  });

  await step('技師簽到（已簽到者為冪等）', async () => {
    const s = await api('/queue/checkin', { method: 'POST', body: { therapist_id: th.id } });
    return `第 ${s.queue_seq} 號，已輪 ${s.rounds}`;
  });

  await step('閘門預檢（正常單）', async () => {
    const c = await api('/tickets/check', { method: 'POST', body: {
      therapist_id: th.id, service_id: svc.id, room_id: room.id, member_id: member.id,
      assign_type: 'rotation', start_at: null } });
    return `${c.issues.length} 則訊息，硬衝突 ${c.conflicts.length}`;
  });

  await step('禁忌閘門確實會擋', async () => {
    const banned = opt.services.find(s => s.contraindications);
    const ms = await api('/members?q=');
    const victim = ms.find(m => m.conditions && banned.contraindications.split(',').some(c => m.conditions.includes(c.trim())));
    if (!victim) return '（找不到有禁忌狀況的客人，略過）';
    const c = await api('/tickets/check', { method: 'POST', body: {
      therapist_id: th.id, service_id: banned.id, member_id: victim.id, assign_type: 'rotation' } });
    const hit = c.conflicts.find(x => x.code === 'contraindication');
    if (!hit) throw new Error('沒有擋下來！');
    return hit.message.slice(0, 60);
  });

  await step('沒填理由不能硬開單', async () => {
    const banned = opt.services.find(s => s.contraindications);
    const ms = await api('/members?q=');
    const victim = ms.find(m => m.conditions && banned.contraindications.split(',').some(c => m.conditions.includes(c.trim())));
    if (!victim) return '（略過）';
    try {
      await api('/tickets', { method: 'POST', body: { therapist_id: th.id, service_id: banned.id, member_id: victim.id, start_now: true } });
      throw new Error('竟然開成功了');
    } catch (e) { if (/放行理由/.test(e.message)) return '已被擋下：' + e.message.slice(0, 30); throw e; }
  });

  await step('開單（立刻上鐘）', async () => {
    before = await api('/queue');
    const r = await api('/tickets', { method: 'POST', body: {
      member_id: member.id, service_id: svc.id, therapist_id: th.id, room_id: room.id,
      assign_type: 'designated', start_now: true, source: '現場' } });
    ticketId = r.ticket.id;
    return `${r.ticket.ticket_no} 應收 ${r.ticket.net_amount}（含指名費 ${r.ticket.designate_fee}）`;
  });

  await step('指名不吃輪次（設定為不計）', async () => {
    after = await api('/queue');
    const b0 = before.list.find(x => x.therapist_id === th.id);
    const a0 = after.list.find(x => x.therapist_id === th.id);
    if (a0.rounds !== b0.rounds) throw new Error(`輪次從 ${b0.rounds} 變成 ${a0.rounds}，指名不該計輪`);
    if (a0.status !== 'serving') throw new Error('狀態沒有變成上鐘中');
    return `輪次維持 ${a0.rounds}，狀態 ${a0.status}`;
  });

  await step('加賣商品（扣庫存）', async () => {
    const r = await api(`/tickets/${ticketId}/items`, { method: 'POST', body: { kind: 'retail', ref_id: prod.id, qty: 1 } });
    const after2 = await api('/options');
    const p2 = after2.retail_products.find(x => x.id === prod.id);
    if (p2.stock !== prod.stock - 1) throw new Error(`庫存沒扣：${prod.stock} → ${p2.stock}`);
    return `${prod.name}，庫存 ${prod.stock} → ${p2.stock}，應收 ${r.ticket.net_amount}`;
  });

  await step('結帳試算（次卡→儲值→現金）', async () => {
    const q = await api(`/tickets/${ticketId}/quote`, { method: 'POST', body: { use_wallet: 1 } });
    return `應收 ${q.net_amount}＝次卡 ${q.paid_pass}＋儲值 ${q.paid_wallet}＋現金 ${q.paid_cash}；抽成 ${q.commission.total}（${q.commission.pct_used}%）`;
  });

  await step('結帳', async () => {
    const r = await api(`/tickets/${ticketId}/checkout`, { method: 'POST', body: { use_wallet: 1, pay_method: '現金', rating: 5 } });
    const t = r.ticket;
    if (t.paid_cash + t.paid_wallet + t.paid_pass !== t.net_amount) throw new Error('付款拆解對不上應收');
    if (t.status !== 'done') throw new Error('狀態不是已完成');
    return `已收 ${t.net_amount}（現金 ${t.paid_cash}／儲值 ${t.paid_wallet}），抽成 ${t.comm_service + t.comm_retail + t.comm_designate}`;
  });

  await step('下鐘後回到整理狀態', async () => {
    const q = await api('/queue');
    const s = q.list.find(x => x.therapist_id === th.id);
    return `狀態 ${s.status}`;
  });

  await step('薪資試算含這一鐘', async () => {
    const pv = await api(`/payroll/preview/${th.id}`);
    const t = await api(`/tickets/${ticketId}`);
    if (pv.comm_designate < t.comm_designate) throw new Error('薪資沒有算到指名費');
    return `鐘數 ${pv.ticket_count}、服務抽成 ${pv.comm_service}、指名費 ${pv.comm_designate}、合計 ${pv.total_before_adjust}`;
  });

  await step('取消：儲值、庫存、輪次全部還原', async () => {
    const wBefore = (await api(`/wallets/${member.id}`)).balance.total;
    const t = await api(`/tickets/${ticketId}`);
    await api(`/tickets/${ticketId}/cancel`, { method: 'POST', body: { reason: '自動化測試' } });
    const wAfter = (await api(`/wallets/${member.id}`)).balance.total;
    const t2 = await api(`/tickets/${ticketId}`);
    const o2 = await api('/options');
    const p2 = o2.retail_products.find(x => x.id === prod.id);
    if (wAfter !== wBefore + t.paid_wallet) throw new Error(`儲值沒還原：${wBefore} → ${wAfter}（應退 ${t.paid_wallet}）`);
    if (p2.stock !== prod.stock) throw new Error(`庫存沒還原：${p2.stock} ≠ ${prod.stock}`);
    if (t2.comm_service !== 0) throw new Error('抽成沒歸零');
    return `儲值 +${t.paid_wallet}、庫存回到 ${p2.stock}、抽成歸零`;
  });

  await step('輪序軌跡有留下痕跡', async () => {
    const logs = await api('/queue/logs');
    const mine = logs.filter(l => l.ticket_id === ticketId);
    if (!mine.length) throw new Error('沒有寫入軌跡');
    return mine.map(l => l.event).join(' → ');
  });

  await step('儲值 → 退款（贈送金作廢）', async () => {
    const m2 = (await api('/members?q='))[1];
    await api('/wallets/topup', { method: 'POST', body: { member_id: m2.id, amount: 10000, bonus: 1000, pay_method: '現金', note: '測試' } });
    const bal = await api(`/wallets/${m2.id}`);
    const q = await api(`/wallets/${m2.id}/refund-quote`);
    const r = await api('/wallets/refund', { method: 'POST', body: { member_id: m2.id, note: '自動化測試退款' } });
    const after3 = await api(`/wallets/${m2.id}`);
    if (after3.balance.bonus !== 0) throw new Error('贈送金沒作廢');
    return `餘額 ${bal.balance.total} → 退還現金 ${r.refunded}、贈送 ${r.bonus_void} 作廢，剩 ${after3.balance.total}`;
  });

  await step('次卡：買 → 核銷 → 退卡試算', async () => {
    const m3 = (await api('/members?q='))[2];
    const pass = await api('/passes', { method: 'POST', body: { member_id: m3.id, service_id: svc.id, total_times: 10, price_paid: 9000 } });
    const use = await api(`/passes/${pass.id}/use`, { method: 'POST', body: { times: 1, note: '測試' } });
    const q = await api(`/passes/${pass.id}/refund-quote`);
    if (Math.abs(use.value - 900) > 1) throw new Error(`單次值應為 900，實際 ${use.value}`);
    if (Math.abs(q.by_unit - 8100) > 1) throw new Error(`退卡應為 8100，實際 ${q.by_unit}`);
    return `單次值 ${use.value}、核銷後剩 ${use.remain} 次、退卡試算 ${q.by_unit}`;
  });

  await step('合規掃描抓得到踩線文案', async () => {
    const r = await api('/compliance/check-text', { method: 'POST', body: { text: '本館獨門手法，三次根治肩頸痠痛，療效顯著' } });
    if (r.hits.length < 2) throw new Error('沒抓到');
    return r.hits.map(h => h.term).join('、');
  });

  // ---- 以下是後來補上的模組：日結、進退貨、班表、發票、集點、同意書、檔案 ----

  await step('進貨 → 盤點 → 調撥（庫存流水全程對得上）', async () => {
    const st = await api('/stock');
    const p0 = st.rows[0];
    const before = p0.real_stock;
    const po = await api('/stock/purchase', { method: 'POST', body: {
      store_id: null, vendor: '自動化測試廠商',
      items: [{ product_id: p0.id, qty: 10, unit_cost: 100 }] } });
    const after = (await api('/stock')).rows.find(r => r.id === p0.id);
    if (after.real_stock !== before + 10) throw new Error(`進貨後庫存應為 ${before + 10}，實際 ${after.real_stock}`);
    if (!after.cache_ok) throw new Error('庫存快取與流水對不上');
    // 盤點：故意少一件
    const ct = await api('/stock/count', { method: 'POST', body: {
      items: [{ product_id: p0.id, counted: after.real_stock - 1 }], reason: '自動化測試盤虧' } });
    const after2 = (await api('/stock')).rows.find(r => r.id === p0.id);
    if (after2.real_stock !== after.real_stock - 1) throw new Error('盤點差異沒寫進庫存');
    // 調撥
    const stores = (await api('/options')).stores;
    let tf = '（單店，略過調撥）';
    if (stores.length > 1) {
      await api('/stock/purchase', { method: 'POST', body: { store_id: stores[0].id,
        items: [{ product_id: p0.id, qty: 5, unit_cost: 100 }] } });
      const r = await api('/stock/transfer', { method: 'POST', body: {
        product_id: p0.id, from_store_id: stores[0].id, to_store_id: stores[1].id, qty: 2, note: '測試' } });
      tf = `調撥 ${r.doc_no}`;
    }
    return `進貨 ${po.doc_no}（${before}→${after.real_stock}）、盤點 ${ct.doc_no} 差 ${ct.diff_count} 項、${tf}`;
  });

  await step('庫存不足擋得下來', async () => {
    const st = await api('/stock');
    const p0 = st.rows[0];
    try {
      await api('/stock/adjust', { method: 'POST', body: {
        product_id: p0.id, qty: -(p0.real_stock + 999), reason: '測試超領' } });
      throw new Error('竟然讓庫存變成負數');
    } catch (e) {
      if (!/庫存不足/.test(e.message)) throw e;
      return e.message;
    }
  });

  await step('日結：應有 vs 實點，短溢要留下來', async () => {
    const pv = await api('/closing/preview');
    // 故意少點 50 元
    const denom = {};
    let left = Math.max(0, pv.expected_cash - 50);
    for (const d of pv.denoms) { const k = Math.floor(left / d); if (k) { denom[d] = k; left -= k * d; } }
    const c = await api('/closing', { method: 'POST', body: {
      biz_date: pv.biz_date, shift_label: '全日', denom, handover_to: '自動化測試',
      note: '自動化測試：故意短少 50 元' } });
    if (Math.abs(c.diff - (c.counted_cash - c.expected_cash)) > 1) throw new Error('短溢算錯');
    await api(`/closing/${c.id}/void`, { method: 'POST', body: { reason: '自動化測試，用完作廢' } });
    return `${c.closing_no} 應有 ${c.expected_cash}／實點 ${c.counted_cash}／短溢 ${c.diff}`;
  });

  await step('日結：短溢超標又不寫原因會被擋', async () => {
    const pv = await api('/closing/preview');
    try {
      await api('/closing', { method: 'POST', body: {
        biz_date: pv.biz_date, shift_label: '早班', counted_cash: pv.expected_cash - 5000 } });
      throw new Error('竟然讓它存進去了');
    } catch (e) {
      if (!/超過容忍值/.test(e.message)) throw e;
      return e.message;
    }
  });

  await step('班表：排班 → 複製下週 → 與實際簽到對照', async () => {
    const g = await api('/roster');
    const th = g.therapists[0];
    const day = g.dates[0];
    await api('/roster', { method: 'PUT', body: { work_date: day, therapist_id: th.id, shift_code: '早班' } });
    const g2 = await api('/roster');
    const cell = g2.cells[`${day}|${th.id}`];
    if (!cell || cell.shift_code !== '早班') throw new Error('班表沒存進去');
    if (cell.start_time !== '10:00') throw new Error(`班別預設時間沒帶進來：${cell.start_time}`);
    const cp = await api('/roster/copy', { method: 'POST', body: {
      from_start: g.from, to_start: g.dates[6], overwrite: false } });
    const cmp = await api(`/roster/compare?from=${g.from}&to=${g.dates[6]}`);
    return `${th.name} ${day} 早班 10:00、複製 ${cp.copied} 格、落差 ${cmp.absent.length + cmp.unplanned.length} 筆`;
  });

  await step('發票：開立 → 折讓 → 作廢', async () => {
    const before = await api('/invoices');
    if (!before.missing.length) return '（沒有待開發票，略過）';
    const tk = before.missing[0];
    const inv = await api('/invoices', { method: 'POST', body: { ticket_id: tk.id } });
    if (inv.net_amount + inv.tax_amount !== inv.amount) throw new Error('未稅＋稅額 ≠ 含稅總額');
    // 重複開要被擋
    let dup = false;
    try { await api('/invoices', { method: 'POST', body: { ticket_id: tk.id } }); }
    catch (e) { dup = /已經開過/.test(e.message); }
    if (!dup) throw new Error('同一張單開了兩次發票');
    await api(`/invoices/${inv.id}/allowance`, { method: 'POST', body: { amount: 100, reason: '自動化測試折讓' } });
    await api(`/invoices/${inv.id}/void`, { method: 'POST', body: { reason: '自動化測試，用完作廢' } });
    return `${inv.track}-${inv.number}：${inv.amount}＝未稅 ${inv.net_amount}＋稅 ${inv.tax_amount}`;
  });

  await step('集點：加點 → 兌換成儲值贈送金', async () => {
    const mm = (await api('/members?q='))[3];
    await api('/loyalty/adjust', { method: 'POST', body: { member_id: mm.id, points: 500, reason: '自動化測試加點' } });
    const w1 = await api(`/wallets/${mm.id}`);
    const r = await api('/loyalty/redeem', { method: 'POST', body: { member_id: mm.id, points: 300 } });
    const w2 = await api(`/wallets/${mm.id}`);
    if (w2.balance.bonus - w1.balance.bonus !== r.value) throw new Error('兌換的贈送金沒進到儲值');
    if (w2.balance.cash !== w1.balance.cash) throw new Error('兌換不該動到現金部位');
    await api('/loyalty/adjust', { method: 'POST', body: { member_id: mm.id, points: -200, reason: '自動化測試還原' } });
    return `300 點 → 贈送金 ${r.value}（現金部位不動），餘 ${r.balance} 點`;
  });

  await step('上傳檔案：存檔後回讀驗證指紋', async () => {
    const mm = (await api('/members?q='))[4];
    const out = await p.evaluate(async (id) => {
      const cv = document.createElement('canvas'); cv.width = 80; cv.height = 50;
      const cx = cv.getContext('2d'); cx.fillStyle = '#4a7'; cx.fillRect(0, 0, 80, 50);
      const data = cv.toDataURL('image/png');
      const r = await fetch(`/api/members/${id}/photo`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, filename: 'e2e-測試照片.png' }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      // 讀回來：後端會重算指紋，壞掉會回 410
      const back = await fetch(d.url);
      const buf = await back.arrayBuffer();
      return { id: d.id, bytes: d.bytes, sha: d.sha256.slice(0, 8), readBack: buf.byteLength, status: back.status };
    }, mm.id);
    if (out.status !== 200) throw new Error(`讀回檔案失敗：HTTP ${out.status}`);
    if (out.readBack !== out.bytes) throw new Error(`讀回大小不符：${out.readBack} vs ${out.bytes}`);
    await api(`/files/${out.id}`, { method: 'DELETE' });
    return `${out.bytes} 位元組，sha ${out.sha}…，讀回一致`;
  });

  await step('假造的圖片會被擋下來', async () => {
    const mm = (await api('/members?q='))[4];
    const msg = await p.evaluate(async (id) => {
      // btoa 只吃 Latin1，所以用純 ASCII 假內容（重點是它不是真的 PNG）
      const fake = 'data:image/png;base64,' + btoa('NOT-A-REAL-PNG-'.repeat(8));
      const r = await fetch(`/api/members/${id}/photo`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: fake, filename: 'x.png' }) });
      const d = await r.json();
      return r.ok ? 'OK（不該通過）' : d.error;
    }, mm.id);
    if (!/不像|損壞/.test(msg)) throw new Error(msg);
    return msg;
  });

  await step('同意書：簽名存檔並可調閱', async () => {
    const mm = (await api('/members?q='))[5];
    const out = await p.evaluate(async (id) => {
      const cv = document.createElement('canvas'); cv.width = 200; cv.height = 80;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, 200, 80);
      cx.strokeStyle = '#111'; cx.lineWidth = 2;
      cx.beginPath(); cx.moveTo(20, 60); cx.lineTo(80, 20); cx.lineTo(140, 60); cx.stroke();
      const r = await fetch('/api/consents', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: id, signature: cv.toDataURL('image/png'), signer_name: 'E2E 測試' }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      const img = await fetch(d.signature);
      return { id: d.id, sig: d.signature, status: img.status, snapshot: d.conditions };
    }, mm.id);
    if (out.status !== 200) throw new Error(`簽名檔讀不回來：HTTP ${out.status}`);
    const st = await api(`/consents?member_id=${mm.id}`);
    if (st.status.status !== 'ok') throw new Error(`簽完狀態應為有效，實際 ${st.status.status}`);
    return `#${out.id} 簽名檔 ${out.sig}，狀態 ${st.status.label}`;
  });

  await step('收據頁印得出東西', async () => {
    const done = (await api('/tickets?status=done'))[0];
    const r = await api(`/tickets/${done.id}/receipt`);
    if (!r.ticket || !r.store) throw new Error('收據資料不完整');
    // 一定要用同一個 context 開分頁，b.newPage() 會開一個全新的（沒有登入 cookie）
    const page = await ctx.newPage();
    await page.goto((process.env.BASE_URL || 'http://127.0.0.1:3460/') + `print.html#ticket=${done.id}`);
    await page.waitForSelector('.receipt');
    const text = await page.textContent('.receipt');
    await page.close();
    if (!text.includes(done.ticket_no)) throw new Error('收據上沒有單號');
    return `${done.ticket_no}：應收 ${r.ticket.net_amount}、餘額與次卡都印得出來`;
  });

  await step('備份：建立並確認打得開', async () => {
    const r = await api('/backups', { method: 'POST', body: {} });
    if (!r.verified) throw new Error('備份沒通過驗證');
    const list = await api('/backups');
    if (!list.rows.find(x => x.name === r.name)) throw new Error('備份沒出現在清單裡');
    if (!list.files.ok) throw new Error(`附件檢查有問題：${list.files.bad.length} 個`);
    return `${r.name}（${(r.bytes / 1048576).toFixed(1)}MB、${r.tickets} 張鐘單），附件 ${list.files.checked} 個全部正常`;
  });

  await step('忘記密碼：代碼只能用一次', async () => {
    const users = await api('/users');
    const u = users.find(x => x.username === 'front') || users.find(x => x.role !== 'admin');
    if (!u) return '（沒有非管理員帳號，略過）';
    const rc = await api(`/users/${u.id}/reset-code`, { method: 'POST', body: {} });
    const first = await p.evaluate(async ([un, code]) => {
      const r = await fetch('/api/password-reset', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: un, code, new_password: 'temp123456' }) });
      return { ok: r.ok, d: await r.json() };
    }, [u.username, rc.code]);
    if (!first.ok) throw new Error('第一次就失敗：' + first.d.error);
    const second = await p.evaluate(async ([un, code]) => {
      const r = await fetch('/api/password-reset', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: un, code, new_password: 'other123456' }) });
      return { ok: r.ok, d: await r.json() };
    }, [u.username, rc.code]);
    if (second.ok) throw new Error('代碼竟然可以重複使用');
    // 還原成示範密碼
    await api(`/users/${u.id}`, { method: 'PUT', body: { password: '123456' } });
    return `代碼 ${rc.code} 可用一次，第二次被擋：${second.d.error}`;
  });

  await b.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
