// API 呼叫共用：自動處理 JSON、錯誤訊息、401 導回登入
async function api(path, options = {}) {
  const opts = { headers: {}, credentials: 'same-origin', ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  // 唯讀模組的寫入請求先在前端擋下：伺服器一樣會拒絕，但這樣訊息更快也更清楚
  const method = (opts.method || 'GET').toUpperCase();
  if (method !== 'GET' && window.App && App.me && !App.canEdit(App.currentModule())) {
    throw new Error('你對這個模組只有檢視權限，不能修改');
  }
  const res = await fetch('/api' + path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && window.App && App.onUnauthorized) App.onUnauthorized();
    throw new Error((data && data.error) || '操作失敗，請稍後再試');
  }
  return data;
}
const GET = p => api(p);
const POST = (p, body) => api(p, { method: 'POST', body });
const PUT = (p, body) => api(p, { method: 'PUT', body });
const DEL = p => api(p, { method: 'DELETE' });
