'use strict';

const $ = (id) => document.getElementById(id);

/* ================= 班级绑定 =================
 * 每块大屏永久绑定一个班：display.html?class=class-a。
 * 没有 class 参数、或班级不存在时，不进入任何班级，只显示绑定错误。 */
const CLASS_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const QUERY = new URLSearchParams(location.search);
const classId = (QUERY.get('class') || '').trim();
let klass = null;            // { classId, className, code, color }

function classPath(sub) {
  return '/api/classes/' + encodeURIComponent(classId) + '/' + sub;
}

function showBindError(title, detail, retrying = false) {
  document.body.classList.add('bind-error');
  document.body.classList.remove('active', 'notice', 'urgent');
  $('bindTitle').textContent = title;
  $('bindDetail').textContent = detail;
  $('klass').textContent = '未绑定班级';
  $('klassCode').textContent = '';
  // 参数错误不会自行恢复；网关或网络故障则保留自动重试提示。
  $('reconnect').classList.toggle('show', retrying);
  document.title = '班级绑定错误 · 老师找人通知';
}

function applyClassIdentity() {
  if (!klass) return;
  $('klass').textContent = klass.className;
  $('klassCode').textContent = klass.code;
  $('stageKlass').textContent = klass.className + ' · ' + klass.code;
  document.documentElement.dataset.classColor = klass.color || '';
  document.title = klass.className + ' · 老师找人通知';
}

/* ================= 时钟 ================= */
const WD = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
function tick() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const hh = p(d.getHours()), mm = p(d.getMinutes());
  $('clock').innerHTML = hh + '<s>:</s>' + mm;
  $('railClock').textContent = hh + ':' + mm;
  $('date').textContent = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · ' + WD[d.getDay()];
}
tick();
setInterval(tick, 1000);

/* ================= 提示音 ================= */
let soundOn = localStorage.getItem('cc.sound') !== '0';
let ac = null;

function audioLocked() { return !ac || ac.state === 'suspended'; }

function syncSoundUi() {
  const button = $('btnSound');
  button.setAttribute('aria-pressed', String(soundOn));
  button.querySelector('.wave').style.display = soundOn ? '' : 'none';
  button.querySelector('.mute').style.display = soundOn ? 'none' : '';
  $('audioTip').classList.toggle('show', soundOn && audioLocked());
}

function unlockAudio() {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume().then(syncSoundUi, () => {});
  } catch {}
  syncSoundUi();
}

function chime() {
  if (!soundOn || audioLocked()) return;
  try {
    [[880, 0], [1174, .13]].forEach(([frequency, delay]) => {
      const oscillator = ac.createOscillator();
      const gain = ac.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = frequency;
      const time = ac.currentTime + delay;
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.22, time + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.6);
      oscillator.connect(gain).connect(ac.destination);
      oscillator.start(time);
      oscillator.stop(time + 0.65);
    });
  } catch {}
}

$('btnSound').onclick = (event) => {
  event.stopPropagation();
  soundOn = !soundOn;
  localStorage.setItem('cc.sound', soundOn ? '1' : '0');
  if (soundOn) unlockAudio(); else syncSoundUi();
};
$('btnFull').onclick = (event) => {
  event.stopPropagation();
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
};

/* ================= 排版：按容器实测像素定字号与列数 ================= */
let currentNames = [];

function layout() {
  const box = $('names');
  if (!currentNames.length) return;
  const width = box.clientWidth;
  const height = box.clientHeight;
  if (!width || !height) return;

  const count = currentNames.length;
  const maxLength = Math.max(...currentNames.map((name) => [...name].length));
  let best = { columns: 1, size: 0 };
  for (let columns = 1; columns <= Math.min(count, 6); columns += 1) {
    const rows = Math.ceil(count / columns);
    const gapX = width * 0.045;
    const gapY = height * 0.06;
    const cellWidth = (width - gapX * (columns - 1)) / columns;
    const cellHeight = (height - gapY * (rows - 1)) / rows;
    const size = Math.min(cellWidth / (maxLength * 1.08), cellHeight / 1.52);
    if (size > best.size) best = { columns, size };
  }

  const size = Math.min(best.size, height * 0.58);
  box.style.gridTemplateColumns = 'repeat(' + best.columns + ', auto)';
  box.style.gap = (height * 0.06) + 'px ' + (width * 0.045) + 'px';
  box.style.fontSize = Math.max(16, Math.floor(size)) + 'px';
}

if (window.ResizeObserver) {
  new ResizeObserver(() => layout()).observe($('names'));
} else {
  window.addEventListener('resize', layout);
}

/* ================= 本地程序启动与去重 ================= */
const PROCESSED_KEY = 'cc.launch.processed.v1';
const PROCESSED_LIMIT = 100;
let launcherMode = 'off';
let previewMode = false;

function loadProcessed() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROCESSED_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function rememberProcessed(deliveryId) {
  const ids = loadProcessed().filter((id) => id !== deliveryId);
  ids.push(deliveryId);
  try {
    localStorage.setItem(PROCESSED_KEY, JSON.stringify(ids.slice(-PROCESSED_LIMIT)));
  } catch {}
}

function showLaunchWarning() {
  $('launchWarning').classList.add('show');
}

function maybeLaunch(ev) {
  if (previewMode || launcherMode !== 'protocol' || ev.type !== 'call') return;
  if (typeof ev.deliveryId !== 'string' || typeof ev.launchPayload !== 'string') return;
  if (!/^[A-Za-z0-9_-]+$/.test(ev.launchPayload)) return;
  if (!Number.isFinite(ev.launchValidUntil) || !Number.isFinite(ev.serverTime)) return;
  if (ev.serverTime > ev.launchValidUntil) return;
  if (loadProcessed().includes(ev.deliveryId)) return;

  // 先记账再交给浏览器，避免重连、刷新或双帧造成重复启动。
  rememberProcessed(ev.deliveryId);
  const uri = 'classcaller://v1/call?payload=' + encodeURIComponent(ev.launchPayload);
  try {
    const opened = window.open(uri, 'classcaller-launch');
    if (!opened) showLaunchWarning();
  } catch {
    showLaunchWarning();
  }
}

/* ================= 「收到」确认 ================= */
let ackBusy = false;
let ackNoteTimer = null;

function ackedNames(ev) {
  const set = new Set();
  for (const ack of Array.isArray(ev && ev.acks) ? ev.acks : []) {
    if (ack && typeof ack.name === 'string') set.add(ack.name);
  }
  return set;
}

function setAckNote(text, bad) {
  const note = $('ackNote');
  note.textContent = text || '';
  note.classList.toggle('bad', Boolean(bad));
  clearTimeout(ackNoteTimer);
  if (text) ackNoteTimer = setTimeout(() => { note.textContent = ''; }, 4000);
}

function renderAck(ev) {
  const button = $('ack');
  const acked = ackedNames(ev);
  const total = (ev.names || []).length;
  const done = total > 0 && (ev.names || []).every((name) => acked.has(name));
  button.classList.toggle('done', done);
  button.classList.toggle('busy', ackBusy && !done);
  button.disabled = done || ackBusy;
  button.querySelector('span').textContent = done
    ? '已收到'
    : (ackBusy ? '发送中' : (acked.size ? '其余同学收到' : '收到'));
  button.setAttribute('aria-label', done ? '已确认收到' : '确认收到');
}

async function sendAck(ev, names) {
  if (!ev || ev.type !== 'call' || ackBusy) return;
  if (previewMode) {
    const wanted = names && names.length ? names : ev.names;
    ev.acks = [...(ev.acks || []), ...wanted.map((name) => ({ name, at: Date.now() }))];
    render(ev, false);
    return;
  }
  ackBusy = true;
  renderAck(ev);
  try {
    const response = await fetch(classPath('public/ack'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(names && names.length ? { eventId: ev.id, names } : { eventId: ev.id }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json || !json.ok) {
      setAckNote((json && json.message) || '发送失败，请再点一次', true);
      return;
    }
    // SSE 会推最新状态；这里先就地更新，避免网络抖动时按钮迟迟不变
    if (json.event && json.event.id === ev.id && json.event.classId === classId) {
      ev.acks = json.event.acks;
      render(ev, false);
    }
    setAckNote(json.allAcked ? '已通知' + (ev.caller || '老师') : '已记录', false);
  } catch {
    setAckNote('连不上服务器，请再点一次', true);
  } finally {
    ackBusy = false;
    renderAck(currentEvent && currentEvent.id === ev.id ? currentEvent : ev);
  }
}

$('ack').onclick = (event) => {
  event.stopPropagation();
  if (currentEvent) sendAck(currentEvent, []);
};
$('names').onclick = (event) => {
  const figure = event.target.closest('figure');
  if (!figure || !currentEvent) return;
  event.stopPropagation();
  if (!figure.classList.contains('acked')) sendAck(currentEvent, [figure.dataset.name]);
};

/* ================= 渲染 ================= */
let currentEvent = null;
let shownEventId = 0;          // 正在显示的事件（点人或留言）的 id，本地到期定时器据此判断是否还是同一条
const LAST_EVENT_KEY = 'cc.display.lastEventId.' + classId;
let lastEventId = Number(sessionStorage.getItem(LAST_EVENT_KEY)) || 0;
let expiryLocal = null;
let totalMs = 0;
let expiryTimer = null;

function cancelLocalExpiry() {
  clearTimeout(expiryTimer);
  expiryTimer = null;
}

/**
 * SSE 断线时服务端的 clear 帧可能无法送达，因此浏览器也必须按服务端时间本地清屏。
 * 定时器绑定事件 id，防止旧通知的定时器误清掉后来收到的新通知。
 */
function scheduleLocalExpiry(ev) {
  cancelLocalExpiry();
  if (!expiryLocal) return;

  const eventId = ev.id;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    if (shownEventId !== eventId) return;
    render({ type: 'clear' }, false);
  }, Math.max(0, expiryLocal - Date.now()));
}

function paintProgress() {
  const wrap = $('progress');
  const bar = wrap.firstElementChild;
  wrap.classList.toggle('on', Boolean(expiryLocal));
  if (!expiryLocal) return;

  const remain = Math.max(0, expiryLocal - Date.now());
  bar.style.transition = 'none';
  bar.style.transform = 'scaleX(' + (totalMs ? remain / totalMs : 0) + ')';
  void bar.offsetWidth;
  bar.style.transition = 'transform ' + remain + 'ms linear';
  bar.style.transform = 'scaleX(0)';
}

function renderQueueHint(ev) {
  const n = ev && Number.isFinite(ev.queued) ? ev.queued : 0;
  $('queueHint').textContent = n > 0 ? '还有 ' + n + ' 条内容等待显示' : '';
}

function setExpiry(ev) {
  if (ev.expiresAt) {
    const skew = Date.now() - ev.serverTime;
    expiryLocal = ev.expiresAt + skew;
    totalMs = ev.expiresAt - ev.createdAt;
  } else {
    expiryLocal = null;
  }
}

/** 班级留言版式：标题 + 正文 + 发布人，没有「收到」按钮 */
function renderAnnouncement(ev, isNew) {
  currentNames = [];
  document.body.classList.remove('active');
  document.body.classList.add('notice');
  document.body.classList.toggle('urgent', ev.priority === 1);
  $('notice').classList.toggle('restore', !isNew);
  $('noticeKind').textContent = ev.priority === 1 ? '紧急通知' : '班级留言';
  $('noticeTitle').textContent = ev.title || '';
  $('noticeBody').textContent = ev.body || '';
  $('noticeAuthor').textContent = ev.author || ev.caller || '';
  $('foot').classList.remove('has-msg');
  setExpiry(ev);
  scheduleLocalExpiry(ev);
  paintProgress();
  if (isNew) chime();
}

function render(ev, isNew) {
  // 「当前事件」只对点人有意义：留言没有「收到」流程
  currentEvent = ev.type === 'call' ? ev : null;
  shownEventId = ev.type === 'clear' ? 0 : (ev.id || 0);
  renderQueueHint(ev);
  if (ev.type === 'announcement') {
    if (!ev.title && !ev.body) return render({ type: 'clear' }, false);
    return renderAnnouncement(ev, isNew);
  }
  if (ev.type !== 'call') {
    cancelLocalExpiry();
    document.body.classList.remove('active', 'notice', 'urgent');
    currentNames = [];
    expiryLocal = null;
    $('progress').classList.remove('on');
    return;
  }
  document.body.classList.remove('notice', 'urgent');

  currentNames = ev.names || [];
  const box = $('names');
  const acked = ackedNames(ev);
  const sameNames = !isNew && box.children.length === currentNames.length
    && [...box.children].every((figure, index) => figure.dataset.name === currentNames[index]);

  if (sameNames) {
    // 只是确认状态变了：就地更新，不重放入场动画
    [...box.children].forEach((figure) => {
      const name = figure.dataset.name;
      figure.classList.toggle('acked', acked.has(name));
      figure.title = acked.has(name) ? name + ' 已收到' : '点一下：' + name + ' 收到';
    });
  } else {
    box.innerHTML = '';
    box.classList.toggle('restore', !isNew);
    currentNames.forEach((name, index) => {
      const figure = document.createElement('figure');
      const label = document.createElement('b');
      label.textContent = name;
      figure.appendChild(label);
      figure.dataset.name = name;
      figure.classList.toggle('acked', acked.has(name));
      figure.title = acked.has(name) ? name + ' 已收到' : '点一下：' + name + ' 收到';
      const delay = (index * 0.07) + 's';
      label.style.animationDelay = delay;
      figure.style.animationDelay = delay;
      box.appendChild(figure);
    });
  }
  renderAck(ev);

  $('label').style.display = currentNames.length ? '' : 'none';
  $('label').textContent = (ev.caller || '老师') + '正在找';
  $('message').firstElementChild.textContent = ev.message || '';
  $('foot').classList.toggle('has-msg', Boolean(ev.message));
  document.body.classList.add('active');

  setExpiry(ev);
  scheduleLocalExpiry(ev);
  layout();
  paintProgress();
  if (isNew) chime();
}

function onEvent(ev) {
  if (!ev || typeof ev.id !== 'number') return;
  // 串班消息（即使服务端异常发来）一律拒绝显示；预览模式没有服务端，放行
  if (!previewMode && ev.classId !== classId) return;
  const isNew = ev.id > lastEventId;
  lastEventId = Math.max(lastEventId, ev.id);
  try { sessionStorage.setItem(LAST_EVENT_KEY, String(lastEventId)); } catch {}
  render(ev, isNew);
  maybeLaunch(ev);
}

/* ================= SSE ================= */
let lastConnectedAt = null;

function setConn(ok, text) {
  const box = $('conn');
  box.classList.toggle('ok', ok);
  box.querySelector('em').textContent = text;
  $('reconnect').classList.toggle('show', !ok);
}

function connect() {
  const es = new EventSource(classPath('public/stream?role=display'));

  es.onopen = () => {
    lastConnectedAt = new Date();
    setConn(true, '已连接');
  };

  es.onmessage = (event) => {
    try { onEvent(JSON.parse(event.data)); } catch {}
  };

  es.addEventListener('bye', (event) => {
    let reason = '';
    try { reason = JSON.parse(event.data).reason || ''; } catch {}
    if (reason === 'class_removed') {
      es.close();
      showBindError('班级绑定错误', '服务器上已没有班级「' + classId + '」，请检查大屏链接的 class 参数。');
      return;
    }
    setConn(false, '服务重启中');
  });

  es.onerror = () => {
    const since = lastConnectedAt
      ? '断线（' + lastConnectedAt.toTimeString().slice(0, 5) + ' 最后连接）'
      : '无法连接服务器';
    setConn(false, since);
  };
}

/* ================= 初始化 ================= */
let configRetryTimer = null;
let configAttempts = 0;

function retryConfig(detail) {
  configAttempts += 1;
  const delay = Math.min(30_000, 2_000 * (2 ** Math.min(configAttempts - 1, 4)));
  showBindError('暂时无法连接大屏服务', detail + '；将在 ' + Math.ceil(delay / 1000) + ' 秒后自动重试。', true);
  clearTimeout(configRetryTimer);
  configRetryTimer = setTimeout(loadRemoteConfig, delay);
}

async function loadRemoteConfig() {
  let response = null;
  let config = null;
  try {
    response = await fetch(classPath('public/config'), { cache: 'no-store' });
    config = await response.json().catch(() => null);
  } catch {}

  if (!response) return retryConfig('无法连接服务器，请检查网络');
  if (response.status === 404 && config && config.error === 'CLASS_NOT_FOUND') {
    setConn(false, '班级不存在');
    showBindError('班级绑定错误', '服务器上没有班级「' + classId + '」，请检查大屏链接的 class 参数。');
    return;
  }
  if (!config || !response.ok || !config.ok) {
    let detail = '服务器返回 HTTP ' + response.status + '，且不是大屏接口响应';
    if (response.headers.get('cf-mitigated') === 'challenge') {
      detail = '请求被 Cloudflare 人机验证拦截，请让管理员对 /api/* 关闭 Managed Challenge';
    } else if (response.headers.has('www-authenticate')) {
      detail = '服务器仍启用了 HTTP Basic Auth，请更新 Nginx 配置并关闭 auth_basic';
    }
    setConn(false, '连接受阻');
    return retryConfig(detail);
  }
  if (config.classId !== classId) {
    setConn(false, '班级不匹配');
    showBindError('班级绑定错误', '服务器返回了其它班级的数据，已拒绝连接。');
    return;
  }

  clearTimeout(configRetryTimer);
  configAttempts = 0;
  document.body.classList.remove('bind-error');
  klass = { classId: config.classId, className: config.className, code: config.code, color: config.color };
  applyClassIdentity();
  launcherMode = config.launcher && config.launcher.mode || 'off';
  connect();
}

(function init() {
  syncSoundUi();

  if (QUERY.has('preview')) {
    previewMode = true;
    klass = { classId: 'preview', className: '预览班级', code: '00', color: '' };
    applyClassIdentity();
    setConn(true, '预览模式');
    const names = QUERY.get('preview').split(',').map((name) => name.trim()).filter(Boolean);
    if (names.length) {
      onEvent({
        type: 'call', id: 1, names, message: QUERY.get('msg') || '', caller: QUERY.get('caller') || '老师',
        createdAt: Date.now(), expiresAt: null, serverTime: Date.now(), acks: [],
      });
    }
    return;
  }

  if (!classId) {
    setConn(false, '未绑定');
    showBindError('此设备尚未绑定班级', '请在大屏链接后加上班级参数，例如 display.html?class=class-a。不会默认进入任何班级。');
    return;
  }
  if (!CLASS_ID_RE.test(classId)) {
    setConn(false, '未绑定');
    showBindError('班级绑定错误', '班级参数格式不正确：' + classId);
    return;
  }

  loadRemoteConfig();
})();

/* ================= 交互：点画面解锁声音 + 全屏；动鼠标露出控件 ================= */
document.body.addEventListener('click', () => {
  unlockAudio();
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen();
  }
});

let toolsTimer;
document.addEventListener('mousemove', () => {
  document.body.classList.add('show-cursor');
  $('tools').classList.add('show');
  clearTimeout(toolsTimer);
  toolsTimer = setTimeout(() => {
    document.body.classList.remove('show-cursor');
    $('tools').classList.remove('show');
  }, 2600);
});
