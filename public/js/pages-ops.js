// 日結與交班、班表

App.page('closing', {
  title: '日結與交班', module: 'closing', sub: '應有現金是系統算的，實點現金是人數的 —— 差額要留下來，不是改到一樣',
  help: {
    intro: '換班或打烊時對一次現金抽屜。系統先算出「這一班應該有多少現金」，你點鈔輸入面額，差額自動出來。',
    steps: [
      '選營業日與班別，確認統計區間（跨午夜的店預設就是整個營業日）。',
      '按「開始點鈔」，一格一格填各面額的張數，合計會自動加。',
      '差額超過容忍值時一定要寫原因，寫完才存得起來。',
      '填「交班給誰」，按確認日結。已確認的日結不能改，只能作廢重開。'
    ],
    notes: [
      '刷卡與行動支付不進抽屜，它們列在旁邊給你跟收單機對，不要加進點鈔。',
      '動用儲值、次卡、團購券完全不是現金 —— 那些錢在客人儲值或買券的當天就收過了。',
      '「未結營業日」是最該先看的：漏結的那一天，事後幾乎查不出短少是誰的班。'
    ],
    terms: [
      ['應有現金', '零用金＋鐘單收現＋儲值收現＋售卡收現－現金支出－現金退款。'],
      ['短溢', '實點－應有。負數是短少，正數是溢收；兩種都要有人說明。']
    ]
  },
  async render(el) {
    const state = { biz_date: UI.today(), store_id: '', shift_label: '', from: UI.addDays(UI.today(), -13), to: UI.today() };
    el.innerHTML = '';
    el.appendChild(App.filterBar([
      { name: 'biz_date', label: '營業日', type: 'date', value: state.biz_date },
      { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市') }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const [pv, list] = await Promise.all([
        GET('/closing/preview' + App.qs({ biz_date: state.biz_date, store_id: state.store_id })),
        GET('/closing' + App.qs({ from: state.from, to: state.to, store_id: state.store_id }))
      ]);
      const stat = (l, v, s, cls = '') =>
        `<div class="stat ${cls}"><div class="stat-label">${l}</div><div class="stat-value">${v}</div><div class="stat-sub">${s || ''}</div></div>`;
      body.innerHTML = `
        <div class="stat-grid">
          ${stat('應有現金', UI.fmtMoney(pv.expected_cash), `零用金 ${UI.fmtMoney(pv.open_float)}`, 'ok')}
          ${stat('鐘單收現', UI.fmtMoney(pv.ticket_cash), `${pv.tickets} 張已結帳`)}
          ${stat('儲值／售卡收現', UI.fmtMoney(pv.topup_cash + pv.pass_cash), `儲值 ${UI.fmtMoney(pv.topup_cash)}・售卡 ${UI.fmtMoney(pv.pass_cash)}`)}
          ${stat('現金支出／退款', UI.fmtMoney(pv.cash_expense + pv.cash_refund),
            pv.cash_expense_outside ? `另有 ${UI.fmtMoney(pv.cash_expense_outside)} 登錄在其他時段` : '從抽屜拿出去的',
            pv.cash_expense_outside ? 'warn' : '')}
          ${stat('刷卡與行動支付', UI.fmtMoney(pv.card_amount), '不進抽屜，跟收單機對', 'warn')}
          ${stat('動用預收', UI.fmtMoney(pv.wallet_used + pv.pass_used + pv.voucher_used),
            `儲值 ${UI.fmtMoney(pv.wallet_used)}・次卡 ${UI.fmtMoney(pv.pass_used)}・券 ${UI.fmtMoney(pv.voucher_used)}`)}
        </div>
        <div class="notice">統計區間：${UI.esc(pv.from_at)} ~ ${UI.esc(pv.to_at)}（不含結束時刻）。
          鐘單以「結帳時間」歸班：早班的客人做到晚班才結帳，那筆錢在晚班的抽屜裡。
          現金支出以「登錄時間」歸班，這樣同一天分兩班結時才不會各扣一次。</div>
        ${pv.cash_expense_outside ? `<div class="notice warn">今天另有
          <b>${UI.fmtMoney(pv.cash_expense_outside)}</b> 的現金支出登錄在本班區間之外
          （多半是隔天才補登的）。這筆錢確實離開了抽屜，但不會算進這一班的應有現金 ——
          若點鈔短少的金額接近它，原因大概就在這裡。</div>` : ''}
        <div style="margin:12px 0"><button class="btn" id="do-close">開始點鈔並日結</button></div>
        ${list.unclosed.length ? `<div class="notice danger"><b>⛔ 有 ${list.unclosed.length} 個營業日還沒日結：</b>
          ${list.unclosed.slice(0, 10).map(u => `${UI.esc(u.d)}（${u.n} 張／收現 ${UI.fmtMoney(u.cash)}）`).join('、')}</div>` : ''}
        <h3>短溢統計（${UI.esc(state.from)} ~ ${UI.esc(state.to)}）</h3>
        ${UI.table(['班別', '結帳次數', '應有合計', '實點合計', '短少', '溢收', '淨差額'],
          list.summary.rows.map(r => `<tr><td>${UI.esc(r.shift_label)}</td><td class="num">${r.n}</td>
            <td class="num">${UI.fmtMoney(r.expected)}</td><td class="num">${UI.fmtMoney(r.counted)}</td>
            <td class="num danger">${UI.fmtMoney(r.short_total)}</td>
            <td class="num">${UI.fmtMoney(r.over_total)}</td>
            <td class="num ${r.diff_total < 0 ? 'danger' : ''}">${UI.fmtDelta(r.diff_total)}</td></tr>`),
          '這段期間還沒有日結紀錄')}
        <h3>日結紀錄</h3>
        <div id="cl-export"></div>
        ${UI.table(['單號', '營業日', '班別', '門市', '應有', '實點', '短溢', '交班給', '狀態', '經手', ''],
          list.rows.map(r => `<tr class="${r.status === 'void' ? 'muted' : ''}">
            <td>${UI.esc(r.closing_no)}</td><td>${UI.esc(r.biz_date)}</td><td>${UI.esc(r.shift_label)}</td>
            <td>${UI.esc(r.store_name || '全部')}</td>
            <td class="num">${UI.fmtMoney(r.expected_cash)}</td>
            <td class="num">${UI.fmtMoney(r.counted_cash)}</td>
            <td class="num ${r.diff < 0 ? 'danger' : r.diff > 0 ? 'warn' : ''}">${UI.fmtDelta(r.diff)}</td>
            <td>${UI.esc(r.handover_to || '—')}</td>
            <td>${r.status === 'void' ? UI.tag('已作廢', 'danger') : r.status === 'draft' ? UI.tag('試算', 'warn') : UI.tag('已結', 'ok')}</td>
            <td>${UI.esc(r.actor)}</td>
            <td><button class="btn tiny secondary" data-view="${r.id}">明細</button>
              ${r.status === 'confirmed' ? `<button class="btn tiny danger" data-void="${r.id}">作廢</button>` : ''}</td>
          </tr>`), '還沒有日結紀錄')}`;

      body.querySelector('#cl-export').appendChild(
        App.exportBtn('closings', () => ({ from: state.from, to: state.to, store_id: state.store_id })));
      body.querySelector('#do-close').onclick = () => countDialog(pv);
      body.querySelectorAll('[data-view]').forEach(b => b.onclick = () => viewClosing(b.dataset.view));
      body.querySelectorAll('[data-void]').forEach(b => b.onclick = () => voidClosing(b.dataset.void));
    }

    // 點鈔視窗：一格一格填張數，合計與差額即時算
    function countDialog(pv) {
      const denomHtml = pv.denoms.map(d => `<div class="denom-row">
        <label>${d}</label><input type="number" min="0" step="1" data-denom="${d}" placeholder="0">
        <span class="sub" data-denom-sub="${d}">0</span></div>`).join('');
      UI.modal({
        title: `日結點鈔　${pv.biz_date}`, wide: true, submitText: '確認日結',
        body: `<div class="form-grid">
            ${UI.select('shift_label', '班別', pv.shift_labels.map(s => [s, s]), { value: pv.shift_labels.includes('全日') ? '全日' : pv.shift_labels[0] })}
            ${UI.input('open_float', '抽屜零用金', { type: 'number', value: pv.open_float })}
            ${UI.input('handover_to', '交班給', { placeholder: '接班的人' })}
          </div>
          <div class="notice">應有現金 <b id="cd-expect">${UI.fmtMoney(pv.expected_cash)}</b>
            ＝ 零用金 ${UI.fmtMoney(pv.open_float)} ＋ 鐘單收現 ${UI.fmtMoney(pv.ticket_cash)}
            ＋ 儲值 ${UI.fmtMoney(pv.topup_cash)} ＋ 售卡 ${UI.fmtMoney(pv.pass_cash)}
            − 現金支出 ${UI.fmtMoney(pv.cash_expense)} − 現金退款 ${UI.fmtMoney(pv.cash_refund)}</div>
          <h4 style="margin:10px 0 6px">點鈔（填張數）</h4>
          <div class="denom-grid">${denomHtml}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap;gap:10px">
            <div>實點合計：<b id="cd-count">NT$ 0</b></div>
            <div>短溢：<span class="cash-diff bad" id="cd-diff">—</span></div>
          </div>
          <div id="cd-warn"></div>
          ${UI.textarea('note', '說明（短溢超過容忍值時必填）', { rows: 2, placeholder: '例如：找零時多找了 100，已於交接時說明' })}`,
        onOpen(el2) {
          const recalc = () => {
            let total = 0;
            el2.querySelectorAll('[data-denom]').forEach(i => {
              const d = Number(i.dataset.denom), n = Number(i.value) || 0;
              total += d * n;
              el2.querySelector(`[data-denom-sub="${d}"]`).textContent = (d * n).toLocaleString('zh-TW');
            });
            const expect = Number(el2.querySelector('[name=open_float]').value || 0) - pv.open_float + pv.expected_cash;
            el2.querySelector('#cd-expect').textContent = UI.fmtMoney(expect);
            el2.querySelector('#cd-count').textContent = UI.fmtMoney(total);
            const diff = total - expect;
            const dEl = el2.querySelector('#cd-diff');
            dEl.textContent = UI.fmtDelta(diff);
            dEl.className = 'cash-diff ' + (Math.abs(diff) <= pv.tolerance ? 'ok' : 'bad');
            el2.querySelector('#cd-warn').innerHTML = Math.abs(diff) > pv.tolerance
              ? `<div class="notice warn">差額 ${UI.fmtDelta(diff)} 元超過容忍值 ${pv.tolerance} 元，請在下方說明原因。</div>` : '';
          };
          el2.addEventListener('input', recalc);
          recalc();
        },
        async onSubmit(el2) {
          const f = UI.formData(el2);
          const denom = {};
          el2.querySelectorAll('[data-denom]').forEach(i => {
            const n = Number(i.value) || 0;
            if (n) denom[i.dataset.denom] = n;
          });
          if (!Object.keys(denom).length) throw new Error('請先點鈔（至少填一種面額的張數）');
          const r = await POST('/closing', {
            biz_date: pv.biz_date, store_id: state.store_id || null,
            shift_label: f.shift_label, open_float: f.open_float, handover_to: f.handover_to,
            denom, note: f.note
          });
          UI.toast(`日結完成 ${r.closing_no}，短溢 ${r.diff} 元`);
          draw();
        }
      });
    }

    async function viewClosing(id) {
      const c = await GET('/closing/' + id);
      const denomRows = c.denom
        ? Object.entries(c.denom).sort((a, b) => b[0] - a[0])
          .map(([d, n]) => `<tr><td>${d} 元</td><td class="num">${n} 張</td><td class="num">${UI.fmtMoney(d * n)}</td></tr>`)
        : [];
      UI.modal({
        title: `日結明細　${c.closing_no}`, wide: true, hideFooter: true,
        body: `<div class="form-grid">
            <div class="form-row"><label>營業日</label><div>${UI.esc(c.biz_date)}　${UI.esc(c.shift_label)}</div></div>
            <div class="form-row"><label>區間</label><div>${UI.esc(c.from_at)} ~ ${UI.esc(c.to_at)}</div></div>
            <div class="form-row"><label>門市</label><div>${UI.esc(c.store_name || '全部')}</div></div>
            <div class="form-row"><label>經手／交班</label><div>${UI.esc(c.actor)} → ${UI.esc(c.handover_to || '—')}</div></div>
          </div>
          ${UI.table(['項目', '金額'], [
            ['抽屜零用金', c.open_float], ['鐘單收現', c.ticket_cash], ['儲值收現', c.topup_cash],
            ['售卡收現', c.pass_cash], ['現金支出', -c.cash_expense],
            ['＝ 應有現金', c.expected_cash], ['實點現金', c.counted_cash], ['短溢', c.diff],
            ['刷卡與行動支付', c.card_amount], ['其他非現金', c.other_amount],
            ['動用儲值', c.wallet_used], ['次卡核銷', c.pass_used], ['團購券折抵', c.voucher_used]
          ].map(([k, v]) => `<tr><td>${k}</td><td class="num ${v < 0 ? 'danger' : ''}">${UI.fmtMoney(v)}</td></tr>`))}
          ${denomRows.length ? `<h4>點鈔明細</h4>${UI.table(['面額', '張數', '小計'], denomRows)}` : ''}
          ${c.note ? `<div class="notice">${UI.esc(c.note)}</div>` : ''}`
      });
    }

    async function voidClosing(id) {
      UI.modal({
        title: '作廢日結單', submitText: '確認作廢',
        body: `<div class="notice warn">日結單不會被刪除，作廢後這一班可以重新結一次。原因會留在稽核軌跡裡。</div>
          ${UI.textarea('reason', '作廢原因', { rows: 2, placeholder: '例如：面額輸入錯誤，重新點鈔' })}`,
        async onSubmit(el2) {
          await POST(`/closing/${id}/void`, UI.formData(el2));
          UI.toast('已作廢');
          draw();
        }
      });
    }
    draw();
  }
});

App.page('roster', {
  title: '班表', module: 'roster', sub: '預排下週誰上什麼班 —— 這件事不該再用 LINE 發圖片',
  help: {
    intro: '班表是「計畫」，輪鐘檯的簽到是「事實」。兩邊刻意分開，因為它們的落差正是店長要看的東西。',
    steps: [
      '選一週的起始日，直接在格子裡選班別，按「儲存班表」一次寫入。',
      '排下週時按「複製上一週」，再改動的幾個人就好。',
      '往下看「班表 vs 實際」：誰排了班沒簽到、誰沒排班卻來上班。',
      '再往下是人力與生意量的對照，用來決定要不要加人或放人。'
    ],
    notes: [
      '休假、特休、請假這類班別不算人力，也不會帶時間。',
      '複製上一週預設不會蓋掉已經排好的格子；要整週重來請勾「覆蓋」。',
      '班別與預設時間在「系統設定」的 roster_shifts 調整。'
    ],
    terms: [['負載率', '當日預約總時數 ÷（排班人數 × 每人每日時數上限）。超過 100% 代表人不夠。']]
  },
  async render(el) {
    const monday = d => {
      const dt = new Date(d + 'T00:00:00Z');
      const wd = (dt.getUTCDay() + 6) % 7;      // 週一為 0
      return UI.addDays(d, -wd);
    };
    const state = { from: monday(UI.today()), store_id: '' };
    el.innerHTML = '';
    const bar = App.filterBar([
      { name: 'from', label: '週起始日', type: 'date', value: state.from },
      { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市') }
    ], v => { Object.assign(state, v); draw(); });
    el.appendChild(bar);
    const body = document.createElement('div');
    el.appendChild(body);

    const WD = ['一', '二', '三', '四', '五', '六', '日'];

    async function draw() {
      const to = UI.addDays(state.from, 6);
      const [g, cmp, dem] = await Promise.all([
        GET('/roster' + App.qs({ from: state.from, to, store_id: state.store_id })),
        GET('/roster/compare' + App.qs({ from: state.from, to, store_id: state.store_id })),
        GET('/roster/demand' + App.qs({ from: state.from, to, store_id: state.store_id }))
      ]);
      const opts = [['', '—']].concat(g.types.map(t => [t.code, t.code]));
      const dayHead = g.dates.map((d, i) => {
        const weekend = i >= 5;
        return `<th class="${weekend ? 'rs-weekend' : ''}">${d.slice(5)}<br><small>週${WD[i]}</small></th>`;
      }).join('');
      const rows = g.therapists.map(t => `<tr>
        <td class="rs-name">${UI.esc(t.code)} ${UI.esc(t.name)}<br><small class="muted">${UI.esc(t.level)}</small></td>
        ${g.dates.map(d => {
          const c = g.cells[`${d}|${t.id}`];
          const ty = c ? g.types.find(x => x.code === c.shift_code) : null;
          const cls = !c ? '' : ty && ty.off ? 'rs-off' : 'rs-on';
          return `<td class="${cls}"><select data-cell="${d}|${t.id}">
            ${opts.map(([v, l]) => `<option value="${UI.esc(v)}"${c && c.shift_code === v ? ' selected' : ''}>${UI.esc(l)}</option>`).join('')}
          </select></td>`;
        }).join('')}
      </tr>`).join('');
      const foot = `<tr><td class="rs-name">上班人數</td>
        ${g.dates.map(d => `<td class="rs-count" data-count="${d}">${g.headcount[d] || 0}</td>`).join('')}</tr>`;

      body.innerHTML = `
        <div class="toolbar">
          <button class="btn" id="rs-save">儲存班表</button>
          <button class="btn secondary" id="rs-copy">複製上一週到本週</button>
          <span id="rs-export"></span>
        </div>
        <div class="roster-grid"><table>
          <thead><tr><th class="rs-name">技師</th>${dayHead}</tr></thead>
          <tbody>${rows}</tbody>
          <tfoot>${foot}</tfoot>
        </table></div>
        <h3>班表 vs 實際簽到</h3>
        ${cmp.absent.length || cmp.unplanned.length ? `
          ${UI.table(['日期', '技師', '班別', '狀況'],
            cmp.absent.concat(cmp.unplanned).map(x => `<tr>
              <td>${UI.esc(x.work_date)}</td><td>${UI.esc(x.code)} ${UI.esc(x.name)}</td>
              <td>${UI.esc(x.shift_code || '—')}</td>
              <td>${UI.tag(x.problem, x.problem.includes('沒有簽到') ? 'danger' : 'warn')}</td></tr>`))}`
          : '<div class="notice ok">✓ 這一週的班表與實際簽到完全對得起來</div>'}
        <h3>人力與生意量</h3>
        ${UI.table(['日期', '排班人數', '實際簽到', '鐘數', '服務時數', '可服務時數', '負載率'],
          dem.map(d => `<tr>
            <td>${UI.esc(d.date)}</td>
            <td class="num">${d.planned}</td>
            <td class="num ${d.planned && d.checked_in < d.planned ? 'danger' : ''}">${d.checked_in}</td>
            <td class="num">${d.tickets}</td>
            <td class="num">${UI.dur(d.minutes)}</td>
            <td class="num">${UI.dur(d.capacity_minutes)}</td>
            <td class="num ${d.load > 0.95 ? 'danger' : d.load < 0.3 && d.planned ? 'warn' : ''}">
              ${d.planned ? UI.fmtPct(d.load, 0) : '—'}</td></tr>`))}`;

      body.querySelector('#rs-export').appendChild(
        App.exportBtn('roster', () => ({ from: state.from, to })));

      const recount = () => {
        const offCodes = g.types.filter(t => t.off).map(t => t.code);
        g.dates.forEach(d => {
          let n = 0;
          body.querySelectorAll(`[data-cell^="${d}|"]`).forEach(s => {
            if (s.value && !offCodes.includes(s.value)) n++;
          });
          const cell = body.querySelector(`[data-count="${d}"]`);
          if (cell) cell.textContent = n;
        });
      };
      body.querySelectorAll('[data-cell]').forEach(s => {
        s.addEventListener('change', () => {
          const td = s.closest('td');
          const ty = g.types.find(x => x.code === s.value);
          td.className = !s.value ? '' : ty && ty.off ? 'rs-off' : 'rs-on';
          recount();
        });
      });

      body.querySelector('#rs-save').onclick = async () => {
        const cells = [];
        body.querySelectorAll('[data-cell]').forEach(s => {
          const [work_date, therapist_id] = s.dataset.cell.split('|');
          const cur = g.cells[s.dataset.cell];
          // 只送有變動的格子：整週幾百格全送一次，寫入慢又會把別人剛改的蓋掉
          if ((cur ? cur.shift_code : '') !== s.value) cells.push({ work_date, therapist_id, shift_code: s.value });
        });
        if (!cells.length) return UI.toast('沒有變動');
        try {
          const r = await PUT('/roster', { cells, store_id: state.store_id || null });
          UI.toast(`已儲存 ${r.saved} 格`);
          draw();
        } catch (e) { UI.err(e); }
      };

      body.querySelector('#rs-copy').onclick = () => {
        UI.modal({
          title: '複製上一週', submitText: '複製',
          body: `<div class="notice">把 ${UI.addDays(state.from, -7)} 那一週的班表複製到 ${state.from} 這一週。</div>
            ${UI.checkbox('overwrite', '覆蓋已排好的格子', false, { text: '勾選後，本週已經排的班會被上週的蓋掉' })}`,
          async onSubmit(el2) {
            const f = UI.formData(el2);
            const r = await POST('/roster/copy', {
              from_start: UI.addDays(state.from, -7), to_start: state.from,
              store_id: state.store_id || null, overwrite: f.overwrite
            });
            UI.toast(`複製 ${r.copied} 格，略過 ${r.skipped} 格`);
            draw();
          }
        });
      };
    }
    draw();
  }
});
