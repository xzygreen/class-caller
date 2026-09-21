'use strict';

const $ = (id) => document.getElementById(id);

/* ================= 页面状态 =================
 * 登录身份属于个人（HttpOnly Cookie，脚本拿不到令牌）；班级权限由管理员授权。
 * URL ?class=<id> 只表示当前打开的班级，权限每次都由服务端重新校验。 */
let me = null;
let classId = '';
let klass = null;               // { classId, className, code, color }
let students = [];
let maxNamesPerCall = 20;
let callWindow = null;
let settings = { announcementPolicy: 'immediate' };
const sel = new Set();
let display = { current: null, queue: [] };
let sending = false;
let liveStream = null;
let cdTimer = null;
let currentTab = 'call';
let schedules = [];
let noticesCache = [];

const CLASS_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const PAUSE_REASONS = {
  CALL_WINDOW_CHANGED: '全校作息已修改，该时间不再允许点人',
  ACCESS_REVOKED: '你对该班级的权限已被撤销',
  USER_DISABLED: '创建教师的账号已停用',
  STUDENT_REMOVED: '有学生已不在本班名单',
  CLASS_UNAVAILABLE: '班级已归档',
};

/* ================= 工具 ================= */
function toast(text, bad) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('bad', Boolean(bad));
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2800);
}
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const dateTime = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(ms)}`; };
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    return { status: 0, ok: false, json: null };
  }
  const json = await res.json().catch(() => null);
  const challenged = res.headers.get('cf-mitigated') === 'challenge';
  const basic = res.headers.has('www-authenticate');
  let gatewayError = '';
  if (!json && challenged) gatewayError = '请求被 Cloudflare 人机验证拦截。请让管理员对 /api/* 关闭 Managed Challenge 后重试';
  else if (!json && basic) gatewayError = '服务器仍启用了 HTTP Basic Auth。请更新 Nginx 配置并关闭 auth_basic';
  else if (!json && !res.ok) gatewayError = '服务器网关返回了非应用响应（HTTP ' + res.status + '），请检查 Nginx 或 Cloudflare 配置';
  if (res.status === 401 && json && ['UNAUTHORIZED', 'ACCOUNT_DISABLED'].includes(json.error)) {
    gateOut(json.error === 'ACCOUNT_DISABLED' ? '账号已停用，请联系管理员' : '登录已失效，请重新登录');
  }
  if (res.status === 403 && json && json.error === 'PASSWORD_CHANGE_REQUIRED') { showPasswordGate(); }
  return { status: res.status, ok: res.ok, json, gatewayError };
}
const cpath = (sub) => '/api/classes/' + encodeURIComponent(classId) + '/' + sub;

function errText(res, fallback) {
  if (res.status === 0) return '连不上服务器';
  if (res.gatewayError) return res.gatewayError;
  const m = (res.json && res.json.message) || fallback;
  return res.json && res.json.detail ? m + '：' + res.json.detail : m;
}

/* ================= 登录闸门 ================= */
function showGate(which, message) {
  $('app').hidden = true;
  $('gate').hidden = false;
  for (const id of ['loginForm', 'registerForm', 'passwordForm']) $(id).hidden = id !== which;
  $('loginErr').textContent = which === 'loginForm' ? (message || '') : '';
  if (which === 'loginForm') $('loginUser').focus();
  if (which === 'registerForm') $('regUser').focus();
  if (which === 'passwordForm') $('newPwd').focus();
}
function showPasswordGate() { showGate('passwordForm'); }

function gateOut(message) {
  me = null;
  disconnectLive();
  clearInterval(cdTimer);
  showGate('loginForm', message);
}

$('toRegister').onclick = () => showGate('registerForm');
$('toLogin').onclick = () => showGate('loginForm');
$('forgot').onclick = () => toast('请联系管理员重置密码：管理员会发给你一个临时密码，登录后需立即修改', false);

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const b = $('loginBtn'); b.disabled = true; b.dataset.loading = '1';
  const res = await api('POST', '/api/auth/login', { username: $('loginUser').value.trim(), password: $('loginPwd').value });
  b.disabled = false; delete b.dataset.loading;
  if (!res.ok) { $('loginErr').textContent = errText(res, '登录失败'); $('loginPwd').select(); return; }
  $('loginPwd').value = '';
  await enter(res.json.user);
};

$('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  const b = $('regBtn'); b.disabled = true; b.dataset.loading = '1';
  const res = await api('POST', '/api/auth/register', {
    username: $('regUser').value.trim(), displayName: $('regName').value.trim(), title: $('regTitle').value.trim(), password: $('regPwd').value,
  });
  b.disabled = false; delete b.dataset.loading;
  if (!res.ok) { $('regErr').textContent = errText(res, '注册失败'); return; }
  $('regPwd').value = '';
  toast('注册成功。请申请管理班级，管理员批准后即可点人');
  await enter(res.json.user);
};

$('passwordForm').onsubmit = async (e) => {
  e.preventDefault();
  if ($('newPwd').value !== $('newPwd2').value) { $('pwdErr').textContent = '两次输入不一致'; return; }
  const res = await api('POST', '/api/me/password', { newPassword: $('newPwd').value });
  if (!res.ok) { $('pwdErr').textContent = errText(res, '修改失败'); return; }
  $('newPwd').value = ''; $('newPwd2').value = '';
  toast('密码已更新');
  await enter(res.json.user);
};
$('pwdLogout').onclick = () => $('logout').onclick();

$('logout').onclick = async () => {
  await api('POST', '/api/auth/logout', {});
  history.replaceState(null, '', location.pathname);
  classId = ''; klass = null;
  gateOut('');
};

/* ================= 进入 ================= */
async function enter(user) {
  me = user;
  if (me.mustChangePassword) return showPasswordGate();
  $('gate').hidden = true;
  $('app').hidden = false;
  $('whoami').textContent = (me.title ? me.title + ' · ' : '') + me.displayName + (me.role === 'admin' ? '（管理员）' : '');
  const wanted = new URLSearchParams(location.search).get('class') || '';
  if (CLASS_ID_RE.test(wanted)) {
    if (await openClass(wanted)) return;
  }
  await showHome();
}

/* ================= 个人工作台 ================= */
async function showHome() {
  classId = ''; klass = null;
  disconnectLive();
  document.documentElement.dataset.classColor = '';
  history.replaceState(null, '', location.pathname);
  $('home').hidden = false;
  $('klassView').hidden = true;
  $('tabs').hidden = true;
  $('tray').hidden = true;
  $('backHome').hidden = true;
  $('classBadge').hidden = true;
  $('livePill').hidden = true;
  $('title').childNodes[0].nodeValue = '老师找人';
  $('subtitle').textContent = '个人工作台';
  document.title = '老师找人 · 教师端';
  await loadHome();
}

async function loadHome() {
  const res = await api('GET', '/api/me/classes');
  if (!res.ok) return;
  const d = res.json;
  callWindow = d.callWindow;
  renderWindowPill();
  $('homeWindow').innerHTML = '';
  $('homeWindow').append(windowSummary());

  const box = $('myClasses');
  box.innerHTML = '';
  if (!d.classes.length) {
    box.append(el('span', 'ph', me.role === 'admin' ? '还没有任何班级；请在管理端新增班级' : '还没有获批的班级。请在下方提交申请，等待管理员审批。'));
  }
  for (const c of d.classes) {
    const item = el('div', 'item');
    item.dataset.status = 'active';
    const copy = el('div');
    copy.append(el('strong', '', `${c.name}（${c.code}）`));
    copy.append(el('small', '', `${c.studentCount} 名学生 · 大屏 ${c.autoClearSeconds ? c.autoClearSeconds + ' 秒后自动清除' : '常驻显示'}`));
    const acts = el('div', 'acts');
    const open = el('button', 'btn btn-go btn-sm', '进入班级');
    open.onclick = () => openClass(c.id);
    acts.append(open);
    item.append(copy, acts);
    box.append(item);
  }

  const select = $('requestClass');
  const mine = new Set(d.classes.map((c) => c.id));
  const pending = new Set(d.requests.filter((r) => r.status === 'pending').map((r) => r.classId));
  select.innerHTML = '<option value="">选择班级</option>';
  for (const c of d.availableClasses) {
    if (mine.has(c.id) || pending.has(c.id)) continue;
    const o = el('option', '', `${c.name}（${c.code}）`); o.value = c.id; select.append(o);
  }
  const rq = $('myRequests');
  rq.innerHTML = '';
  for (const r of d.requests) {
    const item = el('div', 'item');
    item.dataset.status = r.status;
    const copy = el('div');
    const st = { pending: '待审批', approved: '已批准', rejected: '已拒绝', cancelled: '已撤回' }[r.status] || r.status;
    copy.append(el('strong', '', `${r.className} · ${st}`));
    const parts = [dateTime(r.createdAt)];
    if (r.reason) parts.push(r.reason);
    if (r.status === 'rejected' && r.note) parts.push('理由：' + r.note);
    copy.append(el('small', '', parts.join(' · ')));
    const acts = el('div', 'acts');
    if (r.status === 'pending') {
      const cancel = el('button', 'link danger', '撤回');
      cancel.onclick = async () => { const x = await api('DELETE', '/api/me/class-requests/' + r.id); if (x.ok) { toast('已撤回申请'); loadHome(); } else toast(errText(x, '撤回失败'), true); };
      acts.append(cancel);
    }
    item.append(copy, acts);
    rq.append(item);
  }

  const hs = $('homeSchedules');
  hs.innerHTML = '';
  if (!d.upcomingSchedules.length && !d.pausedSchedules.length) hs.append(el('span', 'ph', '暂无'));
  for (const s of d.pausedSchedules) {
    const item = el('div', 'item'); item.dataset.status = 'paused';
    const copy = el('div');
    copy.append(el('strong', '', `${s.time} ${s.names.join('、')}`));
    copy.append(el('small', '', '已暂停：' + (PAUSE_REASONS[s.pauseReason] || s.pauseReason || '')));
    item.append(copy); hs.append(item);
  }
  for (const s of d.upcomingSchedules) {
    const item = el('div', 'item'); item.dataset.status = 'active';
    const copy = el('div');
    copy.append(el('strong', '', `${s.time} ${s.names.join('、')}`));
    copy.append(el('small', '', `下次 ${dateTime(s.nextRunAt)}${s.message ? ' · ' + s.message : ''}`));
    item.append(copy); hs.append(item);
  }
  $('homeAccount').textContent = `${me.displayName}（${me.username}）${me.title ? ' · ' + me.title : ''}`;
}

$('requestForm').onsubmit = async (e) => {
  e.preventDefault();
  const cid = $('requestClass').value;
  if (!cid) return toast('请先选择班级', true);
  const res = await api('POST', '/api/me/class-requests', { classId: cid, reason: $('requestReason').value.trim() });
  if (!res.ok) return toast(errText(res, '提交失败'), true);
  $('requestReason').value = '';
  toast('申请已提交，等待管理员审批');
  loadHome();
};

$('changePwd').onclick = () => { $('pwdChangeErr').textContent = ''; $('pwdDialog').showModal(); };
$('pwdCancel').onclick = () => $('pwdDialog').close();
$('pwdChangeForm').onsubmit = async (e) => {
  e.preventDefault();
  const res = await api('POST', '/api/me/password', { currentPassword: $('curPwd').value, newPassword: $('nxtPwd').value });
  if (!res.ok) { $('pwdChangeErr').textContent = errText(res, '修改失败'); return; }
  $('curPwd').value = ''; $('nxtPwd').value = '';
  $('pwdDialog').close();
  toast('密码已更新，其它设备需要重新登录');
};
$('backHome').onclick = showHome;

/* ================= 作息提示 ================= */
function windowSummary() {
  const box = el('div');
  if (!callWindow) return box;
  if (callWindow.open) {
    box.append(el('div', 'note ok', `现在可以点人：${callWindow.current.start}–${callWindow.current.end}${callWindow.current.label ? '（' + callWindow.current.label + '）' : ''}`));
  } else {
    const n = callWindow.next;
    box.append(el('div', 'note warn', '当前正在上课，暂不能点人' + (n ? `。下次可用时间：${n.date === callWindow.now.date ? '' : n.weekdayName + ' '}${n.start}–${n.end}` : '')));
  }
  return box;
}

function renderWindowPill() {
  const pill = $('windowPill');
  if (!callWindow) return;
  pill.className = 'pill ' + (callWindow.open ? 'on' : 'warn');
  $('windowText').textContent = callWindow.open
    ? `可点人至 ${callWindow.current.end}`
    : (callWindow.next ? `上课中 · 下次 ${callWindow.next.date === callWindow.now.date ? '' : callWindow.next.weekdayName + ' '}${callWindow.next.start}` : '上课中');
  const notice = $('windowNotice');
  if (callWindow.open) { notice.hidden = true; } else {
    notice.hidden = false;
    notice.textContent = '当前正在上课，暂不能点人' + (callWindow.next ? `。下次可用时间：${callWindow.next.start}–${callWindow.next.end}` : '');
  }
  renderPicked();
}

/* ================= 班级工作台 ================= */
async function openClass(id) {
  classId = id;
  const res = await api('GET', cpath('workspace'));
  if (!res.ok) {
    classId = '';
    if (res.status === 403 || res.status === 404) toast(errText(res, '无法进入该班级'), true);
    return false;
  }
  const d = res.json;
  if (d.classId !== id) return false;
  klass = { classId: d.classId, className: d.className, code: d.code, color: d.color };
  students = d.students || [];
  maxNamesPerCall = d.maxNamesPerCall || 20;
  callWindow = d.callWindow;
  settings = d.settings || settings;
  display = d.display;
  sel.clear();
  $('msg').value = ''; $('search').value = '';

  const url = new URL(location.href); url.searchParams.set('class', id); history.replaceState(null, '', url);
  document.documentElement.dataset.classColor = klass.color;
  $('home').hidden = true;
  $('klassView').hidden = false;
  $('tabs').hidden = false;
  $('backHome').hidden = false;
  $('classBadge').hidden = false;
  $('classBadge').textContent = '当前班级：' + klass.className + ' ' + klass.code;
  $('livePill').hidden = false;
  $('title').childNodes[0].nodeValue = klass.className + '　老师找人';
  $('subtitle').textContent = '共 ' + students.length + ' 名同学' + (d.autoClearSeconds ? ' · 大屏 ' + d.autoClearSeconds + ' 秒后自动清除' : '');
  document.title = klass.className + ' · 老师找人';
  $('nowTitle').textContent = klass.className + '大屏正在显示';
  $('callerLabel').textContent = '发起人：' + callerLabel();
  $('annUrgentField').hidden = me.role !== 'admin';
  $('annPolicyNote').textContent = settings.announcementPolicy === 'next_window' && me.role !== 'admin'
    ? '学校设置：上课期间发布的留言会等到下一个课间再显示。' : '';
  renderWindowPill();
  renderGrid(); renderPicked(); renderNow(); renderLive(d);
  connectLive();
  switchTab(currentTab);
  return true;
}

function callerLabel() {
  if (!me) return '老师';
  const name = me.displayName.length <= 2 ? me.displayName + '老师' : me.displayName;
  return me.title ? me.title + ' · ' + name : name;
}

/* ---------- 标签页 ---------- */
function switchTab(tab) {
  currentTab = tab;
  for (const b of $('tabs').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const t of ['call', 'announce', 'schedule', 'activity']) $('tab-' + t).hidden = t !== tab;
  $('tray').hidden = tab !== 'call';
  if (tab === 'announce') { renderPreview(); loadAnnouncements(); }
  if (tab === 'schedule') { renderSchPicked(); loadSchedules(); }
  if (tab === 'activity') { loadActivity(); }
}
$('tabs').onclick = (e) => { const b = e.target.closest('button[data-tab]'); if (b) switchTab(b.dataset.tab); };

/* ---------- 名字网格 ---------- */
function renderGrid() {
  const q = $('search').value.trim();
  const grid = $('grid');
  grid.innerHTML = '';
  const list = students.filter((name) => !q || name.includes(q));
  for (const name of list) {
    const selected = sel.has(name);
    const b = el('button', 's', name);
    b.type = 'button';
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    b.disabled = !selected && sel.size >= maxNamesPerCall;
    b.onclick = () => {
      if (sel.has(name)) sel.delete(name);
      else if (sel.size < maxNamesPerCall) sel.add(name);
      else return toast('一次最多选择 ' + maxNamesPerCall + ' 人', true);
      renderGrid(); renderPicked();
    };
    grid.append(b);
  }
  const t = '已选择 ' + sel.size + ' / ' + maxNamesPerCall;
  $('hint').textContent = q ? '匹配 ' + list.length + ' 人 · ' + t : t;
}

function chips(box, placeholder) {
  box.innerHTML = '';
  if (!sel.size) { box.append(el('span', 'ph', placeholder)); return; }
  for (const name of sel) {
    const chip = el('span', 'chip', name);
    const rm = el('button', '', '×');
    rm.type = 'button'; rm.setAttribute('aria-label', '取消 ' + name);
    rm.onclick = () => { sel.delete(name); renderGrid(); renderPicked(); renderSchPicked(); };
    chip.append(rm); box.append(chip);
  }
}

function renderPicked() {
  chips($('picked'), '请从名单中选择同学');
  const open = callWindow ? callWindow.open : true;
  $('send').disabled = sel.size === 0 || sending || !open;
  $('reset').disabled = sel.size === 0;
  const target = klass ? klass.className + '大屏' : '大屏';
  $('send').textContent = !open ? '上课中，暂不能点人' : (sel.size ? '通知 ' + sel.size + ' 人到' + target : '通知到' + target);
}
function renderSchPicked() { chips($('schPicked'), '请先在「点人」页选择学生，再回到这里'); }

/* ---------- 大屏状态 ---------- */
function ownEvent(ev) {
  if (!ev || typeof ev.id !== 'number' || ev.classId !== classId) return null;
  return ev.type === 'clear' ? null : ev;
}

function renderNow() {
  const ev = ownEvent(display.current);
  const namesBox = $('nowNames');
  const summary = $('ackSummary');
  const body = $('nowBody');
  clearInterval(cdTimer);
  summary.textContent = ''; summary.classList.remove('all');
  body.textContent = '';
  if (!ev) {
    $('nowTitle').textContent = (klass ? klass.className : '') + '大屏正在显示';
    namesBox.className = 'now-names idle';
    namesBox.textContent = '当前为空';
    $('countdown').classList.remove('on');
  } else if (ev.type === 'call') {
    $('nowTitle').textContent = (ev.caller || '老师') + '正在找';
    namesBox.className = 'now-names';
    namesBox.innerHTML = '';
    const acked = new Map((ev.acks || []).map((a) => [a.name, a.at]));
    for (const name of ev.names) {
      const chip = el('span', 'ack');
      chip.dataset.acked = acked.has(name) ? '1' : '0';
      chip.append(el('i'), name, el('small', '', acked.has(name) ? '已收到 ' + hhmm(acked.get(name)) : '未收到'));
      namesBox.append(chip);
    }
    const n = ev.names.filter((x) => acked.has(x)).length;
    summary.textContent = n === ev.names.length ? '全部 ' + n + ' 人已确认收到' : '已收到 ' + n + ' / ' + ev.names.length + ' 人';
    body.textContent = ev.message || '';
  } else {
    $('nowTitle').textContent = (ev.priority === 1 ? '紧急通知' : '班级留言') + ' · ' + (ev.author || '');
    namesBox.className = 'now-names';
    namesBox.textContent = ev.title || '';
    body.textContent = ev.body || '';
  }
  if (ev) paintCountdown(ev);
  renderQueue();
}

function paintCountdown(ev) {
  const cd = $('countdown');
  if (!ev.expiresAt) { cd.classList.add('on'); $('cdText').textContent = '常驻'; cd.querySelector('.bar i').style.transform = 'scaleX(1)'; return; }
  const total = ev.expiresAt - ev.createdAt;
  const skew = Date.now() - ev.serverTime;
  const expiry = ev.expiresAt + skew;
  const paint = () => {
    const remain = expiry - Date.now();
    if (remain <= 0) { clearInterval(cdTimer); cd.classList.remove('on'); return; }
    cd.classList.add('on');
    $('cdText').textContent = remain > 120_000 ? '剩余 ' + Math.ceil(remain / 60000) + ' 分钟' : '剩余 ' + Math.ceil(remain / 1000) + ' 秒';
    cd.querySelector('.bar i').style.transform = 'scaleX(' + Math.max(0, remain / total) + ')';
  };
  paint();
  cdTimer = setInterval(paint, 250);
}

function renderQueue() {
  const box = $('queue');
  const q = display.queue || [];
  $('queueCount').textContent = q.length ? q.length + ' 条' : '';
  box.innerHTML = '';
  if (!q.length) { box.append(el('span', 'ph', '没有等待中的内容')); return; }
  q.forEach((item, i) => {
    const row = el('div', 'item');
    const copy = el('div');
    const label = item.type === 'call' ? (item.names || []).join('、') : (item.title || '留言');
    copy.append(el('strong', '', (i + 1) + '. ' + label));
    copy.append(el('small', '', (item.type === 'call' ? '点人' : '留言') + (item.author ? ' · ' + item.author : '') + ' · ' + ({ 1: '紧急', 2: '定时提醒', 3: '手动', 4: '普通' }[item.priority] || '')));
    const acts = el('div', 'acts');
    const wd = el('button', 'link danger', '撤回');
    wd.onclick = () => withdraw(item.noticeId);
    acts.append(wd);
    row.append(copy, acts);
    box.append(row);
  });
}

function renderLive(d) {
  const pill = $('livePill');
  const displays = d.displays || 0;
  pill.className = 'pill ' + (displays ? 'on' : 'off');
  $('liveText').textContent = displays ? '大屏在线 ' + displays : '大屏未连接';
}

/* ---------- 实时 ---------- */
function disconnectLive() { if (liveStream) { liveStream.close(); liveStream = null; } }
function connectLive() {
  disconnectLive();
  if (!window.EventSource || !classId) return;
  liveStream = new EventSource(cpath('stream'), { withCredentials: true });
  liveStream.onmessage = (event) => {
    let ev = null;
    try { ev = JSON.parse(event.data); } catch { return; }
    if (!ev || ev.classId !== classId) return;
    display.current = ev;
    // 队列摘要靠轮询补全；这里先更新计数
    if (typeof ev.queued === 'number' && ev.queued !== (display.queue || []).length) pollStatus();
    renderNow();
  };
}

async function pollStatus() {
  if ($('app').hidden || !classId) return;
  const res = await api('GET', cpath('status'));
  if (!res.ok || res.json.classId !== classId) return;
  display = res.json.display;
  callWindow = res.json.callWindow;
  renderWindowPill();
  renderNow();
  renderLive(res.json);
}
setInterval(pollStatus, 5000);

/* ---------- 点人 ---------- */
function setSending(v) {
  sending = v;
  const b = $('send');
  if (v) b.dataset.loading = '1'; else delete b.dataset.loading;
  renderPicked();
}

$('send').onclick = async () => {
  const names = [...sel];
  if (!names.length || sending) return;
  setSending(true);
  try {
    const res = await api('POST', cpath('calls'), { names, message: $('msg').value.trim() });
    if (!res.ok) {
      if (res.json && res.json.error === 'CALL_WINDOW_CLOSED') { callWindow = res.json.callWindow || callWindow; renderWindowPill(); }
      return toast(errText(res, '发送失败'), true);
    }
    display = res.json.display;
    renderNow(); renderLive(res.json);
    toast(res.json.displayedNow ? '已通知到' + klass.className + '大屏' + (res.json.displays ? '' : '（大屏未连接）') : '已加入等待队列，将在当前内容结束后显示', !res.json.displays);
    sel.clear(); $('msg').value = ''; $('search').value = '';
    renderGrid(); renderPicked();
  } finally { setSending(false); }
};

$('clear').onclick = () => clearDisplay(false);
$('clearAll').onclick = () => clearDisplay(true);
async function clearDisplay(all) {
  const res = await api('POST', cpath('display/clear'), { all });
  if (!res.ok) return toast(errText(res, '清空失败'), true);
  display = res.json.display; renderNow();
  toast(all ? '大屏与等待队列已清空' : '当前内容已清除');
}
async function withdraw(noticeId) {
  const res = await api('POST', cpath('notices/' + noticeId + '/withdraw'), {});
  if (!res.ok) return toast(errText(res, '撤回失败'), true);
  display = res.json.display; renderNow();
  toast('已撤回');
}
async function resend(noticeId) {
  const res = await api('POST', cpath('notices/' + noticeId + '/resend'), {});
  if (!res.ok) return toast(errText(res, '再次发送失败'), true);
  display = res.json.display; renderNow();
  toast(res.json.alreadyQueued ? '这条内容已在大屏或队列中' : '已再次发送');
}

$('reset').onclick = () => { sel.clear(); renderGrid(); renderPicked(); };
$('search').oninput = renderGrid;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentTab === 'call') { $('search').value = ''; renderGrid(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && currentTab === 'call' && !$('app').hidden) $('send').click();
});

/* ---------- 留言 ---------- */
function renderPreview() {
  $('pvTitle').textContent = $('annTitle').value.trim() || '班级通知';
  $('pvBody').textContent = $('annBody').value.trim() || '正文内容';
  $('pvAuthor').textContent = '—— ' + callerLabel();
}
$('annTitle').oninput = renderPreview;
$('annBody').oninput = renderPreview;
$('annWhen').onchange = () => { $('annAtField').hidden = $('annWhen').value !== 'later'; };
$('announceForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    title: $('annTitle').value.trim(), body: $('annBody').value.trim(),
    durationSeconds: Number($('annDuration').value),
    urgent: me.role === 'admin' && $('annUrgent').checked,
  };
  if ($('annWhen').value === 'later') {
    const at = $('annAt').value;
    if (!at) return toast('请选择显示时间', true);
    body.publishAt = new Date(at).getTime();
  }
  const b = $('annSend'); b.disabled = true; b.dataset.loading = '1';
  const res = await api('POST', cpath('announcements'), body);
  b.disabled = false; delete b.dataset.loading;
  if (!res.ok) return toast(errText(res, '发布失败'), true);
  display = res.json.display; renderNow();
  const n = res.json.notice;
  toast(n.status === 'scheduled' ? '已安排在 ' + dateTime(n.publishAt) + ' 显示' : (res.json.displayedNow ? '留言已显示到大屏' : '留言已加入等待队列'));
  $('annTitle').value = ''; $('annBody').value = ''; renderPreview();
  loadAnnouncements();
};

async function loadAnnouncements() {
  const res = await api('GET', cpath('notices?type=announcement'));
  if (!res.ok || res.json.classId !== classId) return;
  const box = $('annList');
  box.innerHTML = '';
  if (!res.json.notices.length) box.append(el('span', 'ph', '暂无'));
  for (const n of res.json.notices.slice(0, 20)) box.append(noticeRow(n));
}

function noticeRow(n) {
  const row = el('div', 'item');
  const copy = el('div');
  const tag = el('span', 'tag ' + (n.priority === 1 ? 'urgent' : n.type), n.priority === 1 ? '紧急' : (n.type === 'call' ? (n.source === 'schedule' ? '定时' : '点人') : '留言'));
  const title = el('strong');
  title.append(tag, n.type === 'call' ? n.names.join('、') : n.title);
  copy.append(title);
  const st = { scheduled: '待显示 ' + dateTime(n.publishAt), published: '', withdrawn: '已撤回' }[n.status] || '';
  const meta = [dateTime(n.createdAt), n.caller || n.author || n.authorName];
  if (n.type === 'call' && n.message) meta.push(n.message);
  if (n.type === 'announcement') meta.push(n.body.length > 40 ? n.body.slice(0, 40) + '…' : n.body);
  if (n.deliveryCount > 1) meta.push('已发送 ' + n.deliveryCount + ' 次');
  if (st) meta.push(st);
  copy.append(el('small', '', meta.join(' · ')));
  const acts = el('div', 'acts');
  if (n.status !== 'withdrawn' || n.type === 'call') {
    const re = el('button', 'link', '再次发送'); re.onclick = () => resend(n.id); acts.append(re);
  }
  if (n.status !== 'withdrawn') {
    const wd = el('button', 'link danger', '撤回'); wd.onclick = () => withdraw(n.id).then(() => { loadAnnouncements(); if (currentTab === 'activity') loadActivity(); }); acts.append(wd);
  }
  row.append(copy, acts);
  return row;
}

/* ---------- 定时提醒 ---------- */
async function loadSchedules() {
  const res = await api('GET', cpath('schedules'));
  if (!res.ok || res.json.classId !== classId) return;
  schedules = res.json.schedules;
  const w = res.json.callWindows;
  $('schWindows').textContent = w.windows.map((x) => x.start + '–' + x.end).join('、') + '（' + w.weekdays.map((d) => WEEKDAYS[d]).join('、') + '）';
  $('schWindowHint').textContent = '必须在允许点人的时段内';
  const box = $('schList');
  box.innerHTML = '';
  const paused = schedules.filter((s) => s.status === 'paused').length;
  $('scheduleBadge').textContent = paused ? String(paused) : '';
  if (!schedules.length) box.append(el('span', 'ph', '还没有定时提醒'));
  for (const s of schedules) {
    const row = el('div', 'item');
    row.dataset.status = s.status === 'paused' ? 'paused' : (s.enabled ? 'active' : '');
    const copy = el('div');
    copy.append(el('strong', '', `${s.time}　${s.names.join('、')}`));
    const meta = [s.weekdayNames.join('、'), s.message || '（无说明）', '创建：' + s.createdByName];
    if (s.startDate || s.endDate) meta.push((s.startDate || '') + ' 至 ' + (s.endDate || '不限'));
    if (!s.enabled) meta.push('已停用');
    else if (s.status === 'paused') meta.push('已暂停：' + (PAUSE_REASONS[s.pauseReason] || s.pauseReason));
    else if (s.nextRunAt) meta.push('下次 ' + dateTime(s.nextRunAt));
    if (s.lastResult) meta.push('最近：' + ({ sent: '已发送', missed: '已错过', skipped: '已跳过', failed: '失败' }[s.lastResult.status] || s.lastResult.status) + (s.lastRunDate ? ' ' + s.lastRunDate : ''));
    copy.append(el('small', '', meta.join(' · ')));
    const acts = el('div', 'acts');
    if (s.mine || me.role === 'admin') {
      const toggle = el('button', 'link', s.enabled ? (s.status === 'paused' ? '恢复' : '暂停') : '启用');
      toggle.onclick = async () => {
        const r = await api('PATCH', cpath('schedules/' + s.id), { enabled: !(s.enabled && s.status !== 'paused') });
        if (!r.ok) return toast(errText(r, '操作失败'), true);
        loadSchedules();
      };
      const edit = el('button', 'link', '改时间');
      edit.onclick = async () => {
        const t = window.prompt('新的提醒时间（HH:MM，必须在允许点人的时段内）', s.time);
        if (!t) return;
        const r = await api('PATCH', cpath('schedules/' + s.id), { time: t.trim() });
        if (!r.ok) return toast(errText(r, '修改失败'), true);
        loadSchedules();
      };
      const del = el('button', 'link danger', '删除');
      del.onclick = async () => {
        if (!window.confirm('删除这条定时提醒？')) return;
        const r = await api('DELETE', cpath('schedules/' + s.id));
        if (!r.ok) return toast(errText(r, '删除失败'), true);
        loadSchedules();
      };
      acts.append(toggle, edit, del);
    }
    row.append(copy, acts);
    box.append(row);
  }
}

$('scheduleForm').onsubmit = async (e) => {
  e.preventDefault();
  const names = [...sel];
  if (!names.length) return toast('请先在「点人」页选择学生', true);
  const weekdays = [...$('schWeekdays').querySelectorAll('input:checked')].map((i) => Number(i.value));
  const body = {
    names, time: $('schTime').value, message: $('schMessage').value.trim(), weekdays,
    startDate: $('schStart').value || null, endDate: $('schEnd').value || null,
  };
  const b = $('schCreate'); b.disabled = true; b.dataset.loading = '1';
  const res = await api('POST', cpath('schedules'), body);
  b.disabled = false; delete b.dataset.loading;
  if (!res.ok) return toast(errText(res, '创建失败'), true);
  toast('已创建定时提醒');
  $('schMessage').value = '';
  loadSchedules();
};

/* ---------- 记录 ---------- */
async function loadActivity() {
  const q = new URLSearchParams();
  if ($('actType').value) q.set('type', $('actType').value);
  if ($('actAuthor').value) q.set('author', $('actAuthor').value);
  if ($('actDate').value) q.set('date', $('actDate').value);
  const res = await api('GET', cpath('activity' + (q.toString() ? '?' + q : '')));
  if (!res.ok || res.json.classId !== classId) return;
  const box = $('activity');
  box.innerHTML = '';
  const authors = new Map();
  for (const x of res.json.activity) if (x.authorId) authors.set(x.authorId, x.authorName);
  const sel2 = $('actAuthor');
  const cur = sel2.value;
  if (!cur) {
    sel2.innerHTML = '<option value="">全部教师</option>';
    for (const [id, name] of authors) { const o = el('option', '', name); o.value = id; sel2.append(o); }
  }
  if (!res.json.activity.length) { box.append(el('span', 'ph', '没有记录')); return; }
  for (const x of res.json.activity) {
    if (x.kind === 'schedule_run') {
      const row = el('div', 'item');
      const copy = el('div');
      const t = el('strong'); t.append(el('span', 'tag schedule', '定时'), ({ missed: '已错过', skipped: '已跳过', failed: '发送失败' }[x.status] || x.status));
      copy.append(t, el('small', '', dateTime(x.at) + (x.detail ? ' · ' + (PAUSE_REASONS[x.detail] || (x.detail === 'CALL_WINDOW_CLOSED' ? '不在允许点人的时段' : x.detail)) : '')));
      row.append(copy); box.append(row);
    } else {
      box.append(noticeRow(x));
    }
  }
}
$('actType').onchange = loadActivity;
$('actAuthor').onchange = loadActivity;
$('actDate').onchange = loadActivity;
$('actReset').onclick = () => { $('actType').value = ''; $('actAuthor').value = ''; $('actDate').value = ''; loadActivity(); };

/* ================= 启动 ================= */
(async function init() {
  const res = await api('GET', '/api/me');
  if (res.ok) {
    callWindow = res.json.callWindow;
    await enter(res.json.user);
  } else if (res.status === 0) {
    showGate('loginForm', '连不上服务器');
  } else {
    showGate('loginForm', res.gatewayError || '');
  }
})();
