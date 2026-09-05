// 集點與介紹人。
//
// 這兩件事是按摩／SPA 業主要的拉客手段，原本系統完全沒有，店家只能拿紙卡蓋章。
//
// 有兩個設計決定值得寫下來，因為它們看起來像是繞遠路：
//
// 1. **兌換一律換成「儲值贈送金」，不直接折在鐘單上。**
//    折在鐘單上會壓低 net_amount，而抽成是按業績算的 —— 客人用點數，技師的薪水就變少，
//    那是吵不完的。走贈送金則沿用既有的預收流程：負債怎麼算、退款怎麼退、
//    扣款先扣哪一邊，全部已經是對的，不必再寫一套。
//
// 2. **點數只認服務消費，不含商品與預收（可設定）。**
//    跟業績級距獎金同一個道理：買一張三萬元的次卡就集滿點，等於把預收款又打了一次折，
//    而那筆錢還沒變成收入。
const { db, num, getSetting, nowStamp, yuan, money, audit } = require('./db');
const prepaid = require('./prepaid');

function enabled() { return getSetting('points_enabled', '1') === '1'; }

// 餘額＝流水加總。members.points 是快取（同儲值金的規矩）。
function balanceOf(memberId) {
  return db.prepare('SELECT COALESCE(SUM(points),0) v FROM point_txns WHERE member_id = ?').get(memberId).v;
}

function writeTxn({ memberId, kind, points, ticketId, peerMemberId, amount, note, actor }) {
  const after = balanceOf(memberId) + Number(points);
  db.prepare(`INSERT INTO point_txns(member_id,kind,points,balance_after,ticket_id,peer_member_id,
      amount,note,actor) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(memberId, kind, Number(points), after, ticketId || null, peerMemberId || null,
      money(amount || 0), String(note || ''), String(actor || ''));
  db.prepare('UPDATE members SET points = ? WHERE id = ?').run(after, memberId);
  return after;
}

// 這張單可以累幾點
function pointsFor(ticket) {
  const per = num('points_per_amount', 100);
  if (per <= 0) return 0;
  const base = getSetting('points_service_only', '1') === '1'
    ? Math.max(0, yuan(ticket.net_amount) - yuan(ticket.retail_amount))
    : yuan(ticket.net_amount);
  return Math.floor(base / per);
}

// 結帳後累點；同時處理介紹人獎勵。
// 整個流程對同一張鐘單必須是冪等的 —— 結帳失敗重試、或日後補跑，都不能重複發點。
const earnForTicket = db.transaction(({ ticketId, actor }) => {
  if (!enabled()) return { points: 0, referral: 0 };
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!t || !t.member_id || t.status !== 'done') return { points: 0, referral: 0 };
  const dup = db.prepare("SELECT id FROM point_txns WHERE ticket_id = ? AND kind = 'earn'").get(ticketId);
  if (dup) return { points: 0, referral: 0, already: true };

  const pts = pointsFor(t);
  if (pts > 0) {
    writeTxn({ memberId: t.member_id, kind: 'earn', points: pts, ticketId,
      note: `${t.ticket_no} 消費累點`, actor });
  }

  // 介紹獎勵：被介紹的新客第一次完成消費時，發給介紹人，一位客人只發一次。
  let refPts = 0;
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(t.member_id);
  const bonus = num('referral_points', 0);
  if (m && m.referrer_id && !m.referral_paid && bonus > 0) {
    const referrer = db.prepare('SELECT * FROM members WHERE id = ? AND active = 1').get(m.referrer_id);
    if (referrer) {
      refPts = bonus;
      writeTxn({ memberId: referrer.id, kind: 'referral', points: bonus, ticketId,
        peerMemberId: m.id, note: `介紹 ${m.name} 首次消費`, actor });
      db.prepare('UPDATE members SET referral_paid = 1 WHERE id = ?').run(m.id);
      audit('staff', null, actor || '', `介紹獎勵：${referrer.name} 獲得 ${bonus} 點（介紹 ${m.name}）`);
    }
  }
  return { points: pts, referral: refPts };
});

// 取消鐘單：把這張單發出去的點數（含介紹獎勵）收回來。
// 收回會讓餘額變成負數的情況也照收 —— 帳是帳，客人已經把點用掉是另一件事，
// 讓它顯示為負數，櫃檯才看得到「這個人欠了點數」，而不是悄悄少扣。
const revokeForTicket = db.transaction(({ ticketId, actor }) => {
  const rows = db.prepare("SELECT * FROM point_txns WHERE ticket_id = ? AND kind IN ('earn','referral')")
    .all(ticketId);
  let n = 0;
  for (const r of rows) {
    // 已經收回過就不要再收一次
    const done = db.prepare(`SELECT id FROM point_txns WHERE ticket_id = ? AND kind = 'adjust'
      AND member_id = ? AND points = ?`).get(ticketId, r.member_id, -r.points);
    if (done) continue;
    writeTxn({ memberId: r.member_id, kind: 'adjust', points: -r.points, ticketId,
      note: '鐘單取消，點數收回', actor });
    n += r.points;
  }
  // 介紹獎勵收回後要讓它還能再發一次（客人下次真的來消費時）
  for (const r of rows.filter(x => x.kind === 'referral')) {
    if (r.peer_member_id) db.prepare('UPDATE members SET referral_paid = 0 WHERE id = ?').run(r.peer_member_id);
  }
  return { revoked: n };
});

// 兌換成儲值贈送金
const redeem = db.transaction(({ memberId, points, note, actor }) => {
  if (!enabled()) throw new Error('系統設定未啟用集點');
  const p = Math.floor(Number(points) || 0);
  const min = num('point_redeem_min', 0);
  const have = balanceOf(memberId);
  if (p <= 0) throw new Error('兌換點數要大於 0');
  if (p > have) throw new Error(`點數不足：目前 ${have} 點`);
  if (min > 0 && p < min) throw new Error(`每次至少要兌換 ${min} 點`);
  const value = yuan(p * num('point_redeem_value', 1));
  if (value <= 0) throw new Error('兌換金額為 0，請檢查系統設定的點數價值');
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!m) throw new Error('找不到這位客人');
  writeTxn({ memberId, kind: 'redeem', points: -p, amount: value,
    note: note || `兌換 ${value} 元儲值贈送金`, actor });
  prepaid.grantBonus({ memberId, bonus: value, note: `點數兌換（${p} 點）`, actor });
  audit('staff', null, actor || '', `${m.name} 點數兌換：${p} 點 → 贈送金 ${value} 元`);
  return { points: p, value, balance: balanceOf(memberId), wallet: prepaid.walletBalance(memberId) };
});

// 人工加減點（活動加碼、客訴補償、輸入錯誤更正）。一律要填原因。
const adjustPoints = db.transaction(({ memberId, points, reason, actor }) => {
  const p = Math.trunc(Number(points) || 0);
  if (!p) throw new Error('調整點數不能是 0');
  if (!String(reason || '').trim()) throw new Error('點數調整必須填寫原因');
  const after = writeTxn({ memberId, kind: 'adjust', points: p, note: reason, actor });
  const m = db.prepare('SELECT name FROM members WHERE id = ?').get(memberId);
  audit('staff', null, actor || '', `點數調整：${m?.name || memberId} ${p > 0 ? '+' : ''}${p} 點（${reason}）`);
  return { balance: after };
});

function txnsOf(memberId, limit = 100) {
  return db.prepare(`SELECT x.*, t.ticket_no, pm.name AS peer_name FROM point_txns x
    LEFT JOIN tickets t ON t.id = x.ticket_id
    LEFT JOIN members pm ON pm.id = x.peer_member_id
    WHERE x.member_id = ? ORDER BY x.id DESC LIMIT ?`).all(memberId, limit);
}

// 介紹關係樹（誰介紹了誰、帶進來多少業績）。做活動時要看的就是這張。
function referrals({ memberId } = {}) {
  const where = memberId ? 'WHERE m.referrer_id = ?' : 'WHERE m.referrer_id IS NOT NULL';
  const args = memberId ? [memberId] : [];
  return db.prepare(`SELECT m.id, m.name, m.phone, m.created_at, m.referral_paid,
      r.id AS referrer_id, r.name AS referrer_name,
      (SELECT COUNT(*) FROM tickets t WHERE t.member_id = m.id AND t.status='done') AS visits,
      (SELECT COALESCE(SUM(t.net_amount),0) FROM tickets t WHERE t.member_id = m.id AND t.status='done') AS spent
    FROM members m JOIN members r ON r.id = m.referrer_id
    ${where} AND m.active = 1 ORDER BY spent DESC`).all(...args);
}

// 排行榜：誰介紹得最多、誰的點數最多
function summary() {
  const top = db.prepare(`SELECT r.id, r.name, r.phone, COUNT(*) AS n,
      COALESCE(SUM((SELECT COALESCE(SUM(t.net_amount),0) FROM tickets t
        WHERE t.member_id = m.id AND t.status='done')),0) AS brought
    FROM members m JOIN members r ON r.id = m.referrer_id
    WHERE m.active = 1 GROUP BY r.id ORDER BY n DESC, brought DESC LIMIT 20`).all();
  const pts = db.prepare(`SELECT id, name, phone, points FROM members
    WHERE active = 1 AND points > 0 ORDER BY points DESC LIMIT 20`).all();
  const total = db.prepare('SELECT COALESCE(SUM(points),0) v FROM members WHERE active = 1').get().v;
  return {
    enabled: enabled(),
    rules: {
      points_per_amount: num('points_per_amount', 100),
      point_redeem_value: num('point_redeem_value', 1),
      point_redeem_min: num('point_redeem_min', 0),
      referral_points: num('referral_points', 0),
      service_only: getSetting('points_service_only', '1') === '1'
    },
    outstanding_points: total,
    // 未兌換點數的潛在成本：全部拿去換的話，帳上要多出這麼多贈送金
    outstanding_value: yuan(total * num('point_redeem_value', 1)),
    top_referrers: top, top_holders: pts
  };
}

// 快取對帳（跟庫存、儲值同一套）
function reconcile({ fix = false, actor = '' } = {}) {
  const bad = [];
  for (const m of db.prepare('SELECT id, name, points FROM members').all()) {
    const real = balanceOf(m.id);
    if (real === m.points) continue;
    bad.push({ id: m.id, name: m.name, cached: m.points, real });
    if (fix) {
      db.prepare('UPDATE members SET points = ? WHERE id = ?').run(real, m.id);
      audit('staff', null, actor, `點數快取重算：${m.name} ${m.points} → ${real}`);
    }
  }
  return { ok: bad.length === 0, mismatched: bad, fixed: fix ? bad.length : 0 };
}

module.exports = {
  enabled, balanceOf, pointsFor, earnForTicket, revokeForTicket, redeem, adjustPoints,
  txnsOf, referrals, summary, reconcile
};
