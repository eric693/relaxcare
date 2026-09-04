// 系統：帳號權限、設定、稽核軌跡、通知紀錄、客訴、線上預約、CSV 匯出。
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, audit, getSetting, setSetting, getList, LIST_KEYS, UI_TEXT_KEYS, today, nowStamp,
  nextSerial, yuan, thisMonth, monthRange } = require('../db');
const { requireStaff, requireAny, requireAdmin, MODULES, MODULE_GROUPS, MODULE_KEYS, parsePermissions } = require('../auth');
const notify = require('../notify');
const rotation = require('../rotation');

const router = express.Router();

// ---- 帳號 ----

router.get('/modules', requireStaff(), (req, res) => res.json({ modules: MODULES, groups: MODULE_GROUPS }));

router.get('/users', requireStaff('users'), (req, res) => {
  res.json(db.prepare(`SELECT u.id,u.username,u.name,u.role,u.title,u.store_id,u.permissions,
      u.readonly_modules,u.active,u.created_at, s.name AS store_name
    FROM users u LEFT JOIN stores s ON s.id = u.store_id ORDER BY u.id`).all()
    .map(u => ({ ...u, permissions: parsePermissions(u.permissions), readonly_modules: parsePermissions(u.readonly_modules) })));
});

function pickPerms(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return JSON.stringify(arr.map(x => String(x).trim()).filter(k => MODULE_KEYS.includes(k)));
}

router.post('/users', requireStaff('users'), (req, res) => {
  const b = req.body || {};
  if (!b.username || !b.name) return res.status(400).json({ error: '請填寫帳號與姓名' });
  if (!b.password || String(b.password).length < 6) return res.status(400).json({ error: '密碼至少 6 碼' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(b.username)) {
    return res.status(400).json({ error: '這個帳號已經存在' });
  }
  if (b.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: '只有管理員能建立管理員帳號' });
  const info = db.prepare(`INSERT INTO users(username,password_hash,name,role,title,store_id,permissions,readonly_modules)
    VALUES(?,?,?,?,?,?,?,?)`).run(String(b.username).trim(), bcrypt.hashSync(String(b.password), 10),
      String(b.name).trim(), b.role === 'admin' ? 'admin' : 'staff', String(b.title || ''),
      b.store_id ? Number(b.store_id) : null, pickPerms(b.permissions), pickPerms(b.readonly_modules));
  audit('staff', req.user.id, req.user.name, `新增帳號：${b.username}（${b.name}）`);
  res.json({ id: info.lastInsertRowid });
});

router.put('/users/:id', requireStaff('users'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '找不到這個帳號' });
  const b = req.body || {};
  if (u.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: '只有管理員能修改管理員帳號' });
  const sets = [], args = [];
  if (b.name !== undefined) { sets.push('name = ?'); args.push(String(b.name).trim()); }
  if (b.title !== undefined) { sets.push('title = ?'); args.push(String(b.title)); }
  if (b.store_id !== undefined) { sets.push('store_id = ?'); args.push(b.store_id ? Number(b.store_id) : null); }
  if (b.permissions !== undefined) { sets.push('permissions = ?'); args.push(pickPerms(b.permissions)); }
  if (b.readonly_modules !== undefined) { sets.push('readonly_modules = ?'); args.push(pickPerms(b.readonly_modules)); }
  if (b.active !== undefined) {
    // 不能把最後一個管理員停用，否則沒有人進得去了
    if (!Number(b.active) && u.role === 'admin') {
      const n = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(u.id).n;
      if (!n) return res.status(400).json({ error: '這是最後一個啟用中的管理員帳號，不能停用' });
    }
    sets.push('active = ?'); args.push(Number(b.active) ? 1 : 0);
  }
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: '密碼至少 6 碼' });
    sets.push('password_hash = ?'); args.push(bcrypt.hashSync(String(b.password), 10));
  }
  if (b.role !== undefined && req.user.role === 'admin') { sets.push('role = ?'); args.push(b.role === 'admin' ? 'admin' : 'staff'); }
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, u.id);
  audit('staff', req.user.id, req.user.name, `修改帳號：${u.username}${b.password ? '（含重設密碼）' : ''}`);
  res.json({ ok: true });
});

// ---- 設定 ----

router.get('/settings', requireStaff('settings'), (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  res.json({
    settings: Object.fromEntries(rows.map(r => [r.key, r.value])),
    list_keys: Object.keys(LIST_KEYS),
    ui_text_keys: UI_TEXT_KEYS
  });
});

router.put('/settings', requireStaff('settings'), (req, res) => {
  const b = req.body || {};
  const changed = [];
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'object') continue;
    const old = getSetting(k, null);
    if (old === String(v ?? '')) continue;
    setSetting(k, v);
    changed.push(k);
  }
  if (changed.length) audit('staff', req.user.id, req.user.name, `修改系統設定：${changed.join('、')}`);
  res.json({ ok: true, changed });
});

// ---- 稽核 ----
router.get('/audit', requireStaff('audit'), (req, res) => {
  const where = [], args = [];
  if (req.query.from) { where.push('created_at >= ?'); args.push(req.query.from + ' 00:00'); }
  if (req.query.to) { where.push('created_at <= ?'); args.push(req.query.to + ' 23:59'); }
  const q = (req.query.q || '').trim();
  if (q) { where.push('(action LIKE ? OR actor_name LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  res.json(db.prepare(`SELECT * FROM audit_logs${where.length ? ' WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT 500`).all(...args));
});

// ---- 通知紀錄 ----
router.get('/notifications', requireStaff('notifications'), (req, res) => {
  const where = [], args = [];
  if (req.query.status) { where.push('status = ?'); args.push(req.query.status); }
  if (req.query.target_type) { where.push('target_type = ?'); args.push(req.query.target_type); }
  if (req.query.date) { where.push('substr(created_at,1,10) = ?'); args.push(req.query.date); }
  res.json(db.prepare(`SELECT * FROM notifications${where.length ? ' WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT 300`).all(...args));
});

router.get('/notifications/enabled', requireStaff(), (req, res) => res.json({ enabled: notify.enabled() }));

// 技師班表通知：把當日預約與客人注意事項一次推給技師
router.post('/notifications/therapist', requireAny('notifications', 'queue'), async (req, res) => {
  const id = Number(req.body?.therapist_id);
  const built = notify.therapistText(id, req.body?.work_date);
  if (!built) return res.status(404).json({ error: '找不到這位技師' });
  const r = await notify.send({ targetType: 'therapist', targetId: id, targetName: built.therapist.name,
    lineUid: built.therapist.line_uid, title: '今日班表', body: built.text });
  audit('staff', req.user.id, req.user.name, `發送班表通知給 ${built.therapist.name}（${r.status}）`);
  res.json({ ...r, text: built.text });
});

// ---- 客訴與異常 ----

router.get('/issues', requireStaff('issues'), (req, res) => {
  const where = [], args = [];
  for (const k of ['status', 'category', 'severity', 'therapist_id', 'member_id', 'store_id']) {
    if (req.query[k]) { where.push(`i.${k} = ?`); args.push(req.query[k]); }
  }
  const q = (req.query.q || '').trim();
  if (q) { where.push('(i.title LIKE ? OR i.detail LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  res.json(db.prepare(`SELECT i.*, m.name AS member_name, th.name AS therapist_name, t.ticket_no
    FROM issues i
    LEFT JOIN members m ON m.id = i.member_id
    LEFT JOIN therapists th ON th.id = i.therapist_id
    LEFT JOIN tickets t ON t.id = i.ticket_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (i.status <> 'closed') DESC, i.id DESC LIMIT 300`).all(...args));
});

const ISSUE_FIELDS = ['store_id', 'happen_date', 'category', 'severity', 'member_id', 'therapist_id',
  'ticket_id', 'title', 'detail', 'handling', 'compensation', 'status', 'owner'];

router.post('/issues', requireStaff('issues'), (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: '請填寫事件標題' });
  const d = { issue_no: nextSerial('IS'), happen_date: b.happen_date || today() };
  for (const f of ISSUE_FIELDS) {
    if (b[f] === undefined) continue;
    if (['store_id', 'member_id', 'therapist_id', 'ticket_id'].includes(f)) d[f] = b[f] ? Number(b[f]) : null;
    else if (f === 'compensation') d[f] = yuan(b[f]);
    else d[f] = String(b[f]).trim();
  }
  const keys = Object.keys(d);
  const info = db.prepare(`INSERT INTO issues(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => d[k]));
  audit('staff', req.user.id, req.user.name, `新增客訴／異常：${d.title}`);
  res.json(db.prepare('SELECT * FROM issues WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/issues/:id', requireStaff('issues'), (req, res) => {
  const cur = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這筆紀錄' });
  const b = req.body || {};
  const d = {};
  for (const f of ISSUE_FIELDS) {
    if (b[f] === undefined) continue;
    if (['store_id', 'member_id', 'therapist_id', 'ticket_id'].includes(f)) d[f] = b[f] ? Number(b[f]) : null;
    else if (f === 'compensation') d[f] = yuan(b[f]);
    else d[f] = String(b[f]).trim();
  }
  if (d.status === 'closed' && cur.status !== 'closed') d.closed_at = nowStamp();
  const keys = Object.keys(d);
  if (keys.length) {
    db.prepare(`UPDATE issues SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map(k => d[k]), cur.id);
  }
  audit('staff', req.user.id, req.user.name, `更新客訴／異常：${cur.title}`);
  res.json(db.prepare('SELECT * FROM issues WHERE id = ?').get(cur.id));
});

// ---- 線上預約 ----

router.get('/bookings', requireStaff('bookings'), (req, res) => {
  const where = [], args = [];
  if (req.query.status) { where.push('b.status = ?'); args.push(req.query.status); }
  if (req.query.store_id) { where.push('b.store_id = ?'); args.push(req.query.store_id); }
  res.json(db.prepare(`SELECT b.*, s.name AS service_name, th.name AS therapist_name, st.name AS store_name
    FROM bookings b
    LEFT JOIN services s ON s.id = b.service_id
    LEFT JOIN therapists th ON th.id = b.therapist_id
    LEFT JOIN stores st ON st.id = b.store_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (b.status = 'new') DESC, b.id DESC LIMIT 300`).all(...args));
});

router.put('/bookings/:id', requireStaff('bookings'), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: '找不到這筆預約' });
  const d = req.body || {};
  const sets = [], args = [];
  // 客人自己打的 note 是「他當初送出什麼」的憑據，內勤不能改；聯繫過程寫在 staff_note。
  for (const [f, v] of Object.entries({ status: d.status, staff_note: d.staff_note })) {
    if (v !== undefined) { sets.push(`${f} = ?`); args.push(String(v)); }
  }
  if (d.therapist_id !== undefined) { sets.push('therapist_id = ?'); args.push(d.therapist_id ? Number(d.therapist_id) : null); }
  if (sets.length) db.prepare(`UPDATE bookings SET ${sets.join(', ')} WHERE id = ?`).run(...args, b.id);
  audit('staff', req.user.id, req.user.name, `更新線上預約 ${b.booking_no}`);
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id));
});

// ---- CSV 匯出 ----
// 畫面上篩到什麼就匯出什麼：查詢條件跟清單 API 一致。
function csv(res, filename, headers, rows) {
  const esc = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers.map(h => esc(h[0])).join(',')]
    .concat(rows.map(r => headers.map(h => esc(typeof h[1] === 'function' ? h[1](r) : r[h[1]])).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}-${today()}.csv"`);
  // BOM：Excel 沒有它就會把中文顯示成亂碼，使用者只會說「你的匯出壞了」
  res.send('﻿' + body);
}

const EXPORTS = {
  tickets: {
    module: 'tickets',
    run(q) {
      const where = [], args = [];
      const dateExpr = "substr(COALESCE(NULLIF(t.actual_start,''), t.start_at),1,10)";
      if (q.from) { where.push(`${dateExpr} >= ?`); args.push(q.from); }
      if (q.to) { where.push(`${dateExpr} <= ?`); args.push(q.to); }
      if (q.status) { where.push('t.status = ?'); args.push(q.status); }
      if (q.therapist_id) { where.push('t.therapist_id = ?'); args.push(q.therapist_id); }
      return db.prepare(`SELECT t.*, COALESCE(m.name, t.guest_name) AS customer, th.name AS therapist_name,
          r.name AS room_name FROM tickets t
        LEFT JOIN members m ON m.id = t.member_id
        LEFT JOIN therapists th ON th.id = t.therapist_id
        LEFT JOIN rooms r ON r.id = t.room_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.start_at`).all(...args);
    },
    headers: [['單號', 'ticket_no'], ['日期時間', 'start_at'], ['客人', 'customer'], ['技師', 'therapist_name'],
      ['項目', 'service_name'], ['分鐘', 'minutes'], ['指名', r => r.assign_type === 'designated' ? '指名' : '輪鐘'],
      ['床位', 'room_name'], ['服務金額', 'amount'], ['商品', 'retail_amount'], ['折扣', 'discount'],
      ['應收', 'net_amount'], ['現金', 'paid_cash'], ['儲值', 'paid_wallet'], ['次卡', 'paid_pass'],
      ['服務抽成', 'comm_service'], ['商品抽成', 'comm_retail'], ['指名費', 'comm_designate'], ['狀態', 'status']]
  },
  payroll: {
    module: 'payroll',
    run(q) {
      return db.prepare(`SELECT p.*, t.name, t.code, t.level FROM payrolls p
        JOIN therapists t ON t.id = p.therapist_id WHERE p.period = ? ORDER BY p.total DESC`)
        .all(q.period || thisMonth());
    },
    headers: [['月份', 'period'], ['編號', 'code'], ['技師', 'name'], ['級別', 'level'], ['底薪', 'base_salary'],
      ['鐘數', 'ticket_count'], ['指名數', 'designate_count'], ['服務分鐘', 'minutes_total'],
      ['服務業績', 'service_amount'], ['指名業績', 'designated_amount'], ['銷售業績', 'retail_amount'],
      ['服務抽成', 'comm_service'], ['銷售抽成', 'comm_retail'], ['指名費', 'comm_designate'],
      ['級距獎金', 'tier_bonus'], ['加項', 'adjust'], ['扣項', 'deduction'], ['合計', 'total'], ['狀態', 'status']]
  },
  members: {
    module: 'members',
    run() {
      return db.prepare(`SELECT m.*, COALESCE(w.cash_balance,0) AS wallet_cash,
          COALESCE(w.bonus_balance,0) AS wallet_bonus,
          (SELECT COUNT(*) FROM tickets t WHERE t.member_id = m.id AND t.status='done') AS visits,
          (SELECT COALESCE(SUM(t.net_amount),0) FROM tickets t WHERE t.member_id = m.id AND t.status='done') AS total_spent
        FROM members m LEFT JOIN wallets w ON w.member_id = m.id WHERE m.active = 1 ORDER BY m.id`).all();
    },
    headers: [['客編', 'member_no'], ['姓名', 'name'], ['電話', 'phone'], ['性別', 'gender'], ['生日', 'birthday'],
      ['來源', 'source'], ['標籤', 'tags'], ['力道', 'pressure_pref'], ['禁忌部位', 'avoid_parts'],
      ['身體狀況', 'conditions'], ['問診更新', 'health_updated_at'], ['儲值現金', 'wallet_cash'],
      ['儲值贈送', 'wallet_bonus'], ['到店次數', 'visits'], ['累計消費', 'total_spent']]
  },
  wallet_txns: {
    module: 'wallets',
    run(q) {
      const where = [], args = [];
      if (q.from) { where.push('substr(x.created_at,1,10) >= ?'); args.push(q.from); }
      if (q.to) { where.push('substr(x.created_at,1,10) <= ?'); args.push(q.to); }
      if (q.member_id) { where.push('x.member_id = ?'); args.push(q.member_id); }
      return db.prepare(`SELECT x.*, m.name AS member_name FROM wallet_txns x
        LEFT JOIN members m ON m.id = x.member_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY x.id`).all(...args);
    },
    headers: [['時間', 'created_at'], ['客人', 'member_name'], ['類型', 'kind'], ['現金增減', 'cash_delta'],
      ['贈送增減', 'bonus_delta'], ['金額', 'amount'], ['現金餘額', 'cash_after'], ['贈送餘額', 'bonus_after'],
      ['說明', 'note'], ['經手', 'actor']]
  },
  passes: {
    module: 'passes',
    run() {
      return db.prepare(`SELECT p.*, m.name AS member_name, s.name AS service_name FROM passes p
        LEFT JOIN members m ON m.id = p.member_id LEFT JOIN services s ON s.id = p.service_id
        ORDER BY p.id`).all();
    },
    headers: [['卡號', 'pass_no'], ['客人', 'member_name'], ['品名', 'name'], ['綁定項目', 'service_name'],
      ['總次數', 'total_times'], ['已用', 'used_times'], ['剩餘', r => r.total_times - r.used_times],
      ['實付', 'price_paid'], ['原價值', 'list_value'], ['購買日', 'buy_date'], ['到期日', 'expiry_date'], ['狀態', 'status']]
  },
  queue_logs: {
    module: 'queue',
    run(q) {
      const where = [], args = [];
      if (q.from) { where.push('work_date >= ?'); args.push(q.from); }
      if (q.to) { where.push('work_date <= ?'); args.push(q.to); }
      if (q.therapist_id) { where.push('therapist_id = ?'); args.push(q.therapist_id); }
      return db.prepare(`SELECT * FROM queue_logs${where.length ? ' WHERE ' + where.join(' AND ') : ''}
        ORDER BY id`).all(...args);
    },
    headers: [['日期', 'work_date'], ['時間', 'created_at'], ['技師', 'therapist_name'], ['事件', 'event'],
      ['鐘單', 'ticket_id'], ['序號前', 'seq_before'], ['序號後', 'seq_after'],
      ['輪次前', 'rounds_before'], ['輪次後', 'rounds_after'], ['原因', 'reason'], ['經手', 'actor']]
  },
  attendance: {
    module: 'attendance',
    run(q) {
      return db.prepare(`SELECT s.*, t.name, t.code FROM shifts s JOIN therapists t ON t.id = s.therapist_id
        WHERE s.work_date >= ? AND s.work_date <= ? ORDER BY s.work_date, s.queue_seq`)
        .all(q.from || today(), q.to || q.from || today());
    },
    headers: [['日期', 'work_date'], ['編號', 'code'], ['技師', 'name'], ['簽到序', 'queue_seq'],
      ['已輪次數', 'rounds'], ['簽到', 'checkin_at'], ['簽退', 'checkout_at'], ['狀態', 'status']]
  },
  expenses: {
    module: 'expenses',
    run(q) {
      return db.prepare(`SELECT e.*, s.name AS store_name FROM expenses e LEFT JOIN stores s ON s.id = e.store_id
        WHERE e.spend_date >= ? AND e.spend_date <= ? ORDER BY e.spend_date`)
        .all(q.from || monthRange(thisMonth()).start, q.to || today());
    },
    headers: [['日期', 'spend_date'], ['門市', 'store_name'], ['科目', 'category'], ['對象', 'vendor'],
      ['金額', 'amount'], ['付款', 'pay_method'], ['備註', 'note']]
  }
};

router.get('/export/:dataset', requireStaff(), (req, res) => {
  const spec = EXPORTS[req.params.dataset];
  if (!spec) return res.status(404).json({ error: '沒有這個匯出項目' });
  if (req.user.role !== 'admin' && !req.userModules.includes(spec.module)) {
    return res.status(403).json({ error: '無此模組使用權限' });
  }
  const rows = spec.run(req.query || {});
  audit('staff', req.user.id, req.user.name, `匯出 ${req.params.dataset}（${rows.length} 筆）`);
  csv(res, req.params.dataset, spec.headers, rows);
});

module.exports = router;
