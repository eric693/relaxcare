// 法遵：用語合規自檢、證照與健檢到期

App.page('compliance', {
  title: '用語合規自檢', module: 'compliance', sub: '民俗調理業不得宣稱醫療效能',
  help: {
    intro: '按摩、推拿、腳底按摩屬於民俗調理業，不是醫療院所。實務上被檢舉的多半不是手法，是文案。',
    steps: ['按「重新掃描」檢查服務項目、商品與對外文案。',
      '點命中的項目直接去改；系統不會自動改文案（改壞了更糟）。',
      '下方可以貼一段廣告文案先檢查再發出去。'],
    notes: ['禁用字詞清單可在「系統設定」的 banned_terms 調整。',
      '這是自我檢查工具，不能取代法律意見。']
  },
  async render(el) {
    el.innerHTML = '<div class="empty">掃描中…</div>';
    const d = await GET('/compliance/scan');
    el.innerHTML = `
      <div class="notice ${d.total ? 'warn' : 'ok'}">
        ${d.total ? `⚠ 發現 <b>${d.total}</b> 處可能踩線的用語` : '✓ 目前沒有發現踩線用語'}
        <div>${UI.esc(d.note)}</div>
      </div>
      ${d.by_term.length ? `<div class="chip-row">${d.by_term.map(t =>
        `<span class="chip chip-danger">${UI.esc(t.term)} ×${t.count}</span>`).join('')}</div>` : ''}
      ${UI.table(['來源', '資料', '欄位', '命中字詞', '上下文', '建議'],
        d.findings.map(f => `<tr><td>${UI.esc(f.source)}</td><td>${UI.esc(f.name)}</td>
          <td>${UI.esc(f.field)}</td><td><b class="danger">${UI.esc(f.term)}</b></td>
          <td class="muted">…${UI.esc(f.context)}…</td><td>${UI.esc(f.suggest)}</td></tr>`),
        '沒有命中任何禁用字詞')}
      <h3>文案預檢</h3>
      <div class="form-grid">
        ${UI.textarea('text', '貼上要發出去的文案', { rows: 5, placeholder: '例：本館獨家手法，三次改善肩頸痠痛…' })}
      </div>
      <button class="btn" id="check">檢查這段文字</button>
      <div id="check-out"></div>
      <h3>禁用字詞清單（${d.terms.length}）</h3>
      <div class="chip-row">${d.terms.map(t =>
        `<span class="chip">${UI.esc(t.term)}${t.suggest ? ` <span class="muted">→ ${UI.esc(t.suggest)}</span>` : ''}</span>`).join('')}</div>
      <h3>同意書與問診完整度</h3>
      <div id="consent"><div class="empty">載入中…</div></div>`;

    el.querySelector('#check').onclick = async () => {
      const text = el.querySelector('[name=text]').value;
      const r = await POST('/compliance/check-text', { text });
      el.querySelector('#check-out').innerHTML = r.hits.length
        ? r.hits.map(h => `<div class="notice warn">⚠ <b>${UI.esc(h.term)}</b>　…${UI.esc(h.context)}…　建議：${UI.esc(h.suggest)}</div>`).join('')
        : '<div class="notice ok">✓ 這段文字沒有命中禁用字詞</div>';
    };

    const c = await GET('/compliance/consent');
    el.querySelector('#consent').innerHTML = `
      <div class="notice">共 ${c.length} 位需要留意。訪查時「拿不出紀錄」跟「沒有做」一樣麻煩。</div>`
      + UI.table(['客編', '姓名', '電話', '到店次數', '同意書', '問診更新', '狀態'],
        c.slice(0, 200).map(r => `<tr class="${r.status === 'ok' ? '' : 'row-warn'}">
          <td>${UI.esc(r.member_no)}</td><td>${UI.esc(r.name)}</td><td>${UI.esc(r.phone)}</td>
          <td class="num">${r.visits}</td>
          <td>${r.has_consent ? UI.esc(r.consent_at.slice(0, 10)) : '<span class="danger">未簽</span>'}</td>
          <td>${r.has_health ? `${UI.esc(r.health_updated_at.slice(0, 10))}<span class="muted"> ${r.health_age_days} 天前</span>` : '<span class="danger">無</span>'}</td>
          <td>${App.statusTag('consent_status', r.status)}</td></tr>`),
        '全部完整');

    // 電子同意書：compliance.consentAudit 看的是 members.consent_at（有沒有簽過的時間戳），
    // 這一段看的是「簽名檔實際存在不存在」。訪查時後者才是拿得出來的東西。
    const cs = await GET('/consents');
    el.querySelector('#consent').insertAdjacentHTML('beforeend', `
      <h3>電子同意書（有簽名檔的）</h3>
      <div class="notice">同意書有效期 ${cs.valid_months} 個月，過期要重簽 —— 身體狀況會變，一年前簽的等於沒問。
        簽名在「客人檔案」點進客人後按「簽同意書」。</div>
      <span id="cs-export"></span>
      ${UI.table(['姓名', '電話', '到店次數', '簽署次數', '最後簽署', '有效至', '狀態'],
        cs.rows.filter(r => r.visits > 0).slice(0, 200).map(r => `<tr class="${r.status === 'ok' ? '' : 'row-warn'}">
          <td>${UI.esc(r.name)}</td><td>${UI.esc(r.phone || '')}</td>
          <td class="num">${r.visits}</td><td class="num">${r.sign_count}</td>
          <td>${UI.esc(r.last_signed || '—')}</td><td>${UI.esc(r.due || '—')}</td>
          <td>${r.status === 'ok' ? UI.tag('有效', 'ok') : r.status === 'expired' ? UI.tag('已逾期', 'danger') : UI.tag('未簽署', 'danger')}</td>
        </tr>`), '還沒有任何電子同意書')}`);
    el.querySelector('#cs-export').appendChild(App.exportBtn('consents', () => ({})));
  }
});

App.page('expiry', {
  title: '證照與健檢到期', module: 'expiry', sub: '技術士證與健康檢查，稽查時看的就是這兩張紙',
  help: {
    intro: '過期或未登錄的技師在開單時會被系統擋下來（可強制放行但要填理由）。',
    steps: ['紅色是已過期或未登錄，黃色是即將到期。',
      '直接在這一頁編輯到期日，不必回技師主檔。'],
    notes: ['提前提醒天數可在系統設定的 expiry_warn_days 調整。']
  },
  async render(el) {
    el.innerHTML = '<div class="empty">載入中…</div>';
    async function draw() {
      const d = await GET('/expiry');
      const s = d.summary;
      el.innerHTML = `
        <div class="stat-grid">
          <div class="stat warn"><div class="stat-label">已過期</div><div class="stat-value">${s.expired}</div></div>
          <div class="stat warn"><div class="stat-label">未登錄</div><div class="stat-value">${s.missing}</div></div>
          <div class="stat"><div class="stat-label">${d.warn_days} 天內到期</div><div class="stat-value">${s.soon}</div></div>
          <div class="stat ok"><div class="stat-label">正常</div><div class="stat-value">${s.ok}</div></div>
        </div>`
        + UI.table(['技師', '門市', '級別', '項目', '證號／檢查日', '到期日', '剩餘天數', '狀態', ''],
          d.rows.map(r => `<tr class="${r.status === 'expired' || r.status === 'missing' ? 'row-danger' : r.status === 'soon' ? 'row-warn' : ''}">
            <td>${UI.esc(r.name)}<div class="muted">${UI.esc(r.code)}</div></td>
            <td>${UI.esc(r.store_name)}</td><td>${UI.esc(r.level)}</td>
            <td>${UI.esc(r.kind)}</td>
            <td class="muted">${UI.esc(r.cert_no || r.check_date || '—')}</td>
            <td>${UI.esc(r.expiry_date || '未登錄')}</td>
            <td class="num">${r.days_left === null ? '—' : r.days_left}</td>
            <td>${App.statusTag('expiry_status', r.status)}</td>
            <td>${App.canEdit('expiry') ? `<button class="btn tiny secondary" data-t="${r.therapist_id}" data-f="${r.field}" data-k="${UI.esc(r.kind)}">更新</button>` : ''}</td>
          </tr>`));
      el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => {
        const isCert = b.dataset.f === 'cert_expiry';
        UI.modal({
          title: `更新${b.dataset.k}`,
          body: `<div class="form-grid">
            ${isCert ? UI.input('cert_no', '證號', {}) : UI.input('health_check_date', '檢查日期', { type: 'date' })}
            ${UI.input(b.dataset.f, '到期日', { type: 'date' })}
          </div>`,
          async onSubmit(e) { await PUT(`/expiry/${b.dataset.t}`, UI.formData(e)); UI.toast('已更新'); draw(); }
        });
      });
    }
    draw();
  }
});
