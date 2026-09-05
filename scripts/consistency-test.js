// 跨模組一致性測試：同一個數字在不同模組算出來必須一樣。
//
// 這套系統有好幾條「同一筆錢的不同說法」：
//   鐘單的 net_amount ↔ 付款拆解；儲值餘額 ↔ 流水加總；薪資的抽成 ↔ 每張鐘單的抽成；
//   損益的營收 ↔ 鐘單加總；預收負債 ↔ 儲值與次卡剩餘。
// 任何一條對不上，使用者都會在某一頁看到一個他無法解釋的數字。
// 改動財務、抽成、輪鐘、預收邏輯後務必重跑。
process.env.TZ = 'Asia/Taipei';
const { db, today, thisMonth, monthRange, yuan, money, num } = require('../src/db');
const prepaid = require('../src/prepaid');
const commission = require('../src/commission');
const payroll = require('../src/payroll');
const finance = require('../src/finance');
const rotation = require('../src/rotation');
const gates = require('../src/gates');
const compliance = require('../src/compliance');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; fails.push(`${name}${detail ? `：${detail}` : ''}`); }
}
function eq(name, a, b, tol = 1) {
  const d = Math.abs(Number(a) - Number(b));
  ok(name, d <= tol, `${a} vs ${b}（差 ${money(d)}）`);
}

// ---- 1. 鐘單金額自洽 ----
const tickets = db.prepare('SELECT * FROM tickets').all();
for (const t of tickets) {
  const items = db.prepare('SELECT * FROM ticket_items WHERE ticket_id = ?').all(t.id);
  const addService = items.filter(i => i.kind !== 'retail').reduce((s, i) => s + yuan(i.amount), 0);
  const retail = items.filter(i => i.kind === 'retail').reduce((s, i) => s + yuan(i.amount), 0);
  eq(`${t.ticket_no} 商品金額 = 商品明細加總`, t.retail_amount, retail);
  if (t.status !== 'cancelled' && t.status !== 'noshow') {
    const expect = Math.max(0, yuan(t.amount) + retail + yuan(t.designate_fee) - yuan(t.discount));
    eq(`${t.ticket_no} 應收 = 服務＋商品＋指名費－折扣`, t.net_amount, expect);
    ok(`${t.ticket_no} 服務金額涵蓋加鐘`, yuan(t.amount) >= addService,
      `amount ${t.amount} < 加鐘 ${addService}`);
  }
  if (t.status === 'done') {
    eq(`${t.ticket_no} 收款拆解 = 應收`,
      t.paid_cash + t.paid_wallet + t.paid_pass + t.paid_voucher, t.net_amount);
    ok(`${t.ticket_no} 收款不為負`,
      t.paid_cash >= 0 && t.paid_wallet >= 0 && t.paid_pass >= 0 && t.paid_voucher >= 0);
    // 抽成不能超過業績（％只可能是 0~100）
    ok(`${t.ticket_no} 抽成不超過業績`, t.comm_service <= yuan(t.amount) + 1,
      `抽成 ${t.comm_service} > 業績 ${t.amount}`);
  }
  if (t.status === 'cancelled' || t.status === 'noshow') {
    eq(`${t.ticket_no} 取消後抽成歸零`, t.comm_service + t.comm_retail + t.comm_designate, 0);
    eq(`${t.ticket_no} 取消後收款歸零`, t.paid_cash + t.paid_wallet + t.paid_pass + t.paid_voucher, 0);
  }
  // 指名費只有指名單才有
  if (t.assign_type !== 'designated') eq(`${t.ticket_no} 非指名不應有指名費`, t.designate_fee, 0);
}

// ---- 2. 儲值：餘額 = 流水加總 ----
for (const w of db.prepare('SELECT * FROM wallets').all()) {
  const s = db.prepare(`SELECT COALESCE(SUM(cash_delta),0) c, COALESCE(SUM(bonus_delta),0) b
                        FROM wallet_txns WHERE member_id = ?`).get(w.member_id);
  eq(`客人 #${w.member_id} 現金餘額 = 流水加總`, w.cash_balance, s.c);
  eq(`客人 #${w.member_id} 贈送餘額 = 流水加總`, w.bonus_balance, s.b);
  ok(`客人 #${w.member_id} 餘額不為負`, w.cash_balance >= -0.01 && w.bonus_balance >= -0.01);
  // 每一筆流水記下的當下餘額也要能串起來
  const last = db.prepare('SELECT * FROM wallet_txns WHERE member_id = ? ORDER BY id DESC LIMIT 1').get(w.member_id);
  if (last) {
    eq(`客人 #${w.member_id} 最後一筆流水的結存 = 現值`, last.cash_after + last.bonus_after,
      w.cash_balance + w.bonus_balance);
  }
}
// 扣款一定先扣贈送金：不可能在還有贈送金時去扣現金
for (const x of db.prepare("SELECT * FROM wallet_txns WHERE kind = 'consume'").all()) {
  if (x.cash_delta < 0) {
    ok(`扣款 #${x.id} 先扣贈送金`, x.bonus_after <= 0.01,
      `動用現金 ${-x.cash_delta} 時贈送金還剩 ${x.bonus_after}`);
  }
}

// ---- 3. 次卡：已用次數 = 流水加總 ----
for (const p of db.prepare('SELECT * FROM passes').all()) {
  const s = db.prepare(`SELECT COALESCE(SUM(times),0) t FROM pass_txns
                        WHERE pass_id = ? AND kind IN ('use','void')`).get(p.id).t;
  eq(`${p.pass_no} 已用次數 = 核銷流水`, p.used_times, -s, 0);
  ok(`${p.pass_no} 已用不超過總數`, p.used_times <= p.total_times,
    `${p.used_times}/${p.total_times}`);
  eq(`${p.pass_no} 單次價值 = 實付÷次數`, prepaid.passUnitValue(p), p.price_paid / (p.total_times || 1), 0.01);
  // 核銷金額走累計差額，全部用完時加總必須剛好等於實付（除不盡的卡也一樣）
  eq(`${p.pass_no} 用完的累計認列 = 實付`, prepaid.passUsedValue(p, p.total_times), yuan(p.price_paid), 0);
  eq(`${p.pass_no} 已用 + 未用 = 實付`,
    prepaid.passUsedValue(p, p.used_times) + prepaid.passRemainValue(p), yuan(p.price_paid), 0);
  const usedTxns = db.prepare("SELECT * FROM pass_txns WHERE pass_id = ? AND kind = 'use' ORDER BY id").all(p.id);
  if (usedTxns.length) {
    const sum = usedTxns.reduce((a, u) => a + u.amount, 0);
    eq(`${p.pass_no} 核銷流水加總 = 已用累計值`, sum, prepaid.passUsedValue(p, p.used_times), 1);
  }
}

// ---- 4. 鐘單的預收付款 = 預收流水 ----
for (const t of tickets.filter(x => x.status === 'done' && (x.paid_wallet > 0 || x.paid_pass > 0))) {
  if (t.paid_wallet > 0) {
    const w = db.prepare(`SELECT COALESCE(SUM(amount),0) a FROM wallet_txns
                          WHERE ticket_id = ? AND kind = 'consume'`).get(t.id).a;
    eq(`${t.ticket_no} 儲值扣款 = 儲值流水`, t.paid_wallet, w);
  }
  if (t.paid_pass > 0) {
    const p = db.prepare(`SELECT COALESCE(SUM(amount),0) a FROM pass_txns
                          WHERE ticket_id = ? AND kind = 'use'`).get(t.id).a;
    // 核銷價值可能大於實際抵用（卡的單次值高於本次金額時只抵到本次金額）
    ok(`${t.ticket_no} 次卡抵用不超過核銷價值`, t.paid_pass <= p + 1, `抵用 ${t.paid_pass} > 核銷 ${p}`);
  }
}

// ---- 5. 抽成重算一致 ----
// 用同一套 computeTicket 重算，結果必須與寫在單上的一樣。
// 這條是「抽成寫死在單據上」這個設計的保險絲：若哪天有人改成月底重算，這裡會亮。
for (const t of tickets.filter(x => x.status === 'done')) {
  const items = db.prepare('SELECT * FROM ticket_items WHERE ticket_id = ?').all(t.id);
  const c = commission.computeTicket(t, items);
  eq(`${t.ticket_no} 服務抽成可重現`, t.comm_service, c.comm_service, 0.02);
  eq(`${t.ticket_no} 商品抽成可重現`, t.comm_retail, c.comm_retail, 0.02);
  eq(`${t.ticket_no} 指名費可重現`, t.comm_designate, c.comm_designate, 0.02);
  eq(`${t.ticket_no} 套用％可重現`, t.comm_pct_used, c.pct_used, 0.01);
}

// ---- 6. 薪資 = 該月鐘單抽成加總 ----
const period = thisMonth();
const { start, end } = monthRange(period);
// 跟各模組一樣用營業日欄位，否則 24 小時店的凌晨單會被算到不同月份，
// 「薪資 = 鐘單加總」就會假性失敗。
const dateExpr = 't.biz_date';
for (const th of db.prepare('SELECT * FROM therapists WHERE active = 1').all()) {
  const p = payroll.preview(th.id, period);
  const raw = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(t.comm_service),0) cs,
      COALESCE(SUM(t.comm_retail),0) cr, COALESCE(SUM(t.comm_designate),0) cd,
      COALESCE(SUM(t.amount - t.discount),0) amt, COALESCE(SUM(t.minutes),0) mins
    FROM tickets t WHERE t.therapist_id = ? AND t.status = 'done'
      AND ${dateExpr} >= ? AND ${dateExpr} < ?`).get(th.id, start, end);
  const others = db.prepare(`SELECT COALESCE(SUM(i.comm_amount),0) c, COALESCE(SUM(i.amount),0) a
    FROM ticket_items i JOIN tickets t ON t.id = i.ticket_id
    WHERE i.therapist_id = ? AND t.therapist_id <> i.therapist_id AND t.status='done'
      AND ${dateExpr} >= ? AND ${dateExpr} < ?`).get(th.id, start, end);
  eq(`${th.name} 薪資鐘數 = 鐘單筆數`, p.ticket_count, raw.n, 0);
  eq(`${th.name} 薪資服務時數 = 鐘單加總`, p.minutes_total, raw.mins, 0);
  eq(`${th.name} 薪資服務業績 = 鐘單加總`, p.service_amount, raw.amt + others.a);
  eq(`${th.name} 薪資服務抽成 = 鐘單加總`, p.comm_service, raw.cs + (others.c || 0), 0.05);
  eq(`${th.name} 薪資指名費 = 鐘單加總`, p.comm_designate, raw.cd, 0.02);
  // 級距獎金必須落在設定的級距內
  if (p.tier) {
    ok(`${th.name} 級距區間正確`,
      p.service_amount >= p.tier.min_amount && (p.tier.max_amount === 0 || p.service_amount <= p.tier.max_amount),
      `業績 ${p.service_amount} 不在 ${p.tier.min_amount}~${p.tier.max_amount}`);
    eq(`${th.name} 級距獎金 = 業績×％`, p.tier_bonus, p.service_amount * p.tier.bonus_pct / 100, 0.05);
  }
  eq(`${th.name} 薪資合計 = 各項加總`, p.total_before_adjust,
    p.base_salary + p.comm_service + p.comm_retail_total + p.comm_designate + p.tier_bonus, 0.05);
}

// ---- 7. 損益 = 鐘單加總 ----
const rev = finance.serviceRevenue(start, end, null);
const raw = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(t.net_amount),0) net,
    COALESCE(SUM(t.comm_service + t.comm_retail + t.comm_designate),0) c,
    COALESCE(SUM(t.paid_cash),0) pc, COALESCE(SUM(t.paid_wallet),0) pw, COALESCE(SUM(t.paid_pass),0) pp,
    COALESCE(SUM(t.paid_voucher),0) pv
  FROM tickets t WHERE t.status='done' AND ${dateExpr} >= ? AND ${dateExpr} < ?`).get(start, end);
eq('本月營收 = 鐘單應收加總', rev.revenue, raw.net);
eq('本月抽成 = 鐘單抽成加總', rev.commission, raw.c, 0.05);
eq('本月營收 = 四種付款加總', rev.revenue, raw.pc + raw.pw + raw.pp + raw.pv);
const m = finance.monthly(period, null);
// 毛利要扣商品銷貨成本。原本這條寫成「毛利 = 營收 − 抽成」，等於把漏扣成本
// 這個 bug 寫成了預期行為 —— 匯出的損益表因此各列加不起來。
eq('毛利 = 營收 − 抽成 − 商品成本', m.gross_profit, rev.revenue - rev.commission - m.cogs, 0.05);
eq('淨利 = 毛利 − 費用', m.net_profit, m.gross_profit - m.expenses.total, 0.05);
eq('商品銷貨成本 = 庫存流水的出庫成本',
  m.cogs, require('../src/inventory').movement(start, end, null).cogs, 1);
eq('商品毛利 = 商品營收 − 商品成本', m.retail_margin, rev.retail - m.cogs, 1);
// 損益表的各列必須加得起來 —— 這是拿給會計看時第一眼會檢查的事
eq('損益各列加總 = 毛利',
  rev.revenue - m.cogs - m.commission, m.gross_profit, 0.05);
// 各技師排行加總 = 全店營收（服務業績面）
const rank = finance.therapistRank(start, end, null);
eq('技師排行鐘數加總 = 全店鐘數', rank.reduce((s, r) => s + r.tickets, 0), rev.tickets, 0);
eq('技師排行抽成加總 = 全店抽成', rank.reduce((s, r) => s + r.commission, 0), rev.commission, 0.05);
// 項目排行加總 = 服務原價加總
const srank = finance.serviceRank(start, end, null);
eq('項目排行金額加總 = 服務金額加總', srank.reduce((s, r) => s + r.amount, 0), rev.service_gross);

// ---- 8. 營業稅：預收不計入銷售額 ----
const tax = finance.tax(period, null);
eq('稅務認列營收 = 損益營收', tax.recognized_revenue, rev.revenue);
eq('未稅銷售額 + 稅 = 含稅營收', tax.net_sales + tax.output_tax, tax.recognized_revenue);
const cash = finance.cashFlow(start, end, null);
ok('預收未被計入銷售額', tax.prepaid_received === cash.topup + cash.pass_sale,
  `${tax.prepaid_received} vs ${cash.topup + cash.pass_sale}`);
ok('現金流入 ≠ 認列營收（預收存在時）',
  cash.topup + cash.pass_sale === 0 || cash.total !== tax.recognized_revenue);

// ---- 9. 預收負債 = 儲值 + 次卡 ----
const liab = prepaid.liability(null);
const wsum = db.prepare('SELECT COALESCE(SUM(cash_balance),0) c, COALESCE(SUM(bonus_balance),0) b FROM wallets').get();
eq('負債表儲值現金 = 儲值餘額加總', liab.wallet_cash, wsum.c);
eq('負債表贈送 = 贈送餘額加總', liab.wallet_bonus, wsum.b);
let pv = 0, pt = 0;
for (const p of db.prepare("SELECT * FROM passes WHERE status='active'").all()) {
  if (prepaid.passStatus(p) !== 'active') continue;
  pv += prepaid.passRemainValue(p);
  pt += p.total_times - p.used_times;
}
eq('負債表次卡價值 = 各卡剩餘價值加總', liab.pass_value, pv, 0);
eq('負債表次卡次數 = 各卡剩餘次數加總', liab.pass_remain_times, pt, 0);
eq('負債合計 = 儲值現金 + 次卡價值', liab.total_cash_liability, liab.wallet_cash + liab.pass_value, 2);

// ---- 10. 輪鐘：檯面與軌跡一致 ----
for (const d of db.prepare('SELECT DISTINCT work_date FROM shifts ORDER BY work_date DESC LIMIT 10').all()) {
  const shifts = db.prepare('SELECT * FROM shifts WHERE work_date = ?').all(d.work_date);
  const seqs = {};
  for (const s of shifts) {
    const k = `${s.store_id}`;
    seqs[k] = seqs[k] || [];
    seqs[k].push(s.queue_seq);
    ok(`${d.work_date} 簽到序 > 0`, s.queue_seq > 0);
    ok(`${d.work_date} 輪次不為負`, s.rounds >= 0);
    // 當日輪次不可能超過當日鐘單數。
    //
    // 用 **biz_date** 比對，不是從時間字串截日曆日 —— shifts.work_date 本來就是營業日，
    // 24 小時店凌晨兩點的單屬於前一個營業日。這條斷言原本用日曆日，
    // 於是每次示範資料剛好產生凌晨的單就會紅一次，看起來像偶發，其實是口徑不一致。
    const n = db.prepare(`SELECT COUNT(*) n FROM tickets
      WHERE therapist_id = ? AND biz_date = ?
        AND status IN ('serving','done','booked')`).get(s.therapist_id, d.work_date).n;
    ok(`${d.work_date} 技師 #${s.therapist_id} 輪次不超過鐘數`, s.rounds <= n,
      `輪次 ${s.rounds} > 鐘數 ${n}`);
  }
  for (const [store, list] of Object.entries(seqs)) {
    ok(`${d.work_date} 門市 ${store} 簽到序不重複`, new Set(list).size === list.length,
      list.join(','));
  }
}
// 輪鐘檯的排序必須是 (rounds, queue_seq)
for (const store of db.prepare('SELECT id FROM stores').all()) {
  const b = rotation.board(today(), store.id);
  for (let i = 1; i < b.list.length; i++) {
    const a = b.list[i - 1], c = b.list[i];
    ok('輪鐘檯排序 = (已輪次數, 簽到序)',
      a.rounds < c.rounds || (a.rounds === c.rounds && a.queue_seq <= c.queue_seq),
      `${a.name}(${a.rounds},${a.queue_seq}) 排在 ${c.name}(${c.rounds},${c.queue_seq}) 之前`);
  }
  if (b.next) {
    ok('下一位是等鐘中排頭', b.next.status === 'waiting');
    for (const x of b.list.filter(y => y.status === 'waiting')) {
      ok('下一位的輪次最少',
        b.next.rounds < x.rounds || (b.next.rounds === x.rounds && b.next.queue_seq <= x.queue_seq));
    }
  }
}

// ---- 11. 閘門：禁忌真的擋得住 ----
const svcWithBan = db.prepare("SELECT * FROM services WHERE contraindications <> '' LIMIT 5").all();
for (const svc of svcWithBan) {
  const cond = gates.splitList(svc.contraindications)[0];
  const victim = db.prepare("SELECT * FROM members WHERE conditions LIKE ? LIMIT 1").get(`%${cond}%`);
  if (!victim) continue;
  const issues = gates.checkHealth({ memberId: victim.id, serviceId: svc.id });
  ok(`「${svc.name}」擋得住「${cond}」的客人`,
    issues.some(i => i.code === 'contraindication'),
    `${victim.name}（${victim.conditions}）沒有被擋`);
}
// 反過來：沒有禁忌狀況的客人不該被誤擋
const clean = db.prepare("SELECT * FROM members WHERE conditions = '' AND blacklist = 0 LIMIT 3").all();
for (const c of clean) {
  for (const svc of svcWithBan) {
    const issues = gates.checkHealth({ memberId: c.id, serviceId: svc.id });
    ok(`無狀況的 ${c.name} 不該被「${svc.name}」誤擋`,
      !issues.some(i => i.level === 'conflict'));
  }
}

// ---- 12. 合規掃描 ----
const scan = compliance.scanAll();
ok('合規掃描可執行', Array.isArray(scan.findings));
ok('禁用詞掃描抓得到明顯字眼', compliance.scanText('本館可治療肩頸痠痛，療效顯著').length >= 2);
ok('正常文案不誤判', compliance.scanText('全身舒緩放鬆，紓解一天的疲勞').length === 0);
const exp = compliance.expiry();
eq('到期總表筆數 = 技師數×2',
  exp.rows.length, db.prepare('SELECT COUNT(*) n FROM therapists WHERE active=1').get().n * 2, 0);
eq('到期狀態分類數加總 = 總筆數',
  exp.summary.expired + exp.summary.missing + exp.summary.soon + exp.summary.ok, exp.rows.length, 0);

// ---- 13. 退卡試算 ----
for (const p of db.prepare("SELECT * FROM passes WHERE status='active' LIMIT 20").all()) {
  const q = prepaid.refundQuote(p.id, 'unit');
  eq(`${p.pass_no} 退卡(單價法) = 未使用的累計價值`, q.by_unit, prepaid.passRemainValue(p), 0);
  ok(`${p.pass_no} 退卡金額不超過實付`, q.by_unit <= yuan(p.price_paid),
    `退 ${q.by_unit} > 實付 ${p.price_paid}`);
  const q2 = prepaid.refundQuote(p.id, 'list');
  ok(`${p.pass_no} 原價法退款不為負`, q2.by_list >= 0);
  ok(`${p.pass_no} 原價法退得不多於單價法`, q2.by_list <= q.by_unit + 0.02,
    `原價法 ${q2.by_list} > 單價法 ${q.by_unit}`);
}

// ---- 14. 抽成％來源優先序 ----
const rates = require('../src/db').levelRates();
for (const th of db.prepare('SELECT * FROM therapists WHERE active=1').all()) {
  const lv = rates[th.level] || {};
  const r = commission.ratesFor(th, null);
  eq(`${th.name} 輪鐘％取用正確`, r.normal, th.pct_normal > 0 ? th.pct_normal : (lv.normal || 0), 0.01);
  eq(`${th.name} 指名％取用正確`, r.designated, th.pct_designated > 0 ? th.pct_designated : (lv.designated || 0), 0.01);
  ok(`${th.name} 指名％不低於輪鐘％`, r.designated >= r.normal,
    `指名 ${r.designated}% < 輪鐘 ${r.normal}%`);
  // 服務項目覆寫優先於技師
  const svc = db.prepare('SELECT * FROM services WHERE pct_normal > 0 LIMIT 1').get();
  if (svc) {
    const r2 = commission.ratesFor(th, svc);
    eq(`${th.name} 服務項目覆寫優先`, r2.normal, svc.pct_normal, 0.01);
  }
}

// ---- 15. 排班／床位不重疊 ----
const active = tickets.filter(t => ['booked', 'serving'].includes(t.status));
for (let i = 0; i < active.length; i++) {
  for (let j = i + 1; j < active.length; j++) {
    const a = active[i], b = active[j];
    if (!(a.start_at < b.end_at && b.start_at < a.end_at)) continue;
    if (a.therapist_id && a.therapist_id === b.therapist_id) {
      // 這是資料層的檢查：真的重疊代表有人強制放行過，該單必須有理由
      ok(`${a.ticket_no}／${b.ticket_no} 技師重疊須有放行理由`,
        !!(a.gate_note || b.gate_note), '兩張單都沒有 gate_note');
    }
  }
}

// ---- 16. 營業日 ----
// 24 小時營業的店，凌晨的鐘要算給前一個營業日。這條錯了，日結與技師輪次都會錯一天。
{
  const { bizDate, getSetting } = require('../src/db');
  const cut = getSetting('business_day_start', '04:00');
  for (const t of tickets) {
    const src = t.actual_start || t.start_at;
    ok(`${t.ticket_no} 營業日與換日時間一致`, t.biz_date === bizDate(src),
      `biz_date=${t.biz_date}，由 ${src} 應得 ${bizDate(src)}`);
  }
  const late = tickets.filter(t => (t.actual_start || t.start_at).slice(11, 16) < cut);
  ok('有跨午夜的單可供驗證（24 小時店）', late.length > 0, `凌晨單 ${late.length} 張`);
  for (const t of late) {
    ok(`${t.ticket_no} 凌晨單歸前一營業日`,
      t.biz_date < (t.actual_start || t.start_at).slice(0, 10));
  }
  // 日結加總必須用營業日；用日曆日會算出不同的數字，這裡確認兩者確實不同（證明有差別）
  const anyDate = late.length ? late[0].biz_date : null;
  if (anyDate) {
    const byBiz = db.prepare("SELECT COUNT(*) n FROM tickets WHERE biz_date = ?").get(anyDate).n;
    const byCal = db.prepare("SELECT COUNT(*) n FROM tickets WHERE substr(start_at,1,10) = ?").get(anyDate).n;
    ok('營業日與日曆日的統計確實不同（代表換日邏輯有作用）', byBiz !== byCal,
      `兩者都是 ${byBiz} 張`);
  }
}

// ---- 17. 三層定價 ----
{
  const pricing = require('../src/pricing');
  for (const s2 of db.prepare('SELECT * FROM services WHERE active = 1').all()) {
    ok(`「${s2.name}」牌價不低於現場價`, yuan(s2.list_price) >= yuan(s2.price),
      `牌價 ${s2.list_price} < 現場價 ${s2.price}`);
    if (s2.member_price) {
      ok(`「${s2.name}」會員價不高於現場價`, yuan(s2.member_price) <= yuan(s2.price));
    }
    const walkin = pricing.priceOf(s2, {});
    eq(`「${s2.name}」散客帶現場價`, walkin.price, yuan(s2.price), 0);
    const mem = pricing.priceOf(s2, { memberId: 1 });
    ok(`「${s2.name}」會員價不高於散客價`, mem.price <= walkin.price);
  }
  for (const t of tickets.filter(x => x.service_id && x.status === 'done')) {
    const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(t.service_id);
    if (!svc) continue;
    const p = pricing.priceOf(svc, { memberId: t.member_id, tier: t.price_tier });
    // 主項金額 = 該價格層的價格（加鐘另計在 items）
    const addItems = db.prepare("SELECT COALESCE(SUM(amount),0) a FROM ticket_items WHERE ticket_id = ? AND kind <> 'retail'").get(t.id).a;
    eq(`${t.ticket_no} 主項金額 = 套用價格層的價`, yuan(t.amount) - yuan(addItems), p.price);
    ok(`${t.ticket_no} 牌價總額不低於實收`, yuan(t.list_amount) >= yuan(t.amount) - 0.01,
      `牌價 ${t.list_amount} < 金額 ${t.amount}`);
  }
  // 套票價要低於各項分開買
  for (const pk of db.prepare('SELECT * FROM services WHERE is_package = 1').all()) {
    const b = pricing.packageBreakdown(pk, {});
    ok(`套票「${pk.name}」有展開內容`, !!b && b.items.length > 0);
    if (b) {
      ok(`套票「${pk.name}」比分開買便宜`, b.package_price <= b.separate_total,
        `套票 ${b.package_price} > 分開 ${b.separate_total}`);
      eq(`套票「${pk.name}」時長 = 各項相加`, pk.minutes, b.minutes, 0);
    }
  }
}

// ---- 18. 團購券 ----
{
  const V = require('../src/vouchers');
  const vs = db.prepare('SELECT * FROM vouchers').all();
  const seen = new Set();
  for (const v of vs) {
    const key = `${v.platform}|${v.code}`;
    ok(`券號 ${v.code} 不重複`, !seen.has(key)); seen.add(key);
    ok(`券 ${v.code} 淨收不超過面額`, yuan(v.net_receivable) <= yuan(v.face_value),
      `淨收 ${v.net_receivable} > 面額 ${v.face_value}`);
    if (v.commission_pct > 0) {
      eq(`券 ${v.code} 淨收 = 面額×(1-抽成)`, v.net_receivable,
        yuan(v.face_value * (100 - v.commission_pct) / 100), 1);
    }
    if (v.status === 'used' || v.status === 'settled') {
      ok(`券 ${v.code} 已核銷必有核銷時間`, !!v.used_at);
    }
    if (v.status === 'unused') ok(`券 ${v.code} 未核銷不該綁鐘單`, !v.ticket_id);
    // 重複核銷必須被擋
    if (v.status === 'used') {
      const issues = V.checkUse(v, {});
      ok(`券 ${v.code} 重複核銷會被擋`, issues.some(i => i.code === 'used'));
    }
  }
  // 鐘單上的券折抵要對得上券
  for (const t of tickets.filter(x => x.paid_voucher > 0)) {
    const v = db.prepare("SELECT * FROM vouchers WHERE ticket_id = ?").get(t.id);
    ok(`${t.ticket_no} 有券折抵就要找得到券`, !!v, `折抵 ${t.paid_voucher} 但查無券`);
    if (v) ok(`${t.ticket_no} 折抵不超過券面額`, yuan(t.paid_voucher) <= yuan(v.face_value));
  }
  const rec = V.reconcile({});
  const usedNet = db.prepare("SELECT COALESCE(SUM(net_receivable),0) v FROM vouchers WHERE status IN ('used','settled')").get().v;
  eq('對帳表淨收合計 = 已核銷券淨收加總', rec.total.net, usedNet, 1);
  eq('對帳表 = 已入帳 + 待入帳', rec.total.net, rec.total.settled + rec.total.pending, 1);
}

// ---- 19. 加購品主檔 ----
{
  for (const a of db.prepare('SELECT * FROM addons WHERE active = 1').all()) {
    ok(`加購「${a.name}」牌價不低於現場價`, yuan(a.list_price) >= yuan(a.price));
    if (a.member_price) ok(`加購「${a.name}」會員價不高於現場價`, yuan(a.member_price) <= yuan(a.price));
  }
  // 鐘單上的加購都要連得回主檔（不再是自由輸入的品名）
  const orphan = db.prepare(`SELECT COUNT(*) n FROM ticket_items
    WHERE kind = 'addon' AND (ref_id IS NULL OR ref_id NOT IN (SELECT id FROM addons))`).get().n;
  ok('加購項目都連得回加購品主檔', orphan === 0, `${orphan} 筆孤兒`);
}

// ---- 19.5 床位使用率 ----
// 24 小時店與跨午夜店曾經算出 0% 與負數 —— 兩種營業型態在這一行都很常見。
{
  const F = require('../src/finance');
  eq('24 小時店（00:00–00:00）一天算 1440 分', F.openMinutesOf('00:00', '00:00'), 1440, 0);
  eq('跨午夜店（11:00–03:00）一天算 960 分', F.openMinutesOf('11:00', '03:00'), 960, 0);
  eq('一般店（10:00–23:00）一天算 780 分', F.openMinutesOf('10:00', '23:00'), 780, 0);
  eq('半夜開到中午（22:00–12:00）算 840 分', F.openMinutesOf('22:00', '12:00'), 840, 0);
  for (const st of db.prepare('SELECT id, name FROM stores WHERE active = 1').all()) {
    for (const r of F.roomUsage(start, end, st.id)) {
      ok(`${st.name} ${r.name} 可用時數為正`, r.capacity_minutes > 0, `${r.capacity_minutes} 分`);
      ok(`${st.name} ${r.name} 使用率在 0~100% 之間`, r.rate >= 0 && r.rate <= 1,
        `${(r.rate * 100).toFixed(1)}%`);
    }
  }
}

// ---- 20. 庫存：快取 = 流水加總 ----
{
  const inventory = require('../src/inventory');
  for (const p of db.prepare('SELECT * FROM retail_products').all()) {
    const real = inventory.stockOf(p.id);
    eq(`商品「${p.name}」庫存 = 流水加總`, p.stock, real, 0.001);
    ok(`商品「${p.name}」庫存不為負`, real >= 0, `庫存 ${real}`);
    // 每一筆流水記下的當下庫存也要能串起來（跟儲值流水同一套規矩）
    const last = db.prepare('SELECT * FROM stock_txns WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(p.id);
    if (last) eq(`商品「${p.name}」最後一筆流水的結存 = 現值`, last.stock_after, real, 0.001);
  }
  // 逐筆檢查 stock_after 是不是真的等於「到這一筆為止的加總」
  const byProduct = {};
  for (const x of db.prepare('SELECT * FROM stock_txns ORDER BY id').all()) {
    byProduct[x.product_id] = (byProduct[x.product_id] || 0) + x.qty;
    eq(`庫存流水 #${x.id} 結存正確`, x.stock_after, byProduct[x.product_id], 0.001);
    ok(`庫存流水 #${x.id} 類型合法`, !!inventory.KINDS[x.kind], x.kind);
    // 出庫一定是負的，進貨一定是正的 —— 反了會讓「賣愈多庫存愈多」
    if (x.kind === 'sale') ok(`庫存流水 #${x.id} 銷售是出庫`, x.qty <= 0, `qty ${x.qty}`);
    if (x.kind === 'purchase') ok(`庫存流水 #${x.id} 進貨是入庫`, x.qty >= 0, `qty ${x.qty}`);
  }
  // 賣掉的商品都要有對應的出庫流水。
  //
  // 只檢查「庫存流水啟用之後」的鐘單：在那之前賣掉的商品，當年是直接改 stock 欄位的，
  // 補不出逐筆流水（那些數量已經被 init 的期初數吸收掉了）。
  // 拿舊資料來紅燈，等於在罵使用者我們自己把功能加晚了。
  const initAt = db.prepare("SELECT MIN(created_at) v FROM stock_txns WHERE kind = 'init'").get().v || '';
  for (const i of db.prepare(`SELECT i.*, t.status, t.ticket_no, t.created_at FROM ticket_items i
      JOIN tickets t ON t.id = i.ticket_id WHERE i.kind = 'retail' AND i.ref_id IS NOT NULL`).all()) {
    if (initAt && i.created_at < initAt) continue;
    const sale = db.prepare(`SELECT COALESCE(SUM(qty),0) v FROM stock_txns
      WHERE ticket_id = ? AND product_id = ? AND kind IN ('sale','sale_void')`).get(i.ticket_id, i.ref_id).v;
    // 已取消的單淨額為 0（出庫後又回沖），其他情況是 -qty
    const expect = ['cancelled', 'noshow'].includes(i.status) ? 0 : -i.qty;
    eq(`${i.ticket_no} 的「${i.name}」出庫流水`, sale, expect, 0.001);
  }
  // 調撥必定成雙，總量不變
  for (const t of db.prepare(`SELECT doc_no, COALESCE(SUM(qty),0) v, COUNT(*) n FROM stock_txns
      WHERE kind IN ('transfer_out','transfer_in') AND doc_no <> '' GROUP BY doc_no`).all()) {
    eq(`調撥 ${t.doc_no} 一出一進總量不變`, t.v, 0, 0.001);
    ok(`調撥 ${t.doc_no} 成雙`, t.n % 2 === 0, `${t.n} 筆`);
  }
}

// ---- 21. 點數：快取 = 流水加總 ----
{
  const loyalty = require('../src/loyalty');
  for (const m of db.prepare('SELECT id, name, points FROM members').all()) {
    eq(`客人「${m.name}」點數 = 流水加總`, m.points, loyalty.balanceOf(m.id), 0);
  }
  const seen = {};
  for (const x of db.prepare('SELECT * FROM point_txns ORDER BY id').all()) {
    seen[x.member_id] = (seen[x.member_id] || 0) + x.points;
    eq(`點數流水 #${x.id} 結存正確`, x.balance_after, seen[x.member_id], 0);
    ok(`點數流水 #${x.id} 是整數`, Number.isInteger(x.points), String(x.points));
  }
  // 兌換一定要換出對應的贈送金（1 點 = point_redeem_value 元）
  const rate = num('point_redeem_value', 1);
  for (const x of db.prepare("SELECT * FROM point_txns WHERE kind = 'redeem'").all()) {
    eq(`兌換 #${x.id} 金額 = 點數 × 單點價值`, x.amount, Math.round(-x.points * rate), 1);
    ok(`兌換 #${x.id} 點數是扣除`, x.points < 0, String(x.points));
  }
  // 一張鐘單只能累一次點
  const dup = db.prepare(`SELECT ticket_id, COUNT(*) n FROM point_txns
    WHERE kind = 'earn' AND ticket_id IS NOT NULL GROUP BY ticket_id HAVING n > 1`).all();
  ok('沒有鐘單重複累點', dup.length === 0, `${dup.length} 張重複`);
  // 取消的單不該留著點數
  for (const t of tickets.filter(x => ['cancelled', 'noshow'].includes(x.status))) {
    const net = db.prepare("SELECT COALESCE(SUM(points),0) v FROM point_txns WHERE ticket_id = ?").get(t.id).v;
    eq(`${t.ticket_no} 取消後點數已收回`, net, 0, 0);
  }
}

// ---- 22. 日結：短溢 = 實點 − 應有 ----
{
  for (const c of db.prepare("SELECT * FROM closings WHERE status = 'confirmed'").all()) {
    eq(`${c.closing_no} 短溢 = 實點 − 應有`, c.diff, c.counted_cash - c.expected_cash, 1);
    eq(`${c.closing_no} 應有 = 零用金＋收現－支出`,
      c.expected_cash, c.open_float + c.ticket_cash + c.topup_cash + c.pass_cash - c.cash_expense, 1.01);
    ok(`${c.closing_no} 實點不為負`, c.counted_cash >= 0);
    if (c.denom) {
      let sum = 0;
      try { for (const [d, n] of Object.entries(JSON.parse(c.denom))) sum += Number(d) * Number(n); } catch { sum = c.counted_cash; }
      eq(`${c.closing_no} 點鈔明細加總 = 實點金額`, sum, c.counted_cash, 0);
    }
  }
  // 同一天同一班別不能有兩張有效的日結單
  const dupC = db.prepare(`SELECT biz_date, shift_label, COUNT(*) n FROM closings
    WHERE status = 'confirmed' GROUP BY biz_date, shift_label, store_id HAVING n > 1`).all();
  ok('同一班別沒有重複日結', dupC.length === 0, `${dupC.length} 組重複`);
}

// ---- 23. 發票：未稅＋稅額 = 含稅總額 ----
{
  const invoicing = require('../src/invoicing');
  const seen = new Set();
  for (const v of db.prepare('SELECT * FROM invoices').all()) {
    const key = `${v.track}-${v.number}`;
    ok(`發票 ${key} 號碼不重複`, !seen.has(key)); seen.add(key);
    eq(`發票 ${key} 未稅＋稅額 = 含稅總額`, v.net_amount + v.tax_amount, v.amount, 0);
    ok(`發票 ${key} 號碼是 8 碼`, /^\d{8}$/.test(v.number), v.number);
    ok(`發票 ${key} 折讓不超過總額`, v.allowance_amount <= v.amount + 0.01,
      `折讓 ${v.allowance_amount} > 總額 ${v.amount}`);
    if (v.invoice_type === 'B2B') ok(`發票 ${key} 三聯式有統編`, /^\d{8}$/.test(v.buyer_tax_id));
    if (v.status === 'void') ok(`發票 ${key} 作廢有原因`, !!v.void_reason);
    if (v.ticket_id && v.status !== 'void') {
      const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(v.ticket_id);
      if (t) eq(`發票 ${key} 金額 = 鐘單應收`, v.amount, yuan(t.net_amount), 1);
    }
  }
  // 一張鐘單最多一張有效發票
  const dupI = db.prepare(`SELECT ticket_id, COUNT(*) n FROM invoices
    WHERE ticket_id IS NOT NULL AND status <> 'void' GROUP BY ticket_id HAVING n > 1`).all();
  ok('一張鐘單只有一張有效發票', dupI.length === 0, `${dupI.length} 張重複`);
}

// ---- 24. 附件：檔案真的在，而且內容沒變 ----
{
  const storage = require('../src/storage');
  const r = storage.verifyAll({ limit: 2000 });
  ok(`附件完整性（檢查 ${r.checked} 個）`, r.ok,
    r.bad.slice(0, 5).map(b => `#${b.id} ${b.filename}：${b.problem}`).join('；'));
  // 同意書一定要有簽名檔 —— 沒有簽名的同意書比沒有同意書更危險（它會讓完整度變成綠燈）
  for (const c of db.prepare('SELECT * FROM consents').all()) {
    ok(`同意書 #${c.id} 有簽名檔`, !!c.signature, '簽名欄是空的');
    ok(`同意書 #${c.id} 留有條文快照`, !!c.consent_text);
    const att = db.prepare("SELECT COUNT(*) n FROM attachments WHERE owner_type = 'consent' AND owner_id = ?").get(c.id).n;
    ok(`同意書 #${c.id} 簽名檔有登錄`, att > 0);
  }
}

// ---- 25. 班表 ----
{
  const roster = require('../src/roster');
  const codes = roster.shiftTypes().map(t => t.code);
  for (const r of db.prepare('SELECT * FROM rosters').all()) {
    ok(`班表 ${r.work_date} #${r.therapist_id} 班別合法`, codes.includes(r.shift_code), r.shift_code);
    // 休假類不該帶時間，否則排鐘看板會畫出一條不存在的班
    if (roster.typeOf(r.shift_code).off) {
      ok(`班表 ${r.work_date} #${r.therapist_id} 休假不帶時間`, !r.start_time && !r.end_time);
    }
  }
  const dupR = db.prepare(`SELECT work_date, therapist_id, COUNT(*) n FROM rosters
    GROUP BY work_date, therapist_id HAVING n > 1`).all();
  ok('同一天同一位技師只有一筆班表', dupR.length === 0, `${dupR.length} 組重複`);
}

// ---- 結果 ----
console.log(`\n一致性測試：${pass} 項通過，${fail} 項失敗`);
if (fail) {
  console.log('\n失敗項目（最多列 40 筆）：');
  fails.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✓ 全部通過');
