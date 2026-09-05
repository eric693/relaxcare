// 發票與折讓登錄。
//
// 這套系統不連接國稅局，也不代開電子發票 —— 它做的是「把實際開出去的號碼記下來」。
// 沒有這件事，營業稅試算永遠對不回申報書：試算算的是「應該開多少」，
// 而國稅局看的是「你開了哪幾張、作廢了哪幾張、折讓了多少」。
//
// 三個狀態要分清楚，實務上最常搞混的就是後兩個：
//   issued    已開立
//   void      作廢 —— 整張不算數（當天發現開錯、客人取消）。銷售額全額不認列。
//   allowance 折讓 —— 東西已經賣了、發票也開了，事後退一部分錢（退卡、客訴補償）。
//                    原發票仍然有效，只是銷售額減掉折讓金額。
//
// 金額一律以「含稅總額」為主，未稅與稅額由它反推 —— 因為店裡標的價、
// 客人付的錢、鐘單上的 net_amount 全都是含稅的，反過來存會到處都要換算。
const { db, getSetting, setSetting, num, today, nowStamp, monthRange, thisMonth, money, yuan, audit } = require('./db');

function enabled() { return getSetting('invoice_enabled', '1') === '1'; }
function rate() { return num('vat_rate', 5); }

// 含稅總額 → { net 未稅, tax 稅額 }。四捨五入放在未稅那一邊，
// 稅額用相減得到，這樣「未稅＋稅額」永遠等於含稅總額，不會差一元。
function split(amount, r = rate()) {
  const gross = yuan(amount);
  const net = Math.round(gross / (1 + r / 100));
  return { gross, net, tax: gross - net };
}

// 下一個號碼。設定沒填就回空字串，由使用者自己輸入（很多店是手開紙本）。
function peekNumber() {
  const n = String(getSetting('invoice_next_no', '')).trim();
  return /^\d{1,8}$/.test(n) ? n.padStart(8, '0') : '';
}
function takeNumber() {
  const cur = peekNumber();
  if (!cur) return '';
  setSetting('invoice_next_no', String(Number(cur) + 1).padStart(8, '0'));
  return cur;
}

function invoiceOf(id) {
  return db.prepare(`SELECT i.*, t.ticket_no, m.name AS member_name, s.name AS store_name
    FROM invoices i
    LEFT JOIN tickets t ON t.id = i.ticket_id
    LEFT JOIN members m ON m.id = i.member_id
    LEFT JOIN stores s ON s.id = i.store_id WHERE i.id = ?`).get(id);
}

// 開立。ticketId 可以是空的（賣禮券、儲值也可能要開）。
const issue = db.transaction((d) => {
  const amount = yuan(d.amount);
  if (amount <= 0) throw new Error('發票金額要大於 0');
  const track = String(d.track || getSetting('invoice_track', '')).trim().toUpperCase();
  const number = String(d.number || '').trim() || takeNumber();
  if (!track) throw new Error('請先在系統設定填寫發票字軌，或在開立時指定');
  if (!number) throw new Error('請輸入發票號碼（或在系統設定填寫起始號碼讓系統自動帶）');
  if (!/^\d{8}$/.test(number)) throw new Error('發票號碼是 8 位數字');
  const dup = db.prepare('SELECT id FROM invoices WHERE track = ? AND number = ?').get(track, number);
  if (dup) throw new Error(`發票 ${track}-${number} 已經登錄過了`);
  const type = d.invoice_type === 'B2B' ? 'B2B' : 'B2C';
  const taxId = String(d.buyer_tax_id || '').trim();
  if (type === 'B2B' && !/^\d{8}$/.test(taxId)) throw new Error('三聯式發票要填 8 碼統一編號');

  let ticket = null;
  if (d.ticket_id) {
    ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(d.ticket_id);
    if (!ticket) throw new Error('找不到這張鐘單');
    const exist = db.prepare("SELECT * FROM invoices WHERE ticket_id = ? AND status <> 'void'").get(d.ticket_id);
    if (exist) throw new Error(`${ticket.ticket_no} 已經開過發票 ${exist.track}-${exist.number}`);
  }
  const s = split(amount);
  const info = db.prepare(`INSERT INTO invoices(track,number,invoice_date,store_id,ticket_id,member_id,
      buyer_name,buyer_tax_id,invoice_type,amount,net_amount,tax_amount,tax_rate,status,note,actor)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'issued',?,?)`)
    .run(track, number, d.invoice_date || today(), d.store_id || ticket?.store_id || null,
      d.ticket_id || null, d.member_id || ticket?.member_id || null,
      String(d.buyer_name || '').trim(), taxId, type,
      s.gross, s.net, s.tax, rate(), String(d.note || ''), String(d.actor || ''));
  if (ticket) db.prepare('UPDATE tickets SET invoice_id = ? WHERE id = ?').run(info.lastInsertRowid, ticket.id);
  audit('staff', null, d.actor || '',
    `開立發票 ${track}-${number}：${s.gross} 元（未稅 ${s.net}／稅 ${s.tax}）${ticket ? `｜${ticket.ticket_no}` : ''}`);
  return invoiceOf(info.lastInsertRowid);
});

// 依鐘單開立：金額直接取應收，買受人帶客人資料
function issueForTicket({ ticketId, actor, ...rest }) {
  const t = db.prepare(`SELECT t.*, m.name AS member_name FROM tickets t
    LEFT JOIN members m ON m.id = t.member_id WHERE t.id = ?`).get(ticketId);
  if (!t) throw new Error('找不到這張鐘單');
  if (t.status !== 'done') throw new Error('鐘單還沒結帳，不能開立發票');
  return issue({
    ticket_id: t.id, store_id: t.store_id, member_id: t.member_id,
    buyer_name: rest.buyer_name || t.member_name || t.guest_name || '',
    amount: rest.amount !== undefined ? rest.amount : t.net_amount,
    invoice_date: rest.invoice_date, track: rest.track, number: rest.number,
    invoice_type: rest.invoice_type, buyer_tax_id: rest.buyer_tax_id, note: rest.note, actor
  });
}

const voidInvoice = db.transaction(({ id, reason, actor }) => {
  const inv = invoiceOf(id);
  if (!inv) throw new Error('找不到這張發票');
  if (inv.status === 'void') throw new Error('這張發票已經作廢了');
  if (!String(reason || '').trim()) throw new Error('作廢發票必須填寫原因');
  db.prepare("UPDATE invoices SET status = 'void', void_reason = ? WHERE id = ?").run(String(reason).trim(), id);
  if (inv.ticket_id) db.prepare('UPDATE tickets SET invoice_id = NULL WHERE id = ?').run(inv.ticket_id);
  audit('staff', null, actor || '', `作廢發票 ${inv.track}-${inv.number}：${reason}`);
  return invoiceOf(id);
});

// 鐘單被取消時連帶作廢（結帳後才發現要退整筆的情形）
function voidForTicket({ ticketId, reason, actor }) {
  const inv = db.prepare("SELECT * FROM invoices WHERE ticket_id = ? AND status <> 'void'").get(ticketId);
  if (!inv) return null;
  return voidInvoice({ id: inv.id, reason: `鐘單取消：${reason || '未填原因'}`, actor });
}

// 折讓：原發票仍有效，銷售額扣掉折讓金額。可以分次折讓，累計不得超過原金額。
const allowance = db.transaction(({ id, amount, reason, date, actor }) => {
  const inv = invoiceOf(id);
  if (!inv) throw new Error('找不到這張發票');
  if (inv.status === 'void') throw new Error('已作廢的發票不能開折讓');
  const amt = yuan(amount);
  if (amt <= 0) throw new Error('折讓金額要大於 0');
  const already = yuan(inv.allowance_amount);
  if (already + amt > yuan(inv.amount)) {
    throw new Error(`折讓累計 ${already + amt} 元會超過發票金額 ${yuan(inv.amount)} 元`);
  }
  if (!String(reason || '').trim()) throw new Error('開立折讓必須填寫原因');
  db.prepare(`UPDATE invoices SET status = 'allowance', allowance_amount = ?, allowance_date = ?,
    allowance_reason = TRIM(COALESCE(NULLIF(allowance_reason,''),'') || CASE WHEN allowance_reason <> '' THEN ' ｜' ELSE '' END || ?)
    WHERE id = ?`).run(already + amt, date || today(), String(reason).trim(), id);
  audit('staff', null, actor || '', `發票 ${inv.track}-${inv.number} 開立折讓 ${amt} 元：${reason}`);
  return invoiceOf(id);
});

function list({ from, to, status, store_id, q, limit = 500 } = {}) {
  const where = [], args = [];
  if (from) { where.push('i.invoice_date >= ?'); args.push(from); }
  if (to) { where.push('i.invoice_date <= ?'); args.push(to); }
  if (status) { where.push('i.status = ?'); args.push(status); }
  if (store_id) { where.push('i.store_id = ?'); args.push(store_id); }
  if (q) {
    where.push('(i.number LIKE ? OR i.buyer_name LIKE ? OR i.buyer_tax_id LIKE ? OR t.ticket_no LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  return db.prepare(`SELECT i.*, t.ticket_no, m.name AS member_name, s.name AS store_name
    FROM invoices i
    LEFT JOIN tickets t ON t.id = i.ticket_id
    LEFT JOIN members m ON m.id = i.member_id
    LEFT JOIN stores s ON s.id = i.store_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.invoice_date DESC, i.id DESC LIMIT ?`).all(...args, limit);
}

// 期間彙總，給營業稅頁對帳用
function summary(period, storeId) {
  const { start, end } = monthRange(period || thisMonth());
  const f = storeId ? ' AND store_id = ?' : '';
  const args = storeId ? [storeId] : [];
  const rows = db.prepare(`SELECT status, COUNT(*) n, COALESCE(SUM(amount),0) amount,
      COALESCE(SUM(net_amount),0) net, COALESCE(SUM(tax_amount),0) tax,
      COALESCE(SUM(allowance_amount),0) allowance
    FROM invoices WHERE invoice_date >= ? AND invoice_date < ?${f} GROUP BY status`)
    .all(start, end, ...args);
  const by = Object.fromEntries(rows.map(r => [r.status, r]));
  const valid = ['issued', 'allowance'].reduce((acc, k) => {
    const r = by[k];
    if (r) { acc.n += r.n; acc.amount += r.amount; acc.net += r.net; acc.tax += r.tax; acc.allowance += r.allowance; }
    return acc;
  }, { n: 0, amount: 0, net: 0, tax: 0, allowance: 0 });
  const netAfter = split(valid.amount - valid.allowance);
  return {
    period: period || thisMonth(), start, end,
    issued_count: valid.n,
    void_count: (by.void || {}).n || 0,
    gross: yuan(valid.amount),
    allowance: yuan(valid.allowance),
    // 申報用：開立總額扣掉折讓後，再拆未稅與稅額
    taxable_gross: netAfter.gross, net_sales: netAfter.net, output_tax: netAfter.tax,
    by_status: rows
  };
}

// 已結帳但還沒開發票的鐘單。月底要補開的就是這一份名單。
function missing({ from, to, storeId } = {}) {
  const where = ["t.status = 'done'", 't.net_amount > 0',
    "NOT EXISTS (SELECT 1 FROM invoices i WHERE i.ticket_id = t.id AND i.status <> 'void')"];
  const args = [];
  if (from) { where.push('t.biz_date >= ?'); args.push(from); }
  if (to) { where.push('t.biz_date <= ?'); args.push(to); }
  if (storeId) { where.push('t.store_id = ?'); args.push(storeId); }
  return db.prepare(`SELECT t.id, t.ticket_no, t.biz_date, t.net_amount, t.pay_method,
      COALESCE(m.name, t.guest_name) AS customer, s.name AS store_name
    FROM tickets t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN stores s ON s.id = t.store_id
    WHERE ${where.join(' AND ')} ORDER BY t.biz_date DESC, t.id DESC LIMIT 300`).all(...args);
}

module.exports = {
  enabled, rate, split, peekNumber, invoiceOf, issue, issueForTicket, voidInvoice, voidForTicket,
  allowance, list, summary, missing
};
