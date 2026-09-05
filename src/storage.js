// 附件儲存：客人照片、進貨單據、同意書簽名、備份還原上傳。
//
// 這個檔案存在的理由只有一句話：**存檔不能只是「寫下去沒噴錯」就算成功**。
//
// fs.writeFileSync 沒有丟例外，不代表資料真的落到磁碟上：可能只到作業系統的快取，
// 可能磁碟滿了寫進去半截，可能前端傳來的 base64 本身就被截斷。這幾種情況的共同點是
// —— 畫面會顯示「上傳成功」，而問題要等到幾個月後有人來調同意書、調進貨單據時才爆。
// 那時候檔案已經救不回來了。
//
// 所以每一次存檔都跑完整的四步：寫入暫存檔 → fsync 落盤 → 改名到正式位置 → 回讀整個檔案
// 重算 SHA-256 與位元組數，跟寫入前的值比對。任何一步對不上就刪掉半成品、丟出錯誤，
// 讓呼叫端據實回報失敗。指紋存進資料庫，日後還能整批重驗（verifyAll）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, nowStamp, audit } = require('./db');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 允許的型別。副檔名由型別決定，不採信使用者送來的檔名 ——
// 不然有人上傳 evil.html 當作「照片」，之後我們自己把它當靜態檔案送出去就變成 XSS。
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf'
};
const MAX_BYTES = 8 * 1024 * 1024;      // 單檔 8MB（手機直出的照片大約 2~5MB）

const OWNER_TYPES = ['member', 'consent', 'stock', 'ticket', 'issue', 'therapist'];

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// 'data:image/png;base64,iVBOR...' → { mime, buffer }
function parseDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec(String(dataUrl || '').trim());
  if (!m) throw new Error('檔案格式不正確（必須是 base64 資料）');
  const mime = m[1].toLowerCase();
  if (!MIME_EXT[mime]) {
    throw new Error(`不支援的檔案型別：${mime}（可上傳 JPG／PNG／WebP／GIF／PDF）`);
  }
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) throw new Error('檔案是空的，請重新選擇');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`檔案 ${(buffer.length / 1048576).toFixed(1)}MB 超過上限 8MB，請壓縮後再上傳`);
  }
  // base64 還原後的長度必須跟編碼長度對得起來，對不上代表傳輸過程被截斷了。
  // 這一關擋的是「網路斷在一半、前端卻照樣送出」——那種檔案打得開才怪。
  const expect = Math.floor(m[2].replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+$/, '').length * 3 / 4);
  if (Math.abs(expect - buffer.length) > 3) {
    throw new Error('檔案在傳輸過程中被截斷，請重新上傳');
  }
  return { mime, buffer };
}

// 檔頭檢查：宣稱是 PNG 就要真的是 PNG。
// 副檔名與 MIME 都是客戶端說了算，只有前幾個位元組是檔案自己說的。
const MAGIC = {
  'image/jpeg': b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  'image/png': b => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])),
  'image/gif': b => b.slice(0, 3).toString('latin1') === 'GIF',
  'image/webp': b => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': b => b.slice(0, 5).toString('latin1') === '%PDF-'
};

// 檔尾檢查：檔案**完整地**結束了嗎？
//
// 只驗檔頭會漏掉最常見的一種壞檔 —— 傳到一半斷線。前幾個位元組完好無缺，
// 所以檔頭檢查照樣通過，存進去卻是一張只有上半截的照片。
// 這種檔案的可怕之處在於它「看起來成功了」：縮圖甚至可能顯示得出上半部，
// 要等到有人把它放大、或列印同意書時才發現下半截是灰的。
//
// 這幾種格式都有明確的結束標記，驗它就能把截斷的檔案擋在門外：
const TRAILER = {
  // PNG 以 IEND 區塊結尾（最後 8 位元組固定是 IEND + CRC）
  'image/png': b => b.length > 12 && b.slice(-8, -4).toString('latin1') === 'IEND',
  // JPEG 以 FFD9（EOI）結尾。有些相機會在後面補幾個位元組，所以往回找一小段。
  'image/jpeg': b => b.slice(-32).includes(Buffer.from([0xFF, 0xD9])),
  // GIF 以 0x3B（trailer）結尾
  'image/gif': b => b[b.length - 1] === 0x3B,
  // WebP 的 RIFF 標頭第 4~8 位元組寫著「後面還有多少」，對不上就是被截斷了
  'image/webp': b => b.length >= 12 && b.readUInt32LE(4) === b.length - 8,
  // PDF 以 %%EOF 結尾，後面可能有換行
  'application/pdf': b => b.slice(-1024).toString('latin1').includes('%%EOF')
};

function checkMagic(mime, buf) {
  const head = MAGIC[mime];
  if (head && !head(buf)) throw new Error(`檔案內容不像 ${mime}，可能已損壞或副檔名被改過`);
  const tail = TRAILER[mime];
  if (tail && !tail(buf)) {
    throw new Error('檔案不完整（可能在上傳過程中斷線），請重新上傳');
  }
}

// 寫入 → fsync → 回讀比對。回傳實際落盤的檔名。
// 中途失敗一律清掉半成品：留著壞檔比沒有檔更糟，因為它看起來像是好的。
function writeVerified(buffer, ext) {
  const stored = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const dest = path.join(UPLOAD_DIR, stored);
  const tmp = dest + '.part';
  const want = sha256(buffer);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o640);
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
    fs.fsyncSync(fd);              // 這一行是重點：沒有它，斷電後檔案可能是空的
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, dest);
    // 目錄本身也要 fsync，否則改名這件事同樣可能還在快取裡
    try {
      const dirFd = fs.openSync(UPLOAD_DIR, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch { /* 有些檔案系統不支援對目錄 fsync，不是致命問題 */ }

    // 回讀驗證：真的從磁碟讀回來，重算一次指紋
    const back = fs.readFileSync(dest);
    if (back.length !== buffer.length) {
      throw new Error(`存檔驗證失敗：寫入 ${buffer.length} 位元組，讀回 ${back.length} 位元組`);
    }
    if (sha256(back) !== want) {
      throw new Error('存檔驗證失敗：檔案內容與上傳的不一致，請重新上傳');
    }
    return { stored_name: stored, sha256: want, bytes: buffer.length };
  } catch (e) {
    if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已關閉 */ } }
    for (const f of [tmp, dest]) { try { fs.unlinkSync(f); } catch { /* 不存在即略過 */ } }
    throw e;
  }
}

// 存一個 data URL 附件。驗證不過就丟例外，呼叫端不必自己判斷「是不是真的成功了」。
function save({ dataUrl, filename, ownerType, ownerId, kind = 'photo', note = '', actor = '' }) {
  if (!OWNER_TYPES.includes(ownerType)) throw new Error(`不支援的附件歸屬：${ownerType}`);
  const { mime, buffer } = parseDataUrl(dataUrl);
  checkMagic(mime, buffer);
  const w = writeVerified(buffer, MIME_EXT[mime]);
  const info = db.prepare(`INSERT INTO attachments(owner_type,owner_id,kind,filename,stored_name,mime,bytes,
      sha256,verified_at,note,actor) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ownerType, ownerId || null, kind, String(filename || '').slice(0, 120),
      w.stored_name, mime, w.bytes, w.sha256, nowStamp(), String(note || ''), String(actor || ''));
  return get(info.lastInsertRowid);
}

function get(id) {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  return a ? { ...a, url: `/api/files/${a.id}` } : null;
}

function listFor(ownerType, ownerId) {
  return db.prepare('SELECT * FROM attachments WHERE owner_type = ? AND owner_id = ? ORDER BY id DESC')
    .all(ownerType, ownerId).map(a => ({ ...a, url: `/api/files/${a.id}` }));
}

function pathOf(a) { return path.join(UPLOAD_DIR, a.stored_name); }

// 讀出檔案並當場驗指紋。指紋不符就當作壞檔，不要把爛資料送給使用者。
function read(id) {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  if (!a) return null;
  const p = pathOf(a);
  if (!fs.existsSync(p)) throw new Error('檔案已遺失，請重新上傳');
  const buf = fs.readFileSync(p);
  if (a.sha256 && sha256(buf) !== a.sha256) {
    throw new Error('檔案已損毀（指紋與上傳當下不符），請重新上傳');
  }
  db.prepare('UPDATE attachments SET verified_at = ? WHERE id = ?').run(nowStamp(), a.id);
  return { meta: a, buffer: buf };
}

function remove(id, actor) {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  if (!a) return false;
  try { fs.unlinkSync(pathOf(a)); } catch { /* 檔案已不在，資料列照樣刪掉 */ }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  audit('staff', null, actor || '', `刪除附件：${a.filename || a.stored_name}`);
  return true;
}

// 整批重驗：檔案還在嗎？大小對嗎？指紋對嗎？
// 每日維護會跑一次，壞掉的檔案要在還救得回來的時候就被發現，而不是等到要用的那天。
function verifyAll({ limit = 5000 } = {}) {
  const rows = db.prepare('SELECT * FROM attachments ORDER BY id DESC LIMIT ?').all(limit);
  const bad = [];
  for (const a of rows) {
    const p = pathOf(a);
    if (!fs.existsSync(p)) { bad.push({ id: a.id, filename: a.filename, problem: '檔案不存在' }); continue; }
    const st = fs.statSync(p);
    if (st.size !== a.bytes) {
      bad.push({ id: a.id, filename: a.filename, problem: `大小不符（應 ${a.bytes}，實 ${st.size}）` });
      continue;
    }
    if (a.sha256 && sha256(fs.readFileSync(p)) !== a.sha256) {
      bad.push({ id: a.id, filename: a.filename, problem: '內容指紋不符' });
      continue;
    }
    db.prepare('UPDATE attachments SET verified_at = ? WHERE id = ?').run(nowStamp(), a.id);
  }
  return { checked: rows.length, bad, ok: bad.length === 0 };
}

// 沒有任何資料列指向、卻還躺在 uploads/ 裡的檔案。
//
// 來源有兩種：存檔中途失敗留下的殘骸（正常情況下 writeVerified 會自己清掉），
// 以及「資料列被刪了、檔案沒刪」—— 例如重跑 `npm run seed` 會清空 attachments 資料表。
// 這些檔案不影響功能，但它們是客人的照片與同意書簽名，**留著就是留著個資**，
// 而且會讓「備份與檔案」頁的數字愈來愈難看。
function orphanFiles() {
  const known = new Set(db.prepare('SELECT stored_name FROM attachments').all().map(r => r.stored_name));
  return fs.readdirSync(UPLOAD_DIR).filter(f => !known.has(f) && !f.endsWith('.part'));
}

// 清掉孤兒檔案。預設只是列出來（dryRun），真的要刪要明講 ——
// 這些是客人的照片，誤刪沒有第二次機會。
function purgeOrphans({ dryRun = true, actor = '' } = {}) {
  const files = orphanFiles();
  if (dryRun) return { files, deleted: 0, dry_run: true };
  let deleted = 0;
  for (const f of files) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); deleted++; } catch { /* 已不在 */ }
  }
  if (deleted) audit('staff', null, actor || '', `清除無主附件檔案 ${deleted} 個`);
  return { files, deleted, dry_run: false };
}

module.exports = {
  UPLOAD_DIR, MIME_EXT, MAX_BYTES, OWNER_TYPES,
  save, get, listFor, read, remove, verifyAll, orphanFiles, purgeOrphans, pathOf, sha256, parseDataUrl
};
