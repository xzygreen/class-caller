'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 用最小 DOM 驱动真实页面脚本，精确控制请求完成顺序；布局另由浏览器回归检查。
function node(tag = 'div') {
  const n = {
    tagName: typeof tag === 'string' ? tag.toUpperCase() : 'DIV', value: '', hidden: false, disabled: false, dataset: {}, children: [],
    style: { setProperty() {} }, textContent: '', clickCount: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    append(...xs) { this.children.push(...xs); }, replaceChildren(...xs) { this.children = xs; },
    setAttribute() {}, toggleAttribute() {}, querySelector() { return node(); },
    querySelectorAll(selector) { return selector === 'button' ? this.children.filter((c) => c && c.tagName === 'BUTTON') : []; },
    focus() {}, select() {}, replaceWith() {}, addEventListener() {}, reset() {},
    click() { if (!this.disabled) { this.clickCount++; return this.onclick?.(); } },
  };
  Object.defineProperty(n, 'innerHTML', { get() { return ''; }, set() { this.children = []; } });
  Object.defineProperty(n, 'firstChild', { get() { return this.children[0]; } });
  return n;
}
function page(file = 'teacher.js') {
  const nodes = new Map(), listeners = {}, timers = [];
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const document = {
    getElementById: get, addEventListener(type, fn) { listeners[type] = fn; },
    querySelector() { return null; }, documentElement: node(), createElement: node,
  };
  const context = vm.createContext({
    document, window: { addEventListener() {} }, location: { href: 'http://localhost/teacher', pathname: '/teacher', search: '', hash: '' },
    history: { replaceState() {} }, URL, URLSearchParams, console,
    setInterval() {}, clearInterval() {}, setTimeout(fn) { timers.push(fn); }, clearTimeout() {},
    fetch: () => new Promise(() => {}), hydrateIcons() {}, wireMenu() {}, wireTabs() {}, markTabs() {},
    el: node, icon: node, fill(box, ...xs) { box.replaceChildren(...xs); }, skeleton: node,
    emptyState: () => node(), errorState: () => node(), toast() {}, setBusy(n, on) { n.disabled = on; },
    initial() { return ''; }, signalTrack: node, hhmm() {}, dateTime() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), context);
  const run = (code) => vm.runInContext(code, context);
  return { context, get, listeners, timers, run };
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
      assert.ok(result.gatewayError.includes('非应用响应'));
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
