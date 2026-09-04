// 民俗調理業用語自檢。
//
// 按摩、推拿、腳底按摩屬於「民俗調理業」，不是醫療院所：
// 不得從事醫療行為，也不得宣稱醫療效能。實務上被檢舉的多半不是手法，是**文案**——
// 服務項目寫「治療肩頸痠痛」、officialLINE 貼文寫「三次根治」，這些都會出事。
//
// 系統不會自動改文案（改壞了更糟），但會把踩線的字詞找出來、指出在哪一筆資料的哪個欄位，
// 讓店長自己決定怎麼改。
const { db, getSetting, getList, today, dateDiff, num } = require('./db');

// 設定裡的禁用詞可以寫成「治療」或「療程（改稱「服務」）」兩種格式，
// 後者括號裡是建議替代，掃描時只比對括號前的部分。
function bannedTerms() {
  return getSetting('banned_terms', '').split('\n').map(s => s.trim()).filter(Boolean)
    .map(line => {
      const m = line.match(/^(.+?)（(.+)）$/);
      return m ? { term: m[1].trim(), suggest: m[2].trim() } : { term: line, suggest: '' };
    });
}

const SUGGEST = {
  治療: '改用「舒緩」「調理」', 療效: '改用「舒適感受」', 醫療: '避免使用', 診斷: '改用「觀察」「評估」',
  復健: '避免使用', 矯正: '改用「調整姿勢」', 根治: '避免使用', 痊癒: '避免使用',
  消炎: '避免使用', 止痛: '改用「放鬆緊繃」', 整脊: '避免使用（涉及醫療行為）',
  正骨: '避免使用（涉及醫療行為）', 排毒: '改用「促進循環」', 瘦身: '改用「體態放鬆」',
  減肥: '避免使用', 豐胸: '避免使用', 療程: '改用「服務」「課程」'
};

// 掃描一段文字，回傳命中的字詞
function scanText(text) {
  const s = String(text || '');
  const hits = [];
  for (const { term, suggest } of bannedTerms()) {
    if (!term) continue;
    let idx = s.indexOf(term);
    while (idx >= 0) {
      hits.push({
        term,
        suggest: suggest || SUGGEST[term] || '請改用非醫療性描述',
        context: s.slice(Math.max(0, idx - 12), idx + term.length + 12)
      });
      idx = s.indexOf(term, idx + term.length);
      if (hits.length > 200) break;
    }
  }
  return hits;
}

// 掃描資料庫裡所有對外會看到的文字
function scanAll() {
  const targets = [
    { table: 'services', label: '服務項目', fields: ['name', 'description'], nameField: 'name' },
    { table: 'retail_products', label: '販售商品', fields: ['name', 'note'], nameField: 'name' },
    { table: 'stores', label: '分店', fields: ['name', 'note'], nameField: 'name' }
  ];
  const findings = [];
  for (const t of targets) {
    const rows = db.prepare(`SELECT * FROM ${t.table} WHERE active = 1`).all();
    for (const r of rows) {
      for (const f of t.fields) {
        for (const h of scanText(r[f])) {
          findings.push({ source: t.label, table: t.table, id: r.id, name: r[t.nameField], field: f, ...h });
        }
      }
    }
  }
  // 系統設定裡的對外文案（登入頁副標、線上預約說明）也一起掃
  for (const key of ['ui_login_sub', 'booking_notice', 'company_name']) {
    for (const h of scanText(getSetting(key, ''))) {
      findings.push({ source: '系統設定', table: 'settings', id: key, name: key, field: 'value', ...h });
    }
  }
  const byTerm = {};
  for (const f of findings) byTerm[f.term] = (byTerm[f.term] || 0) + 1;
  return {
    findings,
    total: findings.length,
    by_term: Object.entries(byTerm).map(([term, count]) => ({ term, count })).sort((a, b) => b.count - a.count),
    note: getSetting('compliance_note', ''),
    terms: bannedTerms()
  };
}

// 技師證照與健檢到期總表。稽查時看的就是這兩張紙。
function expiry({ days } = {}) {
  const warn = Number(days) || num('expiry_warn_days', 45);
  const t = today();
  const rows = db.prepare(`SELECT th.*, s.name AS store_name FROM therapists th
    LEFT JOIN stores s ON s.id = th.store_id WHERE th.active = 1 ORDER BY th.name`).all();
  const out = [];
  for (const r of rows) {
    for (const [field, kind] of [['cert_expiry', '技術士證'], ['health_check_expiry', '健康檢查']]) {
      const v = r[field];
      const left = v ? dateDiff(t, v) : null;
      // 沒填也要列出來：稽查時「沒有這張紙」跟「過期」一樣糟
      const status = !v ? 'missing' : left < 0 ? 'expired' : left <= warn ? 'soon' : 'ok';
      out.push({
        therapist_id: r.id, name: r.name, code: r.code, level: r.level,
        store_name: r.store_name || '', kind, field, expiry_date: v || '',
        days_left: left, status,
        cert_no: field === 'cert_expiry' ? r.cert_no : '',
        check_date: field === 'health_check_expiry' ? r.health_check_date : ''
      });
    }
  }
  const rank = { expired: 0, missing: 1, soon: 2, ok: 3 };
  out.sort((a, b) => rank[a.status] - rank[b.status] || String(a.expiry_date).localeCompare(String(b.expiry_date)));
  return {
    rows: out, warn_days: warn,
    summary: {
      expired: out.filter(x => x.status === 'expired').length,
      missing: out.filter(x => x.status === 'missing').length,
      soon: out.filter(x => x.status === 'soon').length,
      ok: out.filter(x => x.status === 'ok').length
    }
  };
}

// 客人同意書／問診紀錄的完整度。留存這個是為了兩件事：
// 一是真的出狀況時說得清楚，二是主管機關訪查時拿得出來。
function consentAudit() {
  const rows = db.prepare(`
    SELECT m.id, m.member_no, m.name, m.phone, m.consent_at, m.health_updated_at, m.conditions,
           (SELECT COUNT(*) FROM tickets t WHERE t.member_id = m.id AND t.status = 'done') AS visits
    FROM members m WHERE m.active = 1 ORDER BY visits DESC`).all();
  const t = today();
  return rows.map(r => {
    const age = r.health_updated_at ? dateDiff(r.health_updated_at.slice(0, 10), t) : null;
    return {
      ...r,
      has_consent: !!r.consent_at,
      has_health: !!r.health_updated_at,
      health_age_days: age,
      status: !r.consent_at ? 'no_consent' : !r.health_updated_at ? 'no_health'
        : age > 180 ? 'stale' : 'ok'
    };
  }).filter(r => r.visits > 0 || r.status !== 'ok');
}

module.exports = { scanText, scanAll, expiry, consentAudit, bannedTerms };
