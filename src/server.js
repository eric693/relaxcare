process.env.TZ = process.env.TZ || 'Asia/Taipei';   // 全站時間基準：台北（詳見 src/db.js 開頭說明）

const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db, audit, getSetting, UI_TEXT_KEYS, today, nowStamp } = require('./db');
const {
  STAFF_COOKIE, signToken, setAuthCookie, clearAuthCookie,
  requireStaff, parsePermissions, parseReadonly, MODULE_KEYS, rateLimit,
  loginLockedMinutes, loginFailed, loginSucceeded
} = require('./auth');

const loginRateLimit = rateLimit({ windowMs: 5 * 60 * 1000, max: 30, prefix: 'login:' });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // 服務跑在 nginx 後面，要靠轉發標頭判斷 https 與來源 IP
app.use(express.json({ limit: '2mb' }));
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
app.use('/api', require('./routes/reports'));
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

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err && err.message ? err.message : '系統發生錯誤，請稍後再試' });
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
  const t = today();
  db.prepare(`UPDATE tickets SET status = 'noshow', note = TRIM(note || ' ｜系統標記未到')
              WHERE status = 'booked' AND substr(start_at,1,10) < ?`).run(t);
  const stale = db.prepare(`SELECT * FROM tickets WHERE status = 'serving'
                            AND substr(COALESCE(NULLIF(actual_start,''), start_at),1,10) < ?`).all(t);
  for (const s of stale) {
    db.prepare(`UPDATE tickets SET status = 'done', actual_end = COALESCE(NULLIF(actual_end,''), end_at),
                note = TRIM(note || ' ｜系統自動結束（未於當日結帳）') WHERE id = ?`).run(s.id);
    if (s.therapist_id) {
      const sh = db.prepare('SELECT * FROM shifts WHERE work_date = ? AND therapist_id = ?')
        .get(s.start_at.slice(0, 10), s.therapist_id);
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
    const s = new Date();
    const name = `relaxcare-${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}.db`;
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
    const expired = require('./prepaid').expireBonus();
    if (expired) console.log(`贈送金到期作廢：${expired} 位客人`);
  } catch (e) { console.error('每日維護作業失敗：', e.message); }
}
dailyMaintenance();
setInterval(dailyMaintenance, 6 * 3600 * 1000);

const PORT = process.env.PORT || 3460;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`RelaxCare 按摩／SPA 連鎖營運管理系統 http://127.0.0.1:${PORT}`);
});
