// 主檔用的通用 CRUD 產生器。
// 車輛、司機、供應商、客戶、行程商品這幾張表的存取形狀一模一樣，
// 各寫一遍只會讓「哪一張表忘了做欄位過濾」變成遲早發生的事。
const { db, audit } = require('./db');
const { requireStaff } = require('./auth');

// spec: { table, module, label, fields, nums, ids, search, order, beforeDelete }
//   fields  可寫入的欄位白名單（沒列到的一律忽略，前端多送什麼都進不來）
//   nums    以數字存的欄位
//   ids     外鍵欄位，空字串要存 NULL 而不是 0
//   search  q 參數要比對的欄位
function attach(router, spec) {
  const { table, module: mod, label, fields, nums = [], ids = [], search = [], order = 'id DESC' } = spec;

  const pick = b => {
    const o = {};
    for (const f of fields) {
      if (b[f] === undefined) continue;
      if (ids.includes(f)) o[f] = (b[f] === '' || b[f] === null) ? null : (Number(b[f]) || null);
      else if (nums.includes(f)) o[f] = Number(b[f]) || 0;
      else o[f] = String(b[f]).trim();
    }
    return o;
  };

  router.get(`/${table}`, requireStaff(mod), (req, res) => {
    const where = [], args = [];
    if (req.query.active !== 'all') { where.push('active = ?'); args.push(req.query.active === '0' ? 0 : 1); }
    const q = (req.query.q || '').trim();
    if (q && search.length) {
      where.push('(' + search.map(f => `${f} LIKE ?`).join(' OR ') + ')');
      search.forEach(() => args.push(`%${q}%`));
    }
    for (const [k, v] of Object.entries(req.query)) {
      if (['q', 'active'].includes(k) || v === '') continue;
      if (fields.includes(k)) { where.push(`${k} = ?`); args.push(v); }
    }
    const sql = `SELECT * FROM ${table}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`;
    res.json(db.prepare(sql).all(...args));
  });

  router.get(`/${table}/:id`, requireStaff(mod), (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: `找不到這筆${label}` });
    res.json(row);
  });

  router.post(`/${table}`, requireStaff(mod), (req, res) => {
    const data = pick(req.body || {});
    if (spec.validate) { const err = spec.validate(data, null); if (err) return res.status(400).json({ error: err }); }
    const keys = Object.keys(data);
    if (!keys.length) return res.status(400).json({ error: '沒有可儲存的欄位' });
    const info = db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
      .run(...keys.map(k => data[k]));
    audit('staff', req.user.id, req.user.name, `新增${label}：${data.name || data.plate || info.lastInsertRowid}`);
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid));
  });

  router.put(`/${table}/:id`, requireStaff(mod), (req, res) => {
    const cur = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!cur) return res.status(404).json({ error: `找不到這筆${label}` });
    const data = pick(req.body || {});
    if (spec.validate) { const err = spec.validate({ ...cur, ...data }, cur); if (err) return res.status(400).json({ error: err }); }
    const keys = Object.keys(data);
    if (keys.length) {
      db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map(k => data[k]), req.params.id);
    }
    audit('staff', req.user.id, req.user.name, `修改${label}：${cur.name || cur.plate || cur.id}`);
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id));
  });

  // 刪除一律是「停用」而不是真的刪：主檔被歷史單據參照著，
  // 真刪會讓去年的派車單失去車牌與司機姓名，之後想查也查不回來。
  router.delete(`/${table}/:id`, requireStaff(mod), (req, res) => {
    const cur = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!cur) return res.status(404).json({ error: `找不到這筆${label}` });
    if (spec.beforeDelete) { const err = spec.beforeDelete(cur); if (err) return res.status(400).json({ error: err }); }
    db.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).run(req.params.id);
    audit('staff', req.user.id, req.user.name, `停用${label}：${cur.name || cur.plate || cur.id}`);
    res.json({ ok: true });
  });

  return { pick };
}

module.exports = { attach };
