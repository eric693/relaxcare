const jwt = require('jsonwebtoken');
const { db, SECRET } = require('./db');

const STAFF_COOKIE = 'rc_staff';
const TOKEN_TTL = '7d';

// 模組權限清單（staff 帳號逐一勾選；admin 全開）
// group 對應側欄分類，勾選畫面照同樣分組排列，找得到也對得起來
const MODULES = [
  { key: 'dashboard', label: '營運儀表板', group: '每日作業', hint: '今日鐘數、業績、待辦與異常' },
  { key: 'queue', label: '輪鐘檯', group: '每日作業', hint: '技師簽到順序、誰該上鐘、指名跳鐘與軌跡' },
  { key: 'board', label: '排鐘看板', group: '每日作業', hint: '技師與床位時間軸、衝突偵測' },
  { key: 'tickets', label: '鐘單', group: '每日作業', hint: '開單、加鐘、賣商品、結帳與抽成' },
  { key: 'bookings', label: '線上預約', group: '每日作業', hint: '官網送來的預約申請，確認後轉鐘單' },
  { key: 'issues', label: '客訴與異常', group: '每日作業', hint: '客訴、技師糾紛、收費爭議' },
  { key: 'closing', label: '日結與交班', group: '每日作業', hint: '對現金抽屜、短溢紀錄、交班簽核' },

  { key: 'members', label: '客人檔案', group: '客戶與預收', hint: '基本資料、力道偏好、禁忌部位與健康狀況' },
  { key: 'wallets', label: '儲值金', group: '客戶與預收', hint: '儲值、扣款、轉讓、退款（現金與贈送分開）' },
  { key: 'passes', label: '次卡與套券', group: '客戶與預收', hint: '購買、核銷、展延、轉讓、退卡' },
  { key: 'repurchase', label: '回購與名單', group: '客戶與預收', hint: '久未回店名單、指名回購週期' },
  { key: 'vouchers', label: '團購券', group: '客戶與預收', hint: 'Klook／GOMAJI 券號建檔、核銷與平台對帳' },
  { key: 'loyalty', label: '點數與介紹', group: '客戶與預收', hint: '集點、兌換贈送金、介紹人獎勵與排行' },

  { key: 'therapists', label: '技師管理', group: '資源與商品', hint: '技師檔案、級別、抽成％與指名費' },
  { key: 'rooms', label: '床位與包廂', group: '資源與商品', hint: '房型、數量、使用率' },
  { key: 'services', label: '服務項目', group: '資源與商品', hint: '品項、時長、三層定價、套票與禁忌設定' },
  { key: 'addons', label: '加購品', group: '資源與商品', hint: '刮痧、拔罐、足部護理等固定加購' },
  { key: 'retail', label: '商品與庫存', group: '資源與商品', hint: '販售商品、成本、庫存與抽成' },
  { key: 'purchase', label: '進退貨與盤點', group: '資源與商品', hint: '進貨、退貨、盤點差異、跨店調撥與庫存流水' },

  { key: 'payroll', label: '薪資結算', group: '薪酬', hint: '底薪＋抽成＋指名費＋級距獎金的月結' },
  { key: 'commission', label: '抽成與級距', group: '薪酬', hint: '級別預設％、業績級距獎金設定' },
  { key: 'attendance', label: '出勤與工時', group: '薪酬', hint: '簽到退、當日時數、連續上鐘警示' },
  { key: 'roster', label: '班表', group: '薪酬', hint: '預排下週班別、複製上週、班表與實際簽到的落差' },

  { key: 'finance', label: '營運損益', group: '財務', hint: '收入、抽成成本、費用與毛利' },
  { key: 'liability', label: '預收負債表', group: '財務', hint: '儲值與次卡未使用餘額（會計上的負債）' },
  { key: 'expenses', label: '費用登錄', group: '財務', hint: '房租、耗材、洗滌等營運支出' },
  { key: 'invoices', label: '發票與折讓', group: '財務', hint: '開立登錄、作廢、折讓與待開名單' },
  // 「營業稅試算」與「用語合規自檢」原本各自是一頁。
  // 店長一年用不到幾次，側欄多兩項只是雜訊 —— 權限鍵保留（後端端點仍受它保護），
  // 畫面分別收進「營運損益」與「法遵與證照」的分頁裡。
  { key: 'tax', label: '營業稅試算', group: '財務', hint: '預收不計稅、實際服務才認列（畫面在營運損益的分頁）', hidden: true },
  { key: 'compliance', label: '法遵與證照', group: '法遵', hint: '證照健檢到期、民俗調理業用語自檢、同意書完整度' },
  { key: 'expiry', label: '（併入法遵與證照）', group: '法遵', hint: '證照到期的編輯權限，畫面在法遵與證照頁', hidden: true },

  { key: 'notifications', label: '通知紀錄', group: '系統', hint: 'LINE 預約提醒與回購推播的送出紀錄' },
  { key: 'stores', label: '分店設定', group: '系統', hint: '門市、營業時間、跨店拆帳比例' },
  { key: 'users', label: '帳號權限', group: '系統', hint: '新增帳號與調整他人權限' },
  { key: 'settings', label: '系統設定', group: '系統', hint: '公司名稱、下拉選項、輪鐘規則、預收規則' },
  { key: 'audit', label: '稽核軌跡', group: '系統', hint: '誰在什麼時候做了什麼' },
  { key: 'backup', label: '備份與檔案', group: '系統', hint: '手動備份、下載、還原，以及上傳檔案的完整性檢查' }
];
const MODULE_GROUPS = ['每日作業', '客戶與預收', '資源與商品', '薪酬', '財務', '法遵', '系統'];
const MODULE_KEYS = MODULES.map(m => m.key);

// 登入暴力嘗試防護：同一帳號連續失敗 5 次鎖 15 分鐘
const loginAttempts = new Map();
const LOGIN_MAX_FAILS = 5, LOGIN_LOCK_MS = 15 * 60 * 1000;
function loginLockedMinutes(key) {
  const a = loginAttempts.get(key);
  if (a && a.lockedUntil && a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 60000);
  return 0;
}
function loginFailed(key) {
  if (loginAttempts.size > 10000) loginAttempts.clear();
  const a = loginAttempts.get(key) || { fails: 0 };
  a.fails++;
  if (a.fails >= LOGIN_MAX_FAILS) { a.lockedUntil = Date.now() + LOGIN_LOCK_MS; a.fails = 0; }
  loginAttempts.set(key, a);
}
function loginSucceeded(key) { loginAttempts.delete(key); }

// 真實客戶端 IP（服務跑在 nginx 後方）
function clientIp(req) {
  return (req.headers['x-real-ip'] || '').trim()
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
}

// 通用限流：只用在未登入的攻擊面（登入）
function rateLimit({ windowMs, max, prefix = '' }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = prefix + clientIp(req);
    if (hits.size > 20000) { for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }
    let e = hits.get(key);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(key, e); }
    e.count++;
    if (e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    }
    next();
  };
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function signToken(payload) { return jwt.sign(payload, SECRET, { expiresIn: TOKEN_TTL }); }

// 正式站走 https（nginx 轉發時會帶 x-forwarded-proto），這種情況一律加 Secure，
// 免得有人先連 http:// 就把登入權杖用明文送出去。本機 http 開發時不加，否則登不進去。
function isHttps(req) {
  if (!req) return false;
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    || (req.socket && req.socket.encrypted) || false;
}
function setAuthCookie(res, name, token, req) {
  res.setHeader('Set-Cookie',
    `${name}=${token}; HttpOnly; Path=/; Max-Age=${7 * 86400}; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
}
function clearAuthCookie(res, name, req) {
  res.setHeader('Set-Cookie',
    `${name}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
}

function parsePermissions(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(k => MODULE_KEYS.includes(k)) : [];
  } catch { return []; }
}
// 唯讀模組：存法與 permissions 相同，是它的子集合（沒有該模組權限時這個標記沒有意義）
const parseReadonly = parsePermissions;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// requireStaff() 任一登入員工；requireStaff('orders') 需具該模組權限（admin 一律通過）
function requireStaff(moduleKey) {
  return (req, res, next) => {
    const token = parseCookies(req)[STAFF_COOKIE];
    if (!token) return res.status(401).json({ error: '請先登入' });
    let payload;
    try { payload = jwt.verify(token, SECRET); } catch { return res.status(401).json({ error: '登入已過期，請重新登入' }); }
    if (payload.t !== 'staff') return res.status(401).json({ error: '請先登入' });
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(payload.id);
    if (!user) return res.status(401).json({ error: '帳號不存在或已停用' });
    req.user = user;
    req.userModules = user.role === 'admin' ? MODULE_KEYS : parsePermissions(user.permissions);
    req.userReadonly = user.role === 'admin' ? [] : parseReadonly(user.readonly_modules);
    if (moduleKey && user.role !== 'admin') {
      if (!req.userModules.includes(moduleKey)) return res.status(403).json({ error: '無此模組使用權限' });
      // 唯讀擋在這裡，就不必在幾十支寫入路由各判斷一次，日後新增的端點也自動受保護
      if (req.userReadonly.includes(moduleKey) && WRITE_METHODS.has(req.method)) {
        const label = (MODULES.find(m => m.key === moduleKey) || {}).label || moduleKey;
        return res.status(403).json({ error: `你對「${label}」只有檢視權限，不能修改` });
      }
    }
    next();
  };
}

// 具備清單中任一模組權限即可通過。
//
// 有些資料天生跨模組：投保名冊在訂單頁、梯次頁、保險頁都要匯得出來；
// 訂單清單在退費試算與保單登錄裡也要選得到。
// 若一律綁死單一模組，畫面上會出現「看得到按鈕、按下去說沒有權限」的狀況 ——
// 那比直接不給還糟，因為使用者會以為系統壞了。
function requireAny(...keys) {
  return (req, res, next) => {
    requireStaff()(req, res, () => {
      if (req.user.role === 'admin') return next();
      const hit = keys.find(k => req.userModules.includes(k));
      if (!hit) return res.status(403).json({ error: '無此模組使用權限' });
      // 寫入時，被命中的那個模組若是唯讀就擋下來
      if (WRITE_METHODS.has(req.method) && keys.every(k => !req.userModules.includes(k) || req.userReadonly.includes(k))) {
        return res.status(403).json({ error: '你對相關模組只有檢視權限，不能修改' });
      }
      next();
    });
  };
}

function requireAdmin(req, res, next) {
  requireStaff()(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理員權限' });
    next();
  });
}

module.exports = {
  MODULES, MODULE_KEYS, MODULE_GROUPS, STAFF_COOKIE,
  signToken, setAuthCookie, clearAuthCookie, parsePermissions, parseReadonly,
  requireStaff, requireAny, requireAdmin, loginLockedMinutes, loginFailed, loginSucceeded, rateLimit, clientIp
};
