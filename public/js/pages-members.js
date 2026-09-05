// 客人檔案、儲值金、次卡、回購名單

// 問診表單：開單與客人檔案都會用到，抽出來共用
const Health = {
  form(m = {}) {
    return `<div class="form-grid">
      ${UI.select('pressure_pref', '力道偏好', [''].concat(App.opt.lists.pressure_prefs || []), { value: m.pressure_pref || '', plain: true })}
      ${UI.checkList('avoid_parts', '禁忌部位', App.opt.lists.avoid_part_options || [], { value: m.avoid_parts || '' })}
      ${UI.checkList('conditions', '身體狀況', App.opt.lists.health_conditions || [], { value: m.conditions || '',
        hint: '勾選的項目若屬於某個服務的禁忌，開單時系統會擋下來。' })}
      ${UI.textarea('health_note', '其他說明', { rows: 2, value: m.health_note || '' })}
      ${UI.checkbox('consent', '客人已確認並同意以上內容', false, { full: true })}
    </div>
    <div class="notice">民俗調理業不做醫療行為。這份紀錄是為了避開不該碰的部位與狀況，也是換技師時的交接依據。</div>`;
  },
  edit(memberId, m, onDone) {
    UI.modal({
      title: '身體狀況問診', wide: true,
      body: Health.form(m),
      async onSubmit(el) { await PUT(`/members/${memberId}/health`, UI.formData(el)); UI.toast('已更新問診紀錄'); if (onDone) onDone(); }
    });
  }
};

const Members = {
  form(m = {}) {
    return `<div class="form-grid">
      ${UI.input('name', '姓名', { value: m.name || '', required: true })}
      ${UI.input('phone', '電話', { value: m.phone || '' })}
      ${UI.select('gender', '性別', ['', '女', '男'], { value: m.gender || '', plain: true })}
      ${UI.input('birthday', '生日', { type: 'date', value: m.birthday || '' })}
      ${UI.select('store_id', '主要門市', App.storeOptions('　'), { value: m.store_id || '' })}
      ${UI.select('source', '來源', [''].concat(App.opt.lists.member_sources || []), { value: m.source || '', plain: true })}
      ${UI.select('fav_therapist_id', '慣用指名技師', App.therapistOptions('無'), { value: m.fav_therapist_id || '', full: true })}
      ${UI.input('line_uid', 'LINE UID（推播用）', { value: m.line_uid || '', full: true })}
      ${UI.select('referrer_id', '介紹人（誰帶他來的）', App.memberOptions('無'), { value: m.referrer_id || '', full: true })}
      ${UI.checkList('tags', '標籤', App.opt.lists.member_tags || [], { value: m.tags || '' })}
      ${UI.textarea('note', '備註', { rows: 2, value: m.note || '' })}
      ${UI.checkbox('blacklist', '列入黑名單', m.blacklist)}
      ${UI.input('blacklist_reason', '黑名單原因', { value: m.blacklist_reason || '' })}
    </div>`;
  },

  async detail(id, onDone) {
    const d = await GET(`/members/${id}`);
    const m = d.member;
    const row = (k, v) => `<tr><th>${UI.esc(k)}</th><td>${v}</td></tr>`;
    const mo = UI.modal({
      title: `${m.name}　${m.member_no}`, wide: true, hideFooter: true, onClose: onDone,
      body: `
        <table class="kv">
          ${row('電話', UI.esc(m.phone || '—'))}
          ${row('儲值餘額', `<b>${UI.fmtMoney(d.wallet.total)}</b>（現金 ${UI.fmtMoney(d.wallet.cash)}／贈送 ${UI.fmtMoney(d.wallet.bonus)}${d.wallet.expiry_date ? `，贈送金 ${d.wallet.expiry_date} 到期` : ''}）`)}
          ${row('身體狀況', `${m.conditions ? `<b class="danger">${UI.esc(m.conditions)}</b>` : '無特殊狀況'}
            ${m.avoid_parts ? `　避開：${UI.esc(m.avoid_parts)}` : ''}
            ${m.pressure_pref ? `　力道：${UI.esc(m.pressure_pref)}` : ''}
            <div class="muted">問診更新：${UI.esc(m.health_updated_at || '未建立')}　同意書：${UI.esc(m.consent_at || '未簽')}</div>`)}
          ${row('點數', `<b>${UI.fmtNum(d.points.balance)}</b> 點（可換 ${UI.fmtMoney(d.points.balance * d.points.rules.point_redeem_value)} 贈送金）
            ${d.referrer ? `　介紹人：${UI.esc(d.referrer.name)}` : ''}
            ${d.referred.length ? `　已介紹 ${d.referred.length} 位` : ''}`)}
          ${row('同意書', d.consent.status === 'ok'
            ? `<span class="tag ok">${UI.esc(d.consent.label)}</span>`
            : `<span class="tag danger">${UI.esc(d.consent.label)}</span>`)}
          ${row('常做項目', d.fav_services.map(s => `${UI.esc(s.name)} ×${s.n}`).join('　') || '—')}
          ${row('常做技師', d.fav_therapists.map(s => `${UI.esc(s.name)} ×${s.n}${s.designated ? `（指名 ${s.designated}）` : ''}`).join('　') || '—')}
          ${m.blacklist ? row('黑名單', `<span class="danger">${UI.esc(m.blacklist_reason || '已列入')}</span>`) : ''}
        </table>
        <div class="modal-acts">
          ${App.canEdit('members') ? '<button class="btn secondary" data-a="edit">編輯資料</button>' : ''}
          ${App.canEdit('members') ? '<button class="btn" data-a="health">更新問診</button>' : ''}
          ${App.can('wallets') ? '<button class="btn secondary" data-a="topup">儲值</button>' : ''}
          ${App.can('passes') ? '<button class="btn secondary" data-a="pass">賣次卡</button>' : ''}
          ${App.canEdit('members') ? '<button class="btn secondary" data-a="consent">簽同意書</button>' : ''}
          ${App.canEdit('members') ? '<button class="btn secondary" data-a="photo">上傳照片</button>' : ''}
        </div>
        ${d.photos && d.photos.length ? `<h4>照片（${d.photos.length}）</h4>
          <div class="photo-grid">${d.photos.map(p => `<figure class="thumb">
            <img src="${UI.esc(p.url)}" alt="${UI.esc(p.filename)}">
            <figcaption>${UI.esc(p.created_at.slice(0, 16))}<br>${(p.bytes / 1024).toFixed(0)}KB
              <span class="tag ok">已驗證</span></figcaption>
            ${App.canEdit('members') ? `<button class="btn tiny danger" data-delphoto="${p.id}">刪除</button>` : ''}
          </figure>`).join('')}</div>` : ''}
        ${d.consents && d.consents.length ? `<h4>同意書紀錄</h4>
          ${UI.table(['簽署時間', '簽名人', '當時的健康狀況', '經手', ''],
            d.consents.map(c => `<tr><td>${UI.esc(c.signed_at)}</td><td>${UI.esc(c.signer_name)}</td>
              <td class="muted">${UI.esc(c.conditions || '無')}${c.avoid_parts ? `／避開 ${UI.esc(c.avoid_parts)}` : ''}</td>
              <td>${UI.esc(c.actor)}</td>
              <td><button class="btn tiny secondary" data-consent="${c.id}">檢視</button></td></tr>`))}` : ''}
        <h4>次卡（${d.passes.length}）</h4>
        ${UI.table(['卡號', '品名', '次數', '單次值', '到期', '狀態'],
          d.passes.map(p => `<tr><td>${UI.esc(p.pass_no)}</td><td>${UI.esc(p.name)}</td>
            <td class="num">${p.used_times}/${p.total_times}（剩 ${p.remain}）</td>
            <td class="num">${UI.fmtMoney(p.price_paid / (p.total_times || 1))}</td>
            <td>${UI.esc(p.expiry_date || '—')}</td>
            <td>${App.statusTag('pass_status', p.real_status)}</td></tr>`), '沒有次卡')}
        <h4>儲值流水</h4>
        ${UI.table(['時間', '類型', '現金', '贈送', '餘額', '說明'],
          d.wallet_txns.map(w => `<tr><td>${UI.esc(w.created_at.slice(5, 16))}</td>
            <td>${twLabel('wallet_kind', w.kind)}</td>
            <td class="num ${UI.moneyClass(w.cash_delta)}">${UI.fmtDelta(w.cash_delta)}</td>
            <td class="num ${UI.moneyClass(w.bonus_delta)}">${UI.fmtDelta(w.bonus_delta)}</td>
            <td class="num">${UI.fmtMoney(w.cash_after + w.bonus_after)}</td>
            <td>${UI.esc(w.note)}</td></tr>`), '沒有儲值紀錄')}
        <h4>消費紀錄（最近 100 筆）</h4>
        ${UI.table(['日期', '項目', '技師', '指派', '金額', '評價'],
          d.tickets.map(t => `<tr><td>${UI.esc((t.actual_start || t.start_at).slice(0, 16))}</td>
            <td>${UI.esc(t.service_name)}</td><td>${UI.esc(t.therapist_name || '—')}</td>
            <td>${App.statusTag('assign_type', t.assign_type)}</td>
            <td class="num">${UI.fmtMoney(t.net_amount)}</td>
            <td>${t.rating ? '★'.repeat(t.rating) : '—'}</td></tr>`), '還沒有消費紀錄')}`
    });
    mo.body.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      const again = () => { mo.close(); Members.detail(id, onDone); };
      if (a === 'edit') return Members.edit(m, again);
      if (a === 'health') return Health.edit(id, m, again);
      if (a === 'topup') return Wallets.topup(id, again);
      if (a === 'pass') return Passes.create(id, again);
      if (a === 'consent') return Consents.sign(m, again);
      if (a === 'photo') return Members.uploadPhoto(m, again);
    });
    mo.body.querySelectorAll('[data-consent]').forEach(b =>
      b.onclick = () => Consents.view(b.dataset.consent));
    mo.body.querySelectorAll('[data-delphoto]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('確定刪除這張照片？檔案會一併從磁碟移除。')) return;
      try { await DEL(`/members/${id}/photo/${b.dataset.delphoto}`); UI.toast('已刪除'); mo.close(); Members.detail(id, onDone); }
      catch (e) { UI.err(e); }
    });
  },

  create(onDone) {
    UI.modal({
      title: '新增客人', wide: true, body: Members.form(),
      async onSubmit(el) { await POST('/members', UI.formData(el)); UI.toast('已新增'); onDone(); }
    });
  },
  edit(m, onDone) {
    UI.modal({
      title: `編輯 ${m.name}`, wide: true, body: Members.form(m),
      async onSubmit(el) { await PUT(`/members/${m.id}`, UI.formData(el)); UI.toast('已更新'); onDone(); }
    });
  },

  // 客人照片。成功訊息一定要等後端回來 —— 後端存檔後會回讀比對指紋，
  // 驗不過會回錯誤，這裡就照實顯示失敗，不會出現「顯示成功、檔案卻是壞的」。
  uploadPhoto(m, onDone) {
    UI.modal({
      title: `上傳照片　${m.name}`, submitText: '上傳',
      body: `${UI.fileField('photo', '選擇照片')}
        <div class="notice">上傳後系統會把檔案寫入磁碟、再讀回來比對指紋，兩者一致才算成功。
          每日維護也會重新檢查一次，檔案壞掉會在「備份與檔案」頁報出來。</div>`,
      async onSubmit(el) {
        const input = el.querySelector('[data-file=photo]');
        const file = input.files[0];
        if (!file) throw new Error('請先選擇照片');
        const f = await UI.readFile(file);
        const r = await POST(`/members/${m.id}/photo`, { data: f.data, filename: f.name });
        UI.toast(`已上傳並驗證：${r.filename}（${(r.bytes / 1024).toFixed(0)}KB）`);
        onDone();
      }
    });
  }
};

// 健康告知同意書。民俗調理業被檢舉、或客人事後主張受傷時要拿得出來的東西。
const Consents = {
  async sign(m, onDone) {
    const d = await GET('/consents' + App.qs({ member_id: m.id }));
    UI.modal({
      title: `健康告知同意書　${m.name}`, wide: true, submitText: '確認簽署',
      body: `<div class="notice">${d.status.status === 'ok'
          ? `目前的同意書${UI.esc(d.status.label)}，重簽會留下新的一份，舊的仍然查得到。`
          : `這位客人<b>${UI.esc(d.status.label)}</b>，請當場請客人閱讀並簽名。`}</div>
        <div style="max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:10px;font-size:13px;line-height:1.9;white-space:pre-line;background:#fff">${UI.esc(d.text)}</div>
        <table class="kv" style="margin-top:10px">
          <tr><th>身體狀況</th><td>${UI.esc(m.conditions || '無特殊狀況')}</td></tr>
          <tr><th>禁忌部位</th><td>${UI.esc(m.avoid_parts || '無')}</td></tr>
          <tr><th>力道偏好</th><td>${UI.esc(m.pressure_pref || '未填')}</td></tr>
        </table>
        <div class="muted" style="margin:6px 0">簽署時會把上面這三項一起存成快照 ——
          日後客人改了問診資料，這張同意書仍然是簽署當天的內容。</div>
        ${UI.input('signer_name', '簽名人（本人或代簽者）', { value: m.name, full: true })}
        ${UI.signaturePad('sig')}`,
      async onSubmit(el) {
        const sig = UI.signatureData(el, 'sig');
        if (!sig) throw new Error('請先請客人簽名');
        const f = UI.formData(el);
        await POST('/consents', { member_id: m.id, signature: sig, signer_name: f.signer_name });
        UI.toast('同意書已簽署並存檔（簽名檔已通過完整性驗證）');
        onDone();
      }
    });
  },
  async view(id) {
    const c = await GET('/consents/' + id);
    UI.modal({
      title: `同意書　${c.member_name}`, wide: true, hideFooter: true,
      body: `<table class="kv">
          <tr><th>簽署時間</th><td>${UI.esc(c.signed_at)}</td></tr>
          <tr><th>簽名人</th><td>${UI.esc(c.signer_name)}</td></tr>
          <tr><th>門市／經手</th><td>${UI.esc(c.store_name || '—')}　${UI.esc(c.actor)}</td></tr>
          <tr><th>當時身體狀況</th><td>${UI.esc(c.conditions || '無')}</td></tr>
          <tr><th>當時禁忌部位</th><td>${UI.esc(c.avoid_parts || '無')}</td></tr>
        </table>
        <div style="max-height:200px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:10px;font-size:13px;line-height:1.9;white-space:pre-line;background:#fff;margin:10px 0">${UI.esc(c.consent_text)}</div>
        <div><b>簽名</b></div>
        ${c.signature ? `<img src="${UI.esc(c.signature)}" alt="簽名" style="max-width:100%;border:1px solid var(--border);border-radius:8px;background:#fff">`
          : '<div class="notice danger">找不到簽名檔</div>'}`
    });
  }
};

App.page('members', {
  title: '客人檔案', module: 'members', sub: '基本資料、力道偏好、禁忌部位與消費歷程',
  help: {
    intro: '這裡的「身體狀況」不是病歷，是為了避開不該碰的部位 —— 也是換技師接手時最實用的交接資料。',
    steps: ['新客人建檔後按「更新問診」，勾選身體狀況與禁忌部位。',
      '勾選的狀況若屬於某個服務項目的禁忌，開單時會被系統擋下來。',
      '點任一列可看儲值、次卡與完整消費紀錄。'],
    notes: ['問診紀錄超過半年未更新，開單時會提醒重新確認。',
      '電話重複會被擋下來，避免同一個人被建兩次。']
  },
  async render(el) {
    const state = { q: '', store_id: '', blacklist: '' };
    el.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'page-acts';
    if (App.canEdit('members')) top.innerHTML = '<button class="btn" id="new-m">＋ 新增客人</button>';
    top.appendChild(App.exportBtn('members', {}));
    el.appendChild(top);
    if (App.canEdit('members')) top.querySelector('#new-m').onclick = () => Members.create(draw);

    el.appendChild(App.filterBar([
      { name: 'q', label: '搜尋', type: 'search', placeholder: '姓名／電話／客編' },
      { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市') },
      { name: 'blacklist', label: '黑名單', type: 'select', options: [['', '不篩選'], ['1', '只看黑名單']] }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const rows = await GET('/members' + App.qs(state));
      body.innerHTML = UI.table(
        ['客編', '姓名', '電話', '身體狀況', '儲值', '次卡', '到店', '累計消費', '最後到店'],
        rows.map(r => `<tr data-id="${r.id}" class="clickable${r.blacklist ? ' row-danger' : ''}">
          <td>${UI.esc(r.member_no)}</td>
          <td>${UI.esc(r.name)}${r.tags ? ` <span class="muted">${UI.esc(r.tags)}</span>` : ''}</td>
          <td>${UI.esc(r.phone)}</td>
          <td>${r.conditions ? `<span class="danger">${UI.esc(r.conditions)}</span>` : '—'}
            ${r.avoid_parts ? `<div class="muted">避開 ${UI.esc(r.avoid_parts)}</div>` : ''}</td>
          <td class="num">${UI.fmtMoney(r.wallet_cash + r.wallet_bonus)}</td>
          <td class="num">${r.pass_count || '—'}</td>
          <td class="num">${r.visits}</td>
          <td class="num">${UI.fmtMoney(r.total_spent)}</td>
          <td>${UI.esc((r.last_visit || '').slice(0, 10) || '—')}</td></tr>`),
        '找不到客人');
      body.querySelectorAll('[data-id]').forEach(tr => tr.onclick = () => Members.detail(Number(tr.dataset.id), draw));
    }
    draw();
  }
});

// ---------- 儲值金 ----------
const Wallets = {
  topup(memberId, onDone) {
    UI.modal({
      title: '儲值', wide: true,
      body: `<div class="form-grid">
        ${memberId ? '' : UI.select('member_id', '客人', App.memberOptions('　'), { full: true })}
        ${UI.input('amount', '客人實付金額', { type: 'number', required: true })}
        ${UI.input('bonus', '額外贈送金額', { type: 'number', value: 0 })}
        ${UI.select('pay_method', '收款方式', App.listOptions('pay_methods'), { value: '現金', plain: true })}
        ${UI.select('therapist_id', '銷售技師（抽成用）', App.therapistOptions('無'), { value: '', full: true })}
        ${UI.select('store_id', '門市', App.storeOptions('　'), { value: App.me.store_id || '' })}
        ${UI.textarea('note', '備註', { rows: 2 })}
      </div>
      <div class="notice">現金與贈送金會分開記帳：贈送金會過期、不可轉讓、退款時一律作廢。扣款時一律先扣贈送金。</div>`,
      async onSubmit(el) {
        const d = UI.formData(el);
        await POST('/wallets/topup', { ...d, member_id: memberId || d.member_id });
        UI.toast('已儲值'); onDone();
      }
    });
  },
  async refund(memberId, onDone) {
    const q = await GET(`/wallets/${memberId}/refund-quote`);
    UI.modal({
      title: '儲值退款', wide: true, submitText: '確定退款',
      body: `<table class="kv">
        <tr><th>目前餘額</th><td>現金 ${UI.fmtMoney(q.balance.cash)}／贈送 ${UI.fmtMoney(q.balance.bonus)}</td></tr>
        <tr><th>可退現金</th><td><b>${UI.fmtMoney(q.refundable_cash)}</b></td></tr>
        <tr><th>手續費</th><td>${q.fee_pct}%　${UI.fmtMoney(q.fee)}</td></tr>
        <tr><th>預計退還</th><td><b>${UI.fmtMoney(q.payout)}</b></td></tr>
      </table>
      <div class="form-grid">
        ${UI.input('amount', '退款金額（留空＝全退）', { type: 'number' })}
        ${UI.textarea('note', '退款原因（必填）', { rows: 2 })}
      </div>
      <div class="notice warn">${UI.esc(q.note)}</div>`,
      async onSubmit(el) {
        const d = UI.formData(el);
        if (!d.note) { UI.toast('請填寫退款原因', true); return false; }
        const r = await POST('/wallets/refund', { member_id: memberId, ...d });
        UI.toast(`已退還 ${UI.fmtMoney(r.refunded)}`); onDone();
      }
    });
  },
  transfer(fromId, onDone) {
    UI.modal({
      title: '儲值轉讓',
      body: `<div class="form-grid">
        ${UI.select('to_id', '轉給誰', App.memberOptions('　'), { full: true })}
        ${UI.input('amount', '轉讓金額', { type: 'number' })}
        ${UI.textarea('note', '備註', { rows: 2 })}
      </div><div class="notice warn">只有現金部位可以轉讓，贈送金不可轉（否則會變成套利）。</div>`,
      async onSubmit(el) {
        await POST('/wallets/transfer', { from_id: fromId, ...UI.formData(el) });
        UI.toast('已轉讓'); onDone();
      }
    });
  }
};

App.page('wallets', {
  title: '儲值金', module: 'wallets', sub: '現金與贈送分開記帳，退款只退現金',
  help: {
    intro: '儲值是預收款，不是收入。系統把「客人實付的現金」與「店裡送的贈送金」分成兩個部位管理。',
    steps: ['按「儲值」輸入實付金額與贈送金額；贈送金會自動設定效期。',
      '客人消費時扣款一律先扣贈送金（會過期的先用掉）。',
      '退款只退未使用的現金，全額退款時剩餘贈送金一併作廢。'],
    notes: ['贈送金效期會在每次新儲值時重新起算，這是業界常見做法，可在系統設定調整。'],
    terms: [['現金餘額', '客人真的付過的錢，可退可轉。'],
      ['贈送餘額', '店裡送的，不可退不可轉，會過期。']]
  },
  async render(el) {
    const state = { q: '' };
    el.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'page-acts';
    if (App.canEdit('wallets')) top.innerHTML = '<button class="btn" id="new-w">＋ 儲值</button>';
    top.appendChild(App.exportBtn('wallet_txns', {}));
    el.appendChild(top);
    if (App.canEdit('wallets')) top.querySelector('#new-w').onclick = () => Wallets.topup(null, draw);
    el.appendChild(App.filterBar([{ name: 'q', label: '搜尋', type: 'search', placeholder: '姓名／電話' }],
      v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const rows = await GET('/wallets' + App.qs(state));
      const sum = rows.reduce((a, r) => ({ c: a.c + r.cash_balance, b: a.b + r.bonus_balance }), { c: 0, b: 0 });
      body.innerHTML = `<div class="notice">共 ${rows.length} 個帳戶，現金餘額 <b>${UI.fmtMoney(sum.c)}</b>（這是預收負債），贈送餘額 ${UI.fmtMoney(sum.b)}。</div>`
        + UI.table(['客人', '電話', '現金', '贈送', '合計', '贈送到期', '最後異動', ''],
          rows.map(r => `<tr class="${r.bonus_expired ? 'row-warn' : ''}">
            <td class="clickable" data-m="${r.member_id}">${UI.esc(r.name)}</td>
            <td>${UI.esc(r.phone)}</td>
            <td class="num">${UI.fmtMoney(r.cash_balance)}</td>
            <td class="num">${UI.fmtMoney(r.bonus_balance)}</td>
            <td class="num"><b>${UI.fmtMoney(r.total)}</b></td>
            <td>${UI.esc(r.expiry_date || '—')}</td>
            <td>${UI.esc((r.last_txn || '').slice(0, 16))}</td>
            <td>${App.canEdit('wallets') ? `<button class="btn tiny secondary" data-t="${r.member_id}">儲值</button>
              <button class="btn tiny secondary" data-tr="${r.member_id}">轉讓</button>
              <button class="btn tiny danger" data-r="${r.member_id}">退款</button>` : ''}</td></tr>`),
          '沒有儲值帳戶');
      body.querySelectorAll('[data-m]').forEach(x => x.onclick = () => Members.detail(Number(x.dataset.m), draw));
      body.querySelectorAll('[data-t]').forEach(x => x.onclick = () => Wallets.topup(Number(x.dataset.t), draw));
      body.querySelectorAll('[data-tr]').forEach(x => x.onclick = () => Wallets.transfer(Number(x.dataset.tr), draw));
      body.querySelectorAll('[data-r]').forEach(x => x.onclick = () => Wallets.refund(Number(x.dataset.r), draw));
    }
    draw();
  }
});

// ---------- 次卡 ----------
const Passes = {
  create(memberId, onDone) {
    UI.modal({
      title: '販售次卡／套券', wide: true,
      body: `<div class="form-grid">
        ${memberId ? '' : UI.select('member_id', '客人', App.memberOptions('　'), { full: true })}
        ${UI.select('service_id', '綁定服務（留空＝不限項目）', App.serviceOptions('不綁定'), { full: true })}
        ${UI.input('name', '卡片名稱（留空自動命名）', { full: true })}
        ${UI.input('total_times', '總次數', { type: 'number', value: 10 })}
        ${UI.input('price_paid', '客人實付金額', { type: 'number' })}
        ${UI.input('list_value', '原價總值（留空＝項目定價×次數）', { type: 'number' })}
        ${UI.input('expiry_date', '到期日（留空用預設效期）', { type: 'date' })}
        ${UI.select('sold_by', '銷售技師', App.therapistOptions('無'), { value: '', full: true })}
        ${UI.select('store_id', '門市', App.storeOptions('　'), { value: App.me.store_id || '' })}
        ${UI.checkbox('transferable', '可轉讓', true)}
        ${UI.textarea('note', '備註', { rows: 2 })}
      </div>
      <div class="notice">單次價值以「實付 ÷ 總次數」計算，不是原價 —— 用原價攤會讓卡在用完前就把負債沖光。</div>`,
      async onSubmit(el) {
        const d = UI.formData(el);
        await POST('/passes', { ...d, member_id: memberId || d.member_id });
        UI.toast('已售出'); onDone();
      }
    });
  },
  async detail(id, onDone) {
    const d = await GET(`/passes/${id}`);
    const p = d.pass, q = d.refund_quote;
    const mo = UI.modal({
      title: `${p.pass_no}　${p.name}`, wide: true, hideFooter: true, onClose: onDone,
      body: `<table class="kv">
        <tr><th>次數</th><td>已用 ${p.used_times} / 共 ${p.total_times}（剩 <b>${p.remain}</b>）</td></tr>
        <tr><th>金額</th><td>實付 ${UI.fmtMoney(p.price_paid)}　原價值 ${UI.fmtMoney(p.list_value)}　單次值 <b>${UI.fmtMoney(p.unit_value)}</b></td></tr>
        <tr><th>期限</th><td>${UI.esc(p.buy_date)} ~ ${UI.esc(p.expiry_date || '不限')}　${App.statusTag('pass_status', p.real_status)}</td></tr>
        <tr><th>退卡試算</th><td>按實付單價退未使用次數 <b>${UI.fmtMoney(q.by_unit)}</b>；已使用次數按原價扣回則為 ${UI.fmtMoney(q.by_list)}</td></tr>
      </table>
      <div class="modal-acts">
        ${App.canEdit('passes') ? '<button class="btn secondary" data-a="extend">展延</button>' : ''}
        ${App.canEdit('passes') ? '<button class="btn secondary" data-a="transfer">轉讓</button>' : ''}
        ${App.canEdit('passes') ? '<button class="btn danger" data-a="refund">退卡</button>' : ''}
      </div>
      <h4>使用紀錄</h4>
      ${UI.table(['時間', '類型', '次數', '金額', '鐘單', '說明'],
        d.txns.map(x => `<tr><td>${UI.esc(x.created_at.slice(5, 16))}</td>
          <td>${twLabel('pass_kind', x.kind)}</td>
          <td class="num">${x.times ? UI.fmtDelta(x.times) : '—'}</td>
          <td class="num">${UI.fmtMoney(x.amount)}</td>
          <td>${UI.esc(x.ticket_no || '')}</td>
          <td>${UI.esc(x.note)}</td></tr>`))}`
    });
    mo.body.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const again = () => { mo.close(); Passes.detail(id, onDone); };
      const a = b.dataset.a;
      if (a === 'extend') return UI.modal({
        title: '展延到期日',
        body: `<div class="form-grid">${UI.input('months', '展延月數', { type: 'number', value: 3 })}
          ${UI.input('expiry_date', '或直接指定新到期日', { type: 'date' })}
          ${UI.textarea('note', '原因', { rows: 2 })}</div>`,
        async onSubmit(el) { await POST(`/passes/${id}/extend`, UI.formData(el)); UI.toast('已展延'); again(); }
      });
      if (a === 'transfer') return UI.modal({
        title: '轉讓次卡',
        body: `<div class="form-grid">${UI.select('to_member_id', '轉給誰', App.memberOptions('　'), { full: true })}
          ${UI.textarea('note', '備註', { rows: 2 })}</div>`,
        async onSubmit(el) { await POST(`/passes/${id}/transfer`, UI.formData(el)); UI.toast('已轉讓'); again(); }
      });
      if (a === 'refund') return UI.modal({
        title: '退卡', submitText: '確定退卡',
        body: `<div class="form-grid">
          ${UI.select('mode', '計算方式', twOpts(TW.refund_mode), { value: 'unit', full: true, plain: true })}
          ${UI.textarea('note', '退卡原因（必填）', { rows: 2 })}</div>
          <div class="notice warn">按實付單價：退 ${UI.fmtMoney(q.by_unit)}；已使用按原價扣回：退 ${UI.fmtMoney(q.by_list)}。
            後者對店家有利，因為買卡的折扣是建立在買整套的前提上。</div>`,
        async onSubmit(el) {
          const dd = UI.formData(el);
          if (!dd.note) { UI.toast('請填寫原因', true); return false; }
          const r = await POST(`/passes/${id}/refund`, dd);
          UI.toast(`已退還 ${UI.fmtMoney(r.payout)}`); mo.close(); if (onDone) onDone();
        }
      });
    });
  }
};

App.page('passes', {
  title: '次卡與套券', module: 'passes', sub: '購買、核銷、展延、轉讓、退卡',
  help: {
    intro: '次卡跟儲值一樣是預收負債。核銷時認列的價值是「實付 ÷ 總次數」，不是原價。',
    steps: ['按「販售次卡」開卡，可綁定特定服務項目。',
      '核銷在鐘單結帳時進行（付款順序：次卡 → 儲值 → 現金）。',
      '退卡有兩種算法，畫面上會同時試算兩個金額讓你選。'],
    notes: ['綁定服務的卡只能用在該項目上，開單時系統會擋。',
      '過期的卡不能核銷，要先展延。']
  },
  async render(el) {
    const state = { q: '', status: '' };
    el.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'page-acts';
    if (App.canEdit('passes')) top.innerHTML = '<button class="btn" id="new-p">＋ 販售次卡</button>';
    top.appendChild(App.exportBtn('passes', {}));
    el.appendChild(top);
    if (App.canEdit('passes')) top.querySelector('#new-p').onclick = () => Passes.create(null, draw);
    el.appendChild(App.filterBar([
      { name: 'q', label: '搜尋', type: 'search', placeholder: '卡號／客人' },
      { name: 'status', label: '狀態', type: 'select', options: [['', '全部']].concat(twOpts(TW.pass_status)) }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const rows = await GET('/passes' + App.qs(state));
      const act = rows.filter(r => r.real_status === 'active');
      const liab = act.reduce((s, r) => s + r.unit_value * r.remain, 0);
      body.innerHTML = `<div class="notice">使用中 ${act.length} 張，未使用次數合計 ${act.reduce((s, r) => s + r.remain, 0)} 次，
        對應預收負債 <b>${UI.fmtMoney(liab)}</b>。</div>`
        + UI.table(['卡號', '客人', '品名', '次數', '實付', '單次值', '到期', '狀態'],
          rows.map(r => `<tr data-id="${r.id}" class="clickable${r.days_left !== null && r.days_left <= 30 && r.real_status === 'active' ? ' row-warn' : ''}">
            <td>${UI.esc(r.pass_no)}</td><td>${UI.esc(r.member_name || '')}</td>
            <td>${UI.esc(r.name)}</td>
            <td class="num">${r.used_times}/${r.total_times}</td>
            <td class="num">${UI.fmtMoney(r.price_paid)}</td>
            <td class="num">${UI.fmtMoney(r.unit_value)}</td>
            <td>${UI.esc(r.expiry_date || '—')}${r.days_left !== null && r.days_left >= 0 && r.days_left <= 30 ? `<span class="muted"> 剩 ${r.days_left} 天</span>` : ''}</td>
            <td>${App.statusTag('pass_status', r.real_status)}</td></tr>`),
          '沒有次卡');
      body.querySelectorAll('[data-id]').forEach(tr => tr.onclick = () => Passes.detail(Number(tr.dataset.id), draw));
    }
    draw();
  }
});

// ---------- 回購名單 ----------
App.page('repurchase', {
  title: '回購與名單', module: 'repurchase', sub: '久未回店的客人，依累計消費排序',
  help: {
    intro: '按「多久沒來」把客人撈出來，勾選後可以一次推播 LINE 問候。',
    steps: ['調整「幾天沒來」的門檻，預設 30 天。', '勾選要聯繫的客人，按「推播」。'],
    notes: ['推播文案刻意不提任何療效字眼 —— 這是最容易被截圖檢舉的地方。',
      '有儲值餘額或未用完次卡的客人會標出來，那是最該請回來的一群。']
  },
  async render(el) {
    const state = { days: '30', therapist_id: '' };
    el.innerHTML = '';
    el.appendChild(App.filterBar([
      { name: 'days', label: '幾天沒來', type: 'number', value: '30' },
      { name: 'therapist_id', label: '最後服務技師', type: 'select', options: App.therapistOptions('全部') }
    ], v => { Object.assign(state, v); draw(); }));
    const top = document.createElement('div');
    top.className = 'page-acts';
    top.innerHTML = App.canEdit('repurchase')
      ? '<button class="btn" id="send">推播選取的客人</button><button class="btn secondary" id="all">全選／全不選</button>' : '';
    el.appendChild(top);
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const rows = await GET('/repurchase' + App.qs(state));
      body.innerHTML = UI.table(
        ['', '客人', '電話', '未到天數', '到店次數', '客單價', '累計消費', '儲值', '次卡', '最後技師'],
        rows.map(r => `<tr class="${r.wallet_balance > 0 || r.pass_count > 0 ? 'row-warn' : ''}">
          <td><input type="checkbox" data-pick="${r.id}"></td>
          <td class="clickable" data-m="${r.id}">${UI.esc(r.name)}</td>
          <td>${UI.esc(r.phone)}</td>
          <td class="num">${r.days_since}</td>
          <td class="num">${r.visits}</td>
          <td class="num">${UI.fmtMoney(r.avg_spent)}</td>
          <td class="num">${UI.fmtMoney(r.total_spent)}</td>
          <td class="num">${r.wallet_balance ? UI.fmtMoney(r.wallet_balance) : '—'}</td>
          <td class="num">${r.pass_count || '—'}</td>
          <td>${UI.esc(r.last_therapist || '—')}</td></tr>`),
        '沒有符合條件的客人');
      body.querySelectorAll('[data-m]').forEach(x => x.onclick = () => Members.detail(Number(x.dataset.m), draw));
    }
    if (App.canEdit('repurchase')) {
      top.querySelector('#all').onclick = () => {
        const boxes = [...body.querySelectorAll('[data-pick]')];
        const on = !boxes.every(b => b.checked);
        boxes.forEach(b => { b.checked = on; });
      };
      top.querySelector('#send').onclick = async () => {
        const ids = [...body.querySelectorAll('[data-pick]:checked')].map(b => Number(b.dataset.pick));
        if (!ids.length) return UI.toast('請先勾選客人', true);
        if (!await UI.confirm(`確定推播給 ${ids.length} 位客人？`)) return;
        try {
          const r = await POST('/repurchase/notify', { member_ids: ids });
          UI.toast(`已處理 ${r.sent.length} 位（未設定 LINE Token 時只寫入通知紀錄）`);
        } catch (e) { UI.err(e); }
      };
    }
    draw();
  }
});
