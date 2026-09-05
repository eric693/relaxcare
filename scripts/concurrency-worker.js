// 跨行程並發測試的工人。由 concurrency-test.js 同時 spawn 好幾個，
// 各自直接開資料庫寫入 —— 繞過 HTTP 伺服器的排隊，才測得到真正的跨行程競爭。
//
// 這模擬的是實際會發生的兩件事：pm2 開 cluster（多個伺服器行程共用同一個 .db），
// 以及有人在伺服器還跑著的時候執行 `npm run seed` 或一支修資料的腳本。
process.env.TZ = 'Asia/Taipei';

const [, , mode, a1, a2] = process.argv;

// 每個行程各自延遲一小段隨機時間再動手，讓它們真的擠在一起
const jitter = Math.floor(Math.random() * 40);
const started = Date.now();
while (Date.now() - started < jitter) { /* 忙等，避免 setTimeout 讓行程先各自暖機完 */ }

try {
  if (mode === 'closing') {
    const closing = require('../src/closing');
    const r = closing.create({ biz_date: a1, shift_label: a2, counted_cash: 0,
      note: '跨行程測試：實點 0 元', actor: `worker-${process.pid}` });
    console.log(`OK ${r.closing_no}`);
  } else if (mode === 'stock') {
    const inventory = require('../src/inventory');
    inventory.adjust({ productId: Number(a1), qty: -1, reason: '跨行程測試出庫',
      actor: `worker-${process.pid}` });
    console.log('OK');
  } else {
    throw new Error('不認得的模式：' + mode);
  }
} catch (e) {
  console.log(`FAIL ${e.message}`);
}
