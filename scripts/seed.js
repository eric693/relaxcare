// 示範資料。跑 `npm run seed` 會清空業務資料後重建一份看起來像真的營運紀錄：
// 兩家分店、12 位技師、60 天的鐘單與輪鐘軌跡、儲值與次卡、費用。
// 帳號與系統設定不動 —— 示範完不必重設密碼。
process.env.TZ = 'Asia/Taipei';
const bcrypt = require('bcryptjs');
const { db, today, shiftDate, addMinutes, addMonths, nextSerial, setSetting, money, yuan, nowStamp, bizDate } = require('../src/db');
const { MODULE_KEYS } = require('../src/auth');
const rotation = require('../src/rotation');
const prepaid = require('../src/prepaid');
const commission = require('../src/commission');
const pricing = require('../src/pricing');
const V = require('../src/vouchers');
const consent = require('../src/consent');
const inventory = require('../src/inventory');
const loyalty = require('../src/loyalty');
const invoicing = require('../src/invoicing');
const roster = require('../src/roster');
const closing = require('../src/closing');

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[rnd(0, arr.length - 1)];
const chance = p => Math.random() < p;

console.log('清除既有業務資料…');
// 刪除順序要由「有外鍵的一方」往回刪：consents/point_txns 指向 members，
// rosters 指向 therapists，先刪 members 會直接違反外鍵。
db.exec(`DELETE FROM consents; DELETE FROM point_txns; DELETE FROM password_resets;
  DELETE FROM stock_txns; DELETE FROM closings; DELETE FROM invoices; DELETE FROM rosters;
  DELETE FROM attachments;
  DELETE FROM vouchers; DELETE FROM addons; DELETE FROM pass_txns; DELETE FROM passes; DELETE FROM wallet_txns; DELETE FROM wallets;
  DELETE FROM ticket_items; DELETE FROM tickets; DELETE FROM queue_logs; DELETE FROM shifts;
  DELETE FROM payrolls; DELETE FROM expenses; DELETE FROM issues; DELETE FROM bookings;
  DELETE FROM notifications; DELETE FROM members; DELETE FROM retail_products; DELETE FROM services;
  DELETE FROM rooms; DELETE FROM therapists; DELETE FROM stores; DELETE FROM serials;`);

// 清掉 uploads/ 裡的檔案。只刪資料列會留下一堆沒人認領的照片與簽名檔 ——
// 那是客人的個資，而且每跑一次 seed 就多留一批。
{
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'data', 'uploads');
  if (fs.existsSync(dir)) {
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); n++; } catch { /* 忽略 */ }
    }
    if (n) console.log(`  清除附件檔案 ${n} 個`);
  }
}

// ---- 分店 ----
const stores = [
  // 實際的按摩連鎖多半是 24 小時或營業到凌晨，這裡刻意兩種都放，
  // 讓看板與日結的跨午夜處理有東西可測。
  ['ZH', '中山旗艦館', '02-2511-8899', '台北市中山區林森北路 263 號 3 樓', '00:00', '00:00'],
  ['XY', '信義會館', '02-2758-6677', '台北市信義區松仁路 100 號 2 樓', '11:00', '03:00']
].map(s => db.prepare(`INSERT INTO stores(code,name,phone,address,open_time,close_time) VALUES(?,?,?,?,?,?)`).run(...s).lastInsertRowid);

// ---- 服務項目 ----
// contraindications 用的字詞要跟 settings 的 health_conditions 對得起來，閘門才擋得到。
// 價目參考台北兩家實際連鎖店的標價方式：同一個項目分 60／90／120 分三種時長，
// 每種都是「牌價 → 現場特價 → 會員價」三層。牌價不是唬人的，它是折扣率的分母。
// 欄位：代碼, 品名, 分類, 分鐘, 牌價, 現場價, 會員價, 房型, 整理時間, 禁忌
const serviceDefs = [
  ['F30', '傳統東方足部按摩 30 分', '腳底按摩', 30, 700, 600, 570, '足療區', '', '開放性傷口,急性發炎'],
  ['F60', '傳統東方足部按摩 60 分', '腳底按摩', 60, 1200, 999, 950, '足療區', '', '開放性傷口,急性發炎'],
  ['F90', '傳統東方足部按摩 90 分', '腳底按摩', 90, 1800, 1499, 1420, '足療區', '', '開放性傷口,急性發炎'],
  ['M60', '傳統經絡按摩 60 分', '全身按摩', 60, 1300, 1100, 1050, '單人床,雙人房', '', '近期手術,開放性傷口,急性發炎,血栓病史'],
  ['M90', '傳統經絡按摩 90 分', '全身按摩', 90, 1800, 1499, 1420, '單人床,雙人房', '', '近期手術,開放性傷口,急性發炎,血栓病史'],
  ['M120', '傳統經絡按摩 120 分', '全身按摩', 120, 2400, 1980, 1880, '單人床,雙人房', '', '近期手術,開放性傷口,急性發炎,血栓病史'],
  ['T60', '泰式草本按摩 60 分', '指壓推拿', 60, 1300, 1200, 1140, '單人床', '', '骨質疏鬆,近期手術,服用抗凝血劑,血栓病史'],
  ['T90', '泰式草本按摩 90 分', '指壓推拿', 90, 1800, 1499, 1420, '單人床', '', '骨質疏鬆,近期手術,服用抗凝血劑,血栓病史'],
  ['O60', '精油舒壓 60 分', '精油SPA', 60, 1500, 1300, 1240, 'VIP包廂,雙人房', 5, '懷孕,產後未滿六週,皮膚病,癌症治療中'],
  ['O90', '精油舒壓 90 分', '精油SPA', 90, 2000, 1800, 1710, 'VIP包廂,雙人房', 5, '懷孕,產後未滿六週,皮膚病,癌症治療中'],
  ['H90', '黑玉熱石油壓 90 分', '熱石', 90, 2200, 1800, 1710, 'VIP包廂', 5, '懷孕,高血壓,心臟病,糖尿病,皮膚病'],
  ['H120', '黑玉熱石油壓 120 分', '熱石', 120, 2400, 1980, 1880, 'VIP包廂', 5, '懷孕,高血壓,心臟病,糖尿病,皮膚病'],
  ['N30', '頭肩頸放鬆 30 分', '頭部肩頸', 30, 700, 680, 650, '', '', '近期手術'],
  ['W50', '足湯＋腳底按摩 50 分', '腳底按摩', 50, 800, 800, 760, '足療區', '', '開放性傷口,急性發炎,懷孕'],
  ['P60', '孕期舒緩 60 分', '孕婦按摩', 60, 1600, 1480, 1400, 'VIP包廂,雙人房', 10, '產後未滿六週,急性發炎'],
  ['B60', '美白去角質護理 60 分', '身體護理', 60, 1800, 1500, 1420, 'VIP包廂,沖澡間', 10, '皮膚病,開放性傷口,懷孕']
];
const services = serviceDefs.map((s, i) => db.prepare(`INSERT INTO services(code,name,category,minutes,
  list_price,price,member_price,room_type,buffer_min,contraindications,seq)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
  .run(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8] || 0, s[9], i).lastInsertRowid);

// 組合套票：多個項目綁成一個套餐價，總價低於各項相加。
const svcByCode = code => db.prepare('SELECT * FROM services WHERE code = ?').get(code);
// 套票價一定要低於「各項分開買」的總和，否則沒有人會買套票 ——
// 一致性測試會檢查這件事，設錯了跑不過。
const packageDefs = [
  ['PK180', '完美按摩套票 180 分', 3600, 2680, 2550, ['F60', 'M120']],   // 分開 999+1980=2979
  ['PK120', '豪華按摩套票 120 分', 2500, 1880, 1780, ['F60', 'M60']],    // 分開 999+1100=2099
  ['PK90', '輕鬆套票 90 分', 1900, 1380, 1310, ['F30', 'M60']]           // 分開 600+1100=1700
];
for (const [code, name, list, price, member, items] of packageDefs) {
  const ids = items.map(c => svcByCode(c).id);
  const mins = items.reduce((a, c) => a + svcByCode(c).minutes, 0);
  db.prepare(`INSERT INTO services(code,name,category,minutes,list_price,price,member_price,
    is_package,package_items,seq,description) VALUES(?,?,?,?,?,?,?,1,?,?,?)`)
    .run(code, name, '組合套票', mins, list, price, member, ids.join(','), 90,
      `包含：${items.map(c => svcByCode(c).name).join(' + ')}`);
}
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

// ---- 加購品 ----
const addonDefs = [
  ['A01', '刮痧', '加購療程', 15, 600, 600, 570, 1],
  ['A02', '拔罐', '加購療程', 15, 600, 600, 570, 1],
  ['A03', '足部護理', '足部護理', 20, 600, 600, 570, 1],
  ['A04', '腳趾甲護理', '足部護理', 20, 600, 600, 570, 1],
  ['A05', '加鐘 30 分', '加購療程', 30, 700, 600, 570, 1],
  ['A06', '肩頸加強 15 分', '加購療程', 15, 350, 300, 285, 1],
  ['A07', '中藥足湯包（升級）', '身體護理', 0, 200, 150, 150, 0],
  ['A08', '養生燉湯甜品', '附餐茶點', 0, 150, 120, 100, 0],
  ['A09', '龜苓膏', '附餐茶點', 0, 120, 100, 80, 0],
  ['A10', '浴衣使用', '用品', 0, 100, 0, 0, 0]
];
addonDefs.forEach((a, i) => db.prepare(`INSERT INTO addons(code,name,category,minutes,list_price,price,
  member_price,requires_therapist,seq) VALUES(?,?,?,?,?,?,?,?,?)`).run(...a, i));
const addons = db.prepare('SELECT * FROM addons WHERE active = 1').all();

// ---- 商品 ----
const productDefs = [
  ['P001', '舒緩複方精油 30ml', '精油', 1280, 520], ['P002', '薰衣草純露 100ml', '保養品', 680, 260],
  ['P003', '肩頸熱敷袋', '按摩用品', 880, 340], ['P004', '足部去角質霜', '保養品', 580, 210],
  ['P005', '筋膜按摩球組', '按摩用品', 780, 290], ['P006', '薑黃保健錠 60 錠', '保健食品', 1180, 480],
  ['P007', '護頸支撐枕', '按摩用品', 1480, 620], ['P008', '禮券 1000 元', '禮券', 1000, 0]
];
// 商品建檔時庫存是 0，庫存靠「進貨」進來 —— 跟真實流程一樣，
// 也讓一致性測試的「庫存 = 流水加總」從第一天就是對的。
const products = productDefs.map(p => db.prepare(`INSERT INTO retail_products(sku,name,category,price,cost,stock,safety_stock)
  VALUES(?,?,?,?,?,0,?)`).run(p[0], p[1], p[2], p[3], p[4], 5).lastInsertRowid);

// 期初進貨：每樣商品進一批，成本用主檔的 cost（進貨會把它加權平均回同一個數字）。
// 日期往前推，讓 60 天的鐘單有貨可賣。
for (const pid of products) {
  const prod = db.prepare('SELECT * FROM retail_products WHERE id = ?').get(pid);
  inventory.purchase({
    storeId: stores[0], vendor: pick(['美研生技', '芳療小舖', '康健貿易']),
    items: [{ product_id: pid, qty: rnd(20, 60), unit_cost: prod.cost }],
    note: '開店期初進貨', actor: '示範資料'
  });
}

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
    // 輪次要記在**營業日**那張班上，不是迴圈的這一天。
    // 24 小時店有兩成的單落在凌晨 0~3 點，那些單的營業日是前一天 ——
    // 記錯的話，技師的輪次會比他當天實際上過的鐘還多，
    // 而「輪次對不上鐘數」正是輪鐘制最不能出錯的地方。
    const roundsMap = {};    // key: `${營業日}|${技師 id}`
    // 同一位技師／同一個床位不能同時段有兩張單 —— 正式流程的閘門會擋，
    // 示範資料若隨機撞在一起，一致性測試就會抓到「重疊卻沒有放行理由」。
    const busyMap = { th: {}, room: {} };
    const free = (kind, id, s0, e0, cap = 1) => {
      const list = (busyMap[kind][id] = busyMap[kind][id] || []);
      if (list.filter(([a, b2]) => s0 < b2 && a < e0).length >= cap) return false;
      list.push([s0, e0]);
      return true;
    };

    for (let k = 0; k < count; k++) {
      // 套票占比低一點：實際店裡多數還是單項
      const svc = chance(0.12) ? pick(serviceRows.filter(x => x.is_package))
        : pick(serviceRows.filter(x => !x.is_package));
      const th = pick(shuffled);
      const member = chance(0.78) ? pick(memberRows.filter(m => m.store_id === storeId)) : null;
      // 指名率：紅牌高、見習低。這個差異正是輪鐘制要處理的問題。
      const designateRate = { 首席: 0.62, 資深: 0.42, 一般: 0.22, 見習: 0.08 }[th.level] || 0.2;
      const designated = member && (chance(designateRate) || (member.fav_therapist_id === th.id && chance(0.7)));
      // 找一個技師與床位都空著的時段，找不到就跳過這一筆（示範資料不必湊滿）
      let start = null, room = null, startMin = 0, endMin = 0;
      const store24 = storeId === stores[0];    // 中山館 24 小時，會有凌晨的班
      for (let tries = 0; tries < 12; tries++) {
        // 24 小時店：兩成的單落在凌晨（營業日仍算前一天，正好驗證 bizDate）
        const hour = store24 && chance(0.2) ? rnd(0, 3) : rnd(11, 22);
        const min = Number(pick(['00', '15', '30', '45']));
        // 多留 30 分鐘：下面有機率加鐘 30 分，會把結束時間往後推。
        // 不預留的話，加鐘後就可能撞到自己的下一張單。
        const s0 = hour * 60 + min, e0 = s0 + svc.minutes + 30;
        const r0 = pick(storeRooms);
        if (!free('th', th.id, s0, e0)) continue;
        if (!free('room', r0.id, s0, e0, r0.capacity)) {
          // 技師時段已經佔用了，要還回去，否則這位技師會平白少一個空檔
          busyMap.th[th.id].pop();
          continue;
        }
        start = `${date} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        room = r0; startMin = s0; endMin = e0;
        break;
      }
      if (!start) continue;
      const fee = designated ? 100 : 0;
      const discount = chance(0.15) ? pick([100, 200, 300]) : 0;

      // 三層定價：會員自動帶會員價，散客現場價，牌價只當折扣率的分母
      const pr = pricing.priceOf(svc, { memberId: member?.id });
      // 營業日：凌晨的單算前一天，跟正式流程用同一個函數
      const biz = bizDate(start);
      const no = nextSerial('T', biz);
      // 今天有三成的單留成「已預約」（還沒上鐘），讓輪鐘檯與看板上有東西可看。
      const status = d === 0 && chance(0.3) ? 'booked' : 'done';
      // 已預約的單**還沒發生**，所以不能有實際開始／結束時間。
      // 填了會出事：這種單日後被結帳時，actual_end 是「現在」，
      // 而 actual_start 是預約的未來時段 —— 結束時間比開始時間還早。
      const actualStart = status === 'done' ? start : '';
      const actualEnd = status === 'done' ? addMinutes(start, svc.minutes) : '';
      const id = db.prepare(`INSERT INTO tickets(ticket_no,store_id,member_id,guest_name,pax,therapist_id,room_id,
        service_id,service_name,minutes,start_at,end_at,biz_date,actual_start,actual_end,assign_type,designate_fee,
        status,source,amount,list_amount,price_tier,retail_amount,discount,net_amount,created_by)
        VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,'系統')`)
        .run(no, storeId, member?.id || null, member ? '' : '現場客',
          th.id, room.id, svc.id, svc.name, svc.minutes, start, addMinutes(start, svc.minutes), biz,
          actualStart, actualEnd,
          designated ? 'designated' : 'rotation', fee,
          status,
          pick(['現場', '電話', 'LINE', '官網', '回頭客', '團購平台']),
          pr.price, pr.list, pr.tier, discount, Math.max(0, pr.price + fee - discount)).lastInsertRowid;

      // 商品加購。出庫寫在「加商品的當下」，不是結帳時 ——
      // 正式流程就是這樣（賣出去的東西當場離開架上，之後取消才回沖），
      // 兩邊不一致的話，未結帳的單就會出現「賣了卻沒出庫」。
      const sellOut = (refId, qty) => {
        const doSell = () => inventory.sell({ productId: refId, storeId, qty, ticketId: id,
          note: `${no} 銷售`, actor: '示範資料' });
        try { doSell(); }
        catch {
          // 庫存不足就補一批再賣：示範資料橫跨 60 天，期初那批一定會被賣光，
          // 而「賣不出去」在示範資料裡是假象，不是真的缺貨。
          const prod = db.prepare('SELECT * FROM retail_products WHERE id = ?').get(refId);
          inventory.purchase({ storeId, vendor: '美研生技',
            items: [{ product_id: refId, qty: 30, unit_cost: prod.cost }], note: '補貨', actor: '示範資料' });
          doSell();
        }
      };
      let retail = 0;
      if (chance(0.16)) {
        const p = db.prepare('SELECT * FROM retail_products WHERE id = ?').get(pick(products));
        const qty = 1;
        db.prepare(`INSERT INTO ticket_items(ticket_id,kind,ref_id,name,qty,unit_price,list_price,amount,therapist_id)
          VALUES(?,'retail',?,?,?,?,?,?,?)`).run(id, p.id, p.name, qty, p.price, p.price * qty, p.price * qty, th.id);
        sellOut(p.id, qty);
        retail = p.price * qty;
      }
      // 加購：走主檔，品名與價格才會一致（月底才統計得出「刮痧賣了幾次」）
      if (chance(0.22)) {
        const a = pick(addons);
        const ap = pricing.addonPriceOf(a, { memberId: member?.id });
        db.prepare(`INSERT INTO ticket_items(ticket_id,kind,ref_id,name,minutes,qty,unit_price,list_price,amount,therapist_id)
          VALUES(?,'addon',?,?,?,1,?,?,?,?)`)
          .run(id, a.id, a.name, a.minutes, ap.price, ap.list, ap.price, a.requires_therapist ? th.id : null);
      }

      // 重算金額（跟正式流程用同一套邏輯：主項＋明細）
      const items = db.prepare('SELECT * FROM ticket_items WHERE ticket_id = ?').all(id);
      const addService = items.filter(i => i.kind !== 'retail').reduce((s, i) => s + i.amount, 0);
      const addMin = items.filter(i => i.kind !== 'retail').reduce((s, i) => s + i.minutes, 0);
      const addList = items.filter(i => i.kind !== 'retail').reduce((s2, i) => s2 + (i.list_price || i.amount), 0);
      const amount = pr.price + addService;
      const net = Math.max(0, amount + retail + fee - discount);
      db.prepare(`UPDATE tickets SET amount=?, list_amount=?, retail_amount=?, net_amount=?, minutes=?, end_at=?, actual_end=? WHERE id=?`)
        .run(amount, pr.list + addList, retail, net, svc.minutes + addMin,
          addMinutes(start, svc.minutes + addMin), addMinutes(start, svc.minutes + addMin), id);

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
        // 集點：跟結帳流程一樣，只認服務消費
        try { loyalty.earnForTicket({ ticketId: id, actor: '示範資料' }); } catch { /* 忽略 */ }
      }

      // 輪序軌跡：指名不計輪次（跟系統預設一致）。
      //
      // **只有真的上過鐘的單才吃輪次**。還停在「已預約」的單還沒上鐘，
      // 正式流程要等 /tickets/:id/start 才會 consume ——
      // 這裡先算掉的話，那張單日後被上鐘時會再吃一次，輪次就多出來，
      // 而一致性測試的「輪次不超過鐘數」會抓到它。
      if (status === 'done') {
        const key = `${biz}|${th.id}`;
        const before = roundsMap[key] || 0;
        const after = designated ? before : before + 1;
        roundsMap[key] = after;
        rotation.log({ work_date: biz, store_id: storeId, therapist_id: th.id, therapist_name: th.name,
          event: designated ? 'designate' : 'assign', ticket_id: id,
          seq_after: seqMap[th.id], rounds_before: before, rounds_after: after,
          reason: designated ? '指名不計輪次' : '計入輪次', actor: '系統' });
      }
      ticketCount++;
    }
    for (const [key, r] of Object.entries(roundsMap)) {
      const [bizDay, tid] = key.split('|');
      // 凌晨的單會落在前一個營業日，那張班是上一輪迴圈建的 ——
      // 所以是「加上去」而不是覆蓋，否則會把前一天已經算好的輪次蓋掉。
      db.prepare('UPDATE shifts SET rounds = rounds + ? WHERE work_date = ? AND therapist_id = ?')
        .run(r, bizDay, tid);
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

// ---- 團購券 ----
// 平台先收錢、抽兩成、月結才撥款 —— 所以要有「已核銷但還沒入帳」的券，
// 對帳頁才看得出「平台還欠我多少」。
console.log('建立團購券…');
const voucherPlans = [
  ['Klook', '2026秋季腳底方案', 'F60', 999, 20],
  ['Klook', '2026秋季全身方案', 'M90', 1499, 20],
  ['GOMAJI', '型男舒壓 4.1 折', 'M60', 1100, 25],
  ['KKday', '感謝祭 70 分足湯', 'W50', 1140, 18]
];
let vSeq = 1;
for (const [platform, batch, code, face, pct] of voucherPlans) {
  const svc = svcByCode(code);
  for (let i = 0; i < 25; i++) {
    const v = V.create({
      platform, code: `${platform.slice(0, 2).toUpperCase()}${String(Date.now()).slice(-5)}${String(vSeq++).padStart(4, '0')}`,
      batch, service_id: svc.id, title: `${svc.name}（${batch}）`,
      face_value: face, commission_pct: pct,
      issued_date: shiftDate(today(), -rnd(10, 90)),
      expiry_date: shiftDate(today(), rnd(-15, 180)),
      store_id: pick(stores)
    }, '系統');
    // 六成已被客人拿來用掉，其中一半已經月結入帳
    if (chance(0.6)) {
      // 只掛在「本來就是收現金」的單上，券折抵多少就從現金扣多少 ——
      // 否則會算出負數的現金收款，一致性測試會立刻抓到。
      const t = db.prepare(`SELECT id, paid_cash FROM tickets WHERE service_id = ? AND status = 'done'
                            AND paid_cash > 0 AND paid_voucher = 0
                            ORDER BY RANDOM() LIMIT 1`).get(svc.id);
      db.prepare(`UPDATE vouchers SET status = 'used', ticket_id = ?, used_at = ? WHERE id = ?`)
        .run(t?.id || null, shiftDate(today(), -rnd(1, 60)) + ' 15:00', v.id);
      if (t) {
        const useAmt = Math.min(face, t.paid_cash);
        db.prepare(`UPDATE tickets SET paid_voucher = ?, paid_cash = paid_cash - ?, pay_method = '團購券'
                    WHERE id = ?`).run(useAmt, useAmt, t.id);
      }
      if (chance(0.5)) {
        db.prepare(`UPDATE vouchers SET status = 'settled', settled_at = ? WHERE id = ?`)
          .run(shiftDate(today(), -rnd(1, 30)), v.id);
      }
    }
  }
}
V.expireOld();

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

// ---- 班表 ----
// 從上週一排到下週日：過去的幾天可以跟實際簽到對照，未來的幾天是店長真的在用的東西。
console.log('產生班表…');
{
  const mon = (() => {
    const d = new Date(today() + 'T00:00:00Z');
    return shiftDate(today(), -((d.getUTCDay() + 6) % 7));
  })();
  const codes = ['早班', '早班', '中班', '晚班', '晚班', '休假'];
  let cells = 0;
  for (let i = -7; i < 14; i++) {
    const d = shiftDate(mon, i);
    for (const th of therapistRows) {
      // 每人每週固定休一天（用技師 id 錯開，不會全店同一天休光）
      const wd = (i % 7 + 7) % 7;
      const code = wd === (th.id % 7) ? '休假' : pick(codes.slice(0, 5));
      roster.set({ workDate: d, therapistId: th.id, shiftCode: code, storeId: th.store_id, actor: '示範資料' });
      cells++;
    }
  }
  console.log(`  班表 ${cells} 格`);
}

// ---- 進退貨、盤點、調撥 ----
console.log('產生庫存異動…');
{
  // 補幾次進貨（有進有出，流水才看得出商品怎麼動的）
  for (let i = 0; i < 6; i++) {
    const pid = pick(products);
    const prod = db.prepare('SELECT * FROM retail_products WHERE id = ?').get(pid);
    inventory.purchase({ storeId: pick(stores), vendor: pick(['美研生技', '芳療小舖', '康健貿易']),
      items: [{ product_id: pid, qty: rnd(6, 24), unit_cost: Math.round(prod.cost * (0.9 + Math.random() * 0.25)) }],
      note: '補貨', actor: '示範資料' });
  }
  // 一次調撥
  const tp = pick(products);
  if (inventory.storeStock(tp, stores[0]) >= 3) {
    inventory.transfer({ productId: tp, fromStoreId: stores[0], toStoreId: stores[1], qty: 2,
      note: '信義館缺貨', actor: '示範資料' });
  }
  // 一次盤點（刻意留一筆盤虧，讓「盤點損益」那個數字不是 0）
  const cp = pick(products);
  const book = inventory.stockOf(cp);
  if (book > 1) {
    inventory.stocktake({ items: [{ product_id: cp, counted: book - 1 }],
      reason: '月底盤點，一件外盒破損報廢', actor: '示範資料' });
  }
}

// ---- 發票 ----
console.log('登錄發票…');
{
  setSetting('invoice_track', 'AB');
  setSetting('invoice_next_no', '10000001');
  const done = db.prepare(`SELECT id FROM tickets WHERE status = 'done' AND net_amount > 0
    ORDER BY biz_date DESC LIMIT 60`).all();
  let n = 0, voided = 0, allowed = 0;
  for (const t of done) {
    try {
      const inv = invoicing.issueForTicket({ ticketId: t.id, actor: '示範資料' });
      n++;
      // 少數幾張示範作廢與折讓，讓這兩個狀態在畫面上看得到
      if (chance(0.05)) { invoicing.voidInvoice({ id: inv.id, reason: '買受人統編填錯，重開', actor: '示範資料' }); voided++; }
      else if (chance(0.06)) {
        invoicing.allowance({ id: inv.id, amount: Math.min(200, Math.round(inv.amount * 0.1)),
          reason: '客訴補償部分退款', actor: '示範資料' });
        allowed++;
      }
    } catch { /* 已開過或號碼衝突就跳過 */ }
  }
  console.log(`  發票 ${n} 張（作廢 ${voided}、折讓 ${allowed}）`);
}

// ---- 介紹人與點數兌換 ----
console.log('產生介紹關係與點數…');
{
  let refs = 0;
  for (const m of memberRows) {
    if (!chance(0.22)) continue;
    const other = pick(memberRows);
    if (other.id === m.id) continue;
    db.prepare('UPDATE members SET referrer_id = ? WHERE id = ?').run(other.id, m.id);
    refs++;
  }
  // 幾位客人拿點數換贈送金
  let redeemed = 0;
  for (const m of db.prepare('SELECT * FROM members WHERE points >= 150 ORDER BY points DESC LIMIT 8').all()) {
    try { loyalty.redeem({ memberId: m.id, points: 100, actor: '示範資料' }); redeemed++; } catch { /* 未達門檻 */ }
  }
  console.log(`  介紹關係 ${refs} 筆，兌換 ${redeemed} 筆`);
}

// ---- 同意書 ----
console.log('產生同意書…');
{
  // 產生一張真的 PNG 當簽名圖（storage 會驗檔頭與指紋，隨便塞 base64 會被擋下來）
  const zlib = require('zlib');
  const png = (() => {
    const chunk = (type, data) => {
      const c = Buffer.concat([Buffer.from(type), data]);
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(require('zlib').crc32
        ? require('zlib').crc32(c) >>> 0 : crc32(c) >>> 0);
      return Buffer.concat([len, c, crcBuf]);
    };
    // 自己算 CRC32（Node 的 zlib 不一定有 crc32）
    function crc32(buf) {
      let c, crc = 0xFFFFFFFF;
      for (let i = 0; i < buf.length; i++) {
        c = (crc ^ buf[i]) & 0xFF;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crc = c ^ (crc >>> 8);
      }
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    const W = 120, H = 40;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const rows = [];
    for (let y = 0; y < H; y++) {
      const row = Buffer.alloc(1 + W * 3, 0xFF);
      row[0] = 0;
      // 畫一條斜的「簽名」筆跡
      const x = Math.floor((y / H) * (W - 10)) + 4;
      for (let d = -1; d <= 1; d++) {
        const i = 1 + (x + d) * 3;
        if (i > 0 && i + 2 < row.length) { row[i] = 0x22; row[i + 1] = 0x22; row[i + 2] = 0x22; }
      }
      rows.push(row);
    }
    const idat = zlib.deflateSync(Buffer.concat(rows));
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
    ]);
  })();
  const dataUrl = 'data:image/png;base64,' + png.toString('base64');
  let signed = 0;
  // 常來的客人才簽（法遵頁的重點就是「來過卻沒簽的人」，所以刻意留一些沒簽的）
  const frequent = db.prepare(`SELECT m.* FROM members m
    WHERE (SELECT COUNT(*) FROM tickets t WHERE t.member_id = m.id AND t.status='done') >= 3
    ORDER BY m.id LIMIT 40`).all();
  for (const m of frequent) {
    if (!chance(0.7)) continue;
    try { consent.sign({ memberId: m.id, signature: dataUrl, signerName: m.name, actor: '示範資料' }); signed++; }
    catch (e) { console.log('  同意書失敗：', e.message); break; }
  }
  console.log(`  同意書 ${signed} 份`);
}

// ---- 日結 ----
// 最近幾天的日結，其中一天刻意短少，讓「短溢」欄位不是一片 0。
console.log('產生日結紀錄…');
{
  let n = 0;
  for (let i = 7; i >= 1; i--) {
    const d = shiftDate(today(), -i);
    for (const st of stores) {
      const c = closing.compute({ storeId: st, bizDate: d });
      if (!c.tickets) continue;
      // 大部分剛好，偶爾差幾十塊（硬幣本來就會差）
      const diff = chance(0.25) ? pick([-100, -50, -20, 20, 50]) : 0;
      const counted = Math.max(0, c.expected_cash + diff);
      // 用面額湊出實點金額，點鈔明細才不是空的
      const denom = {};
      let left = counted;
      for (const d2 of closing.DENOMS) {
        const k = Math.floor(left / d2);
        if (k > 0) { denom[d2] = k; left -= k * d2; }
      }
      try {
        closing.create({ store_id: st, biz_date: d, shift_label: '全日', denom,
          handover_to: pick(['櫃檯小美', '店長', '夜班阿華']),
          note: diff ? pick(['找零時多找了，已於交接說明', '零錢箱硬幣短少', '客人多付未察覺']) : '',
          actor: '示範資料' });
        n++;
      } catch { /* 已結過或差額超標就跳過 */ }
    }
  }
  console.log(`  日結 ${n} 張`);
}

setSetting('ui_demo_hint', '示範帳號：admin / admin123（管理員）\n店長 manager / 123456　櫃檯 front / 123456　會計 acct / 123456（唯讀）');

// ---- 示範帳號 ----
const demoUsers = [
  ['manager', '王store長', '店長', ['dashboard', 'queue', 'board', 'tickets', 'bookings', 'issues', 'members',
    'wallets', 'passes', 'repurchase', 'therapists', 'rooms', 'services', 'retail', 'payroll', 'commission',
    'attendance', 'finance', 'liability', 'expenses', 'compliance', 'expiry', 'notifications',
    'closing', 'roster', 'purchase', 'loyalty', 'invoices'], []],
  ['front', '櫃檯小美', '櫃檯', ['dashboard', 'queue', 'board', 'tickets', 'bookings', 'members', 'wallets',
    'passes', 'repurchase', 'notifications', 'closing', 'loyalty'], []],
  ['acct', '會計小陳', '會計', ['finance', 'liability', 'expenses', 'tax', 'payroll', 'tickets', 'wallets', 'passes',
    'invoices', 'closing', 'purchase'],
    ['tickets', 'wallets', 'passes', 'payroll', 'closing', 'purchase']]
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
  預收負債: prepaid.liability().total_cash_liability,
  庫存流水: db.prepare('SELECT COUNT(*) n FROM stock_txns').get().n,
  班表: db.prepare('SELECT COUNT(*) n FROM rosters').get().n,
  日結: db.prepare('SELECT COUNT(*) n FROM closings').get().n,
  發票: db.prepare('SELECT COUNT(*) n FROM invoices').get().n,
  同意書: db.prepare('SELECT COUNT(*) n FROM consents').get().n,
  點數流水: db.prepare('SELECT COUNT(*) n FROM point_txns').get().n
};
console.log('示範資料建立完成：', summary);
