'use strict';

const $ = (id) => document.getElementById(id);

/* ================= 页面状态 ================= */
// 当前班级：只以 URL ?class= 与本班的登录令牌为准。
// 令牌按班级分别存放（cc.token.<classId>），同一浏览器开两个班的标签页不会互相覆盖。
let classId = '';
let klass = null;            // { classId, className, code, color }
let token = '';
let classList = [];

let students = [];
let autoClearSeconds = 0;
let maxNamesPerCall = 20;
const sel = new Set();
let history = [];
let historyVersion = -1;
let historyLimit = 500;
let droppedRecords = 0;
let counts = Object.create(null);
let currentEvent = null;
let sending = false;
let historyLoading = null;

const tokenKey = (id) => 'cc.token.' + id;
const classLabel = () => (klass ? klass.className + ' ' + klass.code : '');
const CLASS_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/* ================= 提示条 ================= */
function toast(text, bad) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('bad', Boolean(bad));
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ================= API：一律走本班作用域 ================= */
function classPath(sub) {
  return '/api/classes/' + encodeURIComponent(classId) + '/' + sub;
}

async function api(method, sub, body) {
  const res = await fetch(classPath(sub), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Teacher-Token': token,
    },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json };
}

function showApiError(res, fallback) {
  if (res.status === 401 || res.status === 403) return gateOut('登录已失效，请重新选择班级并登录');
  if (res.json && res.json.error === 'CLASS_NOT_FOUND') return gateOut('该班级已不存在，请重新选择班级');
  const detail = res.json && res.json.detail ? '：' + res.json.detail : '';
  toast(((res.json && res.json.message) || fallback) + detail, true);
  return null;
}

/* ================= 找人记录 ================= */
function rebuildCounts() {
  counts = Object.create(null);
  for (const record of history) {
    for (const name of record.names) counts[name] = (counts[name] || 0) + 1;
  }
}

async function loadHistory(force) {
  if (historyLoading) {
    if (!force) return historyLoading;
    await historyLoading;
  }
  historyLoading = (async () => {
    let res;
    try {
      res = await api('GET', 'teacher/history');
    } catch {
      toast('找人记录载入失败，请检查网络', true);
      return false;
    }
    if (!res.ok) {
      showApiError(res, '找人记录载入失败');
      return false;
    }
    // 服务端异常时也绝不把别班的记录画到本班页面上
    if (res.json.classId !== classId) return false;
    history = Array.isArray(res.json.records) ? res.json.records : [];
    historyVersion = Number.isSafeInteger(res.json.version) ? res.json.version : 0;
    historyLimit = res.json.limit || 500;
    droppedRecords = res.json.droppedRecords || 0;
    rebuildCounts();
    renderGrid();
    renderHistory();
    return true;
  })().finally(() => { historyLoading = null; });
  return historyLoading;
}

/* ================= 渲染：名字网格 ================= */
function renderGrid() {
  const q = $('search').value.trim();
  const grid = $('grid');
  grid.innerHTML = '';
  const list = students.filter((name) => !q || name.includes(q));

  for (const name of list) {
    const selected = sel.has(name);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 's';
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    button.disabled = !selected && sel.size >= maxNamesPerCall;
    if (counts[name]) {
      button.dataset.called = '1';
      const badge = document.createElement('b');
      badge.textContent = counts[name];
      badge.title = '已找过 ' + counts[name] + ' 次';
      button.appendChild(badge);
    }
    button.appendChild(document.createTextNode(name));
    button.onclick = () => {
      if (sel.has(name)) sel.delete(name);
      else if (sel.size < maxNamesPerCall) sel.add(name);
      else return toast('一次最多选择 ' + maxNamesPerCall + ' 人', true);
      renderGrid();
      renderPicked();
    };
    grid.appendChild(button);
  }

  const called = students.filter((name) => counts[name]).length;
  const selectedText = '已选择 ' + sel.size + ' / ' + maxNamesPerCall;
  $('hint').textContent = q
    ? '匹配 ' + list.length + ' 人 · ' + selectedText
    : selectedText + (called ? ' · 已找过 ' + called + ' 人' : '');
}

/* ================= 渲染：已选 ================= */
function renderPicked() {
  const box = $('picked');
  box.innerHTML = '';
  if (!sel.size) {
    box.innerHTML = '<span class="ph">请从名单中选择同学</span>';
  } else {
    for (const name of sel) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.append(name);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', '取消 ' + name);
      remove.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
        + ' stroke-width="3.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      remove.onclick = () => {
        sel.delete(name);
        renderGrid();
        renderPicked();
      };
      chip.appendChild(remove);
      box.appendChild(chip);
    }
  }
  $('send').disabled = sel.size === 0 || sending;
  $('reset').disabled = sel.size === 0;
  // 发送按钮必须写明目标班级，不能只写「通知到大屏」
  const target = klass ? klass.className + '大屏' : '大屏';
  $('send').textContent = sel.size ? ('通知 ' + sel.size + ' 人到' + target) : ('通知到' + target);
}

/* ================= 渲染：历史 ================= */
function renderHistory() {
  const box = $('history');
  box.innerHTML = '';
  if (!history.length) {
    box.innerHTML = '<span class="ph">还没有找人记录</span>';
  } else {
    for (const record of [...history].reverse()) {
      const row = document.createElement('div');
      row.className = 'hrow';

      const time = document.createElement('time');
      time.textContent = new Date(record.createdAt).toTimeString().slice(0, 5);

      const copy = document.createElement('div');
      copy.className = 'hcopy';
      const names = document.createElement('strong');
      names.textContent = record.names.join('、');
      copy.appendChild(names);
      const meta = [];
      meta.push(record.caller || '老师');
      if (record.message) meta.push(record.message);
      if (record.deliveryCount > 1) meta.push('已发送 ' + record.deliveryCount + ' 次');
      if (meta.length) {
        const small = document.createElement('small');
        small.textContent = meta.join(' · ');
        copy.appendChild(small);
      }

      const resend = document.createElement('button');
      resend.type = 'button';
      resend.className = 'link';
      resend.dataset.resend = record.recordId;
      resend.disabled = sending;
      resend.textContent = '再通知';
      resend.setAttribute('aria-label', '再次通知 ' + record.names.join('、'));
      resend.onclick = () => resendRecord(record.recordId);

      row.append(time, copy, resend);
      box.appendChild(row);
    }
  }
  $('undo').disabled = history.length === 0 || sending;
  $('wipe').disabled = history.length === 0 || sending;
  $('resend').disabled = history.length === 0 || sending;
  if (droppedRecords > 0) {
    const note = document.createElement('span');
    note.className = 'ph';
    note.textContent = '仅保留最近 ' + historyLimit + ' 条，较早记录已省略';
    box.appendChild(note);
  }
}

/* ================= 渲染：大屏当前状态 ================= */
let cdTimer = null;

function renderNow() {
  const namesBox = $('nowNames');
  const ev = currentEvent;

  if (!ev || ev.type !== 'call') {
    $('nowTitle').textContent = klass ? klass.className + '大屏正在通知' : '大屏正在通知';
    namesBox.className = 'idle';
    namesBox.textContent = '当前为空';
    $('ackSummary').textContent = '';
    $('ackSummary').classList.remove('all');
    $('nowMsg').textContent = '';
    $('countdown').classList.remove('on');
    clearInterval(cdTimer);
    return;
  }

  namesBox.className = '';
  $('nowTitle').textContent = (ev.caller || '老师') + '正在找';
  namesBox.innerHTML = '';
  const acked = new Map();
  for (const ack of Array.isArray(ev.acks) ? ev.acks : []) {
    if (ack && typeof ack.name === 'string') acked.set(ack.name, ack.at);
  }
  for (const name of ev.names) {
    const chip = document.createElement('span');
    chip.className = 'ack';
    const isAcked = acked.has(name);
    chip.dataset.acked = isAcked ? '1' : '0';
    const dot = document.createElement('i');
    const small = document.createElement('small');
    if (isAcked) {
      const at = new Date(acked.get(name));
      small.textContent = '已收到 ' + at.toTimeString().slice(0, 5);
      chip.title = name + ' 已在大屏确认收到';
    } else {
      small.textContent = '未收到';
      chip.title = name + ' 尚未在大屏点「收到」';
    }
    chip.append(dot, name, small);
    namesBox.appendChild(chip);
  }
  const summary = $('ackSummary');
  const ackedCount = ev.names.filter((name) => acked.has(name)).length;
  summary.classList.toggle('all', ackedCount === ev.names.length);
  summary.textContent = ackedCount === ev.names.length
    ? '全部 ' + ev.names.length + ' 人已确认收到'
    : '已收到 ' + ackedCount + ' / ' + ev.names.length + ' 人';
  $('nowMsg').textContent = ev.message || '';

  clearInterval(cdTimer);
  if (!ev.expiresAt) {
    $('countdown').classList.add('on');
    $('cdText').textContent = '常驻';
    $('cdBar').firstElementChild.style.transform = 'scaleX(1)';
    return;
  }

  const total = ev.expiresAt - ev.createdAt;
  const skew = Date.now() - ev.serverTime;
  const expiry = ev.expiresAt + skew;

  const paint = () => {
    const remain = expiry - Date.now();
    if (remain <= 0) {
      clearInterval(cdTimer);
      $('countdown').classList.remove('on');
      currentEvent = null;
      renderNow();
      return;
    }
    $('countdown').classList.add('on');
    $('cdText').textContent = '剩余 ' + Math.ceil(remain / 1000) + ' 秒';
    $('cdBar').firstElementChild.style.transform = 'scaleX(' + (remain / total) + ')';
  };
  paint();
  cdTimer = setInterval(paint, 250);
}

function setSending(value) {
  sending = value;
  const button = $('send');
  button.classList.toggle('loading', value);
  if (value) button.dataset.loading = '1'; else delete button.dataset.loading;
  $('clear').disabled = value;
  renderPicked();
  renderHistory();
}

function successToast(result, verb) {
  const where = klass ? klass.className : '';
  if (result.displays) {
    toast(verb + '，' + where + result.displays + ' 块大屏在线');
  } else if (result.launchers) {
    toast(verb + '，' + where + '原生启动器在线');
  } else {
    toast(verb + '，但' + where + '大屏和启动器均未连接', true);
  }
}

/** 只接受本班的快照；串班消息哪怕来自服务端也不显示 */
function ownEvent(ev) {
  if (!ev || typeof ev.id !== 'number') return null;
  if (ev.classId !== classId) return null;
  return ev.type === 'call' ? ev : null;
}

/* ================= 发送与记录操作 ================= */
async function submitCall(names, message, caller) {
  if (sending || !names.length) return null;
  setSending(true);
  try {
    const res = await api('POST', 'teacher/call', { names, message, caller });
    if (!res.ok) return showApiError(res, '发送失败');
    currentEvent = ownEvent(res.json.event);
    historyVersion = res.json.historyVersion;
    await loadHistory(true);
    renderNow();
    successToast(res.json, '已通知到' + (klass ? klass.className : '') + '大屏');
    return res.json;
  } catch {
    toast('连不上服务器', true);
    return null;
  } finally {
    setSending(false);
  }
}

async function resendRecord(recordId) {
  if (sending || !recordId) return;
  setSending(true);
  try {
    const res = await api('POST', 'teacher/history/resend', { recordId });
    if (!res.ok) {
      if (res.status === 409 || (res.json && res.json.error === 'HISTORY_RECORD_NOT_FOUND')) {
        await loadHistory(true);
      }
      return showApiError(res, '再次通知失败');
    }
    currentEvent = ownEvent(res.json.event);
    historyVersion = res.json.historyVersion;
    await loadHistory(true);
    renderNow();
    successToast(res.json, '已再次通知');
  } catch {
    toast('连不上服务器', true);
  } finally {
    setSending(false);
  }
}

$('send').onclick = async () => {
  const names = [...sel];
  if (!names.length) return toast('请先选择同学', true);
  const done = await submitCall(names, $('msg').value.trim(), $('caller').value);
  if (!done) return;
  sel.clear();
  $('msg').value = '';
  $('search').value = '';
  renderGrid();
  renderPicked();
};

$('clear').onclick = async () => {
  if (sending) return;
  setSending(true);
  try {
    const res = await api('POST', 'teacher/clear', {});
    if (!res.ok) return showApiError(res, '清空大屏失败');
    currentEvent = null;
    renderNow();
    toast((klass ? klass.className : '') + '大屏内容已清空');
  } catch {
    toast('连不上服务器', true);
  } finally {
    setSending(false);
  }
};

$('resend').onclick = () => {
  const last = history[history.length - 1];
  if (last) resendRecord(last.recordId);
};

$('undo').onclick = async () => {
  const last = history[history.length - 1];
  if (!last || sending) return;
  setSending(true);
  try {
    const res = await api('POST', 'teacher/history/undo', {
      expectedRecordId: last.recordId,
    });
    if (!res.ok) {
      if (res.status === 409) await loadHistory(true);
      return showApiError(res, '撤销失败');
    }
    currentEvent = ownEvent(res.json.current);
    historyVersion = res.json.historyVersion;
    await loadHistory(true);
    renderNow();
    toast('已撤销：' + last.names.join('、'));
  } catch {
    toast('连不上服务器', true);
  } finally {
    setSending(false);
  }
};

$('wipe').onclick = async () => {
  if (!history.length || sending) return;
  const confirmed = window.confirm('清空' + (klass ? klass.className : '') + '的全部找人记录？\n\n大屏当前通知不会改变，其他班级不受影响。');
  if (!confirmed) return;
  setSending(true);
  try {
    const res = await api('POST', 'teacher/history/clear', {
      expectedVersion: historyVersion,
    });
    if (!res.ok) {
      if (res.status === 409) await loadHistory(true);
      return showApiError(res, '清空记录失败');
    }
    historyVersion = res.json.historyVersion;
    await loadHistory(true);
    toast('找人记录已清空，大屏通知保持不变');
  } catch {
    toast('连不上服务器', true);
  } finally {
    setSending(false);
  }
};

/* ================= 其它交互 ================= */
$('reset').onclick = () => {
  sel.clear();
  renderGrid();
  renderPicked();
};
$('search').oninput = renderGrid;
$('msg').oninput = renderPicked;
$('caller').onchange = renderPicked;
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    $('search').value = '';
    renderGrid();
    $('search').blur();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('app').hidden) $('send').click();
});

$('switch').onclick = async () => {
  // 切班必须退出：清掉本班令牌与所有已选内容，回到选班页重新验证目标班密码
  try { await api('POST', 'teacher/logout', {}); } catch {}
  gateOut('', true);
};

/* ================= 实时状态：SSE（轮询作为兜底） ================= */
function ackSignature(ev) {
  if (!ev || !Array.isArray(ev.acks)) return '';
  return ev.acks.map((ack) => ack && ack.name).join('|');
}

let liveStream = null;
function disconnectLive() {
  if (liveStream) { liveStream.close(); liveStream = null; }
}
function connectLive() {
  disconnectLive();
  if (!window.EventSource || !classId) return;
  liveStream = new EventSource(classPath('public/stream?role=teacher'));
  liveStream.onmessage = (event) => {
    let ev = null;
    try { ev = JSON.parse(event.data); } catch { return; }
    if (!ev || typeof ev.id !== 'number' || ev.classId !== classId) return;
    const next = ev.type === 'call' ? ev : null;
    const changed = !currentEvent || !next || currentEvent.id !== next.id
      || ackSignature(currentEvent) !== ackSignature(next);
    // 自己刚发送时 submitCall 已经写入 currentEvent；这里只在有变化时重绘
    currentEvent = next;
    if (changed) renderNow();
  };
}

/* ================= 大屏状态轮询 ================= */
async function pollStatus() {
  if ($('app').hidden) return;
  const box = $('live');
  try {
    const res = await api('GET', 'teacher/status');
    if (res.status === 401 || res.status === 403) return gateOut('登录已失效，请重新选择班级并登录');
    if (!res.ok) throw new Error();
    if (res.json.classId !== classId) return;

    const displays = res.json.displays || 0;
    const launchers = res.json.launchers || 0;
    box.className = 'live ' + (displays ? 'on' : 'off');
    $('liveText').textContent = displays
      ? '本班大屏在线 ' + displays + (launchers ? ' · 启动器 ' + launchers : '')
      : '本班大屏未连接' + (launchers ? ' · 启动器 ' + launchers : '');

    const ev = ownEvent(res.json.current);
    const changed = !currentEvent || !ev || currentEvent.id !== ev.id
      || ackSignature(currentEvent) !== ackSignature(ev);
    currentEvent = ev;
    if (changed) renderNow();
    if (res.json.historyVersion !== historyVersion) loadHistory();
  } catch {
    box.className = 'live off';
    $('liveText').textContent = '服务器失联';
  }
}

/* ================= 班级标识 ================= */
function applyClassIdentity() {
  document.documentElement.dataset.classColor = klass ? klass.color : '';
  const label = classLabel();
  $('title').childNodes[0].nodeValue = klass ? klass.className + '　老师找人' : '老师找人';
  $('classBadge').textContent = klass ? '当前班级：' + label : '';
  $('classBadge').hidden = !klass;
  $('historyTitle').textContent = klass ? klass.className + '找人记录' : '找人记录';
  $('nowTitle').textContent = klass ? klass.className + '大屏正在通知' : '大屏正在通知';
  document.title = klass ? klass.className + ' · 老师找人' : '老师找人';
}

/** 切班/登出时立即清空一切与上一个班有关的内容 */
function resetWorkspace() {
  sel.clear();
  students = [];
  history = [];
  historyVersion = -1;
  counts = Object.create(null);
  currentEvent = null;
  $('msg').value = '';
  $('caller').selectedIndex = 0;
  $('search').value = '';
  disconnectLive();
  clearInterval(cdTimer);
}

/* ================= 登录 ================= */
function gateOut(message, clearSelection) {
  if (classId) sessionStorage.removeItem(tokenKey(classId));
  token = '';
  resetWorkspace();
  $('gatePwd').value = '';
  if (clearSelection) {
    // 主动切班：回到未选班状态，不能默认停在原班
    classId = '';
    klass = null;
    $('gateClass').value = '';
    $('gateClass').onchange();
    window.history.replaceState(null, '', location.pathname);
  }
  applyClassIdentity();
  showGate(message);
  return null;
}

function setUrlClass(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('class', id); else url.searchParams.delete('class');
  window.history.replaceState(null, '', url);
}

$('gateForm').onsubmit = async (event) => {
  event.preventDefault();
  const chosen = $('gateClass').value;
  if (!CLASS_ID_RE.test(chosen)) {
    $('gateErr').textContent = '请先选择班级';
    $('gateClass').focus();
    return;
  }
  const button = $('gateBtn');
  button.dataset.loading = '1';
  button.disabled = true;

  classId = chosen;
  klass = classList.find((c) => c.id === chosen)
    ? toKlass(classList.find((c) => c.id === chosen)) : null;
  setUrlClass(classId);

  let res;
  try {
    const raw = await fetch(classPath('teacher/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('gatePwd').value }),
    });
    res = { status: raw.status, ok: raw.ok, json: await raw.json().catch(() => null) };
  } catch {
    res = { status: 0, ok: false, json: null };
  }
  button.disabled = false;
  delete button.dataset.loading;

  if (!res.ok) {
    $('gateErr').textContent = res.status === 0
      ? '连不上服务器'
      : ((res.json && res.json.message) || '登录失败');
    if (res.status === 401) {
      $('gatePwd').classList.add('bad');
      $('gatePwd').select();
    }
    return;
  }
  token = res.json.token;
  sessionStorage.setItem(tokenKey(classId), token);
  klass = res.json.class;
  $('gatePwd').value = '';
  if (!await enter()) showGate($('gateErr').textContent);
};
$('gatePwd').oninput = () => $('gatePwd').classList.remove('bad');
$('gateClass').onchange = () => {
  $('gateErr').textContent = '';
  const chosen = classList.find((c) => c.id === $('gateClass').value);
  document.documentElement.dataset.classColor = chosen ? chosen.color : '';
  $('gatePick').textContent = chosen ? '将登录：' + chosen.name + ' ' + chosen.code : '';
};

function toKlass(c) {
  return { classId: c.id, className: c.name, code: c.code, color: c.color };
}

/** 用当前令牌拉本班名单；成功则进入主界面 */
async function enter() {
  let res;
  try {
    res = await api('GET', 'teacher/students');
  } catch {
    $('gateErr').textContent = '连不上服务器';
    return false;
  }
  if (res.status === 401 || res.status === 403) {
    $('gateErr').textContent = '登录已失效，请重新登录';
    sessionStorage.removeItem(tokenKey(classId));
    token = '';
    return false;
  }
  if (!res.ok) {
    $('gateErr').textContent = (res.json && res.json.message) || '载入失败';
    return false;
  }
  if (res.json.classId !== classId) {
    $('gateErr').textContent = '服务器返回的班级不一致，请重新登录';
    return false;
  }

  klass = { classId: res.json.classId, className: res.json.className, code: res.json.code, color: res.json.color };
  students = res.json.students || [];
  autoClearSeconds = res.json.autoClearSeconds || 0;
  maxNamesPerCall = res.json.maxNamesPerCall || 20;
  applyClassIdentity();
  $('count').textContent = '共 ' + students.length + ' 名同学'
    + (autoClearSeconds ? ' · 大屏 ' + autoClearSeconds + ' 秒后自动清除' : ' · 大屏常驻显示');

  $('gate').hidden = true;
  $('app').hidden = false;
  renderGrid();
  renderPicked();
  renderHistory();
  renderNow();
  connectLive();
  await loadHistory(true);
  await pollStatus();
  return true;
}

/* ================= 启动 ================= */
function showGate(message) {
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gateErr').textContent = message || '';
  if ($('gateClass').value) $('gatePwd').focus(); else $('gateClass').focus();
}

function fillClassOptions() {
  const select = $('gateClass');
  select.innerHTML = '<option value="">请选择班级</option>';
  for (const c of classList) {
    const option = document.createElement('option');
    option.value = c.id;
    option.textContent = c.name + '（' + c.code + '）';
    select.appendChild(option);
  }
}

(async function init() {
  try {
    const res = await (await fetch('/api/public/classes')).json();
    if (res && res.ok && Array.isArray(res.classes)) classList = res.classes;
  } catch {}
  fillClassOptions();

  const wanted = new URLSearchParams(location.search).get('class') || '';
  const known = classList.find((c) => c.id === wanted);
  if (known) {
    classId = known.id;
    klass = toKlass(known);
    $('gateClass').value = classId;
    $('gateClass').onchange();
    token = sessionStorage.getItem(tokenKey(classId)) || '';
  }
  applyClassIdentity();

  // 有本班的有效令牌就直接进；否则一律回到选班页，绝不自动进入某个默认班级
  if (classId && token && await enter()) {
    // 已进入
  } else {
    if (classId && !token) $('gateErr').textContent = '';
    showGate(classId && !token ? '' : $('gateErr').textContent);
  }

  setInterval(pollStatus, 5000);
})();
