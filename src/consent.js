// 客人同意書（含電子簽名）。
//
// compliance.js 已經會算「同意書完整度」，但系統裡原本沒有任何地方可以**簽**——
// members.consent_at 只是一個時間戳，證明不了客人當初同意的是什麼內容。
//
// 民俗調理業被檢舉、或客人事後主張「做完更痛」時，要拿得出來的是三件事：
//   1. 客人當下自述了哪些健康狀況與禁忌部位（不是今天的資料，是簽名那天的）
//   2. 他簽的是哪一版條文（條文改過，舊的同意書仍然要看得到原文）
//   3. 誰經手的、什麼時候
// 所以同意書是快照，不是指向 members 的外鍵。
const { db, getSetting, num, nowStamp, today, addMonths, audit } = require('./db');
const storage = require('./storage');

// 現行條文與有效期
function currentText() { return getSetting('consent_text', ''); }
function validMonths() { return num('consent_valid_months', 12); }

// 簽署。簽名圖走 storage 存成檔案（會回讀驗證），資料庫只留 URL ——
// 把幾十 KB 的 base64 塞進每一列，備份與查詢都會被拖垮。
const sign = db.transaction(({ memberId, ticketId, storeId, signature, signerName, note, actor }) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!m) throw new Error('找不到這位客人');
  if (!signature) throw new Error('請讓客人簽名後再儲存');

  const at = nowStamp();
  const info = db.prepare(`INSERT INTO consents(member_id,ticket_id,store_id,signed_at,conditions,
      avoid_parts,pressure_pref,health_note,consent_text,signature,signer_name,actor,note)
      VALUES(?,?,?,?,?,?,?,?,?,'',?,?,?)`)
    .run(memberId, ticketId || null, storeId || m.store_id || null, at,
      m.conditions, m.avoid_parts, m.pressure_pref, m.health_note, currentText(),
      String(signerName || m.name), String(actor || ''), String(note || ''));
  const id = info.lastInsertRowid;

  // 簽名檔存不進去就整張同意書不算數：一張沒有簽名的同意書比沒有更危險，
  // 因為它會讓「完整度」變成綠燈，而真正要用的時候拿不出東西。
  // 這裡丟出的錯誤會讓整個交易回滾，資料庫不會留下半張。
  const att = storage.save({
    dataUrl: signature, filename: `consent-${m.name}-${at.slice(0, 10)}.png`,
    ownerType: 'consent', ownerId: id, kind: 'signature', actor
  });
  db.prepare('UPDATE consents SET signature = ? WHERE id = ?').run(att.url, id);

  // members.consent_at 保留為「最後一次簽署時間」，既有的合規檢查照樣運作
  db.prepare('UPDATE members SET consent_at = ? WHERE id = ?').run(at, memberId);
  audit('staff', null, actor || '', `${m.name} 簽署健康告知同意書（#${id}）`);
  return get(id);
});

function get(id) {
  const c = db.prepare(`SELECT c.*, m.name AS member_name, m.phone, s.name AS store_name, t.ticket_no
    FROM consents c
    LEFT JOIN members m ON m.id = c.member_id
    LEFT JOIN stores s ON s.id = c.store_id
    LEFT JOIN tickets t ON t.id = c.ticket_id WHERE c.id = ?`).get(id);
  if (!c) return null;
  return { ...c, attachments: storage.listFor('consent', c.id) };
}

function listFor(memberId) {
  return db.prepare('SELECT * FROM consents WHERE member_id = ? ORDER BY id DESC').all(memberId);
}

// 這位客人現在的同意書狀態。開單畫面用它決定要不要跳出簽名視窗。
function statusOf(memberId) {
  const last = db.prepare('SELECT * FROM consents WHERE member_id = ? ORDER BY id DESC LIMIT 1').get(memberId);
  if (!last) return { status: 'missing', label: '未簽署', last: null };
  const months = validMonths();
  if (months > 0) {
    const due = addMonths(last.signed_at.slice(0, 10), months);
    if (due < today()) return { status: 'expired', label: `已逾期（${due} 到期）`, last, due };
    return { status: 'ok', label: `有效至 ${due}`, last, due };
  }
  return { status: 'ok', label: '已簽署', last };
}

// 全店總表：誰沒簽、誰過期了。法遵頁與月初的清查用這張。
function audit_list({ storeId } = {}) {
  const sf = storeId ? ' AND m.store_id = ?' : '';
  const args = storeId ? [Number(storeId)] : [];
  const rows = db.prepare(`SELECT m.id, m.name, m.phone, m.store_id, m.conditions, m.health_updated_at,
      (SELECT MAX(signed_at) FROM consents c WHERE c.member_id = m.id) AS last_signed,
      (SELECT COUNT(*) FROM consents c WHERE c.member_id = m.id) AS sign_count,
      (SELECT COUNT(*) FROM tickets t WHERE t.member_id = m.id AND t.status = 'done') AS visits
    FROM members m WHERE m.active = 1${sf}
    ORDER BY visits DESC`).all(...args);
  const months = validMonths();
  return rows.map(r => {
    let status = 'ok';
    if (!r.last_signed) status = 'missing';
    else if (months > 0 && addMonths(r.last_signed.slice(0, 10), months) < today()) status = 'expired';
    return { ...r, status, due: r.last_signed && months > 0 ? addMonths(r.last_signed.slice(0, 10), months) : '' };
  });
}

module.exports = { currentText, validMonths, sign, get, listFor, statusOf, audit_list };
