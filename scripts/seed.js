// 示範資料。跑 `npm run seed` 會清空業務資料後重建一份看起來像真的營運紀錄：
// 兩家分店、12 位技師、60 天的鐘單與輪鐘軌跡、儲值與次卡、費用。
// 帳號與系統設定不動 —— 示範完不必重設密碼。
process.env.TZ = 'Asia/Taipei';
const bcrypt = require('bcryptjs');
const { db, today, shiftDate, addMinutes, addMonths, nextSerial, setSetting, money, yuan, nowStamp } = require('../src/db');
const { MODULE_KEYS } = require('../src/auth');
const rotation = require('../src/rotation');
const prepaid = require('../src/prepaid');
const commission = require('../src/commission');

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[rnd(0, arr.length - 1)];
const chance = p => Math.random() < p;

console.log('清除既有業務資料…');
db.exec(`DELETE FROM pass_txns; DELETE FROM passes; DELETE FROM wallet_txns; DELETE FROM wallets;
  DELETE FROM ticket_items; DELETE FROM tickets; DELETE FROM queue_logs; DELETE FROM shifts;
  DELETE FROM payrolls; DELETE FROM expenses; DELETE FROM issues; DELETE FROM bookings;
  DELETE FROM notifications; DELETE FROM members; DELETE FROM retail_products; DELETE FROM services;
  DELETE FROM rooms; DELETE FROM therapists; DELETE FROM stores; DELETE FROM serials;`);

// ---- 分店 ----
const stores = [
  ['ZH', '中山旗艦館', '02-2511-8899', '台北市中山區南京東路二段 88 號 3 樓', '10:00', '23:00'],
  ['XY', '信義會館', '02-2758-6677', '台北市信義區松仁路 100 號 2 樓', '11:00', '23:30']
].map(s => db.prepare(`INSERT INTO stores(code,name,phone,address,open_time,close_time) VALUES(?,?,?,?,?,?)`).run(...s).lastInsertRowid);

// ---- 服務項目 ----
// contraindications 用的字詞要跟 settings 的 health_conditions 對得起來，閘門才擋得到。
const serviceDefs = [
  ['S60', '全身指壓 60 分', '全身按摩', 60, 1280, '單人床,雙人房', '', '近期手術,開放性傷口,急性發炎,血栓病史'],
  ['S90', '全身指壓 90 分', '全身按摩', 90, 1780, '單人床,雙人房', '', '近期手術,開放性傷口,急性發炎,血栓病史'],
  ['F40', '腳底舒壓 40 分', '腳底按摩', 40, 780, '足療區', '', '開放性傷口,急性發炎'],
  ['F60', '腳底舒壓 60 分', '腳底按摩', 60, 1080, '足療區', '', '開放性傷口,急性發炎'],
  ['N30', '頭肩頸放鬆 30 分', '頭部肩頸', 30, 680, '', '', '近期手術'],
  ['O90', '精油舒緩 90 分', '精油SPA', 90, 2380, 'VIP包廂,雙人房', 5, '懷孕,產後未滿六週,皮膚病,癌症治療中'],
  ['O120', '精油舒緩 120 分', '精油SPA', 120, 3080, 'VIP包廂', 5, '懷孕,產後未滿六週,皮膚病,癌症治療中'],
  ['H90', '熱石深層 90 分', '熱石', 90, 2680, 'VIP包廂', 5, '懷孕,高血壓,心臟病,糖尿病,皮膚病'],
  ['G40', '刮痧拔罐 40 分', '刮痧拔罐', 40, 880, '單人床', '', '懷孕,服用抗凝血劑,血栓病史,皮膚病,開放性傷口'],
  ['P60', '孕期舒緩 60 分', '孕婦按摩', 60, 1480, 'VIP包廂,雙人房', 10, '產後未滿六週,急性發炎'],
  ['T60', '深層推拿 60 分', '指壓推拿', 60, 1380, '單人床', '', '骨質疏鬆,近期手術,服用抗凝血劑,血栓病史']
];
const services = serviceDefs.map((s, i) => db.prepare(`INSERT INTO services(code,name,category,minutes,price,
  room_type,buffer_min,contraindications,seq) VALUES(?,?,?,?,?,?,?,?,?)`)
  .run(s[0], s[1], s[2], s[3], s[4], s[5], s[6] || 0, s[7], i).lastInsertRowid);
const serviceRows = db.prepare('SELECT * FROM services').all();

// ---- 床位 ----
const roomDefs = [
  [0, 'A1', '單人床', 1], [0, 'A2', '單人床', 1], [0, 'A3', '單人床', 1], [0, 'A4', '單人床', 1],
  [0, 'B1', '雙人房', 2], [0, 'VIP-1', 'VIP包廂', 1], [0, 'VIP-2', 'VIP包廂', 1], [0, '足療區', '足療區', 6],
  [1, 'C1', '單人床', 1], [1, 'C2', '單人床', 1], [1, 'C3', '單人床', 1],
  [1, 'D1', '雙人房', 2], [1, 'VIP-S', 'VIP包廂', 1], [1, '足療區', '足療區', 4]
];
const rooms = roomDefs.map((r, i) => db.prepare('INSERT INTO rooms(store_id,name,rtype,capacity,seq) VALUES(?,?,?,?,?)')
  .run(stores[r[0]], r[1], r[2], r[3], i).lastInsertRowid);
const roomRows = db.prepare('SELECT * FROM rooms').all();

// ---- 技師 ----
// 抽成刻意留白（0）讓大部分人走「級別預設」，只有兩位是個別談定的條件 ——
// 這樣示範時看得出「％從哪裡來」這件事。
const therapistDefs = [
  ['T01', '林淑芬', '芬姐', '女', '首席', 26000, 0, 0, 0, 0, '全身按摩,指壓推拿,精油SPA,熱石'],
  ['T02', '陳美玲', '玲玲', '女', '資深', 24000, 0, 0, 0, 0, '全身按摩,精油SPA,孕婦按摩'],
  ['T03', '黃志明', '阿明', '男', '資深', 24000, 48, 55, 0, 120, '全身按摩,指壓推拿,刮痧拔罐'],
  ['T04', '吳雅婷', '婷婷', '女', '一般', 22000, 0, 0, 0, 0, '全身按摩,腳底按摩,頭部肩頸'],
  ['T05', '張家豪', '豪哥', '男', '一般', 22000, 0, 0, 0, 0, '指壓推拿,腳底按摩,刮痧拔罐'],
  ['T06', '李佩珊', '珊珊', '女', '資深', 24000, 0, 0, 15, 0, '精油SPA,熱石,孕婦按摩,全身按摩'],
  ['T07', '王建國', '國仔', '男', '一般', 22000, 0, 0, 0, 0, '全身按摩,指壓推拿'],
  ['T08', '劉品妤', '妤妤', '女', '一般', 22000, 0, 0, 0, 0, '腳底按摩,頭部肩頸,全身按摩'],
  ['T09', '許文彥', '阿彥', '男', '見習', 20000, 0, 0, 0, 0, '腳底按摩,頭部肩頸'],
  ['T10', '鄭雅文', '文文', '女', '見習', 20000, 0, 0, 0, 0, '腳底按摩,全身按摩'],
  ['T11', '蔡明哲', '哲哥', '男', '資深', 24000, 0, 0, 0, 0, '指壓推拿,全身按摩,刮痧拔罐'],
  ['T12', '周佳穎', '穎穎', '女', '一般', 22000, 0, 0, 0, 0, '全身按摩,精油SPA,頭部肩頸']
];
const therapists = therapistDefs.map((t, i) => {
  const store = stores[i < 8 ? 0 : 1];
  const hire = shiftDate(today(), -rnd(120, 1500));
  // 故意讓兩個人的證照／健檢快到期或已過期，法遵頁才有東西可看
  const certExp = i === 8 ? shiftDate(today(), -12) : i === 3 ? shiftDate(today(), 20) : shiftDate(today(), rnd(120, 900));
  const healthExp = i === 5 ? shiftDate(today(), 30) : i === 9 ? '' : shiftDate(today(), rnd(60, 340));
  return db.prepare(`INSERT INTO therapists(code,name,nickname,gender,phone,line_uid,store_id,level,hire_date,
    employ_type,base_salary,pct_normal,pct_designated,pct_retail,designate_fee,skills,cert_no,cert_expiry,
    health_check_date,health_check_expiry,is_blind)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(t[0], t[1], t[2], t[3], `09${rnd(10, 89)}-${rnd(100, 999)}-${rnd(100, 999)}`, '',
      store, t[4], hire, chance(0.15) ? '兼職' : '全職', t[5], t[6], t[7], t[8], t[9], t[10],
      `照字第 ${rnd(100000, 999999)} 號`, certExp,
      healthExp ? shiftDate(healthExp, -365) : '', healthExp, i === 9 ? 1 : 0).lastInsertRowid;
});
const therapistRows = db.prepare('SELECT * FROM therapists').all();

// ---- 商品 ----
const productDefs = [
  ['P001', '舒緩複方精油 30ml', '精油', 1280, 520], ['P002', '薰衣草純露 100ml', '保養品', 680, 260],
  ['P003', '肩頸熱敷袋', '按摩用品', 880, 340], ['P004', '足部去角質霜', '保養品', 580, 210],
  ['P005', '筋膜按摩球組', '按摩用品', 780, 290], ['P006', '薑黃保健錠 60 錠', '保健食品', 1180, 480],
  ['P007', '護頸支撐枕', '按摩用品', 1480, 620], ['P008', '禮券 1000 元', '禮券', 1000, 0]
];
const products = productDefs.map(p => db.prepare(`INSERT INTO retail_products(sku,name,category,price,cost,stock,safety_stock)
  VALUES(?,?,?,?,?,?,?)`).run(p[0], p[1], p[2], p[3], p[4], rnd(3, 40), 5).lastInsertRowid);

// ---- 客人 ----
const surnames = '陳林黃張李王吳劉蔡楊許鄭謝郭洪曾邱廖賴周徐蘇葉莊呂江何蕭羅高'.split('');
const given = ['雅婷', '怡君', '志豪', '家瑋', '淑娟', '建宏', '美惠', '俊傑', '佩君', '柏翰', '欣怡', '宗翰',
  '雅琪', '冠廷', '思妤', '承恩', '筱涵', '柏勳', '育慈', '哲瑋', '孟儒', '若涵', '子軒', '宜蓁'];
const conditionsPool = ['', '', '', '', '高血壓', '糖尿病', '骨質疏鬆', '懷孕', '近期手術', '服用抗凝血劑',
  '心臟病', '皮膚病', '高血壓,糖尿病'];
const avoidPool = ['', '', '', '頸椎', '腰椎', '膝蓋', '肩關節', '腹部', '手術部位'];

const members = [];
for (let i = 0; i < 90; i++) {
  const name = pick(surnames) + pick(given);
  const cond = pick(conditionsPool);
  const fav = chance(0.45) ? pick(therapistRows).id : null;
  const id = db.prepare(`INSERT INTO members(member_no,name,phone,gender,birthday,store_id,source,tags,
    fav_therapist_id,pressure_pref,avoid_parts,conditions,health_note,health_updated_at,consent_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(nextSerial('M'), name, `09${rnd(10, 89)}${rnd(100000, 999999)}`,
      chance(0.62) ? '女' : '男', `19${rnd(60, 99)}-${String(rnd(1, 12)).padStart(2, '0')}-${String(rnd(1, 28)).padStart(2, '0')}`,
      pick(stores), pick(['路過', '朋友介紹', 'Google', 'Facebook', 'LINE', '團購平台', '公司特約']),
      chance(0.2) ? pick(['VIP', '高消費', '只做指名', '需要安靜', '不喜歡聊天']) : '',
      fav, pick(['輕', '中', '中', '重']), pick(avoidPool), cond,
      cond ? '客人自述，服務前已再次確認' : '',
      chance(0.85) ? shiftDate(today(), -rnd(1, 400)) + ' 14:00' : '',
      chance(0.8) ? shiftDate(today(), -rnd(1, 400)) + ' 14:00' : '').lastInsertRowid;
  members.push(id);
}
const memberRows = db.prepare('SELECT * FROM members').all();

// ---- 儲值與次卡 ----
console.log('建立儲值與次卡…');
for (const m of memberRows) {
  if (chance(0.35)) {
    const amt = pick([5000, 10000, 10000, 20000, 30000]);
    const bonus = amt >= 20000 ? Math.round(amt * 0.15) : amt >= 10000 ? Math.round(amt * 0.1) : 0;
    prepaid.topup({ memberId: m.id, amount: amt, bonus, payMethod: pick(['現金', '刷卡', '匯款']),
      therapistId: chance(0.7) ? pick(therapistRows).id : null, storeId: m.store_id,
      note: '示範資料', actor: '系統' });
  }
  if (chance(0.28)) {
    const svc = pick(serviceRows);
    const times = pick([5, 10, 10, 12]);
    const list = svc.price * times;
    prepaid.buyPass({ memberId: m.id, serviceId: svc.id, name: `${svc.name} ${times} 次卡`,
      totalTimes: times, pricePaid: Math.round(list * pick([0.8, 0.85, 0.9])), listValue: list,
      soldBy: pick(therapistRows).id, storeId: m.store_id, actor: '系統' });
  }
}

// ---- 60 天的營運紀錄 ----
console.log('產生 60 天鐘單與輪鐘軌跡…');
const DAYS = 60;
let ticketCount = 0;

for (let d = DAYS; d >= 0; d--) {
  const date = shiftDate(today(), -d);
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const busy = dow === 5 || dow === 6 || dow === 0;      // 週五六日是旺日

  for (const storeId of stores) {
    const pool = therapistRows.filter(t => t.store_id === storeId);
    // 每天約七到九成的人上班
    const onDuty = pool.filter(() => chance(busy ? 0.9 : 0.72));
    if (!onDuty.length) continue;
    // 簽到順序每天不一樣（現實就是誰先到誰前面），這也是輪鐘公平性的起點
    const shuffled = onDuty.slice().sort(() => Math.random() - 0.5);
    const seqMap = {};
    shuffled.forEach((t, i) => {
      const seq = i + 1;
      seqMap[t.id] = seq;
      db.prepare(`INSERT INTO shifts(work_date,therapist_id,store_id,queue_seq,checkin_at,status,rounds)
        VALUES(?,?,?,?,?, ?, 0)`).run(date, t.id, storeId, seq,
          `${date} ${String(rnd(10, 12)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}`,
          d === 0 ? 'waiting' : 'off');
      rotation.log({ work_date: date, store_id: storeId, therapist_id: t.id, therapist_name: t.name,
        event: 'checkin', seq_after: seq, rounds_after: 0, actor: '系統' });
    });

    const storeRooms = roomRows.filter(r => r.store_id === storeId);
    const count = busy ? rnd(14, 24) : rnd(7, 15);
    const roundsMap = {};

    for (let k = 0; k < count; k++) {
      const svc = pick(serviceRows);
      const th = pick(shuffled);
      const member = chance(0.78) ? pick(memberRows.filter(m => m.store_id === storeId)) : null;
      // 指名率：紅牌高、見習低。這個差異正是輪鐘制要處理的問題。
      const designateRate = { 首席: 0.62, 資深: 0.42, 一般: 0.22, 見習: 0.08 }[th.level] || 0.2;
      const designated = member && (chance(designateRate) || (member.fav_therapist_id === th.id && chance(0.7)));
      const hour = rnd(11, 21);
      const start = `${date} ${String(hour).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}`;
      const room = pick(storeRooms);
      const fee = designated ? 100 : 0;
      const discount = chance(0.15) ? pick([100, 200, 300]) : 0;

      const no = nextSerial('T', date);
      const id = db.prepare(`INSERT INTO tickets(ticket_no,store_id,member_id,guest_name,pax,therapist_id,room_id,
        service_id,service_name,minutes,start_at,end_at,actual_start,actual_end,assign_type,designate_fee,
        status,source,amount,retail_amount,discount,net_amount,created_by)
        VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,'系統')`)
        .run(no, storeId, member?.id || null, member ? '' : '現場客',
          th.id, room.id, svc.id, svc.name, svc.minutes, start, addMinutes(start, svc.minutes),
          start, addMinutes(start, svc.minutes),
          designated ? 'designated' : 'rotation', fee,
          d === 0 && chance(0.3) ? 'booked' : 'done',
          pick(['現場', '電話', 'LINE', '官網', '回頭客']),
          svc.price, discount, Math.max(0, svc.price + fee - discount)).lastInsertRowid;

      // 商品加購
      let retail = 0;
      if (chance(0.16)) {
        const p = db.prepare('SELECT * FROM retail_products WHERE id = ?').get(pick(products));
        const qty = 1;
        db.prepare(`INSERT INTO ticket_items(ticket_id,kind,ref_id,name,qty,unit_price,amount,therapist_id)
          VALUES(?,'retail',?,?,?,?,?,?)`).run(id, p.id, p.name, qty, p.price, p.price * qty, th.id);
        retail = p.price * qty;
      }
      // 加鐘
      if (chance(0.1)) {
        const add = 30, price = 500;
        db.prepare(`INSERT INTO ticket_items(ticket_id,kind,name,minutes,qty,unit_price,amount)
          VALUES(?,'service','加鐘 30 分',?,1,?,?)`).run(id, add, price, price);
      }

      // 重算金額（跟正式流程用同一套邏輯：主項＋明細）
      const items = db.prepare('SELECT * FROM ticket_items WHERE ticket_id = ?').all(id);
      const addService = items.filter(i => i.kind !== 'retail').reduce((s, i) => s + i.amount, 0);
      const addMin = items.filter(i => i.kind !== 'retail').reduce((s, i) => s + i.minutes, 0);
      const amount = svc.price + addService;
      const net = Math.max(0, amount + retail + fee - discount);
      db.prepare(`UPDATE tickets SET amount=?, retail_amount=?, net_amount=?, minutes=?, end_at=?, actual_end=? WHERE id=?`)
        .run(amount, retail, net, svc.minutes + addMin, addMinutes(start, svc.minutes + addMin),
          addMinutes(start, svc.minutes + addMin), id);

      const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      if (t.status === 'done') {
        // 結帳：付款方式與抽成走跟正式流程一樣的計算
        const comm = commission.computeTicket(t, items);
        let paidPass = 0, paidWallet = 0, remain = net;
        if (member) {
          const usable = prepaid.activePasses(member.id, svc.id);
          if (usable.length && chance(0.45)) {
            const p = usable[0];
            const r = prepaid.usePass({ passId: p.id, ticketId: id, times: 1, note: `${no} 核銷`, actor: '系統' });
            paidPass = Math.min(r.value, Math.max(0, net - retail));
            remain = Math.max(0, net - paidPass);
          }
          if (remain > 0 && chance(0.4)) {
            const bal = prepaid.walletBalance(member.id);
            if (bal.total > 0) {
              const use = Math.min(remain, bal.total);
              prepaid.consume({ memberId: member.id, amount: use, ticketId: id, storeId, note: `${no} 消費扣款`, actor: '系統' });
              paidWallet = use; remain -= use;
            }
          }
        }
        db.prepare(`UPDATE tickets SET paid_cash=?, paid_wallet=?, paid_pass=?, pay_method=?,
          comm_service=?, comm_retail=?, comm_designate=?, comm_pct_used=?, rating=?, feedback=? WHERE id=?`)
          .run(remain, paidWallet, paidPass,
            remain > 0 ? pick(['現金', '刷卡', 'LINE Pay']) : paidPass > 0 ? '次卡核銷' : '儲值扣款',
            comm.comm_service, comm.comm_retail, comm.comm_designate, comm.pct_used,
            chance(0.3) ? rnd(4, 5) : 0, '', id);
        for (const dt of comm.detail) {
          if (dt.item_id) db.prepare('UPDATE ticket_items SET comm_pct=?, comm_amount=? WHERE id=?').run(dt.pct, dt.amount, dt.item_id);
        }
        if (retail) {
          const it = items.find(i => i.kind === 'retail');
          if (it?.ref_id) db.prepare('UPDATE retail_products SET stock = MAX(0, stock - ?) WHERE id = ?').run(it.qty, it.ref_id);
        }
      }

      // 輪序軌跡：指名不計輪次（跟系統預設一致）
      const before = roundsMap[th.id] || 0;
      const after = designated ? before : before + 1;
      roundsMap[th.id] = after;
      rotation.log({ work_date: date, store_id: storeId, therapist_id: th.id, therapist_name: th.name,
        event: designated ? 'designate' : 'assign', ticket_id: id,
        seq_after: seqMap[th.id], rounds_before: before, rounds_after: after,
        reason: designated ? '指名不計輪次' : '計入輪次', actor: '系統' });
      ticketCount++;
    }
    for (const [tid, r] of Object.entries(roundsMap)) {
      db.prepare('UPDATE shifts SET rounds = ? WHERE work_date = ? AND therapist_id = ?').run(r, date, tid);
    }
  }
}

// 今天檯面上留幾個人在上鐘中，畫面才不是空的
const todayShifts = db.prepare("SELECT * FROM shifts WHERE work_date = ? ORDER BY queue_seq").all(today());
todayShifts.slice(0, 3).forEach(s => db.prepare("UPDATE shifts SET status='serving' WHERE id=?").run(s.id));
if (todayShifts[4]) db.prepare("UPDATE shifts SET status='resting', rest_until=? WHERE id=?")
  .run(addMinutes(nowStamp(), 20), todayShifts[4].id);

// ---- 費用 ----
for (let d = 90; d >= 0; d -= 1) {
  const date = shiftDate(today(), -d);
  if (date.endsWith('-05')) {
    for (const s of stores) {
      db.prepare(`INSERT INTO expenses(store_id,spend_date,category,vendor,amount,pay_method)
        VALUES(?,?,'房租','房東',?,'匯款')`).run(s, date, s === stores[0] ? 180000 : 145000);
    }
  }
  if (chance(0.12)) {
    db.prepare(`INSERT INTO expenses(store_id,spend_date,category,vendor,amount,pay_method,note)
      VALUES(?,?,?,?,?,?,?)`).run(pick(stores), date,
        pick(['用品耗材', '洗滌', '水電', '行銷廣告', '設備維修', '雜支']),
        pick(['大同布巾行', '康和清潔', '台電', 'Meta 廣告', '恆溫設備', '全聯']),
        rnd(800, 26000), pick(['現金', '刷卡', '匯款']), '');
  }
}

// ---- 客訴與線上預約 ----
const issueSamples = [
  ['客訴', 'high', '技師遲到 20 分鐘', '客人 19:00 預約，技師 19:20 才進場，客人當場表示不滿。', '致歉並贈送 30 分鐘加鐘券，店長已與技師面談。', 'closed', 500],
  ['收費爭議', 'normal', '次卡核銷次數認知不同', '客人認為上次沒有用到卡，經查核銷紀錄確有一筆。', '調出核銷流水給客人確認，已解釋清楚。', 'closed', 0],
  ['技師糾紛', 'normal', '輪鐘順序爭議', '技師反映當日應輪到他，卻被跳過。', '調閱輪序軌跡，該筆為客人指名，不計輪次，已說明。', 'closed', 0],
  ['設備故障', 'low', 'VIP-2 恆溫床加熱異常', '加熱功能時好時壞。', '已聯繫廠商，預計三日內到場。', 'handling', 0],
  ['客訴', 'high', '力道過重造成瘀青', '客人反映隔日肩頸出現瘀青。', '致電關心，全額退費並記錄該客人力道偏好為「輕」。', 'open', 1780]
];
issueSamples.forEach((s, i) => {
  db.prepare(`INSERT INTO issues(issue_no,store_id,happen_date,category,severity,member_id,therapist_id,
    title,detail,handling,compensation,status,owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(nextSerial('IS'), pick(stores), shiftDate(today(), -rnd(1, 40)), s[0], s[1],
      pick(memberRows).id, pick(therapistRows).id, s[2], s[3], s[4], s[6], s[5], '店長');
});

for (let i = 0; i < 6; i++) {
  const svc = pick(serviceRows);
  db.prepare(`INSERT INTO bookings(booking_no,store_id,name,phone,service_id,therapist_id,prefer_date,
    prefer_time,pax,note,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(nextSerial('BK'), pick(stores), pick(surnames) + pick(given), `09${rnd(10, 89)}${rnd(100000, 999999)}`,
      svc.id, chance(0.4) ? pick(therapistRows).id : null,
      shiftDate(today(), rnd(0, 7)), pick(['14:00', '15:30', '19:00', '20:30']), rnd(1, 2),
      pick(['第一次來，想試試看', '希望安靜一點的空間', '想指定女技師', '', '停車方便嗎？']),
      i < 3 ? 'new' : pick(['contacted', 'converted']));
}

setSetting('ui_demo_hint', '示範帳號：admin / admin123（管理員）\n店長 manager / 123456　櫃檯 front / 123456　會計 acct / 123456（唯讀）');

// ---- 示範帳號 ----
const demoUsers = [
  ['manager', '王store長', '店長', ['dashboard', 'queue', 'board', 'tickets', 'bookings', 'issues', 'members',
    'wallets', 'passes', 'repurchase', 'therapists', 'rooms', 'services', 'retail', 'payroll', 'commission',
    'attendance', 'finance', 'liability', 'expenses', 'compliance', 'expiry', 'notifications'], []],
  ['front', '櫃檯小美', '櫃檯', ['dashboard', 'queue', 'board', 'tickets', 'bookings', 'members', 'wallets',
    'passes', 'repurchase', 'notifications'], []],
  ['acct', '會計小陳', '會計', ['finance', 'liability', 'expenses', 'tax', 'payroll', 'tickets', 'wallets', 'passes'],
    ['tickets', 'wallets', 'passes', 'payroll']]
];
for (const [u, n, title, perms, ro] of demoUsers) {
  db.prepare(`INSERT INTO users(username,password_hash,name,role,title,permissions,readonly_modules)
    VALUES(?,?,?,'staff',?,?,?)
    ON CONFLICT(username) DO UPDATE SET name=excluded.name, title=excluded.title,
      permissions=excluded.permissions, readonly_modules=excluded.readonly_modules`)
    .run(u, bcrypt.hashSync('123456', 10), n, title, JSON.stringify(perms), JSON.stringify(ro));
}

const summary = {
  分店: stores.length, 技師: therapistRows.length, 床位: roomRows.length, 服務項目: serviceRows.length,
  商品: products.length, 客人: memberRows.length,
  鐘單: db.prepare('SELECT COUNT(*) n FROM tickets').get().n,
  輪鐘軌跡: db.prepare('SELECT COUNT(*) n FROM queue_logs').get().n,
  儲值帳戶: db.prepare('SELECT COUNT(*) n FROM wallets WHERE cash_balance>0 OR bonus_balance>0').get().n,
  次卡: db.prepare('SELECT COUNT(*) n FROM passes').get().n,
  預收負債: prepaid.liability().total_cash_liability
};
console.log('示範資料建立完成：', summary);
