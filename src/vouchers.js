// 團購券（Klook／GOMAJI／KKday）。
//
// 團購券跟現場收現金是完全不同的兩件事，混在一起記帳一定會錯：
//   · 錢是平台先收走的，店家要等月結才拿得到，中間被抽走一兩成
//   · 券有到期日，過期客人不能用（但客人往往不知道，櫃檯要擋得住並講得出理由）
//   · 同一張券號只能核銷一次 —— 重複核銷是實際會發生的糾紛，靠人眼是防不住的
//
// 所以：券在鐘單上折抵的是「券面價值」，但店家的實收是「淨收」，
// 兩個數字都要留，否則月結對不上平台的撥款單。
const { db, today, nowStamp, audit, yuan, num, getSetting, dateDiff } = require('./db');

function voucherOf(id) { return db.prepare('SELECT * FROM vouchers WHERE id = ?').get(id); }

function findByCode(platform, code) {
  return db.prepare('SELECT * FROM vouchers WHERE platform = ? AND code = ?').get(platform, String(code).trim());
}

function realStatus(v) {
  if (!v) return null;
  if (v.status === 'unused' && v.expiry_date && v.expiry_date < today()) return 'expired';
  return v.status;
}

// 建券。平台抽成％沒填就用系統設定的預設值，淨收自動算。
const create = db.transaction((d, actor) => {
  const platform = String(d.platform || '').trim();
  const code = String(d.code || '').trim();
  if (!platform) throw new Error('請選擇平台');
  if (!code) throw new Error('請填寫券號');
  if (findByCode(platform, code)) throw new Error(`${platform} 的券號 ${code} 已經建過了`);
  const face = yuan(d.face_value);
  const pct = d.commission_pct === undefined || d.commission_pct === ''
    ? num('voucher_commission_pct', 20) : Number(d.commission_pct) || 0;
  const net = d.net_receivable !== undefined && d.net_receivable !== ''
    ? yuan(d.net_receivable) : yuan(face * (100 - pct) / 100);
  const info = db.prepare(`INSERT INTO vouchers(platform,code,batch,service_id,title,face_value,net_receivable,
      commission_pct,buyer_name,buyer_phone,issued_date,expiry_date,store_id,note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(platform, code, String(d.batch || ''), d.service_id ? Number(d.service_id) : null,
      String(d.title || ''), face, net, pct, String(d.buyer_name || ''), String(d.buyer_phone || ''),
      d.issued_date || today(), String(d.expiry_date || ''),
      d.store_id ? Number(d.store_id) : null, String(d.note || ''));
  audit('staff', null, actor || '', `建立團購券 ${platform} ${code}：面額 ${face}，淨收 ${net}`);
  return voucherOf(info.lastInsertRowid);
});

// 核銷前的檢查。回傳問題清單，跟其他閘門同一個形狀。
function checkUse(v, { serviceId, ticketId } = {}) {
  const issues = [];
  if (!v) return [{ level: 'conflict', code: 'not_found', message: '查無此券號，請確認平台與券號是否輸入正確' }];
  const st = realStatus(v);
  if (st === 'used') {
    issues.push({ level: 'conflict', code: 'used',
      message: `這張券已於 ${v.used_at || '先前'} 核銷過${v.ticket_id ? `（鐘單 #${v.ticket_id}）` : ''}，不能重複使用` });
  } else if (st === 'expired') {
    issues.push({ level: 'conflict', code: 'expired', message: `這張券已於 ${v.expiry_date} 到期` });
  } else if (st === 'void') {
    issues.push({ level: 'conflict', code: 'void', message: '這張券已作廢' });
  }
  if (v.service_id && serviceId && Number(v.service_id) !== Number(serviceId)) {
    const sn = (db.prepare('SELECT name FROM services WHERE id = ?').get(v.service_id) || {}).name || '';
    issues.push({ level: 'conflict', code: 'service',
      message: `這張券限用於「${sn}」，與本次項目不符` });
  }
  if (st === 'unused' && v.expiry_date) {
    const left = dateDiff(today(), v.expiry_date);
    if (left !== null && left <= 14) {
      issues.push({ level: 'warn', code: 'expiring', message: `這張券將於 ${v.expiry_date} 到期（剩 ${left} 天）` });
    }
  }
  return issues;
}

const use = db.transaction(({ voucherId, ticketId, actor }) => {
  const v = voucherOf(voucherId);
  const issues = checkUse(v, {});
  const hard = issues.find(i => i.level === 'conflict');
  if (hard) throw new Error(hard.message);
  db.prepare(`UPDATE vouchers SET status = 'used', ticket_id = ?, used_at = ? WHERE id = ?`)
    .run(ticketId || null, nowStamp(), voucherId);
  audit('staff', null, actor || '', `核銷團購券 ${v.platform} ${v.code}（面額 ${yuan(v.face_value)}）`);
  return voucherOf(voucherId);
});

// 鐘單取消時把券放回去，否則客人的券就平白消失了
const release = db.transaction(({ ticketId, actor }) => {
  const rows = db.prepare("SELECT * FROM vouchers WHERE ticket_id = ? AND status = 'used'").all(ticketId);
  for (const v of rows) {
    db.prepare(`UPDATE vouchers SET status = 'unused', ticket_id = NULL, used_at = '' WHERE id = ?`).run(v.id);
    audit('staff', null, actor || '', `鐘單取消，團購券 ${v.platform} ${v.code} 回復為未核銷`);
  }
  return rows.length;
});

// 月結：把某段期間已核銷的券標記為已入帳。對帳時跟平台的撥款單核對。
const settle = db.transaction(({ ids, settledAt, actor }) => {
  const d = settledAt || today();
  let n = 0;
  for (const id of ids || []) {
    const v = voucherOf(id);
    if (!v || v.status !== 'used') continue;
    db.prepare(`UPDATE vouchers SET status = 'settled', settled_at = ? WHERE id = ?`).run(d, id);
    n++;
  }
  audit('staff', null, actor || '', `團購券月結入帳 ${n} 張（入帳日 ${d}）`);
  return n;
});

// 平台對帳表：各平台各檔期賣了幾張、核銷幾張、面額多少、淨收多少、還沒入帳多少
function reconcile({ from, to, platform } = {}) {
  const where = [], args = [];
  if (from) { where.push('used_at >= ?'); args.push(from + ' 00:00'); }
  if (to) { where.push('used_at <= ?'); args.push(to + ' 23:59'); }
  if (platform) { where.push('platform = ?'); args.push(platform); }
  const rows = db.prepare(`
    SELECT platform, batch,
           COUNT(*) AS used_count,
           COALESCE(SUM(face_value),0) AS face_total,
           COALESCE(SUM(net_receivable),0) AS net_total,
           COALESCE(SUM(CASE WHEN status = 'settled' THEN net_receivable ELSE 0 END),0) AS settled_total,
           COALESCE(SUM(CASE WHEN status = 'used' THEN net_receivable ELSE 0 END),0) AS pending_total
    FROM vouchers
    WHERE status IN ('used','settled')${where.length ? ' AND ' + where.join(' AND ') : ''}
    GROUP BY platform, batch ORDER BY platform, batch`).all(...args);
  const stock = db.prepare(`
    SELECT platform,
      SUM(CASE WHEN status = 'unused' AND (expiry_date = '' OR expiry_date >= ?) THEN 1 ELSE 0 END) AS unused,
      SUM(CASE WHEN status = 'unused' AND expiry_date <> '' AND expiry_date < ? THEN 1 ELSE 0 END) AS expired
    FROM vouchers GROUP BY platform`).all(today(), today());
  return {
    rows, stock,
    total: {
      face: yuan(rows.reduce((s, r) => s + r.face_total, 0)),
      net: yuan(rows.reduce((s, r) => s + r.net_total, 0)),
      settled: yuan(rows.reduce((s, r) => s + r.settled_total, 0)),
      pending: yuan(rows.reduce((s, r) => s + r.pending_total, 0))
    }
  };
}

// 每日維護：把過期的未核銷券標記起來
function expireOld() {
  const r = db.prepare(`UPDATE vouchers SET status = 'expired'
                        WHERE status = 'unused' AND expiry_date <> '' AND expiry_date < ?`).run(today());
  return r.changes;
}

module.exports = { voucherOf, findByCode, realStatus, create, checkUse, use, release, settle, reconcile, expireOld };
