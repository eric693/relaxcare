// 薪資結算、抽成與級距、出勤與工時

App.page('payroll', {
  title: '薪資結算', module: 'payroll', sub: '底薪＋服務抽成＋銷售抽成＋指名費＋級距獎金',
  help: {
    intro: '每一鐘的抽成在「結帳當下」就算好寫死了，這頁只是加總。所以改了抽成設定，上個月的薪資不會變。',
    steps: ['選月份，按「產生／更新試算」。',
      '逐筆檢查，可填加項（全勤獎金）與扣項（勞健保自付、請假）。',
      '確認無誤按「確認」，之後重新產生就不會覆蓋這一筆。',
      '發放後按「已發放」。'],
    notes: ['技師來問「這個月怎麼只有這樣」，點該列的「明細」可以攤開每一張鐘單。',
      '級距獎金只看服務業績，不含商品與預收 —— 否則會變成鼓勵只賣卡不做鐘。']
  },
  async render(el) {
    const state = { period: UI.thisMonth() };
    el.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'page-acts';
    if (App.canEdit('payroll')) top.innerHTML = '<button class="btn" id="gen">產生／更新試算</button>';
    top.appendChild(App.exportBtn('payroll', () => state));
    el.appendChild(top);
    el.appendChild(App.filterBar([{ name: 'period', label: '月份', type: 'month', value: state.period }],
      v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);

    if (App.canEdit('payroll')) top.querySelector('#gen').onclick = async () => {
      if (!await UI.confirm(`產生 ${state.period} 的薪資試算？已確認或已發放的不會被覆蓋。`)) return;
      try {
        const r = await POST('/payroll/generate', { period: state.period });
        UI.toast(`新增 ${r.created} 筆、更新 ${r.updated} 筆${r.skipped.length ? `，略過 ${r.skipped.length} 筆已確認` : ''}`);
        draw();
      } catch (e) { UI.err(e); }
    };

    async function draw() {
      const d = await GET('/payroll' + App.qs(state));
      body.innerHTML = `<div class="notice">${state.period} 共 ${d.rows.length} 位，合計應發 <b>${UI.fmtMoney(d.total)}</b>。</div>`
        + UI.table(['技師', '級別', '底薪', '鐘數', '指名', '服務業績', '銷售業績', '服務抽成', '銷售抽成', '指名費', '級距獎金', '加/扣', '合計', '狀態', ''],
          d.rows.map(r => `<tr>
            <td>${UI.esc(r.name)}<div class="muted">${UI.esc(r.code)}</div></td>
            <td>${UI.esc(r.level)}</td>
            <td class="num">${UI.fmtMoney(r.base_salary)}</td>
            <td class="num">${r.ticket_count}<div class="muted">${UI.dur(r.minutes_total)}</div></td>
            <td class="num">${r.designate_count}</td>
            <td class="num">${UI.fmtMoney(r.service_amount)}</td>
            <td class="num">${UI.fmtMoney(r.retail_amount)}</td>
            <td class="num">${UI.fmtMoney(r.comm_service)}</td>
            <td class="num">${UI.fmtMoney(r.comm_retail)}</td>
            <td class="num">${UI.fmtMoney(r.comm_designate)}</td>
            <td class="num">${UI.fmtMoney(r.tier_bonus)}</td>
            <td class="num">${r.adjust ? `+${UI.fmtNum(r.adjust)}` : ''}${r.deduction ? ` -${UI.fmtNum(r.deduction)}` : ''}${!r.adjust && !r.deduction ? '—' : ''}</td>
            <td class="num"><b>${UI.fmtMoney(r.total)}</b></td>
            <td>${App.statusTag('payroll_status', r.status)}</td>
            <td><button class="btn tiny secondary" data-b="${r.therapist_id}">明細</button>
              ${App.canEdit('payroll') && r.status !== 'paid' ? `<button class="btn tiny secondary" data-e="${r.id}">加扣項</button>` : ''}
              ${App.canEdit('payroll') && r.status === 'draft' ? `<button class="btn tiny" data-s="${r.id}" data-v="confirmed">確認</button>` : ''}
              ${App.canEdit('payroll') && r.status === 'confirmed' ? `<button class="btn tiny" data-s="${r.id}" data-v="paid">已發放</button>` : ''}
            </td></tr>`),
          '這個月還沒有薪資試算，按上方「產生／更新試算」');

      body.querySelectorAll('[data-b]').forEach(b => b.onclick = () => breakdown(Number(b.dataset.b)));
      body.querySelectorAll('[data-e]').forEach(b => b.onclick = () => {
        const r = d.rows.find(x => String(x.id) === b.dataset.e);
        UI.modal({
          title: `${r.name} ${r.period} 加扣項`,
          body: `<div class="form-grid">
            ${UI.input('adjust', '加項（獎金、補貼）', { type: 'number', value: r.adjust })}
            ${UI.input('deduction', '扣項（勞健保自付、請假、賠償）', { type: 'number', value: r.deduction })}
            ${UI.textarea('note', '說明', { rows: 2, value: r.note || '' })}
          </div>`,
          async onSubmit(e) { await PUT(`/payroll/${r.id}`, UI.formData(e)); UI.toast('已更新'); draw(); }
        });
      });
      body.querySelectorAll('[data-s]').forEach(b => b.onclick = async () => {
        const v = b.dataset.v;
        if (!await UI.confirm(v === 'confirmed'
          ? '確認後這筆薪資不會再被「重新產生」覆蓋，確定嗎？' : '標記為已發放？')) return;
        try { await POST(`/payroll/${b.dataset.s}/status`, { status: v }); UI.toast('已更新'); draw(); }
        catch (e) { UI.err(e); }
      });
    }

    async function breakdown(therapistId) {
      const d = await GET(`/payroll/breakdown/${therapistId}` + App.qs(state));
      const s = d.summary;
      UI.modal({
        title: `${s.therapist.name}　${state.period} 薪資明細`, wide: true, hideFooter: true,
        body: `<table class="kv">
          <tr><th>底薪</th><td>${UI.fmtMoney(s.base_salary)}</td></tr>
          <tr><th>服務業績</th><td>${UI.fmtMoney(s.service_amount)}（其中指名 ${UI.fmtMoney(s.designated_amount)}）
            → 抽成 <b>${UI.fmtMoney(s.comm_service)}</b></td></tr>
          <tr><th>商品業績</th><td>${UI.fmtMoney(s.retail_amount)} → 抽成 ${UI.fmtMoney(s.comm_retail)}</td></tr>
          <tr><th>預收銷售</th><td>儲值 ${UI.fmtMoney(s.prepaid_topup)}（${s.prepaid_topup_count} 筆）＋
            次卡 ${UI.fmtMoney(s.prepaid_pass)}（${s.prepaid_pass_count} 張） → 抽成 ${UI.fmtMoney(s.comm_prepaid)}</td></tr>
          <tr><th>指名費</th><td>${s.designate_count} 次 → ${UI.fmtMoney(s.comm_designate)}</td></tr>
          <tr><th>級距獎金</th><td>${s.tier ? `${UI.esc(s.tier.label)}　+${s.tier.bonus_pct}% → ${UI.fmtMoney(s.tier_bonus)}` : '未達門檻'}</td></tr>
          <tr><th>小計（未含加扣項）</th><td><b>${UI.fmtMoney(s.total_before_adjust)}</b></td></tr>
        </table>
        <h4>鐘單明細（${d.tickets.length} 張）</h4>
        ${UI.table(['日期', '單號', '客人', '項目', '分', '指派', '金額', '抽成％', '服務抽成', '商品抽成', '指名費'],
          d.tickets.map(t => `<tr><td>${UI.esc(t.at.slice(5, 16))}</td><td>${UI.esc(t.ticket_no)}</td>
            <td>${UI.esc(t.customer || '—')}</td><td>${UI.esc(t.service_name)}</td>
            <td class="num">${t.minutes}</td><td>${App.statusTag('assign_type', t.assign_type)}</td>
            <td class="num">${UI.fmtMoney(t.amount - t.discount)}</td>
            <td class="num">${t.comm_pct_used}%</td>
            <td class="num">${UI.fmtMoney(t.comm_service)}</td>
            <td class="num">${UI.fmtMoney(t.comm_retail)}</td>
            <td class="num">${UI.fmtMoney(t.comm_designate)}</td></tr>`))}
        ${d.others.length ? `<h4>掛在他人單上的加鐘／商品</h4>${UI.table(['日期', '單號', '項目', '金額', '抽成'],
          d.others.map(o => `<tr><td>${UI.esc(o.at.slice(5, 16))}</td><td>${UI.esc(o.ticket_no)}</td>
            <td>${UI.esc(o.name)}</td><td class="num">${UI.fmtMoney(o.amount)}</td>
            <td class="num">${UI.fmtMoney(o.comm_amount)}</td></tr>`))}` : ''}
        ${d.prepaid.length ? `<h4>預收銷售</h4>${UI.table(['日期', '類型', '客人', '金額', '抽成'],
          d.prepaid.map(p => `<tr><td>${UI.esc(String(p.at).slice(0, 16))}</td>
            <td>${p.kind === 'topup' ? '儲值' : '次卡'}</td><td>${UI.esc(p.customer || '')}</td>
            <td class="num">${UI.fmtMoney(p.amount)}</td><td class="num">${UI.fmtMoney(p.comm_amount)}</td></tr>`))}` : ''}`
      });
    }
    draw();
  }
});

App.page('commission', {
  title: '抽成與級距', module: 'commission', sub: '級別預設％、指名費與業績級距獎金',
  help: {
    intro: '這頁改的是「未來」的抽成。已結帳的鐘單抽成寫死在單據上，不會因為這裡的調整而改變。',
    steps: ['上半部設定每個級別的預設抽成％與指名費。',
      '下半部設定業績級距：月服務業績落在哪一級，對總服務業績再加給％。'],
    terms: [['向客人加收的指名費', '結帳時加在帳單上的金額。'],
      ['技師實拿的指名費', '每被指名一次給技師的金額。兩者可以不一樣，差額是店裡的。']]
  },
  async render(el) {
    const d = await GET('/commission/levels');
    const tiers = await GET('/commission_tiers?active=all');
    const editable = App.canEdit('commission');
    el.innerHTML = `
      <h3>級別預設抽成</h3>
      <div class="table-wrap"><table class="list"><thead><tr>
        <th>級別</th><th>輪鐘抽成％</th><th>指名抽成％</th><th>商品抽成％</th><th>指名費（技師實拿）</th></tr></thead>
        <tbody>${d.levels.map(l => `<tr data-lv="${UI.esc(l.level)}">
          <td>${UI.esc(l.level)}</td>
          <td><input type="number" data-f="normal" value="${l.normal}" ${editable ? '' : 'disabled'}></td>
          <td><input type="number" data-f="designated" value="${l.designated}" ${editable ? '' : 'disabled'}></td>
          <td><input type="number" data-f="retail" value="${l.retail}" ${editable ? '' : 'disabled'}></td>
          <td><input type="number" data-f="fee" value="${l.fee}" ${editable ? '' : 'disabled'}></td></tr>`).join('')}
        </tbody></table></div>
      <div class="form-grid">
        ${UI.input('designate_fee_charge', '向客人加收的指名費', { type: 'number', value: d.designate_fee_charge })}
        ${UI.input('prepaid_commission_pct', '儲值／次卡銷售抽成％', { type: 'number', value: d.prepaid_commission_pct })}
      </div>
      ${editable ? '<button class="btn" id="save-lv">儲存級別設定</button>' : ''}
      <h3>業績級距獎金</h3>
      <div class="notice">級距只看「服務業績」，不含商品與預收銷售。級別留空＝適用所有人。</div>
      ${editable ? '<button class="btn secondary" id="new-tier">＋ 新增級距</button>' : ''}
      <div id="tier-list"></div>`;

    if (editable) {
      el.querySelector('#save-lv').onclick = async () => {
        const levels = [...el.querySelectorAll('[data-lv]')].map(tr => ({
          level: tr.dataset.lv,
          ...Object.fromEntries([...tr.querySelectorAll('[data-f]')].map(i => [i.dataset.f, Number(i.value) || 0]))
        }));
        const g = UI.formData(el);
        try {
          await PUT('/commission/levels', { levels, designate_fee_charge: g.designate_fee_charge, prepaid_commission_pct: g.prepaid_commission_pct });
          UI.toast('已儲存'); await App.refreshOptions();
        } catch (e) { UI.err(e); }
      };
      el.querySelector('#new-tier').onclick = () => tierDialog({});
    }

    function tierDialog(t) {
      UI.modal({
        title: t.id ? '編輯級距' : '新增級距',
        body: `<div class="form-grid">
          ${UI.select('level', '適用級別（留空＝全部）', [''].concat(App.opt.lists.therapist_levels || []), { value: t.level || '', plain: true })}
          ${UI.input('min_amount', '月服務業績下限', { type: 'number', value: t.min_amount || 0 })}
          ${UI.input('max_amount', '上限（0＝無上限）', { type: 'number', value: t.max_amount || 0 })}
          ${UI.input('bonus_pct', '加給％', { type: 'number', value: t.bonus_pct || 0 })}
          ${UI.input('label', '說明', { value: t.label || '', full: true })}
        </div>`,
        async onSubmit(e) {
          const d2 = UI.formData(e);
          if (t.id) await PUT(`/commission_tiers/${t.id}`, d2); else await POST('/commission_tiers', d2);
          UI.toast('已儲存'); App.reload();
        }
      });
    }

    el.querySelector('#tier-list').innerHTML = UI.table(
      ['適用級別', '業績區間', '加給％', '說明', ''],
      tiers.map(t => `<tr class="${t.active ? '' : 'row-muted'}">
        <td>${UI.esc(t.level || '全部')}</td>
        <td>${UI.fmtMoney(t.min_amount)} ~ ${t.max_amount ? UI.fmtMoney(t.max_amount) : '無上限'}</td>
        <td class="num">${t.bonus_pct}%</td>
        <td>${UI.esc(t.label)}</td>
        <td>${editable ? `<button class="btn tiny secondary" data-t="${t.id}">編輯</button>
          ${t.active ? `<button class="btn tiny danger" data-dt="${t.id}">停用</button>` : ''}` : ''}</td></tr>`));
    el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => tierDialog(tiers.find(x => String(x.id) === b.dataset.t)));
    el.querySelectorAll('[data-dt]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('停用這個級距？')) return;
      await DEL(`/commission_tiers/${b.dataset.dt}`); App.reload();
    });
  }
});

App.page('attendance', {
  title: '出勤與工時', module: 'attendance', sub: '在店時間、上鐘時間、輪到幾次',
  help: {
    intro: '技師最在意的公平性就看這張表：同一天誰輪了幾次、做了幾個鐘、賺了多少。',
    steps: [
      '選日期區間（預設最近七天），要看單一門市就選門市。',
      '同一天的資料照簽到序排，可以直接比較「同樣時間到店的人，接到的鐘差多少」。',
      '黃色底的列是當日服務時數超過上限的人，要留意過勞。',
      '有爭議時搭配「輪鐘檯」的輪序軌跡看，那邊有每一次被跳過的原因。'
    ],
    notes: [
      '上鐘率長期低於三成，通常不是技師的問題，是排班過剩 —— 人太多，鐘不夠分。',
      '在店時間算到簽退為止；還沒簽退的人算到現在，所以當天的數字會一直長。'
    ],
    terms: [
      ['上鐘率', '實際服務時間 ÷ 在店時間。'],
      ['已輪次數', '透過輪鐘接到的客人數（指名依設定預設不計）。'],
      ['簽到序', '當天第幾個到店。輪序先比輪次、再比這個號碼。']
    ]
  },
  async render(el) {
    const state = { from: UI.addDays(UI.today(), -6), to: UI.today(), store_id: '' };
    el.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'page-acts';
    top.appendChild(App.exportBtn('attendance', () => state));
    el.appendChild(top);
    el.appendChild(App.filterBar([
      { name: 'from', label: '起', type: 'date', value: state.from },
      { name: 'to', label: '訖', type: 'date', value: state.to },
      { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市') }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const rows = await GET('/attendance' + App.qs(state));
      body.innerHTML = UI.table(
        ['日期', '技師', '簽到序', '簽到', '簽退', '在店', '鐘數', '指名', '服務時間', '上鐘率', '已輪', '業績'],
        rows.map(r => `<tr class="${r.over_limit ? 'row-warn' : ''}">
          <td>${UI.esc(r.work_date)}</td>
          <td>${UI.esc(r.name)}<div class="muted">${UI.esc(r.level)}</div></td>
          <td class="num">${r.queue_seq}</td>
          <td>${UI.hhmm(r.checkin_at) || '—'}</td>
          <td>${UI.hhmm(r.checkout_at) || '—'}</td>
          <td class="num">${UI.dur(r.on_site_minutes)}</td>
          <td class="num">${r.tickets}</td>
          <td class="num">${r.designated}</td>
          <td class="num">${UI.dur(r.minutes)}</td>
          <td class="num">${UI.fmtPct(r.utilization, 0)}</td>
          <td class="num">${r.rounds}</td>
          <td class="num">${UI.fmtMoney(r.amount)}</td></tr>`),
        '這個期間沒有出勤紀錄');
    }
    draw();
  }
});
