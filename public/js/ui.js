// UI 共用元件：跳出視窗、提示、表格、表單欄位
const UI = {
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  toast(msg, isError) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show' + (isError ? ' error' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ''; }, isError ? 3600 : 2200);
  },
  err(e) { UI.toast(e && e.message ? e.message : String(e), true); },

  // 開啟 Modal；onSubmit 回傳 false 可阻止關閉
  modal({ title, body, wide, submitText = '儲存', onSubmit, onOpen, onClose, hideFooter }) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal${wide ? ' wide' : ''}">
        <div class="modal-head"><h3>${UI.esc(title)}</h3><button class="close" type="button">&times;</button></div>
        <div class="modal-body"></div>
        ${hideFooter ? '' : `<div class="modal-foot">
          <button class="btn secondary" data-act="cancel" type="button">取消</button>
          <button class="btn" data-act="ok" type="button">${UI.esc(submitText)}</button>
        </div>`}
      </div>`;
    const bodyEl = mask.querySelector('.modal-body');
    if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
    // onClose 一定要有：呼叫端若用 Promise 等待結果，使用者按取消時才不會永遠卡住
    let closed = false;
    const close = () => { if (closed) return; closed = true; mask.remove(); if (onClose) onClose(); };
    mask.querySelector('.close').onclick = close;
    mask.addEventListener('mousedown', e => { if (e.target === mask) close(); });
    if (!hideFooter) {
      mask.querySelector('[data-act="cancel"]').onclick = close;
      mask.querySelector('[data-act="ok"]').onclick = async () => {
        const btn = mask.querySelector('[data-act="ok"]');
        btn.disabled = true;
        try {
          const r = onSubmit ? await onSubmit(bodyEl, close) : true;
          if (r !== false) close();
        } catch (e) { UI.err(e); }
        btn.disabled = false;
      };
    }
    document.body.appendChild(mask);
    UI.bindSearchSelects(bodyEl);        // 可搜尋下拉一律自動生效
    UI.bindCheckLists(bodyEl);           // 複選群組同理，呼叫端不必自己記得綁
    if (onOpen) onOpen(bodyEl, close);
    return { close, body: bodyEl };
  },

  confirm(msg) {
    return new Promise(resolve => {
      const m = UI.modal({
        title: '確認操作', hideFooter: true,
        body: `<p style="font-size:15px">${UI.esc(msg)}</p>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
            <button class="btn secondary" data-c="no" type="button">取消</button>
            <button class="btn" data-c="yes" type="button">確定</button>
          </div>`
      });
      m.body.querySelector('[data-c=no]').onclick = () => { m.close(); resolve(false); };
      m.body.querySelector('[data-c=yes]').onclick = () => { m.close(); resolve(true); };
    });
  },

  // ---- 表單欄位產生器 ----
  input(name, label, opts = {}) {
    const { type = 'text', value = '', placeholder = '', required = false, full = false, step } = opts;
    return `<div class="form-row${full ? ' full' : ''}">
      <label>${UI.esc(label)}${required ? ' *' : ''}</label>
      <input name="${name}" type="${type}" value="${UI.esc(value)}" placeholder="${UI.esc(placeholder)}"${step ? ` step="${step}"` : ''}>
    </div>`;
  },
  // 選項一多就自動升級成「可搜尋下拉」。品牌、商品、廠商動輒幾十上百筆，
  // 原生 select 只能一直捲，打字又只能比對開頭第一個字。
  // 門檻設 8：再少就直接看得完，加搜尋框反而礙事。
  SEARCHABLE_MIN: 8,

  select(name, label, options, opts = {}) {
    const { value = '', full = false } = opts;
    if (options.length >= UI.SEARCHABLE_MIN && !opts.plain) {
      return UI.searchSelect(name, label, options, { ...opts, full });
    }
    const inner = options.map(o => {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      return `<option value="${UI.esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${UI.esc(t)}</option>`;
    }).join('');
    return `<div class="form-row${full ? ' full' : ''}"><label>${UI.esc(label)}</label><select name="${name}">${inner}</select></div>`;
  },
  // 可搜尋的下拉：商品動輒上百筆，用原生 select 要一直捲。
  // 上面多一個關鍵字欄，輸入就即時篩選（SKU、品名、品牌都比對），
  // 篩到剩一項會自動選起來，直接按儲存就好。
  // 綁定由 UI.bindSearchSelects 統一處理，呼叫端不必自己接事件。
  searchSelect(name, label, options, opts = {}) {
    const { value = '', full = true, placeholder = '輸入關鍵字快速篩選' } = opts;
    const json = UI.esc(JSON.stringify(options.map(o => (Array.isArray(o) ? o : [o, o]))));
    const inner = options.map(o => {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      return `<option value="${UI.esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${UI.esc(t)}</option>`;
    }).join('');
    return `<div class="form-row${full ? ' full' : ''}" data-ss-wrap>
      <label>${UI.esc(label)}</label>
      <input type="search" class="ss-search" placeholder="${UI.esc(placeholder)}" data-ss-for="${name}" autocomplete="off">
      <select name="${name}" data-ss-options="${json}">${inner}</select>
      <div class="muted ss-count"></div>
    </div>`;
  },

  // 幫容器裡所有 searchSelect 接上篩選行為（UI.modal 開啟時自動呼叫）
  bindSearchSelects(root) {
    root.querySelectorAll('.ss-search').forEach(input => {
      const sel = root.querySelector(`select[name="${input.dataset.ssFor}"]`);
      if (!sel || sel.dataset.ssBound) return;
      sel.dataset.ssBound = '1';
      let all = [];
      try { all = JSON.parse(sel.dataset.ssOptions || '[]'); } catch { all = []; }
      const countEl = input.parentElement.querySelector('.ss-count');

      const render = () => {
        const q = input.value.trim().toLowerCase();
        const keep = sel.value;
        const hits = q ? all.filter(([v, t]) => String(t).toLowerCase().includes(q) || String(v) === q) : all;
        sel.innerHTML = hits.map(([v, t]) =>
          `<option value="${UI.esc(v)}">${UI.esc(t)}</option>`).join('');
        // 原本選的還在就保留，否則篩到剩一項時自動選它
        if (hits.some(([v]) => String(v) === String(keep))) sel.value = keep;
        else if (hits.length === 1) sel.value = String(hits[0][0]);
        // 只有「選到的東西真的變了」才發 change：
        // 否則篩選列每打一個字就會重新查一次清單，畫面一直閃
        if (sel.value !== keep) sel.dispatchEvent(new Event('change', { bubbles: true }));
        if (countEl) {
          countEl.textContent = !q ? ''
            : hits.length ? `符合 ${hits.length} 項` : '找不到符合的商品，可留空改用手動輸入';
        }
      };
      input.addEventListener('input', e => { e.stopPropagation(); render(); });
      input.addEventListener('change', e => e.stopPropagation());
      // 在搜尋框按 Enter 不要送出整張表單，只是收合篩選
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sel.focus(); } });
    });
  },

  inputList(name, label, options, opts = {}) {
    const { value = '', placeholder = '', full = false } = opts;
    const listId = `dl-${name}-${Math.random().toString(36).slice(2, 7)}`;
    return `<div class="form-row${full ? ' full' : ''}">
      <label>${UI.esc(label)}</label>
      <input name="${name}" list="${listId}" value="${UI.esc(value)}" placeholder="${UI.esc(placeholder)}">
      <datalist id="${listId}">${options.map(o => `<option value="${UI.esc(o)}"></option>`).join('')}</datalist>
    </div>`;
  },
  textarea(name, label, opts = {}) {
    const { value = '', full = true, placeholder = '', rows } = opts;
    return `<div class="form-row${full ? ' full' : ''}"><label>${UI.esc(label)}</label>
      <textarea name="${name}"${rows ? ` rows="${rows}"` : ''} placeholder="${UI.esc(placeholder)}">${UI.esc(value)}</textarea></div>`;
  },
  // 可複選的勾選群組。值以逗號串起來存成一個字串（例如 "Facebook,Instagram"）——
  // 這樣既有的單選欄位不必改資料表就能升級成複選，舊資料（只有一個值）本來就是合法的字串。
  // formData 會讀 hidden input，所以呼叫端跟其他欄位一樣用 UI.formData 就拿得到。
  checkList(name, label, options, opts = {}) {
    const { value = '', full = true, hint = '' } = opts;
    const picked = UI.splitList(value);
    const items = options.map(o => {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      return `<label class="chk"><input type="checkbox" data-cl="${name}" value="${UI.esc(v)}"${
        picked.includes(String(v)) ? ' checked' : ''}> ${UI.esc(t)}</label>`;
    }).join('');
    return `<div class="form-row${full ? ' full' : ''}">
      <label>${UI.esc(label)}</label>
      <div class="chk-list" data-cl-wrap="${name}">${items}</div>
      <input type="hidden" name="${name}" value="${UI.esc(picked.join(','))}">
      ${hint ? `<div class="muted">${UI.esc(hint)}</div>` : ''}
    </div>`;
  },
  // 勾選群組要在插進畫面後綁一次，勾選才會同步到 hidden input
  bindCheckLists(root) {
    root.querySelectorAll('[data-cl-wrap]').forEach(wrap => {
      const name = wrap.dataset.clWrap;
      const hidden = wrap.parentElement.querySelector(`input[type=hidden][name="${name}"]`);
      if (!hidden) return;
      wrap.querySelectorAll(`[data-cl="${name}"]`).forEach(cb => cb.addEventListener('change', () => {
        hidden.value = [...wrap.querySelectorAll(`[data-cl="${name}"]`)]
          .filter(x => x.checked).map(x => x.value).join(',');
      }));
    });
  },
  // 逗號分隔的多選值 → 陣列（空字串回空陣列，不要回 ['']）
  splitList(v) {
    return String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  },

  checkbox(name, label, checked, opts = {}) {
    return `<div class="form-row${opts.full ? ' full' : ''}"><label>${UI.esc(label)}</label>
      <label class="chk"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}> ${UI.esc(opts.text || '是')}</label></div>`;
  },
  formData(el) {
    const out = {};
    el.querySelectorAll('input[name], select[name], textarea[name]').forEach(i => {
      out[i.name] = i.type === 'checkbox' ? (i.checked ? 1 : 0) : i.value.trim();
    });
    return out;
  },

  // rowsHtml 可以是 <tr> 陣列，也可以是已經串好的一整段 HTML 字串。
  // 兩種寫法在呼叫端都很自然，這裡一併吃下來，不要讓呼叫端記得該用哪一種。
  table(headers, rowsHtml, emptyMsg = '目前沒有資料') {
    const body = Array.isArray(rowsHtml) ? rowsHtml.join('') : String(rowsHtml || '');
    if (!body.trim()) return `<div class="empty">${UI.esc(emptyMsg)}</div>`;
    return `<div class="table-wrap"><table class="list">
      <thead><tr>${headers.map(h => `<th>${UI.esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table></div>`;
  },

  tag(text, cls = '') { return `<span class="tag ${cls}">${UI.esc(text)}</span>`; },

  // 外部連結按鈕
  link(url, text) {
    if (!url) return '<span class="muted">—</span>';
    return `<a class="btn tiny secondary" href="${UI.esc(url)}" target="_blank" rel="noopener">${UI.esc(text)}</a>`;
  },

  today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  thisMonth() { return UI.today().slice(0, 7); },
  addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  },
  // 'YYYY-MM-DD HH:MM' → 給 <input type="datetime-local"> 用的 'YYYY-MM-DDTHH:MM'
  toLocalInput(stamp) { return String(stamp || '').replace(' ', 'T').slice(0, 16); },
  // 時間點只顯示時分（表格裡日期通常已在別的欄位）
  hhmm(stamp) { return String(stamp || '').slice(11, 16); },
  // 與後端 fmtDuration 同一套寫法：整點只講小時，不到一小時只講分鐘
  dur(min) {
    const m = Math.max(0, Math.round(Number(min) || 0));
    const h = Math.floor(m / 60), r = m % 60;
    if (!h) return `${r} 分鐘`;
    return r ? `${h} 小時 ${r} 分` : `${h} 小時`;
  },

  // 全站帳務一律台幣，不做幣別換算
  fmtMoney(n) { return 'NT$ ' + Math.round(Number(n) || 0).toLocaleString('zh-TW'); },
  fmtTWD(n) { return UI.fmtMoney(n); },
  fmtNum(n) { return Number(n || 0).toLocaleString('zh-TW'); },
  fmtPct(n, digits = 1) { return (Number(n || 0) * 100).toFixed(digits) + '%'; },
  fmtDelta(n) {
    const v = Math.round(Number(n) || 0);
    return (v > 0 ? '+' : '') + v.toLocaleString('zh-TW');
  },
  moneyClass(n) { return Number(n) < 0 ? 'danger' : ''; }
};

// 中文對照：狀態碼只在資料庫裡是英文，畫面上一律講人話
const TW = {
  ticket_status: { booked: '已預約', serving: '服務中', done: '已完成', cancelled: '已取消', noshow: '未到' },
  assign_type: { rotation: '輪鐘', designated: '指名', assigned: '店長指派' },
  shift_status: { waiting: '等鐘', serving: '上鐘中', resting: '休息中', off: '已下班' },
  queue_event: {
    checkin: '簽到', checkout: '下班', rest: '休息', resume: '回到輪序', assign: '輪鐘指派',
    designate: '指名', skip: '被跳過', release: '下鐘', manual: '人工調整', rollback: '返還輪次'
  },
  item_kind: { service: '加鐘', addon: '加項', retail: '商品' },
  wallet_kind: {
    topup: '儲值', consume: '消費扣款', refund: '退款', transfer_out: '轉出', transfer_in: '轉入',
    adjust: '人工調整', expire: '贈送金到期'
  },
  pass_kind: { buy: '購買', use: '核銷', void: '核銷回沖', refund: '退卡', transfer: '轉讓', extend: '展延' },
  pass_status: { active: '使用中', used_up: '已用完', expired: '已過期', refunded: '已退卡', transferred: '已轉出' },
  payroll_status: { draft: '試算中', confirmed: '已確認', paid: '已發放' },
  issue_status: { open: '待處理', handling: '處理中', closed: '已結案' },
  severity: { low: '低', normal: '一般', high: '高' },
  booking_status: { new: '待處理', contacted: '已聯繫', converted: '已成單', rejected: '婉拒／無效' },
  notify_status: { simulated: '模擬（未設 LINE）', sent: '已送出', failed: '失敗' },
  expiry_status: { expired: '已過期', missing: '未登錄', soon: '即將到期', ok: '正常' },
  consent_status: { no_consent: '未簽同意書', no_health: '無問診紀錄', stale: '問診已過半年', ok: '完整' },
  employ_type: { 全職: '全職', 兼職: '兼職', 承攬: '承攬' },
  refund_mode: { unit: '按實付單價退未使用次數', list: '已使用次數按原價扣回' }
};
const twOpts = obj => Object.entries(obj).map(([k, v]) => [k, v]);
const twLabel = (dict, v) => (TW[dict] && TW[dict][v]) || v || '—';
