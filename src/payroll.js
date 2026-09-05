// 薪資結算。
//
// 薪水 = 底薪
//      + 服務抽成（結帳當下寫在 tickets.comm_service，這裡只是加總）
//      + 商品抽成（tickets.comm_retail）
//      + 指名費（tickets.comm_designate，一次一筆）
//      + 預收銷售抽成（儲值與次卡，wallet_txns / passes）
//      + 業績級距獎金（月服務業績落在哪一級，對總服務業績再加給％）
//      + 加項 - 扣項
//
// 這裡刻意不重新計算每一鐘的％：那些數字在結帳當下就定案了。
// 這個模組只做加總與級距，所以「改了抽成設定，上個月的薪資不會變」。
const { db, monthRange, money, yuan, today, nowStamp, audit } = require('./db');
const { tierFor } = require('./commission');

// 一位技師在某個月的業績明細
function stats(therapistId, period) {
  const { start, end } = monthRange(period);
  const t = db.prepare('SELECT * FROM therapists WHERE id = ?').get(therapistId);
  if (!t) throw new Error('找不到這位技師');

  // 服務業績以「實際完成」的鐘單為準，取 actual_start（沒有就退回 start_at）落在當月的。
  // 用結帳時間會讓跨月的夜班單算到下個月，用預約時間又會把取消的單算進來。
  const dateExpr = 't.biz_date';
  const tk = db.prepare(`
    SELECT COUNT(*) AS ticket_count,
           SUM(CASE WHEN t.assign_type = 'designated' THEN 1 ELSE 0 END) AS designate_count,
           COALESCE(SUM(t.minutes),0) AS minutes_total,
           COALESCE(SUM(t.amount - t.discount),0) AS service_amount,
           COALESCE(SUM(CASE WHEN t.assign_type = 'designated' THEN t.amount - t.discount ELSE 0 END),0) AS designated_amount,
           COALESCE(SUM(t.retail_amount),0) AS retail_ticket_amount,
           COALESCE(SUM(t.comm_service),0) AS comm_service,
           COALESCE(SUM(t.comm_retail),0) AS comm_retail,
           COALESCE(SUM(t.comm_designate),0) AS comm_designate
    FROM tickets t
    WHERE t.therapist_id = ? AND t.status = 'done'
      AND ${dateExpr} >= ? AND ${dateExpr} < ?`).get(therapistId, start, end);

  // 掛在別人單上、但指定由這位技師做的加鐘／商品
  const items = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN i.kind <> 'retail' THEN i.amount ELSE 0 END),0) AS other_service_amount,
           COALESCE(SUM(CASE WHEN i.kind = 'retail' THEN i.amount ELSE 0 END),0) AS other_retail_amount,
           COALESCE(SUM(CASE WHEN i.kind <> 'retail' THEN i.comm_amount ELSE 0 END),0) AS other_comm_service,
           COALESCE(SUM(CASE WHEN i.kind = 'retail' THEN i.comm_amount ELSE 0 END),0) AS other_comm_retail
    FROM ticket_items i JOIN tickets t ON t.id = i.ticket_id
    WHERE i.therapist_id = ? AND t.therapist_id <> i.therapist_id AND t.status = 'done'
      AND ${dateExpr} >= ? AND ${dateExpr} < ?`).get(therapistId, start, end);

  // 預收銷售：儲值與次卡。抽成在成交當下算好（wallet_txns.comm_amount）。
  const wal = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(comm_amount),0) AS comm, COUNT(*) AS cnt
    FROM wallet_txns WHERE therapist_id = ? AND kind = 'topup'
      AND substr(created_at,1,10) >= ? AND substr(created_at,1,10) < ?`).get(therapistId, start, end);
  const pss = db.prepare(`
    SELECT COALESCE(SUM(price_paid),0) AS amount, COUNT(*) AS cnt
    FROM passes WHERE sold_by = ? AND buy_date >= ? AND buy_date < ?`).get(therapistId, start, end);
  const prepaidPct = require('./db').num('prepaid_commission_pct', 5);
  const passComm = yuan(yuan(pss.amount) * prepaidPct / 100);

  const serviceAmount = yuan(tk.service_amount) + yuan(items.other_service_amount);
  const retailAmount = yuan(tk.retail_ticket_amount) + yuan(items.other_retail_amount);
  const prepaidAmount = yuan(wal.amount) + yuan(pss.amount);

  // 級距獎金看「服務業績」，不含商品與預收 —— 商品與預收有自己的抽成，
  // 一起算會讓推銷卡的人自動升級距，變相鼓勵只賣卡不做鐘。
  const tier = tierFor(t.level, serviceAmount);
  const tierBonus = tier ? yuan(serviceAmount * (tier.bonus_pct || 0) / 100) : 0;

  return {
    therapist: t, period, start, end,
    ticket_count: tk.ticket_count || 0,
    designate_count: tk.designate_count || 0,
    minutes_total: tk.minutes_total || 0,
    service_amount: serviceAmount,
    designated_amount: yuan(tk.designated_amount),
    retail_amount: retailAmount,
    prepaid_amount: prepaidAmount,
    prepaid_topup: yuan(wal.amount), prepaid_topup_count: wal.cnt || 0,
    prepaid_pass: yuan(pss.amount), prepaid_pass_count: pss.cnt || 0,
    comm_service: yuan(tk.comm_service) + yuan(items.other_comm_service),
    comm_retail: yuan(tk.comm_retail) + yuan(items.other_comm_retail),
    comm_designate: yuan(tk.comm_designate),
    comm_prepaid: yuan(wal.comm) + passComm,
    tier, tier_bonus: tierBonus,
    base_salary: yuan(t.base_salary)
  };
}

// 試算（不寫入）。畫面上按「試算」看到的就是這個。
function preview(therapistId, period) {
  const s = stats(therapistId, period);
  // 預收抽成併入商品抽成欄位呈現，薪資單上分列說明 ——
  // 資料表不再多開欄位，是因為這兩者在薪資單上的角色一樣：「非鐘點的銷售獎金」。
  const commRetail = s.comm_retail + s.comm_prepaid;
  const total = s.base_salary + s.comm_service + commRetail + s.comm_designate + s.tier_bonus;
  return { ...s, comm_retail_total: commRetail, total_before_adjust: total };
}

// 產生／更新當月薪資單。已確認或已發放的不覆蓋 —— 確認過的數字就是承諾。
const generate = db.transaction(({ period, therapistIds, actor }) => {
  const ids = therapistIds && therapistIds.length ? therapistIds
    : db.prepare("SELECT id FROM therapists WHERE active = 1").all().map(r => r.id);
  const out = { created: 0, updated: 0, skipped: [] };
  for (const id of ids) {
    const cur = db.prepare('SELECT * FROM payrolls WHERE period = ? AND therapist_id = ?').get(period, id);
    if (cur && cur.status !== 'draft') { out.skipped.push({ id, reason: `已${cur.status === 'paid' ? '發放' : '確認'}` }); continue; }
    const p = preview(id, period);
    const row = {
      period, therapist_id: id, store_id: p.therapist.store_id || null,
      base_salary: p.base_salary,
      service_amount: p.service_amount, designated_amount: p.designated_amount,
      retail_amount: money(p.retail_amount + p.prepaid_amount),
      ticket_count: p.ticket_count, designate_count: p.designate_count, minutes_total: p.minutes_total,
      comm_service: p.comm_service, comm_retail: p.comm_retail_total, comm_designate: p.comm_designate,
      tier_bonus: p.tier_bonus,
      adjust: cur ? cur.adjust : 0, deduction: cur ? cur.deduction : 0,
      note: cur ? cur.note : (p.tier ? `級距：${p.tier.label}（+${p.tier.bonus_pct}%）` : '')
    };
    row.total = money(row.base_salary + row.comm_service + row.comm_retail + row.comm_designate
      + row.tier_bonus + yuan(row.adjust) - yuan(row.deduction));
    if (cur) {
      db.prepare(`UPDATE payrolls SET base_salary=@base_salary, service_amount=@service_amount,
        designated_amount=@designated_amount, retail_amount=@retail_amount, ticket_count=@ticket_count,
        designate_count=@designate_count, minutes_total=@minutes_total, comm_service=@comm_service,
        comm_retail=@comm_retail, comm_designate=@comm_designate, tier_bonus=@tier_bonus, total=@total
        WHERE period=@period AND therapist_id=@therapist_id`).run(row);
      out.updated++;
    } else {
      db.prepare(`INSERT INTO payrolls(period,therapist_id,store_id,base_salary,service_amount,designated_amount,
        retail_amount,ticket_count,designate_count,minutes_total,comm_service,comm_retail,comm_designate,
        tier_bonus,adjust,deduction,total,note)
        VALUES(@period,@therapist_id,@store_id,@base_salary,@service_amount,@designated_amount,
        @retail_amount,@ticket_count,@designate_count,@minutes_total,@comm_service,@comm_retail,@comm_designate,
        @tier_bonus,@adjust,@deduction,@total,@note)`).run(row);
      out.created++;
    }
  }
  audit('staff', null, actor || '', `產生 ${period} 薪資試算：新增 ${out.created} 筆、更新 ${out.updated} 筆`);
  return out;
});

function recalcTotal(id) {
  const p = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(id);
  if (!p) return null;
  const total = money(p.base_salary + p.comm_service + p.comm_retail + p.comm_designate
    + p.tier_bonus + p.adjust - p.deduction);
  db.prepare('UPDATE payrolls SET total = ? WHERE id = ?').run(total, id);
  return db.prepare('SELECT * FROM payrolls WHERE id = ?').get(id);
}

// 一張薪資單背後的每一筆鐘單。技師來問「這個月怎麼只有這樣」，就打開這個。
function breakdown(therapistId, period) {
  const { start, end } = monthRange(period);
  const dateExpr = 't.biz_date';
  const tickets = db.prepare(`
    SELECT t.id, t.ticket_no, t.service_name, t.minutes, t.assign_type, t.amount, t.discount,
           t.retail_amount, t.comm_service, t.comm_retail, t.comm_designate, t.comm_pct_used,
           COALESCE(NULLIF(t.actual_start,''), t.start_at) AS at,
           COALESCE(m.name, t.guest_name) AS customer
    FROM tickets t LEFT JOIN members m ON m.id = t.member_id
    WHERE t.therapist_id = ? AND t.status = 'done' AND ${dateExpr} >= ? AND ${dateExpr} < ?
    ORDER BY at`).all(therapistId, start, end);
  const others = db.prepare(`
    SELECT i.*, t.ticket_no, COALESCE(NULLIF(t.actual_start,''), t.start_at) AS at
    FROM ticket_items i JOIN tickets t ON t.id = i.ticket_id
    WHERE i.therapist_id = ? AND t.therapist_id <> i.therapist_id AND t.status = 'done'
      AND ${dateExpr} >= ? AND ${dateExpr} < ?
    ORDER BY at`).all(therapistId, start, end);
  const prepaidRows = db.prepare(`
    SELECT w.id, w.created_at AS at, w.amount, w.comm_amount, m.name AS customer, 'topup' AS kind
    FROM wallet_txns w LEFT JOIN members m ON m.id = w.member_id
    WHERE w.therapist_id = ? AND w.kind = 'topup'
      AND substr(w.created_at,1,10) >= ? AND substr(w.created_at,1,10) < ?
    UNION ALL
    SELECT p.id, p.buy_date AS at, p.price_paid AS amount,
           ROUND(p.price_paid * ? / 100, 2) AS comm_amount, m.name AS customer, 'pass' AS kind
    FROM passes p LEFT JOIN members m ON m.id = p.member_id
    WHERE p.sold_by = ? AND p.buy_date >= ? AND p.buy_date < ?
    ORDER BY at`).all(therapistId, start, end,
      require('./db').num('prepaid_commission_pct', 5), therapistId, start, end);
  return { tickets, others, prepaid: prepaidRows, summary: preview(therapistId, period) };
}

module.exports = { stats, preview, generate, recalcTotal, breakdown };
