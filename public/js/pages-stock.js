// 進退貨、盤點、跨店調撥與庫存流水

App.page('purchase', {
  title: '進退貨與盤點', module: 'purchase', sub: '庫存從此有流水：誰進的、進多少錢、少掉的那幾瓶去哪了',
  help: {
    intro: '商品庫存原本只能手動改數字，於是損益表上的商品成本無法稽核。現在每一次異動都有一筆流水，庫存欄位只是它的加總。',
    steps: [
      '收到貨按「進貨」，填數量與進價 —— 成本會用移動加權平均自動更新。',
      '月底按「盤點」，輸入實際數到幾個，差異與原因會寫進流水。',
      'A 店缺貨用「調撥」，一出一進，兩邊的庫存各自變動、總量不變。',
      '破損、試用、送客人用「調整」，一樣要填原因。',
      '點商品列的「流水」看它的完整歷史。'
    ],
    notes: [
      '鐘單賣出商品會自動出庫並記下當下成本；取消鐘單會自動回沖。',
      '成本用移動加權平均：((舊庫存×舊成本)+(進貨量×進價))÷新庫存。',
      '「快取相符」欄若出現「否」，代表有人直接改過資料庫，按「重算庫存」修正。'
    ],
    terms: [
      ['銷貨成本', '賣出時記下的成本合計，就是損益表上的商品成本。'],
      ['庫存市值', '目前庫存 × 目前成本，是壓在架上的錢。']
    ]
  },
  async render(el) {
    const state = { store_id: '', kind: '', from: UI.addDays(UI.today(), -30), to: UI.today() };
    el.innerHTML = '';
    el.appendChild(App.filterBar([
      { name: 'store_id', label: '門市', type: 'select', options: App.storeOptions('全部門市') },
      { name: 'kind', label: '異動類型', type: 'select', options: [['', '全部'], ['purchase', '進貨'],
        ['return', '退貨'], ['sale', '銷售出庫'], ['sale_void', '銷售回沖'], ['count', '盤點調整'],
        ['transfer_out', '調出'], ['transfer_in', '調入'], ['adjust', '人工調整'], ['init', '期初']] },
      { name: 'from', label: '流水起', type: 'date', value: state.from },
      { name: 'to', label: '流水迄', type: 'date', value: state.to }
    ], v => { Object.assign(state, v); draw(); }));
    const body = document.createElement('div');
    el.appendChild(body);

    async function draw() {
      const [st, txns, mv] = await Promise.all([
        GET('/stock' + App.qs({ store_id: state.store_id })),
        GET('/stock/txns' + App.qs({ store_id: state.store_id, kind: state.kind, from: state.from, to: state.to, limit: 300 })),
        GET('/stock/movement' + App.qs({ store_id: state.store_id, from: state.from, to: state.to }))
      ]);
      const stat = (l, v, s, cls = '') =>
        `<div class="stat ${cls}"><div class="stat-label">${l}</div><div class="stat-value">${v}</div><div class="stat-sub">${s || ''}</div></div>`;
      body.innerHTML = `
        <div class="toolbar">
          <button class="btn" id="btn-purchase">進貨</button>
          <button class="btn secondary" id="btn-count">盤點</button>
          <button class="btn secondary" id="btn-transfer">跨店調撥</button>
          <button class="btn secondary" id="btn-return">退貨給廠商</button>
          <button class="btn secondary" id="btn-adjust">庫存調整</button>
          <span class="spacer"></span>
          <span id="sk-export"></span><span id="sk-export2"></span>
        </div>
        <div class="stat-grid">
          ${stat('庫存市值', UI.fmtMoney(st.total_cost_value), `${st.rows.length} 項商品`)}
          ${stat('期間進貨', UI.fmtMoney(mv.purchase_amount), `${mv.purchase_qty} 件`)}
          ${stat('期間銷貨成本', UI.fmtMoney(mv.cogs), `賣出 ${mv.sold_qty} 件`)}
          ${stat('盤點損益', UI.fmtMoney(mv.count_diff_amount), `差異 ${mv.count_diff_qty} 件`,
            mv.count_diff_amount < 0 ? 'warn' : '')}
          ${stat('低於安全庫存', String(st.low_count), '該叫貨了', st.low_count ? 'warn' : '')}
          ${st.mismatch_count ? stat('快取不符', String(st.mismatch_count), '請按重算庫存', 'danger') : ''}
        </div>
        ${st.mismatch_count ? `<div class="notice danger">有 ${st.mismatch_count} 項商品的庫存欄位與流水加總對不上
          （通常是有人直接改了資料庫）。<button class="btn tiny" id="btn-recon">重算庫存</button></div>` : ''}
        <h3>庫存總表</h3>
        ${UI.table(['SKU', '品名', '分類', '售價', '成本', '庫存', '各店分布', '安全庫存', '庫存市值', ''],
          st.rows.map(p => `<tr class="${p.low ? 'row-warn' : ''}">
            <td>${UI.esc(p.sku)}</td><td>${UI.esc(p.name)}</td><td>${UI.esc(p.category)}</td>
            <td class="num">${UI.fmtMoney(p.price)}</td>
            <td class="num">${UI.fmtMoney(p.cost)}${p.last_cost ? `<div class="muted">最後進價 ${UI.fmtMoney(p.last_cost)}</div>` : ''}</td>
            <td class="num ${p.low ? 'danger' : ''}">${p.real_stock}${p.cache_ok ? '' : ` <span class="tag danger">快取 ${p.stock}</span>`}</td>
            <td class="muted">${p.by_store.map(b => `${UI.esc(App.nameOf('stores', b.store_id) || '未分店')} ${b.qty}`).join('　')}</td>
            <td class="num">${p.safety_stock}</td>
            <td class="num">${UI.fmtMoney(p.cost_value)}</td>
            <td><button class="btn tiny secondary" data-hist="${p.id}">流水</button></td></tr>`))}
        <h3>庫存流水（${UI.esc(state.from)} ~ ${UI.esc(state.to)}）</h3>
        ${UI.table(['時間', '商品', '類型', '門市', '數量', '單價', '金額', '異動後', '單號／鐘單', '說明', '經手'],
          txns.map(x => `<tr>
            <td>${UI.esc(x.created_at)}</td>
            <td>${UI.esc(x.product_name || '')}</td>
            <td>${UI.tag(x.kind_label, x.qty < 0 ? 'warn' : 'ok')}</td>
            <td>${UI.esc(x.store_name || '—')}</td>
            <td class="num ${x.qty < 0 ? 'danger' : ''}">${x.qty > 0 ? '+' : ''}${x.qty}</td>
            <td class="num">${UI.fmtMoney(x.unit_cost)}</td>
            <td class="num">${UI.fmtMoney(x.amount)}</td>
            <td class="num">${x.stock_after}</td>
            <td>${UI.esc(x.doc_no || x.ticket_no || '—')}</td>
            <td class="muted">${UI.esc(x.note || '')}</td>
            <td>${UI.esc(x.actor || '')}</td></tr>`), '這段期間沒有庫存異動')}`;

      body.querySelector('#sk-export').appendChild(App.exportBtn('stock', () => ({ store_id: state.store_id }), '⬇ 匯出庫存'));
      body.querySelector('#sk-export2').appendChild(App.exportBtn('stock_txns',
        () => ({ store_id: state.store_id, kind: state.kind, from: state.from, to: state.to }), '⬇ 匯出流水'));
      body.querySelector('#btn-purchase').onclick = () => purchaseDialog(st.rows);
      body.querySelector('#btn-count').onclick = () => countDialog(st.rows);
      body.querySelector('#btn-transfer').onclick = () => transferDialog(st.rows);
      body.querySelector('#btn-return').onclick = () => returnDialog(st.rows);
      body.querySelector('#btn-adjust').onclick = () => adjustDialog(st.rows);
      const rec = body.querySelector('#btn-recon');
      if (rec) rec.onclick = async () => {
        if (!await UI.confirm('把庫存欄位重算成流水的加總？')) return;
        const r = await POST('/stock/reconcile', { fix: true });
        UI.toast(`已修正 ${r.fixed} 項`);
        draw();
      };
      body.querySelectorAll('[data-hist]').forEach(b => b.onclick = () => history(b.dataset.hist));
    }

    const prodOptions = rows => rows.map(p => [p.id, `${p.sku ? p.sku + ' ' : ''}${p.name}（庫存 ${p.real_stock}）`]);

    // 多列的進貨單。一次進五六樣是常態，一次一樣會讓人放棄用系統。
    function itemRows(rows, cols) {
      return `<table class="list"><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}<th></th></tr></thead>
        <tbody data-items></tbody></table>
        <button type="button" class="btn tiny secondary" data-add-row style="margin-top:8px">＋ 加一列</button>`;
    }
    function bindItemRows(el2, rows, rowHtml) {
      const tbody = el2.querySelector('[data-items]');
      const add = () => {
        const tr = document.createElement('tr');
        tr.innerHTML = rowHtml() + '<td><button type="button" class="btn tiny danger" data-del>×</button></td>';
        tbody.appendChild(tr);
        tr.querySelector('[data-del]').onclick = () => tr.remove();
        UI.bindSearchSelects(tr);
      };
      el2.querySelector('[data-add-row]').onclick = add;
      add();
      return () => [...tbody.querySelectorAll('tr')].map(tr => {
        const o = {};
        tr.querySelectorAll('[data-k]').forEach(i => { o[i.dataset.k] = i.value; });
        return o;
      }).filter(o => o.product_id);
    }

    function purchaseDialog(rows) {
      const opts = prodOptions(rows);
      let read;
      UI.modal({
        title: '進貨', wide: true, submitText: '確認進貨',
        body: `<div class="form-grid">
            ${UI.select('store_id', '進到哪一店', App.storeOptions('未分店'))}
            ${UI.inputList('vendor', '廠商', [], { placeholder: '供應商名稱' })}
          </div>
          ${itemRows(rows, ['商品', '數量', '進貨單價', '小計'])}
          ${UI.textarea('note', '備註', { rows: 2 })}
          ${UI.fileField('docs', '進貨單據照片（可多張）', { multiple: true })}
          <div class="notice">成本會用移動加權平均更新，並記下這次的進價與日期。單據照片存檔後會回讀驗證，
            驗不過會直接告訴你，不會假裝成功。</div>`,
        onOpen(el2) {
          read = bindItemRows(el2, rows, () => `
            <td><select data-k="product_id">${opts.map(([v, t]) => `<option value="${v}">${UI.esc(t)}</option>`).join('')}</select></td>
            <td><input type="number" min="1" step="1" data-k="qty" value="1" style="width:80px"></td>
            <td><input type="number" min="0" step="1" data-k="unit_cost" placeholder="單價" style="width:100px"></td>
            <td class="num" data-sum>—</td>`);
          el2.addEventListener('input', () => {
            el2.querySelectorAll('[data-items] tr').forEach(tr => {
              const q = Number(tr.querySelector('[data-k=qty]')?.value) || 0;
              const c = Number(tr.querySelector('[data-k=unit_cost]')?.value) || 0;
              const cell = tr.querySelector('[data-sum]');
              if (cell) cell.textContent = q && c ? UI.fmtMoney(q * c) : '—';
            });
          });
        },
        async onSubmit(el2) {
          const f = UI.formData(el2);
          const items = read().map(x => ({ product_id: Number(x.product_id), qty: Number(x.qty), unit_cost: Number(x.unit_cost) }));
          if (!items.length) throw new Error('請至少填一項商品');
          // 檔案先讀起來，讀不成功就不要送出（後端也會擋，但這裡能講得更清楚）
          const files = [];
          for (const fl of (el2.querySelector('[data-file=docs]')?.files || [])) {
            files.push(await UI.readFile(fl).then(r => ({ data: r.data, name: r.name })));
          }
          const r = await POST('/stock/purchase', {
            store_id: f.store_id || null, vendor: f.vendor, note: f.note, items, attachments: files
          });
          if (r.attachment_errors && r.attachment_errors.length) {
            UI.toast(`進貨 ${r.doc_no} 已完成，但有單據沒存成功：${r.attachment_errors.join('；')}`, true);
          } else {
            UI.toast(`進貨完成 ${r.doc_no}，共 ${UI.fmtMoney(r.total)}${files.length ? `，單據 ${files.length} 張已驗證存檔` : ''}`);
          }
          draw();
        }
      });
    }

    function countDialog(rows) {
      const opts = prodOptions(rows);
      let read;
      UI.modal({
        title: '盤點', wide: true, submitText: '寫入盤點差異',
        body: `<div class="form-grid">${UI.select('store_id', '盤哪一店', App.storeOptions('全部（總量）'))}</div>
          <div class="notice">輸入「實際數到幾個」，差異由系統算。差異會寫成一筆調整流水，
            不會把帳面偷偷改掉 —— 盤盈盤虧本身就是要給人看的資訊。</div>
          ${itemRows(rows, ['商品', '帳面', '實盤'])}
          ${UI.textarea('reason', '盤點原因／說明（必填）', { rows: 2, placeholder: '例如：月底盤點，A 商品破損一瓶' })}`,
        onOpen(el2) {
          read = bindItemRows(el2, rows, () => `
            <td><select data-k="product_id">${opts.map(([v, t]) => `<option value="${v}">${UI.esc(t)}</option>`).join('')}</select></td>
            <td class="num" data-book>—</td>
            <td><input type="number" min="0" step="1" data-k="counted" style="width:90px"></td>`);
          const sync = () => {
            el2.querySelectorAll('[data-items] tr').forEach(tr => {
              const pid = tr.querySelector('[data-k=product_id]')?.value;
              const p = rows.find(x => String(x.id) === String(pid));
              const cell = tr.querySelector('[data-book]');
              if (cell && p) cell.textContent = p.real_stock;
            });
          };
          el2.addEventListener('change', sync);
          setTimeout(sync, 0);
        },
        async onSubmit(el2) {
          const f = UI.formData(el2);
          const items = read().map(x => ({ product_id: Number(x.product_id), counted: Number(x.counted) }));
          if (!items.length) throw new Error('請至少盤一項商品');
          const r = await POST('/stock/count', { store_id: f.store_id || null, items, reason: f.reason });
          UI.toast(`盤點 ${r.doc_no}：${r.diff_count} 項有差異，損益 ${UI.fmtMoney(r.diff_amount)}`);
          draw();
        }
      });
    }

    function transferDialog(rows) {
      UI.modal({
        title: '跨店調撥', submitText: '確認調撥',
        body: `<div class="form-grid">
            ${UI.select('product_id', '商品', prodOptions(rows), { full: true })}
            ${UI.select('from_store_id', '調出門市', App.storeOptions())}
            ${UI.select('to_store_id', '調入門市', App.storeOptions())}
            ${UI.input('qty', '數量', { type: 'number', value: 1 })}
          </div>
          ${UI.textarea('note', '原因', { rows: 2, placeholder: '例如：信義館缺貨' })}
          <div class="notice">調撥會產生一出一進兩筆流水，總庫存不變，兩邊的分店庫存各自變動。</div>`,
        async onSubmit(el2) {
          const f = UI.formData(el2);
          const r = await POST('/stock/transfer', f);
          UI.toast(`調撥完成 ${r.doc_no}：${r.product} x${r.qty}`);
          draw();
        }
      });
    }

    function returnDialog(rows) {
      const opts = prodOptions(rows);
      let read;
      UI.modal({
        title: '退貨給廠商', wide: true, submitText: '確認退貨',
        body: `<div class="form-grid">
            ${UI.select('store_id', '從哪一店退', App.storeOptions('未分店'))}
            ${UI.inputList('vendor', '廠商', [], {})}
          </div>
          ${itemRows(rows, ['商品', '數量'])}
          ${UI.textarea('note', '退貨原因', { rows: 2 })}`,
        onOpen(el2) {
          read = bindItemRows(el2, rows, () => `
            <td><select data-k="product_id">${opts.map(([v, t]) => `<option value="${v}">${UI.esc(t)}</option>`).join('')}</select></td>
            <td><input type="number" min="1" step="1" data-k="qty" value="1" style="width:90px"></td>`);
        },
        async onSubmit(el2) {
          const f = UI.formData(el2);
          const items = read().map(x => ({ product_id: Number(x.product_id), qty: Number(x.qty) }));
          if (!items.length) throw new Error('請至少填一項商品');
          const r = await POST('/stock/return', { store_id: f.store_id || null, vendor: f.vendor, note: f.note, items });
          UI.toast(`退貨完成 ${r.doc_no}，共 ${UI.fmtMoney(r.total)}`);
          draw();
        }
      });
    }

    function adjustDialog(rows) {
      UI.modal({
        title: '庫存調整', submitText: '寫入調整',
        body: `<div class="form-grid">
            ${UI.select('product_id', '商品', prodOptions(rows), { full: true })}
            ${UI.select('store_id', '門市', App.storeOptions('未分店'))}
            ${UI.input('qty', '增減數量（負數為減）', { type: 'number', placeholder: '例如 -1' })}
          </div>
          ${UI.textarea('reason', '原因（必填）', { rows: 2, placeholder: '例如：試用開瓶、破損、送客人' })}`,
        async onSubmit(el2) {
          await POST('/stock/adjust', UI.formData(el2));
          UI.toast('已寫入庫存調整');
          draw();
        }
      });
    }

    async function history(productId) {
      const rows = await GET('/stock/txns' + App.qs({ product_id: productId, limit: 200 }));
      UI.modal({
        title: '庫存流水', wide: true, hideFooter: true,
        body: UI.table(['時間', '類型', '門市', '數量', '單價', '異動後', '單號', '說明', '經手'],
          rows.map(x => `<tr><td>${UI.esc(x.created_at)}</td>
            <td>${UI.tag(x.kind_label, x.qty < 0 ? 'warn' : 'ok')}</td>
            <td>${UI.esc(x.store_name || '—')}</td>
            <td class="num ${x.qty < 0 ? 'danger' : ''}">${x.qty > 0 ? '+' : ''}${x.qty}</td>
            <td class="num">${UI.fmtMoney(x.unit_cost)}</td>
            <td class="num">${x.stock_after}</td>
            <td>${UI.esc(x.doc_no || x.ticket_no || '—')}</td>
            <td class="muted">${UI.esc(x.note || '')}</td>
            <td>${UI.esc(x.actor || '')}</td></tr>`))
      });
    }
    draw();
  }
});
