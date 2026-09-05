// 鐘單：開單、上鐘、加項、結帳、取消。Tickets 物件另外給看板等頁面呼叫。

const Tickets = {
  // 閘門結果的統一呈現。開單、上鐘、改單看到的是同一個樣子。
  checkHtml(check) {
    if (!check || !check.issues) return '';
    if (!check.issues.length) return '<div class="notice ok">✓ 沒有發現問題</div>';
    return check.issues.map(i => {
      const hard = i.level === 'conflict';
      return `<div class="notice ${hard ? 'danger' : 'warn'}"><b>${hard ? '⛔ 衝突' : '⚠ 提醒'}</b>　${UI.esc(i.message)}</div>`;
    }).join('');
  },

  // 開單／改單表單。ticket 給值就是編輯。
  form(ticket = {}) {
    const t = ticket;
    return `<div class="form-grid">
      ${UI.select('store_id', '門市', App.storeOptions('　'), { value: t.store_id || (App.me.store_id || '') })}
      ${UI.select('source', '來源', App.listOptions('ticket_sources'), { value: t.source || '現場', plain: true })}
      ${UI.select('member_id', '客人', App.memberOptions(), { value: t.member_id || '', full: true })}
      ${UI.input('guest_name', '非會員姓名', { value: t.guest_name || '', placeholder: '選了會員就不必填' })}
      ${UI.input('guest_phone', '非會員電話', { value: t.guest_phone || '' })}
      ${UI.select('service_id', '服務項目', App.serviceOptions(), { value: t.service_id || '', full: true })}
      ${UI.select('assign_type', '指派方式', twOpts(TW.assign_type), { value: t.assign_type || 'rotation', plain: true })}
      ${UI.select('therapist_id', '技師', App.therapistOptions(), { value: t.therapist_id || '', full: true })}
      ${UI.select('room_id', '床位／包廂', App.roomOptions(), { value: t.room_id || '', full: true })}
      ${UI.input('start_at', '開始時間', { type: 'datetime-local', value: UI.toLocalInput(t.start_at || `${UI.today()} ${new Date().getHours()}:00`) })}
      ${UI.input('minutes', '時長（分鐘，留空用項目預設）', { type: 'number', value: t.minutes || '' })}
      ${UI.input('discount', '折扣金額', { type: 'number', value: t.discount || 0 })}
      ${UI.textarea('note', '備註', { rows: 2, value: t.note || '' })}
    </div>
    <div id="tk-check"></div>`;
  },

  // 表單一改就重新跑閘門：現場開單的人不會自己去按「檢查」。
  bindCheck(el, extra = {}) {
    const run = async () => {
      const d = UI.formData(el);
      const box = el.querySelector('#tk-check');
      if (!d.service_id) { box.innerHTML = ''; return; }
      try {
        const c = await POST('/tickets/check', { ...d, ...extra, start_at: (d.start_at || '').replace('T', ' ') });
        box.innerHTML = Tickets.checkHtml(c);
      } catch (e) { box.innerHTML = `<div class="notice danger">${UI.esc(e.message)}</div>`; }
    };
    el.addEventListener('change', run);
    run();
    return run;
  },

  async create(onDone) {
    UI.modal({
      title: '新增鐘單', wide: true, submitText: '開單',
      body: Tickets.form() + `
        <div class="form-row full"><label class="chk"><input type="checkbox" name="start_now" checked> 立刻上鐘（現場客人）</label></div>
        <div class="form-row full" id="tk-gate" hidden>
          ${UI.textarea('gate_note', '有硬衝突，請填寫放行理由', { rows: 2 })}
        </div>`,
      onOpen(el) {
        Tickets.bindCheck(el);
        // 有硬衝突才把「放行理由」欄位露出來，沒衝突時不要拿它嚇人
        const obs = new MutationObserver(() => {
          el.querySelector('#tk-gate').hidden = !el.querySelector('#tk-check .notice.danger');
        });
        obs.observe(el.querySelector('#tk-check'), { childList: true, subtree: true });
      },
      async onSubmit(el) {
        const d = UI.formData(el);
        d.start_at = (d.start_at || '').replace('T', ' ');
        const r = await POST('/tickets', d);
        UI.toast(`已開立 ${r.ticket.ticket_no}`);
        if (onDone) onDone();
        Tickets.detail(r.ticket.id, onDone);
      }
    });
  },

  async detail(id, onDone) {
    const t = await GET(`/tickets/${id}`);
    const canEdit = App.canEdit('tickets') && t.status !== 'done' && t.status !== 'cancelled';
    const row = (k, v) => `<tr><th>${UI.esc(k)}</th><td>${v}</td></tr>`;
    const health = [
      t.pressure_pref ? `力道 ${UI.esc(t.pressure_pref)}` : '',
      t.avoid_parts ? `避開 ${UI.esc(t.avoid_parts)}` : '',
      t.conditions ? `<b class="danger">狀況 ${UI.esc(t.conditions)}</b>` : ''
    ].filter(Boolean).join('　');

    const m = UI.modal({
      title: `${t.ticket_no}　${twLabel('ticket_status', t.status)}`, wide: true, hideFooter: true,
      body: `
        <table class="kv">
          ${row('客人', `${UI.esc(t.member_name || t.guest_name || '—')}${t.member_phone ? `　${UI.esc(t.member_phone)}` : ''}`)}
          ${health ? row('身體狀況', health) : ''}
          ${row('技師', `${UI.esc(t.therapist_name || '未指派')}　${App.statusTag('assign_type', t.assign_type)}`)}
          ${row('項目', `${UI.esc(t.service_name)}　${t.minutes} 分鐘`)}
          ${row('時間', `${UI.esc(t.start_at)} ~ ${UI.hhmm(t.end_at)}${t.actual_start ? `（實際 ${UI.hhmm(t.actual_start)}~${UI.hhmm(t.actual_end) || '進行中'}）` : ''}`)}
          ${row('床位', UI.esc(t.room_name || '—'))}
          ${row('金額', `服務 ${UI.fmtMoney(t.amount)}　商品 ${UI.fmtMoney(t.retail_amount)}　指名費 ${UI.fmtMoney(t.designate_fee)}　折扣 -${UI.fmtMoney(t.discount)}　<b>應收 ${UI.fmtMoney(t.net_amount)}</b>`)}
          ${t.status === 'done' ? row('收款', `現金 ${UI.fmtMoney(t.paid_cash)}　儲值 ${UI.fmtMoney(t.paid_wallet)}　次卡 ${UI.fmtMoney(t.paid_pass)}（${UI.esc(t.pay_method)}）`) : ''}
          ${t.status === 'done' ? row('技師抽成', `服務 ${UI.fmtMoney(t.comm_service)}（${t.comm_pct_used}%）　商品 ${UI.fmtMoney(t.comm_retail)}　指名費 ${UI.fmtMoney(t.comm_designate)}`) : ''}
          ${t.gate_note ? row('強制放行理由', `<span class="danger">${UI.esc(t.gate_note)}</span>`) : ''}
          ${t.note ? row('備註', UI.esc(t.note)) : ''}
        </table>
        <h4>明細</h4>
        <div id="tk-items"></div>
        <div class="modal-acts">
          ${canEdit && t.status === 'booked' ? '<button class="btn" data-a="start">上鐘</button>' : ''}
          ${canEdit ? '<button class="btn" data-a="checkout">結帳</button>' : ''}
          ${canEdit ? '<button class="btn secondary" data-a="add">加鐘／加項</button>' : ''}
          ${canEdit ? '<button class="btn secondary" data-a="retail">賣商品</button>' : ''}
          ${canEdit ? '<button class="btn secondary" data-a="edit">修改</button>' : ''}
          <button class="btn secondary" data-a="receipt">列印收據</button>
          ${t.status === 'done' && App.can('invoices') ? '<button class="btn secondary" data-a="invoice">補開發票</button>' : ''}
          <button class="btn secondary" data-a="notify">預約通知</button>
          ${t.status !== 'cancelled' && App.canEdit('tickets') ? '<button class="btn danger" data-a="cancel">取消／未到</button>' : ''}
        </div>`,
      onClose: onDone
    });

    const drawItems = () => {
      m.body.querySelector('#tk-items').innerHTML = UI.table(
        ['類型', '名稱', '數量', '單價', '金額', '歸屬技師', '抽成', ''],
        t.items.map(i => `<tr>
          <td>${twLabel('item_kind', i.kind)}</td><td>${UI.esc(i.name)}</td>
          <td class="num">${i.qty}</td><td class="num">${UI.fmtMoney(i.unit_price)}</td>
          <td class="num">${UI.fmtMoney(i.amount)}</td>
          <td>${UI.esc(i.therapist_name || '主技師')}</td>
          <td class="num">${i.comm_amount ? `${UI.fmtMoney(i.comm_amount)}（${i.comm_pct}%）` : '—'}</td>
          <td>${canEdit ? `<button class="btn tiny danger" data-del="${i.id}">刪除</button>` : ''}</td></tr>`),
        '沒有加鐘或商品');
      m.body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!await UI.confirm('確定刪除這個項目？')) return;
        try { await DEL(`/tickets/${id}/items/${b.dataset.del}`); m.close(); Tickets.detail(id, onDone); }
        catch (e) { UI.err(e); }
      });
    };
    drawItems();

    m.body.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'start') return Tickets.start(t, () => { m.close(); Tickets.detail(id, onDone); });
      if (a === 'checkout') return Tickets.checkout(t, () => { m.close(); if (onDone) onDone(); });
      if (a === 'add') return Tickets.addItem(t, 'service', () => { m.close(); Tickets.detail(id, onDone); });
      if (a === 'retail') return Tickets.addItem(t, 'retail', () => { m.close(); Tickets.detail(id, onDone); });
      if (a === 'edit') return Tickets.edit(t, () => { m.close(); Tickets.detail(id, onDone); });
      if (a === 'cancel') return Tickets.cancel(t, () => { m.close(); if (onDone) onDone(); });
      if (a === 'receipt') return Tickets.receipt(t.id);
      if (a === 'invoice') return Tickets.invoice(t, () => { m.close(); Tickets.detail(id, onDone); });
      if (a === 'notify') return Tickets.notify(t);
    });
  },

  edit(t, onDone) {
    UI.modal({
      title: `修改 ${t.ticket_no}`, wide: true,
      body: Tickets.form(t) + `<div class="form-row full">${UI.textarea('gate_note', '若有硬衝突，請填寫放行理由', { rows: 2, value: t.gate_note || '' })}</div>`,
      onOpen(el) { Tickets.bindCheck(el, { ticket_id: t.id }); },
      async onSubmit(el) {
        const d = UI.formData(el);
        d.start_at = (d.start_at || '').replace('T', ' ');
        await PUT(`/tickets/${t.id}`, d);
        UI.toast('已更新'); onDone();
      }
    });
  },

  start(t, onDone) {
    UI.modal({
      title: `${t.ticket_no} 上鐘`, submitText: '確定上鐘',
      body: `<p>技師 <b>${UI.esc(t.therapist_name || '')}</b> 開始服務 <b>${UI.esc(t.service_name)}</b>。</p>
        <div id="tk-check"><div class="empty">檢查中…</div></div>
        ${UI.textarea('gate_note', '若有硬衝突，請填寫放行理由', { rows: 2 })}`,
      async onOpen(el) {
        const c = await POST('/tickets/check', { ...t, ticket_id: t.id });
        el.querySelector('#tk-check').innerHTML = Tickets.checkHtml(c);
      },
      async onSubmit(el) { await POST(`/tickets/${t.id}/start`, UI.formData(el)); UI.toast('已上鐘'); onDone(); }
    });
  },

  addItem(t, kind, onDone) {
    const isRetail = kind === 'retail';
    UI.modal({
      title: isRetail ? '販售商品' : '加鐘／加項',
      body: `<div class="form-grid">
        ${isRetail
          ? UI.select('ref_id', '商品', App.productOptions(), { full: true })
          : UI.select('ref_id', '帶入服務項目（可留空自行輸入）', App.serviceOptions('不帶入'), { full: true })}
        ${UI.input('name', '名稱（留空用上面帶入的）', { full: true })}
        ${UI.input('qty', '數量', { type: 'number', value: 1 })}
        ${UI.input('unit_price', '單價（留空用定價）', { type: 'number' })}
        ${isRetail ? '' : UI.input('minutes', '增加分鐘數', { type: 'number', value: 30 })}
        ${UI.select('therapist_id', '歸屬技師（抽成算誰的）', App.therapistOptions('主技師'), { value: '', full: true })}
      </div>
      <div class="muted">${isRetail
        ? '商品抽成％優先看商品自訂，其次看技師／級別設定。存檔即扣庫存。'
        : '加鐘會延後結束時間，可能撞到下一張單；存檔後系統會再檢查一次。'}</div>`,
      async onSubmit(el) {
        const d = UI.formData(el);
        const r = await POST(`/tickets/${t.id}/items`, { ...d, kind: isRetail ? 'retail' : 'service' });
        UI.toast('已新增');
        if (r.check && !r.check.ok) {
          UI.modal({ title: '加鐘後出現衝突', hideFooter: true, body: Tickets.checkHtml(r.check) });
        }
        onDone();
      }
    });
  },

  // 收據：另開一頁列印。用新分頁而不是在畫面裡塞一個列印區塊，
  // 是因為櫃檯常常要「補印上一張」，開新分頁才不會把手上這張單的畫面弄丟。
  receipt(ticketId) {
    window.open(`/print.html#ticket=${ticketId}`, '_blank', 'noopener');
  },

  invoice(t, onDone) {
    UI.modal({
      title: `${t.ticket_no} 補開發票`, submitText: '開立',
      body: `<div class="form-grid">
          ${UI.select('invoice_type', '類型', [['B2C', '二聯式（個人）'], ['B2B', '三聯式（公司）']], { plain: true })}
          ${UI.input('buyer_name', '買受人', { value: t.member_name || t.guest_name || '' })}
          ${UI.input('buyer_tax_id', '統一編號（三聯式必填）', { placeholder: '8 碼' })}
          ${UI.input('track', '字軌（留空用系統設定）', {})}
          ${UI.input('number', '號碼（留空自動帶）', {})}
        </div>
        <div class="notice">金額固定為這張單的應收 ${UI.fmtMoney(t.net_amount)}，不能改 ——
          發票金額與鐘單對不起來，日後查帳會查不完。</div>`,
      async onSubmit(el) {
        const r = await POST(`/tickets/${t.id}/invoice`, UI.formData(el));
        UI.toast(`已開立 ${r.track}-${r.number}`);
        onDone();
      }
    });
  },

  async checkout(t, onDone) {
    const passes = t.member_id ? await GET(`/passes/usable/${t.member_id}?service_id=${t.service_id || ''}`) : [];
    const wallet = t.member_id ? await GET(`/wallets/${t.member_id}`).then(r => r.balance).catch(() => null) : null;
    const m = UI.modal({
      title: `${t.ticket_no} 結帳`, wide: true, submitText: '確定結帳',
      body: `<div class="form-grid">
        ${UI.input('discount', '折扣金額', { type: 'number', value: t.discount || 0 })}
        ${UI.select('pass_id', '使用次卡', [['', '不使用']].concat(passes.map(p =>
          [p.id, `${p.pass_no} ${p.name}｜剩 ${p.remain} 次・單次值 ${UI.fmtMoney(p.unit_value)}${p.expiry_date ? `・${p.expiry_date} 到期` : ''}`])),
          { full: true, plain: true })}
        ${UI.input('pass_times', '核銷次數', { type: 'number', value: 1 })}
        ${UI.checkbox('use_wallet', '動用儲值', false, { text: wallet ? `可用 ${UI.fmtMoney(wallet.total)}（現金 ${UI.fmtMoney(wallet.cash)}／贈送 ${UI.fmtMoney(wallet.bonus)}）` : '此客人無儲值帳戶' })}
        ${UI.input('wallet_amount', '儲值抵用上限（留空＝抵到底）', { type: 'number' })}
        ${UI.select('pay_method', '剩餘金額收款方式', App.listOptions('pay_methods'), { value: '現金', plain: true })}
        ${UI.select('rating', '客人評價', [['0', '未評'], ['5', '5 非常滿意'], ['4', '4 滿意'], ['3', '3 普通'], ['2', '2 不滿意'], ['1', '1 很差']], { value: '0', plain: true })}
        ${UI.textarea('feedback', '客人回饋', { rows: 2 })}
        ${UI.checkbox('issue_invoice', '開立發票', false, { text: '結帳後立刻開，號碼依系統設定自動帶' })}
        ${UI.checkbox('print_receipt', '列印收據', true, { text: '結帳後開啟收據列印頁' })}
        ${UI.select('invoice_type', '發票類型', [['B2C', '二聯式（個人）'], ['B2B', '三聯式（公司）']], { plain: true })}
        ${UI.input('buyer_tax_id', '統一編號（三聯式）', { placeholder: '8 碼' })}
      </div>
      <div id="tk-quote"><div class="empty">試算中…</div></div>`,
      async onSubmit(el) {
        const d = UI.formData(el);
        const r = await POST(`/tickets/${t.id}/checkout`, d);
        // 發票開立失敗不會讓結帳退回去（錢已經收了），但一定要講出來，
        // 不然那張單會默默留在「待開發票」名單裡沒有人知道。
        if (r.invoice_error) UI.toast(`已結帳，但發票沒開成功：${r.invoice_error}`, true);
        else {
          UI.toast(`已結帳 ${UI.fmtMoney(r.quote.net_amount)}`
            + (r.invoice ? `，發票 ${r.invoice.track}-${r.invoice.number}` : '')
            + (r.points && r.points.points ? `，累積 ${r.points.points} 點` : ''));
        }
        // 收據直接開新分頁，櫃檯按一次就好
        if (UI.formData(el).print_receipt) Tickets.receipt(t.id);
        onDone();
      }
    });
    // 每動一次就重新試算：付款怎麼拆、抽成多少，按確定前就看得到
    const quote = async () => {
      const d = UI.formData(m.body);
      try {
        const q = await POST(`/tickets/${t.id}/quote`, d);
        const c = q.commission;
        m.body.querySelector('#tk-quote').innerHTML = `
          <table class="kv">
            <tr><th>應收</th><td><b>${UI.fmtMoney(q.net_amount)}</b>　（服務 ${UI.fmtMoney(t.amount)}＋商品 ${UI.fmtMoney(t.retail_amount)}＋指名費 ${UI.fmtMoney(t.designate_fee)}－折扣 ${UI.fmtMoney(q.discount)}）</td></tr>
            <tr><th>付款拆解</th><td>次卡 ${UI.fmtMoney(q.paid_pass)}　儲值 ${UI.fmtMoney(q.paid_wallet)}　<b>現金 ${UI.fmtMoney(q.paid_cash)}</b>
              ${q.wallet ? `<div class="muted">儲值扣款會先扣贈送金 ${UI.fmtMoney(q.wallet.use_bonus)}，再扣現金 ${UI.fmtMoney(q.wallet.use_cash)}</div>` : ''}
              ${q.pass ? `<div class="muted">${UI.esc(q.pass.pass_no)} 核銷 ${q.pass.times} 次，核銷後尚餘 ${q.pass.remain_after} 次</div>` : ''}</td></tr>
            <tr><th>技師抽成</th><td>服務 ${UI.fmtMoney(c.comm_service)}（${c.pct_used}%，${UI.esc(t.assign_type === 'designated' ? c.rates.source.designated : c.rates.source.normal)}）
              ${c.comm_retail ? `　商品 ${UI.fmtMoney(c.comm_retail)}` : ''}
              ${c.comm_designate ? `　指名費 ${UI.fmtMoney(c.comm_designate)}` : ''}
              ${c.comm_other ? `　其他技師 ${UI.fmtMoney(c.comm_other)}` : ''}
              　合計 <b>${UI.fmtMoney(c.total)}</b></td></tr>
            <tr><th>店內留存</th><td>${UI.fmtMoney(q.store_margin)}</td></tr>
          </table>`;
      } catch (e) { m.body.querySelector('#tk-quote').innerHTML = `<div class="notice danger">${UI.esc(e.message)}</div>`; }
    };
    m.body.addEventListener('change', quote);
    quote();
  },

  cancel(t, onDone) {
    UI.modal({
      title: `取消 ${t.ticket_no}`, submitText: '確定',
      body: `<div class="form-grid">
        ${UI.textarea('reason', '原因（必填）', { rows: 2 })}
        ${UI.checkbox('noshow', '標記為「客人未到」', false)}
      </div>
      <div class="notice warn">取消會一併還原：技師的輪次、扣掉的儲值、核銷掉的次卡次數、商品庫存。</div>`,
      async onSubmit(el) {
        const d = UI.formData(el);
        if (!d.reason) { UI.toast('請填寫原因', true); return false; }
        await POST(`/tickets/${t.id}/cancel`, d);
        UI.toast('已取消'); onDone();
      }
    });
  },

  async notify(t) {
    const p = await GET(`/tickets/${t.id}/notify-preview`);
    UI.modal({
      title: '預約通知', submitText: '送出',
      body: `<pre class="msg-preview">${UI.esc(p.text)}</pre>`,
      async onSubmit() {
        const r = await POST(`/tickets/${t.id}/notify`, {});
        UI.toast(`通知${twLabel('notify_status', r.status)}`);
      }
    });
  }
};

App.page('tickets', {
  title: '鐘單', module: 'tickets', sub: '開單、加鐘、賣商品、結帳',
  help: {
    intro: '一張鐘單走完的流程是：開單 → 上鐘 → （加鐘／賣商品）→ 結帳。',
    steps: [
      '按「新增鐘單」，選客人與項目後系統會即時檢查衝突與客人的身體禁忌。',
      '現場客人勾「立刻上鐘」，預約單先開著，客人到了再按「上鐘」。',
      '結帳時付款順序固定：次卡 → 儲值 → 現金，抽成會在按下確定的那一刻算好寫死。'
    ],
    notes: [
      '有紅色「衝突」時仍可開單，但必須填放行理由，理由會留在單子上與稽核軌跡。',
      '已結帳的單不能改，要處理請走「取消」或到客訴頁登記。'
    ],
    terms: [
      ['指名', '客人指定技師。可加收指名費，技師的抽成％也比較高。'],
      ['輪鐘', '依輪鐘檯的順序指派。']
    ]
  },
  async render(el) {
    const state = { from: UI.today(), to: UI.today(), status: '', therapist_id: '', q: '' };
    el.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'page-acts';
    top.innerHTML = App.canEdit('tickets') ? '<button class="btn" id="new-tk">＋ 新增鐘單</button>' : '';
    top.appendChild(App.exportBtn('tickets', () => state));
    el.appendChild(top);
    if (App.canEdit('tickets')) top.querySelector('#new-tk').onclick = () => Tickets.create(draw);

    el.appendChild(App.filterBar([
      { name: 'from', label: '起', type: 'date', value: state.from },
      { name: 'to', label: '訖', type: 'date', value: state.to },
      { name: 'status', label: '狀態', type: 'select', options: [['', '全部']].concat(twOpts(TW.ticket_status)) },
      { name: 'therapist_id', label: '技師', type: 'select', options: App.therapistOptions('全部技師') },
      { name: 'q', label: '搜尋', type: 'search', placeholder: '單號／客人／電話' }
    ], v => { Object.assign(state, v); draw(); }));

    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const rows = await GET('/tickets' + App.qs(state));
      const sum = rows.filter(r => r.status === 'done')
        .reduce((a, r) => ({ n: a.n + 1, net: a.net + r.net_amount, comm: a.comm + r.comm_service + r.comm_retail + r.comm_designate }),
          { n: 0, net: 0, comm: 0 });
      body.innerHTML = `
        <div class="notice">期間已完成 <b>${sum.n}</b> 鐘，營收 <b>${UI.fmtMoney(sum.net)}</b>，技師抽成 ${UI.fmtMoney(sum.comm)}，店內留存 ${UI.fmtMoney(sum.net - sum.comm)}。</div>
        ` + UI.table(['單號', '時間', '客人', '技師', '項目', '指派', '床位', '應收', '狀態'],
          rows.map(r => `<tr data-id="${r.id}" class="clickable">
            <td>${UI.esc(r.ticket_no)}</td>
            <td>${UI.esc(r.start_at.slice(5, 16))}<span class="muted"> ${r.minutes}分</span></td>
            <td>${UI.esc(r.customer || '—')}</td>
            <td>${UI.esc(r.therapist_name || '—')}</td>
            <td>${UI.esc(r.service_name)}</td>
            <td>${App.statusTag('assign_type', r.assign_type)}</td>
            <td>${UI.esc(r.room_name || '—')}</td>
            <td class="num">${UI.fmtMoney(r.net_amount)}</td>
            <td>${App.statusTag('ticket_status', r.status)}</td></tr>`),
          '這個期間沒有鐘單');
      body.querySelectorAll('[data-id]').forEach(tr => tr.onclick = () => Tickets.detail(Number(tr.dataset.id), draw));
    }
    draw();
  }
});
