'use strict';

const $ = (id) => document.getElementById(id);
let me = null;
let view = 'overview';
let classesCache = [];
let usersCache = [];
let windowsDraft = null;
let ovData = null;               // 最近一次概览数据：顶栏状态、角标、各班信号共用
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const COLORS = [['blue', '蓝'], ['green', '绿'], ['orange', '橙'], ['purple', '紫'], ['teal', '青'], ['red', '红']];
const PAUSE_REASONS = {
  CALL_WINDOW_CHANGED: '作息已修改', ACCESS_REVOKED: '权限已撤销', USER_DISABLED: '账号已停用',
  STUDENT_REMOVED: '学生已移出名单', CLASS_UNAVAILABLE: '班级已归档',
};
const ACTIONS = {
  'user.register': '教师注册', 'user.create': '创建教师', 'user.create_admin': '创建管理员', 'user.update': '修改账号', 'user.delete': '删除账号',
  'user.password_change': '修改密码', 'user.bootstrap_admin': '初始化管理员', 'access.request': '申请班级', 'access.cancel': '撤回申请',
  'access.approve': '批准申请', 'access.reject': '拒绝申请', 'access.grant': '授权班级', 'access.revoke': '撤销权限',
  'class.create': '新增班级', 'class.update': '修改班级', 'class.students': '修改名单', 'class.import_legacy': '导入旧名单',
  'call_windows.update': '修改作息', 'schedule.create': '创建定时', 'schedule.update': '修改定时', 'schedule.delete': '删除定时',
  'schedule.auto_pause': '定时自动暂停', 'notice.call': '点人', 'notice.announce': '留言', 'notice.urgent': '紧急广播',
  'notice.withdraw': '撤回通知', 'notice.resend': '再次发送', 'display.clear': '清除大屏', 'display.clear_all': '清空大屏与队列',
  'settings.update': '修改设置', 'session.revoke_all': '强制全员重新登录',
};
const GROUPS = { today: ['overview', 'requests'], org: ['classes', 'users'], dispatch: ['windows', 'schedules', 'displays'], security: ['audit', 'settings'] };
const lastInGroup = {};

const dt = (ms) => { if (!ms) return '—'; const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`; };
function errText(res, fb) { if (res.status === 0) return '连不上服务器，请检查网络后重试'; if (res.gatewayError) return res.gatewayError; const m = (res.json && res.json.message) || fb; return res.json && res.json.detail ? m + '：' + res.json.detail : m; }

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch { return { status: 0, ok: false, json: null }; }
  const json = await res.json().catch(() => null);
  const challenged = res.headers.get('cf-mitigated') === 'challenge';
  const basic = res.headers.has('www-authenticate');
  let gatewayError = '';
  if (!json && challenged) gatewayError = '请求被 Cloudflare 人机验证拦截。请对 /api/* 关闭 Managed Challenge';
  else if (!json && basic) gatewayError = '服务器仍启用了 HTTP Basic Auth。请更新 Nginx 配置并关闭 auth_basic';
  else if (!json && !res.ok) gatewayError = '服务器网关返回了非应用响应（HTTP ' + res.status + '），请检查 Nginx 或 Cloudflare 配置';
  if (res.status === 401 && json && ['UNAUTHORIZED', 'ACCOUNT_DISABLED'].includes(json.error)) gateOut('登录已失效，请重新登录');
  if (res.status === 403 && json && json.error === 'ADMIN_ONLY') gateOut('该账号不是管理员');
  return { status: res.status, ok: res.ok, json, gatewayError };
}

function stampFor(code, color, extra) {
  const s = el('span', 'stamp' + (extra ? ' ' + extra : ''), code || '—');
  if (color) s.dataset.color = color;
  return s;
}
function colorOf(classId) { const c = classesCache.find((x) => x.id === classId); return c ? c.color : ''; }
function classNameOf(id) { const c = classesCache.find((x) => x.id === id); return c ? c.name : id; }
function userNameOf(id) { const u = usersCache.find((x) => x.id === id); return u ? u.displayName : '（已删除的账号）'; }
function itemRow(tone, lead, title, meta, acts) {
  const row = el('div', 'item');
  if (tone) row.dataset.tone = tone;
  const l = typeof lead === 'string' ? el('span', 'lead') : lead;
  if (typeof lead === 'string') l.append(icon(lead));
  const c = el('div', 'body');
  c.append(typeof title === 'string' ? el('strong', '', title) : title);
  if (meta) c.append(el('small', '', meta));
  const a = el('div', 'acts');
  for (const b of acts || []) a.append(b);
  row.append(l, c, a);
  return row;
}
function btn(label, cls, fn, iconName) {
  const b = el('button', 'btn ' + (cls || 'btn-ghost btn-sm'));
  b.type = 'button';
  if (iconName) b.append(icon(iconName));
  b.append(el('span', '', label));
  b.onclick = fn;
  return b;
}

/* ================= 登录 ================= */
function gateOut(msg) {
  me = null;
  $('app').hidden = true; $('gate').hidden = false;
  $('loginErr').textContent = msg || '';
}
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  setBusy($('loginBtn'), true);
  const res = await api('POST', '/api/auth/login', { username: $('loginUser').value.trim(), password: $('loginPwd').value });
  setBusy($('loginBtn'), false);
  if (!res.ok) { $('loginErr').textContent = errText(res, '登录失败'); return; }
  if (res.json.user.role !== 'admin') { await api('POST', '/api/auth/logout', {}); $('loginErr').textContent = '该账号不是管理员，请使用教师端'; return; }
  $('loginPwd').value = '';
  enter(res.json.user);
};
$('logout').onclick = async () => { await api('POST', '/api/auth/logout', {}); gateOut(''); };
wireMenu($('whoBtn'), $('whoMenu'));

function enter(user) {
  me = user;
  if (me.mustChangePassword) { location.href = '/teacher.html'; return; }
  $('gate').hidden = true; $('app').hidden = false;
  $('whoami').textContent = me.displayName;
  $('avatar').textContent = initial(me.displayName);
  const head = $('whoHead'); head.innerHTML = ''; head.append(me.displayName, el('small', '', me.username + ' · 管理员'));
  const wanted = location.hash.slice(1);
  switchView(Object.values(GROUPS).flat().includes(wanted) ? wanted : view);
  if (view !== 'overview') refreshOverview();
}

/* ================= 导航：四个任务域 ================= */
const loaders = {
  overview: loadOverview, requests: loadRequests, classes: loadClasses, users: loadUsers, windows: loadWindows,
  schedules: loadSchedules, displays: loadDisplays, audit: loadAudit, settings: loadSettings,
};
const groupOf = (v) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(v));
function switchView(v) {
  view = v;
  const g = groupOf(v);
  lastInGroup[g] = v;
  markTabs($('groups'), g, 'group');
  for (const box of $('nav').querySelectorAll('.nav-group')) box.hidden = box.dataset.group !== g;
  for (const b of $('nav').querySelectorAll('button[data-view]')) {
    if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  for (const k of Object.keys(loaders)) $('view-' + k).hidden = k !== v;
  if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  loaders[v]();
}
wireTabs($('groups'), (g) => switchView(lastInGroup[g] || GROUPS[g][0]));
$('nav').onclick = (e) => { const b = e.target.closest('button[data-view]'); if (b) { switchView(b.dataset.view); $('main').focus({ preventScroll: true }); } };
// 页面已打开时点书签或手改地址栏的 #视图，不会重新加载页面，只触发 hashchange
window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (me && v !== view && groupOf(v)) switchView(v);
});

function renderWindowPill(cw) {
  if (!cw) return;
  $('windowPill').className = 'status ' + (cw.open ? 'ok' : 'warn');
  $('windowText').textContent = cw.open ? `全校可点人至 ${cw.current.end}` : (cw.next ? `上课中 · ${cw.next.date === cw.now.date ? '' : cw.next.weekdayName + ' '}${cw.next.start} 可点` : '今天没有可点人时段');
}
function renderFleet(d) {
  const total = d.displays.length;
  const online = total - d.offlineDisplays.length;
  const pill = $('fleetPill');
  pill.hidden = !total;
  pill.className = 'status ' + (online === total ? 'ok' : 'bad');
  pill.querySelector('svg').replaceWith(icon(online === total ? 'monitor' : 'monitorOff'));
  $('fleetText').textContent = online + ' / ' + total + ' 大屏在线';
}

/* ================= 概览：今天必须处理的事 ================= */
async function refreshOverview() {
  const res = await api('GET', '/api/admin/overview');
  if (!res.ok) return null;
  const d = res.json;
  ovData = d;
  renderWindowPill(d.callWindow);
  renderFleet(d);
  $('navRequests').textContent = d.pendingRequests.length || '';
  $('navSchedules').textContent = d.pausedSchedules.length || '';
  $('navDisplays').textContent = d.offlineDisplays.length || '';
  $('gToday').textContent = d.pendingRequests.length || '';
  $('gDispatch').textContent = (d.pausedSchedules.length + d.offlineDisplays.length) || '';
  return d;
}

async function loadOverview() {
  const now = new Date();
  $('ovDate').textContent = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAYS[now.getDay()]}`;
  if (!ovData) { fill($('todo'), skeleton(4)); fill($('ovDisplays'), skeleton(3)); }
  const d = await refreshOverview();
  if (!d) return fill($('todo'), errorState('概览加载失败', loadOverview));
  if (view !== 'overview') return;

  const todo = $('todo'); todo.innerHTML = '';
  const cw = d.callWindow;
  const windowIssue = !cw.open && !cw.next;
  const total = d.pendingRequests.length + d.pausedSchedules.length + d.offlineDisplays.length + (windowIssue ? 1 : 0);
  if (!total) {
    const ok = el('div', 'panel all-clear');
    ok.append(icon('check'), el('div', '', ''));
    ok.lastChild.append(el('strong', '', '今天没有需要处理的事'), el('span', '', '没有待审批的申请，所有大屏在线，定时任务都在正常运行。'));
    todo.append(ok);
  } else {
    const wrap = el('div', 'todo-grid');
    const group = (title, n, tone, iconName, rows, more) => {
      const p = el('section', 'panel todo-group');
      p.dataset.tone = tone;
      const h = el('div', 'panel-head');
      const h2 = el('h2'); h2.append(icon(iconName), title, el('span', 'count', String(n)));
      h.append(h2);
      if (more) h.append(btn(more.label, 'btn-ghost btn-sm', more.fn));
      const list = el('div', 'list');
      rows.forEach((r) => list.append(r));
      p.append(h, list);
      wrap.append(p);
    };
    if (d.pendingRequests.length) group('待审批申请', d.pendingRequests.length, 'warn', 'inbox', d.pendingRequests.slice(0, 5).map((r) => requestRow(r, loadOverview)), d.pendingRequests.length > 5 ? { label: '查看全部', fn: () => switchView('requests') } : null);
    if (d.offlineDisplays.length) {
      group('离线的大屏', d.offlineDisplays.length, 'bad', 'monitorOff', d.offlineDisplays.map((x) => itemRow('bad', stampFor(x.code, x.color, 'lead lg'), `${x.className} 大屏离线`, '没有任何浏览器大屏或原生程序连接到该班。检查教室电脑是否开机、联网，链接是否为 display.html?class=' + x.classId,
        [btn('复制大屏链接', 'btn-ghost btn-sm', () => copyDisplayLink(x.classId))])), { label: '查看设备', fn: () => switchView('displays') });
    }
    if (d.pausedSchedules.length) group('暂停的定时任务', d.pausedSchedules.length, 'bad', 'pause', d.pausedSchedules.map((s) => scheduleRow(s, loadOverview)), null);
    if (windowIssue) {
      group('作息异常', 1, 'warn', 'clock', [itemRow('warn', 'clock', '接下来一周没有任何可点人时段', '老师现在无法点人，定时提醒也不会执行。请检查全校作息的上课日与时段。', [btn('打开全校作息', 'btn-secondary btn-sm', () => switchView('windows'))])], null);
    }
    todo.append(wrap);
  }

  const ov = $('ovDisplays'); ov.innerHTML = '';
  if (!d.displays.length) ov.append(emptyState('还没有班级', '新建班级后，每个班的大屏状态会显示在这里。', { label: '新建班级', fn: () => { switchView('classes'); newClass(); } }));
  for (const x of d.displays) ov.append(dossierTile(x));
}

/** 各班信号：班级档案卡，带当前内容与信号轨道 */
function dossierTile(x) {
  const t = el('article', 'dossier');
  if (x.color) t.dataset.color = x.color;
  const head = el('header');
  const name = el('div', 'd-name');
  name.append(el('strong', '', x.className), el('small', '', x.displays ? '大屏在线' + (x.displays > 1 ? ' · ' + x.displays + ' 台' : '') : '大屏离线'));
  const st = el('span', 'status ' + (x.displays ? 'ok' : 'bad'));
  st.append(icon(x.displays ? 'monitor' : 'monitorOff'), x.displays ? '在线' : '离线');
  head.append(stampFor(x.code, x.color, 'lg'), name, st);
  t.append(head);
  const cur = x.current && x.current.type !== 'clear' ? x.current : null;
  const now = el('div', 'd-now');
  if (!cur) {
    now.append(el('p', 'd-idle', '待机'));
    now.append(signalTrack(-1, 'gold'));
  } else if (cur.type === 'call') {
    const acked = (cur.acks || []).length;
    const all = acked === cur.names.length;
    now.append(el('p', 'd-label', (cur.caller || '老师') + '正在找'));
    now.append(el('p', 'd-main', cur.names.join('、')));
    now.append(signalTrack(all ? 4 : 3, all ? 'ok' : 'gold'));
    now.append(el('p', 'd-meta', all ? '全部 ' + acked + ' 人已收到' : '已收到 ' + acked + ' / ' + cur.names.length));
  } else {
    const urgent = cur.priority === 1;
    now.append(el('p', 'd-label' + (urgent ? ' urgent' : ''), urgent ? '紧急通知' : '班级留言'));
    now.append(el('p', 'd-main', cur.title || ''));
    now.append(signalTrack(3, urgent ? 'alert' : 'gold'));
    now.append(el('p', 'd-meta', cur.author || ''));
  }
  t.append(now);
  const foot = el('footer');
  foot.append(el('span', '', cur && cur.queued ? '等待显示 ' + cur.queued + ' 条' : '没有等待内容'));
  foot.append(el('span', '', '教师端在线 ' + (x.teachers || 0)));
  t.append(foot);
  return t;
}

/* ================= 申请 ================= */
function requestRow(r, reload) {
  const who = `${r.user ? r.user.displayName : '（已删除的账号）'}${r.user && r.user.title ? '（' + r.user.title + '）' : ''}`;
  const meta = [dt(r.createdAt), r.user ? '登录名 ' + r.user.username : ''];
  if (r.reason) meta.push('说明：' + r.reason);
  if (r.status !== 'pending') meta.push(({ approved: '已批准', rejected: '已拒绝', cancelled: '已撤回' }[r.status]) + (r.decidedByName ? '（' + r.decidedByName + '）' : '') + (r.note ? '：' + r.note : ''));
  const acts = [];
  if (r.status === 'pending') {
    acts.push(btn('批准', 'btn-primary btn-sm', async () => {
      const x = await api('POST', `/api/admin/requests/${r.id}/approve`, {});
      if (!x.ok) return toast(errText(x, '操作失败'), true);
      reload(); refreshOverview();
      toast(`已批准 ${who} 管理 ${r.className}，立即生效`, { action: { label: '撤销', fn: async () => {
        const u = await api('POST', '/api/admin/memberships/revoke', { userId: r.userId, classId: r.classId });
        if (u.ok) { toast('已撤销这次批准'); reload(); } else toast(errText(u, '撤销失败'), true);
      } } });
    }, 'check'));
    acts.push(btn('拒绝…', 'btn-secondary btn-sm', async () => {
      const note = await promptDialog({ title: '拒绝 ' + who + ' 的申请', icon: 'x', text: '申请管理：' + r.className, label: '拒绝理由（会显示给教师，可留空）', maxLength: 200, confirm: '拒绝申请', danger: true });
      if (note === null) return;
      const x = await api('POST', `/api/admin/requests/${r.id}/reject`, { note: note.trim() });
      if (x.ok) { toast('已拒绝'); reload(); refreshOverview(); } else toast(errText(x, '操作失败'), true);
    }));
  }
  const tone = { pending: 'warn', approved: 'ok', rejected: 'bad' }[r.status] || '';
  return itemRow(tone, { pending: 'inbox', approved: 'check', rejected: 'x' }[r.status] || 'undo', `${who} 申请管理 ${r.className}`, meta.filter(Boolean).join(' · '), acts);
}
async function loadRequests() {
  const box = $('requests');
  fill(box, skeleton(4));
  const st = $('reqStatus').value;
  const res = await api('GET', '/api/admin/requests' + (st ? '?status=' + st : ''));
  if (!res.ok) return fill(box, errorState(errText(res, '申请加载失败'), loadRequests));
  box.innerHTML = '';
  if (!res.json.requests.length) box.append(emptyState(st === 'pending' ? '没有待审批的申请' : '没有符合条件的申请', st === 'pending' ? '教师在教师端提交申请后会出现在这里。' : ''));
  for (const r of res.json.requests) box.append(requestRow(r, loadRequests));
}
$('reqStatus').onchange = loadRequests;

/* ================= 班级 ================= */
function colorField(value) {
  const box = el('fieldset', 'plain-fieldset field');
  box.append(el('legend', 'label', '辅助色'));
  const row = el('div', 'swatches');
  for (const [c, label] of COLORS) {
    const l = el('label', 'swatch');
    const r = el('input'); r.type = 'radio'; r.name = 'color'; r.value = c; r.checked = c === (value || 'blue');
    const s = el('span', 'stamp', label); s.dataset.color = c;
    l.append(r, s);
    row.append(l);
  }
  box.append(row, el('small', '', '只用于编号章和浅色底，帮助区分班级。'));
  return box;
}
function field(label, input, hint) {
  const f = el('label', 'field');
  f.append(el('span', '', label), input);
  if (hint) f.append(el('small', '', hint));
  return f;
}
function input(type, name, attrs) {
  const i = el('input'); i.type = type; i.name = name;
  for (const [k, v] of Object.entries(attrs || {})) i[k] = v;
  return i;
}

function newClass() {
  const body = el('div');
  body.append(
    // pattern 按 v 标志编译：字符类里的连字符必须转义，否则整条规则失效
    field('班级标识', input('text', 'id', { required: true, pattern: '[a-z0-9][a-z0-9\\-]{0,31}', placeholder: 'class-23', autocapitalize: 'off', spellcheck: false }), '小写字母、数字、连字符。用于大屏链接，创建后不能修改。'),
    field('班级名称', input('text', 'name', { required: true, maxLength: 32, placeholder: '初三23班' })),
    field('短编号', input('text', 'code', { maxLength: 4, placeholder: '23' }), '不超过 4 个字，显示在编号章和大屏上。'),
    colorField('blue'),
    field('点人自动清屏（秒）', input('number', 'autoClearSeconds', { min: 0, max: 3600, value: 30 }), '0 表示常驻，直到老师手动清屏。'),
  );
  let created = '';
  const drawer = openDrawer({
    title: '新建班级', body, submit: '新建班级',
    onSubmit: async (f) => {
      const id = f.elements.id.value.trim();
      const res = await api('POST', '/api/admin/classes', {
        id, name: f.elements.name.value.trim(), code: f.elements.code.value.trim() || undefined, color: f.elements.color.value,
        autoClearSeconds: Number(f.elements.autoClearSeconds.value), students: [],
      });
      if (!res.ok) { toast(errText(res, '新增失败'), true); return false; }
      toast('已新建班级，请录入名单');
      created = id;
      return true;
    },
  });
  // 抽屉关闭时浏览器会把焦点还给「新建班级」按钮，所以等它关掉再展开新班级的名单框并聚焦
  drawer.addEventListener('close', () => { if (created) loadClasses(created); });
}
$('newClass').onclick = newClass;

async function loadClasses(focusId) {
  const box = $('classList');
  if (!box.children.length) fill(box, skeleton(6));
  const res = await api('GET', '/api/admin/classes');
  if (!res.ok) return fill(box, errorState(errText(res, '班级列表加载失败'), () => loadClasses()));
  classesCache = res.json.classes;
  box.innerHTML = '';
  if (!classesCache.length) box.append(emptyState('还没有班级', '新建第一个班级，录入名单，再把大屏链接配置到教室电脑上。', { label: '新建班级', fn: newClass }, true));
  for (const c of classesCache) box.append(classCard(c));
  if (typeof focusId === 'string') {
    // 新班级排在列表末尾，可能被上面的班级挤出视口：直接展开它的名单框并聚焦
    const card = box.querySelector(`[data-class-id="${focusId}"]`);
    if (card) {
      card.querySelector('.roster-toggle').click();
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const ta = card.querySelector('textarea'); if (ta) ta.focus({ preventScroll: true });
    }
  }
}

function classCard(c) {
  const students = Array.isArray(c.students) ? c.students : [];
  const teachers = Array.isArray(c.teachers) ? c.teachers : [];
  const archived = c.status === 'archived';
  const card = el('section', 'panel class-card' + (archived ? ' archived' : ''));
  card.dataset.classId = c.id;
  if (c.color) card.dataset.color = c.color;
  const head = el('div', 'cc-head');
  const title = el('div', 'cc-title');
  const h = el('h2', '', c.name);
  if (archived) h.append(el('span', 'tag', '已归档'));
  title.append(h, el('small', 'num', c.id));
  const acts = el('div', 'row');
  acts.append(btn('编辑信息', 'btn-ghost btn-sm', () => editClass(c), 'edit'));
  acts.append(btn(archived ? '恢复' : '归档…', archived ? 'btn-secondary btn-sm' : 'btn-ghost danger btn-sm', async () => {
    if (!archived) {
      const ok = await confirmDialog({
        title: '归档 ' + c.name + '？', confirm: '归档班级', danger: true,
        impact: ['该班大屏连接会被关闭，大屏显示「班级绑定错误」', '教师将无法再操作该班（授权记录保留）', '该班的定时任务会暂停', '随时可以恢复'],
      });
      if (!ok) return;
    }
    const x = await api('PATCH', `/api/admin/classes/${c.id}`, { status: archived ? 'active' : 'archived' });
    if (!x.ok) return toast(errText(x, '操作失败'), true);
    loadClasses();
    if (archived) toast('已恢复 ' + c.name);
    else toast('已归档 ' + c.name, { action: { label: '撤销', fn: async () => { const u = await api('PATCH', `/api/admin/classes/${c.id}`, { status: 'active' }); if (u.ok) { toast('已恢复'); loadClasses(); } else toast(errText(u, '恢复失败'), true); } } });
  }));
  head.append(stampFor(c.code, c.color, 'lg'), title, acts);
  card.append(head);

  const facts = el('dl', 'facts');
  const fact = (k, v) => { const d = el('div'); d.append(el('dt', '', k), el('dd', '', v)); facts.append(d); };
  fact('学生', students.length + ' 名');
  fact('大屏', c.displays ? '在线 ' + c.displays + ' 台' : '离线');
  fact('自动清屏', c.autoClearSeconds ? c.autoClearSeconds + ' 秒' : '常驻');
  fact('授权教师', teachers.map((t) => t.displayName).join('、') || '尚无');
  card.append(facts);

  const toggle = btn(students.length ? '编辑名单' : '录入名单', 'btn-secondary btn-sm roster-toggle', null, 'users');
  toggle.setAttribute('aria-expanded', 'false');
  const roster = el('div', 'roster');
  roster.hidden = true;
  roster.id = 'roster-' + c.id;
  toggle.setAttribute('aria-controls', roster.id);
  toggle.onclick = () => {
    roster.hidden = !roster.hidden;
    toggle.setAttribute('aria-expanded', String(!roster.hidden));
    if (!roster.hidden) roster.querySelector('textarea').focus();
  };
  const lab = el('label', 'field');
  lab.append(el('span', '', c.name + ' 名单'));
  const ta = el('textarea'); ta.value = students.join('\n');
  ta.placeholder = '每行一个姓名；也可以直接粘贴用逗号、顿号或空格分隔的名单';
  ta.rows = 8;
  lab.append(ta);
  const row = el('div', 'row end');
  const count = el('span', 'muted', '');
  const save = btn('保存名单', 'btn-primary btn-sm', null);
  const recount = () => {
    const next = parseNames(ta.value);
    const removed = students.filter((n) => !next.includes(n)).length;
    const added = next.filter((n) => !students.includes(n)).length;
    count.textContent = next.length + ' 人' + (added || removed ? `（新增 ${added}，移除 ${removed}）` : '');
  };
  ta.oninput = recount; recount();
  save.onclick = async () => {
    const next = parseNames(ta.value);
    const removed = students.filter((n) => !next.includes(n));
    if (removed.length) {
      const ok = await confirmDialog({
        title: `保存 ${c.name} 名单`, confirm: '保存名单', danger: !next.length,
        text: next.length ? '' : '名单将被清空。',
        impact: [`将移除 ${removed.length} 人：${removed.slice(0, 8).join('、')}${removed.length > 8 ? ' 等' : ''}`, '包含这些学生的定时任务会自动暂停'],
      });
      if (!ok) return;
    }
    setBusy(save, true);
    const x = await api('PUT', `/api/admin/classes/${c.id}/students`, { students: next });
    setBusy(save, false);
    if (!x.ok) return toast(errText(x, '保存失败'), true);
    toast(`名单已保存（${x.json.students.length} 人）` + (x.json.pausedSchedules ? `，${x.json.pausedSchedules} 个定时任务因学生变动暂停` : ''));
    loadClasses();
  };
  row.append(count, save);
  roster.append(lab, row);
  const rowT = el('div', 'row');
  rowT.append(toggle, btn('复制大屏链接', 'btn-ghost btn-sm', () => copyDisplayLink(c.id), 'monitor'));
  card.append(rowT, roster);
  return card;
}
function parseNames(text) { return text.split(/[\n,，、;；\s]+/).map((s) => s.trim()).filter(Boolean); }

function copyDisplayLink(id) {
  const url = location.origin + '/display.html?class=' + encodeURIComponent(id);
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('已复制：' + url), () => toast(url));
  else toast(url);
}

function editClass(c) {
  const body = el('div');
  const mode = el('select'); mode.name = 'mode';
  mode.innerHTML = '<option value="off">关闭</option><option value="protocol">浏览器协议唤起（protocol）</option><option value="native">原生监听程序（native）</option>';
  body.append(
    field('名称', input('text', 'name', { maxLength: 32, required: true, value: c.name })),
    field('短编号', input('text', 'code', { maxLength: 4, value: c.code })),
    colorField(c.color),
    field('点人自动清屏（秒）', input('number', 'autoClearSeconds', { min: 0, max: 3600, value: c.autoClearSeconds }), '0 表示常驻。'),
    field('本地程序启动器', mode, '点人时在教室电脑上启动本地程序；不需要就保持关闭。'),
  );
  mode.value = c.launcher.mode;
  openDrawer({
    title: '编辑 ' + c.name, body,
    onSubmit: async (f) => {
      const x = await api('PATCH', `/api/admin/classes/${c.id}`, { name: f.elements.name.value.trim(), code: f.elements.code.value.trim(), color: f.elements.color.value, autoClearSeconds: Number(f.elements.autoClearSeconds.value), launcher: { mode: f.elements.mode.value, freshSeconds: c.launcher.freshSeconds } });
      if (!x.ok) { toast(errText(x, '保存失败'), true); return false; }
      toast('已保存'); loadClasses();
      return true;
    },
  });
}

/* ================= 教师与权限 ================= */
function newUser() {
  const body = el('div');
  const role = el('select'); role.name = 'role';
  role.innerHTML = '<option value="teacher">教师</option><option value="admin">管理员</option>';
  body.append(
    field('登录名', input('text', 'username', { required: true, autocapitalize: 'off', spellcheck: false })),
    field('姓名', input('text', 'displayName', { required: true, maxLength: 20 })),
    field('职务（可选）', input('text', 'title', { maxLength: 12, placeholder: '例：数学老师' })),
    field('初始密码', input('text', 'password', { required: true, minLength: 8, autocomplete: 'off' }), '至少 8 位。本人首次登录时必须修改。'),
    field('角色', role, '管理员可以管理全校所有班级。'),
  );
  openDrawer({
    title: '创建账号', body, submit: '创建账号',
    onSubmit: async (f) => {
      const e = f.elements;
      const res = await api('POST', '/api/admin/users', { username: e.username.value.trim(), displayName: e.displayName.value.trim(), title: e.title.value.trim(), password: e.password.value, role: e.role.value });
      if (!res.ok) { toast(errText(res, '创建失败'), true); return false; }
      toast('已创建账号，请把初始密码告知本人；首次登录必须修改');
      loadUsers();
      return true;
    },
  });
}
$('newUser').onclick = newUser;
$('userFilter').oninput = renderUsers;

let schedulesCache = [];
async function loadUsers() {
  const tb = $('userTable').querySelector('tbody');
  if (!usersCache.length) { tb.innerHTML = ''; const tr = el('tr'); const td = el('td'); td.colSpan = 7; td.dataset.label = ''; td.append(skeleton(6)); tr.append(td); tb.append(tr); }
  const [u, c, s] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/classes'), api('GET', '/api/admin/schedules')]);
  if (!u.ok) { tb.innerHTML = ''; const tr = el('tr'); const td = el('td'); td.colSpan = 7; td.dataset.label = ''; td.append(errorState(errText(u, '账号列表加载失败'), loadUsers)); tr.append(td); tb.append(tr); return; }
  usersCache = u.json.users;
  if (c.ok) classesCache = c.json.classes;
  if (s.ok) schedulesCache = s.json.schedules;
  renderUsers();
}
const activeSchedulesOf = (userId, classId) => schedulesCache.filter((s) => s.createdBy === userId && s.enabled && s.status === 'active' && (!classId || s.classId === classId));

function td(label, ...nodes) { const x = el('td'); x.dataset.label = label; x.append(...nodes); return x; }

function renderUsers() {
  const q = $('userFilter').value.trim().toLowerCase();
  const tb = $('userTable').querySelector('tbody'); tb.innerHTML = '';
  let shown = 0;
  for (const u of usersCache) {
    if (q && !u.displayName.toLowerCase().includes(q) && !u.username.includes(q)) continue;
    shown += 1;
    const tr = el('tr');
    const name = el('div');
    name.append(el('strong', '', u.displayName));
    if (u.title) name.append(el('small', '', u.title));
    const st = el('div', 'row');
    const s = el('span', 'status ' + (u.status === 'active' ? 'ok' : 'bad'));
    s.append(icon(u.status === 'active' ? 'check' : 'pause'), u.status === 'active' ? '启用' : '停用');
    st.append(s);
    if (u.mustChangePassword) st.append(el('span', 'tag', '待改密码'));
    tr.append(td('姓名', name), td('登录名', el('span', 'num', u.username)), td('角色', u.role === 'admin' ? '管理员' : '教师'), td('状态', st));

    const cls = el('div', 'grants');
    for (const m of u.classes) {
      const chip = el('span', 'grant');
      const c = classesCache.find((x) => x.id === m.classId);
      chip.append(stampFor(c ? c.code : '', c ? c.color : ''), el('span', '', m.className));
      if (u.role !== 'admin') {
        const x = el('button', 'grant-x'); x.type = 'button'; x.setAttribute('aria-label', '撤销 ' + u.displayName + ' 对 ' + m.className + ' 的权限');
        x.append(icon('x'));
        x.onclick = () => revokeAccess(u, m);
        chip.append(x);
      }
      cls.append(chip);
    }
    if (u.role === 'admin') cls.append(el('span', 'muted', '全部班级'));
    else cls.append(btn('授权班级…', 'btn-ghost btn-sm', () => grantAccess(u), 'plus'));
    tr.append(td('已授权班级', cls), td('最近登录', el('span', 'num', dt(u.lastLoginAt))));

    const acts = el('div', 'row');
    acts.append(btn('编辑', 'btn-ghost btn-sm', () => editUser(u)));
    acts.append(btn(u.status === 'active' ? '停用…' : '启用', u.status === 'active' ? 'btn-ghost danger btn-sm' : 'btn-ghost btn-sm', () => toggleUser(u)));
    acts.append(btn('重置密码…', 'btn-ghost btn-sm', () => resetPassword(u)));
    const del = btn('删除…', 'btn-ghost danger btn-sm', () => deleteUser(u));
    del.disabled = u.id === me.id; if (del.disabled) del.title = '不能删除当前登录的账号';
    acts.append(del);
    tr.append(td('', acts));
    tb.append(tr);
  }
  $('userCount').textContent = usersCache.length ? (q ? `匹配 ${shown} / ${usersCache.length} 个账号` : `共 ${usersCache.length} 个账号`) : '';
  if (!shown) { const tr = el('tr'); const x = el('td'); x.colSpan = 7; x.dataset.label = ''; x.append(emptyState(q ? '没有匹配的账号' : '还没有账号', q ? '换个关键词试试。' : '')); tr.append(x); tb.append(tr); }
}

async function grantAccess(u) {
  const options = classesCache.filter((c) => c.status === 'active' && !u.classes.some((m) => m.classId === c.id));
  if (!options.length) return toast(u.displayName + ' 已拥有全部班级的权限');
  const sel = el('select');
  for (const c of options) { const o = el('option', '', `${c.name}（${c.code}）`); o.value = c.id; sel.append(o); }
  const f = field('班级', sel);
  const ok = await confirmDialog({
    title: '为 ' + u.displayName + ' 授权班级', icon: 'shield', confirm: '确认授权', node: f,
    impact: ['授权立即生效：可以对该班点人、发班级留言、创建定时提醒', '该教师对这个班的待审批申请会一并标记为已批准', '随时可以在这里撤销'],
  });
  if (!ok) return;
  const cid = sel.value;
  const r = await api('POST', '/api/admin/memberships', { userId: u.id, classId: cid });
  if (!r.ok) return toast(errText(r, '授权失败'), true);
  toast('已授权 ' + u.displayName + ' 管理 ' + classNameOf(cid));
  loadUsers();
}

async function revokeAccess(u, m) {
  const affected = activeSchedulesOf(u.id, m.classId).length;
  const ok = await confirmDialog({
    title: `撤销 ${u.displayName} 对 ${m.className} 的权限？`, danger: true, confirm: '撤销权限',
    impact: ['立即生效，该教师不能再操作这个班', affected ? `其在该班创建的 ${affected} 个定时任务会自动暂停` : '该教师在这个班没有运行中的定时任务', '可以在提示条里撤销，重新授权后暂停的任务会恢复'],
  });
  if (!ok) return;
  const r = await api('POST', '/api/admin/memberships/revoke', { userId: u.id, classId: m.classId });
  if (!r.ok) return toast(errText(r, '撤销失败'), true);
  loadUsers();
  toast('已撤销' + (r.json.pausedSchedules ? `，${r.json.pausedSchedules} 个定时任务已暂停` : ''), { action: { label: '撤销', fn: async () => {
    const g = await api('POST', '/api/admin/memberships', { userId: u.id, classId: m.classId });
    if (g.ok) { toast('已恢复授权'); loadUsers(); } else toast(errText(g, '恢复失败'), true);
  } } });
}

async function toggleUser(u) {
  const disabling = u.status === 'active';
  if (disabling) {
    const n = activeSchedulesOf(u.id).length;
    const ok = await confirmDialog({
      title: '停用 ' + u.displayName + '？', danger: true, confirm: '停用账号',
      impact: [
        '立即退出所有设备上的登录，之后无法再登录',
        u.role === 'admin' ? '失去管理端权限' : (u.classes.length ? `不能再操作 ${u.classes.map((m) => m.className).join('、')}（授权记录保留）` : '目前没有授权班级'),
        n ? `其创建的 ${n} 个定时任务会自动暂停` : '没有运行中的定时任务',
        '可以随时重新启用',
      ],
    });
    if (!ok) return;
  }
  const r = await api('PATCH', `/api/admin/users/${u.id}`, { status: disabling ? 'disabled' : 'active' });
  if (!r.ok) return toast(errText(r, '操作失败'), true);
  loadUsers();
  if (disabling) {
    toast('已停用 ' + u.displayName, { action: { label: '撤销', fn: async () => {
      const x = await api('PATCH', `/api/admin/users/${u.id}`, { status: 'active' });
      if (x.ok) { toast('已重新启用'); loadUsers(); } else toast(errText(x, '启用失败'), true);
    } } });
  } else toast('已启用 ' + u.displayName);
}

async function resetPassword(u) {
  const ok = await confirmDialog({
    title: '重置 ' + u.displayName + ' 的密码？', icon: 'key', confirm: '生成临时密码',
    impact: ['旧密码立即失效，所有设备退出登录', '会生成一个只显示一次的临时密码', '本人用临时密码登录后必须改成自己的密码'],
  });
  if (!ok) return;
  const r = await api('PATCH', `/api/admin/users/${u.id}`, { resetPassword: true });
  if (!r.ok) return toast(errText(r, '重置失败'), true);
  const code = el('pre', 'temp-pwd', r.json.tempPassword);
  const copy = await confirmDialog({
    title: '已重置 ' + u.displayName + ' 的密码', icon: 'key', text: '临时密码只显示这一次，请当面或通过可信渠道告知本人：',
    node: code, confirm: '复制并关闭', cancel: '关闭',
  });
  if (copy && navigator.clipboard) navigator.clipboard.writeText(r.json.tempPassword).then(() => toast('临时密码已复制'), () => {});
  loadUsers();
}

async function deleteUser(u) {
  const n = schedulesCache.filter((s) => s.createdBy === u.id).length;
  const ok = await confirmDialog({
    title: `删除账号 ${u.displayName}（${u.username}）？`, danger: true, confirm: '永久删除账号',
    impact: [
      u.classes.length ? `移除 ${u.classes.length} 个班级授权：${u.classes.map((m) => m.className).join('、')}` : '没有班级授权',
      n ? `一并删除其创建的 ${n} 个定时任务` : '没有定时任务',
      '其申请记录一并移除；已发出的通知记录保留',
      '此操作不可恢复。只想临时禁止登录，请用「停用」',
    ],
  });
  if (!ok) return;
  const r = await api('DELETE', `/api/admin/users/${u.id}`);
  if (!r.ok) return toast(errText(r, '删除失败'), true);
  toast('已删除账号' + (r.json.removedSchedules ? `，同时移除了 ${r.json.removedSchedules} 个定时任务` : '')); loadUsers();
}

function editUser(u) {
  const body = el('div');
  body.append(
    field('姓名', input('text', 'displayName', { maxLength: 20, required: true, value: u.displayName })),
    field('职务', input('text', 'title', { maxLength: 12, value: u.title || '' }), '显示在大屏上，例：「数学老师 · 张老师正在找」。'),
  );
  openDrawer({
    title: '编辑 ' + u.username, body,
    onSubmit: async (f) => {
      const r = await api('PATCH', `/api/admin/users/${u.id}`, { displayName: f.elements.displayName.value.trim(), title: f.elements.title.value.trim() });
      if (!r.ok) { toast(errText(r, '保存失败'), true); return false; }
      toast('已保存'); loadUsers();
      return true;
    },
  });
}

/* ================= 作息 ================= */
async function loadWindows() {
  const res = await api('GET', '/api/admin/call-windows');
  if (!res.ok) { const tb = $('wTable').querySelector('tbody'); tb.innerHTML = ''; const tr = el('tr'); const x = el('td'); x.colSpan = 4; x.dataset.label = ''; x.append(errorState(errText(res, '作息加载失败'), loadWindows)); tr.append(x); tb.append(tr); return; }
  windowsDraft = JSON.parse(JSON.stringify(res.json.callWindows));
  renderWindowPill(res.json.status);
  renderWindows();
}
function renderWindows() {
  $('tzLabel').textContent = windowsDraft.timezone;
  for (const i of $('wDays').querySelectorAll('input')) i.checked = windowsDraft.weekdays.includes(Number(i.value));
  const tb = $('wTable').querySelector('tbody'); tb.innerHTML = '';
  if (!windowsDraft.windows.length) { const tr = el('tr'); const x = el('td'); x.colSpan = 4; x.dataset.label = ''; x.append(emptyState('没有任何时段', '没有时段时老师全天都不能点人。点「添加时段」或「恢复默认作息」。')); tr.append(x); tb.append(tr); }
  windowsDraft.windows.forEach((w, idx) => {
    const tr = el('tr');
    const s = el('input'); s.type = 'time'; s.value = w.start; s.step = 60; s.setAttribute('aria-label', '第 ' + (idx + 1) + ' 个时段开始'); s.onchange = () => { w.start = s.value; };
    const e = el('input'); e.type = 'time'; e.value = w.end; e.step = 60; e.setAttribute('aria-label', '第 ' + (idx + 1) + ' 个时段结束'); e.onchange = () => { w.end = e.value; };
    const l = el('input'); l.type = 'text'; l.value = w.label || ''; l.maxLength = 30; l.placeholder = '课间'; l.setAttribute('aria-label', '第 ' + (idx + 1) + ' 个时段说明'); l.oninput = () => { w.label = l.value; };
    const d = btn('删除', 'btn-ghost danger btn-sm', () => { windowsDraft.windows.splice(idx, 1); renderWindows(); }, 'trash');
    tr.append(td('开始', s), td('结束', e), td('说明', l), td('', d));
    tb.append(tr);
  });
}
$('wAdd').onclick = () => { windowsDraft.windows.push({ start: '12:00', end: '12:10', label: '' }); renderWindows(); };
$('wDefault').onclick = () => {
  windowsDraft.weekdays = [1, 2, 3, 4, 5];
  windowsDraft.windows = [['08:45', '09:00', '课间'], ['09:45', '10:15', '课间'], ['11:00', '11:15', '课间'], ['11:35', '12:30', '午餐、过渡时间、午自习'], ['13:00', '13:10', '午休结束后的课间'], ['13:55', '14:15', '课间'], ['15:00', '15:15', '课间'], ['16:00', '16:15', '课间']].map(([start, end, label]) => ({ start, end, label }));
  renderWindows();
  toast('已填入默认作息，点「保存作息」后生效');
};
$('wSave').onclick = async () => {
  windowsDraft.weekdays = [...$('wDays').querySelectorAll('input:checked')].map((i) => Number(i.value));
  const ok = await confirmDialog({
    title: '保存全校作息？', icon: 'clock', confirm: '保存并生效',
    impact: [
      '立即对全校所有班级生效',
      `上课日：${windowsDraft.weekdays.length ? windowsDraft.weekdays.map((d) => WEEKDAYS[d]).join('、') : '无'}；共 ${windowsDraft.windows.length} 个可点人时段`,
      '时间不在新时段内的定时任务会自动暂停，保存后会告诉你暂停了几个',
    ],
  });
  if (!ok) return;
  setBusy($('wSave'), true);
  const res = await api('PUT', '/api/admin/call-windows', windowsDraft);
  setBusy($('wSave'), false);
  if (!res.ok) return toast(errText(res, '保存失败'), true);
  toast('作息已保存并生效' + (res.json.pausedSchedules ? `；${res.json.pausedSchedules} 个定时任务因不符合新作息已暂停` : ''));
  loadWindows();
  refreshOverview();
};

/* ================= 定时任务 ================= */
function scheduleRow(s, reload) {
  const paused = s.status === 'paused';
  const tone = !s.enabled ? '' : (paused ? 'bad' : 'ok');
  const t = el('strong');
  t.append(el('span', 'num', s.time + '　'), `${s.className || classNameOf(s.classId)} · ${s.names.join('、')}`);
  const meta = [s.weekdayNames.join('、'), s.message || '无附加说明', '创建：' + s.createdByName];
  if (!s.enabled) meta.push('已停用'); else if (paused) meta.push('已暂停：' + (PAUSE_REASONS[s.pauseReason] || s.pauseReason)); else if (s.nextRunAt) meta.push('下次 ' + dt(s.nextRunAt));
  if (s.lastResult) meta.push('最近：' + ({ sent: '已发送', missed: '已错过', skipped: '已跳过', failed: '失败' }[s.lastResult.status] || s.lastResult.status));
  const running = s.enabled && !paused;
  const tog = btn(paused ? '恢复' : (s.enabled ? '停用' : '启用'), 'btn-ghost btn-sm', async () => {
    const r = await api('PATCH', `/api/admin/schedules/${s.id}`, { enabled: paused ? true : !s.enabled });
    if (!r.ok) return toast(errText(r, r.json && r.json.error === 'SCHEDULE_OUT_OF_WINDOW' ? '该时间不在允许点人的时段' : '操作失败'), true);
    reload(); refreshOverview();
    if (running) toast('已停用', { action: { label: '撤销', fn: async () => { const u = await api('PATCH', `/api/admin/schedules/${s.id}`, { enabled: true }); if (u.ok) { toast('已恢复'); reload(); } else toast(errText(u, '恢复失败'), true); } } });
    else toast('已恢复');
  });
  const del = btn('删除…', 'btn-ghost danger btn-sm', async () => {
    const ok = await confirmDialog({ title: '删除这条定时任务？', danger: true, confirm: '删除任务', impact: [`${s.className || s.classId} 每天 ${s.time} 不再自动点 ${s.names.join('、')}`, '创建者：' + s.createdByName, '删除后不能恢复；只想临时停止请用「停用」'] });
    if (!ok) return;
    const r = await api('DELETE', `/api/admin/schedules/${s.id}`);
    if (r.ok) { toast('已删除'); reload(); refreshOverview(); } else toast(errText(r, '删除失败'), true);
  });
  return itemRow(tone, !s.enabled ? 'pause' : (paused ? 'alert' : 'clock'), t, meta.join(' · '), [tog, del]);
}
async function loadSchedules() {
  const box = $('schedules');
  fill(box, skeleton(5));
  const res = await api('GET', '/api/admin/schedules');
  if (!res.ok) return fill(box, errorState(errText(res, '定时任务加载失败'), loadSchedules));
  box.innerHTML = '';
  const list = res.json.schedules.slice().sort((a, b) => (a.status === 'paused' ? 0 : 1) - (b.status === 'paused' ? 0 : 1) || a.time.localeCompare(b.time));
  if (!list.length) box.append(emptyState('没有定时任务', '教师可以在教师端「定时提醒」里为本班创建。'));
  for (const s of list) box.append(scheduleRow(s, loadSchedules));
}

/* ================= 大屏 ================= */
function currentText(cur) {
  if (!cur || cur.type === 'clear') return '待机';
  if (cur.type === 'call') return `${cur.caller}正在找：${cur.names.join('、')} · 已收到 ${cur.acks.length}/${cur.names.length}`;
  return (cur.priority === 1 ? '紧急通知' : '留言') + `「${cur.title}」（${cur.author}）`;
}
function displayRow(x, reload) {
  const cur = x.current && x.current.type !== 'clear' ? x.current : null;
  const t = el('strong');
  t.append(x.className + ' ');
  const st = el('span', 'status ' + (x.displays ? 'ok' : 'bad'));
  st.append(icon(x.displays ? 'monitor' : 'monitorOff'), x.displays ? '大屏在线 ' + x.displays : '大屏离线');
  t.append(st);
  const meta = [currentText(cur)];
  if (cur && cur.queued) meta.push('等待 ' + cur.queued + ' 条');
  if (x.launchers) meta.push('启动器 ' + x.launchers);
  if (x.teachers) meta.push('教师端 ' + x.teachers);
  const clr = btn('清空…', 'btn-ghost danger btn-sm', async () => {
    const q = cur ? cur.queued || 0 : 0;
    const choice = await choiceDialog({
      title: '清空 ' + x.className + ' 大屏', icon: 'monitor', text: cur ? '正在显示：' + currentText(cur) : '大屏当前空闲。',
      choices: [
        { value: 'current', label: '只清除当前内容', desc: q ? '等待中的 ' + q + ' 条会接着显示' : '大屏回到待机', disabled: !cur },
        { value: 'all', label: '清除当前内容和等待队列', desc: q ? '当前内容和等待中的 ' + q + ' 条都会移除，不能恢复' : '没有等待中的内容', danger: true, disabled: !q },
      ],
    });
    if (!choice) return;
    const r = await api('POST', `/api/admin/classes/${x.classId}/display/clear`, { all: choice === 'all' });
    if (r.ok) { toast(choice === 'all' ? '已清空大屏和队列' : '已清除当前内容'); reload(); } else toast(errText(r, '清空失败'), true);
  });
  clr.disabled = !cur;
  return itemRow(x.displays ? 'ok' : 'bad', stampFor(x.code, x.color, 'lead lg'), t, meta.join(' · '), [btn('复制链接', 'btn-ghost btn-sm', () => copyDisplayLink(x.classId)), clr]);
}
async function loadDisplays() {
  const box = $('displays');
  if (!box.children.length) fill(box, skeleton(5));
  const d = await refreshOverview();
  if (!d) return fill(box, errorState('大屏状态加载失败', loadDisplays));
  box.innerHTML = '';
  if (!d.displays.length) box.append(emptyState('还没有班级', '新建班级后，把「复制大屏链接」得到的地址配置到教室电脑上。'));
  for (const x of d.displays) box.append(displayRow(x, loadDisplays));
  const cur = $('ugClass').value;
  $('ugClass').innerHTML = '';
  for (const x of d.displays) { const o = el('option', '', `${x.className}（${x.code}）`); o.value = x.classId; $('ugClass').append(o); }
  if (cur) $('ugClass').value = cur;
}
$('urgentForm').onsubmit = async (e) => {
  e.preventDefault();
  const cid = $('ugClass').value;
  if (!cid) return toast('请先选择班级', true);
  const x = (ovData ? ovData.displays : []).find((y) => y.classId === cid) || { className: cid, displays: 0 };
  const cur = x.current && x.current.type !== 'clear' ? x.current : null;
  const dur = $('ugDuration');
  const ok = await confirmDialog({
    title: '向 ' + x.className + ' 发送紧急广播？', danger: true, confirm: '立即抢占大屏',
    impact: [
      '立即抢占 ' + x.className + ' 大屏' + (x.displays ? '' : '（注意：该班大屏当前离线）'),
      cur ? '正在显示的' + currentText(cur) + ' 会被挤到等待队列，广播结束后回来' : '大屏当前空闲',
      '大屏顶部显示红色信号条和「紧急通知」；' + dur.options[dur.selectedIndex].textContent + '自动下屏',
    ],
  });
  if (!ok) return;
  setBusy($('ugSend'), true);
  const res = await api('POST', `/api/classes/${cid}/announcements`, { title: $('ugTitle').value.trim(), body: $('ugBody').value.trim(), durationSeconds: Number(dur.value), urgent: true });
  setBusy($('ugSend'), false);
  if (!res.ok) return toast(errText(res, '发送失败'), true);
  toast('紧急广播已发送到 ' + x.className); $('ugTitle').value = ''; $('ugBody').value = ''; loadDisplays();
};

/* ================= 审计：翻译成人话 ================= */
function describeAudit(a) {
  const d = a.detail || {};
  const cls = () => classNameOf(a.target);
  const usr = (id) => userNameOf(id);
  const plus = (n, text) => (n ? '，' + n + ' ' + text : '');
  switch (a.action) {
    case 'access.approve': return `批准 ${usr(d.userId)} 管理 ${cls()}`;
    case 'access.reject': return `拒绝 ${usr(d.userId)} 管理 ${cls()} 的申请${d.note ? '，理由：' + d.note : ''}`;
    case 'access.grant': return `授权 ${usr(d.userId)} 管理 ${cls()}`;
    case 'access.revoke': return `撤销 ${usr(d.userId)} 对 ${cls()} 的权限${plus(d.pausedSchedules, '个定时任务暂停')}`;
    case 'access.request': return `申请管理 ${cls()}`;
    case 'access.cancel': return `撤回管理 ${cls()} 的申请`;
    case 'user.register': return `注册教师账号 ${d.username || ''}`;
    case 'user.create': return `创建教师账号 ${d.username || ''}`;
    case 'user.create_admin': return `创建管理员账号 ${d.username || ''}`;
    case 'user.bootstrap_admin': return `初始化管理员 ${d.username || ''}`;
    case 'user.password_change': return '修改了自己的密码';
    case 'user.delete': return `删除账号 ${d.username || ''}${plus(d.removedSchedules, '个定时任务一并删除')}`;
    case 'user.update': {
      const parts = [];
      if (d.displayName) parts.push('姓名');
      if (d.title) parts.push('职务');
      if (d.status) parts.push(d.status === 'active' ? '启用账号' : '停用账号');
      if (d.resetPassword) parts.push('重置密码');
      return `修改 ${usr(a.target)}：${parts.join('、') || '资料'}`;
    }
    case 'class.create': return `新增班级 ${d.name || a.target}`;
    case 'class.update': {
      const map = { name: '名称', code: '编号', color: '辅助色', autoClearSeconds: '自动清屏', launcher: '启动器', status: '状态' };
      return `修改 ${cls()} 的${(d.fields || []).map((f) => map[f] || f).join('、') || '信息'}`;
    }
    case 'class.students': {
      const n = (v) => (Array.isArray(v) ? v.length : v || 0);
      return `修改 ${cls()} 名单：共 ${d.count} 人（新增 ${n(d.added)}，移除 ${n(d.removed)}）`;
    }
    case 'class.import_legacy': return `导入旧版名单 ${d.count || 0} 个班`;
    case 'call_windows.update': return `修改全校作息：${d.windows} 个时段${plus(d.pausedSchedules, '个定时任务暂停')}`;
    case 'schedule.create': return `在 ${cls()} 创建定时提醒 ${d.time || ''} ${(d.names || []).join('、')}`;
    case 'schedule.update': return `修改 ${cls()} 的定时提醒`;
    case 'schedule.delete': return `删除 ${cls()} 的定时提醒`;
    case 'schedule.auto_pause': return `${cls()} 的定时提醒自动暂停：${PAUSE_REASONS[d.reason] || d.reason || ''}`;
    case 'notice.call': return `在 ${cls()} ${d.source === 'schedule' ? '定时点人' : '点人'}：${(d.names || []).join('、')}`;
    case 'notice.announce': return `在 ${cls()} 发布留言「${d.title || ''}」`;
    case 'notice.urgent': return `向 ${cls()} 发送紧急广播「${d.title || ''}」`;
    case 'notice.withdraw': return `撤回 ${cls()} 的一条通知`;
    case 'notice.resend': return `再次发送 ${cls()} 的一条通知`;
    case 'display.clear': return `清除 ${cls()} 大屏当前内容`;
    case 'display.clear_all': return `清空 ${cls()} 大屏和等待队列`;
    case 'settings.update': return d.announcementPolicy ? '留言显示策略改为「' + (d.announcementPolicy === 'next_window' ? '上课期间推迟到下一课间' : '立即显示') + '」' : '修改系统设置';
    case 'session.revoke_all': return `强制全员重新登录（${d.count || 0} 个会话）`;
    default: return ACTIONS[a.action] || a.action;
  }
}
async function loadAudit() {
  const tb = $('auditTable').querySelector('tbody');
  const placeholder = (node) => { tb.innerHTML = ''; const tr = el('tr'); const x = el('td'); x.colSpan = 4; x.dataset.label = ''; x.append(node); tr.append(x); tb.append(tr); };
  placeholder(skeleton(8));
  const q = $('auditFilter').value;
  const needNames = !usersCache.length || !classesCache.length;
  const [res, u, c] = await Promise.all([
    api('GET', '/api/admin/audit?limit=300' + (q ? '&action=' + encodeURIComponent(q) : '')),
    needNames ? api('GET', '/api/admin/users') : null,
    needNames ? api('GET', '/api/admin/classes') : null,
  ]);
  if (u && u.ok) usersCache = u.json.users;
  if (c && c.ok) classesCache = c.json.classes;
  if (!res.ok) return placeholder(errorState(errText(res, '操作记录加载失败'), loadAudit));
  tb.innerHTML = '';
  if (!res.json.audit.length) return placeholder(emptyState('没有记录', q ? '这个类别下还没有操作。' : ''));
  for (const a of res.json.audit) {
    const tr = el('tr');
    const what = el('div');
    const tone = /delete|revoke|reject|urgent|clear_all/.test(a.action) ? 'bad' : (/approve|grant|create/.test(a.action) ? 'ok' : '');
    what.append(el('span', 'tag ' + tone, ACTIONS[a.action] || a.action), el('strong', '', describeAudit(a)));
    tr.append(
      td('时间', el('span', 'num', dt(a.at))),
      td('操作者', a.actorName ? a.actorName + (a.actorRole === 'admin' ? '（管理员）' : '') : '系统'),
      td('操作', what),
      td('来源', el('span', 'num muted', a.ip || '—')),
    );
    tb.append(tr);
  }
}
$('auditReload').onclick = loadAudit;
$('auditFilter').onchange = loadAudit;

/* ================= 设置 ================= */
async function loadSettings() {
  const res = await api('GET', '/api/admin/settings');
  if (res.ok) $('setPolicy').value = res.json.settings.announcementPolicy || 'immediate';
  else toast(errText(res, '设置加载失败'), true);
}
$('setSave').onclick = async () => {
  setBusy($('setSave'), true);
  const r = await api('PATCH', '/api/admin/settings', { announcementPolicy: $('setPolicy').value });
  setBusy($('setSave'), false);
  if (r.ok) toast('已保存'); else toast(errText(r, '保存失败'), true);
};
$('revokeAll').onclick = async () => {
  const ok = await confirmDialog({
    title: '强制所有人重新登录？', danger: true, confirm: '全部退出登录',
    impact: ['所有教师和管理员在所有设备上立即退出登录', '你自己也会被登出', '大屏不需要登录，不受影响'],
  });
  if (!ok) return;
  const r = await api('POST', '/api/admin/sessions/revoke-all', {});
  if (r.ok) { toast(`已撤销 ${r.json.revoked} 个会话`); gateOut('会话已全部撤销，请重新登录'); }
  else toast(errText(r, '操作失败'), true);
};

/* ================= 启动 ================= */
hydrateIcons();
(async function init() {
  const pub = await api('GET', '/api/public/status');
  if (pub.ok && pub.json.setupRequired) { $('gate').hidden = false; $('loginForm').hidden = true; $('setupPanel').hidden = false; return; }
  const res = await api('GET', '/api/me');
  if (res.ok && res.json.user.role === 'admin') enter(res.json.user);
  else if (res.ok) gateOut('该账号不是管理员，请使用教师端');
  else gateOut(res.status === 0 ? '连不上服务器，请检查网络后刷新' : (res.gatewayError || ''));
  setInterval(() => { if (!me) return; if (view === 'overview') loadOverview(); else refreshOverview(); }, 15000);
})();
