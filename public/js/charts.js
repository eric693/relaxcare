// 零相依 SVG 圖表：長條圖（可分組、支援負值）、圓餅／甜甜圈、橫向長條
// 色盤已通過色盲辨識度驗證（CVD ΔE ≥ 8），順序固定不循環；第 9 個以上併入「其他」。
const Charts = {
  PALETTE: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  MAX_SLOTS: 8,

  esc: s => UI.esc(s),
  color(i) { return Charts.PALETTE[i % Charts.PALETTE.length]; },

  // 超過 8 項就把尾巴併成「其他」，避免產生辨識不出來的顏色
  fold(rows, max = Charts.MAX_SLOTS) {
    if (rows.length <= max) return rows;
    const head = rows.slice(0, max - 1);
    const rest = rows.slice(max - 1);
    head.push({ label: '其他', value: rest.reduce((a, r) => a + r.value, 0), folded: rest.length });
    return head;
  },

  // 座標軸刻度：取好記的級距（1／2／5 × 10^n）
  ticks(min, max, count = 4) {
    if (max === min) { max = min + 1; }
    const raw = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || mag * 10;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  },

  shortNum(n) {
    const v = Math.abs(n);
    if (v >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '億';
    if (v >= 1e4) return (n / 1e4).toFixed(v >= 1e6 ? 0 : 1).replace(/\.0$/, '') + '萬';
    return String(Math.round(n));
  },

  // 外框：標題 + 圖例 + 圖 + 表格切換（低對比色盤的「補救規則」：表格檢視必備）
  frame({ title, legend, svg, table, note }) {
    const id = 'c' + Math.random().toString(36).slice(2, 8);
    return `<div class="chart" id="${id}">
      ${title ? `<div class="chart-head"><span class="chart-title">${Charts.esc(title)}</span>
        ${table ? `<button type="button" class="chart-toggle" data-for="${id}">表格</button>` : ''}</div>` : ''}
      ${legend || ''}
      <div class="chart-plot">${svg}<div class="chart-tip" hidden></div></div>
      ${table ? `<div class="chart-table" hidden>${table}</div>` : ''}
      ${note ? `<div class="chart-note">${Charts.esc(note)}</div>` : ''}
    </div>`;
  },

  legend(items) {
    if (items.length < 2) return '';   // 單一數列不需要圖例，標題已經說明了
    return `<div class="chart-legend">${items.map((it, i) =>
      `<span class="lg"><i style="background:${it.color || Charts.color(i)}"></i>${Charts.esc(it.name)}</span>`).join('')}</div>`;
  },

  // ---- 直立長條圖（可多數列分組，支援負值）----
  // data: [{ label, values: [n, n, ...] }]，series: ['營收','毛利','淨利']
  bars({ title, data, series, fmt = UI.fmtMoney, note, height = 300 }) {
    const W = 860, H = height, P = { t: 16, r: 16, b: 34, l: 64 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const all = data.flatMap(d => d.values);
    const tk = Charts.ticks(Math.min(0, ...all), Math.max(0, ...all));
    const lo = tk[0], hi = tk[tk.length - 1];
    const y = v => P.t + ih - ((v - lo) / (hi - lo)) * ih;
    const gw = iw / (data.length || 1);
    const n = series.length;
    const bw = Math.min(46, (gw * 0.72) / n);
    const zero = y(0);

    let g = '';
    for (const t of tk) {
      g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"${t === 0 ? ' stroke-width="1.5"' : ''}/>
        <text class="ax" x="${P.l - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${Charts.shortNum(t)}</text>`;
    }

    let m = '';
    data.forEach((d, di) => {
      const cx = P.l + gw * di + gw / 2;
      const x0 = cx - (bw * n) / 2;
      d.values.forEach((v, si) => {
        const yv = y(v);
        const top = Math.min(yv, zero), h = Math.max(1.5, Math.abs(yv - zero));
        // 資料端 4px 圓角、與基線相接；相鄰長條留 2px 底色間隙
        m += `<rect class="bar" x="${(x0 + bw * si + 1).toFixed(1)}" y="${top.toFixed(1)}"
          width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${Charts.color(si)}"
          data-tip="${Charts.esc(d.label)}｜${Charts.esc(series[si])}：${Charts.esc(fmt(v))}"/>`;
      });
      m += `<text class="ax" x="${cx.toFixed(1)}" y="${H - 12}" text-anchor="middle">${Charts.esc(d.label)}</text>`;
    });

    const table = `<table class="list"><thead><tr><th>項目</th>${series.map(s => `<th>${Charts.esc(s)}</th>`).join('')}</tr></thead>
      <tbody>${data.map(d => `<tr><td>${Charts.esc(d.label)}</td>${d.values.map(v => `<td class="num">${Charts.esc(fmt(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

    return Charts.frame({
      title, note, table,
      legend: Charts.legend(series.map(s => ({ name: s }))),
      svg: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">${g}${m}</svg>`
    });
  },

  // ---- 橫向長條（單一數列的排行，項目名稱較長時用）----
  hbars({ title, data, fmt = UI.fmtMoney, note, colorByIndex = false }) {
    const rows = Charts.fold(data);
    const W = 860, rowH = 30, P = { t: 8, r: 90, b: 8, l: 130 };
    const H = P.t + P.b + rows.length * rowH;
    const max = Math.max(1, ...rows.map(r => Math.abs(r.value)));
    const iw = W - P.l - P.r;

    const m = rows.map((r, i) => {
      const w = Math.max(2, (Math.abs(r.value) / max) * iw);
      const yy = P.t + i * rowH + 4;
      const h = rowH - 10;
      return `<rect class="bar" x="${P.l}" y="${yy}" width="${w.toFixed(1)}" height="${h}" rx="4"
          fill="${colorByIndex ? Charts.color(i) : (r.value < 0 ? Charts.PALETTE[7] : Charts.PALETTE[0])}"
          data-tip="${Charts.esc(r.label)}：${Charts.esc(fmt(r.value))}"/>
        <text class="ax name" x="${P.l - 10}" y="${yy + h / 2 + 4}" text-anchor="end">${Charts.esc(r.label)}</text>
        <text class="val" x="${(P.l + w + 8).toFixed(1)}" y="${yy + h / 2 + 4}">${Charts.esc(fmt(r.value))}</text>`;
    }).join('');

    const table = `<table class="list"><thead><tr><th>項目</th><th>金額</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${Charts.esc(r.label)}</td><td class="num">${Charts.esc(fmt(r.value))}</td></tr>`).join('')}</tbody></table>`;

    return Charts.frame({
      title, note, table,
      svg: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">${m}</svg>`
    });
  },

  // ---- 圓餅／甜甜圈（結構佔比，例如費用科目）----
  donut({ title, data, fmt = UI.fmtMoney, note, centerLabel = '合計' }) {
    const rows = Charts.fold(data).filter(r => r.value > 0);
    const total = rows.reduce((a, r) => a + r.value, 0);
    const W = 860, H = 300, cx = 190, cy = H / 2, R = 112, r0 = 66;

    if (!total) {
      return Charts.frame({ title, note, svg: `<svg viewBox="0 0 ${W} ${H}"><text class="ax" x="${W / 2}" y="${H / 2}" text-anchor="middle">目前沒有資料</text></svg>` });
    }

    let a0 = -Math.PI / 2, segs = '';
    const pt = (a, rad) => `${(cx + Math.cos(a) * rad).toFixed(2)} ${(cy + Math.sin(a) * rad).toFixed(2)}`;
    const gap = 0.012;   // 相鄰扇形之間的底色間隙
    rows.forEach((r, i) => {
      const span = (r.value / total) * Math.PI * 2;
      const s = a0 + gap / 2, e = a0 + span - gap / 2;
      if (e > s) {
        const big = span > Math.PI ? 1 : 0;
        segs += `<path class="seg" d="M ${pt(s, R)} A ${R} ${R} 0 ${big} 1 ${pt(e, R)} L ${pt(e, r0)} A ${r0} ${r0} 0 ${big} 0 ${pt(s, r0)} Z"
          fill="${Charts.color(i)}" data-tip="${Charts.esc(r.label)}：${Charts.esc(fmt(r.value))}（${(r.value / total * 100).toFixed(1)}%）"/>`;
      }
      a0 += span;
    });

    // 右側直接標示每一項（色盤對比補救規則：一律附可見文字標籤）
    const lx = 400, ly0 = cy - (rows.length * 24) / 2 + 12;
    const labels = rows.map((r, i) => {
      const yy = ly0 + i * 24;
      return `<rect x="${lx}" y="${yy - 9}" width="11" height="11" rx="3" fill="${Charts.color(i)}"/>
        <text class="ax name" x="${lx + 18}" y="${yy}">${Charts.esc(r.label)}</text>
        <text class="val" x="${lx + 200}" y="${yy}">${Charts.esc(fmt(r.value))}</text>
        <text class="ax" x="${lx + 340}" y="${yy}">${(r.value / total * 100).toFixed(1)}%</text>`;
    }).join('');

    const table = `<table class="list"><thead><tr><th>項目</th><th>金額</th><th>佔比</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${Charts.esc(r.label)}</td><td class="num">${Charts.esc(fmt(r.value))}</td><td class="num">${(r.value / total * 100).toFixed(1)}%</td></tr>`).join('')}</tbody></table>`;

    return Charts.frame({
      title, note, table,
      svg: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
        ${segs}
        <text class="hero" x="${cx}" y="${cy - 2}" text-anchor="middle">${Charts.esc(Charts.shortNum(total))}</text>
        <text class="ax" x="${cx}" y="${cy + 18}" text-anchor="middle">${Charts.esc(centerLabel)}</text>
        ${labels}</svg>`
    });
  },

  // 掛上 hover 提示與表格切換；每次重繪畫面後呼叫一次
  mount(root = document) {
    root.querySelectorAll('.chart').forEach(c => {
      if (c._bound) return;
      c._bound = true;
      const tip = c.querySelector('.chart-tip');
      const plot = c.querySelector('.chart-plot');
      plot.addEventListener('mousemove', e => {
        const t = e.target.closest('[data-tip]');
        if (!t) { tip.hidden = true; return; }
        tip.textContent = t.getAttribute('data-tip');
        tip.hidden = false;
        const b = plot.getBoundingClientRect();
        const x = e.clientX - b.left, y = e.clientY - b.top;
        tip.style.left = Math.min(Math.max(x + 12, 4), b.width - tip.offsetWidth - 4) + 'px';
        tip.style.top = Math.max(y - tip.offsetHeight - 10, 4) + 'px';
      });
      plot.addEventListener('mouseleave', () => { tip.hidden = true; });
      const btn = c.querySelector('.chart-toggle');
      if (btn) btn.onclick = () => {
        const tb = c.querySelector('.chart-table');
        const show = tb.hidden;
        tb.hidden = !show; plot.hidden = show;
        c.querySelector('.chart-legend') && (c.querySelector('.chart-legend').hidden = show);
        btn.textContent = show ? '圖表' : '表格';
      };
    });
  }
};
