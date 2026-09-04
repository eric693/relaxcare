// LINE 通知：預約提醒、回購推播、技師排班通知。
//
// 未設定 LINE token 時走「模擬模式」—— 訊息照樣組出來、照樣寫進通知紀錄，只是不真的送出。
// 這樣示範與教育訓練不必先申請官方帳號，之後在系統設定填上 token 就會真的發送。
const { db, getSetting, nowStamp, today, yuan } = require('./db');

function enabled() { return !!getSetting('line_token', '').trim(); }

async function push(uid, text) {
  const token = getSetting('line_token', '').trim();
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: uid, messages: [{ type: 'text', text: text.slice(0, 4900) }] })
  });
  if (!res.ok) throw new Error(`LINE API ${res.status}：${(await res.text()).slice(0, 200)}`);
}

// 送出並留紀錄。不會 throw —— 通知失敗不該讓「儲存鐘單」整個失敗，但一定要留下痕跡。
async function send({ targetType, targetId, targetName, lineUid, title, body, ticketId, memberId }) {
  let status = 'simulated', error = '';
  if (enabled() && lineUid) {
    try { await push(lineUid, `【${title}】\n${body}`); status = 'sent'; }
    catch (e) { status = 'failed'; error = e.message; }
  } else if (enabled() && !lineUid) {
    status = 'failed'; error = '對象沒有填 LINE UID';
  }
  db.prepare(`INSERT INTO notifications(target_type,target_id,target_name,title,body,status,error,ticket_id,member_id)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(targetType, targetId ?? null, targetName || '', title, body, status, error, ticketId ?? null, memberId ?? null);
  return { status, error };
}

const company = () => getSetting('company_name', 'RelaxCare');

// 預約提醒（客人）
function bookingText(ticketId) {
  const t = db.prepare(`SELECT t.*, m.name AS member_name, m.line_uid, th.name AS therapist_name,
                          r.name AS room_name, s.name AS store_name, s.phone AS store_phone, s.address
                        FROM tickets t
                        LEFT JOIN members m ON m.id = t.member_id
                        LEFT JOIN therapists th ON th.id = t.therapist_id
                        LEFT JOIN rooms r ON r.id = t.room_id
                        LEFT JOIN stores s ON s.id = t.store_id
                        WHERE t.id = ?`).get(ticketId);
  if (!t) return null;
  const L = [];
  L.push(`${t.member_name || t.guest_name} 您好，這是您的預約確認：`);
  L.push(`門市：${t.store_name || company()}`);
  L.push(`時間：${t.start_at}`);
  L.push(`項目：${t.service_name}（${t.minutes} 分鐘）`);
  if (t.therapist_name) L.push(`技師：${t.therapist_name}${t.assign_type === 'designated' ? '（指名）' : ''}`);
  if (t.room_name) L.push(`空間：${t.room_name}`);
  L.push(`金額：NT$ ${yuan(t.net_amount).toLocaleString('zh-TW')}`);
  if (t.address) L.push(`地址：${t.address}`);
  if (t.store_phone) L.push(`電話：${t.store_phone}`);
  L.push('');
  L.push('提醒：如需更改或取消，請提前來電告知。用餐後建議休息 30 分鐘再進行服務。');
  L.push('若有懷孕、近期手術、心血管疾病等狀況，請於服務前主動告知，我們會調整力道與部位。');
  return { ticket: t, text: L.join('\n') };
}

// 回購推播（客人）。文案刻意不提任何療效字眼 —— 這是會被截圖檢舉的地方。
function repurchaseText(member) {
  const L = [];
  L.push(`${member.name} 您好，好一陣子沒見到您了。`);
  if (member.last_therapist) L.push(`${member.last_therapist} 技師請我們向您問好。`);
  if (member.wallet_balance > 0) L.push(`您的儲值餘額尚有 NT$ ${yuan(member.wallet_balance).toLocaleString('zh-TW')}。`);
  if (member.pass_count > 0) L.push(`您還有 ${member.pass_count} 張次卡未使用完畢，記得留意到期日。`);
  L.push('');
  L.push('近期想找時間放鬆一下嗎？回覆這則訊息就能預約，我們幫您留位。');
  L.push(company());
  return L.join('\n');
}

// 技師的當日班表／上鐘通知
function therapistText(therapistId, workDate) {
  const d = workDate || today();
  const t = db.prepare('SELECT * FROM therapists WHERE id = ?').get(therapistId);
  if (!t) return null;
  const rows = db.prepare(`SELECT tk.*, COALESCE(m.name, tk.guest_name) AS customer,
                             m.pressure_pref, m.avoid_parts, m.conditions, r.name AS room_name
                           FROM tickets tk
                           LEFT JOIN members m ON m.id = tk.member_id
                           LEFT JOIN rooms r ON r.id = tk.room_id
                           WHERE tk.therapist_id = ? AND substr(tk.start_at,1,10) = ?
                             AND tk.status IN ('booked','serving') ORDER BY tk.start_at`).all(therapistId, d);
  const L = [`${t.name} 您好，${d} 的預約如下：`];
  if (!rows.length) L.push('（目前沒有預約）');
  for (const r of rows) {
    L.push('—');
    L.push(`${r.start_at.slice(11)}~${r.end_at.slice(11)} ${r.service_name}${r.assign_type === 'designated' ? '（指名）' : ''}`);
    L.push(`客人：${r.customer}${r.room_name ? `　${r.room_name}` : ''}`);
    // 這三行是這則通知真正的價值：技師走進包廂前就知道該注意什麼
    if (r.pressure_pref) L.push(`力道：${r.pressure_pref}`);
    if (r.avoid_parts) L.push(`避開：${r.avoid_parts}`);
    if (r.conditions) L.push(`⚠ 身體狀況：${r.conditions}`);
  }
  L.push(`\n（發送時間 ${nowStamp()}）`);
  return { therapist: t, text: L.join('\n') };
}

module.exports = { enabled, send, bookingText, repurchaseText, therapistText };
