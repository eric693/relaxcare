// 儀表板、輪鐘檯、排鐘看板

// ---------- 儀表板 ----------
App.page('dashboard', {
  title: '營運儀表板', module: 'dashboard', sub: '今天的鐘、今天的錢、今天該處理的事',
  help: {
    intro: '一天開始與結束時各看一次。上半部是今天，下半部是本月與趨勢。',
    steps: [
      '看「等鐘／上鐘中」確認人力夠不夠，下一位輪到誰會直接寫在上面。',
      '看「待辦」區的紅字：新預約、客訴、證照到期、快過期的次卡，點數字會跳到該頁。',
      '月營收與預收負債分開看 —— 收到的錢不等於這個月的收入。'
    ],
    terms: [
      ['服務營收', '客人實際做完服務才認列的收入，含用儲值與次卡付掉的部分。'],
      ['現金流入', '今天實際收進來的錢，含儲值與賣卡（那是負債，不是收入）。'],
      ['預收負債', '儲值餘額＋次卡未使用價值，是「還欠客人的服務」。']
    ]
  },
  async render(el) {
    const d = await GET('/dashboard');
    const a = d.alerts, t = d.today, m = d.month;
    // 數字型的值用等寬數字不換行；「0 上鐘 / 0 等鐘」這種句子型的值改用小一號字並允許換行
    const card = (label, value, sub, cls = '', text = false) =>
      `<div class="stat ${cls}"><div class="stat-label">${UI.esc(label)}</div>
        <div class="stat-value${text ? ' text' : ''}">${value}</div><div class="stat-sub">${sub || ''}</div></div>`;
    const alert = (n, label, hash) => n
      ? `<a class="badge-alert" href="#${hash}">${UI.esc(label)} <b>${n}</b></a>` : '';

    const alerts = [
      alert(a.cert_expired, '證照已過期', 'expiry'),
      alert(a.cert_missing, '證照未登錄', 'expiry'),
      alert(a.cert_soon, '證照即將到期', 'expiry'),
      alert(a.new_bookings, '待處理線上預約', 'bookings'),
      alert(a.open_issues, '未結案客訴', 'issues'),
      alert(a.expiring_passes, '次卡 30 天內到期', 'liability'),
      alert(a.repurchase, '待回訪客人', 'repurchase'),
      alert(a.low_stock, '商品低於安全庫存', 'purchase'),
      alert(a.unclosed_days, '營業日未日結', 'closing'),
      alert(a.missing_invoices, '已結帳未開發票', 'invoices'),
      alert(a.consent_missing, '同意書未簽或逾期', 'compliance')
    ].filter(Boolean).join('');

    el.innerHTML = `
      <div class="stat-grid">
        ${card('今日鐘數', UI.fmtNum(t.tickets), `指名 ${t.designated_tickets} 鐘・服務 ${UI.dur(t.minutes)}`)}
        ${card('今日服務營收', UI.fmtMoney(t.revenue), `技師抽成 ${UI.fmtMoney(t.commission)}`)}
        ${card('今日現金流入', UI.fmtMoney(t.cash.total), `含儲值 ${UI.fmtMoney(t.cash.topup)}・售卡 ${UI.fmtMoney(t.cash.pass_sale)}`)}
        ${card('檯面', `${t.serving} 上鐘 ／ ${t.waiting} 等鐘`, `在班 ${t.on_duty} 人・預約待到 ${t.booked} 組`, '', true)}
        ${card('下一位輪鐘', t.next ? UI.esc(t.next.name) : '—',
          t.next ? `第 ${t.next.queue_seq} 號・今日已輪 ${t.next.rounds} 次` : '目前沒有人在等鐘', t.next ? 'ok' : '', true)}
        ${card('本月服務營收', UI.fmtMoney(m.revenue), `${m.tickets} 鐘・抽成 ${UI.fmtMoney(m.commission)}`)}
        ${card('本月費用', UI.fmtMoney(m.expenses), `毛利 ${UI.fmtMoney(m.revenue - m.commission - m.expenses)}`)}
        ${card('預收負債', UI.fmtMoney(d.liability.total_cash_liability),
          `儲值 ${UI.fmtMoney(d.liability.wallet_cash)}・次卡 ${UI.fmtMoney(d.liability.pass_value)}`, 'warn')}
      </div>
      ${alerts ? `<div class="alert-bar">${alerts}</div>` : '<div class="notice ok">✓ 目前沒有待處理的異常</div>'}
      <div id="dash-charts"></div>
      <div class="two-col">
        <div><h3>本月技師排行</h3>${UI.table(['技師', '鐘數', '指名', '服務業績', '抽成'],
          d.top_therapists.map(r => `<tr><td>${UI.esc(r.name)} <span class="muted">${UI.esc(r.level)}</span></td>
            <td class="num">${r.tickets}</td>
            <td class="num">${r.designated}<span class="muted"> ${r.tickets ? Math.round(r.designated / r.tickets * 100) : 0}%</span></td>
            <td class="num">${UI.fmtMoney(r.service_amount)}</td>
            <td class="num">${UI.fmtMoney(r.commission)}</td></tr>`))}</div>
        <div><h3>本月熱門項目</h3>${UI.table(['項目', '鐘數', '金額'],
          d.top_services.map(r => `<tr><td>${UI.esc(r.name)}</td><td class="num">${r.tickets}</td>
            <td class="num">${UI.fmtMoney(r.amount)}</td></tr>`))}</div>
      </div>`;

    // 營收與鐘數是兩種單位，硬塞進同一個座標軸只能靠「乘以 1000」這種把戲，
    // 看的人得先在心裡除回去 —— 不如分成兩張圖，各自用自己的刻度。
    const days = d.trend.length;
    const totalTickets = d.trend.reduce((s, x) => s + x.tickets, 0);
    const avgRevenue = days ? Math.round(d.trend.reduce((s, x) => s + x.revenue, 0) / days) : 0;
    document.getElementById('dash-charts').innerHTML =
      Charts.bars({
        title: '近 30 天服務營收',
        data: d.trend.map(x => ({ label: x.d.slice(5).replace('-', '/'), values: [x.revenue] })),
        series: ['服務營收'],
        note: `日均 ${UI.fmtMoney(avgRevenue)}，期間共 ${UI.fmtNum(totalTickets)} 鐘。日期標籤會依寬度自動疏化，滑過長條看單日數字。`
      })
      + Charts.bars({
        title: '近 30 天鐘數',
        data: d.trend.map(x => ({ label: x.d.slice(5).replace('-', '/'), values: [x.tickets] })),
        series: ['鐘數'], fmt: v => `${UI.fmtNum(v)} 鐘`, height: 220
      })
      + Charts.hbars({
        title: '本月技師服務業績', colorByIndex: true,
        data: d.top_therapists.map(t => ({ label: t.name, value: t.service_amount }))
      });
  }
});

// ---------- 輪鐘檯 ----------
App.page('queue', {
  title: '輪鐘檯', module: 'queue', sub: '誰該上鐘、誰在休息、輪序怎麼變的都寫在這裡',
  help: {
    intro: '輪序＝先比「已輪次數」，再比「簽到順序」。輪過的人自動排到隊尾，補簽到的人插進來也不會亂。',
    steps: [
      '技師到店按「簽到」，系統給當日號碼（第幾個到就是第幾號）。',
      '排頭那位就是下一個輪鐘的人，卡片會標成綠色並寫「下一位」。',
      '吃飯、抽菸、身體不適按「休息」並填時間，時間到會自動回到輪序。',
      '要喬順序按「調整」，必須填原因 —— 原因會進軌跡，日後有爭議查得到。'
    ],
    notes: [
      '指名預設「不吃輪」：被指名做完回來還是排原本的位置，否則紅牌會被指名指到接不到輪鐘。這個行為可在系統設定改。',
      '每一次簽到、指派、跳過、調整都會寫進輪序軌跡，下方可以查。'
    ],
    terms: [
      ['已輪次數', '今天透過輪鐘接到的客人數。指名不計（依設定）。'],
      ['被跳過', '輪鐘指派給了排在你後面的人。系統會自動記錄，不必自己記。']
    ]
  },
  async render(el) {
    const state = { date: App.pageQuery.get('date') || UI.today(), store_id: '' };
    el.innerHTML = '';
    const bar = App.filterBar([
      { name: 'date', label: '日期', type: 'date', value: state.date },
      { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市'), value: '' }
    ], v => { Object.assign(state, v); draw(); });
    el.appendChild(bar);
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const [b, absent] = await Promise.all([
        GET('/queue' + App.qs(state)),
        GET('/queue/absent' + App.qs(state))
      ]);
      const nextId = b.next ? b.next.therapist_id : null;
      const rule = b.rules.designate_counts ? '指名<b>計入</b>輪次' : '指名<b>不計</b>輪次';

      const cards = b.list.map(t => {
        const isNext = t.therapist_id === nextId;
        const cur = t.current;
        return `<div class="q-card q-${t.status}${isNext ? ' q-next' : ''}">
          <div class="q-head">
            <span class="q-seq">${t.queue_seq}</span>
            <div><b>${UI.esc(t.name)}</b>${t.nickname ? ` <span class="muted">${UI.esc(t.nickname)}</span>` : ''}
              <div class="muted">${UI.esc(t.level)}${t.is_blind ? '・視障按摩' : ''}</div></div>
            ${App.statusTag('shift_status', t.status)}${isNext ? UI.tag('下一位', 'ok') : ''}
          </div>
          <div class="q-stats">
            <span>已輪 <b>${t.rounds}</b> 次</span>
            <span>今日 <b>${t.ticket_count}</b> 鐘</span>
            <span>指名 <b>${t.designate_count}</b></span>
            <span>${UI.dur(t.minutes_total)}</span>
            <span>${UI.fmtMoney(t.amount_total)}</span>
          </div>
          ${cur ? `<div class="q-current">服務中：${UI.esc(cur.service_name)}　${UI.hhmm(cur.start_at)}~${UI.hhmm(cur.end_at)}
            ${cur.assign_type === 'designated' ? UI.tag('指名', 'ok') : ''}</div>` : ''}
          ${t.status === 'resting' && t.rest_until ? `<div class="q-current">休息至 ${UI.hhmm(t.rest_until)}</div>` : ''}
          <div class="q-acts">
            ${t.status === 'resting' ? `<button class="btn tiny" data-act="resume" data-id="${t.therapist_id}">回到輪序</button>` : ''}
            ${t.status === 'waiting' ? `<button class="btn tiny secondary" data-act="rest" data-id="${t.therapist_id}">休息</button>` : ''}
            ${t.status !== 'off' ? `<button class="btn tiny secondary" data-act="checkout" data-id="${t.therapist_id}">下班</button>` : ''}
            ${t.status === 'off' ? `<button class="btn tiny" data-act="checkin" data-id="${t.therapist_id}">重新上工</button>` : ''}
            <button class="btn tiny secondary" data-act="adjust" data-id="${t.therapist_id}"
              data-seq="${t.queue_seq}" data-rounds="${t.rounds}">調整</button>
            <button class="btn tiny secondary" data-act="notify" data-id="${t.therapist_id}">班表通知</button>
          </div>
        </div>`;
      }).join('');

      body.innerHTML = `
        <div class="notice">現行規則：${rule}；下鐘後整理 ${b.rules.rest_min} 分鐘才回到輪序；
          每日時數上限 ${UI.dur(b.rules.daily_minutes_max)}。可在系統設定調整。</div>
        <div class="q-grid">${cards || '<div class="empty">今天還沒有人簽到</div>'}</div>
        <h3>尚未簽到（${absent.length}）</h3>
        <div class="chip-row">${absent.map(t =>
          `<button class="chip" data-act="checkin" data-id="${t.id}">＋ ${UI.esc(t.code)} ${UI.esc(t.name)}</button>`).join('')
          || '<span class="muted">全員都簽到了</span>'}</div>
        <h3>輪序軌跡</h3>
        <div id="q-logs"><div class="empty">載入中…</div></div>`;

      body.querySelectorAll('[data-act]').forEach(btn => { btn.onclick = () => act(btn); });
      const logs = await GET('/queue/logs' + App.qs({ date: state.date }));
      document.getElementById('q-logs').innerHTML = UI.table(
        ['時間', '技師', '事件', '序號', '輪次', '說明', '經手'],
        logs.map(l => `<tr>
          <td>${UI.esc(l.created_at.slice(11, 16))}</td>
          <td>${UI.esc(l.therapist_name)}</td>
          <td>${App.statusTag('queue_event', l.event)}</td>
          <td class="num">${l.seq_after ?? '—'}</td>
          <td class="num">${l.rounds_before !== null && l.rounds_before !== undefined
            ? `${l.rounds_before} → ${l.rounds_after}` : (l.rounds_after ?? '—')}</td>
          <td>${UI.esc(l.reason || '')}</td>
          <td>${UI.esc(l.actor || '')}</td></tr>`),
        '這一天沒有輪序異動紀錄');
    }

    async function act(btn) {
      const id = Number(btn.dataset.id), a = btn.dataset.act;
      try {
        if (a === 'checkin') { await POST('/queue/checkin', { therapist_id: id, work_date: state.date, store_id: state.store_id || undefined }); UI.toast('已簽到'); }
        else if (a === 'resume') { await POST('/queue/resume', { therapist_id: id, work_date: state.date }); UI.toast('已回到輪序'); }
        else if (a === 'rest') return restDialog(id);
        else if (a === 'checkout') return checkoutDialog(id);
        else if (a === 'adjust') return adjustDialog(btn);
        else if (a === 'notify') return notifyDialog(id);
        draw();
      } catch (e) { UI.err(e); }
    }

    function restDialog(id) {
      UI.modal({
        title: '登記休息', submitText: '確定',
        body: `<div class="form-grid">
          ${UI.select('minutes', '休息多久', [['0', '不設定（要人工恢復）'], ['10', '10 分鐘'], ['15', '15 分鐘'],
            ['30', '30 分鐘'], ['45', '45 分鐘'], ['60', '1 小時']], { value: '30', plain: true })}
          ${UI.inputList('reason', '原因', ['用餐', '休息', '抽菸', '身體不適', '私事外出'], { value: '休息', full: true })}
        </div><div class="muted">休息期間不會被排到輪鐘；設定的時間到了會自動回到輪序。</div>`,
        onSubmit: async e => { await POST('/queue/rest', { therapist_id: id, work_date: state.date, ...UI.formData(e) }); UI.toast('已登記休息'); draw(); }
      });
    }
    function checkoutDialog(id) {
      UI.modal({
        title: '技師下班', submitText: '確定下班',
        body: `<div class="form-grid">${UI.inputList('reason', '原因（可留空）', ['正常下班', '提早下班', '請假', '身體不適'], { full: true })}</div>`,
        onSubmit: async e => { await POST('/queue/checkout', { therapist_id: id, work_date: state.date, ...UI.formData(e) }); UI.toast('已下班'); draw(); }
      });
    }
    function adjustDialog(btn) {
      UI.modal({
        title: '人工調整輪序', submitText: '確定調整',
        body: `<div class="form-grid">
          ${UI.input('queue_seq', '簽到序號', { type: 'number', value: btn.dataset.seq })}
          ${UI.input('rounds', '已輪次數', { type: 'number', value: btn.dataset.rounds })}
          ${UI.textarea('reason', '調整原因（必填）', { rows: 2, placeholder: '例：早上系統當機沒簽到，補回原本的順序' })}
        </div>
        <div class="notice warn">調整原因會寫進輪序軌跡並保留，日後技師有疑問時是唯一的依據。</div>`,
        onSubmit: async e => {
          const d = UI.formData(e);
          if (!d.reason) { UI.toast('請填寫調整原因', true); return false; }
          await POST('/queue/adjust', { therapist_id: Number(btn.dataset.id), work_date: state.date, ...d });
          UI.toast('已調整'); draw();
        }
      });
    }
    async function notifyDialog(id) {
      const r = await POST('/notifications/therapist', { therapist_id: id, work_date: state.date });
      UI.modal({
        title: `班表通知（${twLabel('notify_status', r.status)}）`, hideFooter: true,
        body: `<pre class="msg-preview">${UI.esc(r.text)}</pre>
          ${r.status === 'simulated' ? '<div class="notice">目前未設定 LINE Token，訊息只寫入通知紀錄，沒有真的送出。</div>' : ''}
          ${r.error ? `<div class="notice danger">${UI.esc(r.error)}</div>` : ''}`
      });
    }

    draw();
  }
});

// ---------- 排鐘看板 ----------
App.page('board', {
  title: '排鐘看板', module: 'board', sub: '技師與床位的時間軸，一眼看出哪裡塞得下',
  help: {
    intro: '橫軸是時間，每一列是一位技師或一個床位。色塊就是鐘單，點下去可以看細節。',
    steps: ['先看「技師」分頁確認人有沒有空，再看「床位」分頁確認房間有沒有空。',
      '色塊重疊代表衝突 —— 開單時系統會擋，但手動改過時間的單要自己留意。'],
    terms: [['灰色列', '該技師今天沒有簽到，不會被排到輪鐘。']]
  },
  async render(el) {
    const state = { date: App.pageQuery.get('date') || UI.today(), store_id: '', view: 'therapist' };
    el.innerHTML = '';
    el.appendChild(App.filterBar([
      { name: 'date', label: '日期', type: 'date', value: state.date },
      { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市'), value: '' }
    ], v => { Object.assign(state, v); draw(); }));
    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    tabs.innerHTML = `<button data-view="therapist" class="active">依技師</button><button data-view="room">依床位</button>`;
    tabs.onclick = e => {
      const b = e.target.closest('[data-view]'); if (!b) return;
      state.view = b.dataset.view;
      tabs.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      draw();
    };
    el.appendChild(tabs);
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const b = await GET('/board' + App.qs({ date: state.date, store_id: state.store_id }));
      const toMin = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
      const open = toMin(b.open_time), close = Math.max(open + 60, toMin(b.close_time));
      const span = close - open;
      const hours = [];
      for (let h = Math.floor(open / 60); h <= Math.ceil(close / 60); h++) hours.push(h);

      const rows = state.view === 'therapist'
        ? b.therapists.map(t => ({ id: t.id, label: `${t.code} ${t.name}`,
            sub: t.shift_status ? `${twLabel('shift_status', t.shift_status)}・第 ${t.queue_seq} 號・已輪 ${t.rounds}` : '未簽到',
            off: !t.shift_status, key: 'therapist_id' }))
        : b.rooms.map(r => ({ id: r.id, label: r.name, sub: `${r.rtype}${r.capacity > 1 ? `・可容 ${r.capacity}` : ''}`,
            off: false, key: 'room_id' }));

      const lines = rows.map(r => {
        const mine = b.tickets.filter(t => t[r.key] === r.id);
        const blocks = mine.map(t => {
          const s = Math.max(open, toMin(t.start_at.slice(11)));
          const e = Math.min(close, toMin(t.end_at.slice(11)) || s + t.minutes);
          const left = ((s - open) / span * 100).toFixed(2);
          const w = Math.max(1.2, ((e - s) / span * 100)).toFixed(2);
          return `<div class="tl-block tl-${t.status}${t.assign_type === 'designated' ? ' tl-des' : ''}"
            style="left:${left}%;width:${w}%" data-id="${t.id}"
            title="${UI.esc(`${t.ticket_no} ${UI.hhmm(t.start_at)}~${UI.hhmm(t.end_at)} ${t.customer} ${t.service_name}`)}">
            <span>${UI.esc(t.customer)}・${UI.esc(t.service_name)}</span></div>`;
        }).join('');
        return `<div class="tl-row${r.off ? ' tl-off' : ''}">
          <div class="tl-name"><b>${UI.esc(r.label)}</b><small>${UI.esc(r.sub)}</small></div>
          <div class="tl-track">${blocks}</div></div>`;
      }).join('');

      body.innerHTML = `
        <div class="timeline">
          <div class="tl-row tl-head"><div class="tl-name"></div><div class="tl-track">
            ${hours.map(h => `<span class="tl-hour" style="left:${((h * 60 - open) / span * 100).toFixed(2)}%">${h}:00</span>`).join('')}
          </div></div>
          ${lines || '<div class="empty">這一天沒有可排的資源</div>'}
        </div>
        <div class="legend-row">
          <span class="lg lg-booked">已預約</span><span class="lg lg-serving">服務中</span>
          <span class="lg lg-done">已完成</span><span class="lg lg-des">粗框＝指名</span>
        </div>`;
      body.querySelectorAll('.tl-block').forEach(b2 => {
        b2.onclick = () => Tickets.detail(Number(b2.dataset.id), draw);
      });
    }
    draw();
  }
});
