'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 用最小 DOM 驱动真实页面脚本，精确控制请求完成顺序；布局另由浏览器回归检查。
function node(tag = 'div', className = '', text = '') {
  const n = {
    tagName: typeof tag === 'string' ? tag.toUpperCase() : 'DIV', value: '', hidden: false, disabled: false, dataset: {}, children: [],
    style: { setProperty() {} }, textContent: text, clickCount: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    append(...xs) { this.children.push(...xs); }, replaceChildren(...xs) { this.children = xs; },
    setAttribute() {}, removeAttribute() {}, toggleAttribute() {}, querySelector() { return node(); },
    querySelectorAll(selector) { return selector === 'button' ? this.children.filter((c) => c && c.tagName === 'BUTTON') : []; },
    focus() {}, select() {}, replaceWith() {}, addEventListener() {}, reset() {},
    click() { if (!this.disabled) { this.clickCount++; return this.onclick?.(); } },
  };
  Object.defineProperty(n, 'innerHTML', { get() { return ''; }, set() { this.children = []; } });
  Object.defineProperty(n, 'firstChild', { get() { return this.children[0]; } });
  return n;
}
function page(file = 'teacher.js') {
  const nodes = new Map(), listeners = {}, timers = [], intervals = [];
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const document = {
    getElementById: get, addEventListener(type, fn) { listeners[type] = fn; },
    querySelector() { return null; }, documentElement: node(), createElement: node,
  };
  const context = vm.createContext({
    document, window: { addEventListener() {} }, location: { href: 'http://localhost/teacher', pathname: '/teacher', search: '', hash: '' },
    history: { replaceState() {} }, URL, URLSearchParams, console,
    setInterval(fn, ms) { intervals.push({ fn, ms }); }, clearInterval() {}, setTimeout(fn) { timers.push(fn); }, clearTimeout() {},
    fetch: () => new Promise(() => {}), hydrateIcons() {}, wireMenu() {}, wireTabs() {}, markTabs() {},
    el: node, icon: node, fill(box, ...xs) { box.replaceChildren(...xs); }, skeleton: node,
    emptyState: (title, text, action) => Object.assign(node(), { title, text, action }), errorState: () => node(), toast() {}, setBusy(n, on) { n.disabled = on; },
    initial() { return ''; }, signalTrack: node, hhmm() {}, dateTime() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), context);
  const run = (code) => vm.runInContext(code, context);
  return { context, get, listeners, timers, intervals, run };
}
function teacher() {
  const p = page(), requests = [];
  p.context.requests = requests;
  p.run(`me = { role: 'teacher', displayName: '老师' };
    api = (method, path) => new Promise(resolve => requests.push({ method, path, resolve }));
    renderWindowPill = renderGrid = renderPicked = renderNow = renderLive = connectLive = switchTab = () => {};
    loadHome = async () => {};
    toast = (text, opts) => { globalThis.undo = opts && opts.action && opts.action.fn; };`);
  const workspace = (id, students = [id + '-student']) => ({ ok: true, json: {
    classId: id, className: id, students, display: { current: null, queue: [] }, callWindow: { open: true }, settings: {},
  } });
  const enter = async (id, students) => {
    const done = p.run(`openClass(${JSON.stringify(id)})`);
    requests.at(-1).resolve(workspace(id, students));
    await done;
  };
  return { ...p, requests, workspace, enter };
}

function home(role = 'teacher') {
  const p = page(), requests = [];
  p.context.requests = requests;
  p.context.role = role;
  p.run(`me = { role, displayName: '老师' };
    api = (method, path) => new Promise(resolve => requests.push({ method, path, resolve }));
    renderWindowPill = () => {}; windowSummary = () => document.createElement('div');`);
  const data = (mine = ['a'], available = ['a'], requests = []) => ({ ok: true, json: {
    classes: mine.map((id) => ({ id, name: id, code: id, studentCount: 3 })),
    availableClasses: available.map((id) => ({ id, name: id, code: id })),
    requests, upcomingSchedules: [], pausedSchedules: [], callWindow: null,
  } });
  const refresh = async (response = data(), quiet = false) => {
    const done = p.run(`loadHome({ quiet: ${quiet} })`);
    requests.at(-1).resolve(response);
    await done;
  };
  return { ...p, requests, data, refresh };
}

test('管理员和已授权全部现有班级的教师隐藏整块申请区域，历史申请不影响判断', async () => {
  for (const role of ['admin', 'teacher']) {
    const p = home(role);
    const history = [{ id: 'r1', classId: 'a', className: '甲班', status: 'approved' }];
    await p.refresh(p.data(['a'], ['a'], history));
    assert.equal(p.get('requestPanel').hidden, true);
    assert.ok(p.get('myClasses').children.length > 0, '保留班级入口，不依赖说明文案');
    if (role === 'admin') {
      await p.refresh(p.data(['a'], ['a', 'b']), true);
      assert.equal(p.get('requestPanel').hidden, true, '管理员始终无需申请');
    }
  }
});

test('新增班级或撤权时申请区域重新出现，再次全部授权或归档未授权班级时隐藏', async () => {
  const p = home();
  await p.refresh();
  assert.equal(p.get('requestPanel').hidden, true);
  await p.refresh(p.data(['a'], ['a', 'b']), true);
  assert.equal(p.get('requestPanel').hidden, false);
  assert.deepEqual(p.get('requestClass').children.map((n) => n.value), ['', 'b']);
  await p.refresh(p.data(['a', 'b'], ['a', 'b']), true);
  assert.equal(p.get('requestPanel').hidden, true);
  await p.refresh(p.data(['a'], ['a', 'b']), true);
  assert.equal(p.get('requestPanel').hidden, false);
  await p.refresh(p.data(['a'], ['a']), true);
  assert.equal(p.get('requestPanel').hidden, true);
});

test('全部未授权班级待审批时仍显示申请记录与撤回按钮，没有班级时不显示无效申请入口', async () => {
  const p = home();
  await p.refresh(p.data([], ['a'], [{ id: 'r1', classId: 'a', className: '甲班', status: 'pending' }]));
  assert.equal(p.get('requestPanel').hidden, false);
  assert.equal(p.get('requestClass').disabled, true);
  assert.equal(p.get('requestBtn').disabled, true);
  assert.equal(p.get('myRequests').children[0].children[2].children[0].textContent, '撤回申请');
  assert.equal(p.get('myClasses').children[0].action, undefined);
  await p.refresh(p.data([], []));
  assert.equal(p.get('requestPanel').hidden, true);
  assert.equal(p.get('myClasses').children[0].action, undefined);
});

test('后台刷新不重建未变化的班级控件，变化时保留仍可申请的选择和说明', async () => {
  const p = home();
  await p.refresh(p.data(['a'], ['a', 'b']));
  const card = p.get('myClasses').children[0];
  const option = p.get('requestClass').children[1];
  p.get('requestClass').value = 'b';
  p.get('requestReason').value = '本班数学教师';
  await p.refresh(p.data(['a'], ['a', 'b']), true);
  assert.equal(p.get('myClasses').children[0], card);
  assert.equal(p.get('requestClass').children[1], option);
  await p.refresh(p.data(['a'], ['a', 'b', 'c']), true);
  assert.equal(p.get('requestClass').value, 'b');
  assert.equal(p.get('requestReason').value, '本班数学教师');
  await p.refresh({ ok: false, status: 0 }, true);
  assert.equal(p.get('requestPanel').hidden, false);
  assert.equal(p.get('requestClass').value, 'b');
  await p.refresh(p.data(['a', 'b'], ['a', 'b', 'c']), true);
  assert.equal(p.get('requestClass').value, '', '已授权的选择应移除');
});

test('首页只接受最新响应，离开首页或退出登录后忽略旧响应', async () => {
  const p = home();
  const old = p.run('loadHome()');
  await p.refresh(p.data(['a'], ['a']));
  p.requests[0].resolve(p.data(['a'], ['a', 'b'])); await old;
  assert.equal(p.get('requestPanel').hidden, true);
  for (const leave of ['workspaceVersion++', 'me = null']) {
    const done = p.run('loadHome({ quiet: true })');
    p.run(leave);
    p.requests.at(-1).resolve(p.data(['a'], ['a', 'b'])); await done;
    assert.equal(p.get('requestPanel').hidden, true);
  }
});

test('首页每 15 秒或返回标签页时刷新，后台、班级页和提交期间不轮询，不重叠请求', async () => {
  const p = home();
  assert.ok(p.intervals.some(({ fn, ms }) => fn.name === 'pollHome' && ms === 15000));
  for (const [object, key, value] of [[p.context.document, 'hidden', true], [p.get('home'), 'hidden', true], [p.get('app'), 'hidden', true], [p.get('requestBtn').dataset, 'loading', '1']]) {
    object[key] = value;
    await p.run('pollHome()');
    assert.equal(p.requests.length, 0);
    object[key] = false;
  }
  const first = p.listeners.visibilitychange();
  await p.run('pollHome()');
  assert.equal(p.requests.length, 1);
  p.requests[0].resolve(p.data()); await first;
  assert.equal(p.get('requestPanel').hidden, true);
});

test('班级异步切换只接纳最后一次响应，包括 A → B → A', async () => {
  const p = teacher();
  const a = p.run("openClass('class-a')"), b = p.run("openClass('class-b')");
  assert.equal(p.requests[0].path, '/api/classes/class-a/workspace');
  p.requests[1].resolve(p.workspace('class-b')); await b;
  p.requests[0].resolve(p.workspace('class-a')); await a;
  assert.equal(p.run('classId'), 'class-b');
  assert.equal(p.run('klass.classId'), 'class-b');
  const old = p.run("openClass('class-a')"), middle = p.run("openClass('class-b')"), latest = p.run("openClass('class-a')");
  p.requests[4].resolve(p.workspace('class-a', ['new-roster'])); await latest;
  p.requests[2].resolve(p.workspace('class-a', ['old-roster'])); await old;
  p.requests[3].resolve(p.workspace('class-b')); await middle;
  assert.deepEqual(Array.from(p.run('students')), ['new-roster']);
  assert.equal(p.run('klass.classId'), 'class-a');
});

test('旧班级发送完成后，不清空新班级选择、不覆盖新页面；回首页也不报错', async () => {
  for (const home of [false, true]) {
    const p = teacher();
    await p.enter('class-a');
    p.run("sel.add('class-a-student')");
    const send = p.run("$('send').onclick()"), request = p.requests.at(-1);
    if (home) await p.run('showHome()');
    else { await p.enter('class-b'); p.run("sel.add('class-b-student')"); }
    request.resolve({ ok: true, json: { notice: { id: 'old' }, display: { current: { id: 'old' }, queue: [] } } });
    await send;
    assert.equal(p.run('lastSent'), null);
    if (home) assert.equal(p.run('klass'), null);
    else {
      assert.equal(p.run('klass.classId'), 'class-b');
      assert.deepEqual(Array.from(p.run('[...sel]')), ['class-b-student']);
      assert.equal(p.run('display.current'), null);
      assert.equal(p.run('sending'), false);
    }
  }
});

test('撤销选择不超过人数上限，且不能把旧班名单带到新班级', async () => {
  const p = teacher();
  await p.enter('class-a', ['A1', 'A2', 'A3']);
  p.run("maxNamesPerCall = 2; sel.add('A1'); sel.add('A2'); clearSelection(); sel.add('A3'); undo()");
  assert.deepEqual(Array.from(p.run('[...sel]')), ['A3', 'A1']);
  p.run('clearSelection()');
  const undo = p.context.undo;
  await p.enter('class-b', ['B1']);
  p.run("sel.add('B1')");
  undo();
  assert.deepEqual(Array.from(p.run('[...sel]')), ['B1']);
});

test('跨班级后，旧通知的撤销不向新班级发送请求', async () => {
  const p = teacher();
  await p.enter('class-a');
  const done = p.run("withdraw('notice-a', true)");
  p.requests.at(-1).resolve({ ok: true, json: { display: { current: null, queue: [] } } });
  await done;
  const undo = p.context.undo;
  await p.enter('class-b');
  const count = p.requests.length;
  undo();
  assert.equal(p.requests.length, count);
});

test('记录筛选丢弃旧请求结果，重新进班级时清理旧筛选', async () => {
  const p = teacher();
  await p.enter('class-a');
  p.run('noticeRow = n => n');
  p.get('actType').value = 'call'; const old = p.run('loadActivity()'), oldRequest = p.requests.at(-1);
  p.get('actType').value = 'announcement'; const fresh = p.run('loadActivity()'), freshRequest = p.requests.at(-1);
  freshRequest.resolve({ ok: true, json: { classId: 'class-a', activity: [{ id: 'new', kind: 'notice' }] } }); await fresh;
  oldRequest.resolve({ ok: true, json: { classId: 'class-a', activity: [{ id: 'old', kind: 'notice' }] } }); await old;
  assert.equal(p.get('activity').children[0].id, 'new');
  p.get('actDate').value = '2026-09-29';
  await p.enter('class-b');
  assert.equal(p.get('actType').value, '');
  assert.equal(p.get('actDate').value, '');
  assert.equal(p.get('activity').children.length, 0);
});

test('弹窗打开时 Ctrl/Cmd+Enter 不触发底层发送', () => {
  const p = page();
  let prevented = false;
  const event = { key: 'Enter', ctrlKey: true, preventDefault() { prevented = true; } };
  p.context.document.querySelector = () => ({});
  p.listeners.keydown(event);
  assert.equal(p.get('send').clickCount, 0);
  p.context.document.querySelector = () => null;
  p.listeners.keydown(event);
  assert.equal(p.get('send').clickCount, 1);
  assert.equal(prevented, true);
});

test('教师和管理端拒绝 HTTP 200 的非应用响应，同时保留正常错误消息', async () => {
  for (const file of ['teacher.js', 'admin.js']) {
    const p = page(file);
    for (const payload of [null, [], 'gateway', 42, {}, { message: 'challenge' }]) {
      p.context.fetch = async () => ({ ok: true, status: 200, headers: { get() {}, has() {} }, json: async () => payload });
      const result = await p.run("api('GET', '/api/me')");
      assert.equal(result.ok, false, file);
      assert.ok(result.gatewayError.includes('服务暂时不可用'));
    }
    p.context.fetch = async () => ({ ok: true, status: 200, headers: { get() {}, has() {} }, json: async () => { throw Error('HTML'); } });
    assert.equal((await p.run("api('GET', '/api/me')")).ok, false);
    p.context.fetch = async () => ({ ok: true, status: 200, headers: { get() {}, has() {} }, json: async () => ({ ok: true, user: {} }) });
    assert.equal((await p.run("api('GET', '/api/me')")).ok, true);
    p.context.fetch = async () => ({ ok: false, status: 400, headers: { get() {}, has() {} }, json: async () => ({ ok: false, message: '操作失败' }) });
    const failure = await p.run("api('POST', '/api/example')");
    assert.equal(failure.ok, false);
    assert.equal(failure.gatewayError, '');
    assert.equal(failure.json.message, '操作失败');
  }
});

test('F19 星期选择即时进入权威草稿，增删时段、空星期及恢复默认均不丢失', () => {
  const p = page('admin.js');
  const days = Array.from({ length: 7 }, (_, value) => Object.assign(node('input'), { value: String(value), checked: value > 0 && value < 6 }));
  p.get('wDays').querySelectorAll = (selector) => selector === 'input:checked' ? days.filter((d) => d.checked) : days;
  const tbody = node('tbody');
  p.get('wTable').querySelector = () => tbody;
  p.run("windowsDraft = { timezone: 'Asia/Shanghai', weekdays: [1,2,3,4,5], windows: [{ start: '08:00', end: '08:10' }] }; renderWindows()");
  days[6].checked = true; days[1].checked = false; p.get('wDays').onchange();
  assert.deepEqual(Array.from(p.run('windowsDraft.weekdays')), [2,3,4,5,6]);
  p.get('wAdd').onclick();
  tbody.children[0].children[3].children[0].onclick();
  assert.deepEqual(days.filter((d) => d.checked).map((d) => Number(d.value)), [2,3,4,5,6]);
  assert.equal(p.run('windowsDraft.windows.length'), 1);
  days.forEach((d) => { d.checked = false; }); p.get('wDays').onchange(); p.get('wAdd').onclick();
  assert.equal(p.run('windowsDraft.weekdays.length'), 0);
  assert.equal(days.some((d) => d.checked), false);
  p.get('wDefault').onclick();
  assert.deepEqual(Array.from(p.run('windowsDraft.weekdays')), [1,2,3,4,5]);
  assert.deepEqual(days.filter((d) => d.checked).map((d) => Number(d.value)), [1,2,3,4,5]);
});

test('F22 同班级在途点人只清理未变草稿，保留选人、取消、说明、搜索与清空后的撤销', async () => {
  const edits = [
    "toggleName(sel, 'A2', () => {})",
    "toggleName(sel, 'A1', () => {})",
    "$('msg').value = '下一条'; $('msg').oninput()",
    "$('search').value = 'A2'; $('search').oninput()",
    'clearSelection(); undo()',
    "$('msg').value = 'changed'; $('msg').oninput(); $('msg').value = 'first'; $('msg').oninput()",
  ];
  for (const edit of edits) {
    const p = teacher(); await p.enter('class-a', ['A1', 'A2']);
    p.run("sel.add('A1'); $('msg').value = 'first'");
    const done = p.run("$('send').onclick()");
    p.run(edit);
    const expected = p.run('callDraftKey()');
    p.requests.at(-1).resolve({ ok: true, json: { notice: { id: 'sent' }, display: { current: null, queue: [] } } }); await done;
    assert.equal(p.run('callDraftKey()'), expected, edit);
    assert.equal(p.run('lastSent.message'), 'first');
    assert.deepEqual(Array.from(p.run('lastSent.names')), ['A1']);
    assert.equal(p.run('sending'), false);
  }
});

test('F22 未编辑的成功请求清空草稿，失败请求保持原稿供重试', async () => {
  for (const ok of [true, false]) {
    const p = teacher(); await p.enter('class-a');
    p.run("sel.add('class-a-student'); $('msg').value = 'first'; $('search').value = 'student'");
    const done = p.run("$('send').onclick()");
    p.requests.at(-1).resolve(ok ? { ok, json: { notice: { id: 'sent' }, display: { current: null, queue: [] } } } : { ok, json: { message: '失败' } });
    await done;
    assert.equal(p.run('sel.size'), ok ? 0 : 1);
    assert.equal(p.get('msg').value, ok ? '' : 'first');
    assert.equal(p.get('search').value, ok ? '' : 'student');
    assert.equal(p.get('sendErr').hidden, ok);
  }
});

test('撤销提示过期后按钮禁用，不再响应键盘点击', () => {
  const p = page('ui.js');
  p.run("icon = () => document.createElement('svg'); globalThis.called = 0; toast('已撤回', { action: { label: '撤销', fn() { called++; } } })");
  const button = p.get('toast').querySelectorAll('button')[0];
  assert.equal(button.disabled, false);
  p.timers.at(-1)();
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(p.context.called, 0);
});
