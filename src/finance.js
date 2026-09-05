// 營運損益與稅務。
//
// 這行業的損益有一個容易搞錯的地方：**收到的錢不等於當月的收入**。
// 客人儲值 2 萬，那天的現金流是 2 萬，但收入是 0 —— 那是負債。
// 真正的收入發生在他來做的那一天，用掉多少才認列多少。
//
// 所以這裡分開算三組數字，畫面上也分三塊呈現：
//   現金流入 cash_in    ：實際進來的錢（含儲值、賣卡）＝ 老闆看的「今天收了多少」
//   服務營收 revenue    ：實際服務認列的收入（含用儲值／次卡付掉的部分）＝ 損益表的收入
//   預收負債 liability  ：還沒服務完的餘額（見 prepaid.liability）
const { db, monthRange, num, today, yuan, money, bizExpr } = require('./db');
const prepaid = require('./prepaid');

function storeFilter(storeId, alias = 't') {
  return storeId ? { sql: ` AND ${alias}.store_id = ?`, args: [storeId] } : { sql: '', args: [] };
}

// 期間內完成的鐘單彙總
function serviceRevenue(start, end, storeId) {
  const f = storeFilter(storeId);
  // 統計一律用營業日欄位，不從時間字串截日期 ——
  // 24 小時營業的店，凌晨兩點那一鐘要算給前一天的生意。
  const dateExpr = 't.biz_date';
  const r = db.prepare(`
    SELECT COUNT(*) AS tickets,
           COALESCE(SUM(t.minutes),0) AS minutes,
           COALESCE(SUM(t.amount),0) AS service_gross,
           COALESCE(SUM(t.discount),0) AS discount,
           COALESCE(SUM(t.retail_amount),0) AS retail,
           COALESCE(SUM(t.designate_fee),0) AS designate_fee,
           COALESCE(SUM(t.net_amount),0) AS net,
           COALESCE(SUM(t.paid_cash),0) AS paid_cash,
           COALESCE(SUM(t.paid_wallet),0) AS paid_wallet,
           COALESCE(SUM(t.paid_pass),0) AS paid_pass,
           COALESCE(SUM(t.paid_voucher),0) AS paid_voucher,
           COALESCE(SUM(t.list_amount),0) AS list_total,
           COALESCE(SUM(t.comm_service + t.comm_retail + t.comm_designate),0) AS commission,
           SUM(CASE WHEN t.assign_type = 'designated' THEN 1 ELSE 0 END) AS designated_tickets
    FROM tickets t
    WHERE t.status = 'done' AND ${dateExpr} >= ? AND ${dateExpr} < ?${f.sql}`).get(start, end, ...f.args);
  return {
    tickets: r.tickets || 0, minutes: r.minutes || 0,
    service_gross: yuan(r.service_gross), discount: yuan(r.discount),
    retail: yuan(r.retail), designate_fee: yuan(r.designate_fee),
    revenue: yuan(r.net), commission: yuan(r.commission),
    paid_cash: yuan(r.paid_cash), paid_wallet: yuan(r.paid_wallet), paid_pass: yuan(r.paid_pass),
    paid_voucher: yuan(r.paid_voucher),
    list_total: yuan(r.list_total),
    // 實收 ÷ 牌價。低於 0.7 通常代表折扣給得太兇，或團購券佔比過高。
    realization: r.list_total ? yuan(r.net) / yuan(r.list_total) : 0,
    designated_tickets: r.designated_tickets || 0
  };
}

// 期間內實際收到的現金（鐘單現金 + 儲值 + 賣卡 - 退款）
//
// 期間篩選一律用**營業日**，不是日曆日。
// 鐘單有 biz_date 欄位，其他表只有 created_at，所以用 bizExpr() 現算 ——
// 兩邊用不同的口徑，24 小時店在月底就會出現「營收算上個月、現金流入算這個月」。
function cashFlow(start, end, storeId) {
  const f = storeFilter(storeId);
  const dateExpr = 't.biz_date';
  const tk = db.prepare(`SELECT COALESCE(SUM(t.paid_cash),0) AS v FROM tickets t
    WHERE t.status = 'done' AND ${dateExpr} >= ? AND ${dateExpr} < ?${f.sql}`).get(start, end, ...f.args).v;
  const wf = storeId ? ' AND w.store_id = ?' : '';
  const wargs = storeId ? [storeId] : [];
  const we = bizExpr('w.created_at');
  const topup = db.prepare(`SELECT COALESCE(SUM(w.amount),0) AS v FROM wallet_txns w
    WHERE w.kind = 'topup' AND ${we.sql} >= ? AND ${we.sql} < ?${wf}`)
    .get(...we.args, start, ...we.args, end, ...wargs).v;
  const refund = db.prepare(`SELECT COALESCE(SUM(w.amount),0) AS v FROM wallet_txns w
    WHERE w.kind = 'refund' AND ${we.sql} >= ? AND ${we.sql} < ?${wf}`)
    .get(...we.args, start, ...we.args, end, ...wargs).v;
  const pf = storeId ? ' AND p.store_id = ?' : '';
  // 次卡用 created_at 而不是 buy_date：buy_date 是 today()（日曆日），
  // 凌晨賣的卡會掛到隔天，跟同一刻的鐘單對不起來。
  const pe = bizExpr('p.created_at');
  const pass = db.prepare(`SELECT COALESCE(SUM(p.price_paid),0) AS v FROM passes p
    WHERE ${pe.sql} >= ? AND ${pe.sql} < ?${pf}`).get(...pe.args, start, ...pe.args, end, ...wargs).v;
  const xe = bizExpr('x.created_at');
  const passRefund = db.prepare(`SELECT COALESCE(SUM(x.amount),0) AS v FROM pass_txns x
    WHERE x.kind = 'refund' AND ${xe.sql} >= ? AND ${xe.sql} < ?`)
    .get(...xe.args, start, ...xe.args, end).v;
  // 團購券在核銷當天沒有現金進來（平台月結才撥款），所以只記淨收待撥，不進 total
  const ve = bizExpr('v.used_at');
  const voucherNet = db.prepare(`SELECT COALESCE(SUM(v.net_receivable),0) AS v FROM vouchers v
    WHERE v.status IN ('used','settled') AND v.used_at <> ''
      AND ${ve.sql} >= ? AND ${ve.sql} < ?`).get(...ve.args, start, ...ve.args, end).v;
  return {
    ticket_cash: yuan(tk), topup: yuan(topup), pass_sale: yuan(pass),
    voucher_net: yuan(voucherNet),
    wallet_refund: yuan(refund), pass_refund: yuan(passRefund),
    total: yuan(tk + topup + pass - refund - passRefund)
  };
}

function expenses(start, end, storeId) {
  const f = storeId ? ' AND store_id = ?' : '';
  const args = storeId ? [storeId] : [];
  const rows = db.prepare(`SELECT category, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS cnt
    FROM expenses WHERE spend_date >= ? AND spend_date < ?${f}
    GROUP BY category ORDER BY amount DESC`).all(start, end, ...args);
  return { rows, total: yuan(rows.reduce((s, r) => s + r.amount, 0)) };
}

// 月損益。
//
//   毛利 = 服務營收 − 技師抽成 − 商品銷貨成本
//   淨利 = 毛利 − 營運費用
//
// **商品銷貨成本一定要扣**。原本沒扣，於是匯出的損益表把「商品銷貨成本」列成一行、
// 底下的「毛利」卻沒有減掉它 —— 各列加起來對不上總數，拿給會計看第一眼就會被抓包。
// 成本取自庫存流水（賣出當下記下的成本），不是月底回頭用現在的進價套算。
//
// 底薪不在這裡扣（底薪是固定成本，登在費用登錄），避免同一筆錢被算兩次。
function monthly(period, storeId) {
  const { start, end } = monthRange(period);
  const rev = serviceRevenue(start, end, storeId);
  const exp = expenses(start, end, storeId);
  const cash = cashFlow(start, end, storeId);
  const mv = require('./inventory').movement(start, end, storeId);
  const cogs = yuan(mv.cogs);
  const gross = rev.revenue - rev.commission - cogs;
  const net = gross - exp.total;
  return {
    period, start, end, revenue: rev, expenses: exp, cash,
    commission: rev.commission,
    cogs, inventory: mv,
    // 商品自己的毛利，拿來回答「這些保養品到底有沒有賺」
    retail_margin: yuan(rev.retail - cogs),
    gross_profit: gross,
    net_profit: net,
    margin: rev.revenue ? gross / rev.revenue : 0,
    net_margin: rev.revenue ? net / rev.revenue : 0,
    liability: prepaid.liability(storeId)
  };
}

// 每日趨勢（給圖表用）
function daily(start, end, storeId) {
  const f = storeFilter(storeId);
  const dateExpr = 't.biz_date';
  return db.prepare(`
    SELECT ${dateExpr} AS d, COUNT(*) AS tickets,
           COALESCE(SUM(t.net_amount),0) AS revenue,
           COALESCE(SUM(t.minutes),0) AS minutes
    FROM tickets t WHERE t.status = 'done' AND ${dateExpr} >= ? AND ${dateExpr} < ?${f.sql}
    GROUP BY d ORDER BY d`).all(start, end, ...f.args);
}

// 技師業績排行
function therapistRank(start, end, storeId) {
  const f = storeFilter(storeId);
  const dateExpr = 't.biz_date';
  return db.prepare(`
    SELECT th.id, th.name, th.level, th.code,
           COUNT(*) AS tickets,
           SUM(CASE WHEN t.assign_type='designated' THEN 1 ELSE 0 END) AS designated,
           COALESCE(SUM(t.minutes),0) AS minutes,
           COALESCE(SUM(t.amount - t.discount),0) AS service_amount,
           COALESCE(SUM(t.retail_amount),0) AS retail_amount,
           COALESCE(SUM(t.comm_service + t.comm_retail + t.comm_designate),0) AS commission,
           COALESCE(AVG(NULLIF(t.rating,0)),0) AS rating
    FROM tickets t JOIN therapists th ON th.id = t.therapist_id
    WHERE t.status = 'done' AND ${dateExpr} >= ? AND ${dateExpr} < ?${f.sql}
    GROUP BY th.id ORDER BY service_amount DESC`).all(start, end, ...f.args);
}

// 服務項目排行
function serviceRank(start, end, storeId) {
  const f = storeFilter(storeId);
  const dateExpr = 't.biz_date';
  return db.prepare(`
    SELECT t.service_name AS name, COUNT(*) AS tickets,
           COALESCE(SUM(t.amount),0) AS amount, COALESCE(SUM(t.minutes),0) AS minutes
    FROM tickets t WHERE t.status = 'done' AND ${dateExpr} >= ? AND ${dateExpr} < ?${f.sql}
    GROUP BY t.service_name ORDER BY amount DESC`).all(start, end, ...f.args);
}

// 一天營業幾分鐘。
//
// 直接把 close 減 open 會在這一行的兩種實際店家上壞掉，而且壞得很明顯：
//   · 24 小時店（00:00–00:00）算出 0 分鐘 → 使用率永遠是 0%
//   · 營業到凌晨的店（11:00–03:00）算出負數 → 使用率變成負的
// 兩家示範店正好各中一種。
function openMinutesOf(open, close) {
  const toMin = t => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
  const o = toMin(open || '10:00'), c = toMin(close || '23:00');
  if (o === c) return 1440;          // 開始與結束同一時刻＝ 24 小時營業
  if (c < o) return 1440 - o + c;    // 跨午夜（11:00 開到隔天 03:00）
  return c - o;
}

// 床位使用率：期間內每個床位被佔用的分鐘 ÷ 可營業分鐘
function roomUsage(start, end, storeId) {
  const days = Math.max(1, require('./db').dateDiff(start, end) || 1);
  const rooms = db.prepare(`SELECT * FROM rooms WHERE active = 1${storeId ? ' AND store_id = ?' : ''}`)
    .all(...(storeId ? [storeId] : []));
  const store = storeId ? db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId) : null;
  const open = store?.open_time || '10:00', close = store?.close_time || '23:00';
  const openMin = openMinutesOf(open, close);
  const dateExpr = 't.biz_date';
  const used = db.prepare(`SELECT t.room_id, COALESCE(SUM(t.minutes),0) AS m, COUNT(*) AS c
    FROM tickets t WHERE t.status = 'done' AND t.room_id IS NOT NULL
      AND ${dateExpr} >= ? AND ${dateExpr} < ? GROUP BY t.room_id`).all(start, end);
  const map = Object.fromEntries(used.map(u => [u.room_id, u]));
  return rooms.map(r => {
    const u = map[r.id] || { m: 0, c: 0 };
    const cap = openMin * days * (r.capacity || 1);
    return {
      ...r, used_minutes: u.m, tickets: u.c, capacity_minutes: cap,
      // 夾在 0~1：強制放行的重疊單會讓分子灌水，畫面上出現 130% 只會讓人以為系統壞了
      rate: cap > 0 ? Math.min(1, Math.max(0, u.m / cap)) : 0,
      open_minutes_per_day: openMin
    };
  }).sort((a, b) => b.rate - a.rate);
}

// 營業稅試算。
// 重點：預收（儲值、賣卡）在收款當下不是銷售額，實際服務時才認列 ——
// 拿整筆儲值去報，稅會多繳；反過來完全不報，被查到是漏報。
function tax(period, storeId) {
  const { start, end } = monthRange(period);
  const rev = serviceRevenue(start, end, storeId);
  const cash = cashFlow(start, end, storeId);
  const rate = num('vat_rate', 5) / 100;
  const sales = rev.revenue;                       // 含稅認列營收
  const net = Math.round(sales / (1 + rate));      // 未稅銷售額
  return {
    period, rate: num('vat_rate', 5),
    recognized_revenue: sales, net_sales: net, output_tax: sales - net,
    cash_in: cash.total, prepaid_received: cash.topup + cash.pass_sale,
    note: '儲值與售卡屬預收款，收款當期不列入銷售額；客人實際消費時才依本表認列。'
  };
}

// 回購名單：多久沒來的客人。指名技師也帶出來，推播時才知道該用誰的名義。
function repurchase({ days, storeId, therapistId } = {}) {
  const d = Number(days) || num('repurchase_days', 30);
  const cut = require('./db').shiftDate(today(), -d);
  const f = [], args = [];
  if (storeId) { f.push('m.store_id = ?'); args.push(storeId); }
  if (therapistId) { f.push('last.therapist_id = ?'); args.push(therapistId); }
  const rows = db.prepare(`
    SELECT m.id, m.member_no, m.name, m.phone, m.line_uid, m.tags, m.fav_therapist_id,
           last.last_visit, last.visits, last.total_spent, last.therapist_id AS last_therapist_id,
           th.name AS last_therapist,
           COALESCE(w.cash_balance,0) + COALESCE(w.bonus_balance,0) AS wallet_balance,
           (SELECT COUNT(*) FROM passes p WHERE p.member_id = m.id AND p.status = 'active') AS pass_count
    FROM members m
    JOIN (SELECT t.member_id,
                 MAX(COALESCE(NULLIF(t.actual_start,''), t.start_at)) AS last_visit,
                 COUNT(*) AS visits, COALESCE(SUM(t.net_amount),0) AS total_spent,
                 (SELECT t2.therapist_id FROM tickets t2 WHERE t2.member_id = t.member_id AND t2.status='done'
                   ORDER BY COALESCE(NULLIF(t2.actual_start,''), t2.start_at) DESC LIMIT 1) AS therapist_id
          FROM tickets t WHERE t.status = 'done' AND t.member_id IS NOT NULL
          GROUP BY t.member_id) last ON last.member_id = m.id
    LEFT JOIN therapists th ON th.id = last.therapist_id
    LEFT JOIN wallets w ON w.member_id = m.id
    WHERE m.active = 1 AND m.blacklist = 0 AND substr(last.last_visit,1,10) < ?
      ${f.length ? 'AND ' + f.join(' AND ') : ''}
    ORDER BY last.total_spent DESC`).all(cut, ...args);
  return rows.map(r => ({
    ...r,
    days_since: require('./db').dateDiff(r.last_visit.slice(0, 10), today()),
    avg_spent: r.visits ? Math.round(r.total_spent / r.visits) : 0
  }));
}

module.exports = {
  serviceRevenue, cashFlow, expenses, monthly, daily, openMinutesOf,
  therapistRank, serviceRank, roomUsage, tax, repurchase
};
