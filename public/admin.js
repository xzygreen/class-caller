'use strict';

const $ = (id) => document.getElementById(id);
let me = null;
let view = 'overview';
let classesCache = [];
let usersCache = [];
let windowsDraft = null;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
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
  'notice.withdraw': '撤回通知', 'notice.resend': '再次发送', 'display.clear': '清空大屏', 'display.clear_all': '清空大屏与队列',
  'settings.update': '修改设置', 'session.revoke_all': '强制全员重新登录',
};

function toast(text, bad) {
  const t = $('toast'); t.textContent = text; t.classList.toggle('bad', Boolean(bad)); t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2800);
}
const dt = (ms) => { if (!ms) return '—'; const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 8)}`; };
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function errText(res, fb) { if (res.status === 0) return '连不上服务器'; if (res.gatewayError) return res.gatewayError; const m = (res.json && res.json.message) || fb; return res.json && res.json.detail ? m + '：' + res.json.detail : m; }

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

function showDialog(title, node) { $('dlgTitle').textContent = title; $('dlgBody').innerHTML = ''; $('dlgBody').append(node); $('dlg').showModal(); }
$('dlgClose').onclick = () => $('dlg').close();

/* ================= 登录 ================= */
function gateOut(msg) {
  me = null;
  $('app').hidden = true; $('gate').hidden = false;
  $('loginErr').textContent = msg || '';
}
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const res = await api('POST', '/api/auth/login', { username: $('loginUser').value.trim(), password: $('loginPwd').value });
  if (!res.ok) { $('loginErr').textContent = errText(res, '登录失败'); return; }
  if (res.json.user.role !== 'admin') { await api('POST', '/api/auth/logout', {}); $('loginErr').textContent = '该账号不是管理员，请使用教师端'; return; }
  $('loginPwd').value = '';
  enter(res.json.user);
};
$('logout').onclick = async () => { await api('POST', '/api/auth/logout', {}); gateOut(''); };

function enter(user) {
  me = user;
  if (me.mustChangePassword) { location.href = '/teacher.html'; return; }
  $('gate').hidden = true; $('app').hidden = false;
  $('whoami').textContent = me.displayName;
  switchView(view);
}

/* ================= 导航 ================= */
const loaders = {
  overview: loadOverview, requests: loadRequests, classes: loadClasses, users: loadUsers, windows: loadWindows,
  schedules: loadSchedules, displays: loadDisplays, audit: loadAudit, settings: loadSettings,
};
function switchView(v) {
  view = v;
  for (const b of $('nav').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.view === v));
  for (const k of Object.keys(loaders)) $('view-' + k).hidden = k !== v;
  loaders[v]();
}
$('nav').onclick = (e) => { const b = e.target.closest('button[data-view]'); if (b) switchView(b.dataset.view); };

function renderWindowPill(cw) {
  if (!cw) return;
  $('windowPill').className = 'pill ' + (cw.open ? 'on' : 'warn');
  $('windowText').textContent = cw.open ? `全校可点人至 ${cw.current.end}` : (cw.next ? `上课中 · 下次 ${cw.next.date === cw.now.date ? '' : cw.next.weekdayName + ' '}${cw.next.start}` : '上课中');
}

/* ================= 概览 ================= */
async function loadOverview() {
  const res = await api('GET', '/api/admin/overview');
  if (!res.ok) return;
  const d = res.json;
  renderWindowPill(d.callWindow);
  $('navRequests').textContent = d.pendingRequests.length || '';
  $('navSchedules').textContent = d.pausedSchedules.length || '';
  $('navDisplays').textContent = d.offlineDisplays.length || '';
  const k = $('kpis'); k.innerHTML = '';
  const kpi = (n, label, alert) => { const x = el('div', 'kpi' + (alert && n ? ' alert' : '')); x.append(el('b', '', String(n)), el('span', '', label)); return x; };
  k.append(kpi(d.pendingRequests.length, '待审批申请', true), kpi(d.pausedSchedules.length, '暂停的定时任务', true), kpi(d.offlineDisplays.length, '离线的大屏', true));
  const cw = el('div', 'kpi' + (d.callWindow.open ? '' : ' alert'));
  cw.append(el('b', '', d.callWindow.open ? '可点人' : '上课中'), el('span', '', d.callWindow.open ? `当前时段 ${d.callWindow.current.start}–${d.callWindow.current.end}` : (d.callWindow.next ? `下次 ${d.callWindow.next.weekdayName} ${d.callWindow.next.start}–${d.callWindow.next.end}` : '无可用时段')));
  k.append(cw);

  const todo = $('todo'); todo.innerHTML = '';
  if (!d.pendingRequests.length && !d.pausedSchedules.length && !d.offlineDisplays.length) todo.append(el('span', 'ph', '暂时没有需要处理的事项'));
  for (const r of d.pendingRequests) todo.append(requestRow(r, loadOverview));
  for (const s of d.pausedSchedules) todo.append(scheduleRow(s, loadOverview));
  for (const x of d.offlineDisplays) {
    const row = el('div', 'item'); row.dataset.status = 'paused';
    const c = el('div'); c.append(el('strong', '', `${x.className}（${x.code}）大屏离线`), el('small', '', '没有任何大屏或原生程序连接到该班事件流'));
    row.append(c); todo.append(row);
  }
  const ov = $('ovDisplays'); ov.innerHTML = '';
  for (const x of d.displays) ov.append(displayRow(x, loadOverview));
}

/* ================= 申请 ================= */
function requestRow(r, reload) {
  const row = el('div', 'item'); row.dataset.status = r.status;
  const c = el('div');
  c.append(el('strong', '', `${r.user ? r.user.displayName : '?'}${r.user && r.user.title ? '（' + r.user.title + '）' : ''} 申请管理 ${r.className}`));
  const meta = [dt(r.createdAt), r.user ? '登录名 ' + r.user.username : ''];
  if (r.reason) meta.push('说明：' + r.reason);
  if (r.status !== 'pending') meta.push(({ approved: '已批准', rejected: '已拒绝', cancelled: '已撤回' }[r.status]) + (r.decidedByName ? '（' + r.decidedByName + '）' : '') + (r.note ? '：' + r.note : ''));
  c.append(el('small', '', meta.filter(Boolean).join(' · ')));
  const acts = el('div', 'acts');
  if (r.status === 'pending') {
    const ok = el('button', 'btn btn-go btn-sm', '批准');
    ok.onclick = async () => { const x = await api('POST', `/api/admin/requests/${r.id}/approve`, {}); if (x.ok) { toast('已批准，权限立即生效'); reload(); } else toast(errText(x, '操作失败'), true); };
    const no = el('button', 'btn btn-danger btn-sm', '拒绝');
    no.onclick = async () => { const note = window.prompt('拒绝理由（会显示给教师，可留空）', '') ; if (note === null) return; const x = await api('POST', `/api/admin/requests/${r.id}/reject`, { note }); if (x.ok) { toast('已拒绝'); reload(); } else toast(errText(x, '操作失败'), true); };
    acts.append(ok, no);
  }
  row.append(c, acts);
  return row;
}
async function loadRequests() {
  const st = $('reqStatus').value;
  const res = await api('GET', '/api/admin/requests' + (st ? '?status=' + st : ''));
  if (!res.ok) return;
  const box = $('requests'); box.innerHTML = '';
  if (!res.json.requests.length) box.append(el('span', 'ph', '没有申请'));
  for (const r of res.json.requests) box.append(requestRow(r, loadRequests));
}
$('reqStatus').onchange = loadRequests;

/* ================= 班级 ================= */
$('classForm').onsubmit = async (e) => {
  e.preventDefault();
  const id = $('cId').value.trim();
  const res = await api('POST', '/api/admin/classes', {
    id, name: $('cName').value.trim(), code: $('cCode').value.trim() || undefined, color: $('cColor').value,
    autoClearSeconds: Number($('cAuto').value), students: [],
  });
  if (!res.ok) return toast(errText(res, '新增失败'), true);
  toast('已新增班级，请在下方录入名单');
  $('cId').value = ''; $('cName').value = ''; $('cCode').value = '';
  await loadClasses();
  // 新班级排在列表末尾，可能被上面的班级挤出视口：直接滚到它的名单框并聚焦
  const card = $('classList').querySelector(`[data-class-id="${id}"]`);
  if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); const ta = card.querySelector('textarea'); if (ta) ta.focus(); }
};

async function loadClasses() {
  const res = await api('GET', '/api/admin/classes');
  if (!res.ok) return toast(errText(res, '班级列表加载失败'), true);
  classesCache = res.json.classes;
  const box = $('classList'); box.innerHTML = '';
  if (!classesCache.length) box.append(el('div', 'muted', '还没有班级，请先在上方新增。'));
  for (const c of classesCache) {
    const students = Array.isArray(c.students) ? c.students : [];
    const teachers = Array.isArray(c.teachers) ? c.teachers : [];
    const card = el('section', 'card');
    card.dataset.classId = c.id;
    const h = el('h2');
    h.append(el('span', '', `${c.name}（${c.code}）· ${c.id}${c.status === 'archived' ? ' · 已归档' : ''}`));
    const acts = el('span', 'row');
    const edit = el('button', 'link', '编辑');
    edit.onclick = () => editClass(c);
    const arch = el('button', 'link' + (c.status === 'archived' ? '' : ' danger'), c.status === 'archived' ? '恢复' : '归档');
    arch.onclick = async () => {
      if (c.status !== 'archived' && !window.confirm(`归档 ${c.name}？该班大屏连接会被关闭，教师将无法再操作该班，定时任务会暂停。`)) return;
      const x = await api('PATCH', `/api/admin/classes/${c.id}`, { status: c.status === 'archived' ? 'active' : 'archived' });
      if (!x.ok) return toast(errText(x, '操作失败'), true);
      toast(c.status === 'archived' ? '已恢复' : '已归档'); loadClasses();
    };
    acts.append(edit, arch); h.append(acts); card.append(h);
    card.append(el('div', 'muted', `${students.length} 名学生 · 大屏在线 ${c.displays || 0} · 自动清屏 ${c.autoClearSeconds || '常驻'} 秒 · 教师：${teachers.map((t) => t.displayName).join('、') || '尚无'}`));
    const ta = el('textarea'); ta.value = students.join('\n');
    ta.placeholder = students.length ? '每行一个姓名；也可用逗号、空格分隔粘贴' : '还没有名单。每行一个姓名，或直接粘贴用逗号、空格分隔的名单，然后点「保存名单」';
    ta.style.marginTop = '10px'; ta.style.minHeight = '140px';
    const row = el('div', 'row end'); row.style.marginTop = '8px';
    const count = el('span', 'muted', ''); const save = el('button', 'btn btn-go btn-sm', '保存名单');
    const recount = () => { count.textContent = parseNames(ta.value).length + ' 人'; }; ta.oninput = recount; recount();
    save.onclick = async () => {
      const next = parseNames(ta.value);
      if (!next.length && students.length && !window.confirm(`清空 ${c.name} 的全部名单？`)) return;
      save.disabled = true;
      const x = await api('PUT', `/api/admin/classes/${c.id}/students`, { students: next });
      save.disabled = false;
      if (!x.ok) return toast(errText(x, '保存失败'), true);
      toast(`名单已保存（${x.json.students.length} 人）` + (x.json.pausedSchedules ? `，${x.json.pausedSchedules} 个定时任务因学生变动暂停` : ''));
      loadClasses();
    };
    row.append(count, save);
    card.append(ta, row);
    box.append(card);
  }
}
function parseNames(text) { return text.split(/[\n,，、;；\s]+/).map((s) => s.trim()).filter(Boolean); }

function editClass(c) {
  const f = el('form');
  f.innerHTML = `
    <label class="field"><span>名称</span><input type="text" name="name" value="" maxlength="32" required></label>
    <div class="grid2">
      <label class="field"><span>短编号</span><input type="text" name="code" maxlength="4"></label>
      <label class="field"><span>辅助色</span><select name="color">${['blue', 'green', 'orange', 'purple', 'teal', 'red'].map((x) => `<option>${x}</option>`).join('')}</select></label>
      <label class="field"><span>自动清屏（秒）</span><input type="number" name="autoClearSeconds" min="0" max="3600"></label>
      <label class="field"><span>启动器模式</span><select name="mode"><option value="off">off</option><option value="protocol">protocol</option><option value="native">native</option></select></label>
    </div>
    <div class="row end"><button type="submit" class="btn btn-go">保存</button></div>`;
  f.name.value = c.name; f.code.value = c.code; f.color.value = c.color; f.autoClearSeconds.value = c.autoClearSeconds; f.mode.value = c.launcher.mode;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const x = await api('PATCH', `/api/admin/classes/${c.id}`, { name: f.name.value.trim(), code: f.code.value.trim(), color: f.color.value, autoClearSeconds: Number(f.autoClearSeconds.value), launcher: { mode: f.mode.value, freshSeconds: c.launcher.freshSeconds } });
    if (!x.ok) return toast(errText(x, '保存失败'), true);
    $('dlg').close(); toast('已保存'); loadClasses();
  };
  showDialog('编辑班级 ' + c.id, f);
}

/* ================= 教师与权限 ================= */
$('userForm').onsubmit = async (e) => {
  e.preventDefault();
  const res = await api('POST', '/api/admin/users', { username: $('uUser').value.trim(), displayName: $('uName').value.trim(), title: $('uTitle').value.trim(), password: $('uPwd').value, role: $('uRole').value });
  if (!res.ok) return toast(errText(res, '创建失败'), true);
  toast('已创建账号，请把初始密码告知本人；首次登录必须修改');
  $('uUser').value = ''; $('uName').value = ''; $('uTitle').value = ''; $('uPwd').value = '';
  loadUsers();
};
$('userFilter').oninput = renderUsers;

async function loadUsers() {
  const [u, c] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/classes')]);
  if (!u.ok) return;
  usersCache = u.json.users;
  if (c.ok) classesCache = c.json.classes;
  renderUsers();
}
function renderUsers() {
  const q = $('userFilter').value.trim().toLowerCase();
  const tb = $('userTable').querySelector('tbody'); tb.innerHTML = '';
  for (const u of usersCache) {
    if (q && !u.displayName.toLowerCase().includes(q) && !u.username.includes(q)) continue;
    const tr = el('tr');
    tr.append(el('td', '', u.displayName + (u.title ? '（' + u.title + '）' : '')), el('td', '', u.username), el('td', '', u.role === 'admin' ? '管理员' : '教师'));
    const st = el('td'); st.append(el('span', 'tag ' + (u.status === 'active' ? 'ok' : 'bad'), u.status === 'active' ? '启用' : '停用')); if (u.mustChangePassword) st.append(el('span', 'tag', '待改密码')); tr.append(st);
    const cls = el('td');
    for (const m of u.classes) {
      const chip = el('span', 'tag call', m.className);
      if (u.role !== 'admin') {
        const x = el('button', 'link danger', '撤销'); x.style.padding = '0 4px';
        x.onclick = async () => { if (!window.confirm(`撤销 ${u.displayName} 对 ${m.className} 的权限？立即生效。`)) return; const r = await api('POST', '/api/admin/memberships/revoke', { userId: u.id, classId: m.classId }); if (r.ok) { toast('已撤销' + (r.json.pausedSchedules ? `，${r.json.pausedSchedules} 个定时任务已暂停` : '')); loadUsers(); } else toast(errText(r, '失败'), true); };
        chip.append(x);
      }
      cls.append(chip);
    }
    if (u.role === 'admin') cls.append(el('span', 'muted', '全部班级'));
    else {
      const sel = el('select'); sel.style.width = 'auto'; sel.style.padding = '2px 6px'; sel.style.fontSize = '12px';
      sel.innerHTML = '<option value="">+ 授权班级</option>' + classesCache.filter((c) => c.status === 'active' && !u.classes.some((m) => m.classId === c.id)).map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
      sel.onchange = async () => { if (!sel.value) return; const r = await api('POST', '/api/admin/memberships', { userId: u.id, classId: sel.value }); if (r.ok) { toast('已授权'); loadUsers(); } else toast(errText(r, '失败'), true); };
      cls.append(sel);
    }
    tr.append(cls, el('td', '', dt(u.lastLoginAt)));
    const acts = el('td');
    const edit = el('button', 'link', '编辑'); edit.onclick = () => editUser(u);
    const tog = el('button', 'link' + (u.status === 'active' ? ' danger' : ''), u.status === 'active' ? '停用' : '启用');
    tog.onclick = async () => { const r = await api('PATCH', `/api/admin/users/${u.id}`, { status: u.status === 'active' ? 'disabled' : 'active' }); if (r.ok) { toast(u.status === 'active' ? '已停用，其会话已失效' : '已启用'); loadUsers(); } else toast(errText(r, '失败'), true); };
    const reset = el('button', 'link', '重置密码');
    reset.onclick = async () => {
      if (!window.confirm(`为 ${u.displayName} 生成临时密码？其所有会话会立即失效，首次登录必须改密码。`)) return;
      const r = await api('PATCH', `/api/admin/users/${u.id}`, { resetPassword: true });
      if (!r.ok) return toast(errText(r, '失败'), true);
      const box = el('div'); box.append(el('p', '', '临时密码只显示这一次，请当面或通过可信渠道告知本人：'));
      const code = el('pre', '', r.json.tempPassword); code.style.cssText = 'font-size:22px;letter-spacing:.1em;background:var(--paper-050);padding:12px;border-radius:8px;user-select:all';
      box.append(code); showDialog('已重置 ' + u.displayName + ' 的密码', box); loadUsers();
    };
    const del = el('button', 'link danger', '删除');
    del.disabled = u.id === me.id; if (del.disabled) del.title = '不能删除当前登录的账号';
    del.onclick = async () => {
      if (!window.confirm(`删除账号 ${u.displayName}（${u.username}）？\n其班级授权、申请与定时任务会一并移除，已发出的通知记录保留。此操作不可恢复。`)) return;
      const r = await api('DELETE', `/api/admin/users/${u.id}`);
      if (!r.ok) return toast(errText(r, '删除失败'), true);
      toast('已删除账号' + (r.json.removedSchedules ? `，同时移除了 ${r.json.removedSchedules} 个定时任务` : '')); loadUsers();
    };
    acts.append(edit, tog, reset, del); tr.append(acts);
    tb.append(tr);
  }
}
function editUser(u) {
  const f = el('form');
  f.innerHTML = `<label class="field"><span>姓名</span><input type="text" name="displayName" maxlength="20" required></label>
    <label class="field"><span>职务</span><input type="text" name="title" maxlength="12"></label>
    <div class="row end"><button type="submit" class="btn btn-go">保存</button></div>`;
  f.displayName.value = u.displayName; f.title.value = u.title;
  f.onsubmit = async (e) => { e.preventDefault(); const r = await api('PATCH', `/api/admin/users/${u.id}`, { displayName: f.displayName.value.trim(), title: f.title.value.trim() }); if (!r.ok) return toast(errText(r, '失败'), true); $('dlg').close(); toast('已保存'); loadUsers(); };
  showDialog('编辑 ' + u.username, f);
}

/* ================= 作息 ================= */
async function loadWindows() {
  const res = await api('GET', '/api/admin/call-windows');
  if (!res.ok) return;
  windowsDraft = JSON.parse(JSON.stringify(res.json.callWindows));
  renderWindowPill(res.json.status);
  renderWindows();
}
function renderWindows() {
  $('tzLabel').textContent = windowsDraft.timezone;
  for (const i of $('wDays').querySelectorAll('input')) i.checked = windowsDraft.weekdays.includes(Number(i.value));
  const tb = $('wTable').querySelector('tbody'); tb.innerHTML = '';
  windowsDraft.windows.forEach((w, idx) => {
    const tr = el('tr');
    const s = el('input'); s.type = 'time'; s.value = w.start; s.step = 60; s.onchange = () => { w.start = s.value; };
    const e = el('input'); e.type = 'time'; e.value = w.end; e.step = 60; e.onchange = () => { w.end = e.value; };
    const l = el('input'); l.type = 'text'; l.value = w.label || ''; l.maxLength = 30; l.placeholder = '课间'; l.oninput = () => { w.label = l.value; };
    const d = el('button', 'link danger', '删除'); d.onclick = () => { windowsDraft.windows.splice(idx, 1); renderWindows(); };
    for (const x of [s, e, l, d]) { const td = el('td'); td.append(x); tr.append(td); }
    tb.append(tr);
  });
}
$('wAdd').onclick = () => { windowsDraft.windows.push({ start: '12:00', end: '12:10', label: '' }); renderWindows(); };
$('wDefault').onclick = () => {
  windowsDraft.weekdays = [1, 2, 3, 4, 5];
  windowsDraft.windows = [['08:45', '09:00', '课间'], ['09:45', '10:15', '课间'], ['11:00', '11:15', '课间'], ['11:35', '12:30', '午餐、过渡时间、午自习'], ['13:00', '13:10', '午休结束后的课间'], ['13:55', '14:15', '课间'], ['15:00', '15:15', '课间'], ['16:00', '16:15', '课间']].map(([start, end, label]) => ({ start, end, label }));
  renderWindows();
};
$('wSave').onclick = async () => {
  windowsDraft.weekdays = [...$('wDays').querySelectorAll('input:checked')].map((i) => Number(i.value));
  const res = await api('PUT', '/api/admin/call-windows', windowsDraft);
  if (!res.ok) return toast(errText(res, '保存失败'), true);
  toast('作息已保存并生效' + (res.json.pausedSchedules ? `；${res.json.pausedSchedules} 个定时任务因不符合新作息已暂停` : ''));
  loadWindows();
};

/* ================= 定时任务 ================= */
function scheduleRow(s, reload) {
  const row = el('div', 'item'); row.dataset.status = s.status === 'paused' ? 'paused' : (s.enabled ? 'active' : '');
  const c = el('div');
  c.append(el('strong', '', `${s.className || s.classId} · ${s.time} · ${s.names.join('、')}`));
  const meta = [s.weekdayNames.join('、'), s.message || '（无说明）', '创建：' + s.createdByName];
  if (!s.enabled) meta.push('已停用'); else if (s.status === 'paused') meta.push('已暂停：' + (PAUSE_REASONS[s.pauseReason] || s.pauseReason)); else if (s.nextRunAt) meta.push('下次 ' + dt(s.nextRunAt));
  if (s.lastResult) meta.push('最近：' + ({ sent: '已发送', missed: '已错过', skipped: '已跳过', failed: '失败' }[s.lastResult.status] || s.lastResult.status));
  c.append(el('small', '', meta.join(' · ')));
  const acts = el('div', 'acts');
  const tog = el('button', 'link', s.status === 'paused' ? '恢复' : (s.enabled ? '停用' : '启用'));
  tog.onclick = async () => { const r = await api('PATCH', `/api/admin/schedules/${s.id}`, { enabled: s.status === 'paused' ? true : !s.enabled }); if (r.ok) { toast('已更新'); reload(); } else toast(errText(r, '失败：' + (r.json && r.json.error === 'SCHEDULE_OUT_OF_WINDOW' ? '该时间不在允许点人的时段' : '')), true); };
  const del = el('button', 'link danger', '删除');
  del.onclick = async () => { if (!window.confirm('删除这条定时任务？')) return; const r = await api('DELETE', `/api/admin/schedules/${s.id}`); if (r.ok) { toast('已删除'); reload(); } else toast(errText(r, '失败'), true); };
  acts.append(tog, del); row.append(c, acts);
  return row;
}
async function loadSchedules() {
  const res = await api('GET', '/api/admin/schedules');
  if (!res.ok) return;
  const box = $('schedules'); box.innerHTML = '';
  if (!res.json.schedules.length) box.append(el('span', 'ph', '没有定时任务'));
  for (const s of res.json.schedules) box.append(scheduleRow(s, loadSchedules));
}

/* ================= 大屏 ================= */
function displayRow(x, reload) {
  const row = el('div', 'item'); row.dataset.status = x.displays ? 'active' : 'paused';
  const c = el('div');
  c.append(el('strong', '', `${x.className}（${x.code}）· 大屏 ${x.displays} 台在线${x.launchers ? ' · 启动器 ' + x.launchers : ''}${x.teachers ? ' · 教师端 ' + x.teachers : ''}`));
  const cur = x.current;
  let text = '大屏空闲';
  if (cur && cur.type === 'call') text = `正在找：${cur.names.join('、')}（${cur.caller}）已收到 ${cur.acks.length}/${cur.names.length}`;
  if (cur && cur.type === 'announcement') text = `留言：${cur.title}（${cur.author}）`;
  if (cur && cur.queued) text += ` · 等待 ${cur.queued} 条`;
  c.append(el('small', '', text));
  const acts = el('div', 'acts');
  const clr = el('button', 'link danger', '清空大屏');
  clr.onclick = async () => { const r = await api('POST', `/api/admin/classes/${x.classId}/display/clear`, { all: true }); if (r.ok) { toast('已清空'); reload(); } else toast(errText(r, '失败'), true); };
  acts.append(clr); row.append(c, acts);
  return row;
}
async function loadDisplays() {
  const res = await api('GET', '/api/admin/overview');
  if (!res.ok) return;
  const box = $('displays'); box.innerHTML = '';
  for (const x of res.json.displays) box.append(displayRow(x, loadDisplays));
  $('ugClass').innerHTML = res.json.displays.map((x) => `<option value="${x.classId}">${x.className}</option>`).join('');
}
$('urgentForm').onsubmit = async (e) => {
  e.preventDefault();
  const cid = $('ugClass').value;
  if (!cid) return;
  const res = await api('POST', `/api/classes/${cid}/announcements`, { title: $('ugTitle').value.trim(), body: $('ugBody').value.trim(), durationSeconds: Number($('ugDuration').value), urgent: true });
  if (!res.ok) return toast(errText(res, '发送失败'), true);
  toast('紧急广播已发送'); $('ugTitle').value = ''; $('ugBody').value = ''; loadDisplays();
};

/* ================= 审计 ================= */
async function loadAudit() {
  const q = $('auditFilter').value.trim();
  const res = await api('GET', '/api/admin/audit?limit=300' + (q ? '&action=' + encodeURIComponent(q) : ''));
  if (!res.ok) return;
  const tb = $('auditTable').querySelector('tbody'); tb.innerHTML = '';
  for (const a of res.json.audit) {
    const tr = el('tr');
    tr.append(el('td', '', dt(a.at)), el('td', '', a.actorName + (a.actorRole === 'admin' ? '（管理员）' : '')), el('td', '', ACTIONS[a.action] || a.action), el('td', '', a.target || ''));
    const d = el('td', '', a.detail ? JSON.stringify(a.detail) : ''); d.style.maxWidth = '360px'; d.style.overflowWrap = 'anywhere';
    tr.append(d, el('td', '', a.ip || ''));
    tb.append(tr);
  }
}
$('auditReload').onclick = loadAudit;
$('auditFilter').onchange = loadAudit;

/* ================= 设置 ================= */
async function loadSettings() {
  const res = await api('GET', '/api/admin/settings');
  if (res.ok) $('setPolicy').value = res.json.settings.announcementPolicy || 'immediate';
}
$('setSave').onclick = async () => { const r = await api('PATCH', '/api/admin/settings', { announcementPolicy: $('setPolicy').value }); if (r.ok) toast('已保存'); else toast(errText(r, '失败'), true); };
$('revokeAll').onclick = async () => {
  if (!window.confirm('强制所有账号重新登录？你自己也会被登出。')) return;
  const r = await api('POST', '/api/admin/sessions/revoke-all', {});
  if (r.ok) { toast(`已撤销 ${r.json.revoked} 个会话`); gateOut('会话已全部撤销，请重新登录'); }
};

/* ================= 启动 ================= */
(async function init() {
  const pub = await api('GET', '/api/public/status');
  if (pub.ok && pub.json.setupRequired) { $('gate').hidden = false; $('loginForm').hidden = true; $('setupPanel').hidden = false; return; }
  const res = await api('GET', '/api/me');
  if (res.ok && res.json.user.role === 'admin') enter(res.json.user);
  else if (res.ok) gateOut('该账号不是管理员，请使用教师端');
  else gateOut(res.status === 0 ? '连不上服务器' : (res.gatewayError || ''));
  setInterval(() => { if (me && view === 'overview') loadOverview(); }, 15000);
})();
