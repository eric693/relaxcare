// 上鐘前閘門：一次把該擋的事情全部檢查完。
//
// 這套系統的差異化就在這裡。現場開單的人很忙，不會主動去翻客人的健康紀錄，
// 所以檢查必須發生在「按下開單」的那一刻，而且要一次講完 ——
// 分三次跳警告，第三次就沒有人在看了。
//
// 分兩級：
//   conflict  硬衝突（同一時間兩張單、健康禁忌、證照過期）。可以強制放行，但必須填理由，
//             理由寫進 tickets.gate_note，也寫進稽核軌跡。
//   warn      提醒（跳過輪序、時數偏高、卡片快到期）。照做即可，不必填理由。
const { db, num, getSetting, today, dateDiff, yuan } = require('./db');
const rotation = require('./rotation');
const prepaid = require('./prepaid');

function splitList(v) { return String(v || '').split(',').map(s => s.trim()).filter(Boolean); }

// 床位／包廂衝突。capacity > 1 的空間（足療區）可以同時容納多組客人，
// 所以是「同時段佔用數 >= capacity」才算滿，不是有人就算衝突。
function checkRoom({ roomId, startAt, endAt, ticketId }) {
  const issues = [];
  if (!roomId || !startAt || !endAt) return issues;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return [{ level: 'conflict', code: 'no_room', message: '找不到這個床位／包廂' }];
  if (!room.active) issues.push({ level: 'warn', code: 'room_inactive', message: `${room.name} 已停用` });
  const rows = db.prepare(`SELECT ticket_no, start_at, end_at FROM tickets
    WHERE room_id = ? AND status IN ('booked','serving') AND id <> COALESCE(?, -1)
      AND start_at < ? AND ? < end_at`).all(roomId, ticketId || null, endAt, startAt);
  if (rows.length >= (room.capacity || 1)) {
    issues.push({ level: 'conflict', code: 'room_full',
      message: `${room.name}（可容 ${room.capacity} 組）同時段已有 ${rows.length} 組：${rows.map(r => `${r.ticket_no} ${r.start_at.slice(11)}~${r.end_at.slice(11)}`).join('、')}` });
  }
  return issues;
}

// 客人的健康狀況 vs 服務項目的禁忌。
// 這是真正會出事的一項：孕婦做精油、剛手術的人做重手推拿、服抗凝血劑的人拔罐。
function checkHealth({ memberId, serviceId }) {
  const issues = [];
  if (!memberId) return issues;
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!m) return issues;
  if (m.blacklist) {
    issues.push({ level: 'conflict', code: 'blacklist',
      message: `${m.name} 已被列入黑名單${m.blacklist_reason ? `：${m.blacklist_reason}` : ''}` });
  }
  const conds = splitList(m.conditions);
  if (serviceId) {
    const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
    const banned = splitList(svc?.contraindications);
    const hit = conds.filter(c => banned.includes(c));
    if (hit.length) {
      issues.push({ level: 'conflict', code: 'contraindication',
        message: `${m.name} 的身體狀況「${hit.join('、')}」屬於「${svc.name}」的禁忌，不建議施作` });
    }
  }
  if (m.avoid_parts) {
    issues.push({ level: 'warn', code: 'avoid_parts', message: `禁忌部位：${m.avoid_parts}（請務必告知技師）` });
  }
  if (m.pressure_pref) {
    issues.push({ level: 'warn', code: 'pressure', message: `力道偏好：${m.pressure_pref}` });
  }
  if (conds.length && !issues.some(i => i.code === 'contraindication')) {
    issues.push({ level: 'warn', code: 'conditions', message: `身體狀況：${conds.join('、')}` });
  }
  // 問診紀錄太舊等於沒有。半年前填的「無特殊狀況」不能拿來當今天的依據。
  if (!m.health_updated_at) {
    issues.push({ level: 'warn', code: 'no_health', message: `${m.name} 尚未填寫身體狀況問診，建議補建立` });
  } else {
    const days = dateDiff(m.health_updated_at.slice(0, 10), today());
    if (days !== null && days > 180) {
      issues.push({ level: 'warn', code: 'stale_health',
        message: `身體狀況最後更新於 ${m.health_updated_at.slice(0, 10)}（${days} 天前），建議重新確認` });
    }
  }
  return issues;
}

// 付款方式可行性：要用儲值就得有餘額，要用次卡就得有卡且沒過期
function checkPayment({ memberId, serviceId, useWallet, walletAmount, passId, amount }) {
  const issues = [];
  if (useWallet && memberId) {
    const b = prepaid.walletBalance(memberId);
    const need = yuan(walletAmount || amount);
    // 餘額不足不是硬衝突：結帳試算本來就會「儲值抵到底、不足的收現金」。
    // 若這裡擋下來，畫面上會出現「試算說收現金 1960、按下確定卻說餘額不足」這種自相矛盾。
    // 只有完全沒有餘額卻勾了動用儲值，才視為選錯付款方式。
    if (b.total <= 0) {
      issues.push({ level: 'conflict', code: 'wallet_empty',
        message: '這位客人沒有儲值餘額，請取消「動用儲值」或先為他儲值' });
    } else if (b.total < need) {
      issues.push({ level: 'warn', code: 'wallet_short',
        message: `儲值餘額 ${b.total} 元（現金 ${b.cash}／贈送 ${b.bonus}）不足 ${need} 元，差額 ${need - b.total} 元會以現金收取` });
    } else if (b.bonus > 0 && b.expiry_date && b.expiry_date >= today()) {
      const left = dateDiff(today(), b.expiry_date);
      if (left !== null && left <= 30) {
        issues.push({ level: 'warn', code: 'bonus_expiring',
          message: `贈送金 ${b.bonus} 元將於 ${b.expiry_date} 到期（剩 ${left} 天），本次會優先扣除` });
      }
    }
  }
  if (passId) {
    const p = prepaid.passOf(passId);
    if (!p) issues.push({ level: 'conflict', code: 'no_pass', message: '找不到指定的次卡' });
    else {
      const st = prepaid.passStatus(p);
      const remain = p.total_times - p.used_times;
      if (st === 'expired') issues.push({ level: 'conflict', code: 'pass_expired', message: `次卡 ${p.pass_no} 已於 ${p.expiry_date} 到期` });
      else if (st !== 'active' || remain <= 0) issues.push({ level: 'conflict', code: 'pass_unusable', message: `次卡 ${p.pass_no} 無可用次數` });
      else {
        if (Number(p.member_id) !== Number(memberId)) {
          issues.push({ level: 'conflict', code: 'pass_owner', message: `次卡 ${p.pass_no} 不屬於這位客人，請先辦理轉讓` });
        }
        if (p.service_id && serviceId && Number(p.service_id) !== Number(serviceId)) {
          const sn = (db.prepare('SELECT name FROM services WHERE id = ?').get(p.service_id) || {}).name || '';
          issues.push({ level: 'conflict', code: 'pass_service', message: `次卡 ${p.pass_no} 限用於「${sn}」，與本次項目不符` });
        }
        if (remain === 1) issues.push({ level: 'warn', code: 'pass_last', message: `次卡 ${p.pass_no} 核銷後即用完，可提醒客人續購` });
        if (p.expiry_date) {
          const left = dateDiff(today(), p.expiry_date);
          if (left !== null && left <= 30) {
            issues.push({ level: 'warn', code: 'pass_expiring', message: `次卡 ${p.pass_no} 將於 ${p.expiry_date} 到期，尚餘 ${remain} 次` });
          }
        }
      }
    }
  }
  return issues;
}

// 技師會不會做這個項目。skills 是逗號分隔的服務名稱或分類，留空＝什麼都能做。
function checkSkill({ therapistId, serviceId }) {
  if (!therapistId || !serviceId) return [];
  const t = db.prepare('SELECT * FROM therapists WHERE id = ?').get(therapistId);
  const s = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
  if (!t || !s) return [];
  const skills = splitList(t.skills);
  if (!skills.length) return [];
  if (skills.includes(s.name) || skills.includes(s.category)) return [];
  return [{ level: 'warn', code: 'skill',
    message: `${t.name} 的可做項目為「${skills.join('、')}」，不含「${s.name}」` }];
}

// 房型是否對得上（精油要有沖澡間、VIP 項目要在包廂做）
function checkRoomType({ roomId, serviceId }) {
  if (!roomId || !serviceId) return [];
  const r = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  const s = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
  if (!r || !s || !s.room_type) return [];
  const want = splitList(s.room_type);
  if (want.includes(r.rtype)) return [];
  return [{ level: 'warn', code: 'room_type',
    message: `「${s.name}」建議安排在 ${want.join('／')}，目前指定的是 ${r.name}（${r.rtype}）` }];
}

// 全部一起跑。這是開單／改單前唯一要呼叫的東西。
function checkAll(input) {
  const issues = [];
  if (input.therapist_id) {
    issues.push(...rotation.checkAssign({
      therapistId: input.therapist_id,
      workDate: (input.start_at || '').slice(0, 10) || today(),
      assignType: input.assign_type || 'rotation',
      startAt: input.start_at, endAt: input.end_at,
      minutes: input.minutes, ticketId: input.ticket_id
    }));
    issues.push(...checkSkill({ therapistId: input.therapist_id, serviceId: input.service_id }));
  } else {
    issues.push({ level: 'warn', code: 'no_therapist', message: '尚未指派技師' });
  }
  issues.push(...checkRoom({ roomId: input.room_id, startAt: input.start_at, endAt: input.end_at, ticketId: input.ticket_id }));
  issues.push(...checkRoomType({ roomId: input.room_id, serviceId: input.service_id }));
  issues.push(...checkHealth({ memberId: input.member_id, serviceId: input.service_id }));
  issues.push(...checkPayment({
    memberId: input.member_id, serviceId: input.service_id,
    useWallet: input.use_wallet, walletAmount: input.wallet_amount,
    passId: input.pass_id, amount: input.net_amount
  }));
  return {
    issues,
    conflicts: issues.filter(i => i.level === 'conflict'),
    warnings: issues.filter(i => i.level !== 'conflict'),
    ok: !issues.some(i => i.level === 'conflict')
  };
}

module.exports = { checkAll, checkRoom, checkHealth, checkPayment, checkSkill, checkRoomType, splitList };
