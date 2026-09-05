// 技師、床位、服務項目、商品、分店

// 主檔頁的共用產生器：清單、新增、編輯、停用的形狀都一樣，各寫一遍只會出錯。
function masterPage(key, def) {
  App.page(key, {
    title: def.title, module: def.module || key, sub: def.sub, help: def.help,
    async render(el) {
      const state = { q: '', active: '1', ...(def.state || {}) };
      el.innerHTML = '';
      const top = document.createElement('div');
      top.className = 'page-acts';
      if (App.canEdit(def.module || key)) top.innerHTML = `<button class="btn" id="new">＋ ${UI.esc(def.addLabel || '新增')}</button>`;
      if (def.exportName) top.appendChild(App.exportBtn(def.exportName, () => state));
      el.appendChild(top);
      if (App.canEdit(def.module || key)) {
        top.querySelector('#new').onclick = () => UI.modal({
          title: def.addLabel || '新增', wide: true, body: def.form({}),
          onOpen(e) { if (def.afterForm) def.afterForm(e, {}); },
          async onSubmit(e) { await POST(`/${def.table}`, UI.formData(e)); UI.toast('已新增'); draw(); }
        });
      }
      // 篩選器的選項要在畫面渲染時才取（下拉內容來自 App.opt，載入時序比模組定義晚）
      const extra = typeof def.filters === 'function' ? def.filters() : (def.filters || []);
      el.appendChild(App.filterBar([
        { name: 'q', label: '搜尋', type: 'search', placeholder: def.searchHint || '關鍵字' },
        { name: 'active', label: '狀態', type: 'select', options: [['1', '啟用中'], ['0', '已停用'], ['all', '全部']] },
        ...extra
      ], v => { Object.assign(state, v); draw(); }));
      const body = document.createElement('div');
      el.appendChild(body);

      async function draw() {
        const rows = await GET(`/${def.table}` + App.qs(state));
        body.innerHTML = (def.summary ? def.summary(rows) : '')
          + UI.table(def.headers.concat(['']), rows.map(r => `<tr class="${r.active ? '' : 'row-muted'}">
              ${def.row(r)}
              <td>${App.canEdit(def.module || key)
                ? `<button class="btn tiny secondary" data-e="${r.id}">編輯</button>
                   ${r.active ? `<button class="btn tiny danger" data-d="${r.id}">停用</button>` : ''}` : ''}</td></tr>`),
            '沒有資料');
        body.querySelectorAll('[data-e]').forEach(b => b.onclick = async () => {
          const cur = rows.find(x => String(x.id) === b.dataset.e);
          UI.modal({
            title: `編輯 ${cur.name || cur.id}`, wide: true, body: def.form(cur),
            onOpen(e) { if (def.afterForm) def.afterForm(e, cur); },
            async onSubmit(e) { await PUT(`/${def.table}/${cur.id}`, UI.formData(e)); UI.toast('已更新'); draw(); }
          });
        });
        body.querySelectorAll('[data-d]').forEach(b => b.onclick = async () => {
          if (!await UI.confirm('確定停用？停用不會刪除歷史資料。')) return;
          try { await DEL(`/${def.table}/${b.dataset.d}`); UI.toast('已停用'); draw(); } catch (e) { UI.err(e); }
        });
        if (def.after) def.after(body, rows, draw);
      }
      draw();
    }
  });
}

masterPage('therapists', {
  title: '技師管理', table: 'therapists', addLabel: '新增技師',
  sub: '級別決定預設抽成；個別談定的條件填在技師身上會覆蓋級別',
  searchHint: '姓名／編號／花名',
  help: {
    intro: '抽成％的優先順序：服務項目自訂 → 技師自訂 → 級別預設。留 0 就是沿用下一層。',
    steps: ['新增技師時先選「級別」，抽成留白即可（走級別預設）。',
      '個別談定的條件才填在技師的抽成欄位上。',
      '「可做項目」留空＝什麼都能做；有填的話開單選到不會做的項目會提醒。'],
    notes: ['技術士證與健康檢查到期會在「證照與健檢到期」頁追蹤，過期的技師上鐘時會被擋。'],
    terms: [['指名費', '技師每被指名一次實拿的金額。與「向客人加收多少」是兩件事，後者在系統設定。']]
  },
  filters: () => [
    { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市') },
    { name: 'level', label: '級別', type: 'select', options: App.listOptions('therapist_levels', '全部級別') },
    { name: 'employ_type', label: '雇用', type: 'select', options: App.listOptions('employ_types', '全部') }
  ],
  headers: ['編號', '姓名', '門市', '級別', '抽成（輪鐘／指名／商品）', '指名費', '底薪', '可做項目', '證照到期'],
  form(t) {
    return `<div class="form-grid">
      ${UI.input('code', '編號', { value: t.code || '', required: true })}
      ${UI.input('name', '姓名', { value: t.name || '', required: true })}
      ${UI.input('nickname', '花名（客人指名時講的）', { value: t.nickname || '' })}
      ${UI.select('gender', '性別', ['', '女', '男'], { value: t.gender || '', plain: true })}
      ${UI.input('phone', '電話', { value: t.phone || '' })}
      ${UI.input('line_uid', 'LINE UID', { value: t.line_uid || '' })}
      ${UI.select('store_id', '門市', App.storeOptions('　'), { value: t.store_id || '' })}
      ${UI.select('level', '級別', App.opt.lists.therapist_levels || [], { value: t.level || '一般', plain: true })}
      ${UI.select('employ_type', '雇用型態', App.opt.lists.employ_types || [], { value: t.employ_type || '全職', plain: true })}
      ${UI.input('hire_date', '到職日', { type: 'date', value: t.hire_date || '' })}
      ${UI.input('base_salary', '底薪', { type: 'number', value: t.base_salary || 0 })}
      ${UI.input('pct_normal', '輪鐘抽成％（0＝用級別預設）', { type: 'number', value: t.pct_normal || 0 })}
      ${UI.input('pct_designated', '指名抽成％（0＝用級別預設）', { type: 'number', value: t.pct_designated || 0 })}
      ${UI.input('pct_retail', '商品抽成％（0＝用級別預設）', { type: 'number', value: t.pct_retail || 0 })}
      ${UI.input('designate_fee', '指名費（技師實拿，0＝用級別預設）', { type: 'number', value: t.designate_fee || 0 })}
      ${UI.checkList('skills', '可做項目（留空＝不限）', (App.opt.lists.service_categories || []).concat((App.opt.services || []).map(s => s.name)), { value: t.skills || '' })}
      ${UI.input('cert_no', '技術士證號', { value: t.cert_no || '' })}
      ${UI.input('cert_expiry', '技術士證到期', { type: 'date', value: t.cert_expiry || '' })}
      ${UI.input('health_check_date', '健檢日期', { type: 'date', value: t.health_check_date || '' })}
      ${UI.input('health_check_expiry', '健檢到期', { type: 'date', value: t.health_check_expiry || '' })}
      ${UI.checkbox('is_blind', '視障按摩人員', t.is_blind)}
      ${UI.textarea('note', '備註', { rows: 2, value: t.note || '' })}
    </div>`;
  },
  row(r) {
    const lv = (App.opt.level_rates || {})[r.level] || {};
    const p = (own, def) => own > 0 ? `<b>${own}%</b>` : `${def || 0}%`;
    return `<td>${UI.esc(r.code)}</td>
      <td>${UI.esc(r.name)}${r.nickname ? `<span class="muted"> ${UI.esc(r.nickname)}</span>` : ''}${r.is_blind ? UI.tag('視障', '') : ''}</td>
      <td>${UI.esc(App.nameOf('stores', r.store_id) || '—')}</td>
      <td>${UI.esc(r.level)}</td>
      <td>${p(r.pct_normal, lv.normal)} / ${p(r.pct_designated, lv.designated)} / ${p(r.pct_retail, lv.retail)}</td>
      <td class="num">${UI.fmtMoney(r.designate_fee > 0 ? r.designate_fee : (lv.fee || 0))}</td>
      <td class="num">${UI.fmtMoney(r.base_salary)}</td>
      <td class="muted">${UI.esc(r.skills || '不限')}</td>
      <td>${UI.esc(r.cert_expiry || '未登錄')}</td>`;
  },
  summary() { return '<div class="notice">粗體的抽成％是技師個別設定，一般字體是沿用級別預設（可在「抽成與級距」頁調整）。</div>'; }
});

masterPage('rooms', {
  title: '床位與包廂', table: 'rooms', addLabel: '新增床位',
  sub: '房型會影響服務項目能不能排進去；足療區可設定同時容納多組',
  help: {
    intro: '床位是排鐘看板的第二條軸線。開單時系統會檢查同時段有沒有空間，判斷依據就是這裡的「房型」與「可容組數」。',
    steps: [
      '先選門市，再填名稱（A1、VIP-2、足療區這種現場叫得出來的名字）。',
      '選房型 —— 服務項目那邊可以指定「這個項目要做在哪種房型」，兩邊要對得起來。',
      '足療區這種開放空間，把「可容組數」設成實際座位數。',
      '「排序」決定排鐘看板上由上到下的順序，通常照現場的動線排。'
    ],
    notes: [
      '可容組數預設 1：同時段只要有一組客人就算滿，開單會擋。設成 6 的足療區則要 6 組才算滿。',
      '停用不會刪除歷史鐘單，過去的單子仍看得到當初在哪個房間做的。'
    ],
    terms: [
      ['房型', '單人床／雙人房／VIP包廂／足療區／沖澡間，可在系統設定增減。'],
      ['可容組數', '同時段這個空間能容納幾組客人，是床位衝突判斷的分母。']
    ]
  },
  filters: () => [
    { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市') },
    { name: 'rtype', label: '房型', type: 'select', options: App.listOptions('room_types', '全部房型') }
  ],
  headers: ['門市', '名稱', '房型', '可容組數', '排序'],
  form(r) {
    return `<div class="form-grid">
      ${UI.select('store_id', '門市', App.storeOptions('　'), { value: r.store_id || '' })}
      ${UI.input('name', '名稱', { value: r.name || '', required: true })}
      ${UI.select('rtype', '房型', App.opt.lists.room_types || [], { value: r.rtype || '單人床', plain: true })}
      ${UI.input('capacity', '可同時容納幾組', { type: 'number', value: r.capacity || 1 })}
      ${UI.input('seq', '排序', { type: 'number', value: r.seq || 0 })}
      ${UI.textarea('note', '備註', { rows: 2, value: r.note || '' })}
    </div><div class="muted">足療區這種開放空間把「可容組數」設成實際座位數，開單時才不會被誤判成衝突。</div>`;
  },
  row(r) {
    return `<td>${UI.esc(App.nameOf('stores', r.store_id) || '—')}</td><td>${UI.esc(r.name)}</td>
      <td>${UI.esc(r.rtype)}</td><td class="num">${r.capacity}</td><td class="num">${r.seq}</td>`;
  }
});

masterPage('services', {
  title: '服務項目', table: 'services', addLabel: '新增項目',
  sub: '時長、定價、需要的房型，以及哪些身體狀況不能做',
  help: {
    intro: '「禁忌」是這個頁面最重要的欄位：勾了什麼，開單時遇到有該狀況的客人就會被擋下來。',
    steps: ['填時長與定價；時長會決定看板上色塊的長度與結束時間。',
      '「需要房型」留空＝不限；有填的話排到別的房型會提醒。',
      '勾選禁忌狀況，例如精油與熱石通常排除懷孕。'],
    notes: ['抽成％留 0＝沿用技師／級別設定。高價療程若要抽低一點，才填在這裡。',
      '品名與說明會被「用語合規自檢」掃描，別寫「治療」「療效」等字眼。']
  },
  headers: ['代碼', '名稱', '分類', '時長', '牌價', '現場價', '會員價', '折數', '需要房型', '禁忌'],
  filters: () => [
    { name: 'category', label: '分類', type: 'select', options: App.listOptions('service_categories', '全部分類') },
    { name: 'is_package', label: '類型', type: 'select', options: [['', '全部'], ['0', '單項'], ['1', '組合套票']] }
  ],
  form(s) {
    return `<div class="form-grid">
      ${UI.input('code', '代碼', { value: s.code || '' })}
      ${UI.input('name', '名稱', { value: s.name || '', required: true })}
      ${UI.select('category', '分類', App.opt.lists.service_categories || [], { value: s.category || '', plain: true })}
      ${UI.input('minutes', '時長（分鐘）', { type: 'number', value: s.minutes || 60 })}
      ${UI.input('list_price', '牌價（原價，折扣率的分母）', { type: 'number', value: s.list_price || 0 })}
      ${UI.input('price', '現場價（散客實收）', { type: 'number', value: s.price || 0 })}
      ${UI.input('member_price', '會員價（留 0＝同現場價）', { type: 'number', value: s.member_price || 0 })}
      ${UI.checkbox('is_package', '這是組合套票', s.is_package)}
      ${UI.select('package_items', '套票包含的項目（可複選，按住 Ctrl）', [], { value: '', full: true, plain: true })}
      ${UI.checkList('room_type', '需要房型（留空＝不限）', App.opt.lists.room_types || [], { value: s.room_type || '' })}
      ${UI.checkList('contraindications', '禁忌狀況（勾了就會擋）', App.opt.lists.health_conditions || [], { value: s.contraindications || '' })}
      ${UI.input('pct_normal', '輪鐘抽成％覆寫（0＝不覆寫）', { type: 'number', value: s.pct_normal || 0 })}
      ${UI.input('pct_designated', '指名抽成％覆寫（0＝不覆寫）', { type: 'number', value: s.pct_designated || 0 })}
      ${UI.input('buffer_min', '結束後整理時間（分鐘）', { type: 'number', value: s.buffer_min || 0 })}
      ${UI.input('seq', '排序', { type: 'number', value: s.seq || 0 })}
      ${UI.textarea('description', '說明', { rows: 2, value: s.description || '' })}
    </div>
    <div class="muted">牌價是折扣率的分母：實收 ÷ 牌價就是這張單真正打了幾折。牌價不能低於現場價。</div>`;
  },
  // 套票的子項目要用複選清單，開啟後由 afterForm 換掉
  afterForm(el, cur) {
    const wrap = el.querySelector('[name=package_items]');
    if (!wrap) return;
    const picked = String(cur.package_items || '').split(',').map(x => x.trim()).filter(Boolean);
    const opts = (App.opt.services || []).filter(x => !x.is_package);
    wrap.outerHTML = `<div class="chk-list" data-cl-wrap="package_items">${opts.map(o =>
      `<label class="chk"><input type="checkbox" data-cl="package_items" value="${o.id}"${
        picked.includes(String(o.id)) ? ' checked' : ''}> ${UI.esc(o.name)}（${o.minutes}分 ${UI.fmtMoney(o.price)}）</label>`).join('')}</div>
      <input type="hidden" name="package_items" value="${UI.esc(picked.join(','))}">`;
    UI.bindCheckLists(el);
  },
  row(s) {
    const list = s.list_price || s.price;
    const off = list ? 1 - s.price / list : 0;
    return `<td>${UI.esc(s.code)}</td>
      <td>${UI.esc(s.name)}${s.is_package ? UI.tag('套票', 'ok') : ''}</td>
      <td>${UI.esc(s.category)}</td>
      <td class="num">${s.minutes} 分</td>
      <td class="num muted">${UI.fmtMoney(list)}</td>
      <td class="num"><b>${UI.fmtMoney(s.price)}</b></td>
      <td class="num">${s.member_price ? UI.fmtMoney(s.member_price) : '—'}</td>
      <td class="num">${off > 0 ? `${Math.round((1 - off) * 100)} 折` : '—'}</td>
      <td>${UI.esc(s.room_type || '不限')}</td>
      <td class="muted">${UI.esc(s.contraindications || '無')}</td>`;
  }
});

masterPage('retail', {
  title: '商品與庫存', table: 'retail_products', module: 'retail', addLabel: '新增商品',
  sub: '販售商品的成本、庫存與抽成',
  help: {
    intro: '技師在鐘單上加賣商品時，存檔就直接扣庫存；鐘單取消會自動加回來，不必手動盤。',
    steps: [
      '填售價與成本，畫面會自動算毛利率。',
      '設「安全庫存」，低於門檻時這一頁與儀表板都會跳紅字提醒。',
      '抽成％留 0 就是沿用技師／級別的商品抽成；某些高毛利商品要抽多一點才填在這裡。',
      '進貨後直接編輯「庫存」欄位加上去。'
    ],
    notes: [
      '商品抽成與服務抽成分開算，不會併進服務業績的級距獎金 —— 否則會變成鼓勵推銷不做鐘。',
      '禮券類商品成本填 0 即可，但要記得它賣出去是預收款，不是當下的收入。',
      '品名與備註會被「用語合規自檢」掃描，別寫「排毒」「瘦身」這種字眼。'
    ],
    terms: [['安全庫存', '低於這個數量就提醒補貨，通常設成「補貨到貨前會賣掉的量」。']]
  },
  filters: () => [{ name: 'category', label: '分類', type: 'select', options: App.listOptions('retail_categories', '全部分類') }],
  headers: ['貨號', '名稱', '分類', '售價', '成本', '毛利率', '庫存', '抽成'],
  form(p) {
    return `<div class="form-grid">
      ${UI.input('sku', '貨號', { value: p.sku || '' })}
      ${UI.input('name', '名稱', { value: p.name || '', required: true })}
      ${UI.select('category', '分類', App.opt.lists.retail_categories || [], { value: p.category || '', plain: true })}
      ${UI.input('price', '售價', { type: 'number', value: p.price || 0 })}
      ${UI.input('cost', '成本', { type: 'number', value: p.cost || 0 })}
      ${UI.input('pct_retail', '抽成％覆寫（0＝用技師設定）', { type: 'number', value: p.pct_retail || 0 })}
      ${UI.input('stock', '庫存', { type: 'number', value: p.stock || 0 })}
      ${UI.input('safety_stock', '安全庫存', { type: 'number', value: p.safety_stock || 0 })}
      ${UI.textarea('note', '備註', { rows: 2, value: p.note || '' })}
    </div>`;
  },
  row(p) {
    const margin = p.price ? (p.price - p.cost) / p.price : 0;
    return `<td>${UI.esc(p.sku)}</td><td>${UI.esc(p.name)}</td><td>${UI.esc(p.category)}</td>
      <td class="num">${UI.fmtMoney(p.price)}</td><td class="num">${UI.fmtMoney(p.cost)}</td>
      <td class="num">${UI.fmtPct(margin)}</td>
      <td class="num ${p.stock <= p.safety_stock ? 'danger' : ''}">${p.stock}</td>
      <td class="num">${p.pct_retail ? p.pct_retail + '%' : '—'}</td>`;
  },
  summary(rows) {
    const low = rows.filter(r => r.active && r.stock <= r.safety_stock);
    return low.length ? `<div class="notice warn">⚠ ${low.length} 項商品低於安全庫存：${low.map(r => UI.esc(r.name)).join('、')}</div>` : '';
  }
});

masterPage('stores', {
  title: '分店設定', table: 'stores', addLabel: '新增分店',
  sub: '門市資料、營業時間與跨店拆帳比例',
  help: {
    intro: '單店也要建一筆。營業時間會決定排鐘看板的時間軸範圍，以及床位使用率的分母。',
    steps: [
      '填店名、電話、地址 —— 這三項會出現在客人收到的預約通知裡。',
      '設開店與打烊時間，排鐘看板的橫軸就是這個區間。',
      '有多家店時，帳號可以綁定門市，該員工預設只看自己店的資料。'
    ],
    notes: [
      '打烊時間跨午夜（例如凌晨 2 點）請填 23:59，深夜時段的單仍可正常開，只是看板畫到 23:59。',
      '停用門市不會影響歷史資料，但該店的技師與床位要另外處理。'
    ],
    terms: [
      ['跨店拆帳％', '客人拿 A 店買的儲值或次卡到 B 店消費時，服務店（B）可取得的比例。單店可忽略。']
    ]
  },
  headers: ['代碼', '名稱', '電話', '營業時間', '跨店拆帳％', '地址'],
  form(s) {
    return `<div class="form-grid">
      ${UI.input('code', '代碼', { value: s.code || '' })}
      ${UI.input('name', '名稱', { value: s.name || '', required: true })}
      ${UI.input('phone', '電話', { value: s.phone || '' })}
      ${UI.input('open_time', '開店時間', { type: 'time', value: s.open_time || '10:00' })}
      ${UI.input('close_time', '打烊時間', { type: 'time', value: s.close_time || '23:00' })}
      ${UI.input('cross_store_pct', '跨店使用預收時，服務店可取得的％', { type: 'number', value: s.cross_store_pct ?? 100 })}
      ${UI.input('address', '地址', { value: s.address || '', full: true })}
      ${UI.textarea('note', '備註', { rows: 2, value: s.note || '' })}
    </div><div class="muted">營業時間會決定排鐘看板的時間軸範圍與床位使用率的分母。</div>`;
  },
  row(s) {
    return `<td>${UI.esc(s.code)}</td><td>${UI.esc(s.name)}</td><td>${UI.esc(s.phone)}</td>
      <td>${UI.esc(s.open_time)}~${UI.esc(s.close_time)}</td>
      <td class="num">${s.cross_store_pct}%</td><td class="muted">${UI.esc(s.address)}</td>`;
  }
});


masterPage('addons', {
  title: '加購品', table: 'addons', addLabel: '新增加購品',
  sub: '刮痧、拔罐、足部護理、附餐茶點',
  searchHint: '名稱／代碼／分類',
  help: {
    intro: '把固定加購做成主檔，是為了讓月底統計得出「刮痧到底賣了幾次」——自由輸入品名的話，每個櫃檯打出來的字都不一樣。',
    steps: [
      '按「新增加購品」，填名稱與三層價格（跟服務項目同一套定價邏輯）。',
      '填「會延長多久」：刮痧 15 分會把鐘單的結束時間往後推，附餐茶點填 0。',
      '附餐、浴衣這類不需要技師施作的，把「需要技師施作」取消勾選 —— 它們不會算進技師業績。',
      '抽成％留 0 就是沿用技師／級別的商品抽成。'
    ],
    notes: [
      '在鐘單上加購時會自動依客人是不是會員帶出對應價格。',
      '停用不會影響已經賣出去的紀錄。'
    ],
    terms: [['需要技師施作', '勾了就算技師業績並抽成；附餐茶點這類請取消勾選。']]
  },
  filters: () => [{ name: 'category', label: '分類', type: 'select', options: App.listOptions('addon_categories', '全部分類') }],
  headers: ['代碼', '名稱', '分類', '延長時間', '牌價', '現場價', '會員價', '技師施作', '抽成'],
  form(a) {
    return `<div class="form-grid">
      ${UI.input('code', '代碼', { value: a.code || '' })}
      ${UI.input('name', '名稱', { value: a.name || '', required: true })}
      ${UI.select('category', '分類', App.opt.lists.addon_categories || [], { value: a.category || '加購療程', plain: true })}
      ${UI.input('minutes', '會延長幾分鐘（附餐填 0）', { type: 'number', value: a.minutes || 0 })}
      ${UI.input('list_price', '牌價', { type: 'number', value: a.list_price || 0 })}
      ${UI.input('price', '現場價', { type: 'number', value: a.price || 0 })}
      ${UI.input('member_price', '會員價（0＝同現場價）', { type: 'number', value: a.member_price || 0 })}
      ${UI.input('pct_commission', '抽成％覆寫（0＝用技師設定）', { type: 'number', value: a.pct_commission || 0 })}
      ${UI.input('seq', '排序', { type: 'number', value: a.seq || 0 })}
      ${UI.checkbox('requires_therapist', '需要技師施作（會算業績與抽成）', a.requires_therapist === undefined ? 1 : a.requires_therapist)}
      ${UI.textarea('note', '備註', { rows: 2, value: a.note || '' })}
    </div>`;
  },
  row(a) {
    return `<td>${UI.esc(a.code)}</td><td>${UI.esc(a.name)}</td><td>${UI.esc(a.category)}</td>
      <td class="num">${a.minutes ? a.minutes + ' 分' : '—'}</td>
      <td class="num muted">${UI.fmtMoney(a.list_price)}</td>
      <td class="num"><b>${UI.fmtMoney(a.price)}</b></td>
      <td class="num">${a.member_price ? UI.fmtMoney(a.member_price) : '—'}</td>
      <td>${a.requires_therapist ? '是' : '否'}</td>
      <td class="num">${a.pct_commission ? a.pct_commission + '%' : '—'}</td>`;
  }
});
