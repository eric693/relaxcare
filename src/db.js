// 時區固定台北：主機時區是 UTC，若不指定，SQLite 的 datetime('now','localtime')
// 與 Node 的 new Date() 都會慢 8 小時 —— 深夜到凌晨的鐘單（按摩店最忙的時段之一）
// 會被記成前一天，當日輪鐘、日結、抽成全部錯一天。
// 這行必須在 require('better-sqlite3') 之前，SQLite 的 localtime 是啟動時讀 TZ 決定的。
process.env.TZ = process.env.TZ || 'Asia/Taipei';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'relaxcare.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));

// 既有資料庫的欄位遷移（日後新增欄位補在這裡，新裝直接走 schema.sql）
function ensureColumns(table, cols) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const [name, ddl] of Object.entries(cols)) {
    if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

// ---- 24 小時營業與營業日 ----
//
// 森 SPA 的中山館、不老松的新生行館都是 24 小時營業，松江館是 09:00~03:00。
// 這件事會把三個地方弄壞：排鐘看板的時間軸畫不出跨午夜的班、日結把凌晨的鐘算成隔天、
// 技師的當日輪次在午夜歸零。
//
// 解法是引進「營業日」：凌晨 04:00（可設定）之前的單，仍算前一天的營業日。
// tickets.biz_date 在開單時就算好存起來 —— 統計一律用它，不再從時間字串截前 10 碼。
ensureColumns('tickets', {
  biz_date: "TEXT NOT NULL DEFAULT ''"
});
// 舊資料補算一次：沒有 biz_date 的單先用實際開始時間的日期填上
db.prepare(`UPDATE tickets SET biz_date = substr(COALESCE(NULLIF(actual_start,''), start_at),1,10)
            WHERE biz_date = ''`).run();
db.exec('CREATE INDEX IF NOT EXISTS idx_ticket_bizdate ON tickets(biz_date)');

// ---- 三層定價 ----
// 兩家實際店家都是這樣標價：牌價 2400 → 現場價 1980 → 會員價再低一點。
// 只存一個 price 的話，「打折了多少」這件事就永遠算不出來，
// 而那正是老闆最想知道的數字（實收 ÷ 牌價 = 折扣率）。
ensureColumns('services', {
  list_price: 'REAL NOT NULL DEFAULT 0',      // 牌價（原價）
  member_price: 'REAL NOT NULL DEFAULT 0',    // 會員價（0＝同現場價）
  is_package: 'INTEGER NOT NULL DEFAULT 0',   // 是不是組合套票
  package_items: "TEXT NOT NULL DEFAULT ''"   // 套票內容（服務 id 以逗號分隔）
});
// 沒填牌價的沿用現場價，這樣折扣率的分母不會是 0
db.prepare('UPDATE services SET list_price = price WHERE list_price = 0').run();

ensureColumns('ticket_items', {
  list_price: 'REAL NOT NULL DEFAULT 0'       // 這一項照牌價要多少（算折扣率用）
});

ensureColumns('tickets', {
  // 這張單套用了哪一層價：list 牌價／walkin 現場價／member 會員價／package 套票／voucher 團購券
  price_tier: "TEXT NOT NULL DEFAULT 'walkin'",
  list_amount: 'REAL NOT NULL DEFAULT 0',     // 同樣的服務照牌價要多少（算折扣率用）
  paid_voucher: 'REAL NOT NULL DEFAULT 0'     // 團購券折抵金額
});

// ---- 集點與介紹人 ----
// points 是快取，point_txns 才是真相（跟儲值金同一套規矩）。
ensureColumns('members', {
  points: 'INTEGER NOT NULL DEFAULT 0',
  referrer_id: 'INTEGER',                       // 誰介紹來的
  referral_paid: 'INTEGER NOT NULL DEFAULT 0',  // 介紹獎勵發過了沒（只在首次消費發一次）
  photo_id: 'INTEGER'                           // 大頭照（attachments.id）
});

// ---- 商品成本 ----
// 進貨會用加權平均更新 cost，這裡記最後一次進貨的單價與日期，讓「成本怎麼變成這樣」查得到。
ensureColumns('retail_products', {
  last_cost: 'REAL NOT NULL DEFAULT 0',
  last_purchase_date: "TEXT NOT NULL DEFAULT ''"
});

// ---- 次卡的收款方式 ----
// 日結要算「進抽屜的現金」，售卡是其中一塊；沒有這個欄位就分不出這張卡是收現還是刷卡。
ensureColumns('passes', {
  pay_method: "TEXT NOT NULL DEFAULT ''"
});

// ---- 鐘單開立的發票 ----
ensureColumns('tickets', {
  invoice_id: 'INTEGER'
});

// ---- JWT 密鑰 ----
let SECRET = process.env.JWT_SECRET || '';
if (!SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('未設定 JWT_SECRET，正式環境拒絕啟動。請在 .env 加上一組隨機字串。');
    process.exit(1);
  }
  const f = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(f)) SECRET = fs.readFileSync(f, 'utf8').trim();
  else { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}

// ---- 設定 ----

function getSetting(key, fallback = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value ?? ''));
}
function setSettingDefault(key, value) {
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(key, String(value));
}
function num(key, fallback = 0) {
  const v = Number(getSetting(key, ''));
  return Number.isFinite(v) && getSetting(key, '') !== '' ? v : fallback;
}

const UI_TEXT_KEYS = ['ui_login_title', 'ui_login_sub', 'ui_demo_hint'];

// 下拉選項類的設定，值是用換行分隔的清單
const LIST_KEYS = {
  service_categories: '全身按摩\n腳底按摩\n指壓推拿\n精油SPA\n頭部肩頸\n刮痧拔罐\n熱石\n孕婦按摩\n其他',
  room_types: '單人床\n雙人房\nVIP包廂\n足療區\n沖澡間',
  therapist_levels: '見習\n一般\n資深\n首席',
  employ_types: '全職\n兼職\n承攬',
  pressure_prefs: '輕\n中\n重',
  // 客人健康狀況。服務項目可以指定哪幾項是禁忌，上鐘前系統會擋。
  health_conditions: '懷孕\n產後未滿六週\n高血壓\n心臟病\n糖尿病\n骨質疏鬆\n近期手術\n開放性傷口\n急性發炎\n皮膚病\n血栓病史\n癌症治療中\n服用抗凝血劑\n植入心律調節器\n酒後',
  avoid_part_options: '頸椎\n腰椎\n膝蓋\n肩關節\n腹部\n頭部\n腳踝\n手術部位',
  member_sources: '路過\n朋友介紹\nGoogle\nFacebook\nInstagram\nLINE\n團購平台\n公司特約',
  member_tags: 'VIP\n高消費\n只做指名\n對精油過敏\n不喜歡聊天\n需要安靜\n常遲到\n奧客注意',
  ticket_sources: '現場\n電話\nLINE\n官網\n回頭客\n團購平台',
  pay_methods: '現金\n刷卡\nLINE Pay\n街口\n悠遊卡\n匯款\n儲值扣款\n次卡核銷\n團購券',
  addon_categories: '加購療程\n身體護理\n足部護理\n附餐茶點\n用品',
  retail_categories: '保養品\n精油\n按摩用品\n保健食品\n禮券\n其他',
  expense_categories: '房租\n水電\n用品耗材\n洗滌\n行銷廣告\n設備維修\n勞健保\n雜支',
  issue_categories: '客訴\n技師糾紛\n設備故障\n預約疏失\n收費爭議\n衛生問題\n其他',
  vendor_categories: '用品\n洗滌\n設備\n耗材\n其他'
};

function seedDefaults() {
  setSettingDefault('company_name', 'RelaxCare 舒壓會館');
  setSettingDefault('ui_login_title', 'RelaxCare');
  setSettingDefault('ui_login_sub', '按摩／SPA 連鎖營運管理系統');
  setSettingDefault('audit_retention_days', '730');
  setSettingDefault('notify_retention_days', '180');

  // ---- 輪鐘 ----
  // 指名要不要吃掉輪序：多數店家的規矩是「被指名不算輪到」，
  // 也就是指名做完回來還是排原本的位置 —— 不然紅牌會被指名指到沒有輪鐘可接。
  setSettingDefault('rotation_designate_counts', '0');
  // 技師下鐘後最少要休息幾分鐘才會重新進入輪序（喝水、換床單）
  setSettingDefault('rotation_rest_min', '10');
  // 每日單一技師的服務時數上限（分鐘），超過會警告
  setSettingDefault('daily_minutes_max', '480');
  // 連續上鐘幾次沒休息就警告
  setSettingDefault('continuous_tickets_max', '4');

  // ---- 指名費與抽成預設（依級別，格式：級別=輪鐘%|指名%|商品%|指名費）----
  setSettingDefault('level_rates',
    '見習=35|40|10|0\n一般=40|45|10|50\n資深=45|50|12|100\n首席=50|55|15|150');
  // 向客人加收的指名費（0＝不加收，只影響技師分潤）
  setSettingDefault('designate_fee_charge', '100');

  // ---- 預收 ----
  setSettingDefault('wallet_bonus_expire_months', '12');   // 贈送金效期（月），0＝不到期
  setSettingDefault('pass_default_months', '12');          // 次卡預設效期（月）
  // 儲值退款手續費％（贈送金一律不退，這裡是對「未使用現金部位」收的）
  setSettingDefault('wallet_refund_fee_pct', '0');
  // 銷售儲值／次卡的抽成％（先收錢的業績，通常抽得比服務低）
  setSettingDefault('prepaid_commission_pct', '5');

  // ---- 營業日 ----
  // 24 小時營業的店，凌晨的客人算「前一天」的生意。這個時間點之前開的單歸前一營業日。
  // 設 '00:00' 就是不做營業日換算（一般日班店家）。
  setSettingDefault('business_day_start', '04:00');
  // 排鐘看板要畫幾個小時。24 小時店設 24，一般店可設 14~16 讓格子寬一點。
  setSettingDefault('board_hours', '24');

  // ---- 定價 ----
  // 會員價要不要自動帶：客人是會員時開單自動套用會員價
  setSettingDefault('auto_member_price', '1');
  // 團購券平台
  setSettingDefault('voucher_platforms', 'Klook\nGOMAJI\nKKday\n蝦皮\n團購\n其他');
  // 平台預設抽成％（建券時帶入，可逐張改）
  setSettingDefault('voucher_commission_pct', '20');

  // ---- 營運 ----
  setSettingDefault('vat_rate', '5');
  setSettingDefault('slot_min', '15');                     // 看板時間軸的一格分鐘數
  setSettingDefault('repurchase_days', '30');              // 幾天沒來就進回購名單
  setSettingDefault('expiry_warn_days', '45');             // 證照／健檢到期提前提醒
  setSettingDefault('line_token', '');
  setSettingDefault('booking_enabled', '1');
  setSettingDefault('booking_notice', '線上預約送出後為「預約申請」，門市確認技師與時段後才成立。');

  // ---- 法遵：民俗調理業用語 ----
  // 民俗調理業（按摩、推拿、腳底按摩）不得涉及醫療行為，也不得宣稱療效。
  // 系統不會自動改文案，但會把踩線的字詞找出來給你看 —— 廣告文案被檢舉是實際會發生的事。
  setSettingDefault('banned_terms',
    '治療\n療效\n醫療\n診斷\n復健\n矯正\n根治\n痊癒\n藥效\n消炎\n止痛\n療程（改稱「服務」）\n整脊\n正骨\n推血路\n打通經絡\n排毒\n瘦身\n減肥\n豐胸\n療癒疾病');
  setSettingDefault('compliance_note',
    '民俗調理業不得從事醫療行為、不得宣稱醫療效能。文案請改用「舒緩」「放鬆」「舒壓」「調理」等描述。');

  // ---- 日結與交班 ----
  // 抽屜起始零用金（找零用）。日結的「應有現金」從這個數字開始加。
  setSettingDefault('cash_open_float', '3000');
  // 短溢容忍值：差額在這個金額以內只是提醒，超過要填說明。
  // 設 0 會讓每天都在填說明（硬幣本來就會差幾塊），設太大等於沒在管。
  setSettingDefault('cash_diff_tolerance', '50');
  setSettingDefault('closing_shifts', '早班\n晚班\n全日');
  // 哪些付款方式算「進抽屜的現金」。刷卡與行動支付不進抽屜，要跟收單機各自對。
  setSettingDefault('cash_pay_methods', '現金');
  setSettingDefault('card_pay_methods', '刷卡\nLINE Pay\n街口\n悠遊卡');

  // ---- 收據 ----
  setSettingDefault('receipt_footer', '謝謝光臨，祝您身心舒暢。\n本店為民俗調理業，服務內容不涉及醫療行為。');
  setSettingDefault('receipt_show_therapist', '1');

  // ---- 發票 ----
  setSettingDefault('invoice_enabled', '1');
  setSettingDefault('invoice_track', '');                  // 本期字軌，例如 AB
  setSettingDefault('invoice_next_no', '');                // 下一個號碼（8 碼），留空＝手動輸入

  // ---- 班表 ----
  // 班別代碼與預設時間（格式：代碼=開始|結束）。「休假」不填時間。
  setSettingDefault('roster_shifts', '早班=10:00|19:00\n中班=14:00|23:00\n晚班=16:00|01:00\n休假=|\n特休=|\n請假=|');

  // ---- 集點與介紹 ----
  setSettingDefault('points_enabled', '1');
  // 消費多少元累 1 點。設 100 就是「每消費 100 元 1 點」。
  setSettingDefault('points_per_amount', '100');
  // 1 點可兌換多少元的儲值贈送金
  setSettingDefault('point_redeem_value', '1');
  // 兌換門檻：低於這個點數不給換（避免每次來換 3 點，櫃檯做白工）
  setSettingDefault('point_redeem_min', '100');
  // 介紹人獎勵點數（被介紹的新客第一次消費完成時發給介紹人）
  setSettingDefault('referral_points', '200');
  // 點數只認服務消費、不含商品與預收：跟級距獎金同一個道理，
  // 否則客人買一張大卡就集滿點，等於把預收款又打了一次折。
  setSettingDefault('points_service_only', '1');

  // ---- 同意書 ----
  setSettingDefault('consent_text',
    '一、本人已據實告知自身健康狀況、疾病史與不適部位，並瞭解按摩／推拿等民俗調理服務不具醫療效能，'
    + '亦非醫療行為，不能取代醫師之診斷與治療。\n'
    + '二、服務過程中如感到不適、疼痛或力道過重，本人會立即告知技師調整或停止。\n'
    + '三、本人同意店家為服務安全之目的，保存上述健康資訊與本同意書，並依個人資料保護法使用。');
  // 同意書多久要重簽一次（月）。身體狀況會變，一年前簽的等於沒問。
  setSettingDefault('consent_valid_months', '12');

  for (const [k, v] of Object.entries(LIST_KEYS)) setSettingDefault(k, v);
}
seedDefaults();

function getList(key) {
  return getSetting(key, LIST_KEYS[key] || '').split('\n').map(s => s.trim()).filter(Boolean);
}

// 級別預設抽成表：'一般=40|45|10|50' → { 一般: {normal:40,designated:45,retail:10,fee:50} }
function levelRates() {
  const out = {};
  for (const line of getSetting('level_rates', '').split('\n')) {
    const [lv, rest] = line.split('=');
    if (!lv || !rest) continue;
    const [n, d, r, f] = rest.split('|').map(x => Number(x) || 0);
    out[lv.trim()] = { normal: n, designated: d, retail: r, fee: f };
  }
  return out;
}

// 業績級距獎金：第一次啟動帶一組常見級距，之後使用者改過就不再覆蓋
function seedTiers() {
  if (db.prepare('SELECT COUNT(*) n FROM commission_tiers').get().n) return;
  const ins = db.prepare('INSERT INTO commission_tiers(level,min_amount,max_amount,bonus_pct,label) VALUES(?,?,?,?,?)');
  const tx = db.transaction(rows => rows.forEach(r => ins.run(...r)));
  tx([
    ['', 0, 79999, 0, '未達門檻'],
    ['', 80000, 119999, 2, '月業績 8 萬以上'],
    ['', 120000, 179999, 4, '月業績 12 萬以上'],
    ['', 180000, 0, 6, '月業績 18 萬以上']
  ]);
}
seedTiers();

// ---- 稽核軌跡 ----
function audit(actorType, actorId, actorName, action) {
  db.prepare('INSERT INTO audit_logs(actor_type,actor_id,actor_name,action) VALUES(?,?,?,?)')
    .run(actorType, actorId ?? null, actorName || '', action);
}

// ---- 日期與時間工具 ----
// 全站的「時間點」格式是 'YYYY-MM-DD HH:MM'。固定長度、固定時區，
// 所以字串比大小就等於時間比大小 —— 排鐘重疊、床位衝突都直接用 SQL 比較。

const pad = n => String(n).padStart(2, '0');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function nowStamp() {
  const d = new Date();
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function thisMonth() { return today().slice(0, 7); }

// 'YYYY-MM-DD HH:MM' → 營業日。
// 凌晨 business_day_start 之前算前一天：24 小時店的凌晨兩點是「昨天的夜班」，
// 那一鐘要算給昨天的日結、昨天的輪次、昨天的班表。
function bizDate(stamp) {
  const s = String(stamp || nowStamp());
  const d = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return today();
  const cut = getSetting('business_day_start', '04:00');
  if (!cut || cut === '00:00') return d;
  const hhmm = s.slice(11, 16);
  if (!hhmm) return d;
  return hhmm < cut ? shiftDate(d, -1) : d;
}
// 營業日的起訖時間點（含跨午夜）。看板的時間軸與日結的區間都用這個。
function bizRange(dateStr) {
  const cut = getSetting('business_day_start', '04:00');
  if (!cut || cut === '00:00') return { start: `${dateStr} 00:00`, end: `${shiftDate(dateStr, 1)} 00:00` };
  return { start: `${dateStr} ${cut}`, end: `${shiftDate(dateStr, 1)} ${cut}` };
}

function toMinutes(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) / 60000);
}
function fromMinutes(min) {
  const d = new Date(min * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function addMinutes(stamp, min) { const t = toMinutes(stamp); return t === null ? '' : fromMinutes(t + min); }
function shiftDate(dateStr, days) { const t = toMinutes(dateStr); return t === null ? '' : fromMinutes(t + days * 1440).slice(0, 10); }
// 加幾個月（用來算次卡與贈送金的到期日）。落在不存在的日期（1/31 + 1 月）退到當月最後一天。
function addMonths(dateStr, months) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  let y = +m[1], mo = +m[2] - 1 + Number(months), d = +m[3];
  y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return `${y}-${pad(mo + 1)}-${pad(Math.min(d, last))}`;
}
function dateDiff(a, b) {
  const ta = toMinutes(a), tb = toMinutes(b);
  if (ta === null || tb === null) return null;
  return Math.round((tb - ta) / 1440);
}
function minutesBetween(a, b) {
  const ta = toMinutes(a), tb = toMinutes(b);
  if (ta === null || tb === null) return 0;
  return tb - ta;
}
function fmtDuration(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r} 分鐘`;
  return r ? `${h} 小時 ${r} 分` : `${h} 小時`;
}
function monthRange(period) {
  const p = /^\d{4}-\d{2}$/.test(period || '') ? period : thisMonth();
  const start = p + '-01';
  return { start, end: addMonths(start, 1) };   // end 為次月一日（用 < end 比較）
}
// 兩個區間是否重疊（端點相接不算重疊：11:00 下鐘、11:00 上鐘是接得上的）
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
// 金額一律進位到元，避免抽成％算出 0.333 元這種東西進帳
function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function yuan(n) { return Math.round(Number(n) || 0); }

// ---- 單號 ----
const nextSerial = db.transaction((prefix, dateStr) => {
  const period = (dateStr || today()).slice(2, 7).replace('-', '');   // 'YYMM'
  db.prepare('INSERT OR IGNORE INTO serials(prefix,period,seq) VALUES(?,?,0)').run(prefix, period);
  db.prepare('UPDATE serials SET seq = seq + 1 WHERE prefix = ? AND period = ?').run(prefix, period);
  const { seq } = db.prepare('SELECT seq FROM serials WHERE prefix = ? AND period = ?').get(prefix, period);
  return `${prefix}${period}-${String(seq).padStart(4, '0')}`;
});

module.exports = {
  db, SECRET, ensureColumns,
  getSetting, setSetting, setSettingDefault, num, getList, LIST_KEYS, UI_TEXT_KEYS, levelRates,
  audit, nextSerial,
  today, nowStamp, thisMonth, bizDate, bizRange, toMinutes, fromMinutes, addMinutes, shiftDate, addMonths,
  dateDiff, minutesBetween, fmtDuration, monthRange, overlaps, money, yuan
};
