// 輪鐘（排鐘）引擎。
//
// 這是整套系統最容易引起爭議的一塊：技師的收入直接取決於「今天輪到我幾次」。
// 所以規則要能講清楚，而且每一次異動都要留痕跡 —— 店長口頭喬的結果沒有人會記得，
// 但系統寫下來的 queue_logs 會。
//
// 規則本身很單純，複雜的是例外：
//   · 輪序＝(已輪次數 rounds, 簽到順序 queue_seq) 由小到大。先比輪次，再比簽到。
//     這樣「輪過的人自動排到隊尾」不必真的去搬動 queue_seq，補簽到的人插進來也不會亂。
//   · 指名預設「不吃輪」：紅牌被指名做完回來，還是排在原本的位置。
//     否則指名多的技師會被指名指到接不到輪鐘，實際上是變相減薪。這個行為可在設定改。
//   · 休息（吃飯、抽菸、身體不適）是暫時離開輪序，不是下班；回來時輪次不變。
const { db, getSetting, num, nowStamp, today, audit, addMinutes } = require('./db');

const STATUS = { waiting: '等鐘', serving: '上鐘中', resting: '休息中', off: '已下班' };

function designateCountsAsRound() { return getSetting('rotation_designate_counts', '0') === '1'; }

function log(entry) {
  db.prepare(`INSERT INTO queue_logs(work_date,store_id,therapist_id,therapist_name,event,ticket_id,
              seq_before,seq_after,rounds_before,rounds_after,reason,actor)
              VALUES(@work_date,@store_id,@therapist_id,@therapist_name,@event,@ticket_id,
              @seq_before,@seq_after,@rounds_before,@rounds_after,@reason,@actor)`)
    .run({
      seq_before: null, seq_after: null, rounds_before: null, rounds_after: null,
      ticket_id: null, store_id: null, reason: '', actor: '', therapist_name: '', ...entry
    });
}

function shiftOf(workDate, therapistId) {
  return db.prepare('SELECT * FROM shifts WHERE work_date = ? AND therapist_id = ?').get(workDate, therapistId);
}

// 當日檯面：每位已簽到技師的狀態、已接鐘數、目前服務中的單。
// 前端輪鐘檯就是直接畫這個結果。
function board(workDate, storeId) {
  const d = workDate || today();
  const args = [d];
  let where = 's.work_date = ?';
  if (storeId) { where += ' AND s.store_id = ?'; args.push(storeId); }
  const rows = db.prepare(`
    SELECT s.*, t.name, t.code, t.nickname, t.level, t.gender, t.is_blind, t.skills,
           t.cert_expiry, t.health_check_expiry
    FROM shifts s JOIN therapists t ON t.id = s.therapist_id
    WHERE ${where}
    ORDER BY s.rounds, s.queue_seq`).all(...args);

  const stats = db.prepare(`
    SELECT therapist_id,
           COUNT(*) AS ticket_count,
           SUM(CASE WHEN assign_type = 'designated' THEN 1 ELSE 0 END) AS designate_count,
           COALESCE(SUM(minutes),0) AS minutes_total,
           COALESCE(SUM(net_amount),0) AS amount_total
    FROM tickets
    WHERE biz_date = ? AND status IN ('serving','done')
    GROUP BY therapist_id`).all(d);
  const statMap = Object.fromEntries(stats.map(s => [s.therapist_id, s]));

  const serving = db.prepare(`
    SELECT id, ticket_no, therapist_id, service_name, minutes, start_at, end_at, room_id, assign_type
    FROM tickets WHERE status = 'serving' AND therapist_id IS NOT NULL`).all();
  const servingMap = Object.fromEntries(serving.map(t => [t.therapist_id, t]));

  const now = nowStamp();
  const restMin = num('rotation_rest_min', 10);

  const list = rows.map(r => {
    const st = statMap[r.therapist_id] || {};
    // 休息時間到了就當作已經回到輪序，不必等人來按「恢復」——
    // 現場沒有人會記得按，結果就是這位技師整晚都不會被排到。
    const restOver = r.status === 'resting' && r.rest_until && r.rest_until <= now;
    return {
      ...r,
      status: restOver ? 'waiting' : r.status,
      status_label: STATUS[restOver ? 'waiting' : r.status] || r.status,
      ticket_count: st.ticket_count || 0,
      designate_count: st.designate_count || 0,
      minutes_total: st.minutes_total || 0,
      amount_total: st.amount_total || 0,
      current: servingMap[r.therapist_id] || null,
      rest_ready_at: r.status === 'serving' ? '' : r.rest_until,
      rest_min: restMin
    };
  });

  // 下一位輪鐘：等鐘中、輪次最少、簽到最早
  const queue = list.filter(x => x.status === 'waiting');
  return {
    work_date: d,
    rules: {
      designate_counts: designateCountsAsRound(),
      rest_min: restMin,
      daily_minutes_max: num('daily_minutes_max', 480),
      continuous_tickets_max: num('continuous_tickets_max', 4)
    },
    list,
    queue: queue.map(x => x.therapist_id),
    next: queue[0] || null
  };
}

// 簽到：取當日該店最後一個 queue_seq + 1。用交易包住，兩個人同時簽到不會撞號。
const checkin = db.transaction(({ therapistId, workDate, storeId, actor }) => {
  const d = workDate || today();
  const t = db.prepare('SELECT * FROM therapists WHERE id = ? AND active = 1').get(therapistId);
  if (!t) throw new Error('找不到這位技師或已停用');
  const sid = storeId || t.store_id || null;
  const exist = shiftOf(d, therapistId);
  if (exist) {
    if (exist.status === 'off') {
      // 下班後又回來（臨時被叫回來加班）：不重排號碼，但輪次要接續，
      // 直接放回等鐘。若重新給號會排到最前面，對整晚沒走的人不公平。
      db.prepare("UPDATE shifts SET status='waiting', checkout_at='' WHERE id = ?").run(exist.id);
      log({ work_date: d, store_id: sid, therapist_id: therapistId, therapist_name: t.name,
            event: 'checkin', seq_after: exist.queue_seq, rounds_after: exist.rounds,
            reason: '下班後重新上工', actor });
      return shiftOf(d, therapistId);
    }
    return exist;
  }
  const max = db.prepare('SELECT COALESCE(MAX(queue_seq),0) AS m FROM shifts WHERE work_date = ? AND (store_id IS ? OR store_id = ?)')
    .get(d, sid, sid).m;
  const seq = max + 1;
  db.prepare(`INSERT INTO shifts(work_date,therapist_id,store_id,queue_seq,checkin_at,status)
              VALUES(?,?,?,?,?,'waiting')`).run(d, therapistId, sid, seq, nowStamp());
  log({ work_date: d, store_id: sid, therapist_id: therapistId, therapist_name: t.name,
        event: 'checkin', seq_after: seq, rounds_after: 0, actor });
  return shiftOf(d, therapistId);
});

function checkout({ therapistId, workDate, actor, reason }) {
  const d = workDate || today();
  const s = shiftOf(d, therapistId);
  if (!s) throw new Error('這位技師今天尚未簽到');
  if (s.status === 'serving') throw new Error('目前正在上鐘中，請先完成或取消該鐘單再下班');
  db.prepare("UPDATE shifts SET status='off', checkout_at=? WHERE id = ?").run(nowStamp(), s.id);
  const t = db.prepare('SELECT name FROM therapists WHERE id = ?').get(therapistId) || {};
  log({ work_date: d, store_id: s.store_id, therapist_id: therapistId, therapist_name: t.name,
        event: 'checkout', seq_after: s.queue_seq, rounds_after: s.rounds, reason: reason || '', actor });
  return shiftOf(d, therapistId);
}

// 暫離輪序。minutes 給 0 表示「不設定回來時間」，要人工按恢復。
function rest({ therapistId, workDate, minutes, reason, actor }) {
  const d = workDate || today();
  const s = shiftOf(d, therapistId);
  if (!s) throw new Error('這位技師今天尚未簽到');
  if (s.status === 'serving') throw new Error('上鐘中不能設為休息');
  const until = Number(minutes) > 0 ? addMinutes(nowStamp(), Number(minutes)) : '';
  db.prepare("UPDATE shifts SET status='resting', rest_until=? WHERE id = ?").run(until, s.id);
  const t = db.prepare('SELECT name FROM therapists WHERE id = ?').get(therapistId) || {};
  log({ work_date: d, store_id: s.store_id, therapist_id: therapistId, therapist_name: t.name,
        event: 'rest', seq_after: s.queue_seq, rounds_after: s.rounds,
        reason: `${reason || '休息'}${until ? `（至 ${until.slice(11)}）` : ''}`, actor });
  return shiftOf(d, therapistId);
}

function resume({ therapistId, workDate, actor }) {
  const d = workDate || today();
  const s = shiftOf(d, therapistId);
  if (!s) throw new Error('這位技師今天尚未簽到');
  db.prepare("UPDATE shifts SET status='waiting', rest_until='' WHERE id = ?").run(s.id);
  const t = db.prepare('SELECT name FROM therapists WHERE id = ?').get(therapistId) || {};
  log({ work_date: d, store_id: s.store_id, therapist_id: therapistId, therapist_name: t.name,
        event: 'resume', seq_after: s.queue_seq, rounds_after: s.rounds, actor });
  return shiftOf(d, therapistId);
}

// 人工調整輪序或輪次。店長總有需要喬的時候，重點是喬完要留下理由。
function adjust({ therapistId, workDate, queueSeq, rounds, reason, actor }) {
  const d = workDate || today();
  const s = shiftOf(d, therapistId);
  if (!s) throw new Error('這位技師今天尚未簽到');
  if (!String(reason || '').trim()) throw new Error('人工調整輪序必須填寫原因');
  const seq = queueSeq === undefined || queueSeq === '' ? s.queue_seq : Number(queueSeq);
  const rd = rounds === undefined || rounds === '' ? s.rounds : Number(rounds);
  db.prepare('UPDATE shifts SET queue_seq = ?, rounds = ? WHERE id = ?').run(seq, rd, s.id);
  const t = db.prepare('SELECT name FROM therapists WHERE id = ?').get(therapistId) || {};
  log({ work_date: d, store_id: s.store_id, therapist_id: therapistId, therapist_name: t.name,
        event: 'manual', seq_before: s.queue_seq, seq_after: seq,
        rounds_before: s.rounds, rounds_after: rd, reason, actor });
  return shiftOf(d, therapistId);
}

// 檢查「這位技師現在能不能上鐘」。回傳問題清單，conflict 是硬衝突。
// 不直接擋下來，是因為現場總會有必須放行的時候 —— 但放行要留理由（tickets.gate_note）。
function checkAssign({ therapistId, workDate, assignType, startAt, endAt, minutes, ticketId }) {
  const issues = [];
  const d = workDate || (startAt || today()).slice(0, 10);
  const s = shiftOf(d, therapistId);
  const t = db.prepare('SELECT * FROM therapists WHERE id = ?').get(therapistId);
  if (!t) return [{ level: 'conflict', code: 'no_therapist', message: '找不到這位技師' }];
  if (!t.active) issues.push({ level: 'conflict', code: 'inactive', message: `${t.name} 已停用` });

  if (!s) {
    issues.push({ level: 'conflict', code: 'not_checkin', message: `${t.name} ${d} 尚未簽到，無法排鐘` });
  } else {
    if (s.status === 'off') issues.push({ level: 'conflict', code: 'off', message: `${t.name} 今天已下班` });
    if (s.status === 'resting') issues.push({ level: 'warn', code: 'resting', message: `${t.name} 目前登記為休息中${s.rest_until ? `（至 ${s.rest_until.slice(11)}）` : ''}` });
  }

  // 時間重疊：同一位技師不可能同時做兩個人
  if (startAt && endAt) {
    const clash = db.prepare(`
      SELECT ticket_no, start_at, end_at, service_name FROM tickets
      WHERE therapist_id = ? AND status IN ('booked','serving')
        AND id <> COALESCE(?, -1)
        AND start_at < ? AND ? < end_at`).all(therapistId, ticketId || null, endAt, startAt);
    for (const c of clash) {
      issues.push({ level: 'conflict', code: 'overlap',
        message: `與 ${c.ticket_no}（${c.start_at.slice(11)}~${c.end_at.slice(11)} ${c.service_name}）時間重疊` });
    }
  }

  // 輪序：輪鐘單指派的對象應該是排頭那位
  if (assignType === 'rotation' && s && s.status !== 'off') {
    const b = board(d, s.store_id);
    const nxt = b.next;
    if (nxt && nxt.therapist_id !== Number(therapistId)) {
      issues.push({ level: 'warn', code: 'not_next',
        message: `依輪序現在應該輪到 ${nxt.name}（第 ${nxt.queue_seq} 號，已輪 ${nxt.rounds} 次）；指派給 ${t.name} 會跳過輪序` });
    }
  }

  // 當日時數與連續上鐘
  const dayStat = db.prepare(`
    SELECT COALESCE(SUM(minutes),0) AS mins, COUNT(*) AS cnt FROM tickets
    WHERE therapist_id = ? AND biz_date = ?
      AND status IN ('booked','serving','done') AND id <> COALESCE(?, -1)`).get(therapistId, d, ticketId || null);
  const maxMin = num('daily_minutes_max', 480);
  const willBe = dayStat.mins + (Number(minutes) || 0);
  if (maxMin > 0 && willBe > maxMin) {
    issues.push({ level: 'warn', code: 'daily_minutes',
      message: `${t.name} 今日服務時數將達 ${Math.round(willBe / 60 * 10) / 10} 小時，超過設定上限 ${Math.round(maxMin / 60 * 10) / 10} 小時` });
  }
  const maxCont = num('continuous_tickets_max', 4);
  if (maxCont > 0 && dayStat.cnt >= maxCont) {
    // 中間有沒有休息看 queue_logs：有 rest 就重新起算
    const restedAfter = db.prepare(`SELECT COUNT(*) n FROM queue_logs
      WHERE work_date = ? AND therapist_id = ? AND event = 'rest'`).get(d, therapistId).n;
    if (!restedAfter) {
      issues.push({ level: 'warn', code: 'continuous',
        message: `${t.name} 今日已連續接 ${dayStat.cnt} 鐘未登記休息，建議安排休息` });
    }
  }

  // 證照與健檢
  const warnDays = num('expiry_warn_days', 45);
  for (const [field, label] of [['cert_expiry', '技術士證'], ['health_check_expiry', '健康檢查']]) {
    const v = t[field];
    if (!v) continue;
    const left = require('./db').dateDiff(d, v);
    if (left === null) continue;
    if (left < 0) issues.push({ level: 'conflict', code: field, message: `${t.name} 的${label}已於 ${v} 到期` });
    else if (left <= warnDays) issues.push({ level: 'warn', code: field, message: `${t.name} 的${label}將於 ${v} 到期（剩 ${left} 天）` });
  }

  return issues;
}

// 指派成功後推進輪序。指名是否吃輪由設定決定。
const consume = db.transaction(({ therapistId, workDate, assignType, ticketId, actor }) => {
  const d = workDate || today();
  const s = shiftOf(d, therapistId);
  if (!s) return null;
  const counts = assignType !== 'designated' || designateCountsAsRound();
  const rounds = counts ? s.rounds + 1 : s.rounds;
  db.prepare("UPDATE shifts SET status='serving', rounds=?, rest_until='' WHERE id = ?").run(rounds, s.id);
  const t = db.prepare('SELECT name FROM therapists WHERE id = ?').get(therapistId) || {};
  log({ work_date: d, store_id: s.store_id, therapist_id: therapistId, therapist_name: t.name,
        event: assignType === 'designated' ? 'designate' : 'assign', ticket_id: ticketId,
        seq_after: s.queue_seq, rounds_before: s.rounds, rounds_after: rounds,
        reason: counts ? '計入輪次' : '指名不計輪次', actor });

  // 被跳過的人也要留紀錄，日後對帳才知道「那天為什麼沒輪到我」
  if (assignType === 'rotation') {
    const skipped = db.prepare(`SELECT s2.therapist_id, s2.queue_seq, s2.rounds, t2.name
      FROM shifts s2 JOIN therapists t2 ON t2.id = s2.therapist_id
      WHERE s2.work_date = ? AND (s2.store_id IS ? OR s2.store_id = ?) AND s2.status = 'waiting'
        AND s2.therapist_id <> ?
        AND (s2.rounds < ? OR (s2.rounds = ? AND s2.queue_seq < ?))`)
      .all(d, s.store_id, s.store_id, therapistId, s.rounds, s.rounds, s.queue_seq);
    for (const k of skipped) {
      log({ work_date: d, store_id: s.store_id, therapist_id: k.therapist_id, therapist_name: k.name,
            event: 'skip', ticket_id: ticketId, seq_after: k.queue_seq, rounds_after: k.rounds,
            reason: `輪鐘指派給 ${t.name}（第 ${s.queue_seq} 號）時被跳過`, actor });
    }
  }
  return shiftOf(d, therapistId);
});

// 下鐘：回到等鐘，並依設定給一段整理時間
function release({ therapistId, workDate, ticketId, actor, toStatus }) {
  const d = workDate || today();
  const s = shiftOf(d, therapistId);
  if (!s) return null;
  const restMin = num('rotation_rest_min', 10);
  if (toStatus === 'off') {
    db.prepare("UPDATE shifts SET status='off', checkout_at=? WHERE id = ?").run(nowStamp(), s.id);
  } else if (restMin > 0) {
    db.prepare("UPDATE shifts SET status='resting', rest_until=? WHERE id = ?")
      .run(addMinutes(nowStamp(), restMin), s.id);
  } else {
    db.prepare("UPDATE shifts SET status='waiting', rest_until='' WHERE id = ?").run(s.id);
  }
  const t = db.prepare('SELECT name FROM therapists WHERE id = ?').get(therapistId) || {};
  log({ work_date: d, store_id: s.store_id, therapist_id: therapistId, therapist_name: t.name,
        event: 'release', ticket_id: ticketId, seq_after: s.queue_seq, rounds_after: s.rounds,
        reason: restMin > 0 ? `下鐘，整理 ${restMin} 分鐘` : '下鐘', actor });
  return shiftOf(d, therapistId);
}

// 取消鐘單時要把吃掉的輪次還回去，否則技師平白少一輪
function rollback({ therapistId, workDate, ticketId, assignType, actor, reason }) {
  const d = workDate || today();
  const s = shiftOf(d, therapistId);
  if (!s) return null;
  const counts = assignType !== 'designated' || designateCountsAsRound();
  const rounds = counts ? Math.max(0, s.rounds - 1) : s.rounds;
  db.prepare("UPDATE shifts SET status = CASE WHEN status='serving' THEN 'waiting' ELSE status END, rounds=? WHERE id = ?")
    .run(rounds, s.id);
  const t = db.prepare('SELECT name FROM therapists WHERE id = ?').get(therapistId) || {};
  log({ work_date: d, store_id: s.store_id, therapist_id: therapistId, therapist_name: t.name,
        event: 'rollback', ticket_id: ticketId, rounds_before: s.rounds, rounds_after: rounds,
        seq_after: s.queue_seq, reason: reason || '鐘單取消，返還輪次', actor });
  return shiftOf(d, therapistId);
}

module.exports = {
  STATUS, board, checkin, checkout, rest, resume, adjust,
  checkAssign, consume, release, rollback, shiftOf, log, designateCountsAsRound
};
