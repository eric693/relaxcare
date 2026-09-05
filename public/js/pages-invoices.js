// 發票與折讓、點數與介紹

App.page('invoices', {
  title: '發票與折讓', module: 'invoices', sub: '系統不代開電子發票，它記的是「你實際開了哪幾張」',
  help: {
    intro: '營業稅試算算的是「應該開多少」，國稅局看的是「你開了哪幾張、作廢了哪幾張、折讓多少」。這一頁補的是後者。',
    steps: [
      '在「系統設定」填字軌與起始號碼，之後開立會自動帶號。',
      '結帳時勾「開立發票」最省事；漏開的會出現在下方「待開發票」，可以逐張補開。',
      '開錯整張用「作廢」；已經賣了但退一部分錢用「折讓」。',
      '月底按匯出，拿去跟申報書對。'
    ],
    notes: [
      '作廢 = 整張不算數；折讓 = 原發票有效，銷售額扣掉折讓金額。這兩個實務上最常搞混。',
      '三聯式（B2B）一定要填 8 碼統一編號。',
      '金額以含稅總額為準，未稅與稅額由系統反推，兩者相加永遠等於含稅總額。'
    ],
    terms: [['應稅銷售額', '開立總額扣掉折讓後的未稅金額，就是申報書上要填的數字。']]
  },
  async render(el) {
    const state = { period: UI.thisMonth(), status: '', q: '', store_id: '' };
    el.innerHTML = '';
    el.appendChild(App.filterBar([
      { name: 'period', label: '月份', type: 'month', value: state.period },
      { name: 'status', label: '狀態', type: 'select', options: [['', '全部'], ['issued', '已開立'], ['allowance', '已折讓'], ['void', '已作廢']] },
      { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市') },
      { name: 'q', label: '搜尋', type: 'text', placeholder: '號碼／買受人／統編／鐘單' }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const range = { from: state.period + '-01', to: UI.addDays(state.period + '-01', 31).slice(0, 8) + '01' };
      const d = await GET('/invoices' + App.qs({ ...state, ...range }));
      const s = d.summary, st = d.settings;
      const stat = (l, v, sub, cls = '') =>
        `<div class="stat ${cls}"><div class="stat-label">${l}</div><div class="stat-value">${v}</div><div class="stat-sub">${sub || ''}</div></div>`;
      body.innerHTML = `
        <div class="toolbar">
          <button class="btn" id="btn-issue">開立發票</button>
          <span class="spacer"></span><span id="iv-export"></span>
        </div>
        ${st.track ? '' : '<div class="notice warn">還沒設定發票字軌。到「系統設定」填 invoice_track（例如 AB）與 invoice_next_no（8 碼起始號碼），開立時就會自動帶號。</div>'}
        <div class="stat-grid">
          ${stat('開立張數', String(s.issued_count), `作廢 ${s.void_count} 張`)}
          ${stat('開立總額', UI.fmtMoney(s.gross), '含稅')}
          ${stat('折讓', UI.fmtMoney(s.allowance), '從銷售額扣掉', s.allowance ? 'warn' : '')}
          ${stat('應稅銷售額', UI.fmtMoney(s.net_sales), `稅額 ${UI.fmtMoney(s.output_tax)}（${st.rate}%）`, 'ok')}
          ${stat('下一個號碼', st.track ? `${st.track}-${st.next_no || '手動'}` : '未設定', '在系統設定調整')}
          ${stat('待開發票', String(d.missing.length), '已結帳但還沒開', d.missing.length ? 'warn' : '')}
        </div>
        ${d.missing.length ? `<h3>待開發票（${d.missing.length}）</h3>
          ${UI.table(['鐘單', '營業日', '客人', '金額', '付款', '門市', ''],
            d.missing.slice(0, 50).map(m => `<tr>
              <td>${UI.esc(m.ticket_no)}</td><td>${UI.esc(m.biz_date)}</td><td>${UI.esc(m.customer || '')}</td>
              <td class="num">${UI.fmtMoney(m.net_amount)}</td><td>${UI.esc(m.pay_method || '')}</td>
              <td>${UI.esc(m.store_name || '')}</td>
              <td><button class="btn tiny" data-fill="${m.id}" data-amt="${m.net_amount}" data-name="${UI.esc(m.customer || '')}">開立</button></td>
            </tr>`))}` : ''}
        <h3>發票紀錄</h3>
        ${UI.table(['日期', '號碼', '類型', '買受人', '含稅總額', '未稅', '稅額', '折讓', '狀態', '鐘單', ''],
          d.rows.map(r => `<tr class="${r.status === 'void' ? 'muted' : ''}">
            <td>${UI.esc(r.invoice_date)}</td>
            <td>${UI.esc(r.track)}-${UI.esc(r.number)}</td>
            <td>${r.invoice_type === 'B2B' ? '三聯' : '二聯'}</td>
            <td>${UI.esc(r.buyer_name || '')}${r.buyer_tax_id ? `<div class="muted">${UI.esc(r.buyer_tax_id)}</div>` : ''}</td>
            <td class="num">${UI.fmtMoney(r.amount)}</td>
            <td class="num">${UI.fmtMoney(r.net_amount)}</td>
            <td class="num">${UI.fmtMoney(r.tax_amount)}</td>
            <td class="num ${r.allowance_amount ? 'warn' : ''}">${r.allowance_amount ? UI.fmtMoney(r.allowance_amount) : '—'}</td>
            <td>${r.status === 'void' ? UI.tag('已作廢', 'danger') : r.status === 'allowance' ? UI.tag('已折讓', 'warn') : UI.tag('已開立', 'ok')}</td>
            <td>${UI.esc(r.ticket_no || '')}</td>
            <td>${r.status !== 'void' ? `<button class="btn tiny secondary" data-allow="${r.id}">折讓</button>
              <button class="btn tiny danger" data-void="${r.id}">作廢</button>` : `<span class="muted">${UI.esc(r.void_reason)}</span>`}</td>
          </tr>`), '這個月還沒有發票紀錄')}`;

      body.querySelector('#iv-export').appendChild(App.exportBtn('invoices', () => range));
      body.querySelector('#btn-issue').onclick = () => issueDialog();
      body.querySelectorAll('[data-fill]').forEach(b => b.onclick = () =>
        issueDialog({ ticket_id: b.dataset.fill, amount: b.dataset.amt, buyer_name: b.dataset.name }));
      body.querySelectorAll('[data-void]').forEach(b => b.onclick = () => voidDialog(b.dataset.void));
      body.querySelectorAll('[data-allow]').forEach(b => b.onclick = () => allowDialog(b.dataset.allow));

      function issueDialog(pre = {}) {
        UI.modal({
          title: '開立發票', submitText: '開立',
          body: `<div class="form-grid">
              ${UI.input('track', '字軌', { value: st.track, placeholder: 'AB' })}
              ${UI.input('number', '號碼（留空自動帶）', { value: pre.ticket_id ? '' : st.next_no, placeholder: '8 碼數字' })}
              ${UI.input('invoice_date', '開立日期', { type: 'date', value: UI.today() })}
              ${UI.select('invoice_type', '類型', [['B2C', '二聯式（個人）'], ['B2B', '三聯式（公司）']])}
              ${UI.input('buyer_name', '買受人', { value: pre.buyer_name || '' })}
              ${UI.input('buyer_tax_id', '統一編號（三聯式必填）', { placeholder: '8 碼' })}
              ${UI.input('amount', '含稅總額', { type: 'number', value: pre.amount || '' })}
            </div>
            ${UI.textarea('note', '備註', { rows: 2 })}`,
          async onSubmit(el2) {
            const f = UI.formData(el2);
            const r = await POST('/invoices', { ...f, ticket_id: pre.ticket_id || null });
            UI.toast(`已開立 ${r.track}-${r.number}`);
            draw();
          }
        });
      }
      function voidDialog(id) {
        UI.modal({
          title: '作廢發票', submitText: '確認作廢',
          body: `<div class="notice warn">作廢＝整張不算數，銷售額全額不認列。若只是要退一部分錢，請改用「折讓」。</div>
            ${UI.textarea('reason', '作廢原因（必填）', { rows: 2 })}`,
          async onSubmit(el2) {
            await POST(`/invoices/${id}/void`, UI.formData(el2));
            UI.toast('已作廢');
            draw();
          }
        });
      }
      function allowDialog(id) {
        UI.modal({
          title: '開立折讓', submitText: '確認折讓',
          body: `<div class="notice">折讓＝原發票仍有效，銷售額扣掉折讓金額。可以分次開，累計不得超過原金額。</div>
            <div class="form-grid">
              ${UI.input('amount', '折讓金額', { type: 'number' })}
              ${UI.input('date', '折讓日期', { type: 'date', value: UI.today() })}
            </div>
            ${UI.textarea('reason', '折讓原因（必填）', { rows: 2, placeholder: '例如：客訴補償退款 200 元' })}`,
          async onSubmit(el2) {
            await POST(`/invoices/${id}/allowance`, UI.formData(el2));
            UI.toast('已開立折讓');
            draw();
          }
        });
      }
    }
    draw();
  }
});

App.page('loyalty', {
  title: '點數與介紹', module: 'loyalty', sub: '兌換一律換成儲值贈送金 —— 折在鐘單上會扣到技師的抽成',
  help: {
    intro: '集點與介紹人是這行業主要的拉客手段。點數在結帳時自動累積，兌換時轉成儲值贈送金。',
    steps: [
      '規則在「系統設定」調整：多少錢 1 點、1 點值多少錢、兌換門檻、介紹獎勵點數。',
      '客人要兌換時按「兌換點數」，選客人與點數，系統會存進他的儲值贈送金。',
      '活動加碼或輸入錯誤用「人工調整」，一律要填原因。',
      '在客人檔案裡設定「介紹人」，那位新客第一次消費完成時，介紹人自動得點。'
    ],
    notes: [
      '兌換不直接折鐘單，是因為抽成按業績算 —— 客人用點數會讓技師薪水變少，那是吵不完的。',
      '點數預設只認服務消費，不含商品與預收（跟級距獎金同一個道理）。',
      '鐘單取消時，那張單發出去的點數與介紹獎勵會一起收回。'
    ],
    terms: [['未兌換點數成本', '全部拿去換的話，帳上要多出來的贈送金 —— 這是一筆潛在負擔。']]
  },
  async render(el) {
    const body = document.createElement('div');
    el.innerHTML = '';
    el.appendChild(body);

    async function draw() {
      const d = await GET('/loyalty');
      const r = d.rules;
      const stat = (l, v, s, cls = '') =>
        `<div class="stat ${cls}"><div class="stat-label">${l}</div><div class="stat-value">${v}</div><div class="stat-sub">${s || ''}</div></div>`;
      body.innerHTML = `
        <div class="toolbar">
          <button class="btn" id="btn-redeem">兌換點數</button>
          <button class="btn secondary" id="btn-adjust">人工調整</button>
          <span class="spacer"></span><span id="pt-export"></span>
        </div>
        ${d.enabled ? '' : '<div class="notice warn">集點目前是關閉的（系統設定 points_enabled）。結帳不會累點。</div>'}
        <div class="stat-grid">
          ${stat('流通點數', UI.fmtNum(d.outstanding_points), '客人手上還沒兌換的')}
          ${stat('潛在兌換成本', UI.fmtMoney(d.outstanding_value), '全部兌換要付出的贈送金', 'warn')}
          ${stat('累點規則', `每 ${r.points_per_amount} 元 1 點`, r.service_only ? '只計服務消費' : '含商品與預收')}
          ${stat('兌換價值', `1 點 = ${UI.fmtMoney(r.point_redeem_value)}`, `門檻 ${r.point_redeem_min} 點`)}
          ${stat('介紹獎勵', `${r.referral_points} 點`, '新客首次消費完成時發給介紹人')}
        </div>
        <div class="two-col">
          <div><h3>介紹排行</h3>
            ${UI.table(['介紹人', '電話', '介紹人數', '帶進業績'],
              d.top_referrers.map(x => `<tr><td>${UI.esc(x.name)}</td><td>${UI.esc(x.phone || '')}</td>
                <td class="num">${x.n}</td><td class="num">${UI.fmtMoney(x.brought)}</td></tr>`),
              '還沒有人被登記介紹人')}</div>
          <div><h3>點數排行</h3>
            ${UI.table(['客人', '電話', '點數', '可換'],
              d.top_holders.map(x => `<tr><td>${UI.esc(x.name)}</td><td>${UI.esc(x.phone || '')}</td>
                <td class="num">${UI.fmtNum(x.points)}</td>
                <td class="num">${UI.fmtMoney(x.points * r.point_redeem_value)}</td></tr>`),
              '還沒有人累到點數')}</div>
        </div>
        <h3>介紹關係（${d.referrals.length}）</h3>
        ${UI.table(['新客', '電話', '介紹人', '到店次數', '累計消費', '獎勵'],
          d.referrals.map(x => `<tr><td>${UI.esc(x.name)}</td><td>${UI.esc(x.phone || '')}</td>
            <td>${UI.esc(x.referrer_name)}</td><td class="num">${x.visits}</td>
            <td class="num">${UI.fmtMoney(x.spent)}</td>
            <td>${x.referral_paid ? UI.tag('已發放', 'ok') : UI.tag('待首次消費', 'warn')}</td></tr>`),
          '還沒有介紹關係。到「客人檔案」編輯客人，選填「介紹人」。')}`;

      body.querySelector('#pt-export').appendChild(App.exportBtn('points', () => ({})));
      body.querySelector('#btn-redeem').onclick = redeemDialog;
      body.querySelector('#btn-adjust').onclick = adjustDialog;

      function redeemDialog() {
        UI.modal({
          title: '兌換點數', submitText: '兌換',
          body: `<div class="form-grid">
              ${UI.select('member_id', '客人', App.memberOptions('請選擇客人'), { full: true })}
              ${UI.input('points', '兌換點數', { type: 'number', placeholder: `至少 ${r.point_redeem_min} 點` })}
            </div>
            <div class="notice" id="rd-hint">1 點 = ${UI.fmtMoney(r.point_redeem_value)}，兌換後會存入客人的<b>儲值贈送金</b>，
              下次消費自動優先扣抵。</div>`,
          onOpen(el2) {
            const upd = async () => {
              const id = el2.querySelector('[name=member_id]').value;
              const pts = Number(el2.querySelector('[name=points]').value) || 0;
              if (!id) return;
              const m = await GET('/loyalty/member/' + id).catch(() => null);
              el2.querySelector('#rd-hint').innerHTML = m
                ? `這位客人目前有 <b>${UI.fmtNum(m.balance)}</b> 點`
                  + (pts ? `，兌換 ${pts} 點可得 <b>${UI.fmtMoney(pts * r.point_redeem_value)}</b> 贈送金` : '')
                : '';
            };
            el2.addEventListener('change', upd);
            el2.addEventListener('input', upd);
          },
          async onSubmit(el2) {
            const f = UI.formData(el2);
            const out = await POST('/loyalty/redeem', f);
            UI.toast(`兌換 ${out.points} 點 → 贈送金 ${UI.fmtMoney(out.value)}，餘 ${out.balance} 點`);
            draw();
          }
        });
      }
      function adjustDialog() {
        UI.modal({
          title: '人工調整點數', submitText: '寫入',
          body: `<div class="form-grid">
              ${UI.select('member_id', '客人', App.memberOptions('請選擇客人'), { full: true })}
              ${UI.input('points', '增減點數（負數為扣除）', { type: 'number' })}
            </div>
            ${UI.textarea('reason', '原因（必填）', { rows: 2, placeholder: '例如：開幕活動加碼／客訴補償／輸入錯誤更正' })}`,
          async onSubmit(el2) {
            const out = await POST('/loyalty/adjust', UI.formData(el2));
            UI.toast(`已調整，餘額 ${out.balance} 點`);
            draw();
          }
        });
      }
    }
    draw();
  }
});
