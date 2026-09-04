// 輪鐘檯與出勤。畫面上最常被按的幾個鍵都在這裡：簽到、休息、恢復、下班、調整輪序。
const express = require('express');
const { db, today, thisMonth, monthRange, audit, num, yuan } = require('../db');
const { requireStaff, requireAny } = require('../auth');
const rotation = require('../rotation');

const router = express.Router();
const actorOf = req => req.user.name;

router.get('/queue', requireAny('queue', 'tickets', 'board', 'dashboard'), (req, res) => {
  res.json(rotation.board(req.query.date || today(), req.query.store_id ? Number(req.query.store_id) : null));
});

// 還沒簽到的技師（簽到面板要列出來讓人點）
router.get('/queue/absent', requireAny('queue', 'attendance'), (req, res) => {
  const d = req.query.date || today();
  const sid = req.query.store_id ? Number(req.query.store_id) : null;
  const rows = db.prepare(`SELECT t.id, t.code, t.name, t.nickname, t.level, t.store_id
    FROM therapists t
    WHERE t.active = 1 AND (? IS NULL OR t.store_id = ?)
      AND t.id NOT IN (SELECT therapist_id FROM shifts WHERE work_date = ?)
    ORDER BY t.code, t.name`).all(sid, sid, d);
  res.json(rows);
});

router.post('/queue/checkin', requireStaff('queue'), (req, res) => {
  const { therapist_id, work_date, store_id } = req.body || {};
  const s = rotation.checkin({ therapistId: Number(therapist_id), workDate: work_date, storeId: store_id ? Number(store_id) : null, actor: actorOf(req) });
  audit('staff', req.user.id, req.user.name, `技師簽到：#${therapist_id}（第 ${s.queue_seq} 號）`);
  res.json(s);
});

router.post('/queue/checkout', requireStaff('queue'), (req, res) => {
  const { therapist_id, work_date, reason } = req.body || {};
  res.json(rotation.checkout({ therapistId: Number(therapist_id), workDate: work_date, reason, actor: actorOf(req) }));
});

router.post('/queue/rest', requireStaff('queue'), (req, res) => {
  const { therapist_id, work_date, minutes, reason } = req.body || {};
  res.json(rotation.rest({ therapistId: Number(therapist_id), workDate: work_date, minutes, reason, actor: actorOf(req) }));
});

router.post('/queue/resume', requireStaff('queue'), (req, res) => {
  const { therapist_id, work_date } = req.body || {};
  res.json(rotation.resume({ therapistId: Number(therapist_id), workDate: work_date, actor: actorOf(req) }));
});

router.post('/queue/adjust', requireStaff('queue'), (req, res) => {
  const { therapist_id, work_date, queue_seq, rounds, reason } = req.body || {};
  const s = rotation.adjust({ therapistId: Number(therapist_id), workDate: work_date, queueSeq: queue_seq, rounds, reason, actor: actorOf(req) });
  audit('staff', req.user.id, req.user.name, `人工調整輪序：技師 #${therapist_id} → 第 ${s.queue_seq} 號／已輪 ${s.rounds} 次（${reason}）`);
  res.json(s);
});

// 輪序軌跡。這是吵架時拿出來的東西，所以要能篩日期與技師。
router.get('/queue/logs', requireAny('queue', 'audit'), (req, res) => {
  const where = [], args = [];
  if (req.query.date) { where.push('work_date = ?'); args.push(req.query.date); }
  if (req.query.from) { where.push('work_date >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('work_date <= ?'); args.push(req.query.to); }
  if (req.query.therapist_id) { where.push('therapist_id = ?'); args.push(req.query.therapist_id); }
  if (req.query.event) { where.push('event = ?'); args.push(req.query.event); }
  res.json(db.prepare(`SELECT * FROM queue_logs${where.length ? ' WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT 500`).all(...args));
});

// ---- 出勤與工時 ----
// 「今天每個人做了幾鐘、幾小時、輪到幾次」。技師最在意的公平性就看這張表。
router.get('/attendance', requireAny('attendance', 'queue', 'payroll'), (req, res) => {
  const from = req.query.from || today();
  const to = req.query.to || from;
  const sid = req.query.store_id ? Number(req.query.store_id) : null;
  const rows = db.prepare(`
    SELECT s.work_date, s.therapist_id, t.name, t.code, t.level, s.queue_seq, s.rounds,
           s.checkin_at, s.checkout_at, s.status, st.name AS store_name
    FROM shifts s JOIN therapists t ON t.id = s.therapist_id
    LEFT JOIN stores st ON st.id = s.store_id
    WHERE s.work_date >= ? AND s.work_date <= ? AND (? IS NULL OR s.store_id = ?)
    ORDER BY s.work_date DESC, s.queue_seq`).all(from, to, sid, sid);
  const dateExpr = "substr(COALESCE(NULLIF(t.actual_start,''), t.start_at),1,10)";
  const stats = db.prepare(`
    SELECT ${dateExpr} AS d, t.therapist_id,
           COUNT(*) AS tickets,
           SUM(CASE WHEN t.assign_type='designated' THEN 1 ELSE 0 END) AS designated,
           COALESCE(SUM(t.minutes),0) AS minutes,
           COALESCE(SUM(t.net_amount),0) AS amount
    FROM tickets t WHERE t.status IN ('serving','done') AND ${dateExpr} >= ? AND ${dateExpr} <= ?
    GROUP BY d, t.therapist_id`).all(from, to);
  const key = (d, id) => `${d}|${id}`;
  const map = Object.fromEntries(stats.map(s => [key(s.d, s.therapist_id), s]));
  const maxMin = num('daily_minutes_max', 480);
  res.json(rows.map(r => {
    const s = map[key(r.work_date, r.therapist_id)] || {};
    const mins = s.minutes || 0;
    // 在班時數：已下班用簽退時間，還在班上就算到現在
    const inMin = r.checkin_at ? require('../db').minutesBetween(r.checkin_at,
      r.checkout_at || require('../db').nowStamp()) : 0;
    return {
      ...r, tickets: s.tickets || 0, designated: s.designated || 0,
      minutes: mins, amount: yuan(s.amount || 0),
      on_site_minutes: Math.max(0, inMin),
      // 上鐘率＝實際服務時間 ÷ 在店時間。低於三成通常是排班過剩（人太多鐘不夠分）。
      utilization: inMin > 0 ? Math.min(1, mins / inMin) : 0,
      over_limit: maxMin > 0 && mins > maxMin
    };
  }));
});

module.exports = router;
