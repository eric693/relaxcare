// 營運損益、預收負債、費用、營業稅

App.page('finance', {
  title: '營運損益', module: 'finance', sub: '收到的錢 ≠ 這個月的收入，這裡分開算',
  help: {
    intro: '三組數字要分清楚：現金流入是「今天收了多少」，服務營收是「損益表上的收入」，預收負債是「還欠客人的服務」。',
    steps: ['選月份看整月損益。', '往下看技師排行、項目排行與床位使用率。'],
    notes: ['底薪不在這裡扣（底薪是固定成本，登在「費用登錄」），避免同一筆錢被算兩次。',
      '毛利＝服務營收 − 技師抽成；淨利再扣掉費用。'],
    terms: [['服務營收', '客人實際做完服務才認列，含用儲值與次卡付掉的部分。'],
      ['床位使用率', '床位被佔用的分鐘 ÷ 營業時間 × 可容組數。']]
  },
  async render(el) {
    const state = { period: UI.thisMonth(), store_id: '' };
    el.innerHTML = '';
    el.appendChild(App.filterBar([
      { name: 'period', label: '月份', type: 'month', value: state.period },
      { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市') }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const d = await GET('/finance' + App.qs(state));
      // 商品成本另外抓：它來自庫存流水（賣出當下記下的成本），不是損益表自己算的。
      // 抓不到就當 0 —— 沒有進貨紀錄的店不該因此看不到損益。
      const mv = await GET('/stock/movement' + App.qs({ from: d.start, to: d.end, store_id: state.store_id }))
        .catch(() => ({ cogs: 0, purchase_amount: 0, sold_qty: 0 }));
      const r = d.revenue, c = d.cash, l = d.liability;
      const stat = (label, v, sub, cls = '') =>
        `<div class="stat ${cls}"><div class="stat-label">${label}</div><div class="stat-value">${v}</div><div class="stat-sub">${sub || ''}</div></div>`;
      body.innerHTML = `
        <div class="stat-grid">
          ${stat('服務營收', UI.fmtMoney(r.revenue), `${r.tickets} 鐘・${UI.dur(r.minutes)}`)}
          ${stat('技師抽成', UI.fmtMoney(r.commission), `占營收 ${UI.fmtPct(r.revenue ? r.commission / r.revenue : 0)}`)}
          ${stat('毛利', UI.fmtMoney(d.gross_profit), `毛利率 ${UI.fmtPct(d.margin)}`)}
          ${stat('費用', UI.fmtMoney(d.expenses.total), '房租、耗材、水電等')}
          ${stat('淨利', UI.fmtMoney(d.net_profit), `淨利率 ${UI.fmtPct(d.net_margin)}`, d.net_profit < 0 ? 'warn' : 'ok')}
          ${stat('現金流入', UI.fmtMoney(c.total), `鐘單現金 ${UI.fmtMoney(c.ticket_cash)}・儲值 ${UI.fmtMoney(c.topup)}・售卡 ${UI.fmtMoney(c.pass_sale)}`)}
          ${stat('指名鐘數', `${r.designated_tickets} / ${r.tickets}`, `指名率 ${UI.fmtPct(r.tickets ? r.designated_tickets / r.tickets : 0)}`)}
          ${stat('預收負債', UI.fmtMoney(l.total_cash_liability), `儲值 ${UI.fmtMoney(l.wallet_cash)}・次卡 ${UI.fmtMoney(l.pass_value)}`, 'warn')}
          ${stat('商品銷貨成本', UI.fmtMoney(mv.cogs),
            `商品營收 ${UI.fmtMoney(r.retail)}・毛利 ${UI.fmtMoney(r.retail - mv.cogs)}`)}
          ${stat('本月進貨', UI.fmtMoney(mv.purchase_amount), `賣出 ${mv.sold_qty} 件`)}
        </div>
        <div class="notice">商品成本來自庫存流水（賣出當下記下的成本），不是月底回頭用現在的成本套算 ——
          進價變動之後，上個月賣掉的那幾件仍然要維持當初的成本。毛利已扣掉技師抽成，未扣商品成本；
          要看含商品成本的完整損益請匯出「營運損益」CSV。</div>
        <div class="notice">收款組成：客人以現金／刷卡付了 ${UI.fmtMoney(r.paid_cash)}，
          動用儲值 ${UI.fmtMoney(r.paid_wallet)}，核銷次卡 ${UI.fmtMoney(r.paid_pass)}。
          後兩者的現金早在儲值／買卡當天就收過了，所以它們算收入、不算今天的現金流入。</div>
        <div id="fin-export"></div>
        <div id="fin-chart"></div>
        <div class="two-col">
          <div><h3>技師業績</h3>${UI.table(['技師', '鐘數', '指名率', '服務業績', '商品', '抽成', '評價'],
            d.therapists.map(t => `<tr><td>${UI.esc(t.name)}<div class="muted">${UI.esc(t.level)}</div></td>
              <td class="num">${t.tickets}</td>
              <td class="num">${UI.fmtPct(t.tickets ? t.designated / t.tickets : 0, 0)}</td>
              <td class="num">${UI.fmtMoney(t.service_amount)}</td>
              <td class="num">${UI.fmtMoney(t.retail_amount)}</td>
              <td class="num">${UI.fmtMoney(t.commission)}</td>
              <td class="num">${t.rating ? t.rating.toFixed(1) : '—'}</td></tr>`))}</div>
          <div><h3>項目排行</h3>${UI.table(['項目', '鐘數', '金額', '時數'],
            d.services.map(s => `<tr><td>${UI.esc(s.name)}</td><td class="num">${s.tickets}</td>
              <td class="num">${UI.fmtMoney(s.amount)}</td><td class="num">${UI.dur(s.minutes)}</td></tr>`))}</div>
        </div>
        <h3>床位使用率</h3>
        ${UI.table(['床位', '房型', '鐘數', '使用時數', '可用時數', '使用率'],
          d.rooms.map(r2 => `<tr><td>${UI.esc(r2.name)}</td><td>${UI.esc(r2.rtype)}</td>
            <td class="num">${r2.tickets}</td><td class="num">${UI.dur(r2.used_minutes)}</td>
            <td class="num">${UI.dur(r2.capacity_minutes)}</td>
            <td class="num">${UI.fmtPct(r2.rate, 0)}</td></tr>`))}
        <h3>費用明細</h3>
        ${UI.table(['科目', '筆數', '金額', '占比'],
          d.expenses.rows.map(e => `<tr><td>${UI.esc(e.category || '未分類')}</td><td class="num">${e.cnt}</td>
            <td class="num">${UI.fmtMoney(e.amount)}</td>
            <td class="num">${UI.fmtPct(d.expenses.total ? e.amount / d.expenses.total : 0, 0)}</td></tr>`))}`;

      const ex = document.getElementById('fin-export');
      ex.innerHTML = '';
      ex.appendChild(App.exportBtn('finance', () => ({ period: state.period, store_id: state.store_id }), '⬇ 匯出損益 CSV'));
      document.getElementById('fin-chart').innerHTML = Charts.bars({
        title: '本月每日營收',
        data: d.daily.map(x => ({ label: x.d.slice(8), values: [x.revenue] })),
        series: ['服務營收']
      }) + Charts.hbars({
        title: '技師服務業績', colorByIndex: true,
        data: d.therapists.slice(0, 10).map(t => ({ label: t.name, value: t.service_amount }))
      });
      Charts.mount(body);
    }
    draw();
  }
});

App.page('liability', {
  title: '預收負債表', module: 'liability', sub: '還沒服務完的錢：儲值餘額＋次卡未使用價值',
  help: {
    intro: '這是資產負債表上的數字，也是「哪些客人該打電話請他回來用」的名單。',
    steps: [
      '上方四個數字給會計：儲值現金與次卡價值就是要入帳的預收負債。',
      '下方兩張表給店長：60 天內到期的次卡與贈送金，照著打電話請客人回來用。',
      '要看單一客人的明細，請到「儲值金」或「次卡與套券」頁點進去。'
    ],
    notes: [
      '贈送金不是真的收到的錢，習慣上不列為負債，所以分開列。',
      '快到期的預收是最該聯繫的對象 —— 它們差一點就會變成店裡的收入，但客人會很不高興，長期看不划算。',
      '這個數字持續變大代表「賣卡賣得比做得快」，看起來現金充裕，其實是欠了愈來愈多服務。'
    ],
    terms: [
      ['預收負債', '客人已經付錢、但還沒享受到的服務。會計上是負債，不是收入。'],
      ['次卡未使用價值', '各卡的「實付÷總次數 × 剩餘次數」加總。']
    ]
  },
  async render(el) {
    const d = await GET('/liability');
    // 會計要的是可以貼進試算表的明細，不是畫面上的四個數字
    const stat = (l, v, s) => `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div><div class="stat-sub">${s || ''}</div></div>`;
    el.innerHTML = `
      <div class="stat-grid">
        ${stat('儲值現金餘額', UI.fmtMoney(d.wallet_cash), `${d.wallet_members} 個帳戶`)}
        ${stat('儲值贈送餘額', UI.fmtMoney(d.wallet_bonus), '非實收，不列負債')}
        ${stat('次卡未使用價值', UI.fmtMoney(d.pass_value), `${d.pass_count} 張・${d.pass_remain_times} 次`)}
        ${stat('預收負債合計', UI.fmtMoney(d.total_cash_liability), '儲值現金＋次卡價值')}
      </div>
      <div id="lb-export"></div>
      <h3>60 天內到期的次卡（${d.expiring_passes.length}）</h3>
      ${UI.table(['卡號', '客人', '電話', '品名', '剩餘次數', '對應價值', '到期日'],
        d.expiring_passes.map(p => `<tr><td>${UI.esc(p.pass_no)}</td><td>${UI.esc(p.member_name || '')}</td>
          <td>${UI.esc(p.phone || '')}</td><td>${UI.esc(p.name)}</td>
          <td class="num">${p.remain}</td>
          <td class="num">${UI.fmtMoney(p.unit_value * p.remain)}</td>
          <td>${UI.esc(p.expiry_date)}</td></tr>`), '沒有即將到期的次卡')}
      <h3>60 天內到期的贈送金（${d.expiring_bonus.length}）</h3>
      ${UI.table(['客人', '電話', '贈送餘額', '現金餘額', '到期日'],
        d.expiring_bonus.map(w => `<tr><td>${UI.esc(w.member_name || '')}</td><td>${UI.esc(w.phone || '')}</td>
          <td class="num">${UI.fmtMoney(w.bonus_balance)}</td>
          <td class="num">${UI.fmtMoney(w.cash_balance)}</td>
          <td>${UI.esc(w.expiry_date)}</td></tr>`), '沒有即將到期的贈送金')}`;
    el.querySelector('#lb-export').appendChild(App.exportBtn('liability', () => ({}), '⬇ 匯出預收負債明細'));
  }
});

App.page('expenses', {
  title: '費用登錄', module: 'expenses', sub: '房租、耗材、水電等營運支出',
  help: {
    intro: '房租、水電、耗材、洗滌等營運支出。技師底薪也登在這裡，才不會在損益裡被算兩次。',
    steps: [
      '按「新增費用」，選日期與科目，填對象與金額。',
      '多店經營請選門市，損益頁才能分店看。',
      '科目不夠用時到「系統設定 → 下拉選項」的 expense_categories 自行增加。'
    ],
    notes: [
      '技師的「抽成」不要登在這裡：抽成已經從鐘單自動算進損益的成本了，重複登會少算毛利。',
      '技師的「底薪」則要登（薪資頁只是試算，不會自動變成費用）。',
      '刪除是真的刪除，不是停用 —— 費用是流水帳，沒有其他單據會參照它。'
    ],
    terms: [['科目', '費用的分類，決定損益頁的費用明細怎麼分組。']]
  },
  async render(el) {
    const state = { from: UI.thisMonth() + '-01', to: UI.today(), category: '', store_id: '', q: '' };
    el.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'page-acts';
    if (App.canEdit('expenses')) top.innerHTML = '<button class="btn" id="new">＋ 新增費用</button>';
    top.appendChild(App.exportBtn('expenses', () => state));
    el.appendChild(top);
    const dialog = (e = {}) => UI.modal({
      title: e.id ? '編輯費用' : '新增費用',
      body: `<div class="form-grid">
        ${UI.select('store_id', '門市', App.storeOptions('　'), { value: e.store_id || '' })}
        ${UI.input('spend_date', '日期', { type: 'date', value: e.spend_date || UI.today() })}
        ${UI.select('category', '科目', App.opt.lists.expense_categories || [], { value: e.category || '', plain: true })}
        ${UI.input('vendor', '對象', { value: e.vendor || '' })}
        ${UI.input('amount', '金額', { type: 'number', value: e.amount || 0 })}
        ${UI.select('pay_method', '付款方式', App.listOptions('pay_methods'), { value: e.pay_method || '現金', plain: true })}
        ${UI.textarea('note', '備註', { rows: 2, value: e.note || '' })}
      </div>`,
      async onSubmit(el2) {
        const d = UI.formData(el2);
        if (e.id) await PUT(`/expenses/${e.id}`, d); else await POST('/expenses', d);
        UI.toast('已儲存'); draw();
      }
    });
    if (App.canEdit('expenses')) top.querySelector('#new').onclick = () => dialog();
    el.appendChild(App.filterBar([
      { name: 'from', label: '起', type: 'date', value: state.from },
      { name: 'to', label: '訖', type: 'date', value: state.to },
      { name: 'category', label: '科目', type: 'select', options: App.listOptions('expense_categories', '全部') },
      { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市') },
      { name: 'q', label: '搜尋', type: 'search', placeholder: '對象／備註' }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const rows = await GET('/expenses' + App.qs(state));
      const total = rows.reduce((s, r) => s + r.amount, 0);
      body.innerHTML = `<div class="notice">共 ${rows.length} 筆，合計 <b>${UI.fmtMoney(total)}</b>。</div>`
        + UI.table(['日期', '門市', '科目', '對象', '金額', '付款', '備註', ''],
          rows.map(r => `<tr><td>${UI.esc(r.spend_date)}</td><td>${UI.esc(r.store_name || '—')}</td>
            <td>${UI.esc(r.category)}</td><td>${UI.esc(r.vendor)}</td>
            <td class="num">${UI.fmtMoney(r.amount)}</td><td>${UI.esc(r.pay_method)}</td>
            <td class="muted">${UI.esc(r.note)}</td>
            <td>${App.canEdit('expenses') ? `<button class="btn tiny secondary" data-e="${r.id}">編輯</button>
              <button class="btn tiny danger" data-d="${r.id}">刪除</button>` : ''}</td></tr>`),
          '這個期間沒有費用紀錄');
      body.querySelectorAll('[data-e]').forEach(b => b.onclick = () => dialog(rows.find(x => String(x.id) === b.dataset.e)));
      body.querySelectorAll('[data-d]').forEach(b => b.onclick = async () => {
        if (!await UI.confirm('確定刪除這筆費用？')) return;
        await DEL(`/expenses/${b.dataset.d}`); UI.toast('已刪除'); draw();
      });
    }
    draw();
  }
});

App.page('tax', {
  title: '營業稅試算', module: 'tax', sub: '預收不計稅，實際服務才認列',
  help: {
    intro: '這是按摩業最容易報錯的一件事：客人儲值 2 萬，那天的現金流是 2 萬，但銷售額是 0。',
    steps: [
      '選要申報的月份。',
      '「認列營收」與「未稅銷售額」是報表上要填的數字。',
      '對照「當期現金流入」與「其中屬預收」，就能跟銀行帳與收銀機對得起來。'
    ],
    notes: [
      '拿整筆儲值去報，稅會多繳；完全不報，被查到是漏報。正確做法是客人實際消費時才認列。',
      '用儲值或次卡付掉的鐘單「算」在認列營收裡 —— 那筆錢當初收的時候沒報，現在才報。',
      '這裡是試算，實際申報請以會計師與國稅局函釋為準。'
    ],
    terms: [
      ['認列營收', '當期實際完成服務的金額，含以儲值與次卡支付的部分。'],
      ['預收', '儲值與售卡收到的錢。收款當期不計入銷售額。']
    ]
  },
  async render(el) {
    const state = { period: UI.thisMonth() };
    el.innerHTML = '';
    el.appendChild(App.filterBar([{ name: 'period', label: '月份', type: 'month', value: state.period }],
      v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);
    async function draw() {
      const d = await GET('/tax' + App.qs(state));
      body.innerHTML = `<table class="kv">
        <tr><th>期間</th><td>${UI.esc(d.period)}　稅率 ${d.rate}%</td></tr>
        <tr><th>認列營收（含稅）</th><td><b>${UI.fmtMoney(d.recognized_revenue)}</b></td></tr>
        <tr><th>未稅銷售額</th><td>${UI.fmtMoney(d.net_sales)}</td></tr>
        <tr><th>應納營業稅</th><td><b>${UI.fmtMoney(d.output_tax)}</b></td></tr>
        <tr><th>當期現金流入</th><td>${UI.fmtMoney(d.cash_in)}</td></tr>
        <tr><th>其中屬預收</th><td>${UI.fmtMoney(d.prepaid_received)}（儲值＋售卡，本期不計入銷售額）</td></tr>
      </table>
      <div class="notice">${UI.esc(d.note)}</div>`;
    }
    draw();
  }
});
