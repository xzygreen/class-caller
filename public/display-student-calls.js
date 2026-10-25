'use strict';

(() => {
  const dialog = $('studentCallDialog'), button = $('btnCallTeacher');
  const storageKey = 'cc.student-calls.' + classId;
  const states = { pending: '等待老师回应', replied: '老师已回应', cancelled: '已撤回', expired: '超过 30 分钟未回应，请当面联系老师', unavailable: '老师或班级信息已变化，请当面联系老师' };
  let ids = [], calls = [], busy = false, loading = false, ready = false, requestId = '', requestBody = '';
  let optionsVersion = 0, statusVersion = 0;
  const receiptRows = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) ids = [...new Set(saved.filter((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id)))].slice(0, 10);
  } catch {}
  let receiptsReady = ids.length === 0;

  const text = (tag, value, cls) => {
    const node = document.createElement(tag); node.textContent = value;
    if (cls) node.className = cls;
    return node;
  };
  const error = (message = '') => { $('studentCallError').textContent = message; };
  function save() { try { localStorage.setItem(storageKey, JSON.stringify(ids)); } catch {} }
  function uuid() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }
  async function request(sub, body) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
    try {
      const res = await fetch(classPath('public/' + sub), { method: body ? 'POST' : 'GET', cache: 'no-store', signal: abort.signal,
        headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) throw new Error(data && data.message || '服务暂时不可用，请稍后重试');
      return data;
    } catch (err) {
      if (err instanceof TypeError || err.name === 'AbortError') throw new Error('连接中断，请检查网络后重试；重复提交不会重复呼叫');
      throw err;
    } finally { clearTimeout(timer); }
  }
  async function loadOptions() {
    const version = ++optionsVersion;
    $('studentCallSend').disabled = true;
    $('studentCallWindow').textContent = '正在读取本班老师与作息…';
    try {
      const data = await request('student-call-options');
      if (version !== optionsVersion || !ready) return;
      const select = $('studentCallTeacher'), previous = select.value;
      select.replaceChildren(text('option', '请选择老师'));
      select.firstChild.value = '';
      for (const teacher of data.teachers) {
        const option = text('option', teacher.displayName + (teacher.title ? ' · ' + teacher.title : ''));
        option.value = teacher.id; select.append(option);
      }
      select.value = previous;
      const open = data.callWindow.open;
      $('studentCallWindow').textContent = !data.teachers.length ? '本班还没有可呼叫的老师，请联系管理员授权。'
        : open ? '现在可以呼叫。老师需打开教师端查看，30 分钟未回应会自动结束。'
          : '当前正在上课，暂不能呼叫老师。请在课间重试。';
      $('studentCallSend').disabled = busy || !open || !data.teachers.length;
    } catch (err) {
      if (version !== optionsVersion) return;
      $('studentCallWindow').textContent = '未能读取老师列表，请点击「刷新」重试。'; error(err.message);
    }
  }
  function renderReceipts() {
    const box = $('studentCallReceipts');
    $('studentCallEmpty').hidden = calls.length > 0;
    const present = new Set(calls.map((c) => c.id));
    for (const [id, row] of receiptRows) if (!present.has(id)) {
      if (row.node.contains(document.activeElement)) box.focus();
      row.node.remove(); receiptRows.delete(id);
    }
    const sorted = [...calls].sort((a, b) => b.createdAt - a.createdAt);
    for (const [index, call] of sorted.entries()) {
      let row = receiptRows.get(call.id);
      if (!row) {
        const node = text('article', '', 'student-receipt'); node.dataset.callId = call.id;
        const title = text('strong', ''), status = text('p', ''), message = text('p', ''), reply = text('p', '', 'student-reply');
        status.tabIndex = -1;
        const cancel = text('button', '撤回呼叫'); cancel.type = 'button';
        cancel.onclick = async () => {
          cancel.disabled = true; error(); ++statusVersion;
          try { const data = await request('student-calls/' + encodeURIComponent(call.id) + '/cancel', {}); updateCall(data.call); }
          catch (err) { error(err.message); cancel.disabled = false; await poll(); }
        };
        node.append(title, status, message, reply, cancel);
        row = { node, title, status, message, reply, cancel }; receiptRows.set(call.id, row);
        // 只把新节点插到时间顺序对应的位置，既有焦点节点不移动；Tab 与视觉顺序一致。
        box.insertBefore(node, box.children[index] || null);
      }
      row.title.textContent = call.studentName + ' → ' + call.teacherName;
      row.status.textContent = new Date(call.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' · ' + states[call.status];
      row.message.textContent = call.message; row.message.hidden = !call.message;
      row.reply.textContent = call.reply; row.reply.hidden = !call.reply;
      if (call.status !== 'pending' && document.activeElement === row.cancel) row.status.focus();
      row.cancel.hidden = call.status !== 'pending';
    }
  }
  function updateCall(call) {
    ++statusVersion;
    calls = [...calls.filter((c) => c.id !== call.id), call];
    renderReceipts();
  }
  async function poll() {
    if (!ready || !ids.length || loading) return;
    loading = true;
    const version = ++statusVersion;
    try {
      const data = await request('student-calls/status', { ids });
      if (version !== statusVersion || !ready) return;
      receiptsReady = true;
      const changed = JSON.stringify(calls) !== JSON.stringify(data.calls);
      const replies = data.calls.filter((c) => c.status === 'replied' && calls.some((old) => old.id === c.id && old.status === 'pending'));
      calls = data.calls;
      const count = calls.filter((c) => c.status === 'replied').length;
      button.textContent = count ? '呼叫老师 · ' + count + ' 条回应' : '呼叫老师';
      if (replies.length) chime();
      if (changed) renderReceipts();
      $('studentCallSync').textContent = '每 5 秒自动更新；记录仅供本设备查看。';
    } catch {
      $('studentCallSync').textContent = '暂时无法更新回应，正在重试；已有记录仍保留。';
    } finally { loading = false; }
  }
  window.enableStudentCalls = () => {
    ready = true; button.hidden = false; renderReceipts(); poll();
    if (QUERY.get('callTeacher') === '1') button.click();
  };
  window.disableStudentCalls = () => {
    ready = false; ++optionsVersion; ++statusVersion; button.hidden = true;
    if (dialog.open) dialog.close();
  };
  button.onclick = (event) => {
    event.stopPropagation();
    if (!ready) return;
    error(); dialog.showModal(); loadOptions(); poll();
  };
  $('studentCallClose').onclick = () => dialog.close();
  $('studentCallRefresh').onclick = () => { error(); loadOptions(); poll(); };
  // 发送期间保护同一份草稿，关闭后再打开仍保留回执或失败后的内容。
  $('studentCallForm').onsubmit = async (event) => {
    event.preventDefault();
    if (busy || !ready) return;
    if (!receiptsReady) { error('正在确认本设备已有呼叫，请稍后重试。'); poll(); return; }
    if (calls.filter((c) => c.status === 'pending').length >= 10) { error('本设备已有 10 条呼叫等待回应，请先等待或撤回。'); return; }
    const body = { studentName: $('studentCallName').value.trim(), teacherId: $('studentCallTeacher').value, message: $('studentCallMessage').value.trim() };
    if (!body.studentName || !body.teacherId) { error('请填写姓名并选择老师'); return; }
    const key = JSON.stringify(body);
    if (key !== requestBody) { requestId = uuid(); requestBody = key; }
    busy = true; error(); $('studentCallFields').disabled = true; $('studentCallSend').textContent = '正在发送…';
    ++statusVersion;
    try {
      const data = await request('student-calls', { ...body, requestId });
      if (!ready) return;
      const updated = [...calls.filter((c) => c.id !== data.call.id), data.call];
      // 待回应优先，余下名额保留最近的已结束回执；绝不能按发送顺序挤掉待回应。
      updated.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt - a.createdAt);
      calls = updated.slice(0, 10); ids = calls.map((c) => c.id); save(); ++statusVersion;
      renderReceipts(); requestBody = ''; requestId = '';
      $('studentCallForm').reset(); $('studentCallSync').textContent = '已发送，请在下方查看老师回应。';
      $('studentCallReceipts').scrollIntoView({ block: 'nearest' });
    } catch (err) { error(err.message); }
    finally { busy = false; $('studentCallFields').disabled = false; $('studentCallSend').textContent = '呼叫老师'; if (ready) loadOptions(); }
  };
  setInterval(poll, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  if (klass && !previewMode && !document.body.classList.contains('bind-error')) window.enableStudentCalls();
})();
