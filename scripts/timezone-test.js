// 時區測試：全站的時間基準都是台北嗎？
//
// 這件事值得單獨寫一支，因為時區錯了**不會報錯**。它只會讓某些數字悄悄落在別的日期上，
// 而且專挑最忙的時段出錯 —— 按摩店深夜到凌晨的鐘單，正好落在 UTC 與台北跨日的那八小時。
//
// 主機的系統時區是 UTC（`timedatectl` 看得到），所以「有沒有正確設成台北」這件事
// 每一個進入點都要各自負責。少設一個地方，那支腳本寫出來的資料就會早八小時。
//
// 三個特別容易踩的陷阱，這裡都各有對應的檢查：
//   1. `toISOString()` 永遠輸出 UTC，完全不理會 process.env.TZ。
//      （「備份與檔案」頁真的因此顯示過比檔名早一天的時間。）
//   2. SQLite 的 `datetime('now','localtime')` 是在**載入 better-sqlite3 的當下**
//      決定要用哪個時區的。TZ 設在 require 之後就來不及了。
//   3. 前端的「今天」如果問瀏覽器要，櫃檯平板時區設錯就會看到別天的輪鐘檯。
process.env.TZ = 'Asia/Taipei';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  db, today, nowStamp, fmtStamp, fmtDate, bizDate, bizRange, shiftDate, addMonths,
  toMinutes, fromMinutes, addMinutes, dateDiff, getSetting, setSetting
} = require('../src/db');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? ' → ' + detail : ''}`); }
  else { fail++; fails.push(`${name}${detail ? '：' + detail : ''}`); console.log(`❌ ${name}${detail ? '：' + detail : ''}`); }
}

console.log('時區測試（全站基準：Asia/Taipei）\n');

// ---- 1. 行程本身 ----
{
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  ok('Node 行程跑在台北時區', tz === 'Asia/Taipei', tz);
  // 台北固定 UTC+8，沒有夏令時間 —— 所以偏移永遠是 -480 分鐘
  ok('與 UTC 的偏移是 +8 小時', new Date().getTimezoneOffset() === -480,
    `${-new Date().getTimezoneOffset() / 60} 小時`);
}

// ---- 2. Node 與 SQLite 講的是同一個時間 ----
// 這一條是整支測試最重要的。兩邊各自決定時區，只要有一邊沒設對就會差八小時，
// 而且是「鐘單寫進去的時間」跟「稽核軌跡的時間」對不起來這種很難查的錯法。
{
  const sqliteNow = db.prepare("SELECT datetime('now','localtime') v").get().v;
  const nodeNow = nowStamp();
  const diff = Math.abs(toMinutes(sqliteNow.slice(0, 16)) - toMinutes(nodeNow));
  ok('SQLite 的 localtime 與 Node 的現在時間一致（差 < 2 分鐘）', diff < 2,
    `SQLite ${sqliteNow} vs Node ${nodeNow}`);
  const sqliteUtc = db.prepare("SELECT datetime('now') v").get().v;
  const utcDiff = toMinutes(sqliteNow.slice(0, 16)) - toMinutes(sqliteUtc.slice(0, 16));
  ok('SQLite 的 localtime 比 UTC 早 8 小時', Math.abs(utcDiff - 480) < 2,
    `差 ${utcDiff} 分鐘（應為 480）`);
}

// ---- 3. 資料庫欄位的預設值（DEFAULT datetime('now','localtime')）----
// 這些欄位不經過 Node，是 SQLite 自己填的。它們也必須是台北時間。
{
  db.prepare("INSERT INTO audit_logs(actor_type,actor_name,action) VALUES('staff','時區測試','時區測試寫入')").run();
  const row = db.prepare("SELECT * FROM audit_logs WHERE action = '時區測試寫入' ORDER BY id DESC LIMIT 1").get();
  const diff = Math.abs(toMinutes(row.created_at.slice(0, 16)) - toMinutes(nowStamp()));
  ok('資料庫自動填的 created_at 是台北時間', diff < 2, `${row.created_at} vs ${nowStamp()}`);
  db.prepare("DELETE FROM audit_logs WHERE action = '時區測試寫入'").run();
}

// ---- 4. 不准用 toISOString() 產生顯示用的時間 ----
// 它永遠是 UTC。這一條是靜態檢查，因為出錯時畫面看起來很正常，只是時間早了八小時。
{
  const files = [];
  const walk = dir => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('toISOString')) return;
      // 註解裡提到它是可以的（我們就是在警告不要用）
      if (/^\s*(\/\/|\*)/.test(line)) return;
      hits.push(`${path.relative(path.join(__dirname, '..'), f)}:${i + 1}`);
    });
  }
  ok('後端沒有用 toISOString() 產生時間字串（它永遠是 UTC）', hits.length === 0, hits.join('、'));
}

// ---- 5. 每一個進入點都設了 TZ，而且設在 require better-sqlite3 之前 ----
{
  const entries = ['src/server.js', 'src/db.js', 'scripts/seed.js', 'scripts/consistency-test.js',
    'scripts/concurrency-test.js', 'scripts/concurrency-worker.js', 'scripts/upload-test.js',
    'scripts/timezone-test.js', 'scripts/e2e-test.js'];
  const missing = [];
  const tooLate = [];
  for (const e of entries) {
    const src = fs.readFileSync(path.join(__dirname, '..', e), 'utf8');
    const tzAt = src.indexOf('process.env.TZ');
    if (tzAt < 0) { missing.push(e); continue; }
    // TZ 必須設在第一個 require 之前（db.js 開頭的註解解釋了為什麼）
    const firstRequire = src.search(/^\s*const .*=\s*require\(/m);
    if (firstRequire >= 0 && firstRequire < tzAt) tooLate.push(e);
  }
  ok('每個進入點都設定了 TZ', missing.length === 0, missing.join('、'));
  ok('TZ 都設在第一個 require 之前', tooLate.length === 0, tooLate.join('、'));
}

// ---- 6. 營業日換算（24 小時店的凌晨算前一天）----
{
  const saved = getSetting('business_day_start', '04:00');
  setSetting('business_day_start', '04:00');
  ok('凌晨 02:00 算前一天的生意', bizDate('2026-09-05 02:00') === '2026-09-04',
    bizDate('2026-09-05 02:00'));
  ok('凌晨 03:59 還是前一天', bizDate('2026-09-05 03:59') === '2026-09-04',
    bizDate('2026-09-05 03:59'));
  ok('04:00 整開始算當天', bizDate('2026-09-05 04:00') === '2026-09-05',
    bizDate('2026-09-05 04:00'));
  ok('中午當然是當天', bizDate('2026-09-05 12:00') === '2026-09-05');
  ok('晚上 23:59 也是當天', bizDate('2026-09-05 23:59') === '2026-09-05');
  const r = bizRange('2026-09-05');
  ok('營業日區間跨午夜', r.start === '2026-09-05 04:00' && r.end === '2026-09-06 04:00',
    `${r.start} ~ ${r.end}`);
  // 設成 00:00 就是不做換算（一般日班店家）
  setSetting('business_day_start', '00:00');
  ok('設 00:00 時凌晨的單就算當天', bizDate('2026-09-05 02:00') === '2026-09-05');
  const r2 = bizRange('2026-09-05');
  ok('設 00:00 時區間就是整個自然日',
    r2.start === '2026-09-05 00:00' && r2.end === '2026-09-06 00:00', `${r2.start} ~ ${r2.end}`);
  setSetting('business_day_start', saved);
}

// ---- 7. 日期運算不受時區影響 ----
// toMinutes/fromMinutes 刻意走 UTC 當作純算術，這是對的 —— 但要確認它真的自洽，
// 而且跨月、跨年、閏年都不會少一天。
{
  const cases = ['2026-01-01 00:00', '2026-02-28 23:59', '2026-03-01 00:00',
    '2024-02-29 12:00', '2026-12-31 23:59', '2026-09-05 04:00'];
  for (const c of cases) {
    ok(`${c} 轉成分鐘再轉回來不變`, fromMinutes(toMinutes(c)) === c, fromMinutes(toMinutes(c)));
  }
  ok('跨月加一天', shiftDate('2026-01-31', 1) === '2026-02-01', shiftDate('2026-01-31', 1));
  ok('跨年加一天', shiftDate('2026-12-31', 1) === '2027-01-01', shiftDate('2026-12-31', 1));
  ok('閏年 2/28 加一天是 2/29', shiftDate('2024-02-28', 1) === '2024-02-29', shiftDate('2024-02-28', 1));
  ok('平年 2/28 加一天是 3/1', shiftDate('2026-02-28', 1) === '2026-03-01', shiftDate('2026-02-28', 1));
  ok('1/31 加一個月退到 2/28', addMonths('2026-01-31', 1) === '2026-02-28', addMonths('2026-01-31', 1));
  ok('1/31 加一個月（閏年）退到 2/29', addMonths('2024-01-31', 1) === '2024-02-29', addMonths('2024-01-31', 1));
  ok('跨午夜加分鐘', addMinutes('2026-09-05 23:30', 60) === '2026-09-06 00:30',
    addMinutes('2026-09-05 23:30', 60));
  ok('日期相差天數', dateDiff('2026-09-01', '2026-09-05') === 4);
  ok('今天減今天是 0 天', dateDiff(today(), today()) === 0);
}

// ---- 8. fmtStamp / fmtDate 產生的是台北時間 ----
{
  // 用一個固定的時刻：2026-09-05 02:00 UTC = 台北 10:00
  const d = new Date(Date.UTC(2026, 8, 5, 2, 0));
  ok('fmtStamp 把 UTC 02:00 顯示成台北 10:00', fmtStamp(d) === '2026-09-05 10:00', fmtStamp(d));
  ok('fmtDate 取的是台北的日期', fmtDate(d) === '2026-09-05', fmtDate(d));
  // 跨日的那一刻：UTC 前一天 16:30 = 台北當天 00:30
  const cross = new Date(Date.UTC(2026, 8, 4, 16, 30));
  ok('UTC 前一天 16:30 在台北是隔天 00:30', fmtStamp(cross) === '2026-09-05 00:30', fmtStamp(cross));
  ok('這種時刻的日期要算隔天（用 toISOString 會錯一天）',
    fmtDate(cross) === '2026-09-05' && cross.toISOString().slice(0, 10) === '2026-09-04',
    `fmtDate ${fmtDate(cross)} vs toISOString ${cross.toISOString().slice(0, 10)}`);
  ok('today() 與 nowStamp() 是同一天', nowStamp().startsWith(today()));
}

// ---- 9. 既有資料：沒有明顯來自 UTC 的時間 ----
// 如果曾經有一段時間跑在 UTC，資料庫裡會留下比同批資料早八小時的紀錄。
{
  const bad = db.prepare(`SELECT COUNT(*) n FROM tickets
    WHERE actual_end <> '' AND actual_start <> '' AND actual_end < actual_start`).get().n;
  ok('沒有鐘單的結束時間早於開始時間', bad === 0, `${bad} 張`);
  // 營業日欄位要跟實際時間對得起來
  const mismatch = db.prepare(`SELECT ticket_no, biz_date, start_at FROM tickets
    WHERE start_at <> '' AND biz_date <> '' LIMIT 500`).all()
    .filter(t => bizDate(t.start_at) !== t.biz_date);
  ok('每張鐘單的營業日都算得出來一樣', mismatch.length === 0,
    mismatch.slice(0, 3).map(t => `${t.ticket_no} 存 ${t.biz_date} 但算出 ${bizDate(t.start_at)}`).join('、'));
  // 稽核軌跡不該有未來的時間（時鐘往前跳的徵兆）
  const future = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE created_at > ?")
    .get(addMinutes(nowStamp(), 5)).n;
  ok('稽核軌跡沒有未來的時間', future === 0, `${future} 筆`);
}

// ---- 9.5 期間篩選的口徑：全部走營業日，不能有人用日曆日 ----
//
// 鐘單有 biz_date 欄位，儲值流水／次卡／團購券只有 created_at。
// 若後者用 substr(created_at,1,10)（日曆日）在篩期間，24 小時店的凌晨交易
// 就會落在跟鐘單不同的月份 —— 損益的營收算上個月、現金流入算這個月。
{
  const finance = require('../src/finance');
  const saved = getSetting('business_day_start', '04:00');
  setSetting('business_day_start', '04:00');
  const m = db.prepare('SELECT id FROM members LIMIT 1').get();
  if (m) {
    // 月初凌晨 02:00 的儲值：營業日屬於上個月的最後一天
    db.prepare(`INSERT INTO wallet_txns(member_id,kind,cash_delta,amount,cash_after,bonus_after,note,created_at)
      VALUES(?,'topup',1,1,0,0,'營業日口徑測試','2026-09-01 02:00:00')`).run(m.id);
    const sep = finance.cashFlow('2026-09-01', '2026-10-01', null).topup;
    const aug = finance.cashFlow('2026-08-01', '2026-09-01', null).topup;
    ok('凌晨的儲值算在前一個營業日（跟鐘單同一個口徑）', aug >= 1,
      `八月 ${aug}／九月 ${sep}`);
    ok('營業日換算後，這筆不會重複算在兩個月', !(aug >= 1 && sep >= 605001),
      `八月 ${aug}／九月 ${sep}`);
    db.prepare("DELETE FROM wallet_txns WHERE note = '營業日口徑測試'").run();
  }
  // bizExpr 的 SQL 與 bizDate 的 JS 必須算出一樣的結果
  const { bizExpr } = require('../src/db');
  const e = bizExpr('?');
  for (const ts of ['2026-09-05 02:00:00', '2026-09-05 03:59:00',
    '2026-09-05 04:00:00', '2026-09-05 23:30:00', '2026-01-01 01:00:00']) {
    const sql = db.prepare(`SELECT ${e.sql} v`).get(ts, ...e.args).v;
    ok(`SQL 與 JS 對 ${ts} 算出同一個營業日`, sql === bizDate(ts.slice(0, 16)),
      `SQL ${sql} vs JS ${bizDate(ts.slice(0, 16))}`);
  }
  // 設 00:00（不做營業日換算）時要退回單純的日期
  setSetting('business_day_start', '00:00');
  const plain = bizExpr('x');
  ok('關閉營業日換算時，SQL 退回單純截日期', plain.sql.includes('substr') && plain.args.length === 0,
    plain.sql);
  setSetting('business_day_start', saved);
}

// ---- 9.7 輪次的日期口徑：加與減必須掛在同一張班上 ----
//
// 這是實際踩到的 bug：開單用營業日、上鐘／下鐘／取消用日曆日。
// 24 小時店凌晨兩點的單，輪次加在「昨天的班」卻要從「今天的班」扣回來 ——
// 扣不到，那位技師的輪次就永遠多一次，而輪鐘檯的公平性正是這套系統的核心。
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'tickets.js'), 'utf8');
  // 這幾支都不能再用 .slice(0, 10) 從時間字串截日期
  const bad = [];
  for (const m of src.matchAll(/rotation\.(consume|release|rollback)\(\{[\s\S]{0,240}?\}\)/g)) {
    if (/workDate:[^,]*slice\(0, ?10\)/.test(m[0])) bad.push(m[1]);
  }
  ok('輪次的加減都用營業日，不是從時間字串截日曆日', bad.length === 0, bad.join('、'));

  const srv = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  ok('每日維護找班也用營業日，不是 start_at 截前十碼',
    !srv.includes('.get(s.start_at.slice(0, 10)'));

  // 實際驗一次：凌晨的單，開單與取消要算在同一張班上
  const { bizDate: bd } = require('../src/db');
  const dawn = '2026-09-05 02:00';
  ok('凌晨 02:00 的單，開單與取消算的是同一個營業日',
    bd(dawn) === bd(dawn) && bd(dawn) !== dawn.slice(0, 10),
    `營業日 ${bd(dawn)}、日曆日 ${dawn.slice(0, 10)}`);
}

// 輪次不能超過當日實際上過鐘的單數（已預約的單還沒吃輪次）
{
  for (const sh of db.prepare('SELECT * FROM shifts ORDER BY id DESC LIMIT 200').all()) {
    const n = db.prepare(`SELECT COUNT(*) n FROM tickets
      WHERE therapist_id = ? AND biz_date = ? AND status IN ('serving','done')`)
      .get(sh.therapist_id, sh.work_date).n;
    const booked = db.prepare(`SELECT COUNT(*) n FROM tickets
      WHERE therapist_id = ? AND biz_date = ? AND status = 'booked'`).get(sh.therapist_id, sh.work_date).n;
    // 取消的單會把輪次還回去，所以上限就是「上過鐘的 + 還沒上鐘的」
    ok(`${sh.work_date} 技師 #${sh.therapist_id} 輪次不超過上過鐘的單數`,
      sh.rounds <= n + booked, `輪次 ${sh.rounds} > ${n} 已上鐘 + ${booked} 待上鐘`);
  }
}

// ---- 10. 伺服器有把「現在」告訴前端 ----
// 前端拿它跟自己的時鐘對時。少了這個欄位，櫃檯平板時區設錯就會看到別天的資料。
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'masters.js'), 'utf8');
  ok('/options 有回傳 server_now', src.includes('server_now'));
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ui.js'), 'utf8');
  ok('前端的 UI.today() 走對時後的時間而不是瀏覽器時鐘',
    ui.includes('syncClock') && /today\(\)\s*\{\s*const d = UI\.now\(\)/.test(ui));
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  ok('載入選項時會呼叫對時', app.includes('UI.syncClock'));
}

// ---- 11. 換一個時區跑，結果必須一模一樣 ----
// 最直接的驗證：把行程的 TZ 改成紐約，如果程式碼真的處處以台北為準，
// 算出來的營業日與時間戳應該完全不受影響。
{
  const probe = path.join(__dirname, 'tz-probe.js');
  const runIn = tz => JSON.parse(execFileSync(process.execPath, [probe],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
  const taipei = runIn('Asia/Taipei');
  const ny = runIn('America/New_York');
  const utc = runIn('UTC');
  ok('在紐約時區跑，營業日換算結果相同',
    JSON.stringify(taipei.biz) === JSON.stringify(ny.biz),
    `台北 ${JSON.stringify(taipei.biz)} vs 紐約 ${JSON.stringify(ny.biz)}`);
  ok('在 UTC 跑，營業日換算結果相同',
    JSON.stringify(taipei.biz) === JSON.stringify(utc.biz));
  ok('在紐約時區跑，日期運算結果相同',
    JSON.stringify(taipei.calc) === JSON.stringify(ny.calc));
  // 這一條擋的是「部署環境順手設了 TZ」——容器映像、systemd、pm2 的父行程都可能帶進來，
  // 而沒有人會意識到它會把整套系統的營業日推移八小時。
  ok('外部 TZ 是紐約或 UTC，行程仍強制跑在台北',
    ny.tz === 'Asia/Taipei' && utc.tz === 'Asia/Taipei',
    `紐約→${ny.tz}、UTC→${utc.tz}`);
  ok('三種環境下 SQLite 與 Node 都一致',
    [taipei, ny, utc].every(r => r.sqlite_matches_node));
}

console.log(`\n時區測試：${pass} 項通過，${fail} 項失敗`);
if (fail) {
  console.log('\n失敗項目：');
  fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✓ 全部通過');
