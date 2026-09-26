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
const sel = new Set();          // 点人页的选择
const schSel = new Set();       // 定时提醒自己的选择，不再依赖点人页
let display = { current: null, queue: [] };
let displaysOnline = 0;
let sending = false;
let liveStream = null;
let cdTimer = null;
let currentTab = 'call';
let schedules = [];
/** 我最近一次发出的点人：信号轨道据此显示它走到了哪一步 */
let lastSent = null;

const CLASS_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const PAUSE_REASONS = {
  CALL_WINDOW_CHANGED: '全校作息已修改，该时间不再允许点人',
  ACCESS_REVOKED: '你对该班级的权限已被撤销',
  USER_DISABLED: '创建教师的账号已停用',
  STUDENT_REMOVED: '有学生已不在本班名单',
  CLASS_UNAVAILABLE: '班级已归档',
};

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
  if (res.status === 0) return '连不上服务器，请检查网络后重试';
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
  $('loginInfo').hidden = true;
  if (which === 'loginForm') $('loginUser').focus();
  if (which === 'registerForm') $('regUser').focus();
  if (which === 'passwordForm') $('newPwd').focus();
}
function showPasswordGate() { showGate('passwordForm'); }

function gateOut(message) {
  me = null;
  disconnectLive();
  clearInterval(cdTimer);
  closeSheet();
  showGate('loginForm', message);
}

$('toRegister').onclick = () => showGate('registerForm');
$('toLogin').onclick = () => showGate('loginForm');
$('forgot').onclick = () => {
  const n = $('loginInfo');
  n.textContent = '请联系管理员重置密码。管理员会给你一个临时密码，用它登录后需要立即改成自己的密码。';
  n.hidden = false;
};

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!$('loginUser').value.trim() || !$('loginPwd').value) { $('loginErr').textContent = '请输入登录名和密码'; return; }
  setBusy($('loginBtn'), true);
  const res = await api('POST', '/api/auth/login', { username: $('loginUser').value.trim(), password: $('loginPwd').value });
  setBusy($('loginBtn'), false);
  if (!res.ok) { $('loginErr').textContent = errText(res, '登录失败'); $('loginPwd').select(); return; }
  $('loginPwd').value = '';
  await enter(res.json.user);
};

$('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  setBusy($('regBtn'), true);
  const res = await api('POST', '/api/auth/register', {
    username: $('regUser').value.trim(), displayName: $('regName').value.trim(), title: $('regTitle').value.trim(), password: $('regPwd').value,
  });
  setBusy($('regBtn'), false);
  if (!res.ok) { $('regErr').textContent = errText(res, '注册失败'); return; }
  $('regPwd').value = '';
  toast('注册成功。下一步：申请管理班级');
  await enter(res.json.user);
};

$('passwordForm').onsubmit = async (e) => {
  e.preventDefault();
  if ($('newPwd').value !== $('newPwd2').value) { $('pwdErr').textContent = '两次输入的密码不一致'; return; }
  setBusy($('pwdBtn'), true);
  const res = await api('POST', '/api/me/password', { newPassword: $('newPwd').value });
  setBusy($('pwdBtn'), false);
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
  $('avatar').textContent = initial(me.displayName);
  $('whoName').textContent = me.displayName;
  const head = $('whoami');
  head.innerHTML = '';
  head.append(me.displayName, el('small', '', me.username + (me.title ? ' · ' + me.title : '') + (me.role === 'admin' ? ' · 管理员' : '')));
  $('toAdmin').hidden = me.role !== 'admin';
  const wanted = new URLSearchParams(location.search).get('class') || '';
  if (CLASS_ID_RE.test(wanted)) {
    if (await openClass(wanted)) return;
  }
  await showHome();
}
wireMenu($('whoBtn'), $('whoMenu'));

/* ================= 个人工作台 ================= */
async function showHome() {
  classId = ''; klass = null; lastSent = null;
  disconnectLive();
  closeSheet();
  delete document.documentElement.dataset.color;
  history.replaceState(null, '', location.pathname);
  $('home').hidden = false;
  $('klassView').hidden = true;
  $('tabs').hidden = true;
  $('tray').hidden = true;
  $('backHome').hidden = true;
  $('classStamp').hidden = true;
  $('livePill').hidden = true;
  $('title').textContent = '个人工作台';
  $('subtitle').textContent = me.displayName + (me.title ? ' · ' + me.title : '');
  $('hello').textContent = '你好，' + callerName();
  document.title = 'Caller · 教师端';
  await loadHome();
}

async function loadHome() {
  fill($('myClasses'), skeleton(3));
  const res = await api('GET', '/api/me/classes');
  if (!res.ok) {
    if (res.status !== 401) fill($('myClasses'), errorState(errText(res, '班级列表加载失败'), loadHome));
    return;
  }
  const d = res.json;
  callWindow = d.callWindow;
  renderWindowPill();
  fill($('homeWindow'), windowSummary());

  const box = $('myClasses');
  box.innerHTML = '';
  if (!d.classes.length) {
    box.append(me.role === 'admin'
      ? emptyState('还没有任何班级', '请先在管理端新增班级并录入名单。', { label: '打开管理端', fn: () => { location.href = '/admin.html'; } })
      : emptyState('还没有获批的班级', '在下方选择班级提交申请，管理员批准后这里会出现「进入班级」。', { label: '去申请', fn: () => $('requestClass').focus() }));
  }
  for (const c of d.classes) {
    const item = el('div', 'item');
    const stamp = el('span', 'lead stamp lg', c.code);
    stamp.dataset.color = c.color || '';
    const copy = el('div', 'body');
    copy.append(el('strong', '', c.name));
    copy.append(el('small', '', `${c.studentCount} 名学生 · 大屏${c.autoClearSeconds ? ' ' + c.autoClearSeconds + ' 秒后自动清除' : '常驻显示'}`));
    const acts = el('div', 'acts');
    const open = el('button', 'btn btn-primary', '');
    open.type = 'button';
    open.append(el('span', '', '进入班级'));
    open.onclick = () => openClass(c.id);
    acts.append(open);
    item.append(stamp, copy, acts);
    box.append(item);
  }

  const select = $('requestClass');
  const mine = new Set(d.classes.map((c) => c.id));
  const pending = new Set(d.requests.filter((r) => r.status === 'pending').map((r) => r.classId));
  select.innerHTML = '<option value="">选择班级</option>';
  let options = 0;
  for (const c of d.availableClasses) {
    if (mine.has(c.id) || pending.has(c.id)) continue;
    const o = el('option', '', `${c.name}（${c.code}）`); o.value = c.id; select.append(o);
    options += 1;
  }
  select.disabled = options === 0;
  if (!options) select.firstElementChild.textContent = '没有可以申请的班级';

  const rq = $('myRequests');
  rq.innerHTML = '';
  if (d.requests.length) rq.style.marginTop = 'var(--gap-item)';
  for (const r of d.requests) {
    const tone = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: '' }[r.status] || '';
    const item = el('div', 'item');
    item.dataset.tone = tone;
    const lead = el('span', 'lead');
    lead.append(icon({ pending: 'clock', approved: 'check', rejected: 'x', cancelled: 'undo' }[r.status] || 'info'));
    const copy = el('div', 'body');
    const st = { pending: '待审批', approved: '已批准', rejected: '已拒绝', cancelled: '已撤回' }[r.status] || r.status;
    copy.append(el('strong', '', `${r.className} · ${st}`));
    const parts = [dateTime(r.createdAt)];
    if (r.reason) parts.push(r.reason);
    if (r.status === 'rejected' && r.note) parts.push('理由：' + r.note);
    copy.append(el('small', '', parts.join(' · ')));
    const acts = el('div', 'acts');
    if (r.status === 'pending') {
      const cancel = el('button', 'btn btn-ghost danger btn-sm', '撤回申请');
      cancel.type = 'button';
      cancel.onclick = async () => {
        const x = await api('DELETE', '/api/me/class-requests/' + r.id);
        if (x.ok) { toast('已撤回申请'); loadHome(); } else toast(errText(x, '撤回失败'), true);
      };
      acts.append(cancel);
    }
    item.append(lead, copy, acts);
    rq.append(item);
  }

  const hs = $('homeSchedules');
  hs.innerHTML = '';
  if (!d.upcomingSchedules.length && !d.pausedSchedules.length) hs.append(emptyState('暂无定时提醒', '进入班级后可在「定时提醒」里创建每天固定时间的点人。'));
  for (const s of d.pausedSchedules) hs.append(miniSchedule(s, true));
  for (const s of d.upcomingSchedules) hs.append(miniSchedule(s, false));
}

function miniSchedule(s, paused) {
  const item = el('div', 'item');
  item.dataset.tone = paused ? 'bad' : 'info';
  const lead = el('span', 'lead'); lead.append(icon(paused ? 'pause' : 'clock'));
  const copy = el('div', 'body');
  const t = el('strong');
  t.append(el('span', 'num', s.time + ' '), s.names.join('、'));
  copy.append(t);
  copy.append(el('small', '', paused
    ? '已暂停：' + (PAUSE_REASONS[s.pauseReason] || s.pauseReason || '')
    : `下次 ${dateTime(s.nextRunAt)}${s.message ? ' · ' + s.message : ''}`));
  item.append(lead, copy);
  return item;
}

$('requestForm').onsubmit = async (e) => {
  e.preventDefault();
  const cid = $('requestClass').value;
  if (!cid) { $('requestClass').focus(); return toast('请先选择要申请的班级', true); }
  setBusy($('requestBtn'), true);
  const res = await api('POST', '/api/me/class-requests', { classId: cid, reason: $('requestReason').value.trim() });
  setBusy($('requestBtn'), false);
  if (!res.ok) return toast(errText(res, '提交失败'), true);
  $('requestReason').value = '';
  toast('申请已提交，等待管理员审批');
  loadHome();
};

$('changePwd').onclick = () => { $('pwdChangeErr').hidden = true; $('pwdDialog').showModal(); $('curPwd').focus(); };
$('pwdCancel').onclick = () => $('pwdDialog').close();
$('pwdChangeForm').onsubmit = async (e) => {
  e.preventDefault();
  setBusy($('pwdSave'), true);
  const res = await api('POST', '/api/me/password', { currentPassword: $('curPwd').value, newPassword: $('nxtPwd').value });
  setBusy($('pwdSave'), false);
  if (!res.ok) { $('pwdChangeErr').textContent = errText(res, '修改失败'); $('pwdChangeErr').hidden = false; return; }
  $('curPwd').value = ''; $('nxtPwd').value = '';
  $('pwdDialog').close();
  toast('密码已更新，其它设备需要重新登录');
};
$('backHome').onclick = showHome;
$('brandHome').onclick = (e) => { if (!me) return; e.preventDefault(); showHome(); };

/* ================= 作息提示 ================= */
function nextText(n) {
  if (!n) return '';
  return (n.date === callWindow.now.date ? '今天 ' : n.weekdayName + ' ') + n.start + '–' + n.end;
}
function windowSummary() {
  const box = el('div');
  if (!callWindow) return box;
  const n = el('div', 'note ' + (callWindow.open ? 'ok' : 'warn'));
  n.append(icon(callWindow.open ? 'check' : 'clock'));
  if (callWindow.open) {
    n.append(el('span', '', `现在可以点人：${callWindow.current.start}–${callWindow.current.end}${callWindow.current.label ? '（' + callWindow.current.label + '）' : ''}`));
  } else {
    n.append(el('span', '', '当前正在上课，暂不能点人' + (callWindow.next ? '。下次可用时间：' + nextText(callWindow.next) : '')));
  }
  box.append(n);
  return box;
}

function renderWindowPill() {
  const pill = $('windowPill');
  if (!callWindow) return;
  pill.className = 'status ' + (callWindow.open ? 'ok' : 'warn');
  $('windowText').textContent = callWindow.open
    ? `可点人至 ${callWindow.current.end}`
    : (callWindow.next ? `上课中 · ${callWindow.next.date === callWindow.now.date ? '' : callWindow.next.weekdayName + ' '}${callWindow.next.start} 可点` : '上课中');
  const notice = $('windowNotice');
  if (callWindow.open) { notice.hidden = true; } else {
    notice.hidden = false;
    notice.innerHTML = '';
    notice.append(icon('clock'), el('span', '', '当前正在上课，暂不能点人' + (callWindow.next ? `。下次可用时间：${nextText(callWindow.next)}` : '') + '。可以先选好学生，到时间再发送。'));
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
  lastSent = null;
  sel.clear(); schSel.clear();
  $('msg').value = ''; $('search').value = ''; $('schSearch').value = '';

  const url = new URL(location.href); url.searchParams.set('class', id); history.replaceState(null, '', url);
  $('home').hidden = true;
  $('klassView').hidden = false;
  $('tabs').hidden = false;
  $('backHome').hidden = false;
  const stamp = $('classStamp');
  stamp.hidden = false;
  stamp.textContent = klass.code;
  stamp.dataset.color = klass.color || '';
  $('livePill').hidden = false;
  $('title').textContent = klass.className;
  $('subtitle').textContent = students.length + ' 名同学' + (d.autoClearSeconds ? ' · 大屏 ' + d.autoClearSeconds + ' 秒后自动清除' : ' · 大屏常驻显示');
  document.title = klass.className + ' · Caller';
  $('nowTitle').textContent = klass.className + '大屏';
  $('callerLabel').textContent = '大屏上显示的发起人：' + callerLabel();
  $('annUrgentField').hidden = me.role !== 'admin';
  const policy = settings.announcementPolicy === 'next_window' && me.role !== 'admin';
  $('annPolicyNote').hidden = !policy;
  $('annPolicyNote').textContent = policy ? '学校设置：上课期间发布的留言会等到下一个课间再显示。' : '';
  $('pvClass').textContent = klass.className;
  renderWindowPill();
  renderGrid(); renderPicked(); renderNow(); renderLive(d);
  connectLive();
  switchTab(currentTab);
  return true;
}

function callerName() {
  if (!me) return '老师';
  return me.displayName.length <= 2 ? me.displayName + '老师' : me.displayName;
}
function callerLabel() {
  if (!me) return '老师';
  const name = callerName();
  return me.title ? me.title + ' · ' + name : name;
}

/* ---------- 标签页 ---------- */
function switchTab(tab) {
  currentTab = tab;
  markTabs($('tabs'), tab, 'tab');
  for (const t of ['call', 'announce', 'schedule', 'activity']) $('tab-' + t).hidden = t !== tab;
  $('tray').hidden = tab !== 'call';
  if (tab !== 'call') closeSheet();
  if (tab === 'announce') { renderPreview(); loadAnnouncements(); }
  if (tab === 'schedule') { renderSchPicker(); loadSchedules(); }
  if (tab === 'activity') { loadActivity(); }
  syncTrayHeight();
}
wireTabs($('tabs'), switchTab);

/* ---------- 名字网格 ---------- */
function toggleName(set, name, rerender) {
  if (set.has(name)) set.delete(name);
  else if (set.size < maxNamesPerCall) set.add(name);
  else { toast('一次最多选择 ' + maxNamesPerCall + ' 人', true); return; }
  rerender();
}

/** 重建名单格子时保留键盘焦点：否则每选一个人，焦点就掉回页面顶部 */
function keepFocus(grid, build) {
  const active = document.activeElement;
  const name = active && grid.contains(active) ? active.dataset.name : null;
  build();
  if (name) {
    const again = [...grid.children].find((b) => b.dataset.name === name);
    if (again) again.focus();
  }
}

function nameButton(name, set, onToggle) {
  const selected = set.has(name);
  const b = el('button', 's');
  b.type = 'button';
  b.dataset.name = name;
  b.append(name);
  const tick = el('span', 'tick'); tick.append(icon('check')); b.append(tick);
  b.setAttribute('aria-pressed', selected ? 'true' : 'false');
  b.disabled = !selected && set.size >= maxNamesPerCall;
  b.onclick = () => toggleName(set, name, onToggle);
  return b;
}

function filtered(q) { return students.filter((name) => !q || name.includes(q)); }

function renderGrid() {
  const q = $('search').value.trim();
  const grid = $('grid');
  const list = filtered(q);
  keepFocus(grid, () => {
    grid.innerHTML = '';
    for (const name of list) grid.append(nameButton(name, sel, () => { renderGrid(); renderPicked(); }));
  });
  const empty = $('gridEmpty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    fill(empty, students.length
      ? emptyState('没有找到「' + q + '」', '换个关键词，或清空搜索框查看全班。', { label: '清空搜索', fn: () => { $('search').value = ''; renderGrid(); $('search').focus(); } }, true)
      : emptyState('本班名单还是空的', '请联系管理员在管理端录入学生名单。', null, true));
  }
  const t = '已选择 ' + sel.size + ' / ' + maxNamesPerCall;
  $('hint').textContent = q ? '匹配 ' + list.length + ' 人 · ' + t : t;
}

function chips(box, set, placeholder, after) {
  box.innerHTML = '';
  if (!set.size) { box.append(el('span', 'ph', placeholder)); return; }
  for (const name of set) {
    const chip = el('span', 'chip', name);
    const rm = el('button');
    rm.type = 'button'; rm.setAttribute('aria-label', '取消选择 ' + name);
    rm.append(icon('x'));
    rm.onclick = () => { set.delete(name); after(); };
    chip.append(rm); box.append(chip);
  }
}

function renderPicked() {
  chips($('picked'), sel, '还没有选择学生', () => { renderGrid(); renderPicked(); });
  const open = callWindow ? callWindow.open : true;
  const n = sel.size;
  $('send').disabled = n === 0 || sending || !open;
  $('reset').disabled = n === 0;
  $('pickedCount').textContent = String(n);
  $('pickedNames').textContent = n ? [...sel].join('、') : '点名单选择学生';
  $('pickedBtn').toggleAttribute('data-empty', n === 0);
  $('tray').toggleAttribute('data-empty', n === 0);
  $('sheetTitle').textContent = '已选 ' + n + ' 人';
  const txt = $('sendText');
  txt.innerHTML = '';
  if (!open) txt.textContent = '上课中，暂不能点人';
  else if (!n) txt.textContent = '通知到大屏';
  else { txt.append('通知 ' + n + ' 人'); txt.append(el('span', 'send-target', '到' + (klass ? klass.className : '') + '大屏')); }
  if (!n) closeSheet();
  renderSignal();
  syncTrayHeight();
}

/* ---------- 已选名单面板（bottom sheet） ---------- */
function openSheet() {
  if (!sel.size) return;
  $('sheet').hidden = false;
  $('pickedBtn').setAttribute('aria-expanded', 'true');
  syncTrayHeight();
}
function closeSheet() {
  $('sheet').hidden = true;
  $('pickedBtn').setAttribute('aria-expanded', 'false');
}
$('pickedBtn').onclick = () => ($('sheet').hidden ? openSheet() : closeSheet());
$('sheetClose').onclick = () => { closeSheet(); $('pickedBtn').focus(); };
$('sheetClear').onclick = () => clearSelection();
function syncTrayHeight() {
  document.documentElement.style.setProperty('--tray-h', ($('tray').hidden ? 0 : $('tray').offsetHeight) + 'px');
}
window.addEventListener('resize', syncTrayHeight);

function clearSelection() {
  if (!sel.size) return;
  const before = [...sel];
  sel.clear(); renderGrid(); renderPicked();
  toast('已清空 ' + before.length + ' 人', { action: { label: '撤销', fn: () => { before.forEach((n) => sel.add(n)); renderGrid(); renderPicked(); } } });
}
$('reset').onclick = clearSelection;

/* ---------- 大屏状态 ---------- */
function ownEvent(ev) {
  if (!ev || typeof ev.id !== 'number' || ev.classId !== classId) return null;
  return ev.type === 'clear' ? null : ev;
}

function renderNow() {
  const ev = ownEvent(display.current);
  const scr = $('nowScreen');
  scr.innerHTML = '';
  scr.className = 'screen';
  clearInterval(cdTimer);
  if (!ev) {
    scr.append(el('div', 'scr-idle', hhmm(Date.now())), el('small', '', '待机'));
    $('countdown').classList.remove('on');
  } else if (ev.type === 'call') {
    scr.append(el('div', 'scr-label', (ev.caller || '老师') + '正在找'));
    const names = el('div', 'scr-names');
    const acked = new Map((ev.acks || []).map((a) => [a.name, a.at]));
    for (const name of ev.names) {
      const s = el('span', acked.has(name) ? 'acked' : '', name);
      if (acked.has(name)) s.append(icon('check'));
      s.title = acked.has(name) ? '已收到 ' + hhmm(acked.get(name)) : '未收到';
      names.append(s);
    }
    scr.append(names);
    if (ev.message) scr.append(el('div', 'scr-msg', ev.message));
  } else {
    if (ev.priority === 1) scr.classList.add('urgent');
    scr.append(el('div', 'scr-label', ev.priority === 1 ? '紧急通知' : '班级留言'));
    scr.append(el('div', 'scr-title', ev.title || ''));
    if (ev.body) scr.append(el('div', 'scr-body', ev.body));
  }
  $('clear').disabled = !ev && !(display.queue || []).length;
  if (ev) paintCountdown(ev);
  renderQueue();
  renderSignal();
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
    row.dataset.tone = item.priority === 1 ? 'bad' : 'warn';
    const lead = el('span', 'lead num', String(i + 1));
    const copy = el('div', 'body');
    const label = item.type === 'call' ? (item.names || []).join('、') : (item.title || '留言');
    copy.append(el('strong', '', label));
    copy.append(el('small', '', (item.type === 'call' ? '点人' : '留言') + (item.author ? ' · ' + item.author : '') + ' · ' + ({ 1: '紧急', 2: '定时提醒', 3: '手动', 4: '普通' }[item.priority] || '')));
    const acts = el('div', 'acts');
    const wd = el('button', 'btn btn-ghost danger btn-sm', '撤回');
    wd.type = 'button';
    wd.onclick = () => withdraw(item.noticeId, true);
    acts.append(wd);
    row.append(lead, copy, acts);
    box.append(row);
  });
}

function renderLive(d) {
  const pill = $('livePill');
  displaysOnline = d.displays || 0;
  pill.className = 'status ' + (displaysOnline ? 'ok' : 'bad');
  pill.querySelector('svg').replaceWith(icon(displaysOnline ? 'monitor' : 'monitorOff'));
  $('liveText').textContent = displaysOnline ? '大屏在线' + (displaysOnline > 1 ? ' ' + displaysOnline : '') : '大屏未连接';
  renderSignal();
}

/* ---------- 消息信号轨道：我最近一次发送走到了哪一步 ---------- */
function signalState() {
  const cur = ownEvent(display.current);
  const s = lastSent;
  const onScreen = Boolean(cur && cur.type === 'call' && cur.noticeId === s.noticeId);
  const qi = (display.queue || []).findIndex((q) => q.noticeId === s.noticeId);
  if (onScreen) {
    s.seen = true;
    s.acks = new Map((cur.acks || []).map((a) => [a.name, a.at]));
  }
  if (qi >= 0) s.queued = true;
  const acked = s.names.filter((n) => s.acks.has(n)).length;
  const total = s.names.length;
  if (s.withdrawn) return { stage: s.seen ? 3 : 2, tone: 'alert', ended: true, text: '已撤回', short: '已撤回' };
  if (acked === total) return { stage: 4, tone: 'ok', text: '全部 ' + total + ' 人已收到', short: '全部已收到' };
  if (onScreen) return { stage: 3, tone: 'gold', text: '正在显示 · 已收到 ' + acked + ' / ' + total, short: '正在显示 ' + acked + '/' + total, live: true };
  if (qi >= 0) return { stage: 2, tone: 'gold', text: qi ? '排队中，前面还有 ' + qi + ' 条' : '排队中，下一条就是它', short: '等待显示', queued: true };
  if (s.seen) return { stage: 3, tone: 'gold', ended: true, text: '已下屏 · 已收到 ' + acked + ' / ' + total, short: '已下屏 ' + acked + '/' + total };
  // 排过队、还没显示就不见了：别人清空了队列或撤回了它。不能一直停在「等待大屏同步」
  if (s.queued) return { stage: 2, tone: 'alert', ended: true, text: '已从等待队列移除，没有显示', short: '已移除' };
  return { stage: 1, tone: 'gold', text: '已发送，等待大屏同步', short: '已发送' };
}

function renderSignal() {
  const box = $('signalBox');
  const tray = $('traySignal');
  if (!box) return;
  box.innerHTML = '';
  if (!lastSent) {
    tray.hidden = true;
    const head = el('div', 'signal-head');
    head.append(el('strong', '', sel.size ? '已选 ' + sel.size + ' 人，还没有发送' : '还没有发送通知'));
    box.append(head, signalTrack(sel.size ? 0 : -1, 'gold'));
    const foot = el('div', 'signal-foot');
    foot.append(el('p', 'muted', '发送后，这里实时显示通知走到了哪一步，以及每位同学有没有点「收到」。'));
    foot.firstChild.style.margin = '0';
    box.append(foot);
    syncTrayHeight();
    return;
  }
  const st = signalState();
  const s = lastSent;
  const head = el('div', 'signal-head');
  head.append(el('strong', '', st.text), el('span', 'num', hhmm(s.sentAt) + ' 发送'));
  box.append(head, signalTrack(st.stage, st.tone, st.ended));

  const foot = el('div', 'signal-foot');
  const names = el('div', 'chips');
  for (const n of s.names) {
    const has = s.acks.has(n);
    const chip = el('span', 'status ' + (has ? 'ok' : ''));
    chip.append(icon(has ? 'check' : 'clock'), n + ' · ' + (has ? '已收到 ' + hhmm(s.acks.get(n)) : '未收到'));
    names.append(chip);
  }
  foot.append(names);
  if (s.message) foot.append(el('p', 'muted', '附加说明：' + s.message));
  if (!displaysOnline && !st.ended && st.stage < 4) {
    const warn = el('div', 'note bad');
    warn.append(icon('monitorOff'), el('span', '', '大屏未连接：学生暂时看不到这条通知。请检查教室大屏是否开机联网。'));
    foot.append(warn);
  }
  const acts = el('div', 'row');
  if (st.live || st.queued) {
    const wd = el('button', 'btn btn-secondary btn-sm', '撤回这条通知');
    wd.type = 'button';
    wd.onclick = () => withdraw(s.noticeId, true);
    acts.append(wd);
  }
  if (st.ended && st.stage < 4 && !s.withdrawn) {
    const re = el('button', 'btn btn-secondary btn-sm', '再次发送');
    re.type = 'button';
    re.onclick = () => resend(s.noticeId, true);
    acts.append(re);
  }
  if (acts.children.length) foot.append(acts);
  for (const p of foot.querySelectorAll('p')) p.style.margin = '0';
  box.append(foot);

  // 手机上托盘里的精简信号条
  tray.hidden = false;
  tray.dataset.tone = st.tone;
  tray.innerHTML = '';
  const dots = el('span', 'dots');
  for (let i = 0; i < 5; i += 1) dots.append(el('i', i <= st.stage ? 'on' : ''));
  tray.append(dots, el('span', '', st.short), el('span', '', s.names.length > 3 ? s.names.slice(0, 3).join('、') + '…' : s.names.join('、')));
  tray.setAttribute('aria-label', '通知进度：' + st.text + '，点一下查看详情');
  syncTrayHeight();
}
$('traySignal').onclick = () => { closeSheet(); $('signalPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); };

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
  setBusy($('send'), v);
  renderPicked();
}

$('send').onclick = async () => {
  const names = [...sel];
  if (!names.length || sending) return;
  const message = $('msg').value.trim();
  $('sendErr').hidden = true;
  setSending(true);
  try {
    const res = await api('POST', cpath('calls'), { names, message });
    if (!res.ok) {
      if (res.json && res.json.error === 'CALL_WINDOW_CLOSED') { callWindow = res.json.callWindow || callWindow; renderWindowPill(); }
      // 发送失败不自动消失：留在托盘里，直到下一次操作
      $('sendErr').textContent = errText(res, '发送失败') + '。已选名单保留，可以直接重试。';
      $('sendErr').hidden = false;
      syncTrayHeight();
      return;
    }
    lastSent = { noticeId: res.json.notice.id, names, message, sentAt: Date.now(), acks: new Map(), seen: false, queued: false, withdrawn: false };
    display = res.json.display;
    sel.clear(); $('msg').value = ''; $('search').value = '';
    renderGrid();
    renderNow(); renderLive(res.json);
    const b = $('send');
    b.dataset.state = 'success';
    setTimeout(() => { delete b.dataset.state; }, 1400);
    toast(res.json.displayedNow ? '已通知到' + klass.className + '大屏' : '已加入等待队列，当前内容结束后显示', !res.json.displays);
  } finally { setSending(false); }
};

$('clear').onclick = async () => {
  const cur = ownEvent(display.current);
  const q = (display.queue || []).length;
  const what = !cur ? '' : (cur.type === 'call' ? '「' + cur.names.join('、') + '」' : '「' + (cur.title || '留言') + '」');
  const choice = await choiceDialog({
    title: '清空' + (klass ? klass.className : '') + '大屏',
    icon: 'monitor',
    text: cur ? '大屏正在显示' + what + '。' : '大屏当前空闲。',
    choices: [
      { value: 'current', label: '只清除当前内容', desc: q ? '等待中的 ' + q + ' 条会接着显示' : '大屏回到待机', disabled: !cur },
      { value: 'all', label: '清除当前内容和等待队列', desc: q ? '当前内容和等待中的 ' + q + ' 条都会移除，不能恢复' : '没有等待中的内容', danger: true, disabled: !q },
    ],
  });
  if (choice) clearDisplay(choice === 'all');
};
async function clearDisplay(all) {
  const res = await api('POST', cpath('display/clear'), { all });
  if (!res.ok) return toast(errText(res, '清空失败'), true);
  display = res.json.display; renderNow();
  toast(all ? '大屏与等待队列已清空' : '当前内容已清除');
}
async function withdraw(noticeId, offerUndo) {
  const res = await api('POST', cpath('notices/' + noticeId + '/withdraw'), {});
  if (!res.ok) return toast(errText(res, '撤回失败'), true);
  if (lastSent && lastSent.noticeId === noticeId) lastSent.withdrawn = true;
  display = res.json.display; renderNow();
  toast('已撤回', offerUndo ? { action: { label: '撤销', fn: () => resend(noticeId, false) } } : undefined);
  return true;
}
async function resend(noticeId, quiet) {
  const res = await api('POST', cpath('notices/' + noticeId + '/resend'), {});
  if (!res.ok) return toast(errText(res, '再次发送失败'), true);
  if (lastSent && lastSent.noticeId === noticeId) { lastSent.withdrawn = false; lastSent.seen = false; lastSent.queued = false; lastSent.acks = new Map(); lastSent.sentAt = Date.now(); }
  display = res.json.display; renderNow();
  if (quiet !== false || res.json.alreadyQueued) toast(res.json.alreadyQueued ? '这条内容已在大屏或队列中' : '已再次发送');
}

$('search').oninput = renderGrid;
$('search').onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = filtered($('search').value.trim())[0];
  if (!first || !$('search').value.trim()) return;
  toggleName(sel, first, () => { $('search').value = ''; renderGrid(); renderPicked(); });
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentTab === 'call' && !document.querySelector('dialog[open]')) {
    if (!$('sheet').hidden) { closeSheet(); $('pickedBtn').focus(); } else if ($('search').value) { $('search').value = ''; renderGrid(); }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && currentTab === 'call' && !$('app').hidden && !$('klassView').hidden) $('send').click();
});

/* ---------- 留言 ---------- */
function renderPreview() {
  const urgent = me && me.role === 'admin' && $('annUrgent').checked;
  $('annPreview').classList.toggle('urgent', urgent);
  $('pvKind').textContent = urgent ? '紧急通知' : '班级留言';
  $('pvTitle').textContent = $('annTitle').value.trim() || '班级通知';
  $('pvBody').textContent = $('annBody').value.trim() || '正文内容会显示在这里';
  $('pvAuthor').textContent = '—— ' + callerLabel();
  $('pvClock').textContent = hhmm(Date.now());
}
$('annTitle').oninput = renderPreview;
$('annBody').oninput = renderPreview;
$('annUrgent').onchange = renderPreview;
$('annWhen').onchange = () => { $('annAtField').hidden = $('annWhen').value !== 'later'; };
$('announceForm').onsubmit = async (e) => {
  e.preventDefault();
  const urgent = me.role === 'admin' && $('annUrgent').checked;
  const body = {
    title: $('annTitle').value.trim(), body: $('annBody').value.trim(),
    durationSeconds: Number($('annDuration').value),
    urgent,
  };
  if (!body.title || !body.body) return toast('请填写标题和正文', true);
  if ($('annWhen').value === 'later') {
    const at = $('annAt').value;
    if (!at) { $('annAt').focus(); return toast('请选择显示时间', true); }
    body.publishAt = new Date(at).getTime();
  }
  if (urgent) {
    const cur = ownEvent(display.current);
    const ok = await confirmDialog({
      title: '发布紧急广播', danger: true, confirm: '立即抢占大屏',
      text: '紧急广播会立刻占用' + klass.className + '大屏。',
      impact: [
        cur ? '正在显示的「' + (cur.type === 'call' ? cur.names.join('、') : cur.title) + '」会被挤到等待队列，广播结束后回来' : '大屏当前空闲',
        '大屏顶部显示红色信号条和「紧急通知」',
        '操作会写入审计记录',
      ],
    });
    if (!ok) return;
  }
  setBusy($('annSend'), true);
  const res = await api('POST', cpath('announcements'), body);
  setBusy($('annSend'), false);
  if (!res.ok) return toast(errText(res, '发布失败'), true);
  display = res.json.display; renderNow();
  const n = res.json.notice;
  toast(n.status === 'scheduled' ? '已安排在 ' + dateTime(n.publishAt) + ' 显示' : (res.json.displayedNow ? '留言已显示到大屏' : '留言已加入等待队列'));
  $('annTitle').value = ''; $('annBody').value = ''; $('annUrgent').checked = false; renderPreview();
  loadAnnouncements();
};

async function loadAnnouncements() {
  const box = $('annList');
  if (!box.children.length) fill(box, skeleton(3));
  const res = await api('GET', cpath('notices?type=announcement'));
  if (!res.ok) return fill(box, errorState(errText(res, '留言加载失败'), loadAnnouncements));
  if (res.json.classId !== classId) return;
  box.innerHTML = '';
  if (!res.json.notices.length) box.append(emptyState('还没有留言', '发布后会列在这里，可以随时撤回或再次发送。'));
  for (const n of res.json.notices.slice(0, 20)) box.append(noticeRow(n));
}

function noticeRow(n) {
  const row = el('div', 'item');
  const urgent = n.priority === 1;
  row.dataset.tone = urgent ? 'bad' : (n.type === 'call' ? 'info' : 'warn');
  const lead = el('span', 'lead');
  lead.append(icon(urgent ? 'alert' : (n.type === 'call' ? (n.source === 'schedule' ? 'clock' : 'users') : 'megaphone')));
  const copy = el('div', 'body');
  const tag = el('span', 'tag ' + (urgent ? 'urgent' : n.type), urgent ? '紧急' : (n.type === 'call' ? (n.source === 'schedule' ? '定时' : '点人') : '留言'));
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
    const re = el('button', 'btn btn-ghost btn-sm', '再次发送'); re.type = 'button'; re.onclick = () => resend(n.id); acts.append(re);
  }
  if (n.status !== 'withdrawn') {
    const wd = el('button', 'btn btn-ghost danger btn-sm', '撤回'); wd.type = 'button';
    wd.onclick = () => withdraw(n.id, false).then((ok) => { if (!ok) return; loadAnnouncements(); if (currentTab === 'activity') loadActivity(); });
    acts.append(wd);
  }
  row.append(lead, copy, acts);
  return row;
}

/* ---------- 定时提醒 ---------- */
function renderSchPicker() {
  const refresh = () => renderSchPicker();
  chips($('schPicked'), schSel, '还没有选择学生：在下面搜索或点选', refresh);
  $('schCount').textContent = '已选 ' + schSel.size + ' 人';
  const q = $('schSearch').value.trim();
  const grid = $('schGrid');
  const list = filtered(q);
  keepFocus(grid, () => {
    grid.innerHTML = '';
    for (const name of list) grid.append(nameButton(name, schSel, refresh));
    if (!list.length) grid.append(el('span', 'ph', students.length ? '没有找到「' + q + '」' : '本班名单为空'));
  });
  const use = $('schUseCall');
  const same = sel.size === schSel.size && [...sel].every((n) => schSel.has(n));
  use.hidden = !sel.size || same;
  use.textContent = '改用「点人」页已选的 ' + sel.size + ' 人';
}
$('schSearch').oninput = renderSchPicker;
$('schSearch').onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = filtered($('schSearch').value.trim())[0];
  if (!first || !$('schSearch').value.trim()) return;
  toggleName(schSel, first, () => { $('schSearch').value = ''; renderSchPicker(); });
};
$('schUseCall').onclick = () => { schSel.clear(); sel.forEach((n) => schSel.add(n)); renderSchPicker(); };

async function loadSchedules() {
  const box = $('schList');
  if (!box.children.length) fill(box, skeleton(3));
  const res = await api('GET', cpath('schedules'));
  if (!res.ok) return fill(box, errorState(errText(res, '定时提醒加载失败'), loadSchedules));
  if (res.json.classId !== classId) return;
  schedules = res.json.schedules;
  const w = res.json.callWindows;
  const wbox = $('schWindows');
  wbox.innerHTML = '';
  const days = el('p', 'muted', w.weekdays.map((d) => WEEKDAYS[d]).join('、'));
  days.style.margin = '0 0 8px';
  const times = el('div', 'chips');
  for (const x of w.windows) times.append(el('span', 'status num', x.start + '–' + x.end));
  wbox.append(days, times);
  box.innerHTML = '';
  const paused = schedules.filter((s) => s.status === 'paused').length;
  $('scheduleBadge').textContent = paused ? String(paused) : '';
  if (!schedules.length) box.append(emptyState('还没有定时提醒', '比如每天第二节课后提醒课代表去办公室，只需设置一次。'));
  for (const s of schedules) {
    const row = el('div', 'item');
    const isPaused = s.status === 'paused';
    row.dataset.tone = !s.enabled ? '' : (isPaused ? 'bad' : 'ok');
    const lead = el('span', 'lead'); lead.append(icon(!s.enabled ? 'pause' : (isPaused ? 'alert' : 'clock')));
    const copy = el('div', 'body');
    const t = el('strong');
    t.append(el('span', 'num', s.time + '　'), s.names.join('、'));
    copy.append(t);
    const meta = [s.weekdayNames.join('、'), s.message || '无附加说明', '创建：' + s.createdByName];
    if (s.startDate || s.endDate) meta.push((s.startDate || '') + ' 至 ' + (s.endDate || '不限'));
    if (!s.enabled) meta.push('已停用');
    else if (isPaused) meta.push('已暂停：' + (PAUSE_REASONS[s.pauseReason] || s.pauseReason));
    else if (s.nextRunAt) meta.push('下次 ' + dateTime(s.nextRunAt));
    if (s.lastResult) meta.push('最近：' + ({ sent: '已发送', missed: '已错过', skipped: '已跳过', failed: '失败' }[s.lastResult.status] || s.lastResult.status) + (s.lastRunDate ? ' ' + s.lastRunDate : ''));
    copy.append(el('small', '', meta.join(' · ')));
    const acts = el('div', 'acts');
    if (s.mine || me.role === 'admin') {
      const active = s.enabled && !isPaused;
      const toggle = el('button', 'btn btn-ghost btn-sm', s.enabled ? (isPaused ? '恢复' : '暂停') : '启用');
      toggle.type = 'button';
      toggle.onclick = async () => {
        const r = await api('PATCH', cpath('schedules/' + s.id), { enabled: !active });
        if (!r.ok) return toast(errText(r, '操作失败'), true);
        loadSchedules();
        if (active) {
          toast('已暂停 ' + s.time + ' 的提醒', { action: { label: '撤销', fn: async () => { const u = await api('PATCH', cpath('schedules/' + s.id), { enabled: true }); if (!u.ok) toast(errText(u, '恢复失败'), true); loadSchedules(); } } });
        } else toast('已恢复');
      };
      const edit = el('button', 'btn btn-ghost btn-sm', '改时间');
      edit.type = 'button';
      edit.onclick = async () => {
        const v = await promptDialog({
          title: '修改提醒时间', icon: 'clock', label: '新的提醒时间', type: 'time', value: s.time, required: true,
          hint: '必须在允许点人的时段内：' + w.windows.map((x) => x.start + '–' + x.end).join('、'),
        });
        if (!v || v === s.time) return;
        const r = await api('PATCH', cpath('schedules/' + s.id), { time: v.trim() });
        if (!r.ok) return toast(errText(r, '修改失败'), true);
        toast('已改为每天 ' + v);
        loadSchedules();
      };
      const del = el('button', 'btn btn-ghost danger btn-sm', '删除');
      del.type = 'button';
      del.onclick = async () => {
        const ok = await confirmDialog({
          title: '删除这条定时提醒？', danger: true, confirm: '删除提醒',
          impact: ['每天 ' + s.time + ' 不再自动点 ' + s.names.join('、'), '已经发出的记录会保留', '删除后不能恢复；只想临时停一下，可以用「暂停」'],
        });
        if (!ok) return;
        const r = await api('DELETE', cpath('schedules/' + s.id));
        if (!r.ok) return toast(errText(r, '删除失败'), true);
        toast('已删除');
        loadSchedules();
      };
      acts.append(toggle, edit, del);
    }
    row.append(lead, copy, acts);
    box.append(row);
  }
}

$('scheduleForm').onsubmit = async (e) => {
  e.preventDefault();
  const names = [...schSel];
  if (!names.length) { $('schSearch').focus(); return toast('请先选择要提醒的学生', true); }
  const weekdays = [...$('schWeekdays').querySelectorAll('input:checked')].map((i) => Number(i.value));
  if (!weekdays.length) return toast('请至少选择一个执行星期', true);
  const body = {
    names, time: $('schTime').value, message: $('schMessage').value.trim(), weekdays,
    startDate: $('schStart').value || null, endDate: $('schEnd').value || null,
  };
  setBusy($('schCreate'), true);
  const res = await api('POST', cpath('schedules'), body);
  setBusy($('schCreate'), false);
  if (!res.ok) return toast(errText(res, '创建失败'), true);
  toast('已创建：每天 ' + body.time + ' 提醒 ' + names.join('、'));
  $('schMessage').value = '';
  schSel.clear(); renderSchPicker();
  loadSchedules();
};

/* ---------- 记录 ---------- */
async function loadActivity() {
  const box = $('activity');
  fill(box, skeleton(5));
  const q = new URLSearchParams();
  if ($('actType').value) q.set('type', $('actType').value);
  if ($('actAuthor').value) q.set('author', $('actAuthor').value);
  if ($('actDate').value) q.set('date', $('actDate').value);
  const res = await api('GET', cpath('activity' + (q.toString() ? '?' + q : '')));
  if (!res.ok) return fill(box, errorState(errText(res, '记录加载失败'), loadActivity));
  if (res.json.classId !== classId) return;
  box.innerHTML = '';
  const authors = new Map();
  for (const x of res.json.activity) if (x.authorId) authors.set(x.authorId, x.authorName);
  const sel2 = $('actAuthor');
  const cur = sel2.value;
  if (!cur) {
    sel2.innerHTML = '<option value="">全部教师</option>';
    for (const [id, name] of authors) { const o = el('option', '', name); o.value = id; sel2.append(o); }
  }
  const filtering = $('actType').value || $('actAuthor').value || $('actDate').value;
  if (!res.json.activity.length) {
    box.append(filtering
      ? emptyState('没有符合条件的记录', '换个筛选条件试试。', { label: '重置筛选', fn: () => $('actReset').click() })
      : emptyState('还没有记录', '点人、留言和定时提醒的执行情况都会记在这里。'));
    return;
  }
  for (const x of res.json.activity) {
    if (x.kind === 'schedule_run') {
      const row = el('div', 'item');
      row.dataset.tone = 'bad';
      const lead = el('span', 'lead'); lead.append(icon('alert'));
      const copy = el('div', 'body');
      const t = el('strong'); t.append(el('span', 'tag schedule', '定时'), ({ missed: '已错过', skipped: '已跳过', failed: '发送失败' }[x.status] || x.status));
      copy.append(t, el('small', '', dateTime(x.at) + (x.detail ? ' · ' + (PAUSE_REASONS[x.detail] || (x.detail === 'CALL_WINDOW_CLOSED' ? '不在允许点人的时段' : x.detail)) : '')));
      row.append(lead, copy); box.append(row);
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
hydrateIcons();
(async function init() {
  const res = await api('GET', '/api/me');
  if (res.ok) {
    callWindow = res.json.callWindow;
    await enter(res.json.user);
  } else if (res.status === 0) {
    showGate('loginForm', '连不上服务器，请检查网络后刷新');
  } else {
    showGate('loginForm', res.gatewayError || '');
  }
})();
