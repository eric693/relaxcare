process.env.TZ = process.env.RELAXCARE_TZ || 'Asia/Taipei';   // 全站時間基準：台北（詳見 src/db.js 開頭說明）

const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db, audit, getSetting, UI_TEXT_KEYS, today, nowStamp, fmtDate, bizDate } = require('./db');
const {
  STAFF_COOKIE, signToken, setAuthCookie, clearAuthCookie,
  requireStaff, parsePermissions, parseReadonly, MODULE_KEYS, rateLimit,
  loginLockedMinutes, loginFailed, loginSucceeded
} = require('./auth');

const loginRateLimit = rateLimit({ windowMs: 5 * 60 * 1000, max: 30, prefix: 'login:' });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // 服務跑在 nginx 後面，要靠轉發標頭判斷 https 與來源 IP
// 上傳照片走 JSON base64（單檔上限 8MB，base64 會膨脹約 1/3），所以放寬到 12MB。
// 真正的檔案大小限制在 storage.js 裡把關，不是靠這個數字。
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false }));

// 安全標頭。CSP 只允許同源資源，所以前端一律用自己的 JS／CSS，不吃 CDN。
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  next();
});

// ---- 首次啟動：建立管理員 ----
function ensureAdmin() {
  if (db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n) return;
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare(`INSERT INTO users(username,password_hash,name,role,title,permissions)
              VALUES('admin',?,'系統管理員','admin','負責人',?)`)
    .run(bcrypt.hashSync(pw, 10), JSON.stringify(MODULE_KEYS));
  console.log(`已建立管理員帳號 admin${process.env.ADMIN_PASSWORD ? '' : '，密碼 admin123（請盡快更改）'}`);
}
ensureAdmin();

app.get('/api/public/ui-texts', (req, res) => {
  const out = { company_name: getSetting('company_name', 'RelaxCare') };
  for (const k of UI_TEXT_KEYS) out[k] = getSetting(k);
  res.json(out);
});

// ---- 登入 ----
app.post('/api/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const lockKey = `staff:${username || ''}`;
  const locked = loginLockedMinutes(lockKey);
  if (locked) return res.status(429).json({ error: `登入失敗次數過多，請 ${locked} 分鐘後再試` });
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    loginFailed(lockKey);
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  loginSucceeded(lockKey);
  setAuthCookie(res, STAFF_COOKIE, signToken({ t: 'staff', id: user.id }), req);
  audit('staff', user.id, user.name, '員工登入');
  res.json({ id: user.id, name: user.name, role: user.role });
});

// 忘記密碼：管理員在「帳號權限」頁產生一次性代碼，當事人在登入頁用它改密碼。
// 這支不需要登入，所以跟登入共用同一組限流。
app.post('/api/password-reset', loginRateLimit, (req, res) => {
  const { username, code, new_password } = req.body || {};
  const fail = () => res.status(400).json({ error: '代碼不正確或已失效，請向管理員重新索取' });
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username || '');
  if (!user) return fail();
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: '新密碼至少 6 碼' });
  }
  const rows = db.prepare(`SELECT * FROM password_resets WHERE user_id = ? AND used_at = ''
    ORDER BY id DESC LIMIT 5`).all(user.id);
  const now = nowStamp();
  const hit = rows.find(r => r.expires_at >= now && bcrypt.compareSync(String(code || ''), r.code_hash));
  if (!hit) return fail();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(String(new_password), 10), user.id);
  db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now, hit.id);
  audit('staff', user.id, user.name, '以重設代碼變更自己的密碼');
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res, STAFF_COOKIE, req);
  res.json({ ok: true });
});

app.get('/api/me', requireStaff(), (req, res) => {
  res.json({
    id: req.user.id, username: req.user.username, name: req.user.name,
    role: req.user.role, title: req.user.title, store_id: req.user.store_id,
    modules: req.user.role === 'admin' ? MODULE_KEYS : parsePermissions(req.user.permissions),
    readonly: req.user.role === 'admin' ? [] : parseReadonly(req.user.readonly_modules),
    company_name: getSetting('company_name', 'RelaxCare')
  });
});

app.put('/api/me/password', requireStaff(), (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!bcrypt.compareSync(old_password || '', req.user.password_hash)) {
    return res.status(400).json({ error: '舊密碼不正確' });
  }
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: '新密碼至少 6 碼' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(String(new_password), 10), req.user.id);
  audit('staff', req.user.id, req.user.name, '修改自己的密碼');
  res.json({ ok: true });
});

// ---- 模組路由 ----
app.use('/api', require('./routes/booking'));
app.use('/api', require('./routes/masters'));
app.use('/api', require('./routes/queue'));
app.use('/api', require('./routes/tickets'));
app.use('/api', require('./routes/prepaid'));
app.use('/api', require('./routes/vouchers'));
app.use('/api', require('./routes/reports'));
app.use('/api', require('./routes/inventory'));
app.use('/api', require('./routes/ops'));
app.use('/api', require('./routes/admin'));

// ---- 靜態檔案 ----
// 前端程式碼不做長快取：改版後若瀏覽器還拿著舊的 JS，會出現「新的 API 配舊的畫面」。
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(js|css|html)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800');
  }
}));

app.use('/api', (req, res) => res.status(404).json({ error: '找不到此 API' }));

// 錯誤處理。
//
// 業務規則的錯誤（「庫存不足」「短溢超過容忍值」「這張卡已經退過了」）是丟例外出來的，
// 它們是使用者做錯事，不是系統壞了 —— 回 500 會讓前端顯示成「系統發生錯誤」，
// 使用者就不知道自己該改什麼。所以只有真正的程式錯誤與資料庫錯誤才算 500。
const BUG_ERRORS = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError']);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isBug = !err || !err.message || BUG_ERRORS.has(err.name) || err.name === 'SqliteError';
  if (isBug) console.error(err);
  res.status(err && err.status ? err.status : isBug ? 500 : 400)
    .json({ error: isBug ? '系統發生錯誤，請稍後再試' : err.message });
});

// ---- 每日維護：備份、資料保留、狀態推進、贈送金到期 ----

const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');
const BACKUP_MIRROR = process.env.RELAXCARE_BACKUP_MIRROR !== undefined
  ? process.env.RELAXCARE_BACKUP_MIRROR : '/root/backups/relaxcare';
const BACKUP_KEEP = 14;

function sweepBackupDir(dir) {
  if (!fs.existsSync(dir)) return;
  const dbs = fs.readdirSync(dir).filter(f => /^relaxcare-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  while (dbs.length > BACKUP_KEEP) {
    const name = dbs.shift();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(path.join(dir, name + suffix)); } catch { /* 不存在即略過 */ }
    }
  }
}

// 沒有人會回頭去把昨天忘記結的單點掉，所以狀態要自己往前走：
// 過了時間還停在「已預約」的單視為未到；還停在「服務中」的單自動結束（金額照原本的算）。
function rollStatuses() {
  // 用營業日比較：24 小時店的凌晨還在「昨天」的班上，不該被當成過期未到
  const t = bizDate();
  // 標記未到之前先把商品還回架上。
  //
  // 預約單也可能先賣了商品（客人先來拿貨、晚點再做），加項的當下庫存就扣掉了。
  // 人工取消走 /tickets/:id/cancel 會回沖，但這裡是系統自己標記的 ——
  // 漏掉就會變成「客人沒來、東西也沒賣出去，架上卻少一件」，而且永遠查不出是哪一天少的。
  const inventory = require('./inventory');
  const noshow = db.prepare("SELECT * FROM tickets WHERE status = 'booked' AND biz_date < ?").all(t);
  for (const tk of noshow) {
    for (const i of db.prepare("SELECT * FROM ticket_items WHERE ticket_id = ? AND kind = 'retail'").all(tk.id)) {
      if (!i.ref_id) continue;
      try {
        inventory.sellVoid({ productId: i.ref_id, storeId: tk.store_id, qty: i.qty, ticketId: tk.id,
          note: `${tk.ticket_no} 系統標記未到，商品回沖`, actor: '系統' });
      } catch (e) { console.error(`未到回沖失敗（${tk.ticket_no} ${i.name}）：`, e.message); }
    }
  }
  db.prepare(`UPDATE tickets SET status = 'noshow', note = TRIM(note || ' ｜系統標記未到')
              WHERE status = 'booked' AND biz_date < ?`).run(t);
  const stale = db.prepare(`SELECT * FROM tickets WHERE status = 'serving' AND biz_date < ?`).all(t);
  for (const s of stale) {
    db.prepare(`UPDATE tickets SET status = 'done', actual_end = COALESCE(NULLIF(actual_end,''), end_at),
                note = TRIM(note || ' ｜系統自動結束（未於當日結帳）') WHERE id = ?`).run(s.id);
    if (s.therapist_id) {
      // 用營業日找班，跟開單／上鐘／取消同一個口徑（凌晨的單掛在前一天的班上）
      const sh = db.prepare('SELECT * FROM shifts WHERE work_date = ? AND therapist_id = ?')
        .get(s.biz_date || bizDate(s.start_at), s.therapist_id);
      if (sh && sh.status === 'serving') {
        db.prepare("UPDATE shifts SET status = 'off', checkout_at = ? WHERE id = ?").run(nowStamp(), sh.id);
      }
    }
  }
  // 前一天還掛在檯面上的班一律關掉，免得今天的輪鐘檯混進昨天的人
  db.prepare("UPDATE shifts SET status='off', checkout_at = COALESCE(NULLIF(checkout_at,''), ?) WHERE work_date < ? AND status <> 'off'")
    .run(nowStamp(), t);
  // 次卡過期
  db.prepare("UPDATE passes SET status = 'expired' WHERE status = 'active' AND expiry_date <> '' AND expiry_date < ?").run(t);
}

async function dailyMaintenance() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    // 檔名用營業日期（台北）。用 toISOString() 會變成 UTC，凌晨的備份會掛到前一天。
    const name = `relaxcare-${fmtDate()}.db`;
    const dest = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(dest)) {
      await db.backup(dest);
      console.log(`資料庫已備份：${dest}`);
      if (BACKUP_MIRROR) {
        try {
          fs.mkdirSync(BACKUP_MIRROR, { recursive: true });
          fs.copyFileSync(dest, path.join(BACKUP_MIRROR, name));
          sweepBackupDir(BACKUP_MIRROR);
        } catch (e) { console.error('異地備份失敗：', e.message); }
      }
    }
    sweepBackupDir(BACKUP_DIR);
    const keep = Number(getSetting('audit_retention_days', '730'));
    if (keep > 0) db.prepare("DELETE FROM audit_logs WHERE created_at < datetime('now','localtime',?)").run(`-${keep} days`);
    const nkeep = Number(getSetting('notify_retention_days', '180'));
    if (nkeep > 0) db.prepare("DELETE FROM notifications WHERE created_at < datetime('now','localtime',?)").run(`-${nkeep} days`);
    rollStatuses();
    // 附件完整性：壞掉的檔案要在還救得回來的時候被發現，而不是等到要調同意書的那天。
    try {
      const fileCheck = require('./storage').verifyAll({ limit: 2000 });
      if (!fileCheck.ok) {
        console.error(`附件完整性檢查：${fileCheck.bad.length} 個檔案有問題`);
        for (const b of fileCheck.bad.slice(0, 10)) console.error(`  · #${b.id} ${b.filename}：${b.problem}`);
        audit('staff', null, '系統', `附件完整性檢查發現 ${fileCheck.bad.length} 個問題檔案`);
      }
    } catch (e) { console.error('附件完整性檢查失敗：', e.message); }
    // 庫存快取與流水對帳（只報告不自動修，庫存自己變了要有人知道）
    try {
      const inv = require('./inventory').reconcile({});
      if (!inv.ok) console.error(`庫存快取與流水不符：${inv.mismatched.length} 項，請到進退貨與盤點頁重算`);
    } catch (e) { console.error('庫存對帳失敗：', e.message); }
    const expired = require('./prepaid').expireBonus();
    const voidVouchers = require('./vouchers').expireOld();
    if (voidVouchers) console.log(`團購券過期：${voidVouchers} 張`);
    if (expired) console.log(`贈送金到期作廢：${expired} 位客人`);
  } catch (e) { console.error('每日維護作業失敗：', e.message); }
}
dailyMaintenance();
setInterval(dailyMaintenance, 6 * 3600 * 1000);

const PORT = process.env.PORT || 3460;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`RelaxCare 按摩／SPA 連鎖營運管理系統 http://127.0.0.1:${PORT}`);
});
