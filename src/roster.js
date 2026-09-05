// 班表（預排班）。
//
// shifts 是「當日簽到表」—— 誰來了、第幾號、輪到第幾次。它回答的是「現在誰該上鐘」。
// 班表回答的是完全不同的問題：「下週三晚上有幾個人？」「阿美排了特休嗎？」
// 這件事現在是在 LINE 群組發圖片解決的，於是排班表沒有版本、改了沒人知道、
// 月底算全勤還要回去翻對話紀錄。
//
// 兩張表刻意不合併：班表是計畫，簽到是事實。人排了早班卻沒來，兩邊就該對不起來 ——
// 那個落差正是店長要看的東西（見 compare）。
const { db, today, shiftDate, dateDiff, getSetting, nowStamp, audit } = require('./db');

// 班別設定：'早班=10:00|19:00' → { code:'早班', start:'10:00', end:'19:00', off:false }
function shiftTypes() {
  return getSetting('roster_shifts', '').split('\n').map(s => s.trim()).filter(Boolean).map(line => {
    const [code, rest = ''] = line.split('=');
    const [start = '', end = ''] = rest.split('|');
    return { code: code.trim(), start: start.trim(), end: end.trim(),
      // 沒有時間的班別就是休假類（休假、特休、請假）：不算人力，也不該排時間
      off: !start.trim() && !end.trim() };
  });
}
function typeOf(code) {
  return shiftTypes().find(t => t.code === code) || { code, start: '', end: '', off: false };
}

// 一週（或任意區間）的班表。回傳的形狀直接對應畫面上的網格：技師 × 日期。
function grid({ from, to, storeId }) {
  const start = from || today();
  const end = to || shiftDate(start, 6);
  const sf = storeId ? ' AND t.store_id = ?' : '';
  const args = storeId ? [Number(storeId)] : [];
  const therapists = db.prepare(`SELECT t.id, t.code, t.name, t.nickname, t.level, t.store_id, t.employ_type
    FROM therapists t WHERE t.active = 1${sf} ORDER BY t.code, t.name`).all(...args);
  const rows = db.prepare(`SELECT r.* FROM rosters r WHERE r.work_date >= ? AND r.work_date <= ?
    ${storeId ? 'AND r.store_id = ?' : ''}`).all(start, end, ...args);
  const dates = [];
  for (let d = start; d <= end; d = shiftDate(d, 1)) dates.push(d);
  const map = {};
  for (const r of rows) map[`${r.work_date}|${r.therapist_id}`] = r;
  // 每天排了幾個人上班（不含休假類）——「人力 vs 預約量」就靠這個數字
  const headcount = {};
  for (const d of dates) {
    headcount[d] = therapists.filter(t => {
      const r = map[`${d}|${t.id}`];
      return r && !typeOf(r.shift_code).off;
    }).length;
  }
  return { from: start, to: end, dates, therapists, cells: map, headcount, types: shiftTypes() };
}

// 排一格。同一天同一位技師只有一筆（UNIQUE），所以是 upsert。
const set = db.transaction(({ workDate, therapistId, shiftCode, startTime, endTime, storeId, note, actor }) => {
  const t = db.prepare('SELECT * FROM therapists WHERE id = ?').get(therapistId);
  if (!t) throw new Error('找不到這位技師');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(workDate || ''))) throw new Error('日期格式不正確');
  const code = String(shiftCode || '').trim();
  // 空的班別代碼＝把這一格清掉（畫面上選「—」就是這個）
  if (!code) {
    db.prepare('DELETE FROM rosters WHERE work_date = ? AND therapist_id = ?').run(workDate, therapistId);
    return null;
  }
  const ty = typeOf(code);
  const st = startTime !== undefined && startTime !== null ? String(startTime) : ty.start;
  const en = endTime !== undefined && endTime !== null ? String(endTime) : ty.end;
  db.prepare(`INSERT INTO rosters(work_date,therapist_id,store_id,shift_code,start_time,end_time,note,actor)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(work_date,therapist_id) DO UPDATE SET
        shift_code=excluded.shift_code, start_time=excluded.start_time, end_time=excluded.end_time,
        store_id=excluded.store_id, note=excluded.note, actor=excluded.actor`)
    .run(workDate, therapistId, storeId || t.store_id || null, code, ty.off ? '' : st, ty.off ? '' : en,
      String(note || ''), String(actor || ''));
  return db.prepare('SELECT * FROM rosters WHERE work_date = ? AND therapist_id = ?').get(workDate, therapistId);
});

// 批次儲存整週（畫面上按一次儲存）
const bulkSet = db.transaction(({ cells, storeId, actor }) => {
  let n = 0;
  for (const c of cells || []) {
    set({ workDate: c.work_date, therapistId: Number(c.therapist_id), shiftCode: c.shift_code,
      startTime: c.start_time, endTime: c.end_time, storeId, note: c.note, actor });
    n++;
  }
  audit('staff', null, actor || '', `更新班表 ${n} 格`);
  return { saved: n };
});

// 複製上一週。排班多半是「上週那樣，改兩個人」，從零排一遍沒有人受得了。
const copyWeek = db.transaction(({ fromStart, toStart, storeId, overwrite = false, actor }) => {
  const days = 7;
  const sf = storeId ? ' AND store_id = ?' : '';
  const args = storeId ? [Number(storeId)] : [];
  const src = db.prepare(`SELECT * FROM rosters WHERE work_date >= ? AND work_date <= ?${sf}`)
    .all(fromStart, shiftDate(fromStart, days - 1), ...args);
  if (!src.length) throw new Error('來源週沒有任何班表可以複製');
  let n = 0, skipped = 0;
  for (const r of src) {
    const offset = dateDiff(fromStart, r.work_date);
    const target = shiftDate(toStart, offset);
    const exist = db.prepare('SELECT id FROM rosters WHERE work_date = ? AND therapist_id = ?')
      .get(target, r.therapist_id);
    // 預設不覆蓋已經排好的格子：店長常常是「先排好幾個確定的，再複製其他的」，
    // 一律覆蓋會把他剛剛排的東西吃掉。
    if (exist && !overwrite) { skipped++; continue; }
    set({ workDate: target, therapistId: r.therapist_id, shiftCode: r.shift_code,
      startTime: r.start_time, endTime: r.end_time, storeId: r.store_id, note: r.note, actor });
    n++;
  }
  audit('staff', null, actor || '', `複製班表：${fromStart} 那一週 → ${toStart}（寫入 ${n} 格、略過 ${skipped} 格）`);
  return { copied: n, skipped };
});

// 班表 vs 實際：誰排了班沒簽到、誰沒排班卻來上班、每天的人力對上預約量夠不夠。
//
// 「排了班沒來」是要扣全勤的依據，「沒排班卻來了」通常是臨時調班沒有人去改班表 ——
// 兩種都要看得到，因為它們最後都會變成薪資爭議。
function compare({ from, to, storeId }) {
  const start = from || today();
  const end = to || start;
  const sf = storeId ? ' AND r.store_id = ?' : '';
  const args = storeId ? [Number(storeId)] : [];
  const rosters = db.prepare(`SELECT r.*, t.name, t.code FROM rosters r
    JOIN therapists t ON t.id = r.therapist_id
    WHERE r.work_date >= ? AND r.work_date <= ?${sf}`).all(start, end, ...args);
  const shifts = db.prepare(`SELECT s.*, t.name, t.code FROM shifts s
    JOIN therapists t ON t.id = s.therapist_id
    WHERE s.work_date >= ? AND s.work_date <= ?${storeId ? ' AND s.store_id = ?' : ''}`)
    .all(start, end, ...args);
  const key = r => `${r.work_date}|${r.therapist_id}`;
  const rmap = Object.fromEntries(rosters.map(r => [key(r), r]));
  const smap = Object.fromEntries(shifts.map(s => [key(s), s]));

  const absent = rosters.filter(r => !typeOf(r.shift_code).off && !smap[key(r)])
    .map(r => ({ work_date: r.work_date, therapist_id: r.therapist_id, name: r.name, code: r.code,
      shift_code: r.shift_code, problem: '排了班但沒有簽到' }));
  const unplanned = shifts.filter(s => {
    const r = rmap[key(s)];
    return !r || typeOf(r.shift_code).off;
  }).map(s => ({ work_date: s.work_date, therapist_id: s.therapist_id, name: s.name, code: s.code,
    shift_code: rmap[key(s)] ? rmap[key(s)].shift_code : '', problem: '沒有排班（或排休）卻簽到了' }));

  return { from: start, to: end, absent, unplanned };
}

// 人力 vs 生意量：每天排了幾個人、實際簽到幾個、做了幾鐘、有幾個預約。
// 排班過剩（人多鐘少）跟排班不足（客人排不進來）都在這張表上看得出來。
function demand({ from, to, storeId }) {
  const start = from || today();
  const end = to || shiftDate(start, 13);
  const sf = storeId ? ' AND store_id = ?' : '';
  const args = storeId ? [Number(storeId)] : [];
  const g = grid({ from: start, to: end, storeId });
  const booked = db.prepare(`SELECT biz_date d, COUNT(*) n, COALESCE(SUM(minutes),0) minutes
    FROM tickets WHERE biz_date >= ? AND biz_date <= ? AND status IN ('booked','serving','done')${sf}
    GROUP BY biz_date`).all(start, end, ...args);
  const bmap = Object.fromEntries(booked.map(b => [b.d, b]));
  const checked = db.prepare(`SELECT work_date d, COUNT(*) n FROM shifts
    WHERE work_date >= ? AND work_date <= ?${sf} GROUP BY work_date`).all(start, end, ...args);
  const cmap = Object.fromEntries(checked.map(c => [c.d, c.n]));
  return g.dates.map(d => {
    const b = bmap[d] || { n: 0, minutes: 0 };
    const planned = g.headcount[d] || 0;
    return {
      date: d, planned, checked_in: cmap[d] || 0, tickets: b.n, minutes: b.minutes,
      // 一個人一天大約能做的鐘數（用設定的每日時數上限估）
      capacity_minutes: planned * Number(getSetting('daily_minutes_max', '480') || 480),
      load: planned ? b.minutes / (planned * Number(getSetting('daily_minutes_max', '480') || 480)) : 0
    };
  });
}

module.exports = { shiftTypes, typeOf, grid, set, bulkSet, copyWeek, compare, demand };
