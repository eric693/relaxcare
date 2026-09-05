// 主檔：分店、技師、床位、服務項目、商品、客人。
// 前五張表的存取形狀一樣，交給 crud.js 產生；客人多了健康問診與消費歷程，另外寫。
const express = require('express');
const { db, audit, getList, LIST_KEYS, nowStamp, today, nextSerial, yuan } = require('../db');
const { requireStaff, requireAny } = require('../auth');
const { attach } = require('../crud');
const { levelRates } = require('../db');
const prepaid = require('../prepaid');

const router = express.Router();

// ---- 共用下拉選項 ----
// 幾乎每個頁面都要「技師清單」「服務清單」，各自去查會讓側欄一切換就打五六支 API。
router.get('/options', requireStaff(), (req, res) => {
  const lists = {};
  for (const k of Object.keys(LIST_KEYS)) lists[k] = getList(k);
  res.json({
    stores: db.prepare('SELECT id,code,name,open_time,close_time FROM stores WHERE active = 1 ORDER BY id').all(),
    therapists: db.prepare('SELECT id,code,name,nickname,level,gender,store_id,skills,is_blind FROM therapists WHERE active = 1 ORDER BY code, name').all(),
    rooms: db.prepare('SELECT id,name,rtype,capacity,store_id FROM rooms WHERE active = 1 ORDER BY store_id, seq, name').all(),
    services: db.prepare(`SELECT id,code,name,category,minutes,price,list_price,member_price,is_package,
      package_items,room_type,contraindications FROM services WHERE active = 1 ORDER BY seq, category, name`).all(),
    addons: db.prepare('SELECT id,code,name,category,minutes,list_price,price,member_price,requires_therapist FROM addons WHERE active = 1 ORDER BY seq, category, name').all(),
    retail_products: db.prepare('SELECT id,sku,name,category,price,stock FROM retail_products WHERE active = 1 ORDER BY category, name').all(),
    members: db.prepare('SELECT id,member_no,name,phone,fav_therapist_id FROM members WHERE active = 1 ORDER BY name').all(),
    staff: db.prepare("SELECT id,name FROM users WHERE active = 1 ORDER BY name").all(),
    level_rates: levelRates(),
    voucher_platforms: require('../db').getSetting('voucher_platforms', '').split('\n').map(x => x.trim()).filter(Boolean),
    // 伺服器的「現在」。前端拿它跟自己的時鐘對時 ——
    // 櫃檯平板的時區設錯或時鐘不準時，畫面上的「今天」不能跟著錯。
    server_now: require('../db').nowStamp(),
    server_date: require('../db').today(),
    business_day_start: require('../db').getSetting('business_day_start', '04:00'),
    board_hours: Number(require('../db').getSetting('board_hours', '24')) || 24,
    lists
  });
});

// ---- 主檔 CRUD ----

attach(router, {
  table: 'stores', module: 'stores', label: '分店',
  fields: ['code', 'name', 'phone', 'address', 'open_time', 'close_time', 'cross_store_pct', 'note'],
  nums: ['cross_store_pct'], search: ['name', 'code', 'address'], order: 'id'
});

attach(router, {
  table: 'therapists', module: 'therapists', label: '技師',
  fields: ['code', 'name', 'nickname', 'gender', 'phone', 'line_uid', 'store_id', 'level', 'hire_date',
    'leave_date', 'employ_type', 'base_salary', 'pct_normal', 'pct_designated', 'pct_retail',
    'designate_fee', 'skills', 'cert_no', 'cert_expiry', 'health_check_date', 'health_check_expiry',
    'is_blind', 'note'],
  nums: ['base_salary', 'pct_normal', 'pct_designated', 'pct_retail', 'designate_fee', 'is_blind'],
  ids: ['store_id'], search: ['name', 'code', 'nickname', 'phone'], order: 'code, name',
  validate(d) {
    for (const [f, label] of [['pct_normal', '輪鐘抽成'], ['pct_designated', '指名抽成'], ['pct_retail', '商品抽成']]) {
      if (d[f] !== undefined && (d[f] < 0 || d[f] > 100)) return `${label}％要在 0~100 之間`;
    }
    return null;
  },
  beforeDelete(cur) {
    const n = db.prepare("SELECT COUNT(*) n FROM tickets WHERE therapist_id = ? AND status IN ('booked','serving')").get(cur.id).n;
    return n ? `這位技師還有 ${n} 張未完成的鐘單，請先處理` : null;
  }
});

attach(router, {
  table: 'rooms', module: 'rooms', label: '床位／包廂',
  fields: ['store_id', 'name', 'rtype', 'capacity', 'seq', 'note'],
  nums: ['capacity', 'seq'], ids: ['store_id'], search: ['name', 'rtype'], order: 'store_id, seq, name'
});

attach(router, {
  table: 'services', module: 'services', label: '服務項目',
  fields: ['code', 'name', 'category', 'minutes', 'list_price', 'price', 'member_price', 'room_type',
    'pct_normal', 'pct_designated', 'contraindications', 'buffer_min', 'description', 'seq',
    'is_package', 'package_items'],
  nums: ['minutes', 'list_price', 'price', 'member_price', 'pct_normal', 'pct_designated', 'buffer_min', 'seq', 'is_package'],
  search: ['name', 'code', 'category'], order: 'seq, category, name',
  validate(d) {
    if (d.minutes !== undefined && d.minutes <= 0) return '服務時長要大於 0 分鐘';
    // 牌價低於現場價的話，折扣率會算出負數，畫面上會出現「折 -12%」這種東西
    if (d.list_price && d.price && d.list_price < d.price) return '牌價不應低於現場價';
    if (d.member_price && d.price && d.member_price > d.price) return '會員價不應高於現場價';
    if (d.is_package && !String(d.package_items || '').trim()) return '組合套票必須指定包含哪些服務項目';
    return null;
  }
});

// 加購品主檔。原本刮痧、拔罐這些只能在鐘單上自由輸入，
// 結果每個櫃檯打出來的名字都不一樣，月底統計不出「刮痧到底賣了幾次」。
attach(router, {
  table: 'addons', module: 'addons', label: '加購品',
  fields: ['code', 'name', 'category', 'minutes', 'list_price', 'price', 'member_price',
    'pct_commission', 'requires_therapist', 'note', 'seq'],
  nums: ['minutes', 'list_price', 'price', 'member_price', 'pct_commission', 'requires_therapist', 'seq'],
  search: ['name', 'code', 'category'], order: 'seq, category, name',
  validate(d) {
    if (d.price !== undefined && d.price < 0) return '價格不能是負數';
    if (d.member_price && d.price && d.member_price > d.price) return '會員價不應高於現場價';
    return null;
  }
});

attach(router, {
  table: 'retail_products', module: 'retail', label: '商品',
  fields: ['sku', 'name', 'category', 'price', 'cost', 'pct_retail', 'stock', 'safety_stock', 'note'],
  nums: ['price', 'cost', 'pct_retail', 'stock', 'safety_stock'],
  search: ['name', 'sku', 'category'], order: 'category, name'
});

// ---- 客人 ----

const MEMBER_FIELDS = ['member_no', 'name', 'phone', 'line_uid', 'gender', 'birthday', 'store_id', 'source',
  'tags', 'fav_therapist_id', 'pressure_pref', 'avoid_parts', 'conditions', 'health_note',
  'consent_at', 'blacklist', 'blacklist_reason', 'referrer_id', 'note'];

function pickMember(b) {
  const o = {};
  for (const f of MEMBER_FIELDS) {
    if (b[f] === undefined) continue;
    if (['store_id', 'fav_therapist_id', 'referrer_id'].includes(f)) o[f] = (b[f] === '' || b[f] === null) ? null : (Number(b[f]) || null);
    else if (f === 'blacklist') o[f] = Number(b[f]) ? 1 : 0;
    else o[f] = String(b[f]).trim();
  }
  return o;
}

router.get('/members', requireAny('members', 'tickets', 'wallets', 'passes', 'repurchase'), (req, res) => {
  const where = ['m.active = ?'], args = [req.query.active === '0' ? 0 : 1];
  if (req.query.active === 'all') { where.length = 0; args.length = 0; }
  const q = (req.query.q || '').trim();
  if (q) { where.push('(m.name LIKE ? OR m.phone LIKE ? OR m.member_no LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (req.query.store_id) { where.push('m.store_id = ?'); args.push(req.query.store_id); }
  if (req.query.blacklist) { where.push('m.blacklist = ?'); args.push(Number(req.query.blacklist) ? 1 : 0); }
  if (req.query.tag) { where.push('m.tags LIKE ?'); args.push(`%${req.query.tag}%`); }
  const rows = db.prepare(`
    SELECT m.*, th.name AS fav_therapist_name,
           COALESCE(w.cash_balance,0) AS wallet_cash, COALESCE(w.bonus_balance,0) AS wallet_bonus,
           (SELECT COUNT(*) FROM passes p WHERE p.member_id = m.id AND p.status = 'active') AS pass_count,
           (SELECT COUNT(*) FROM tickets t WHERE t.member_id = m.id AND t.status = 'done') AS visits,
           (SELECT COALESCE(SUM(t.net_amount),0) FROM tickets t WHERE t.member_id = m.id AND t.status = 'done') AS total_spent,
           (SELECT MAX(COALESCE(NULLIF(t.actual_start,''), t.start_at)) FROM tickets t
             WHERE t.member_id = m.id AND t.status = 'done') AS last_visit
    FROM members m
    LEFT JOIN therapists th ON th.id = m.fav_therapist_id
    LEFT JOIN wallets w ON w.member_id = m.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY m.id DESC`).all(...args);
  res.json(rows);
});

router.get('/members/:id', requireAny('members', 'tickets', 'wallets', 'passes'), (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '找不到這位客人' });
  const tickets = db.prepare(`
    SELECT t.id, t.ticket_no, t.service_name, t.minutes, t.start_at, t.actual_start, t.status,
           t.assign_type, t.net_amount, t.rating, t.feedback, th.name AS therapist_name
    FROM tickets t LEFT JOIN therapists th ON th.id = t.therapist_id
    WHERE t.member_id = ? ORDER BY COALESCE(NULLIF(t.actual_start,''), t.start_at) DESC LIMIT 100`).all(req.params.id);
  // 常做的項目與常指名的技師：換技師接手時，這兩件事比病歷還實用
  const favServices = db.prepare(`SELECT service_name AS name, COUNT(*) AS n FROM tickets
    WHERE member_id = ? AND status = 'done' GROUP BY service_name ORDER BY n DESC LIMIT 5`).all(req.params.id);
  const favTherapists = db.prepare(`SELECT th.name, COUNT(*) AS n,
      SUM(CASE WHEN t.assign_type='designated' THEN 1 ELSE 0 END) AS designated
    FROM tickets t JOIN therapists th ON th.id = t.therapist_id
    WHERE t.member_id = ? AND t.status = 'done' GROUP BY th.id ORDER BY n DESC LIMIT 5`).all(req.params.id);
  res.json({
    member: m,
    wallet: prepaid.walletBalance(m.id),
    wallet_txns: db.prepare('SELECT * FROM wallet_txns WHERE member_id = ? ORDER BY id DESC LIMIT 50').all(m.id),
    passes: db.prepare(`SELECT p.*, s.name AS service_name FROM passes p
      LEFT JOIN services s ON s.id = p.service_id WHERE p.member_id = ? ORDER BY p.id DESC`).all(m.id)
      .map(p => ({ ...p, remain: p.total_times - p.used_times, real_status: prepaid.passStatus(p) })),
    tickets, fav_services: favServices, fav_therapists: favTherapists,
    // 集點、介紹關係、同意書與照片：換技師接手、或客人問「我還有幾點」時要立刻答得出來
    points: {
      balance: require('../loyalty').balanceOf(m.id),
      txns: require('../loyalty').txnsOf(m.id, 20),
      rules: require('../loyalty').summary().rules
    },
    referrer: m.referrer_id ? db.prepare('SELECT id,name,phone FROM members WHERE id = ?').get(m.referrer_id) : null,
    referred: require('../loyalty').referrals({ memberId: m.id }),
    consent: require('../consent').statusOf(m.id),
    consents: require('../consent').listFor(m.id),
    photos: require('../storage').listFor('member', m.id),
    stats: {
      visits: tickets.filter(t => t.status === 'done').length,
      total_spent: yuan(tickets.filter(t => t.status === 'done').reduce((s, t) => s + t.net_amount, 0))
    }
  });
});

router.post('/members', requireAny('members', 'tickets'), (req, res) => {
  const d = pickMember(req.body || {});
  if (!d.name) return res.status(400).json({ error: '請填寫客人姓名' });
  if (!d.member_no) d.member_no = nextSerial('M');
  // 電話重複多半是同一個人又被建了一次；不擋，但要講出來
  if (d.phone) {
    const dup = db.prepare('SELECT id, name FROM members WHERE phone = ? AND active = 1').get(d.phone);
    if (dup) return res.status(400).json({ error: `電話 ${d.phone} 已存在於「${dup.name}」（客編 ${dup.id}），請直接使用該筆資料` });
  }
  if (d.conditions || d.health_note || d.pressure_pref || d.avoid_parts) d.health_updated_at = nowStamp();
  const keys = Object.keys(d);
  const info = db.prepare(`INSERT INTO members(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => d[k]));
  audit('staff', req.user.id, req.user.name, `新增客人：${d.name}`);
  res.json(db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/members/:id', requireAny('members', 'tickets'), (req, res) => {
  const cur = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這位客人' });
  const d = pickMember(req.body || {});
  // 健康相關欄位有動過就更新時間戳。這個時間戳是「問診紀錄多久沒更新」的依據，
  // 順手改個電話不該讓它看起來像剛問過診。
  const healthFields = ['conditions', 'health_note', 'pressure_pref', 'avoid_parts'];
  if (healthFields.some(f => d[f] !== undefined && d[f] !== cur[f])) d.health_updated_at = nowStamp();
  const keys = Object.keys(d);
  if (keys.length) {
    db.prepare(`UPDATE members SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map(k => d[k]), req.params.id);
  }
  audit('staff', req.user.id, req.user.name, `修改客人：${cur.name}`);
  res.json(db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id));
});

// 客人照片。上傳一律經過 storage 的回讀驗證，驗不過就回 400，不會有「顯示成功、檔案是壞的」。
router.post('/members/:id/photo', requireAny('members', 'tickets'), (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '找不到這位客人' });
  const storage = require('../storage');
  const a = storage.save({
    dataUrl: req.body?.data, filename: req.body?.filename || `member-${m.id}.jpg`,
    ownerType: 'member', ownerId: m.id, kind: 'photo',
    note: req.body?.note || '', actor: req.user.name
  });
  // 設為大頭照（舊的照片留著，只是不再是主要那張）
  db.prepare('UPDATE members SET photo_id = ? WHERE id = ?').run(a.id, m.id);
  audit('staff', req.user.id, req.user.name, `上傳客人照片：${m.name}（已通過完整性驗證）`);
  res.json({ ...a, photos: storage.listFor('member', m.id) });
});

router.delete('/members/:id/photo/:photoId', requireStaff('members'), (req, res) => {
  const storage = require('../storage');
  const ok = storage.remove(Number(req.params.photoId), req.user.name);
  if (!ok) return res.status(404).json({ error: '找不到這張照片' });
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (m && String(m.photo_id) === String(req.params.photoId)) {
    const rest = storage.listFor('member', m.id);
    db.prepare('UPDATE members SET photo_id = ? WHERE id = ?').run(rest[0]?.id || null, m.id);
  }
  res.json({ ok: true, photos: storage.listFor('member', req.params.id) });
});

router.delete('/members/:id', requireStaff('members'), (req, res) => {
  const cur = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這位客人' });
  const w = prepaid.walletBalance(cur.id);
  if (w.total > 0) return res.status(400).json({ error: `這位客人還有儲值餘額 ${w.total} 元，請先退款或轉讓` });
  const p = db.prepare("SELECT COUNT(*) n FROM passes WHERE member_id = ? AND status = 'active'").get(cur.id).n;
  if (p) return res.status(400).json({ error: `這位客人還有 ${p} 張使用中的次卡，請先處理` });
  db.prepare('UPDATE members SET active = 0 WHERE id = ?').run(req.params.id);
  audit('staff', req.user.id, req.user.name, `停用客人：${cur.name}`);
  res.json({ ok: true });
});

// 問診：獨立端點，因為它會被開單畫面直接呼叫（不必進客人檔案）
router.put('/members/:id/health', requireAny('members', 'tickets'), (req, res) => {
  const cur = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這位客人' });
  const b = req.body || {};
  db.prepare(`UPDATE members SET pressure_pref = ?, avoid_parts = ?, conditions = ?, health_note = ?,
              consent_at = CASE WHEN ? <> '' THEN ? ELSE consent_at END, health_updated_at = ? WHERE id = ?`)
    .run(String(b.pressure_pref || ''), String(b.avoid_parts || ''), String(b.conditions || ''),
      String(b.health_note || ''), b.consent ? nowStamp() : '', b.consent ? nowStamp() : '',
      nowStamp(), req.params.id);
  audit('staff', req.user.id, req.user.name, `更新客人問診紀錄：${cur.name}`);
  res.json(db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id));
});

module.exports = router;
