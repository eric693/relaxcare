// 抽成分潤引擎。
//
// 一個原則貫穿整份檔案：**抽成在結帳當下算好，寫死在單據上**。
// 不是到月底才回頭套「現在的％」—— 抽成比例調過一次，過去的薪資就全部對不起來，
// 而技師記得自己上個月領多少，這種帳吵不完。
//
// ％的優先順序（由高至低）：
//   1. 服務項目自訂（services.pct_normal / pct_designated）—— 高價療程常常抽得比一般鐘低
//   2. 技師自訂（therapists.pct_normal / pct_designated / pct_retail）—— 個別談定的條件
//   3. 級別預設（settings 的 level_rates）
const { db, levelRates, num, money, yuan } = require('./db');

// 取得某位技師在某個服務項目上的實際抽成％與指名費
function ratesFor(therapist, service) {
  const lv = levelRates()[therapist?.level] || { normal: 0, designated: 0, retail: 0, fee: 0 };
  const pick = (svcVal, thVal, lvVal) => (Number(svcVal) > 0 ? Number(svcVal)
    : Number(thVal) > 0 ? Number(thVal) : Number(lvVal) || 0);
  return {
    normal: pick(service?.pct_normal, therapist?.pct_normal, lv.normal),
    designated: pick(service?.pct_designated, therapist?.pct_designated, lv.designated),
    retail: pick(0, therapist?.pct_retail, lv.retail),
    fee: Number(therapist?.designate_fee) > 0 ? Number(therapist.designate_fee) : (lv.fee || 0),
    level: therapist?.level || '',
    source: {
      normal: Number(service?.pct_normal) > 0 ? '服務項目' : Number(therapist?.pct_normal) > 0 ? '技師自訂' : '級別預設',
      designated: Number(service?.pct_designated) > 0 ? '服務項目' : Number(therapist?.pct_designated) > 0 ? '技師自訂' : '級別預設',
      retail: Number(therapist?.pct_retail) > 0 ? '技師自訂' : '級別預設'
    }
  };
}

function therapistOf(id) { return id ? db.prepare('SELECT * FROM therapists WHERE id = ?').get(id) : null; }
function serviceOf(id) { return id ? db.prepare('SELECT * FROM services WHERE id = ?').get(id) : null; }

// 算一張鐘單的抽成。回傳的數字會被寫進 tickets 與 ticket_items。
//
// 抽成基準是「服務原價 - 折扣」，不是實收現金：
// 客人用儲值或次卡付，技師一樣有做，一樣要抽 —— 預收的錢在儲值當下就已經是店裡的了。
// 但商品抽成只算商品金額，指名費另外給，兩者都不進服務業績的％。
function computeTicket(ticket, items = []) {
  const th = therapistOf(ticket.therapist_id);
  const svc = serviceOf(ticket.service_id);
  const r = ratesFor(th, svc);
  const designated = ticket.assign_type === 'designated';
  const pct = designated ? r.designated : r.normal;

  // 服務業績：主項金額＋屬於主技師的加鐘／加項，扣掉折扣
  const ownServiceItems = items.filter(i => i.kind !== 'retail'
    && (!i.therapist_id || Number(i.therapist_id) === Number(ticket.therapist_id)));
  const serviceBase = Math.max(0,
    yuan(ticket.amount) + ownServiceItems.reduce((s, i) => s + yuan(i.amount), 0) - yuan(ticket.discount));

  const retailItems = items.filter(i => i.kind === 'retail');
  const detail = [];
  let commRetail = 0;
  for (const i of retailItems) {
    const seller = i.therapist_id ? therapistOf(i.therapist_id) : th;
    const prod = i.ref_id ? db.prepare('SELECT * FROM retail_products WHERE id = ?').get(i.ref_id) : null;
    const sellerRates = ratesFor(seller, null);
    const p = Number(prod?.pct_retail) > 0 ? Number(prod.pct_retail) : sellerRates.retail;
    const amt = money(yuan(i.amount) * p / 100);
    commRetail += amt;
    detail.push({ item_id: i.id, kind: 'retail', name: i.name, base: yuan(i.amount), pct: p, amount: amt,
      therapist_id: i.therapist_id || ticket.therapist_id });
  }

  // 加鐘若指定了別的技師，那一筆的抽成算給那個人
  let commOther = 0;
  for (const i of items.filter(x => x.kind !== 'retail'
      && x.therapist_id && Number(x.therapist_id) !== Number(ticket.therapist_id))) {
    const other = therapistOf(i.therapist_id);
    const orates = ratesFor(other, svc);
    const p = designated ? orates.designated : orates.normal;
    const amt = money(yuan(i.amount) * p / 100);
    commOther += amt;
    detail.push({ item_id: i.id, kind: 'service', name: i.name, base: yuan(i.amount), pct: p, amount: amt,
      therapist_id: i.therapist_id });
  }

  const commService = money(serviceBase * pct / 100);
  // 指名費：向客人加收多少（ticket.designate_fee）與技師實拿多少（r.fee）是兩件事。
  // 有些店加收 100 但只給技師 50，差額是店裡的。
  const commDesignate = designated ? money(r.fee) : 0;

  return {
    pct_used: pct,
    rates: r,
    service_base: serviceBase,
    comm_service: commService,
    comm_retail: money(commRetail),
    comm_other: money(commOther),
    comm_designate: commDesignate,
    total: money(commService + commRetail + commDesignate),
    detail: [{ item_id: null, kind: 'service', name: ticket.service_name || '主項服務',
      base: serviceBase, pct, amount: commService, therapist_id: ticket.therapist_id }].concat(detail)
  };
}

// 業績級距獎金：找出符合月業績與級別的那一級，回傳％與說明。
// 級別留空的規則適用所有人；有指定級別的規則優先。
function tierFor(level, monthAmount) {
  const rows = db.prepare(`SELECT * FROM commission_tiers WHERE active = 1
    AND (level = '' OR level = ?) AND min_amount <= ?
    AND (max_amount = 0 OR max_amount >= ?)
    ORDER BY (level = '') ASC, min_amount DESC`).all(level || '', monthAmount, monthAmount);
  return rows[0] || null;
}

// 預收銷售（儲值、次卡）的抽成。這筆錢還沒服務，抽成通常低很多，
// 且要另外標記 —— 客人退款時抽成是否追回，是店裡的政策，系統至少要查得到是誰銷的。
function prepaidCommission(amount, therapistId) {
  const pct = num('prepaid_commission_pct', 5);
  return { pct, amount: money(yuan(amount) * pct / 100), therapist_id: therapistId || null };
}

module.exports = { ratesFor, computeTicket, tierFor, prepaidCommission, therapistOf, serviceOf };
