// 上傳邊界測試。
//
// storage.js 的承諾是一句話：**畫面說「上傳成功」時，檔案必定已經落盤而且內容正確。**
// 這一支就是在攻擊那句話 —— 用各種壞掉、超大、假冒、被截斷的輸入去打它，
// 看它是不是每一種都能誠實地說「失敗」，而不是存進一個看起來像好的爛檔案。
//
// 為什麼值得單獨寫一支：上傳壞掉的代價是**延遲爆炸**。
// 存進去的當下什麼事都沒有，要等到幾個月後客人主張受傷、要調同意書出來時才發現簽名檔是壞的，
// 那時候已經救不回來了。所以驗證要在存檔的當下做完，而這支測試驗的就是「有沒有真的做完」。
process.env.TZ = 'Asia/Taipei';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const storage = require('../src/storage');
const { db } = require('../src/db');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? ' → ' + detail : ''}`); }
  else { fail++; fails.push(`${name}${detail ? '：' + detail : ''}`); console.log(`❌ ${name}${detail ? '：' + detail : ''}`); }
}
// 期待丟出例外，而且訊息要看得懂（不是一句 undefined 或 SQLITE_ERROR）
function rejects(name, fn, expectRe) {
  try {
    fn();
    ok(name, false, '竟然成功了');
  } catch (e) {
    const msg = e.message || String(e);
    ok(name, expectRe.test(msg), `訊息不符預期：${msg}`);
    if (expectRe.test(msg)) console.log(`      擋下的訊息：${msg}`);
  }
}

// ---- 產生一張真的 PNG（指定尺寸，用來湊出不同的檔案大小）----
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// noise=true 會填隨機像素，壓縮不掉 —— 這樣才做得出「真的很大」的檔案
function makePng(w, h, noise = false) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 0;
    if (noise) crypto.randomFillSync(row, 1);
    else row.fill(0xC8, 1);
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: noise ? 0 : 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
}
const asDataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

const member = db.prepare('SELECT * FROM members WHERE active = 1 ORDER BY id LIMIT 1').get();
const created = [];
function save(dataUrl, filename = 'test.png', kind = 'photo') {
  const a = storage.save({ dataUrl, filename, ownerType: 'member', ownerId: member.id, kind, actor: '上傳測試' });
  created.push(a.id);
  return a;
}

// 磁碟上原本就有的孤兒檔案（前人留下的），測試只負責不要再製造新的
const orphansBefore = storage.orphanFiles();

console.log('上傳邊界測試\n');

// ================= 正常路徑 =================

{
  const png = makePng(40, 40);
  const a = save(asDataUrl('image/png', png), '正常照片.png');
  const onDisk = fs.readFileSync(storage.pathOf(a));
  ok('正常 PNG 存得進去', a.bytes === png.length, `${a.bytes} 位元組`);
  ok('磁碟上的檔案與上傳的位元組完全相同', onDisk.equals(png));
  ok('指紋等於內容的 SHA-256', a.sha256 === crypto.createHash('sha256').update(png).digest('hex'));
  ok('存檔當下就記了驗證時間', !!a.verified_at, a.verified_at);
  ok('副檔名由 MIME 決定而不是使用者給的檔名', a.stored_name.endsWith('.png'), a.stored_name);
}

// 檔名帶路徑或奇怪字元，不能影響實際落盤的位置
{
  const a = save(asDataUrl('image/png', makePng(8, 8)), '../../../etc/passwd.png');
  const dir = path.dirname(path.resolve(storage.pathOf(a)));
  ok('檔名帶 ../ 也逃不出 uploads 目錄', dir === path.resolve(storage.UPLOAD_DIR), dir);
  ok('原始檔名照樣保留給使用者看', a.filename.includes('passwd'), a.filename);
}

// 同時存兩個內容一模一樣的檔案，不能互相覆蓋
{
  const png = makePng(16, 16);
  const a = save(asDataUrl('image/png', png), '同名.png');
  const b = save(asDataUrl('image/png', png), '同名.png');
  ok('內容相同的兩次上傳各自存成獨立檔案', a.stored_name !== b.stored_name,
    `${a.stored_name} / ${b.stored_name}`);
  ok('兩個檔案都真的存在',
    fs.existsSync(storage.pathOf(a)) && fs.existsSync(storage.pathOf(b)));
}

// 各種允許的型別
{
  // 每一種都要做成「完整的」檔案 —— 檔頭與檔尾都對，因為 storage 現在兩邊都驗
  const webpBody = Buffer.concat([Buffer.from('WEBP'), Buffer.alloc(64, 7)]);
  const webpLen = Buffer.alloc(4); webpLen.writeUInt32LE(webpBody.length);
  const cases = [
    ['image/png', makePng(8, 8), '.png'],
    ['image/jpeg', Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 7),
      Buffer.from([0xFF, 0xD9])]), '.jpg'],
    ['image/gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 7), Buffer.from([0x3B])]), '.gif'],
    ['image/webp', Buffer.concat([Buffer.from('RIFF'), webpLen, webpBody]), '.webp'],
    ['application/pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 7),
      Buffer.from('\n%%EOF\n')]), '.pdf']
  ];
  for (const [mime, buf, ext] of cases) {
    const a = save(asDataUrl(mime, buf), 'x' + ext);
    ok(`${mime} 存得進去且副檔名正確`, a.stored_name.endsWith(ext) && a.bytes === buf.length);
  }
}

// ================= 大小邊界 =================

{
  // 剛好在上限之下：8MB 減一點點
  const big = makePng(1200, 700, true);   // 隨機像素，壓不掉，大約 2.5MB
  ok('2MB 以上的照片（手機直出的尺寸）存得進去', big.length > 2 * 1024 * 1024,
    `${(big.length / 1048576).toFixed(1)}MB`);
  const a = save(asDataUrl('image/png', big), '大照片.png');
  ok('大照片的指紋一樣驗得過', a.bytes === big.length,
    `${(a.bytes / 1048576).toFixed(1)}MB`);
}
{
  // 超過上限
  const over = Buffer.alloc(storage.MAX_BYTES + 1024);
  crypto.randomFillSync(over);
  over.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0);
  rejects('超過 8MB 會被擋（而且講得出實際大小）',
    () => save(asDataUrl('image/png', over), '太大.png'), /超過上限/);
}
{
  rejects('空檔案會被擋', () => save('data:image/png;base64,', '空的.png'), /空的|格式不正確/);
}

// ================= 假冒與損壞 =================

rejects('宣稱是 PNG 但內容不是，會被擋',
  () => save(asDataUrl('image/png', Buffer.from('NOT-A-REAL-PNG-'.repeat(8))), '假的.png'),
  /不像 image\/png/);

rejects('HTML 冒充圖片會被擋（不然我們會把 XSS 當圖片送出去）',
  () => save(asDataUrl('image/png', Buffer.from('<script>alert(1)</script>')), 'evil.png'),
  /不像 image\/png/);

rejects('不支援的型別（SVG 可以夾帶腳本）會被擋',
  () => save(asDataUrl('image/svg+xml', Buffer.from('<svg onload="alert(1)"/>')), 'x.svg'),
  /不支援的檔案型別/);

rejects('可執行檔會被擋',
  () => save(asDataUrl('application/x-msdownload', Buffer.from('MZ')), 'x.exe'),
  /不支援的檔案型別/);

rejects('根本不是 data URL 的東西會被擋',
  () => save('https://example.com/photo.png', 'x.png'), /格式不正確/);

rejects('傳到一半斷線（base64 被截斷）會被擋', () => {
  const b64 = makePng(60, 60).toString('base64');
  // 砍掉後面三成，模擬網路斷在一半
  return save('data:image/png;base64,' + b64.slice(0, Math.floor(b64.length * 0.7)), '截斷.png');
}, /不完整|截斷/);

// 每一種格式都要驗得出「被截掉尾巴」
{
  const jpg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 7), Buffer.from([0xFF, 0xD9])]);
  rejects('截斷的 JPEG 會被擋',
    () => save(asDataUrl('image/jpeg', jpg.slice(0, jpg.length - 2)), 'cut.jpg'), /不完整/);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 7), Buffer.from([0x3B])]);
  rejects('截斷的 GIF 會被擋',
    () => save(asDataUrl('image/gif', gif.slice(0, gif.length - 1)), 'cut.gif'), /不完整/);
  const pdfBuf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 7), Buffer.from('\n%%EOF\n')]);
  rejects('截斷的 PDF 會被擋',
    () => save(asDataUrl('application/pdf', pdfBuf.slice(0, 40)), 'cut.pdf'), /不完整/);
  const wb = Buffer.concat([Buffer.from('WEBP'), Buffer.alloc(64, 7)]);
  const wl = Buffer.alloc(4); wl.writeUInt32LE(wb.length);
  const webp = Buffer.concat([Buffer.from('RIFF'), wl, wb]);
  rejects('截斷的 WebP 會被擋（RIFF 標頭寫的長度對不上）',
    () => save(asDataUrl('image/webp', webp.slice(0, webp.length - 10)), 'cut.webp'), /不完整/);
}

rejects('掛在不存在的資料類型上會被擋',
  () => storage.save({ dataUrl: asDataUrl('image/png', makePng(8, 8)),
    ownerType: 'nonsense', ownerId: 1, actor: '測試' }), /不支援的附件歸屬/);

// ================= 存檔之後：檔案壞掉要抓得出來 =================

{
  const a = save(asDataUrl('image/png', makePng(24, 24)), '會被弄壞的.png');
  const p = storage.pathOf(a);

  // 情境一：內容被改（磁碟壞軌、有人手動編輯）
  const orig = fs.readFileSync(p);
  const tampered = Buffer.from(orig);
  tampered[tampered.length - 5] ^= 0xFF;      // 大小不變，只改一個位元組
  fs.writeFileSync(p, tampered);
  let msg = '';
  try { storage.read(a.id); } catch (e) { msg = e.message; }
  ok('內容被改（大小不變）讀得出來是壞的', /損毀/.test(msg), msg || '(沒有擋)');
  const v1 = storage.verifyAll({ limit: 5000 });
  ok('整批檢查也抓得到內容被改',
    v1.bad.some(b => b.id === a.id && /指紋/.test(b.problem)),
    v1.bad.find(b => b.id === a.id)?.problem || '(沒抓到)');

  // 情境二：檔案被截斷（磁碟滿了、複製到一半中斷）
  fs.writeFileSync(p, orig.slice(0, orig.length - 10));
  const v2 = storage.verifyAll({ limit: 5000 });
  ok('檔案被截斷抓得到，而且說得出差多少',
    v2.bad.some(b => b.id === a.id && /大小不符/.test(b.problem)),
    v2.bad.find(b => b.id === a.id)?.problem || '(沒抓到)');

  // 情境三：檔案不見了
  fs.unlinkSync(p);
  msg = '';
  try { storage.read(a.id); } catch (e) { msg = e.message; }
  ok('檔案不見了會說「已遺失」而不是丟出系統錯誤', /遺失/.test(msg), msg || '(沒有擋)');
  const v3 = storage.verifyAll({ limit: 5000 });
  ok('整批檢查抓得到檔案不見',
    v3.bad.some(b => b.id === a.id && /不存在/.test(b.problem)),
    v3.bad.find(b => b.id === a.id)?.problem || '(沒抓到)');

  // 修回去，免得留一筆壞資料給下一個測試
  fs.writeFileSync(p, orig);
  const v4 = storage.verifyAll({ limit: 5000 });
  ok('檔案復原後檢查就恢復正常', !v4.bad.some(b => b.id === a.id));
}

// ================= 失敗不能留下殘骸 =================

{
  const before = fs.readdirSync(storage.UPLOAD_DIR).length;
  for (let i = 0; i < 5; i++) {
    try { save(asDataUrl('image/png', Buffer.from('BROKEN'.repeat(10))), 'bad.png'); } catch { /* 預期失敗 */ }
  }
  const after = fs.readdirSync(storage.UPLOAD_DIR).length;
  ok('存檔失敗不會在磁碟上留下半成品', after === before, `${before} → ${after} 個檔案`);
  // 這裡只驗「這次測試沒有製造新的孤兒」——磁碟上原本就可能有前人留下的
  // （例如重建過示範資料）。那些用備份頁的「清除無主檔案」處理。
  const orphans = storage.orphanFiles();
  ok('這一輪測試沒有製造出新的孤兒檔案', storage.orphanFiles().length === orphansBefore.length,
    `原本 ${orphansBefore.length} 個 → 現在 ${orphans.length} 個`);
}

// ================= 刪除 =================

{
  const a = save(asDataUrl('image/png', makePng(12, 12)), '要刪掉的.png');
  const p = storage.pathOf(a);
  storage.remove(a.id, '上傳測試');
  ok('刪除會把磁碟上的檔案一起刪掉', !fs.existsSync(p));
  ok('刪除後資料列也不見了',
    !db.prepare('SELECT id FROM attachments WHERE id = ?').get(a.id));
  ok('刪掉不存在的檔案回 false 而不是爆掉', storage.remove(999999, '上傳測試') === false);
  created.splice(created.indexOf(a.id), 1);
}

// ---- 收尾：把測試產生的檔案清乾淨 ----
for (const id of created) { try { storage.remove(id, '上傳測試清理'); } catch { /* 已刪 */ } }
const leftover = storage.orphanFiles();
ok('測試結束後沒有留下自己製造的殘骸', leftover.length <= orphansBefore.length,
  `原本 ${orphansBefore.length} 個 → 現在 ${leftover.length} 個`);

// purgeOrphans 本身也要驗：預設只列不刪
{
  const dry = storage.purgeOrphans({ dryRun: true });
  ok('清理孤兒檔案預設只列出不刪除', dry.dry_run === true && dry.deleted === 0,
    `列出 ${dry.files.length} 個`);
  ok('列出的數量與 orphanFiles 一致', dry.files.length === storage.orphanFiles().length);
}

console.log(`\n上傳邊界測試：${pass} 項通過，${fail} 項失敗`);
if (fail) {
  console.log('\n失敗項目：');
  fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✓ 全部通過');
