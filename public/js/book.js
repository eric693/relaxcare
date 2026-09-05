// 官網線上預約頁（免登入）。送出的只是「預約申請」，門市確認後才成立。
(async function () {
  const box = document.getElementById('bk-form');
  let info;
  try { info = await GET('/public/booking-info'); }
  catch { box.innerHTML = '<div class="notice danger">目前無法載入預約資訊，請直接來電。</div>'; return; }
  if (!info.enabled) { box.innerHTML = '<div class="notice">目前未開放線上預約，請直接來電洽詢。</div>'; return; }

  document.getElementById('bk-title').textContent = info.company_name;
  document.getElementById('bk-sub').textContent = '線上預約';

  const opt = (arr, label) => [['', label]].concat(arr);
  box.innerHTML = `
    <div class="form-grid">
      ${UI.input('name', '姓名', { required: true, full: true })}
      ${UI.input('phone', '聯絡電話', { required: true, full: true })}
      ${UI.input('line_id', 'LINE ID（選填）', { full: true })}
      ${UI.select('store_id', '門市', opt(info.stores.map(s => [s.id, `${s.name}（${s.open_time}~${s.close_time}）`]), '請選擇'), { full: true, plain: true })}
      ${UI.select('service_id', '想做的項目', opt(info.services.map(s => [s.id, `${s.name}　${s.minutes} 分　NT$ ${s.price}`]), '不指定'), { full: true })}
      ${UI.select('therapist_id', '指定技師（選填）', opt(info.therapists.map(t => [t.id, `${t.code} ${t.name}（${t.level}）`]), '不指定'), { full: true })}
      ${UI.input('prefer_date', '希望日期', { type: 'date', full: true })}
      ${UI.select('prefer_time', '希望時段', ['', '11:00', '12:30', '14:00', '15:30', '17:00', '18:30', '20:00', '21:30'], { full: true, plain: true })}
      ${UI.input('pax', '人數', { type: 'number', value: 1, full: true })}
      ${UI.textarea('note', '備註（力道偏好、身體狀況、停車需求…）', { rows: 3 })}
    </div>
    <button class="btn" id="send">送出預約</button>
    <div class="notice" style="margin-top:12px">${UI.esc(info.notice || '')}</div>
    <div class="muted" style="margin-top:8px;font-size:12.5px">
      提醒：若您有懷孕、近期手術、心血管疾病、服用抗凝血劑等情形，請在備註告知，我們會據以調整服務內容與力道。
      本館為民俗調理服務，不提供醫療行為。
    </div>`;
  UI.bindSearchSelects(box);

  document.getElementById('send').onclick = async () => {
    const d = UI.formData(box);
    try {
      const r = await POST('/public/booking', d);
      box.innerHTML = `<div class="notice ok">✓ 已收到您的預約申請，編號 <b>${UI.esc(r.booking_no)}</b>。<br>${UI.esc(r.message)}</div>`;
    } catch (e) { UI.err(e); }
  };
})();
