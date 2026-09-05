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

-- ============ 加購品主檔 ============
-- 刮痧、拔罐、足部護理、腳趾甲護理這類固定加購，原本只能在鐘單上自由輸入品名與金額，
-- 結果是每個櫃檯打出來的名字都不一樣，月底根本統計不出「刮痧賣了幾次」。
CREATE TABLE IF NOT EXISTS addons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '加購',
  minutes INTEGER NOT NULL DEFAULT 0,        -- 會延長多久（0＝不佔時間，例如附餐）
  list_price REAL NOT NULL DEFAULT 0,        -- 牌價
  price REAL NOT NULL DEFAULT 0,             -- 現場價
  member_price REAL NOT NULL DEFAULT 0,      -- 會員價（0＝同現場價）
  pct_commission REAL NOT NULL DEFAULT 0,    -- 抽成％覆寫（0＝用技師／級別設定）
  requires_therapist INTEGER NOT NULL DEFAULT 1,   -- 是否需要技師施作（附餐類填 0）
  note TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ============ 團購券 ============
-- Klook、GOMAJI、KKday 的券是按摩店很大一塊收入，但它跟現場收現金完全是兩回事：
--   · 錢是平台先收的，店家事後月結才拿得到，中間被抽成
--   · 券有到期日，過期客人不能用
--   · 同一張券號只能核銷一次，重複核銷是實際會發生的糾紛
-- 所以券必須自己是一筆資料，不能只在鐘單上打一行備註。
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT '',          -- Klook／GOMAJI／KKday／團購／其他
  code TEXT NOT NULL,                         -- 券號（同平台內不重複）
  batch TEXT NOT NULL DEFAULT '',             -- 檔期／專案名稱，月結對帳用
  service_id INTEGER,                         -- 綁定服務（空＝可折抵任何項目）
  title TEXT NOT NULL DEFAULT '',             -- 券面品名（平台上長什麼樣）
  face_value REAL NOT NULL DEFAULT 0,         -- 券面可折抵金額
  net_receivable REAL NOT NULL DEFAULT 0,     -- 扣掉平台抽成後，店家實際可收到的錢
  commission_pct REAL NOT NULL DEFAULT 0,     -- 平台抽成％
  buyer_name TEXT NOT NULL DEFAULT '',
  buyer_phone TEXT NOT NULL DEFAULT '',
  issued_date TEXT NOT NULL DEFAULT '',
  expiry_date TEXT NOT NULL DEFAULT '',
  -- unused 未核銷／used 已核銷／expired 已過期／void 作廢／settled 已月結入帳
  status TEXT NOT NULL DEFAULT 'unused',
  store_id INTEGER,
  ticket_id INTEGER,                          -- 核銷在哪張鐘單
  used_at TEXT NOT NULL DEFAULT '',
  settled_at TEXT NOT NULL DEFAULT '',        -- 平台撥款入帳日
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (platform, code)
);
CREATE INDEX IF NOT EXISTS idx_voucher_status ON vouchers(status, expiry_date);

-- ============ 庫存流水 ============
-- 原本 retail_products.stock 只能手動改數字，沒有任何流水 ——
-- 這跟儲值金「餘額是快取、流水才是真相」的原則自相矛盾，
-- 而且損益表上的商品成本因此完全無法稽核（誰改的、改了什麼、進貨多少錢，全都查不到）。
--
-- 每一次庫存異動都寫一筆。products.stock 從此只是這張表的加總快取。
CREATE TABLE IF NOT EXISTS stock_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  store_id INTEGER,                            -- 這筆異動發生在哪一店（調撥靠它分左右手）
  -- purchase 進貨／return 退貨給廠商／sale 銷售出庫／sale_void 銷售回沖
  -- ／count 盤點調整／transfer_out 調出／transfer_in 調入／adjust 人工調整／init 期初
  kind TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,                 -- 正入負出
  unit_cost REAL NOT NULL DEFAULT 0,           -- 進貨單價（銷售出庫記當下的成本，算毛利用）
  amount REAL NOT NULL DEFAULT 0,              -- qty × unit_cost（進貨才有金額）
  stock_after REAL NOT NULL DEFAULT 0,         -- 異動後的總庫存（對帳用）
  vendor TEXT NOT NULL DEFAULT '',
  doc_no TEXT NOT NULL DEFAULT '',             -- 進貨單／盤點單／調撥單號
  ticket_id INTEGER,
  peer_store_id INTEGER,                       -- 調撥的另一端
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_stock_product ON stock_txns(product_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_stock_created ON stock_txns(created_at DESC);

-- ============ 日結與交班 ============
-- 櫃檯每天換班一定要對一次現金抽屜。少了這張表，短溢只能靠 Excel 或吵架解決。
--
-- 「應有現金」是系統算的：零用金 + 當班鐘單收現 + 儲值收現 + 售卡收現 - 現金支出。
-- 「實點現金」是人數的。兩者的差額必須留下來，而不是讓人把數字改到一樣。
CREATE TABLE IF NOT EXISTS closings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  closing_no TEXT NOT NULL UNIQUE,
  store_id INTEGER,
  biz_date TEXT NOT NULL,                      -- 營業日（凌晨的班算前一天，見 db.bizDate）
  shift_label TEXT NOT NULL DEFAULT '全日',     -- 早班／晚班／全日
  from_at TEXT NOT NULL DEFAULT '',            -- 本班統計區間（含）
  to_at TEXT NOT NULL DEFAULT '',              -- （不含）
  open_float REAL NOT NULL DEFAULT 0,          -- 抽屜起始零用金
  expected_cash REAL NOT NULL DEFAULT 0,       -- 系統算出來的應有現金
  counted_cash REAL NOT NULL DEFAULT 0,        -- 實際點鈔
  diff REAL NOT NULL DEFAULT 0,                -- 實點 - 應有（負數＝短少）
  ticket_cash REAL NOT NULL DEFAULT 0,
  topup_cash REAL NOT NULL DEFAULT 0,
  pass_cash REAL NOT NULL DEFAULT 0,
  cash_expense REAL NOT NULL DEFAULT 0,
  card_amount REAL NOT NULL DEFAULT 0,         -- 刷卡／行動支付（不進抽屜，但要跟收單機對）
  other_amount REAL NOT NULL DEFAULT 0,        -- 匯款等其他非現金
  wallet_used REAL NOT NULL DEFAULT 0,         -- 動用儲值（不是現金，只列給人看）
  pass_used REAL NOT NULL DEFAULT 0,
  voucher_used REAL NOT NULL DEFAULT 0,
  tickets INTEGER NOT NULL DEFAULT 0,
  denom TEXT NOT NULL DEFAULT '',              -- 點鈔明細 JSON：{"1000":3,"500":2,...}
  handover_to TEXT NOT NULL DEFAULT '',        -- 交給誰
  status TEXT NOT NULL DEFAULT 'draft',        -- draft 試算／confirmed 已結
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_closing_date ON closings(biz_date DESC, id DESC);

-- ============ 發票與折讓 ============
-- 系統本身不連接國稅局，這裡登錄的是「實際開出去的號碼」：
-- 有了它，營業稅試算才對得回申報書，作廢與折讓也才有軌跡。
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track TEXT NOT NULL DEFAULT '',              -- 字軌（AB）
  number TEXT NOT NULL DEFAULT '',             -- 號碼（12345678）
  invoice_date TEXT NOT NULL DEFAULT '',
  store_id INTEGER,
  ticket_id INTEGER,
  member_id INTEGER,
  buyer_name TEXT NOT NULL DEFAULT '',
  buyer_tax_id TEXT NOT NULL DEFAULT '',       -- 統一編號（開三聯式才有）
  invoice_type TEXT NOT NULL DEFAULT 'B2C',    -- B2C 二聯／B2B 三聯
  amount REAL NOT NULL DEFAULT 0,              -- 含稅總額
  net_amount REAL NOT NULL DEFAULT 0,          -- 未稅銷售額
  tax_amount REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'issued',       -- issued 已開立／void 作廢／allowance 已折讓
  void_reason TEXT NOT NULL DEFAULT '',
  allowance_amount REAL NOT NULL DEFAULT 0,    -- 折讓金額（部分退款用）
  allowance_date TEXT NOT NULL DEFAULT '',
  allowance_reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (track, number)
);
CREATE INDEX IF NOT EXISTS idx_invoice_date ON invoices(invoice_date DESC, id DESC);

-- ============ 班表（預排班）============
-- shifts 是「當日簽到表」，不是班表。店長要排的是下週誰上早班、誰休假，
-- 那件事現在是在 LINE 群組發圖片解決的。
CREATE TABLE IF NOT EXISTS rosters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL,
  therapist_id INTEGER NOT NULL,
  store_id INTEGER,
  shift_code TEXT NOT NULL DEFAULT '早班',      -- 早班／中班／晚班／休假／特休／請假
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (work_date, therapist_id),
  FOREIGN KEY (therapist_id) REFERENCES therapists(id)
);
CREATE INDEX IF NOT EXISTS idx_roster_date ON rosters(work_date, store_id);

-- ============ 同意書簽名 ============
-- compliance 會算「同意書完整度」，但原本系統裡沒有任何地方可以「簽」。
-- 民俗調理業被檢舉或客人事後主張受傷時，要拿得出來的就是這張：
-- 客人當下自述了什麼身體狀況、簽了名、誰經手的。
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  ticket_id INTEGER,
  store_id INTEGER,
  signed_at TEXT NOT NULL DEFAULT '',
  -- 簽署當下的快照。日後客人改了問診資料，這張同意書要維持當時的內容。
  conditions TEXT NOT NULL DEFAULT '',
  avoid_parts TEXT NOT NULL DEFAULT '',
  pressure_pref TEXT NOT NULL DEFAULT '',
  health_note TEXT NOT NULL DEFAULT '',
  consent_text TEXT NOT NULL DEFAULT '',       -- 簽的是哪一版條文（改版後舊的要看得到）
  signature TEXT NOT NULL DEFAULT '',          -- 簽名圖：data:image/png;base64,...
  signer_name TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_consent_member ON consents(member_id, id DESC);

-- ============ 點數與介紹 ============
-- 集點與介紹人是這行業主要的拉客手段，原本完全沒有。
--
-- 兌換一律換成「儲值贈送金」，不直接折在鐘單上 ——
-- 折在鐘單上會動到抽成基礎（技師的薪水會因為客人用點數而變少，那是吵不完的）；
-- 走贈送金則沿用既有的預收流程，負債、退款、優先扣抵全部已經是對的。
CREATE TABLE IF NOT EXISTS point_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                          -- earn 消費累點／referral 介紹獎勵／redeem 兌換／adjust 人工／expire 到期
  points INTEGER NOT NULL DEFAULT 0,           -- 正增負減
  balance_after INTEGER NOT NULL DEFAULT 0,
  ticket_id INTEGER,
  peer_member_id INTEGER,                      -- 介紹獎勵：被介紹的那位
  amount REAL NOT NULL DEFAULT 0,              -- 兌換時換到多少贈送金
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_point_member ON point_txns(member_id, id DESC);

-- ============ 密碼重設 ============
-- 12 位技師以上，「忘記密碼」就會變成管理員的日常雜事。
-- 沒有 email 與簡訊管道，所以走「管理員產生一次性代碼、當事人在登入頁自己改」。
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,                     -- 代碼只在產生的當下顯示一次，資料庫存雜湊
  expires_at TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_reset_user ON password_resets(user_id, id DESC);

-- ============ 附件（照片與檔案）============
-- 客人照片、進貨單據、同意書簽名、盤點單拍照都走這張表。
--
-- 檔案本體存在 data/uploads/，資料庫只存指紋。存檔一律「寫入 → fsync → 回讀 → 比對 SHA-256 與位元組數」，
-- 三者有一項對不上就當作失敗、刪掉半成品並回報錯誤 ——
-- 「畫面顯示上傳成功、實際上檔案是壞的」比直接失敗糟糕得多，
-- 因為那要等到幾個月後客人主張受傷、要調同意書出來時才會發現。
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL,                    -- member 客人照片／consent 同意書／stock 進貨單據／ticket 鐘單／issue 客訴存證
  owner_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'photo',          -- photo 照片／doc 單據／signature 簽名
  filename TEXT NOT NULL DEFAULT '',           -- 使用者看到的原始檔名
  stored_name TEXT NOT NULL UNIQUE,            -- 實際落在 data/uploads/ 的檔名
  mime TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',             -- 存檔當下回讀算出來的指紋，日後可重新驗證
  verified_at TEXT NOT NULL DEFAULT '',        -- 最後一次通過完整性檢查的時間
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_attach_owner ON attachments(owner_type, owner_id, id DESC);
