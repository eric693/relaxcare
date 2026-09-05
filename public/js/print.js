// 收據列印頁。獨立於主畫面，因為它要在新分頁開、而且列印時不能有側欄與按鈕。
//
// 收據上一定要有的三件事（客人事後爭議時就是靠這張紙）：
//   · 這次付了什麼、怎麼付的（現金／儲值／次卡／券各多少）
//   · 付完之後儲值餘額還有多少、次卡還剩幾次
//   · 開了哪張發票
// 少了第二項，客人下次來問「我的卡還剩幾次」就只能吵。

const $ = id => document.getElementById(id);

function row(label, value, cls = '') {
  return `<tr><td>${UI.esc(label)}</td><td class="num ${cls}">${value}</td></tr>`;
}

async function draw() {
  const m = /ticket=(\d+)/.exec(location.hash || '');
  if (!m) { $('out').innerHTML = '<div class="empty">網址少了鐘單編號</div>'; return; }
  let d;
  try { d = await GET(`/tickets/${m[1]}/receipt`); }
  catch (e) { $('out').innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }

  const t = d.ticket;
  const items = t.items || [];
  const paid = [
    ['現金／刷卡', t.paid_cash, t.pay_method],
    ['儲值扣款', t.paid_wallet, ''],
    ['次卡核銷', t.paid_pass, ''],
    ['團購券折抵', t.paid_voucher, '']
  ].filter(([, v]) => Number(v) > 0);

  $('out').innerHTML = `<div class="receipt">
    <h2>${UI.esc(d.store.name || d.company_name)}</h2>
    <div class="r-sub">
      ${d.store.phone ? UI.esc(d.store.phone) + '　' : ''}${UI.esc(d.store.address || '')}
    </div>
    <table>
      ${row('單號', UI.esc(t.ticket_no))}
      ${row('日期', UI.esc(t.actual_end || t.actual_start || t.start_at))}
      ${row('客人', UI.esc(t.member_name || t.guest_name || '現場客'))}
      ${d.show_therapist && t.therapist_name
        ? row('技師', `${UI.esc(t.therapist_code || '')} ${UI.esc(t.therapist_name)}${t.assign_type === 'designated' ? '（指名）' : ''}`) : ''}
      ${t.room_name ? row('床位', UI.esc(t.room_name)) : ''}
    </table>
    <div class="r-line"></div>
    <table>
      ${row(`${UI.esc(t.service_name)}　${t.minutes} 分`, UI.fmtMoney(t.amount - items.filter(i => i.kind !== 'retail').reduce((s, i) => s + i.amount, 0)))}
      ${items.map(i => row(`${UI.esc(i.name)}${i.qty > 1 ? ` x${i.qty}` : ''}`, UI.fmtMoney(i.amount))).join('')}
      ${Number(t.designate_fee) ? row('指名費', UI.fmtMoney(t.designate_fee)) : ''}
      ${Number(t.discount) ? row('折扣', '-' + UI.fmtMoney(t.discount), 'danger') : ''}
    </table>
    <div class="r-line"></div>
    <table>
      <tr class="r-total"><td>應收合計</td><td class="num">${UI.fmtMoney(t.net_amount)}</td></tr>
      ${paid.map(([k, v, extra]) => row(k + (extra ? `（${UI.esc(extra)}）` : ''), UI.fmtMoney(v))).join('')}
    </table>
    ${(d.wallet || (d.passes && d.passes.length) || (d.points && d.points.balance)) ? `
      <div class="r-line"></div>
      <table>
        ${d.wallet ? row('儲值餘額', `${UI.fmtMoney(d.wallet.total)}（現金 ${UI.fmtMoney(d.wallet.cash)}／贈送 ${UI.fmtMoney(d.wallet.bonus)}）`) : ''}
        ${(d.passes || []).map(p => row(`${UI.esc(p.name)}`, `尚餘 ${p.remain}／${p.total} 次${p.expiry_date ? `　${UI.esc(p.expiry_date)} 到期` : ''}`)).join('')}
        ${d.points ? row('累積點數', `${UI.fmtNum(d.points.balance)} 點${d.points.earned ? `（本次 +${d.points.earned}）` : ''}`) : ''}
      </table>` : ''}
    ${d.invoice ? `<div class="r-line"></div><table>
      ${row('發票號碼', `${UI.esc(d.invoice.track)}-${UI.esc(d.invoice.number)}`)}
      ${row('未稅／稅額', `${UI.fmtMoney(d.invoice.net_amount)}／${UI.fmtMoney(d.invoice.tax_amount)}`)}
      ${d.invoice.buyer_tax_id ? row('統一編號', UI.esc(d.invoice.buyer_tax_id)) : ''}
    </table>` : ''}
    <div class="r-foot">${UI.esc(d.footer || '')}
列印：${UI.esc(d.printed_at)}　${UI.esc(d.printed_by)}</div>
  </div>`;
  document.title = `收據 ${t.ticket_no}`;
}

$('btn-print').onclick = () => window.print();
$('btn-close').onclick = () => window.close();
window.addEventListener('hashchange', draw);
draw();
