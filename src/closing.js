// 日結與交班。
//
// 櫃檯每天換班一定要對一次現金抽屜。沒有這張表，短溢只能靠 Excel 或吵架解決，
// 而「今天少了八百塊」這件事如果沒有當天結出來，隔天就再也查不出是哪一筆。
//
// 這個模組只做一件事，但要做對：**應有現金是系統算的，實點現金是人數的，兩者的差額必須留下來。**
// 系統不會、也不該把數字改到一樣 —— 短溢本身就是資訊。
//
// 應有現金 = 抽屜零用金
//          + 鐘單收現（付款方式屬「現金類」的那部分）
//          + 儲值收現
//          + 售卡收現
//          - 當班以現金支付的費用
//
// 刷卡、行動支付不進抽屜，另外列出來跟收單機對；動用儲值、次卡、團購券完全不是現金，
// 只列給人看，避免有人把它們也加進去點鈔。
const { db, getSetting, getList, num, today, nowStamp, bizDate, bizRange, nextSerial,
  money, yuan, audit } = require('./db');

function cashMethods() {
  return getSetting('cash_pay_methods', '現金').split('\n').map(s => s.trim()).filter(Boolean);
}
function cardMethods() {
  return getSetting('card_pay_methods', '').split('\n').map(s => s.trim()).filter(Boolean);
}
function shiftLabels() {
  return getSetting('closing_shifts', '全日').split('\n').map(s => s.trim()).filter(Boolean);
}

// SQL 的 IN (...) 佔位符
function inClause(list) {
  return list.length ? `(${list.map(() => '?').join(',')})` : '(NULL)';
}

// 本班的統計區間。沒指定就用整個營業日（含跨午夜）。
function rangeOf(bizDateStr, fromAt, toAt) {
  const r = bizRange(bizDateStr);
  return { from: fromAt || r.start, to: toAt || r.end };
}

// 算一班的帳。closingId 有值時排除掉「已經被其他已確認日結涵蓋」的問題交給呼叫端，
// 這裡單純照時間區間算 —— 區間是誰決定的，就由誰負責不要重疊。
function compute({ storeId, bizDate: d, fromAt, toAt, openFloat }) {
  const day = d || bizDate();
  const { from, to } = rangeOf(day, fromAt, toAt);
  const cash = cashMethods(), card = cardMethods();
  const sf = storeId ? ' AND t.store_id = ?' : '';
  const sargs = storeId ? [Number(storeId)] : [];

  // 鐘單：用結帳時間（actual_end）落在區間內來分班，不是用營業日 ——
  // 早班的客人做到晚班才結帳，那筆錢在晚班的抽屜裡。
  const timeExpr = "COALESCE(NULLIF(t.actual_end,''), t.start_at)";
  const rows = db.prepare(`SELECT t.id, t.ticket_no, t.pay_method, t.paid_cash, t.paid_wallet,
      t.paid_pass, t.paid_voucher, t.net_amount, ${timeExpr} AS at
    FROM tickets t WHERE t.status = 'done' AND ${timeExpr} >= ? AND ${timeExpr} < ?${sf}
    ORDER BY at`).all(from, to, ...sargs);

  let ticketCash = 0, cardAmount = 0, otherAmount = 0;
  for (const r of rows) {
    const v = yuan(r.paid_cash);
    if (!v) continue;
    if (cash.includes(r.pay_method) || !r.pay_method) ticketCash += v;    // 沒填付款方式一律當現金（收銀機的預設行為）
    else if (card.includes(r.pay_method)) cardAmount += v;
    else otherAmount += v;
  }

  const wf = storeId ? ' AND w.store_id = ?' : '';
  const topupRows = db.prepare(`SELECT w.pay_method, COALESCE(SUM(w.amount),0) v FROM wallet_txns w
    WHERE w.kind = 'topup' AND w.created_at >= ? AND w.created_at < ?${wf}
    GROUP BY w.pay_method`).all(from, to, ...sargs);
  let topupCash = 0, topupCard = 0;
  for (const r of topupRows) {
    if (cash.includes(r.pay_method) || !r.pay_method) topupCash += yuan(r.v);
    else if (card.includes(r.pay_method)) topupCard += yuan(r.v);
    else otherAmount += yuan(r.v);
  }

  const pf = storeId ? ' AND p.store_id = ?' : '';
  const passRows = db.prepare(`SELECT p.pay_method, COALESCE(SUM(p.price_paid),0) v FROM passes p
    WHERE p.created_at >= ? AND p.created_at < ?${pf} GROUP BY p.pay_method`).all(from, to, ...sargs);
  let passCash = 0, passCard = 0;
  for (const r of passRows) {
    if (cash.includes(r.pay_method) || !r.pay_method) passCash += yuan(r.v);
    else if (card.includes(r.pay_method)) passCard += yuan(r.v);
    else otherAmount += yuan(r.v);
  }

  // 現金退款要從抽屜裡拿出去
  const refundCash = yuan(db.prepare(`SELECT COALESCE(SUM(w.amount),0) v FROM wallet_txns w
    WHERE w.kind = 'refund' AND w.created_at >= ? AND w.created_at < ?${wf}`).get(from, to, ...sargs).v);

  // 當班的現金支出（零用金買水、叫便當、修東西）。
  //
  // 這裡用「登錄時間」歸班，不是用 spend_date。
  // 原本是 `spend_date = ?`，也就是整個營業日 —— 早班與晚班各結一次時，
  // **兩張日結都會扣掉同一天的全部現金支出**，短少憑空多出一份。
  // 費用資料表只有日期沒有時分，所以只能用 created_at（key 進系統的時刻）當代理，
  // 對一家小店來說那跟「錢從抽屜拿出去的時刻」差不了多少。
  const ef = storeId ? ' AND store_id = ?' : '';
  const cashExpense = yuan(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM expenses
    WHERE created_at >= ? AND created_at < ? AND pay_method IN ${inClause(cash)}${ef}`)
    .get(from, to, ...cash, ...sargs).v);
  // 同一個營業日、但登錄時間落在本班區間之外的現金支出（多半是隔天才補登的）。
  // 這筆錢確實從某個抽屜拿出去了，卻不會出現在任何一張日結上 ——
  // 與其讓它變成一筆查不出來的短少，不如在畫面上講出來。
  const outsideExpense = yuan(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM expenses
    WHERE spend_date = ? AND NOT (created_at >= ? AND created_at < ?)
      AND pay_method IN ${inClause(cash)}${ef}`)
    .get(day, from, to, ...cash, ...sargs).v);

  const walletUsed = yuan(rows.reduce((s, r) => s + r.paid_wallet, 0));
  const passUsed = yuan(rows.reduce((s, r) => s + r.paid_pass, 0));
  const voucherUsed = yuan(rows.reduce((s, r) => s + r.paid_voucher, 0));
  const float = openFloat === undefined || openFloat === '' ? num('cash_open_float', 0) : yuan(openFloat);
  const expected = yuan(float + ticketCash + topupCash + passCash - cashExpense - refundCash);

  return {
    store_id: storeId ? Number(storeId) : null,
    biz_date: day, from_at: from, to_at: to,
    open_float: float,
    ticket_cash: yuan(ticketCash), topup_cash: yuan(topupCash), pass_cash: yuan(passCash),
    cash_expense: cashExpense, cash_expense_outside: outsideExpense, cash_refund: refundCash,
    expected_cash: expected,
    card_amount: yuan(cardAmount + topupCard + passCard),
    other_amount: yuan(otherAmount),
    wallet_used: walletUsed, pass_used: passUsed, voucher_used: voucherUsed,
    tickets: rows.length,
    revenue: yuan(rows.reduce((s, r) => s + r.net_amount, 0)),
    tolerance: num('cash_diff_tolerance', 0),
    ticket_rows: rows
  };
}

// 面額點鈔。{"1000":3,"500":2,"100":7,...} → 合計
const DENOMS = [2000, 1000, 500, 200, 100, 50, 20, 10, 5, 1];
function countDenom(denom) {
  let total = 0;
  for (const d of DENOMS) total += d * (Number((denom || {})[d]) || 0);
  return total;
}

// 建立日結單。counted_cash 是人點出來的，diff 由系統算 —— 兩個都存，誰也不覆蓋誰。
const create = db.transaction((d) => {
  const day = d.biz_date || bizDate();
  const label = String(d.shift_label || '全日').trim() || '全日';
  const storeId = d.store_id ? Number(d.store_id) : null;
  const dup = db.prepare(`SELECT * FROM closings WHERE biz_date = ? AND shift_label = ?
    AND store_id IS ? AND status = 'confirmed'`).get(day, label, storeId);
  if (dup) throw new Error(`${day} 的${label}已經結過了（${dup.closing_no}），要重結請先作廢原本那張`);

  const c = compute({ storeId, bizDate: day, fromAt: d.from_at, toAt: d.to_at, openFloat: d.open_float });
  const denom = d.denom && typeof d.denom === 'object' ? d.denom : null;
  // 有填面額就以面額加總為準：那是實際數出來的，比手動輸入的總額可信
  const counted = denom ? countDenom(denom) : yuan(d.counted_cash);
  const diff = yuan(counted - c.expected_cash);
  const tol = num('cash_diff_tolerance', 0);
  if (Math.abs(diff) > tol && !String(d.note || '').trim()) {
    throw new Error(`短溢 ${diff} 元超過容忍值 ${tol} 元，請在備註說明原因`);
  }
  const no = nextSerial('CL', day);
  const info = db.prepare(`INSERT INTO closings(closing_no,store_id,biz_date,shift_label,from_at,to_at,
      open_float,expected_cash,counted_cash,diff,ticket_cash,topup_cash,pass_cash,cash_expense,
      card_amount,other_amount,wallet_used,pass_used,voucher_used,tickets,denom,handover_to,status,note,actor,confirmed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(no, storeId, day, label, c.from_at, c.to_at, c.open_float, c.expected_cash, counted, diff,
      c.ticket_cash, c.topup_cash, c.pass_cash, c.cash_expense, c.card_amount, c.other_amount,
      c.wallet_used, c.pass_used, c.voucher_used, c.tickets,
      denom ? JSON.stringify(denom) : '', String(d.handover_to || ''),
      d.status === 'draft' ? 'draft' : 'confirmed', String(d.note || ''), String(d.actor || ''),
      d.status === 'draft' ? '' : nowStamp());
  audit('staff', null, d.actor || '',
    `日結 ${no}（${day} ${label}）：應有 ${c.expected_cash}／實點 ${counted}／差額 ${diff} 元`
    + (d.handover_to ? `，交班給 ${d.handover_to}` : ''));
  return get(info.lastInsertRowid);
});

function get(id) {
  const r = db.prepare(`SELECT c.*, s.name AS store_name FROM closings c
    LEFT JOIN stores s ON s.id = c.store_id WHERE c.id = ?`).get(id);
  if (!r) return null;
  let denom = null;
  try { denom = r.denom ? JSON.parse(r.denom) : null; } catch { denom = null; }
  return { ...r, denom, tolerance: num('cash_diff_tolerance', 0) };
}

function list({ from, to, store_id, status, limit = 200 } = {}) {
  const where = [], args = [];
  if (from) { where.push('c.biz_date >= ?'); args.push(from); }
  if (to) { where.push('c.biz_date <= ?'); args.push(to); }
  if (store_id) { where.push('c.store_id = ?'); args.push(store_id); }
  if (status) { where.push('c.status = ?'); args.push(status); }
  return db.prepare(`SELECT c.*, s.name AS store_name FROM closings c
    LEFT JOIN stores s ON s.id = c.store_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.biz_date DESC, c.id DESC LIMIT ?`).all(...args, limit);
}

// 作廢：日結單不刪除。點錯了就作廢重開，讓「這一班結了兩次」看得出來。
const voidClosing = db.transaction(({ id, reason, actor }) => {
  const c = get(id);
  if (!c) throw new Error('找不到這張日結單');
  if (c.status === 'void') throw new Error('這張日結單已經作廢了');
  if (!String(reason || '').trim()) throw new Error('作廢日結必須填寫原因');
  db.prepare("UPDATE closings SET status = 'void', note = TRIM(note || ' ｜作廢：' || ?) WHERE id = ?")
    .run(String(reason).trim(), id);
  audit('staff', null, actor || '', `作廢日結 ${c.closing_no}：${reason}`);
  return get(id);
});

// 還沒結的營業日。開店久了一定會漏結，這份名單是月底會計第一個要看的東西。
function unclosed({ storeId, days = 30 } = {}) {
  const { shiftDate } = require('./db');
  const from = shiftDate(today(), -days);
  const f = storeId ? ' AND t.store_id = ?' : '';
  const args = storeId ? [Number(storeId)] : [];
  const dates = db.prepare(`SELECT t.biz_date d, COUNT(*) n, COALESCE(SUM(t.paid_cash),0) cash
    FROM tickets t WHERE t.status = 'done' AND t.biz_date >= ? AND t.biz_date <= ?${f}
    GROUP BY t.biz_date ORDER BY t.biz_date DESC`).all(from, today(), ...args);
  const cf = storeId ? ' AND store_id = ?' : '';
  const closed = new Set(db.prepare(`SELECT biz_date FROM closings
    WHERE biz_date >= ? AND status = 'confirmed'${cf}`).all(from, ...args).map(r => r.biz_date));
  return dates.filter(d => !closed.has(d.d));
}

// 期間彙總：短溢總額與次數。哪一班一直在短少，看這張就知道。
function summary({ from, to, storeId } = {}) {
  const f = storeId ? ' AND store_id = ?' : '';
  const args = storeId ? [Number(storeId)] : [];
  const rows = db.prepare(`SELECT shift_label, COUNT(*) n,
      COALESCE(SUM(diff),0) diff_total,
      COALESCE(SUM(CASE WHEN diff < 0 THEN diff ELSE 0 END),0) short_total,
      COALESCE(SUM(CASE WHEN diff > 0 THEN diff ELSE 0 END),0) over_total,
      COALESCE(SUM(expected_cash),0) expected, COALESCE(SUM(counted_cash),0) counted
    FROM closings WHERE status = 'confirmed' AND biz_date >= ? AND biz_date <= ?${f}
    GROUP BY shift_label`).all(from || today(), to || today(), ...args);
  return {
    rows,
    total: rows.reduce((a, r) => ({
      n: a.n + r.n, diff_total: a.diff_total + r.diff_total,
      short_total: a.short_total + r.short_total, over_total: a.over_total + r.over_total,
      expected: a.expected + r.expected, counted: a.counted + r.counted
    }), { n: 0, diff_total: 0, short_total: 0, over_total: 0, expected: 0, counted: 0 })
  };
}

module.exports = {
  DENOMS, cashMethods, cardMethods, shiftLabels, compute, countDenom,
  create, get, list, voidClosing, unclosed, summary
};
