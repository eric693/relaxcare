// 團購券：建檔（單張與批次）、查詢、核銷狀態、作廢、平台月結對帳

const Vouchers = {
  form(v = {}) {
    return `<div class="form-grid">
      ${UI.select('platform', '平台', App.opt.voucher_platforms || [], { value: v.platform || '', plain: true })}
      ${UI.input('code', '券號', { value: v.code || '', required: true })}
      ${UI.input('batch', '檔期／專案名稱', { value: v.batch || '', placeholder: '例：2026 秋季腳底方案' })}
      ${UI.select('service_id', '限用項目（空＝可折抵任何項目）', App.serviceOptions('不限'), { value: v.service_id || '', full: true })}
      ${UI.input('title', '券面品名', { value: v.title || '', full: true })}
      ${UI.input('face_value', '券面可折抵金額', { type: 'number', value: v.face_value || 0 })}
      ${UI.input('commission_pct', '平台抽成％', { type: 'number', value: v.commission_pct ?? '' , placeholder: '留空用預設' })}
      ${UI.input('net_receivable', '店家實收（留空自動算）', { type: 'number', value: v.net_receivable || '' })}
      ${UI.input('issued_date', '售出日', { type: 'date', value: v.issued_date || UI.today() })}
      ${UI.input('expiry_date', '到期日', { type: 'date', value: v.expiry_date || '' })}
      ${UI.select('store_id', '限用門市（空＝不限）', App.storeOptions('不限'), { value: v.store_id || '' })}
      ${UI.input('buyer_name', '購買人', { value: v.buyer_name || '' })}
      ${UI.input('buyer_phone', '購買人電話', { value: v.buyer_phone || '' })}
      ${UI.textarea('note', '備註', { rows: 2, value: v.note || '' })}
    </div>
    <div class="muted">券面金額是客人可以折抵的錢；店家實收是扣掉平台抽成之後、平台之後會撥給你的錢。兩個數字都要留，月結才對得起來。</div>`;
  },

  create(onDone) {
    UI.modal({
      title: '建立團購券', wide: true, body: Vouchers.form(),
      async onSubmit(el) { await POST('/vouchers', UI.formData(el)); UI.toast('已建立'); onDone(); }
    });
  },

  // 平台給的是一整張 CSV，一張一張打會打到天亮
  bulk(onDone) {
    UI.modal({
      title: '批次建立團購券', wide: true, submitText: '批次建立',
      body: `<div class="form-grid">
        ${UI.select('platform', '平台', App.opt.voucher_platforms || [], { plain: true })}
        ${UI.input('batch', '檔期名稱', { placeholder: '例：2026 秋季腳底方案' })}
        ${UI.select('service_id', '限用項目', App.serviceOptions('不限'), { full: true })}
        ${UI.input('face_value', '券面金額（每行沒填時用這個）', { type: 'number' })}
        ${UI.input('commission_pct', '平台抽成％', { type: 'number' })}
        ${UI.input('expiry_date', '到期日（每行沒填時用這個）', { type: 'date' })}
        ${UI.textarea('lines', '券號清單', { rows: 10, placeholder: '一行一張券。可以只貼券號，也可以是「券號,面額,到期日」：\nKL2026001\nKL2026002,999,2026-12-31' })}
      </div>
      <div class="muted">已經建過的券號會被略過並列出來，不會重複建檔。</div>`,
      async onSubmit(el) {
        const r = await POST('/vouchers/bulk', UI.formData(el));
        UI.toast(`建立 ${r.created} 張${r.skipped.length ? `，略過 ${r.skipped.length} 張` : ''}`);
        if (r.skipped.length) {
          UI.modal({ title: `略過 ${r.skipped.length} 張`, hideFooter: true,
            body: UI.table(['券號', '原因'], r.skipped.map(x => `<tr><td>${UI.esc(x.code)}</td><td>${UI.esc(x.reason)}</td></tr>`)) });
        }
        onDone();
      }
    });
  },

  detail(v, onDone) {
    const row = (k, val) => `<tr><th>${UI.esc(k)}</th><td>${val}</td></tr>`;
    const m = UI.modal({
      title: `${v.platform} ${v.code}`, wide: true, hideFooter: true, onClose: onDone,
      body: `<table class="kv">
        ${row('狀態', App.statusTag('voucher_status', v.real_status))}
        ${row('券面品名', UI.esc(v.title || '—'))}
        ${row('檔期', UI.esc(v.batch || '—'))}
        ${row('限用項目', UI.esc(v.service_name || '不限'))}
        ${row('金額', `券面 <b>${UI.fmtMoney(v.face_value)}</b>　平台抽成 ${v.commission_pct}%　店家實收 <b>${UI.fmtMoney(v.net_receivable)}</b>`)}
        ${row('效期', `${UI.esc(v.issued_date || '—')} ~ ${UI.esc(v.expiry_date || '不限')}${
          v.days_left !== null && v.days_left >= 0 ? `<span class="muted">（剩 ${v.days_left} 天）</span>` : ''}`)}
        ${row('購買人', `${UI.esc(v.buyer_name || '—')}　${UI.esc(v.buyer_phone || '')}`)}
        ${v.used_at ? row('核銷', `${UI.esc(v.used_at)}　鐘單 ${UI.esc(v.ticket_no || '—')}`) : ''}
        ${v.settled_at ? row('平台撥款', UI.esc(v.settled_at)) : ''}
        ${v.note ? row('備註', UI.esc(v.note)) : ''}
      </table>
      <div class="modal-acts">
        ${App.canEdit('vouchers') && v.status === 'unused' ? '<button class="btn secondary" data-a="edit">編輯</button>' : ''}
        ${App.canEdit('vouchers') && v.status === 'used' ? '<button class="btn secondary" data-a="unuse">取消核銷</button>' : ''}
        ${App.canEdit('vouchers') && v.status === 'unused' ? '<button class="btn danger" data-a="void">作廢</button>' : ''}
      </div>`
    });
    m.body.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
      const a = b.dataset.a;
      if (a === 'edit') {
        return UI.modal({
          title: `編輯 ${v.code}`, wide: true, body: Vouchers.form(v),
          async onSubmit(el) { await PUT(`/vouchers/${v.id}`, UI.formData(el)); UI.toast('已更新'); m.close(); onDone(); }
        });
      }
      if (a === 'unuse') {
        return UI.modal({
          title: '取消核銷', submitText: '確定取消核銷',
          body: `<div class="form-grid">${UI.textarea('reason', '原因（必填）', { rows: 2, placeholder: '例：櫃檯掃錯券' })}</div>
            <div class="notice warn">取消核銷只會把券放回未使用，不會動到鐘單的收款金額 —— 請另外修正鐘單。</div>`,
          async onSubmit(el) {
            const d = UI.formData(el);
            if (!d.reason) { UI.toast('請填寫原因', true); return false; }
            await POST(`/vouchers/${v.id}/unuse`, d); UI.toast('已取消核銷'); m.close(); onDone();
          }
        });
      }
      if (a === 'void') {
        if (!await UI.confirm('確定作廢這張券？作廢後不能再核銷。')) return;
        try { await DEL(`/vouchers/${v.id}`); UI.toast('已作廢'); m.close(); onDone(); } catch (e) { UI.err(e); }
      }
    });
  }
};

App.page('vouchers', {
  title: '團購券', module: 'vouchers', sub: 'Klook／GOMAJI 券號建檔、核銷狀態與平台對帳',
  help: {
    intro: '團購券跟現場收現金是兩回事：錢是平台先收走的、抽走一兩成、月結才撥給你，而且券有到期日、同一張只能用一次。',
    steps: [
      '平台給了一批券號後，按「批次建立」把清單貼進來（一行一張）。',
      '客人來店出示券，櫃檯在結帳畫面輸入券號，系統會檢查有沒有過期、是不是已經用過、限不限項目。',
      '每個月拿平台的撥款單來對「平台對帳」分頁，撥款進來的券勾起來按「標記已入帳」。',
      '掃錯券的話到該張券按「取消核銷」，並記得回頭修正鐘單的收款。'
    ],
    notes: [
      '同一張券號重複核銷會被系統擋下來 —— 這是靠人眼防不住的糾紛。',
      '券在核銷當天沒有現金進來，所以不會計入當日現金流入，只會出現在「待平台撥款」。',
      '作廢與取消核銷都不是刪除：券號是對外憑證，刪掉之後客人拿券來就查無此券，說不清楚。'
    ],
    terms: [
      ['券面金額', '客人可以折抵的錢。'],
      ['店家實收', '扣掉平台抽成後，平台之後會撥給你的錢。'],
      ['已入帳', '平台的錢真的進到銀行帳戶了。']
    ]
  },
  async render(el) {
    const state = { q: '', platform: '', status: '', batch: '' };
    let view = 'list';
    el.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'page-acts';
    if (App.canEdit('vouchers')) {
      top.innerHTML = '<button class="btn" id="new">＋ 建立券</button><button class="btn secondary" id="bulk">批次建立</button>';
    }
    el.appendChild(top);
    if (App.canEdit('vouchers')) {
      top.querySelector('#new').onclick = () => Vouchers.create(draw);
      top.querySelector('#bulk').onclick = () => Vouchers.bulk(draw);
    }

    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    tabs.innerHTML = '<button data-v="list" class="active">券清單</button><button data-v="recon">平台對帳</button>';
    tabs.onclick = e => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      view = b.dataset.v;
      tabs.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      draw();
    };
    el.appendChild(tabs);

    const filters = document.createElement('div');
    el.appendChild(filters);
    filters.appendChild(App.filterBar([
      { name: 'q', label: '搜尋', type: 'search', placeholder: '券號／品名／購買人／檔期' },
      { name: 'platform', label: '平台', type: 'select', options: [['', '全部平台']].concat((App.opt.voucher_platforms || []).map(x => [x, x])) },
      { name: 'status', label: '狀態', type: 'select', options: [['', '全部']].concat(twOpts(TW.voucher_status)) },
      { name: 'batch', label: '檔期', type: 'search', placeholder: '檔期名稱' }
    ], v => { Object.assign(state, v); draw(); }));

    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      filters.hidden = view !== 'list';
      if (view === 'recon') return drawRecon();
      const rows = await GET('/vouchers' + App.qs(state));
      const n = k => rows.filter(r => r.real_status === k).length;
      body.innerHTML = `<div class="stat-grid">
          <div class="stat"><div class="stat-label">未核銷</div><div class="stat-value">${n('unused')}</div>
            <div class="stat-sub">面額 ${UI.fmtMoney(rows.filter(r => r.real_status === 'unused').reduce((s, r) => s + r.face_value, 0))}</div></div>
          <div class="stat ok"><div class="stat-label">已核銷</div><div class="stat-value">${n('used')}</div>
            <div class="stat-sub">待平台撥款 ${UI.fmtMoney(rows.filter(r => r.real_status === 'used').reduce((s, r) => s + r.net_receivable, 0))}</div></div>
          <div class="stat"><div class="stat-label">已入帳</div><div class="stat-value">${n('settled')}</div></div>
          <div class="stat warn"><div class="stat-label">已過期</div><div class="stat-value">${n('expired')}</div></div>
        </div>`
        + UI.table(['平台', '券號', '檔期', '品名', '券面', '實收', '抽成', '到期', '狀態', '核銷鐘單'],
          rows.map(r => `<tr data-id="${r.id}" class="clickable${r.real_status === 'expired' ? ' row-warn' : ''}">
            <td>${UI.esc(r.platform)}</td><td>${UI.esc(r.code)}</td>
            <td class="muted">${UI.esc(r.batch)}</td>
            <td>${UI.esc(r.title || r.service_name || '—')}</td>
            <td class="num">${UI.fmtMoney(r.face_value)}</td>
            <td class="num">${UI.fmtMoney(r.net_receivable)}</td>
            <td class="num">${r.commission_pct}%</td>
            <td>${UI.esc(r.expiry_date || '—')}${r.days_left !== null && r.days_left >= 0 && r.days_left <= 30 ? `<span class="muted"> 剩 ${r.days_left} 天</span>` : ''}</td>
            <td>${App.statusTag('voucher_status', r.real_status)}</td>
            <td>${UI.esc(r.ticket_no || '—')}</td></tr>`),
          '沒有符合條件的券');
      body.querySelectorAll('[data-id]').forEach(tr => tr.onclick = () =>
        Vouchers.detail(rows.find(x => String(x.id) === tr.dataset.id), draw));
    }

    async function drawRecon() {
      const d = await GET('/vouchers/reconcile');
      body.innerHTML = `<div class="stat-grid">
          <div class="stat"><div class="stat-label">已核銷券面總額</div><div class="stat-value">${UI.fmtMoney(d.total.face)}</div>
            <div class="stat-sub">客人折抵掉的金額</div></div>
          <div class="stat"><div class="stat-label">店家應收</div><div class="stat-value">${UI.fmtMoney(d.total.net)}</div>
            <div class="stat-sub">扣掉平台抽成後</div></div>
          <div class="stat ok"><div class="stat-label">平台已撥款</div><div class="stat-value">${UI.fmtMoney(d.total.settled)}</div></div>
          <div class="stat warn"><div class="stat-label">待平台撥款</div><div class="stat-value">${UI.fmtMoney(d.total.pending)}</div>
            <div class="stat-sub">平台還欠你的錢</div></div>
        </div>
        <h3>各平台／檔期</h3>
        ${UI.table(['平台', '檔期', '核銷張數', '券面總額', '應收', '已入帳', '待入帳'],
          d.rows.map(r => `<tr><td>${UI.esc(r.platform)}</td><td>${UI.esc(r.batch || '—')}</td>
            <td class="num">${r.used_count}</td>
            <td class="num">${UI.fmtMoney(r.face_total)}</td>
            <td class="num">${UI.fmtMoney(r.net_total)}</td>
            <td class="num">${UI.fmtMoney(r.settled_total)}</td>
            <td class="num ${r.pending_total > 0 ? 'danger' : ''}">${UI.fmtMoney(r.pending_total)}</td></tr>`),
          '這段期間沒有核銷紀錄')}
        <h3>各平台庫存</h3>
        ${UI.table(['平台', '未核銷（有效）', '已過期'],
          d.stock.map(r => `<tr><td>${UI.esc(r.platform)}</td><td class="num">${r.unused}</td>
            <td class="num">${r.expired}</td></tr>`))}
        ${App.canEdit('vouchers') ? `<h3>標記平台已撥款</h3>
          <div class="notice">拿平台的撥款單來核對，把這一期已經撥進來的券勾起來。標記後就不會再出現在「待平台撥款」。</div>
          <div class="form-grid">
            ${UI.input('settled_at', '撥款入帳日', { type: 'date', value: UI.today() })}
          </div>
          <div id="pending-list"></div>` : ''}`;

      if (!App.canEdit('vouchers')) return;
      const pending = await GET('/vouchers?status=used');
      document.getElementById('pending-list').innerHTML =
        (pending.length ? '<button class="btn" id="settle">標記勾選的券已入帳</button><button class="btn secondary" id="all">全選／全不選</button>' : '')
        + UI.table(['', '平台', '券號', '檔期', '核銷時間', '應收'],
          pending.map(r => `<tr><td><input type="checkbox" data-pick="${r.id}"></td>
            <td>${UI.esc(r.platform)}</td><td>${UI.esc(r.code)}</td>
            <td>${UI.esc(r.batch || '')}</td><td>${UI.esc((r.used_at || '').slice(0, 16))}</td>
            <td class="num">${UI.fmtMoney(r.net_receivable)}</td></tr>`),
          '沒有待入帳的券');
      const btn = document.getElementById('settle');
      if (btn) {
        document.getElementById('all').onclick = () => {
          const boxes = [...body.querySelectorAll('[data-pick]')];
          const on = !boxes.every(b => b.checked);
          boxes.forEach(b => { b.checked = on; });
        };
        btn.onclick = async () => {
          const ids = [...body.querySelectorAll('[data-pick]:checked')].map(b => Number(b.dataset.pick));
          if (!ids.length) return UI.toast('請先勾選', true);
          const settled_at = body.querySelector('[name=settled_at]').value;
          try {
            const r = await POST('/vouchers/settle', { ids, settled_at });
            UI.toast(`已標記 ${r.settled} 張入帳`); draw();
          } catch (e) { UI.err(e); }
        };
      }
    }
    draw();
  }
});
