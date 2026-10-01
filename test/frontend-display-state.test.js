'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// No wall-clock sleeps: run the real display script and explicitly release HTTP
// replies / expiry timers. Geometry is covered separately by native Chrome CDP.
function displayPage() {
  function element() {
    const classes = new Set(), attrs = {}, queries = new Map();
    const n = {
      children: [], dataset: {}, style: {}, clientWidth: 0, clientHeight: 0, textContent: '',
      classList: { add(...xs) { xs.forEach((x) => classes.add(x)); }, remove(...xs) { xs.forEach((x) => classes.delete(x)); }, contains(x) { return classes.has(x); }, toggle(x, on) { if (on ?? !classes.has(x)) classes.add(x); else classes.delete(x); } },
      append(...xs) { this.children.push(...xs); }, appendChild(x) { this.children.push(x); },
      setAttribute(key, value) { attrs[key] = value; }, getAttribute(key) { return attrs[key]; },
      insertAdjacentHTML() {}, addEventListener() {},
      querySelector(q) { if (!queries.has(q)) queries.set(q, element()); return queries.get(q); },
    };
    Object.defineProperty(n, 'innerHTML', { set() { this.children = []; } });
    Object.defineProperty(n, 'firstElementChild', { get() { return this.children[0] || this.querySelector(':first-child'); } });
    return n;
  }
  const nodes = new Map(), timers = new Map(), requests = [];
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const document = { body: element(), documentElement: element(), getElementById: get, createElement: element, addEventListener() {} };
  let now = 1000, sequence = 0;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    document, window: { addEventListener() {} }, location: { search: '?class=class-a' }, URLSearchParams,
    localStorage: { getItem() { return '0'; }, setItem() {} }, sessionStorage: { getItem() {}, setItem() {} },
    setInterval() {}, clearInterval() {}, setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    Date: Clock, console, fetch: () => new Promise(() => {}),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'display.js'), 'utf8'), context);
  context.fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  const run = (code) => vm.runInContext(code, context);
  const render = (event) => { context.event = event; run('render(event, false)'); };
  const call = (id = 10, extra = {}) => ({ type: 'call', classId: 'class-a', id, names: ['甲', '乙'], caller: '合成老师', createdAt: 1000, serverTime: 1000, expiresAt: 11000, acks: [], ...extra });
  const release = (index, event, ok = true) => requests[index].resolve({ ok, json: async () => ({ ok, event, allAcked: false, message: '合成错误' }) });
  return { run, render, call, release, requests, get, document, timers, advance(ms) { now += ms; } };
}

for (const transition of ['clear', 'call', 'urgent', 'expiry', 'unbind']) {
  test('F18 delayed ACK cannot revive old display after ' + transition, async () => {
    const p = displayPage(), old = p.call(); p.render(old);
    const pending = p.run("sendAck(currentEvent, ['甲'])");
    if (transition === 'clear') p.render({ type: 'clear', id: 11 });
    if (transition === 'call') p.render(p.call(11, { names: ['新同学'] }));
    if (transition === 'urgent') p.render({ type: 'announcement', id: 11, classId: 'class-a', title: '紧急', body: '新正文', priority: 1 });
    if (transition === 'expiry') p.timers.get(p.run('expiryTimer'))();
    if (transition === 'unbind') p.run("showBindError('已归档', '绑定无效')");
    const state = p.run('JSON.stringify({shownEventId, currentEvent, expiryLocal, displayGeneration})');
    p.release(0, { ...old, acks: [{ name: '甲', at: 2000 }] }); await pending;
    assert.equal(p.run('JSON.stringify({shownEventId, currentEvent, expiryLocal, displayGeneration})'), state);
    assert.equal(p.get('ackNote').textContent, '');
    assert.equal(p.run('ackBusy'), false);
  });
}

test('F18 event generation isolates A → clear → A and a new in-flight ACK', async () => {
  const p = displayPage(); p.render(p.call());
  const first = p.run("sendAck(currentEvent, ['甲'])");
  p.render({ type: 'clear' }); p.render(p.call());
  const second = p.run("sendAck(currentEvent, ['乙'])");
  p.release(0, p.call(10, { acks: [{ name: '甲', at: 2000 }] })); await first;
  assert.equal(p.run('ackBusy'), true);
  assert.equal(p.run('currentEvent.acks.length'), 0);
  p.release(1, p.call(10, { acks: [{ name: '乙', at: 3000 }] })); await second;
  assert.equal(p.run('ackBusy'), false);
  assert.deepEqual(Array.from(p.run('currentEvent.acks.map(a => a.name)')), ['乙']);
});

test('F18 same-event HTTP and SSE ACKs merge monotonically without renewing expiry or stale fields', async () => {
  const p = displayPage(); p.render(p.call());
  const pending = p.run("sendAck(currentEvent, ['甲'])");
  p.render(p.call(10, { acks: [{ name: '乙', at: 3000 }], queued: 3, message: '最新说明' }));
  const expiry = p.run('expiryLocal'), timer = p.run('expiryTimer'); p.advance(5000);
  p.release(0, p.call(10, { acks: [{ name: '甲', at: 2000 }], queued: 0 })); await pending;
  assert.deepEqual(Array.from(p.run('currentEvent.acks.map(a => a.name).sort()')), ['乙', '甲'].sort());
  assert.equal(p.run('currentEvent.message'), '最新说明');
  assert.equal(p.run('currentEvent.queued'), 3);
  assert.equal(p.run('expiryLocal'), expiry); assert.equal(p.run('expiryTimer'), timer);
  assert.equal(p.get('ack').disabled, true);
  assert.equal(p.get('names').children.every((n) => n.classList.contains('acked')), true);
  p.render(p.call(10, { acks: [{ name: '甲', at: 1000 }] }));
  assert.equal(p.run('currentEvent.acks.length'), 2);
  assert.equal(p.run("currentEvent.acks.find(a => a.name === '甲').at"), 2000);
});

test('F18 late failures are silent; current failures keep retry available', async () => {
  for (const stale of [true, false]) {
    const p = displayPage(); p.render(p.call());
    const pending = p.run('sendAck(currentEvent, [])');
    if (stale) p.render(p.call(11));
    p.requests[0].reject(Error('offline')); await pending;
    assert.equal(p.get('ackNote').textContent, stale ? '' : '连不上服务器，请再点一次');
    assert.equal(p.get('ack').disabled, false);
  }
});
