-- RelaxCare 按摩／SPA／整復連鎖營運管理系統
--
-- 這套系統跟其他行業系統最大的不同在三件事，資料表的形狀也是照這三件事長出來的：
--   1. 輪鐘制：技師依「簽到順序」排隊等客，指名可以跳過輪序。誰該上鐘要有憑有據，
--      所以每一次輪序異動都寫進 queue_logs —— 這張表存在的唯一理由是「技師吵架時拿得出來」。
--   2. 抽成分潤：薪水＝底薪＋鐘點抽成（指名／輪鐘不同％）＋商品抽成＋業績級距獎金＋指名費。
--      抽成必須在「當下」算好寫進單據（tickets/ticket_items），不能到月底才回頭套現在的％，
--      否則調過一次抽成比例，過去的薪資就全部對不起來。
--   3. 預收負債：儲值金與次卡是先收錢後服務，會計上是負債不是收入。
--      現金儲值與贈送金要分開存，因為退款只退現金部分。

PRAGMA foreign_keys = ON;

-- ============ 系統 ============

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',          -- admin / staff
  title TEXT NOT NULL DEFAULT '',
  store_id INTEGER,                            -- 綁定分店（空＝全店）
  permissions TEXT NOT NULL DEFAULT '[]',
  readonly_modules TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL DEFAULT 'staff',
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS serials (
  prefix TEXT NOT NULL,
  period TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, period)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,                   -- member / therapist
  target_id INTEGER,
  target_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'simulated',    -- simulated / sent / failed
  error TEXT NOT NULL DEFAULT '',
  ticket_id INTEGER,
  member_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notify_created ON notifications(created_at DESC);

-- ============ 主檔 ============

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  open_time TEXT NOT NULL DEFAULT '10:00',
  close_time TEXT NOT NULL DEFAULT '23:00',
  -- 跨店使用儲值／次卡時，本店要跟發卡店拆帳的比例（服務店拿走的％）
  cross_store_pct REAL NOT NULL DEFAULT 100,
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS therapists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',                -- 技師編號／花名（客人指名時講的就是這個）
  name TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  line_uid TEXT NOT NULL DEFAULT '',
  store_id INTEGER,
  level TEXT NOT NULL DEFAULT '一般',           -- 級別，決定抽成％與指名費
  hire_date TEXT NOT NULL DEFAULT '',
  leave_date TEXT NOT NULL DEFAULT '',
  employ_type TEXT NOT NULL DEFAULT '全職',      -- 全職／兼職／承攬
  base_salary REAL NOT NULL DEFAULT 0,          -- 底薪（承攬制填 0）
  -- 抽成％：留 0 表示沿用「級別預設」（settings 的 level_rates）
  pct_normal REAL NOT NULL DEFAULT 0,           -- 輪鐘（非指名）抽成％
  pct_designated REAL NOT NULL DEFAULT 0,       -- 指名抽成％
  pct_retail REAL NOT NULL DEFAULT 0,           -- 商品銷售抽成％
  designate_fee REAL NOT NULL DEFAULT 0,        -- 每被指名一次，技師實拿的指名費（0＝用級別預設）
  skills TEXT NOT NULL DEFAULT '',              -- 可做的服務（逗號分隔的服務名稱或分類）
  -- 民俗調理業：技術士證與健康檢查是稽查時會看的東西
  cert_no TEXT NOT NULL DEFAULT '',
  cert_expiry TEXT NOT NULL DEFAULT '',
  health_check_date TEXT NOT NULL DEFAULT '',
  health_check_expiry TEXT NOT NULL DEFAULT '',
  is_blind INTEGER NOT NULL DEFAULT 0,          -- 視障按摩人員（庇護工場／協會補助要統計）
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_therapist_store ON therapists(store_id, active);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER,
  name TEXT NOT NULL,                           -- A1、VIP-2、足療區 3 號
  rtype TEXT NOT NULL DEFAULT '單人床',          -- 單人床／雙人房／VIP包廂／足療區
  capacity INTEGER NOT NULL DEFAULT 1,          -- 同時可容納幾組客人（足療區可 >1）
  seq INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '全身按摩',
  minutes INTEGER NOT NULL DEFAULT 60,
  price REAL NOT NULL DEFAULT 0,
  room_type TEXT NOT NULL DEFAULT '',           -- 需要的房型（空＝不限）
  -- 抽成可逐項覆寫（0＝用技師／級別的預設）。高價療程常常抽得比一般鐘低。
  pct_normal REAL NOT NULL DEFAULT 0,
  pct_designated REAL NOT NULL DEFAULT 0,
  -- 禁忌：勾選了這些狀況的客人不能做這個項目（逗號分隔，對應 settings 的 health_conditions）
  contraindications TEXT NOT NULL DEFAULT '',
  buffer_min INTEGER NOT NULL DEFAULT 0,        -- 做完之後要留的整理時間
  description TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS retail_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '保養品',
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  pct_retail REAL NOT NULL DEFAULT 0,           -- 0＝用技師預設
  stock INTEGER NOT NULL DEFAULT 0,
  safety_stock INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_no TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  line_uid TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  birthday TEXT NOT NULL DEFAULT '',
  store_id INTEGER,                             -- 主要往來門市
  source TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  fav_therapist_id INTEGER,                     -- 慣用指名技師
  -- 客人身體狀況：這是「不要把人做出事」的第一道防線，也是換技師時交接的依據
  pressure_pref TEXT NOT NULL DEFAULT '',       -- 力道偏好：輕／中／重
  avoid_parts TEXT NOT NULL DEFAULT '',         -- 禁忌部位（頸椎、腰、術後傷口…）
  conditions TEXT NOT NULL DEFAULT '',          -- 健康狀況（逗號分隔，對應 settings.health_conditions）
  health_note TEXT NOT NULL DEFAULT '',
  health_updated_at TEXT NOT NULL DEFAULT '',
  -- 同意書：民俗調理業要留客人自述的身體狀況與同意紀錄
  consent_at TEXT NOT NULL DEFAULT '',
  blacklist INTEGER NOT NULL DEFAULT 0,
  blacklist_reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_member_phone ON members(phone);

-- ============ 輪鐘（排鐘）============

-- 技師每日出勤。queue_seq 是「當日簽到順序」，輪鐘就是照這個號碼往下輪。
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL,
  therapist_id INTEGER NOT NULL,
  store_id INTEGER,
  queue_seq INTEGER NOT NULL DEFAULT 0,         -- 簽到順序（1 起算）
  checkin_at TEXT NOT NULL DEFAULT '',
  checkout_at TEXT NOT NULL DEFAULT '',
  -- 狀態：waiting 等鐘／serving 上鐘中／resting 休息（暫離輪序）／off 已下班
  status TEXT NOT NULL DEFAULT 'waiting',
  -- 輪序游標：每接一次輪鐘就 +1。同一輪內誰先誰後看 queue_seq，
  -- 跨輪之間看 rounds —— 這樣「輪過的人排到隊尾」不必真的搬動順序。
  rounds INTEGER NOT NULL DEFAULT 0,
  rest_until TEXT NOT NULL DEFAULT '',          -- 暫離到幾點（吃飯、抽菸、身體不適）
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (work_date, therapist_id),
  FOREIGN KEY (therapist_id) REFERENCES therapists(id)
);
CREATE INDEX IF NOT EXISTS idx_shift_date ON shifts(work_date, store_id);

-- 輪序異動軌跡。技師對「今天為什麼是他先上」有意見時，這張表就是答案。
CREATE TABLE IF NOT EXISTS queue_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL,
  store_id INTEGER,
  therapist_id INTEGER,
  therapist_name TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,        -- checkin/checkout/rest/resume/assign/designate/skip/manual/rollback
  ticket_id INTEGER,
  seq_before INTEGER,
  seq_after INTEGER,
  rounds_before INTEGER,
  rounds_after INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_qlog_date ON queue_logs(work_date DESC, id DESC);

-- ============ 鐘單（服務單）============

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT NOT NULL UNIQUE,
  store_id INTEGER,
  member_id INTEGER,
  guest_name TEXT NOT NULL DEFAULT '',          -- 非會員客人
  guest_phone TEXT NOT NULL DEFAULT '',
  pax INTEGER NOT NULL DEFAULT 1,
  therapist_id INTEGER,
  room_id INTEGER,
  service_id INTEGER,
  service_name TEXT NOT NULL DEFAULT '',        -- 當下的品名（主檔改名了也要看得到當初做了什麼）
  minutes INTEGER NOT NULL DEFAULT 60,
  start_at TEXT NOT NULL DEFAULT '',            -- 'YYYY-MM-DD HH:MM'
  end_at TEXT NOT NULL DEFAULT '',
  actual_start TEXT NOT NULL DEFAULT '',
  actual_end TEXT NOT NULL DEFAULT '',
  -- 指名方式：rotation 輪鐘／designated 指名／assigned 店長指派
  assign_type TEXT NOT NULL DEFAULT 'rotation',
  designate_fee REAL NOT NULL DEFAULT 0,        -- 向客人加收的指名費
  -- booked 已預約／serving 服務中／done 已完成／cancelled 取消／noshow 未到
  status TEXT NOT NULL DEFAULT 'booked',
  source TEXT NOT NULL DEFAULT '現場',           -- 現場／電話／LINE／官網／回頭客
  amount REAL NOT NULL DEFAULT 0,               -- 服務原價（含加鐘、不含商品）
  retail_amount REAL NOT NULL DEFAULT 0,        -- 商品銷售金額
  discount REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,           -- 應收＝amount+retail+指名費-discount
  -- 付款拆解：現金類實收 vs 動用預收（儲值／次卡）。營收認列與負債沖銷靠這三欄分開。
  paid_cash REAL NOT NULL DEFAULT 0,
  paid_wallet REAL NOT NULL DEFAULT 0,          -- 動用儲值（含贈送金）
  paid_pass REAL NOT NULL DEFAULT 0,            -- 用次卡核銷（以卡的單次價值計）
  pay_method TEXT NOT NULL DEFAULT '',
  -- 抽成在結帳當下算好寫死，日後調％不影響已結的單
  comm_service REAL NOT NULL DEFAULT 0,
  comm_retail REAL NOT NULL DEFAULT 0,
  comm_designate REAL NOT NULL DEFAULT 0,       -- 技師實拿的指名費
  comm_pct_used REAL NOT NULL DEFAULT 0,        -- 當下套用的服務抽成％（留存以便對帳）
  rating INTEGER NOT NULL DEFAULT 0,            -- 客人評價 1~5
  feedback TEXT NOT NULL DEFAULT '',
  gate_note TEXT NOT NULL DEFAULT '',           -- 強制放行時的理由（閘門警告被略過）
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (member_id) REFERENCES members(id),
  FOREIGN KEY (therapist_id) REFERENCES therapists(id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_start ON tickets(start_at);
CREATE INDEX IF NOT EXISTS idx_ticket_ther ON tickets(therapist_id, start_at);
CREATE INDEX IF NOT EXISTS idx_ticket_room ON tickets(room_id, start_at);
CREATE INDEX IF NOT EXISTS idx_ticket_member ON tickets(member_id, start_at DESC);

-- 鐘單明細：加鐘、加項、商品。抽成也逐項記，因為商品跟服務的％不一樣，
-- 而且加鐘有可能是別的技師接手做的。
CREATE TABLE IF NOT EXISTS ticket_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'service',         -- service 加鐘／addon 加項／retail 商品
  ref_id INTEGER,
  name TEXT NOT NULL DEFAULT '',
  minutes INTEGER NOT NULL DEFAULT 0,
  qty REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  therapist_id INTEGER,                          -- 這一項算誰的業績（空＝主技師）
  comm_pct REAL NOT NULL DEFAULT 0,
  comm_amount REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_titem_ticket ON ticket_items(ticket_id);

-- ============ 預收：儲值金與次卡 ============

CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL UNIQUE,
  -- 現金與贈送分開存。退款只能退現金部分，贈送金一律作廢 ——
  -- 混在一起算，遇到「儲值 2 萬送 3 千、用掉 5 千後要退款」就會退錯錢。
  cash_balance REAL NOT NULL DEFAULT 0,
  bonus_balance REAL NOT NULL DEFAULT 0,
  expiry_date TEXT NOT NULL DEFAULT '',          -- 贈送金效期（空＝不到期）
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (member_id) REFERENCES members(id)
);

CREATE TABLE IF NOT EXISTS wallet_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  store_id INTEGER,
  -- topup 儲值／consume 消費扣款／refund 退款／transfer_out 轉出／transfer_in 轉入
  -- ／adjust 人工調整／expire 贈送金到期作廢
  kind TEXT NOT NULL,
  cash_delta REAL NOT NULL DEFAULT 0,            -- 現金部位增減（正入負出）
  bonus_delta REAL NOT NULL DEFAULT 0,           -- 贈送部位增減
  amount REAL NOT NULL DEFAULT 0,                -- 實際金流（儲值時＝客人付的錢；消費時＝抵用金額）
  cash_after REAL NOT NULL DEFAULT 0,
  bonus_after REAL NOT NULL DEFAULT 0,
  ticket_id INTEGER,
  peer_member_id INTEGER,                        -- 轉讓對象
  pay_method TEXT NOT NULL DEFAULT '',
  therapist_id INTEGER,                          -- 誰銷的（儲值也有業績抽成）
  comm_amount REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_wtxn_member ON wallet_txns(member_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_wtxn_created ON wallet_txns(created_at DESC);

CREATE TABLE IF NOT EXISTS passes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_no TEXT NOT NULL UNIQUE,
  member_id INTEGER NOT NULL,
  store_id INTEGER,
  service_id INTEGER,                            -- 綁定服務（空＝任選同價位）
  name TEXT NOT NULL DEFAULT '',
  total_times INTEGER NOT NULL DEFAULT 0,
  used_times INTEGER NOT NULL DEFAULT 0,
  price_paid REAL NOT NULL DEFAULT 0,            -- 實際付了多少
  list_value REAL NOT NULL DEFAULT 0,            -- 原價總值（算折扣與退款用）
  buy_date TEXT NOT NULL DEFAULT '',
  expiry_date TEXT NOT NULL DEFAULT '',
  transferable INTEGER NOT NULL DEFAULT 1,
  -- active 使用中／used_up 已用完／expired 已過期／refunded 已退／transferred 已轉出
  status TEXT NOT NULL DEFAULT 'active',
  sold_by INTEGER,                               -- 銷售技師（抽成用）
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_pass_member ON passes(member_id, status);

CREATE TABLE IF NOT EXISTS pass_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id INTEGER NOT NULL,
  member_id INTEGER,
  kind TEXT NOT NULL,                            -- buy/use/void 銷帳回沖/refund/transfer/extend
  times INTEGER NOT NULL DEFAULT 0,              -- 次數增減（use 為 -1）
  amount REAL NOT NULL DEFAULT 0,
  used_after INTEGER NOT NULL DEFAULT 0,
  ticket_id INTEGER,
  peer_member_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (pass_id) REFERENCES passes(id)
);
CREATE INDEX IF NOT EXISTS idx_ptxn_pass ON pass_txns(pass_id, id DESC);

-- ============ 薪資 ============

CREATE TABLE IF NOT EXISTS payrolls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,                          -- 'YYYY-MM'
  therapist_id INTEGER NOT NULL,
  store_id INTEGER,
  base_salary REAL NOT NULL DEFAULT 0,
  service_amount REAL NOT NULL DEFAULT 0,        -- 服務業績（含加鐘）
  designated_amount REAL NOT NULL DEFAULT 0,     -- 其中屬指名的業績
  retail_amount REAL NOT NULL DEFAULT 0,         -- 商品／儲值／次卡銷售業績
  ticket_count INTEGER NOT NULL DEFAULT 0,
  designate_count INTEGER NOT NULL DEFAULT 0,
  minutes_total INTEGER NOT NULL DEFAULT 0,
  comm_service REAL NOT NULL DEFAULT 0,
  comm_retail REAL NOT NULL DEFAULT 0,
  comm_designate REAL NOT NULL DEFAULT 0,
  tier_bonus REAL NOT NULL DEFAULT 0,            -- 業績級距獎金
  adjust REAL NOT NULL DEFAULT 0,                -- 加項（全勤、獎金）
  deduction REAL NOT NULL DEFAULT 0,             -- 扣項（勞健保自付、請假、賠償）
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft 試算／confirmed 已確認／paid 已發放
  confirmed_at TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (period, therapist_id),
  FOREIGN KEY (therapist_id) REFERENCES therapists(id)
);

-- 業績級距獎金：月服務業績落在區間內，額外加給的％（對總服務業績計算）
CREATE TABLE IF NOT EXISTS commission_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT '',                -- 空＝適用所有級別
  min_amount REAL NOT NULL DEFAULT 0,
  max_amount REAL NOT NULL DEFAULT 0,            -- 0＝無上限
  bonus_pct REAL NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

-- ============ 其他 ============

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER,
  spend_date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  pay_method TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_expense_date ON expenses(spend_date DESC);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_no TEXT NOT NULL DEFAULT '',
  store_id INTEGER,
  happen_date TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '客訴',
  severity TEXT NOT NULL DEFAULT 'normal',
  member_id INTEGER,
  therapist_id INTEGER,
  ticket_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  handling TEXT NOT NULL DEFAULT '',
  compensation REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  owner TEXT NOT NULL DEFAULT '',
  closed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 官網線上預約：先落這裡，內勤確認才轉成鐘單
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_no TEXT NOT NULL DEFAULT '',
  store_id INTEGER,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  line_id TEXT NOT NULL DEFAULT '',
  service_id INTEGER,
  therapist_id INTEGER,                          -- 指定技師（空＝不指定）
  prefer_date TEXT NOT NULL DEFAULT '',
  prefer_time TEXT NOT NULL DEFAULT '',
  pax INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  staff_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',            -- new/contacted/converted/rejected
  ticket_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
