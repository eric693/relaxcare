// 預收引擎：儲值金與次卡。
//
// 這兩樣東西在會計上都是**負債**，不是收入 —— 客人把錢先給你，你欠他服務。
// 系統要守住三件事，少一件就會出現算不清的帳：
//   1. 現金部位與贈送部位分開。退款只退未使用的現金；贈送金一律作廢。
//      混在一起算，遇到「儲值 2 萬送 3 千、用掉 5 千後要退款」就會退錯錢。
//   2. 每一次增減都寫一筆流水（wallet_txns / pass_txns）並記下當下餘額。
//      餘額欄位是「快取」，流水才是真相；對不上時以流水為準重算。
//   3. 扣款一律先扣贈送金。贈送金會過期，先用掉對客人有利，也讓帳面負債下降得快一點。
const { db, num, getSetting, today, nowStamp, addMonths, nextSerial, money, yuan, audit } = require('./db');
const { prepaidCommission } = require('./commission');

// ---------- 儲值金 ----------

function wallet(memberId) {
  let w = db.prepare('SELECT * FROM wallets WHERE member_id = ?').get(memberId);
  if (!w) {
    db.prepare('INSERT INTO wallets(member_id) VALUES(?)').run(memberId);
    w = db.prepare('SELECT * FROM wallets WHERE member_id = ?').get(memberId);
  }
  return w;
}

function walletBalance(memberId) {
  const w = wallet(memberId);
  return { cash: yuan(w.cash_balance), bonus: yuan(w.bonus_balance), total: yuan(w.cash_balance + w.bonus_balance),
    expiry_date: w.expiry_date };
}

function writeWallet(memberId, cash, bonus, expiry) {
  db.prepare(`UPDATE wallets SET cash_balance = ?, bonus_balance = ?,
              expiry_date = COALESCE(?, expiry_date), updated_at = ? WHERE member_id = ?`)
    .run(money(cash), money(bonus), expiry === undefined ? null : expiry, nowStamp(), memberId);
}

function wtxn(row) {
  db.prepare(`INSERT INTO wallet_txns(member_id,store_id,kind,cash_delta,bonus_delta,amount,
              cash_after,bonus_after,ticket_id,peer_member_id,pay_method,therapist_id,comm_amount,note,actor)
              VALUES(@member_id,@store_id,@kind,@cash_delta,@bonus_delta,@amount,
              @cash_after,@bonus_after,@ticket_id,@peer_member_id,@pay_method,@therapist_id,@comm_amount,@note,@actor)`)
    .run({ store_id: null, cash_delta: 0, bonus_delta: 0, amount: 0, ticket_id: null, peer_member_id: null,
      pay_method: '', therapist_id: null, comm_amount: 0, note: '', actor: '', ...row });
}

// 儲值。amount 是客人實際付的錢，bonus 是店裡送的。
const topup = db.transaction(({ memberId, amount, bonus = 0, payMethod, therapistId, storeId, note, actor }) => {
  const amt = yuan(amount), bn = yuan(bonus);
  if (amt <= 0) throw new Error('儲值金額要大於 0');
  const w = wallet(memberId);
  const months = num('wallet_bonus_expire_months', 12);
  // 贈送金效期以「最後一次儲值」重新起算：新儲值把舊的贈送金一起延長，
  // 是業界普遍做法，也比較不會有客訴。
  const expiry = bn > 0 && months > 0 ? addMonths(today(), months) : w.expiry_date;
  const cashAfter = money(w.cash_balance + amt), bonusAfter = money(w.bonus_balance + bn);
  writeWallet(memberId, cashAfter, bonusAfter, expiry);
  const comm = prepaidCommission(amt, therapistId);
  wtxn({ member_id: memberId, store_id: storeId || null, kind: 'topup',
    cash_delta: amt, bonus_delta: bn, amount: amt, cash_after: cashAfter, bonus_after: bonusAfter,
    pay_method: payMethod || '', therapist_id: therapistId || null, comm_amount: comm.amount,
    note: note || (bn ? `儲值 ${amt} 送 ${bn}` : `儲值 ${amt}`), actor: actor || '' });
  return walletBalance(memberId);
});

// 消費扣款。先扣贈送金，再扣現金。回傳實際扣了多少（不夠就扣到 0，由呼叫端決定要不要擋）。
const consume = db.transaction(({ memberId, amount, ticketId, storeId, note, actor, allowPartial = false }) => {
  const need = yuan(amount);
  if (need <= 0) return { cash: 0, bonus: 0, total: 0 };
  const w = wallet(memberId);
  const avail = yuan(w.cash_balance + w.bonus_balance);
  if (need > avail && !allowPartial) throw new Error(`儲值餘額不足：可用 ${avail} 元，需要 ${need} 元`);
  const use = Math.min(need, avail);
  const useBonus = Math.min(yuan(w.bonus_balance), use);
  const useCash = use - useBonus;
  const cashAfter = money(w.cash_balance - useCash), bonusAfter = money(w.bonus_balance - useBonus);
  writeWallet(memberId, cashAfter, bonusAfter);
  wtxn({ member_id: memberId, store_id: storeId || null, kind: 'consume',
    cash_delta: -useCash, bonus_delta: -useBonus, amount: use, cash_after: cashAfter, bonus_after: bonusAfter,
    ticket_id: ticketId || null, note: note || '消費扣款', actor: actor || '' });
  return { cash: useCash, bonus: useBonus, total: use };
});

// 回沖（鐘單取消／改單）：把扣掉的還回去。還的時候依原比例還，贈送還贈送、現金還現金。
const refundConsume = db.transaction(({ memberId, ticketId, note, actor }) => {
  const rows = db.prepare(`SELECT * FROM wallet_txns WHERE member_id = ? AND ticket_id = ? AND kind = 'consume'`)
    .all(memberId, ticketId);
  let cash = 0, bonus = 0;
  for (const r of rows) { cash += -r.cash_delta; bonus += -r.bonus_delta; }
  if (cash + bonus <= 0) return { cash: 0, bonus: 0, total: 0 };
  const w = wallet(memberId);
  const cashAfter = money(w.cash_balance + cash), bonusAfter = money(w.bonus_balance + bonus);
  writeWallet(memberId, cashAfter, bonusAfter);
  wtxn({ member_id: memberId, kind: 'adjust', cash_delta: cash, bonus_delta: bonus, amount: cash + bonus,
    cash_after: cashAfter, bonus_after: bonusAfter, ticket_id: ticketId,
    note: note || '鐘單取消，儲值扣款回沖', actor: actor || '' });
  return { cash, bonus, total: cash + bonus };
});

// 只發贈送金，不動現金部位。點數兌換與補償（客訴、久候致歉）走這裡。
//
// 走 topup 是錯的：topup 的 amount 會被損益的現金流入認列，等於帳上憑空多出一筆收入，
// 而點數兌換根本沒有人付錢進來。贈送金本來就不列為預收負債，這樣三張表都還是對的。
const grantBonus = db.transaction(({ memberId, bonus, months, note, actor }) => {
  const bn = yuan(bonus);
  if (bn <= 0) throw new Error('贈送金額要大於 0');
  const w = wallet(memberId);
  const m = months === undefined ? num('wallet_bonus_expire_months', 12) : Number(months);
  const expiry = m > 0 ? addMonths(today(), m) : w.expiry_date;
  const bonusAfter = money(w.bonus_balance + bn);
  writeWallet(memberId, w.cash_balance, bonusAfter, expiry);
  wtxn({ member_id: memberId, kind: 'adjust', cash_delta: 0, bonus_delta: bn, amount: 0,
    cash_after: money(w.cash_balance), bonus_after: bonusAfter,
    note: note || `贈送金 ${bn} 元`, actor: actor || '' });
  return walletBalance(memberId);
});

// 退款。只退未使用的現金部位，贈送金作廢。手續費依設定％。
const refund = db.transaction(({ memberId, amount, storeId, note, actor }) => {
  const w = wallet(memberId);
  const cash = yuan(w.cash_balance);
  const want = amount === undefined || amount === '' ? cash : yuan(amount);
  if (want <= 0) throw new Error('沒有可退的現金餘額');
  if (want > cash) throw new Error(`可退現金只有 ${cash} 元（贈送金 ${yuan(w.bonus_balance)} 元不予退還）`);
  const feePct = num('wallet_refund_fee_pct', 0);
  const fee = yuan(want * feePct / 100);
  const payout = want - fee;
  // 全額退款時贈送金一併歸零；部分退款則保留剩下的
  const dropBonus = want >= cash ? yuan(w.bonus_balance) : 0;
  const cashAfter = money(w.cash_balance - want), bonusAfter = money(w.bonus_balance - dropBonus);
  writeWallet(memberId, cashAfter, bonusAfter);
  wtxn({ member_id: memberId, store_id: storeId || null, kind: 'refund',
    cash_delta: -want, bonus_delta: -dropBonus, amount: payout, cash_after: cashAfter, bonus_after: bonusAfter,
    note: `${note || '儲值退款'}｜退還 ${payout} 元${fee ? `（手續費 ${fee}）` : ''}${dropBonus ? `，贈送金 ${dropBonus} 元作廢` : ''}`,
    actor: actor || '' });
  return { refunded: payout, fee, bonus_void: dropBonus, balance: walletBalance(memberId) };
});

// 轉讓：現金部位可以轉，贈送金不能轉（否則會變成套利：儲值送金再轉出去）
const transfer = db.transaction(({ fromId, toId, amount, note, actor }) => {
  if (Number(fromId) === Number(toId)) throw new Error('不能轉給自己');
  const amt = yuan(amount);
  if (amt <= 0) throw new Error('轉讓金額要大於 0');
  const a = wallet(fromId), b = wallet(toId);
  if (yuan(a.cash_balance) < amt) throw new Error(`可轉讓的現金餘額只有 ${yuan(a.cash_balance)} 元（贈送金不可轉讓）`);
  const aCash = money(a.cash_balance - amt), bCash = money(b.cash_balance + amt);
  writeWallet(fromId, aCash, a.bonus_balance);
  writeWallet(toId, bCash, b.bonus_balance);
  const nameOf = id => (db.prepare('SELECT name FROM members WHERE id = ?').get(id) || {}).name || `#${id}`;
  wtxn({ member_id: fromId, kind: 'transfer_out', cash_delta: -amt, amount: amt,
    cash_after: aCash, bonus_after: a.bonus_balance, peer_member_id: toId,
    note: `${note || ''}轉讓給 ${nameOf(toId)}`, actor: actor || '' });
  wtxn({ member_id: toId, kind: 'transfer_in', cash_delta: amt, amount: amt,
    cash_after: bCash, bonus_after: b.bonus_balance, peer_member_id: fromId,
    note: `${note || ''}由 ${nameOf(fromId)} 轉入`, actor: actor || '' });
  return { from: walletBalance(fromId), to: walletBalance(toId) };
});

// 贈送金到期作廢。每日維護會呼叫一次。
const expireBonus = db.transaction(() => {
  const t = today();
  const rows = db.prepare(`SELECT * FROM wallets WHERE bonus_balance > 0 AND expiry_date <> '' AND expiry_date < ?`).all(t);
  for (const w of rows) {
    const drop = yuan(w.bonus_balance);
    writeWallet(w.member_id, w.cash_balance, 0);
    wtxn({ member_id: w.member_id, kind: 'expire', bonus_delta: -drop, amount: drop,
      cash_after: w.cash_balance, bonus_after: 0,
      note: `贈送金 ${drop} 元於 ${w.expiry_date} 到期作廢`, actor: '系統' });
  }
  return rows.length;
});

// ---------- 次卡／套券 ----------

function passOf(id) { return db.prepare('SELECT * FROM passes WHERE id = ?').get(id); }

function passUnitValue(p) {
  // 單次價值：以實付金額攤平（不是原價）。用原價攤會讓「買 10 送 2」的卡在用完前
  // 就把負債沖光。這個數字只用來顯示與估算，實際核銷金額請用 passUsedValue。
  const times = Number(p.total_times) || 1;
  return money(yuan(p.price_paid) / times);
}

// 用掉 n 次時，累計應該認列多少。
//
// 為什麼不是「單次價值 × 次數」：14390 元買 12 次，一次是 1199.1666…，
// 四捨五入成 1199.17 再乘回 12 次會變成 14390.04 —— 比客人付的錢還多 4 分。
// 反過來取 1199 則會少 2 元。這種零頭會卡在預收負債裡永遠沖不掉。
// 改成算「累計值的差」：每一次核銷的金額是 round(實付×已用/總次數) 的增量，
// 全部用完時加總剛好等於實付，一分不差。
function passUsedValue(p, times) {
  const total = Number(p.total_times) || 1;
  return yuan(yuan(p.price_paid) * Math.min(times, total) / total);
}
// 這一次核銷（從 before 用到 after）該認列多少
function passStepValue(p, before, after) {
  return passUsedValue(p, after) - passUsedValue(p, before);
}
// 還沒用掉的價值 —— 這就是這張卡在預收負債表上的金額
function passRemainValue(p) {
  return yuan(p.price_paid) - passUsedValue(p, p.used_times);
}

function passStatus(p) {
  if (p.status !== 'active') return p.status;
  if (p.used_times >= p.total_times) return 'used_up';
  if (p.expiry_date && p.expiry_date < today()) return 'expired';
  return 'active';
}

function ptxn(row) {
  db.prepare(`INSERT INTO pass_txns(pass_id,member_id,kind,times,amount,used_after,ticket_id,peer_member_id,note,actor)
              VALUES(@pass_id,@member_id,@kind,@times,@amount,@used_after,@ticket_id,@peer_member_id,@note,@actor)`)
    .run({ member_id: null, times: 0, amount: 0, used_after: 0, ticket_id: null, peer_member_id: null,
      note: '', actor: '', ...row });
}

const buyPass = db.transaction(({ memberId, serviceId, name, totalTimes, pricePaid, listValue,
                                  expiryDate, soldBy, storeId, transferable = 1, payMethod, note, actor }) => {
  const times = Number(totalTimes) || 0;
  if (times <= 0) throw new Error('次數要大於 0');
  const svc = serviceId ? db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId) : null;
  const months = num('pass_default_months', 12);
  const exp = expiryDate || (months > 0 ? addMonths(today(), months) : '');
  // 原價總值：沒給就用綁定服務的牌價 × 次數；都沒有就等於實付（＝沒打折的卡）。
  let lv = yuan(listValue) || (svc ? yuan(svc.price) * times : 0);
  if (!lv) lv = yuan(pricePaid);
  // 實付不能高於原價總值。次卡本來就是「先付錢換折扣」，賣得比原價還貴幾乎一定是打錯
  // （多打一個 0、或選錯服務項目）。而且它會讓退卡的兩種算法反轉 ——
  // 「已使用次數按原價扣回」會退得比「按實付單價退未使用次數」還多，等於送錢出去。
  if (yuan(pricePaid) > lv) {
    throw new Error(`實付 ${yuan(pricePaid)} 元高於原價總值 ${lv} 元。`
      + `次卡是先付錢換折扣，請確認金額或改填正確的原價總值`);
  }
  const no = nextSerial('PC');
  const info = db.prepare(`INSERT INTO passes(pass_no,member_id,store_id,service_id,name,total_times,
                            price_paid,list_value,buy_date,expiry_date,transferable,sold_by,pay_method,note)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(no, memberId, storeId || null, serviceId || null,
      name || (svc ? `${svc.name} ${times} 次卡` : `${times} 次卡`),
      times, yuan(pricePaid), lv, today(), exp, transferable ? 1 : 0, soldBy || null,
      payMethod || '現金', note || '');
  ptxn({ pass_id: info.lastInsertRowid, member_id: memberId, kind: 'buy', times,
    amount: yuan(pricePaid), used_after: 0, note: `購買 ${no}`, actor: actor || '' });
  return passOf(info.lastInsertRowid);
});

// 核銷一次。回傳這次核銷的價值（用來沖銷負債、認列營收）。
const usePass = db.transaction(({ passId, ticketId, times = 1, note, actor }) => {
  const p = passOf(passId);
  if (!p) throw new Error('找不到這張卡');
  const st = passStatus(p);
  if (st === 'expired') throw new Error(`這張卡已於 ${p.expiry_date} 到期，請先展延`);
  if (st !== 'active') throw new Error(`這張卡目前狀態為「${st}」，不能核銷`);
  const n = Number(times) || 1;
  if (p.used_times + n > p.total_times) {
    throw new Error(`剩餘次數不足：尚餘 ${p.total_times - p.used_times} 次，要核銷 ${n} 次`);
  }
  const used = p.used_times + n;
  const value = passStepValue(p, p.used_times, used);
  db.prepare(`UPDATE passes SET used_times = ?, status = ? WHERE id = ?`)
    .run(used, used >= p.total_times ? 'used_up' : 'active', passId);
  ptxn({ pass_id: passId, member_id: p.member_id, kind: 'use', times: -n, amount: value,
    used_after: used, ticket_id: ticketId || null, note: note || '核銷', actor: actor || '' });
  return { value, used, remain: p.total_times - used, unit_value: passUnitValue(p) };
});

// 回沖核銷（鐘單取消）
const voidPassUse = db.transaction(({ ticketId, actor }) => {
  const rows = db.prepare(`SELECT * FROM pass_txns WHERE ticket_id = ? AND kind = 'use'`).all(ticketId);
  let total = 0;
  for (const r of rows) {
    const p = passOf(r.pass_id);
    if (!p) continue;
    const back = Math.min(p.used_times, -r.times);
    const used = p.used_times - back;
    db.prepare(`UPDATE passes SET used_times = ?, status = CASE WHEN status='used_up' THEN 'active' ELSE status END
                WHERE id = ?`).run(used, p.id);
    ptxn({ pass_id: p.id, member_id: p.member_id, kind: 'void', times: back, amount: -r.amount,
      used_after: used, ticket_id: ticketId, note: '鐘單取消，核銷回沖', actor: actor || '' });
    total += r.amount;
  }
  return total;
});

// 退卡：退還「未使用次數 × 單次實付價值」，扣手續費。
// 已使用的次數不退 —— 但要注意：多數店家的規矩是已使用部分改按「原價」計算，
// 因為買卡的折扣是建立在買整套的前提上。這裡兩種算法都給，由使用者選。
function refundQuote(passId, mode = 'unit') {
  const p = passOf(passId);
  if (!p) throw new Error('找不到這張卡');
  const remain = p.total_times - p.used_times;
  const unit = passUnitValue(p);
  const listUnit = p.total_times ? money(yuan(p.list_value) / p.total_times) : 0;
  // 用「實付 − 已使用的累計值」而不是「單價 × 剩餘次數」，理由同 passUsedValue：
  // 除不盡的卡（14390 買 12 次）用乘法會退得比客人付的還多。
  const byUnit = passRemainValue(p);                                     // 按實付單價退未使用次數
  const byList = yuan(Math.max(0, yuan(p.price_paid) - listUnit * p.used_times)); // 已用部分按原價扣回
  const feePct = num('wallet_refund_fee_pct', 0);
  const base = mode === 'list' ? byList : byUnit;
  const fee = yuan(base * feePct / 100);
  return {
    pass: p, remain, unit_value: unit, list_unit: listUnit,
    by_unit: byUnit, by_list: byList, mode, base, fee, payout: Math.max(0, base - fee), fee_pct: feePct
  };
}

const refundPass = db.transaction(({ passId, mode = 'unit', note, actor }) => {
  const q = refundQuote(passId, mode);
  const p = q.pass;
  if (p.status === 'refunded') throw new Error('這張卡已經退過了');
  db.prepare(`UPDATE passes SET status = 'refunded' WHERE id = ?`).run(passId);
  ptxn({ pass_id: passId, member_id: p.member_id, kind: 'refund', times: -q.remain, amount: q.payout,
    used_after: p.used_times,
    note: `${note || '退卡'}｜${mode === 'list' ? '已使用次數按原價扣回' : '按實付單價退未使用次數'}，退還 ${q.payout} 元${q.fee ? `（手續費 ${q.fee}）` : ''}`,
    actor: actor || '' });
  return q;
});

const transferPass = db.transaction(({ passId, toMemberId, note, actor }) => {
  const p = passOf(passId);
  if (!p) throw new Error('找不到這張卡');
  if (!p.transferable) throw new Error('這張卡設定為不可轉讓');
  if (passStatus(p) !== 'active') throw new Error('只有使用中的卡可以轉讓');
  if (Number(p.member_id) === Number(toMemberId)) throw new Error('不能轉給原持卡人');
  const nameOf = id => (db.prepare('SELECT name FROM members WHERE id = ?').get(id) || {}).name || `#${id}`;
  const from = p.member_id;
  db.prepare('UPDATE passes SET member_id = ? WHERE id = ?').run(toMemberId, passId);
  ptxn({ pass_id: passId, member_id: from, kind: 'transfer', peer_member_id: toMemberId,
    used_after: p.used_times, note: `${note || ''}由 ${nameOf(from)} 轉讓給 ${nameOf(toMemberId)}`, actor: actor || '' });
  return passOf(passId);
});

const extendPass = db.transaction(({ passId, newExpiry, months, note, actor }) => {
  const p = passOf(passId);
  if (!p) throw new Error('找不到這張卡');
  const base = p.expiry_date && p.expiry_date > today() ? p.expiry_date : today();
  const exp = newExpiry || (months ? addMonths(base, Number(months)) : '');
  if (!exp) throw new Error('請指定新的到期日或展延月數');
  db.prepare(`UPDATE passes SET expiry_date = ?, status = CASE WHEN status='expired' THEN 'active' ELSE status END
              WHERE id = ?`).run(exp, passId);
  ptxn({ pass_id: passId, member_id: p.member_id, kind: 'extend', used_after: p.used_times,
    note: `${note || '展延'}：${p.expiry_date || '無'} → ${exp}`, actor: actor || '' });
  return passOf(passId);
});

// 客人手上「可用的卡」。開單畫面要用這個挑要核銷哪一張。
function activePasses(memberId, serviceId) {
  const rows = db.prepare(`SELECT p.*, s.name AS service_name FROM passes p
    LEFT JOIN services s ON s.id = p.service_id
    WHERE p.member_id = ? AND p.status = 'active' ORDER BY p.expiry_date, p.id`).all(memberId);
  return rows
    .map(p => ({ ...p, remain: p.total_times - p.used_times, unit_value: passUnitValue(p), real_status: passStatus(p) }))
    .filter(p => p.real_status === 'active' && p.remain > 0)
    // 綁定服務的卡只能用在那個服務上；沒綁定的通用
    .filter(p => !serviceId || !p.service_id || Number(p.service_id) === Number(serviceId));
}

// 預收負債總表：還沒被使用的錢有多少。這是資產負債表上的數字。
function liability(storeId) {
  const w = db.prepare(`SELECT COALESCE(SUM(w.cash_balance),0) AS cash, COALESCE(SUM(w.bonus_balance),0) AS bonus,
                          COUNT(*) AS members
                        FROM wallets w JOIN members m ON m.id = w.member_id
                        WHERE (w.cash_balance > 0 OR w.bonus_balance > 0)
                          AND (? IS NULL OR m.store_id = ?)`).get(storeId || null, storeId || null);
  const passes = db.prepare(`SELECT * FROM passes WHERE status = 'active'
                             AND (? IS NULL OR store_id = ?)`).all(storeId || null, storeId || null);
  let passValue = 0, passRemainTimes = 0;
  for (const p of passes) {
    if (passStatus(p) !== 'active') continue;
    passRemainTimes += p.total_times - p.used_times;
    passValue += passRemainValue(p);
  }
  return {
    wallet_cash: yuan(w.cash), wallet_bonus: yuan(w.bonus), wallet_members: w.members,
    pass_count: passes.length, pass_remain_times: passRemainTimes, pass_value: yuan(passValue),
    // 贈送金不是真的收到的錢，習慣上不列為負債；這裡分開列，要不要含進去由會計決定
    total_cash_liability: yuan(w.cash + passValue),
    total_with_bonus: yuan(w.cash + w.bonus + passValue)
  };
}

module.exports = {
  wallet, walletBalance, topup, consume, refundConsume, refund, transfer, expireBonus, grantBonus,
  passOf, passUnitValue, passUsedValue, passStepValue, passRemainValue, passStatus, buyPass, usePass, voidPassUse, refundQuote, refundPass,
  transferPass, extendPass, activePasses, liability
};
