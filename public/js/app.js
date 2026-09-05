// App 骨架：登入、側欄導覽、頁面路由
const App = {
  me: null,
  pages: {},          // key -> { title, sub, module, help, render }
  opt: {},            // 共用下拉選項（車、司機、供應商、客戶、行程、梯次）
  pageQuery: new URLSearchParams(),

  page(key, def) { App.pages[key] = def; },

  async boot() {
    try {
      App.me = await GET('/me');
      await App.loadShared();
      App.renderLayout();
      App.go(location.hash.slice(1) || App.homePage());
    } catch {
      App.renderLogin();
    }
    window.addEventListener('hashchange', () => App.go(location.hash.slice(1) || App.homePage()));
  },

  onUnauthorized() { if (App.me) { App.me = null; App.renderLogin(); } },

  async loadShared() { App.opt = await GET('/options').catch(() => ({ lists: {} })); },
  async refreshOptions() { App.opt = await GET('/options').catch(() => App.opt); },

  // ---- 下拉選項小工具 ----
  optionsOf(list, { all, none, label = 'name', value = 'id' } = {}) {
    return (all ? [['', all]] : none ? [['', none]] : [])
      .concat((list || []).map(x => [x[value], typeof label === 'function' ? label(x) : x[label]]));
  },
  therapistOptions(all, opts = {}) {
    let list = App.opt.therapists || [];
    if (opts.store_id) list = list.filter(t => String(t.store_id) === String(opts.store_id));
    return App.optionsOf(list, { all: all || undefined, none: all ? undefined : '未指派技師',
      label: t => `${t.code} ${t.name}${t.nickname ? `（${t.nickname}）` : ''}｜${t.level}` });
  },
  roomOptions(all, opts = {}) {
    let list = App.opt.rooms || [];
    if (opts.store_id) list = list.filter(r => String(r.store_id) === String(opts.store_id));
    return App.optionsOf(list, { all: all || undefined, none: all ? undefined : '未指定床位',
      label: r => `${r.name}（${r.rtype}${r.capacity > 1 ? ` 可容 ${r.capacity} 組` : ''}）` });
  },
  serviceOptions(all) {
    return App.optionsOf(App.opt.services, { all: all || undefined, none: all ? undefined : '請選擇項目',
      label: s => `${s.name}｜${s.minutes} 分 ${UI.fmtMoney(s.price)}` });
  },
  productOptions(all) {
    return App.optionsOf(App.opt.retail_products, { all: all || undefined, none: all ? undefined : '請選擇商品',
      label: p => `${p.name}（${UI.fmtMoney(p.price)}／庫存 ${p.stock}）` });
  },
  memberOptions(all) {
    return App.optionsOf(App.opt.members, { all: all || undefined, none: all ? undefined : '非會員（現場客）',
      label: m => `${m.name}${m.phone ? `　${m.phone}` : ''}` });
  },
  storeOptions(all) { return App.optionsOf(App.opt.stores, { all: all || '全部門市' }); },
  staffOptions(all) { return App.optionsOf(App.opt.staff, { all: all || undefined, none: all ? undefined : '未指派' }); },

  listOptions(key, withAll) {
    const list = (App.opt.lists && App.opt.lists[key]) || [];
    return (withAll ? [['', withAll]] : []).concat(list.map(v => [v, v]));
  },
  nameOf(list, id, field = 'name') {
    const x = (App.opt[list] || []).find(v => String(v.id) === String(id));
    return x ? x[field] : '';
  },

  can(module) { return App.me && (App.me.role === 'admin' || App.me.modules.includes(module)); },
  canEdit(module) {
    if (!module) return true;
    if (!App.me) return false;
    if (App.me.role === 'admin') return true;
    return App.me.modules.includes(module) && !(App.me.readonly || []).includes(module);
  },
  currentModule() {
    const key = (location.hash.slice(1) || '').split('?')[0];
    const def = App.pages[key];
    return def ? def.module : null;
  },

  readonlyBanner() {
    return `<div class="notice warn readonly-banner">
      🔒 你對這個模組只有<b>檢視權限</b>：可以看資料與匯出報表，但新增、修改、刪除都會被擋下。
      需要編輯請找管理員調整帳號權限。</div>`;
  },
  lockPage(root) {
    const SAFE = '.export-bar button, [data-view], [data-f], #help-toggle, .ss-search';
    root.querySelectorAll('#page-body button').forEach(b => {
      if (b.matches(SAFE) || b.closest('.export-bar')) return;
      b.disabled = true;
      b.title = '你對這個模組只有檢視權限';
      b.classList.add('locked');
    });
  },

  async renderLogin() {
    const t = await GET('/public/ui-texts').catch(() => ({}));
    document.getElementById('app').innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <h1>${UI.esc(t.ui_login_title || t.company_name || 'RelaxCare')}</h1>
          <div class="sub">${UI.esc(t.ui_login_sub || '按摩／SPA 連鎖營運管理系統')}</div>
          <div class="form-row"><label>帳號</label><input id="lg-user" autocomplete="username"></div>
          <div class="form-row"><label>密碼</label><input id="lg-pass" type="password" autocomplete="current-password"></div>
          <button class="btn" id="lg-btn">登入</button>
          <div class="login-err" id="lg-err"></div>
          ${t.ui_demo_hint ? `<div style="margin-top:14px;padding:12px;background:var(--primary-light);border-radius:8px;font-size:13px;line-height:1.8">${UI.esc(t.ui_demo_hint).replace(/\n/g, '<br>')}</div>` : ''}
          <div style="margin-top:14px;font-size:13px;text-align:center">
            <a href="#" id="lg-forgot">忘記密碼</a>　·　
            <a href="/intro.html">系統功能介紹</a>　·　<a href="/book.html">官網線上預約頁</a></div>
        </div>
      </div>`;
    const doLogin = async () => {
      const err = document.getElementById('lg-err');
      err.textContent = '';
      try {
        await POST('/login', {
          username: document.getElementById('lg-user').value.trim(),
          password: document.getElementById('lg-pass').value
        });
        location.reload();
      } catch (e) { err.textContent = e.message; }
    };
    // 忘記密碼：沒有 email 也沒有簡訊，所以走「向管理員要一次性代碼、自己在這裡改」。
    document.getElementById('lg-forgot').onclick = e => {
      e.preventDefault();
      UI.modal({
        title: '忘記密碼', submitText: '設定新密碼',
        body: `<div class="notice">請向管理員索取「密碼重設代碼」（管理員在「帳號權限」頁按重設密碼即可產生，
            30 分鐘內有效、只能用一次），拿到之後在這裡設定新密碼。</div>
          <div class="form-grid">
            ${UI.input('username', '帳號', { full: true })}
            ${UI.input('code', '重設代碼', { full: true, placeholder: '8 碼英數' })}
            ${UI.input('new_password', '新密碼（至少 6 碼）', { type: 'password', full: true })}
          </div>`,
        async onSubmit(el2) {
          const f = UI.formData(el2);
          await POST('/password-reset', f);
          UI.toast('密碼已更新，請用新密碼登入');
        }
      });
    };
    document.getElementById('lg-btn').onclick = doLogin;
    document.getElementById('lg-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  },

  navGroups: [
    { label: '每日作業', keys: ['dashboard', 'queue', 'board', 'tickets', 'bookings', 'closing', 'issues'] },
    { label: '客戶與預收', keys: ['members', 'wallets', 'passes', 'vouchers', 'loyalty', 'repurchase'] },
    { label: '資源與商品', keys: ['therapists', 'rooms', 'services', 'addons', 'retail', 'purchase'] },
    { label: '薪酬', keys: ['payroll', 'commission', 'attendance', 'roster'] },
    { label: '財務', keys: ['finance', 'liability', 'expenses', 'invoices'] },
    { label: '法遵', keys: ['compliance'] },
    { label: '系統', keys: ['notifications', 'stores', 'users', 'settings', 'audit', 'backup'] }
  ],

  renderLayout() {
    const navHtml = App.navGroups.map(g => {
      const items = g.keys.filter(k => App.pages[k] && (!App.pages[k].module || App.can(App.pages[k].module)));
      if (!items.length) return '';
      return `<div class="nav-group">${g.label}</div>` +
        items.map(k => `<a href="#${k}" data-nav="${k}">${UI.esc(App.pages[k].title)}</a>`).join('');
    }).join('');
    document.getElementById('app').innerHTML = `
      <div class="topbar">
        <button class="menu-btn" id="menu-btn">選單</button>
        <strong>${UI.esc(App.me.company_name)}</strong>
      </div>
      <div class="backdrop" id="backdrop"></div>
      <div class="layout">
        <aside class="sidebar" id="sidebar">
          <div class="brand">${UI.esc(App.me.company_name)}<small>按摩／SPA 連鎖營運管理系統</small></div>
          <nav class="nav" id="nav">${navHtml}</nav>
          <div class="user-box">
            <div class="name">${UI.esc(App.me.name)}</div>
            <div>${UI.esc(App.me.title || (App.me.role === 'admin' ? '管理員' : '員工'))}</div>
            <button id="pw-btn" type="button">修改密碼</button>
            <button id="logout-btn" type="button">登出</button>
          </div>
        </aside>
        <main class="main" id="page"></main>
      </div>`;
    document.getElementById('logout-btn').onclick = async () => { await POST('/logout'); location.reload(); };
    document.getElementById('pw-btn').onclick = App.changePasswordDialog;
    const sidebar = document.getElementById('sidebar'), backdrop = document.getElementById('backdrop');
    document.getElementById('menu-btn').onclick = () => { sidebar.classList.add('open'); backdrop.classList.add('show'); };
    backdrop.onclick = () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); };
    document.getElementById('nav').addEventListener('click', () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); });
  },

  changePasswordDialog() {
    UI.modal({
      title: '修改密碼',
      body: `<div class="form-grid">
        ${UI.input('old_password', '舊密碼', { type: 'password', full: true })}
        ${UI.input('new_password', '新密碼（至少 6 碼）', { type: 'password', full: true })}
      </div>`,
      onSubmit: async el => { await PUT('/me/password', UI.formData(el)); UI.toast('密碼已更新'); }
    });
  },

  homePage() {
    if (App.can('dashboard')) return 'dashboard';
    for (const g of App.navGroups) {
      for (const k of g.keys) {
        const d = App.pages[k];
        if (d && (!d.module || App.can(d.module))) return k;
      }
    }
    return 'dashboard';
  },

  // 頁面 hash 可帶參數（例如 #orders?id=12），路由只看問號前的頁面代碼
  async go(rawKey) {
    const [key, query = ''] = String(rawKey).split('?');
    App.pageQuery = new URLSearchParams(query);
    const def = App.pages[key];
    if (!def || (def.module && !App.can(def.module))) {
      const home = App.homePage();
      if (home === key || !App.pages[home]) {
        document.getElementById('page').innerHTML =
          '<div class="empty">你的帳號目前沒有可用的模組，請聯絡管理員開通權限。</div>';
        return;
      }
      return App.go(home);
    }
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === key));
    if (location.hash.slice(1) !== rawKey) history.replaceState(null, '', '#' + rawKey);
    const el = document.getElementById('page');
    const readonly = !App.canEdit(def.module);
    el.innerHTML = `<div class="page-title">${UI.esc(def.title)}</div><div class="page-sub">${UI.esc(def.sub || '')}</div>`
      + App.helpHtml(key, def.help)
      + (readonly ? App.readonlyBanner() : '')
      + `<div id="page-body"><div class="empty">載入中...</div></div>`;
    App.bindHelp(el, key);
    try {
      await def.render(document.getElementById('page-body'));
      Charts.mount(el);
      if (readonly) App.lockPage(el);
    } catch (e) {
      document.getElementById('page-body').innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`;
    }
  },

  // 頁面操作說明：{ intro, steps:[], notes:[], terms:[[名詞,解釋]] }
  helpKey(key) { return 'help_open_' + key; },
  helpOpen(key) {
    try { return localStorage.getItem(App.helpKey(key)) !== '0'; } catch { return true; }
  },
  helpHtml(key, help) {
    if (!help) return '';
    const li = arr => (arr || []).map(t => `<li>${UI.esc(t)}</li>`).join('');
    const open = App.helpOpen(key);
    const steps = help.steps && help.steps.length ? `<div class="help-h">操作步驟</div><ol>${li(help.steps)}</ol>` : '';
    const notes = help.notes && help.notes.length ? `<div class="help-h">注意事項</div><ul>${li(help.notes)}</ul>` : '';
    const terms = help.terms && help.terms.length
      ? `<div class="help-h">名詞說明</div><dl>` + help.terms.map(([t, d]) => `<dt>${UI.esc(t)}</dt><dd>${UI.esc(d)}</dd>`).join('') + `</dl>` : '';
    return `<section class="help-box${open ? ' open' : ''}" id="help-box">
      <button type="button" class="help-toggle" id="help-toggle">
        <span class="help-mark">?</span>操作說明<span class="help-arrow">${open ? '收合' : '展開'}</span>
      </button>
      <div class="help-body">${help.intro ? `<p class="help-intro">${UI.esc(help.intro)}</p>` : ''}${steps}${notes}${terms}</div>
    </section>`;
  },
  bindHelp(el, key) {
    const box = el.querySelector('#help-box');
    if (!box) return;
    el.querySelector('#help-toggle').onclick = () => {
      const open = box.classList.toggle('open');
      box.querySelector('.help-arrow').textContent = open ? '收合' : '展開';
      try { localStorage.setItem(App.helpKey(key), open ? '1' : '0'); } catch {}
    };
  },

  reload() { App.go(location.hash.slice(1) || App.homePage()); },

  // 篩選列：定義 [{name,label,type,options,value}]，變動即回呼
  filterBar(fields, onChange) {
    const html = fields.map(f => {
      if (f.type === 'select') {
        const opts = f.options.map(o => (Array.isArray(o) ? o : [o, o]));
        const searchable = opts.length >= UI.SEARCHABLE_MIN;
        const optionsHtml = opts.map(([v, t]) =>
          `<option value="${UI.esc(v)}"${String(v) === String(f.value ?? '') ? ' selected' : ''}>${UI.esc(t)}</option>`).join('');
        return `<label class="fl">${UI.esc(f.label)}
          ${searchable ? `<input type="search" class="ss-search" data-ss-for="${f.name}" placeholder="搜尋${UI.esc(f.label)}" autocomplete="off">` : ''}
          <select data-f="${f.name}"${searchable ? ` name="${f.name}" data-ss-options="${UI.esc(JSON.stringify(opts))}"` : ''}>${optionsHtml}</select></label>`;
      }
      return `<label class="fl">${UI.esc(f.label)}
        <input data-f="${f.name}" type="${f.type || 'text'}" value="${UI.esc(f.value ?? '')}" placeholder="${UI.esc(f.placeholder || '')}"></label>`;
    }).join('');
    const wrap = document.createElement('div');
    wrap.className = 'filter-bar';
    wrap.innerHTML = html;
    UI.bindSearchSelects(wrap);

    // 值沒有真的變動就不重新查詢。
    //
    // 這不只是省一次請求 —— 在文字搜尋框打完字之後，使用者接下來多半是直接點清單裡的某一列。
    // 那一下 mousedown 會讓搜尋框失焦，瀏覽器接著補送一個原生 change，
    // 若照單全收就會重畫整張表；等到 mouseup 時原本那一列已經被換掉，
    // 使用者的點擊就這樣消失了，畫面上看起來像是「點了沒反應，要點兩次」。
    const read = () => {
      const out = {};
      wrap.querySelectorAll('[data-f]').forEach(i => { out[i.dataset.f] = i.value.trim(); });
      return out;
    };
    let last = JSON.stringify(read());
    const emit = () => {
      const out = read();
      const key = JSON.stringify(out);
      if (key === last) return;
      last = key;
      onChange(out);
    };
    wrap.addEventListener('change', emit);
    wrap.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); emit(); } });
    return wrap;
  },

  qs(obj) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj || {})) if (v !== '' && v !== undefined && v !== null) p.set(k, v);
    const s = p.toString();
    return s ? '?' + s : '';
  },

  // CSV 匯出鍵：畫面上篩到什麼就匯出什麼
  exportBtn(dataset, paramsFn, text = '⬇ 匯出 CSV') {
    const b = document.createElement('button');
    b.className = 'btn tiny secondary';
    b.textContent = text;
    b.onclick = () => { location.href = `/api/export/${dataset}` + App.qs(typeof paramsFn === 'function' ? paramsFn() : paramsFn); };
    const w = document.createElement('span');
    w.className = 'export-bar';
    w.appendChild(b);
    return w;
  },

  // 檢查結果（衝突／警告）的統一呈現。派車、法遵、名冊都用同一個樣子，
  // 使用者學一次就到處都認得。
  issueList(issues, emptyText = '沒有發現問題') {
    if (!issues || !issues.length) return `<div class="notice ok">✓ ${UI.esc(emptyText)}</div>`;
    return issues.map(i => {
      const hard = i.level === 'conflict' || i.level === 'high' || i.level === 'expired';
      return `<div class="notice ${hard ? 'danger' : 'warn'}">
        <b>${hard ? '⛔ 衝突' : '⚠ 提醒'}</b>　${UI.esc(i.message)}</div>`;
    }).join('');
  },

  statusTag(dict, value) {
    const map = {
      ticket_status: { booked: 'warn', serving: 'ok', done: '', cancelled: 'danger', noshow: 'danger' },
      assign_type: { rotation: '', designated: 'ok', assigned: 'warn' },
      shift_status: { waiting: 'ok', serving: 'warn', resting: '', off: 'danger' },
      pass_status: { active: 'ok', used_up: '', expired: 'danger', refunded: 'danger', transferred: '' },
      voucher_status: { unused: 'ok', used: '', settled: '', expired: 'danger', void: 'danger' },
      price_tier: { list: '', walkin: '', member: 'ok', package: 'ok', voucher: 'warn' },
      payroll_status: { draft: 'warn', confirmed: 'ok', paid: '' },
      issue_status: { open: 'danger', handling: 'warn', closed: 'ok' },
      severity: { low: '', normal: 'warn', high: 'danger' },
      booking_status: { new: 'danger', contacted: 'warn', converted: 'ok', rejected: '' },
      expiry_status: { expired: 'danger', missing: 'danger', soon: 'warn', ok: 'ok' },
      consent_status: { no_consent: 'danger', no_health: 'warn', stale: 'warn', ok: 'ok' }
    };
    return UI.tag(twLabel(dict, value), (map[dict] || {})[value] || '');
  }
};
