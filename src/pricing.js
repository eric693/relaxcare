// 三層定價：牌價 → 現場價 → 會員價。
//
// 森 SPA 與不老松都是這樣標價的：牌價 2400、現場特價 1980、會員再低一點。
// 只存一個 price 的話，「這張單打了幾折」就永遠算不出來 ——
// 而那正是老闆最想知道的數字（實收 ÷ 牌價）。
//
// 適用順序：
//   1. 團購券：券面價值就是這一段的價格，不再套其他層
//   2. 會員價：客人是會員、店家開啟自動帶會員價、且該項目有設會員價
//   3. 現場價：一般散客
// 牌價永遠只當分母用，不會真的向客人收（除非店家把現場價設成等於牌價）。
const { db, getSetting, yuan } = require('./db');

const TIERS = { list: '牌價', walkin: '現場價', member: '會員價', package: '套票價', voucher: '團購券' };

function autoMemberPrice() { return getSetting('auto_member_price', '1') === '1'; }

// 回傳這位客人買這個項目應該收多少
function priceOf(service, { memberId, tier } = {}) {
  if (!service) return { price: 0, list: 0, tier: 'walkin', discount: 0 };
  const list = yuan(service.list_price) || yuan(service.price);
  const walkin = yuan(service.price);
  const member = yuan(service.member_price) || walkin;

  let use = tier;
  if (!use) use = (memberId && autoMemberPrice() && member < walkin) ? 'member' : 'walkin';
  const price = use === 'list' ? list : use === 'member' ? member : walkin;
  return {
    price, list, walkin, member,
    tier: use, tier_label: TIERS[use] || use,
    discount: Math.max(0, list - price),
    discount_pct: list ? (list - price) / list : 0
  };
}

// 加購品同樣有三層
function addonPriceOf(addon, { memberId, tier } = {}) {
  if (!addon) return { price: 0, list: 0, tier: 'walkin' };
  const list = yuan(addon.list_price) || yuan(addon.price);
  const walkin = yuan(addon.price);
  const member = yuan(addon.member_price) || walkin;
  let use = tier;
  if (!use) use = (memberId && autoMemberPrice() && member < walkin) ? 'member' : 'walkin';
  const price = use === 'list' ? list : use === 'member' ? member : walkin;
  return { price, list, walkin, member, tier: use, tier_label: TIERS[use] || use, discount: Math.max(0, list - price) };
}

// 組合套票：把子項目展開。
// 「完美按摩套票 180 分鐘 3480」實際上是腳底 60 分 + 全身 120 分之類的組合，
// 套票價低於各項相加，差額就是套票折扣。
function packageItems(service) {
  if (!service || !service.is_package) return [];
  const ids = String(service.package_items || '').split(',').map(x => Number(x.trim())).filter(Boolean);
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT * FROM services WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  // 照設定的順序回傳，不是資料庫的順序 —— 套票的施作順序是有意義的（先泡腳再按摩）
  return ids.map(id => rows.find(r => r.id === id)).filter(Boolean);
}

function packageBreakdown(service, opts = {}) {
  const items = packageItems(service);
  if (!items.length) return null;
  const parts = items.map(s => ({ ...priceOf(s, opts), id: s.id, name: s.name, minutes: s.minutes }));
  const sumWalkin = parts.reduce((a, p) => a + p.price, 0);
  const sumList = parts.reduce((a, p) => a + p.list, 0);
  const pkg = priceOf(service, { ...opts, tier: opts.tier || 'walkin' });
  return {
    items: parts,
    minutes: items.reduce((a, s) => a + (s.minutes || 0), 0),
    package_price: pkg.price, list_total: sumList, separate_total: sumWalkin,
    saving: Math.max(0, sumWalkin - pkg.price)
  };
}

module.exports = { TIERS, priceOf, addonPriceOf, packageItems, packageBreakdown, autoMemberPrice };
