// 時區探針。由 timezone-test.js 用不同的 TZ 環境變數各跑一次，
// 比對輸出是否一模一樣 —— 如果程式碼真的處處以台北為準，
// 外面的 TZ 是紐約還是 UTC 都不該影響任何一個數字。
//
// 注意這裡**故意不設** process.env.TZ：要測的就是 src/db.js 自己有沒有校正回來。
const {
  today, nowStamp, fmtStamp, fmtDate, bizDate, bizRange, shiftDate, addMonths,
  addMinutes, toMinutes, db
} = require('../src/db');

const fixed = new Date(Date.UTC(2026, 8, 4, 16, 30));   // 台北 2026-09-05 00:30

const sqliteNow = db.prepare("SELECT datetime('now','localtime') v").get().v;

console.log(JSON.stringify({
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  biz: {
    dawn: bizDate('2026-09-05 02:00'),
    cutoff: bizDate('2026-09-05 04:00'),
    noon: bizDate('2026-09-05 12:00'),
    range: bizRange('2026-09-05')
  },
  calc: {
    stamp: fmtStamp(fixed),
    date: fmtDate(fixed),
    shift: shiftDate('2026-12-31', 1),
    months: addMonths('2024-01-31', 1),
    minutes: addMinutes('2026-09-05 23:30', 60)
  },
  // SQLite 與 Node 是不是在講同一個時間（差 2 分鐘內視為一致）
  sqlite_matches_node: Math.abs(toMinutes(sqliteNow.slice(0, 16)) - toMinutes(nowStamp())) < 2,
  today: today()
}));
