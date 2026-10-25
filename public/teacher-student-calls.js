'use strict';

(() => {
  const button = $('studentInboxButton'), dialog = $('studentInboxDialog'), list = $('studentInbox');
  const rows = new Map();
  let generation = 0, pollVersion = 0, loading = false, calls = [], loaded = false;
  const states = { pending: '等待回应', replied: '已回应', cancelled: '学生已撤回', expired: '已超时', unavailable: '已不可用' };

  function render() {
    $('studentInboxEmpty').hidden = calls.length > 0;
    const present = new Set(calls.map((c) => c.id));
    for (const [id, row] of rows) if (!present.has(id)) {
      if (row.node.contains(document.activeElement)) $('studentInboxRefresh').focus();
      row.node.remove(); rows.delete(id);
    }
    for (const call of calls) {
      let row = rows.get(call.id);
      if (!row) {
        const node = el('article', 'student-inbox-item');
        const title = el('h3'), detail = el('p', 'muted'), message = el('p'), response = el('p', 'student-inbox-reply');
        detail.tabIndex = -1;
        const form = el('form', 'student-inbox-form'), label = el('label', 'field');
        const input = el('input'); input.type = 'text'; input.maxLength = 60; input.required = true;
        input.value = '收到，请稍等'; input.id = 'reply-' + call.id; label.htmlFor = input.id;
        label.append(el('span', '', '回复学生（最多 60 字）'), input);
        const submit = el('button', 'btn btn-primary', '发送回应'); submit.type = 'submit';
        const error = el('p', 'note bad'); error.setAttribute('role', 'alert'); error.hidden = true;
        form.append(label, submit, error); node.append(title, detail, message, response, form);
        row = { node, title, detail, message, response, form, input, submit, error, busy: false };
        rows.set(call.id, row); list.append(node);
        form.onsubmit = async (event) => {
          event.preventDefault();
          if (row.busy) return;
          const user = me, version = generation;
          row.busy = true; setBusy(submit, true); input.disabled = true; error.hidden = true;
          const result = await api('POST', '/api/me/student-calls/' + encodeURIComponent(call.id) + '/reply', { reply: input.value.trim() });
          if (version !== generation || me !== user) return;
          row.busy = false; setBusy(submit, false); input.disabled = false;
          if (!result.ok) { error.textContent = errText(result, '回复失败，请重试'); error.hidden = false; poll(); return; }
          pollVersion++;
          calls = calls.map((c) => c.id === call.id ? result.json.call : c);
          render(); updateCount(); toast('已回应学生');
        };
      }
      row.title.textContent = call.studentName + ' · ' + call.className;
      row.detail.textContent = dateTime(call.createdAt) + ' · ' + states[call.status];
      row.message.textContent = call.message || '这位同学正在找你。';
      row.response.textContent = call.reply ? '你的回应：' + call.reply : '';
      row.response.hidden = !call.reply;
      if (call.status !== 'pending' && row.form.contains(document.activeElement)) row.detail.focus();
      row.form.hidden = call.status !== 'pending';
      row.node.dataset.pending = String(call.status === 'pending');
      // 列表就地更新，轮询和新呼叫不会重建正在输入的回复。
    }
  }
  function updateCount() {
    const count = calls.filter((c) => c.status === 'pending').length;
    button.textContent = '学生呼叫' + (count ? ' · ' + count + ' 待回应' : '');
    button.classList.toggle('has-calls', count > 0);
  }
  async function poll() {
    if (!me || me.mustChangePassword || $('app').hidden || loading) return;
    loading = true;
    const user = me, version = generation, request = ++pollVersion;
    try {
      const result = await api('GET', '/api/me/student-calls');
      if (version !== generation || request !== pollVersion || me !== user || $('app').hidden) return;
      if (!result.ok) {
        $('studentInboxStatus').textContent = errText(result, '暂时无法读取呼叫，正在重试');
        button.textContent = '学生呼叫 · 连接中断';
        return;
      }
      const newcomers = result.json.calls.filter((c) => c.status === 'pending' && !calls.some((old) => old.id === c.id));
      calls = result.json.calls; render(); updateCount();
      $('studentInboxStatus').textContent = '每 5 秒自动更新。仅你收到的呼叫会出现在这里，回复将显示在发起呼叫的大屏。';
      if (newcomers.length && loaded) toast(newcomers[0].className + ' · ' + newcomers[0].studentName + ' 正在找你');
      loaded = true;
    } finally { loading = false; }
  }
  window.startStudentInbox = () => {
    generation++; calls = []; loaded = false; rows.clear(); list.replaceChildren();
    updateCount(); poll();
  };
  window.resetStudentInbox = () => {
    generation++; calls = []; loaded = false; rows.clear(); list.replaceChildren();
    if (dialog.open) dialog.close(); updateCount();
  };
  button.onclick = () => { dialog.showModal(); poll(); };
  $('studentInboxClose').onclick = () => dialog.close();
  $('studentInboxRefresh').onclick = poll;
  setInterval(poll, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('focus', poll);
  if (me && !$('app').hidden) window.startStudentInbox();
})();
