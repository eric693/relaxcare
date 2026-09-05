// 客訴、線上預約、通知紀錄、帳號權限、系統設定、稽核軌跡

App.page('issues', {
  title: '客訴與異常', module: 'issues', sub: '客訴、技師糾紛、設備故障、收費爭議',
  help: {
    intro: '客訴、技師糾紛、設備故障都記在這裡。輪序爭議也算 —— 處理時搭配「輪鐘檯」下方的軌跡就有證據。',
    steps: [
      '按「新增紀錄」，選類別與嚴重度，填事發經過。',
      '關聯到客人、技師與當時的鐘單，日後查得回來是哪一鐘出的事。',
      '處理完填「處理方式」與補償金額，狀態改成「已結案」。'
    ],
    notes: [
      '高嚴重度的案件建議當天就登記，記憶會隨時間變形，而客人不會。',
      '補償金額不會自動退款 —— 實際退錢請到儲值頁走退款流程，那邊才有金流紀錄。',
      '涉及力道造成不適的案件，記得回頭把客人的「力道偏好」改掉，下次才不會再犯。'
    ],
    terms: [['嚴重度', '高＝有身體不適或求償、一般＝客人有抱怨、低＝內部記錄備查。']]
  },
  async render(el) {
    const state = { status: '', category: '', q: '' };
    el.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'page-acts';
    if (App.canEdit('issues')) top.innerHTML = '<button class="btn" id="new">＋ 新增紀錄</button>';
    el.appendChild(top);
    const dialog = (i = {}) => UI.modal({
      title: i.id ? `編輯 ${i.issue_no}` : '新增客訴／異常', wide: true,
      body: `<div class="form-grid">
        ${UI.select('store_id', '門市', App.storeOptions('　'), { value: i.store_id || '' })}
        ${UI.input('happen_date', '發生日期', { type: 'date', value: i.happen_date || UI.today() })}
        ${UI.select('category', '類別', App.opt.lists.issue_categories || [], { value: i.category || '客訴', plain: true })}
        ${UI.select('severity', '嚴重度', twOpts(TW.severity), { value: i.severity || 'normal', plain: true })}
        ${UI.select('member_id', '客人', App.memberOptions('無'), { value: i.member_id || '', full: true })}
        ${UI.select('therapist_id', '技師', App.therapistOptions('無'), { value: i.therapist_id || '', full: true })}
        ${UI.input('title', '標題', { value: i.title || '', full: true, required: true })}
        ${UI.textarea('detail', '事發經過', { rows: 3, value: i.detail || '' })}
        ${UI.textarea('handling', '處理方式', { rows: 3, value: i.handling || '' })}
        ${UI.input('compensation', '補償金額', { type: 'number', value: i.compensation || 0 })}
        ${UI.select('status', '狀態', twOpts(TW.issue_status), { value: i.status || 'open', plain: true })}
        ${UI.input('owner', '負責人', { value: i.owner || App.me.name })}
      </div>`,
      async onSubmit(e) {
        const d = UI.formData(e);
        if (i.id) await PUT(`/issues/${i.id}`, d); else await POST('/issues', d);
        UI.toast('已儲存'); draw();
      }
    });
    if (App.canEdit('issues')) top.querySelector('#new').onclick = () => dialog();
    el.appendChild(App.filterBar([
      { name: 'status', label: '狀態', type: 'select', options: [['', '全部']].concat(twOpts(TW.issue_status)) },
      { name: 'category', label: '類別', type: 'select', options: App.listOptions('issue_categories', '全部') },
      { name: 'q', label: '搜尋', type: 'search', placeholder: '標題／內容' }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);
    async function draw() {
      const rows = await GET('/issues' + App.qs(state));
      body.innerHTML = UI.table(['編號', '日期', '類別', '嚴重度', '標題', '客人', '技師', '補償', '狀態', ''],
        rows.map(r => `<tr><td>${UI.esc(r.issue_no)}</td><td>${UI.esc(r.happen_date)}</td>
          <td>${UI.esc(r.category)}</td><td>${App.statusTag('severity', r.severity)}</td>
          <td>${UI.esc(r.title)}</td><td>${UI.esc(r.member_name || '—')}</td>
          <td>${UI.esc(r.therapist_name || '—')}</td>
          <td class="num">${r.compensation ? UI.fmtMoney(r.compensation) : '—'}</td>
          <td>${App.statusTag('issue_status', r.status)}</td>
          <td>${App.canEdit('issues') ? `<button class="btn tiny secondary" data-e="${r.id}">處理</button>` : ''}</td></tr>`),
        '沒有紀錄');
      body.querySelectorAll('[data-e]').forEach(b => b.onclick = () => dialog(rows.find(x => String(x.id) === b.dataset.e)));
    }
    draw();
  }
});

App.page('bookings', {
  title: '線上預約', module: 'bookings', sub: '官網送來的預約申請，確認後開成鐘單',
  help: {
    intro: '線上送來的只是「申請」，技師與床位排不排得下要門市看過才知道。',
    steps: ['聯繫客人確認時段後，按「開成鐘單」帶著資料去開單。', '無效或婉拒的按「婉拒」留下紀錄。'],
    notes: ['客人自己打的內容不能改（那是他當初送出什麼的憑據），內勤的聯繫過程寫在「內部備註」。']
  },
  async render(el) {
    const state = { status: '' };
    el.innerHTML = '';
    el.appendChild(App.filterBar([
      { name: 'status', label: '狀態', type: 'select', options: [['', '全部']].concat(twOpts(TW.booking_status)) }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);
    async function draw() {
      const rows = await GET('/bookings' + App.qs(state));
      body.innerHTML = UI.table(['單號', '送出時間', '姓名', '電話', '門市', '希望時段', '項目', '指定技師', '客人備註', '內部備註', '狀態', ''],
        rows.map(r => `<tr class="${r.status === 'new' ? 'row-warn' : ''}">
          <td>${UI.esc(r.booking_no)}</td><td>${UI.esc(r.created_at.slice(5, 16))}</td>
          <td>${UI.esc(r.name)}</td><td>${UI.esc(r.phone)}</td>
          <td>${UI.esc(r.store_name || '—')}</td>
          <td>${UI.esc(r.prefer_date)} ${UI.esc(r.prefer_time)}</td>
          <td>${UI.esc(r.service_name || '—')}</td><td>${UI.esc(r.therapist_name || '不指定')}</td>
          <td class="muted">${UI.esc(r.note)}</td><td class="muted">${UI.esc(r.staff_note)}</td>
          <td>${App.statusTag('booking_status', r.status)}</td>
          <td>${App.canEdit('bookings') ? `<button class="btn tiny secondary" data-e="${r.id}">處理</button>
            ${App.can('tickets') ? `<button class="btn tiny" data-c="${r.id}">開成鐘單</button>` : ''}` : ''}</td></tr>`),
        '沒有線上預約');
      body.querySelectorAll('[data-e]').forEach(b => b.onclick = () => {
        const r = rows.find(x => String(x.id) === b.dataset.e);
        UI.modal({
          title: `處理 ${r.booking_no}`,
          body: `<div class="form-grid">
            ${UI.select('status', '狀態', twOpts(TW.booking_status), { value: r.status, plain: true })}
            ${UI.select('therapist_id', '安排技師', App.therapistOptions('不指定'), { value: r.therapist_id || '', full: true })}
            ${UI.textarea('staff_note', '內部備註（聯繫過程）', { rows: 3, value: r.staff_note || '' })}
          </div><div class="muted">客人自己填的「${UI.esc(r.note || '（無）')}」不會被覆蓋。</div>`,
          async onSubmit(e) { await PUT(`/bookings/${r.id}`, UI.formData(e)); UI.toast('已更新'); draw(); }
        });
      });
      body.querySelectorAll('[data-c]').forEach(b => b.onclick = () => {
        const r = rows.find(x => String(x.id) === b.dataset.c);
        Tickets.create(draw);
        UI.toast(`請依 ${r.booking_no}：${r.name} ${r.phone} ${r.prefer_date} ${r.prefer_time} 填寫`);
      });
    }
    draw();
  }
});

App.page('notifications', {
  title: '通知紀錄', module: 'notifications', sub: 'LINE 預約提醒、回購推播與班表通知的送出紀錄',
  help: {
    intro: '未設定 LINE Token 時所有訊息都是「模擬」：內容照樣產生並留紀錄，但不會真的送出。示範與教育訓練不必先申請官方帳號。',
    steps: [
      '要真的發送：到「系統設定 → 營運」填入 LINE Channel Access Token。',
      '客人要收得到，還必須在客人檔案填他的 LINE UID；技師的班表通知同理。',
      '訊息從三個地方送出：鐘單的「預約通知」、輪鐘檯的「班表通知」、回購名單的「推播」。',
      '這一頁只是查紀錄，不能重送 —— 要重送請回原本的頁面再按一次。'
    ],
    notes: [
      '狀態「失敗」多半是對象沒有填 LINE UID，或 Token 過期，錯誤原因會顯示在狀態下方。',
      '通知紀錄預設保留 180 天，可在系統設定調整。'
    ],
    terms: [['LINE UID', '不是 LINE ID。要透過官方帳號的 webhook 取得，是一串 U 開頭的英數字。']]
  },
  async render(el) {
    const state = { status: '', target_type: '', date: '' };
    el.innerHTML = '';
    const en = await GET('/notifications/enabled');
    el.innerHTML = en.enabled
      ? '<div class="notice ok">✓ 已設定 LINE Token，訊息會實際送出。</div>'
      : '<div class="notice warn">⚠ 尚未設定 LINE Token（系統設定的 line_token），目前所有通知都是模擬模式。</div>';
    el.appendChild(App.filterBar([
      { name: 'status', label: '狀態', type: 'select', options: [['', '全部']].concat(twOpts(TW.notify_status)) },
      { name: 'target_type', label: '對象', type: 'select', options: [['', '全部'], ['member', '客人'], ['therapist', '技師']] },
      { name: 'date', label: '日期', type: 'date' }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);
    async function draw() {
      const rows = await GET('/notifications' + App.qs(state));
      body.innerHTML = UI.table(['時間', '對象', '姓名', '標題', '內容', '狀態'],
        rows.map(r => `<tr><td>${UI.esc(r.created_at.slice(5, 16))}</td>
          <td>${r.target_type === 'member' ? '客人' : '技師'}</td>
          <td>${UI.esc(r.target_name)}</td><td>${UI.esc(r.title)}</td>
          <td class="muted clip" title="${UI.esc(r.body)}">${UI.esc(r.body.replace(/\n/g, ' ／ ').slice(0, 60))}…</td>
          <td>${App.statusTag('notify_status', r.status)}${r.error ? `<div class="muted">${UI.esc(r.error)}</div>` : ''}</td></tr>`),
        '沒有通知紀錄');
    }
    draw();
  }
});

App.page('users', {
  title: '帳號權限', module: 'users', sub: '逐一勾選每個帳號可以看哪些模組，以及哪些只能看不能改',
  help: {
    intro: '「唯讀」是勾在已授權模組上的額外限制：看得到、匯得出報表，但新增修改刪除都會被擋。',
    steps: [
      '按「新增帳號」，填帳號密碼與姓名。',
      '在「可使用的模組」勾選這個人看得到哪些頁面 —— 沒勾的連側欄都不會出現。',
      '若某些模組只能看不能改，再到「其中只能看不能改的模組」勾一次（必須先在上面勾過）。',
      '多店經營時綁定門市，該員工預設只看自己店的資料。'
    ],
    notes: [
      '會計通常給「財務」全部，再加鐘單與預收的唯讀權限：看得到數字、改不了單據。',
      '櫃檯建議不要給「薪資結算」與「抽成與級距」—— 技師的薪水不該讓同事看到。',
      '不能停用最後一個啟用中的管理員帳號，否則沒有人進得去。',
      '停用帳號不會刪除他過去的操作紀錄，稽核軌跡仍查得到。'
    ],
    terms: [['唯讀', '該模組的所有新增／修改／刪除按鈕會變灰，後端也會再擋一次。']]
  },
  async render(el) {
    const [users, mods] = await Promise.all([GET('/users'), GET('/modules')]);
    el.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'page-acts';
    if (App.canEdit('users')) top.innerHTML = '<button class="btn" id="new">＋ 新增帳號</button>';
    el.appendChild(top);

    const permPicker = (name, value, label) => {
      const groups = mods.groups.map(g => {
        const items = mods.modules.filter(m => m.group === g);
        return `<div class="perm-group"><div class="perm-title">${UI.esc(g)}</div>
          ${items.map(m => `<label class="chk" title="${UI.esc(m.hint)}">
            <input type="checkbox" data-cl="${name}" value="${m.key}"${(value || []).includes(m.key) ? ' checked' : ''}> ${UI.esc(m.label)}</label>`).join('')}</div>`;
      }).join('');
      return `<div class="form-row full"><label>${UI.esc(label)}</label>
        <div class="perm-grid" data-cl-wrap="${name}">${groups}</div>
        <input type="hidden" name="${name}" value="${UI.esc((value || []).join(','))}"></div>`;
    };

    const dialog = (u = {}) => UI.modal({
      title: u.id ? `編輯 ${u.username}` : '新增帳號', wide: true,
      body: `<div class="form-grid">
        ${u.id ? '' : UI.input('username', '帳號', { required: true })}
        ${UI.input('name', '姓名', { value: u.name || '', required: true })}
        ${UI.input('title', '職稱', { value: u.title || '' })}
        ${UI.select('store_id', '所屬門市', App.storeOptions('　'), { value: u.store_id || '' })}
        ${UI.input('password', u.id ? '重設密碼（留空不改）' : '密碼', { type: 'password' })}
        ${App.me.role === 'admin' ? UI.select('role', '角色', [['staff', '員工'], ['admin', '管理員']], { value: u.role || 'staff', plain: true }) : ''}
      </div>
      ${permPicker('permissions', u.permissions, '可使用的模組')}
      ${permPicker('readonly_modules', u.readonly_modules, '其中「只能看不能改」的模組')}`,
      onOpen(e) { UI.bindCheckLists(e); },
      async onSubmit(e) {
        const d = UI.formData(e);
        if (u.id) await PUT(`/users/${u.id}`, d); else await POST('/users', d);
        UI.toast('已儲存'); App.reload();
      }
    });
    if (App.canEdit('users')) top.querySelector('#new').onclick = () => dialog();

    const body = document.createElement('div');
    el.appendChild(body);
    body.innerHTML = UI.table(['帳號', '姓名', '職稱', '角色', '門市', '模組數', '唯讀', '狀態', ''],
      users.map(u => `<tr class="${u.active ? '' : 'row-muted'}">
        <td>${UI.esc(u.username)}</td><td>${UI.esc(u.name)}</td><td>${UI.esc(u.title)}</td>
        <td>${u.role === 'admin' ? UI.tag('管理員', 'ok') : '員工'}</td>
        <td>${UI.esc(u.store_name || '全部')}</td>
        <td class="num">${u.role === 'admin' ? '全部' : u.permissions.length}</td>
        <td class="muted">${u.readonly_modules.length ? u.readonly_modules.length + ' 個' : '—'}</td>
        <td>${u.active ? UI.tag('啟用', 'ok') : UI.tag('停用', 'danger')}</td>
        <td>${App.canEdit('users') ? `<button class="btn tiny secondary" data-e="${u.id}">編輯</button>
          <button class="btn tiny ${u.active ? 'danger' : ''}" data-t="${u.id}" data-v="${u.active ? 0 : 1}">${u.active ? '停用' : '啟用'}</button>` : ''}</td></tr>`));
    body.querySelectorAll('[data-e]').forEach(b => b.onclick = () => dialog(users.find(x => String(x.id) === b.dataset.e)));
    body.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => {
      try { await PUT(`/users/${b.dataset.t}`, { active: Number(b.dataset.v) }); UI.toast('已更新'); App.reload(); }
      catch (e) { UI.err(e); }
    });
  }
});

App.page('settings', {
  title: '系統設定', module: 'settings', sub: '公司名稱、輪鐘規則、預收規則、下拉選項',
  help: {
    intro: '分成六個區塊：一般、輪鐘規則、抽成與指名費、預收規則、營運、法遵，最後是各種下拉選項。',
    steps: [
      '找到要改的區塊，直接修改欄位。',
      '按頁面最下方的「儲存全部設定」—— 是一次存全部，不是各區塊各存一次。',
      '改完下拉選項後請重新整理頁面，其他頁的選單才會跟著更新。'
    ],
    notes: [
      '「指名計入輪次」改成「是」會立刻改變輪鐘檯的排序，動之前先跟技師講清楚。',
      '「贈送金效期」改短不會追溯既有的儲值，只影響之後的新儲值。',
      '下拉選項每行一個。刪掉某個選項不會動到已經用了它的舊資料。',
      '級別預設抽成建議到「抽成與級距」頁改，那邊是表格比較好對；這裡的純文字格式是給進階使用者的。'
    ],
    terms: [
      ['下鐘後整理時間', '技師結帳後多久才重新回到輪序，用來換床單、喝水。設 0 就是立刻回到檯面。'],
      ['LINE Channel Access Token', '從 LINE Developers 後台取得。留空＝所有通知走模擬模式。']
    ]
  },
  async render(el) {
    const d = await GET('/settings');
    const s = d.settings;
    const editable = App.canEdit('settings');
    const group = (title, note, fields) => `<section class="set-group"><h3>${UI.esc(title)}</h3>
      ${note ? `<div class="muted">${note}</div>` : ''}<div class="form-grid">${fields}</div></section>`;
    const txt = (k, label, opts = {}) => UI.input(k, label, { value: s[k] || '', ...opts });
    const area = (k, label, rows = 4) => UI.textarea(k, label, { value: s[k] || '', rows });
    const bool = (k, label, text) => UI.select(k, label, [['1', '是'], ['0', '否']], { value: s[k] === '1' ? '1' : '0', plain: true });

    el.innerHTML = `
      ${group('一般', '', [
        txt('company_name', '公司／店名'), txt('ui_login_title', '登入頁標題'),
        txt('ui_login_sub', '登入頁副標'), area('ui_demo_hint', '登入頁提示文字', 3),
        txt('audit_retention_days', '稽核軌跡保留天數', { type: 'number' }),
        txt('notify_retention_days', '通知紀錄保留天數', { type: 'number' })
      ].join(''))}
      ${group('輪鐘規則', '這幾個數字直接決定輪鐘檯怎麼排。', [
        bool('rotation_designate_counts', '指名計入輪次'),
        txt('rotation_rest_min', '下鐘後整理時間（分鐘）', { type: 'number' }),
        txt('daily_minutes_max', '單人每日服務時數上限（分鐘）', { type: 'number' }),
        txt('continuous_tickets_max', '連續幾鐘未休息就警告', { type: 'number' })
      ].join(''))}
      ${group('抽成與指名費', '級別預設抽成請到「抽成與級距」頁調整。', [
        txt('designate_fee_charge', '向客人加收的指名費', { type: 'number' }),
        txt('prepaid_commission_pct', '儲值／次卡銷售抽成％', { type: 'number' }),
        area('level_rates', '級別預設（級別=輪鐘%|指名%|商品%|指名費）', 5)
      ].join(''))}
      ${group('預收規則', '', [
        txt('wallet_bonus_expire_months', '贈送金效期（月，0＝不到期）', { type: 'number' }),
        txt('pass_default_months', '次卡預設效期（月）', { type: 'number' }),
        txt('wallet_refund_fee_pct', '退款手續費％', { type: 'number' })
      ].join(''))}
      ${group('營運', '', [
        txt('vat_rate', '營業稅率％', { type: 'number' }),
        txt('slot_min', '看板時間格（分鐘）', { type: 'number' }),
        txt('repurchase_days', '幾天沒來列入回購名單', { type: 'number' }),
        txt('expiry_warn_days', '證照到期提前提醒天數', { type: 'number' }),
        txt('line_token', 'LINE Channel Access Token', { full: true }),
        bool('booking_enabled', '開放官網線上預約'),
        area('booking_notice', '線上預約說明文字', 2)
      ].join(''))}
      ${group('日結與交班', '「應有現金」就是照這幾個設定算出來的。', [
        txt('cash_open_float', '抽屜起始零用金', { type: 'number' }),
        txt('cash_diff_tolerance', '短溢容忍值（超過要填說明）', { type: 'number' }),
        area('closing_shifts', '班別（每行一個）', 3),
        area('cash_pay_methods', '算「進抽屜現金」的付款方式', 3),
        area('card_pay_methods', '刷卡／行動支付（不進抽屜）', 4)
      ].join(''))}
      ${group('收據', '', [
        bool('receipt_show_therapist', '收據顯示技師姓名'),
        area('receipt_footer', '收據頁尾文字', 3)
      ].join(''))}
      ${group('發票', '系統不代開電子發票，這裡是登錄實際開出去的號碼。', [
        bool('invoice_enabled', '啟用發票登錄'),
        txt('invoice_track', '字軌（例如 AB）'),
        txt('invoice_next_no', '下一個號碼（8 碼，留空＝每次手動輸入）')
      ].join(''))}
      ${group('班表', '格式：班別=開始|結束。不填時間的班別視為休假類，不計入人力。', [
        area('roster_shifts', '班別與預設時間', 6)
      ].join(''))}
      ${group('集點與介紹', '兌換一律換成儲值贈送金，不直接折鐘單（折鐘單會扣到技師的抽成）。', [
        bool('points_enabled', '啟用集點'),
        txt('points_per_amount', '消費多少元累 1 點', { type: 'number' }),
        txt('point_redeem_value', '1 點可換多少元贈送金', { type: 'number' }),
        txt('point_redeem_min', '每次最少兌換點數', { type: 'number' }),
        txt('referral_points', '介紹獎勵點數', { type: 'number' }),
        bool('points_service_only', '點數只計服務消費（不含商品與預收）')
      ].join(''))}
      ${group('同意書', '改了條文之後，既有的同意書仍然保留簽署當下的版本。', [
        txt('consent_valid_months', '同意書有效期（月）', { type: 'number' }),
        area('consent_text', '同意書條文', 8)
      ].join(''))}
      ${group('法遵：民俗調理業用語', '每行一個禁用詞；可寫成「療程（改稱「服務」）」附上建議替代。', [
        area('banned_terms', '禁用字詞', 8), area('compliance_note', '合規說明', 3)
      ].join(''))}
      ${group('下拉選項', '每行一個選項。改動後請重新整理頁面。',
        d.list_keys.map(k => area(k, k, 4)).join(''))}
      ${editable ? '<button class="btn" id="save">儲存全部設定</button>' : '<div class="notice warn">你對系統設定只有檢視權限。</div>'}`;

    if (editable) el.querySelector('#save').onclick = async () => {
      try { await PUT('/settings', UI.formData(el)); UI.toast('已儲存，重新整理後生效'); await App.refreshOptions(); }
      catch (e) { UI.err(e); }
    };
  }
});

App.page('audit', {
  title: '稽核軌跡', module: 'audit', sub: '誰在什麼時候做了什麼',
  help: {
    intro: '誰在什麼時候做了什麼。強制放行、人工調整輪序、退款、退卡、薪資確認、權限異動全部會留在這裡。',
    steps: [
      '有爭議時先用關鍵字搜尋（例如客人姓名、單號、「退款」「放行」）。',
      '再用日期範圍縮小到事發當天。',
      '輪序爭議請改看「輪鐘檯」下方的輪序軌跡，那邊記得更細（誰被跳過、原本第幾號）。'
    ],
    notes: [
      '稽核軌跡不能修改也不能刪除，這是它的意義。',
      '預設保留 730 天（兩年），可在系統設定調整。'
    ]
  },
  async render(el) {
    const state = { from: '', to: '', q: '' };
    el.innerHTML = '';
    el.appendChild(App.filterBar([
      { name: 'from', label: '起', type: 'date' },
      { name: 'to', label: '訖', type: 'date' },
      { name: 'q', label: '搜尋', type: 'search', placeholder: '動作／操作人' }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);
    async function draw() {
      const rows = await GET('/audit' + App.qs(state));
      body.innerHTML = UI.table(['時間', '操作人', '動作'],
        rows.map(r => `<tr><td>${UI.esc(r.created_at)}</td><td>${UI.esc(r.actor_name)}</td>
          <td>${UI.esc(r.action)}</td></tr>`), '沒有紀錄');
    }
    draw();
  }
});

App.page('backup', {
  title: '備份與檔案', module: 'backup', sub: '手動備份、下載、還原，以及上傳檔案的完整性檢查',
  help: {
    intro: '系統每天自動備份一次並保留 14 份。這一頁讓你在動大設定之前先備一份，或把備份下載到自己的電腦。',
    steps: [
      '改設定、匯入資料、月結之前，先按「立即備份」。',
      '備份完成後系統會立刻打開那個檔案確認讀得到 —— 一份開不起來的備份等於沒有備份。',
      '要帶走請按「下載」。還原需要管理員權限，而且要把檔名完整打一次。',
      '下方是所有上傳檔案（客人照片、同意書簽名、進貨單據）的完整性檢查結果。'
    ],
    notes: [
      '還原會覆蓋目前的資料庫，系統會自動重新啟動；還原之前會先把現況另存一份，還有退路。',
      '每日維護也會重新驗一次所有檔案的指紋，壞掉的會列在下面。',
      '「孤兒檔案」是存檔中途失敗留下的殘骸，沒有任何資料指向它們，可以安心忽略或請工程師清掉。'
    ],
    terms: [['SHA-256 指紋', '檔案內容的數學摘要。上傳當下算一次，日後重算比對，內容有任何改變都會對不上。']]
  },
  async render(el) {
    const body = document.createElement('div');
    el.innerHTML = '';
    el.appendChild(body);

    async function draw() {
      const d = await GET('/backups');
      const f = d.files;
      body.innerHTML = `
        <div class="toolbar">
          <button class="btn" id="bk-now">立即備份</button>
          <button class="btn secondary" id="bk-check">重新檢查檔案</button>
          <button class="btn secondary" id="bk-purge">清除無主檔案</button>
        </div>
        <div class="stat-grid">
          <div class="stat"><div class="stat-label">目前資料庫</div>
            <div class="stat-value">${(d.live_bytes / 1048576).toFixed(1)} MB</div><div class="stat-sub">${UI.esc(d.dir)}</div></div>
          <div class="stat"><div class="stat-label">備份份數</div>
            <div class="stat-value">${d.rows.length}</div><div class="stat-sub">每日自動備份，保留 14 份</div></div>
          <div class="stat ${f.ok ? 'ok' : 'warn'}"><div class="stat-label">上傳檔案</div>
            <div class="stat-value">${f.checked - f.bad.length} / ${f.checked}</div>
            <div class="stat-sub">${f.ok ? '全部通過指紋驗證' : `${f.bad.length} 個檔案有問題`}</div></div>
          ${d.orphans && d.orphans.length ? `<div class="stat warn"><div class="stat-label">無主檔案</div>
            <div class="stat-value">${d.orphans.length}</div>
            <div class="stat-sub">沒有任何資料指向它們</div></div>` : ''}
        </div>
        ${d.orphans && d.orphans.length ? `<div class="notice warn">有 ${d.orphans.length} 個檔案躺在磁碟上、
          卻沒有任何資料列指向它們（多半是重建示範資料留下的）。它們是客人的照片與簽名，
          留著就是留著個資，建議清掉。</div>` : ''}
        ${f.ok ? '' : `<div class="notice danger"><b>⛔ 有檔案損壞或遺失：</b><br>
          ${f.bad.map(b => `#${b.id} ${UI.esc(b.filename || '')}：${UI.esc(b.problem)}`).join('<br>')}
          <br>這些檔案要重新上傳。同意書簽名若在這份名單裡，請盡快請客人重簽。</div>`}
        <h3>備份檔案</h3>
        ${UI.table(['檔名', '大小', '建立時間', ''],
          d.rows.map(r => `<tr><td>${UI.esc(r.name)}</td>
            <td class="num">${(r.bytes / 1048576).toFixed(1)} MB</td>
            <td>${UI.esc(r.mtime)}</td>
            <td><a class="btn tiny secondary" href="/api/backups/${encodeURIComponent(r.name)}">下載</a>
              ${App.me.role === 'admin' ? `<button class="btn tiny danger" data-restore="${UI.esc(r.name)}">還原</button>` : ''}</td>
          </tr>`), '還沒有備份')}`;

      body.querySelector('#bk-now').onclick = async () => {
        UI.toast('備份中…');
        try {
          const r = await POST('/backups', {});
          UI.toast(`備份完成：${r.name}（${(r.bytes / 1048576).toFixed(1)}MB，已確認可開啟，${r.tickets} 張鐘單）`);
          draw();
        } catch (e) { UI.err(e); }
      };
      body.querySelector('#bk-check').onclick = async () => {
        const r = await GET('/files-check');
        UI.toast(r.ok ? `檢查了 ${r.checked} 個檔案，全部正常` : `${r.bad.length} 個檔案有問題`, !r.ok);
        draw();
      };
      body.querySelector('#bk-purge').onclick = async () => {
        const pre = await POST('/files-purge', {});
        if (!pre.files.length) return UI.toast('沒有無主檔案，不必清理');
        UI.modal({
          title: '清除無主檔案', submitText: '確認刪除',
          body: `<div class="notice danger">要刪掉 <b>${pre.files.length}</b> 個檔案。
              它們沒有任何資料列指向，但**檔案本身是刪不回來的** ——
              請先確認這不是資料庫剛還原、資料列還沒對上的暫時狀態。</div>
            <div class="muted" style="max-height:160px;overflow:auto">${pre.files.slice(0, 50).map(UI.esc).join('<br>')}</div>`,
          async onSubmit() {
            const r = await POST('/files-purge', { confirm: true });
            UI.toast(`已刪除 ${r.deleted} 個無主檔案`);
            draw();
          }
        });
      };
      body.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => {
        const name = b.dataset.restore;
        UI.modal({
          title: '還原資料庫', submitText: '確認還原',
          body: `<div class="notice danger"><b>這會覆蓋目前所有資料。</b>
              還原之前系統會先把現況另存一份，所以還有退路，但這段時間之後產生的資料都會回到備份當時的狀態。
              還原完成後系統會自動重新啟動，請稍候重新整理頁面。</div>
            <div class="notice">要還原的是：<b>${UI.esc(name)}</b></div>
            ${UI.input('confirm', '請完整輸入上面的檔名以確認', { full: true, placeholder: name })}`,
          async onSubmit(el2) {
            const r = await POST(`/backups/${encodeURIComponent(name)}/restore`, UI.formData(el2));
            UI.toast(r.note);
            setTimeout(() => location.reload(), 4000);
          }
        });
      });
    }
    draw();
  }
});
