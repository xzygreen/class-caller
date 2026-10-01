'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setImmediate: settle } = require('node:timers/promises');
const { start, req } = require('./helpers');
const { version } = require('../package.json');
const source = fs.readFileSync(path.join(__dirname, '../public/version.js'), 'utf8');

function browser({ count = 3, hidden = false } = {}) {
  const badges = Array.from({ length: count }, () => ({ hidden: true, textContent: '', attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }));
  const requests = [], windows = new Map(), documents = new Map(), intervals = new Map(), timeouts = new Map();
  let sequence = 0;
  const document = { hidden, querySelectorAll: () => badges, addEventListener: (event, listener) => documents.set(event, listener) };
  vm.runInNewContext(source, {
    document, window: { addEventListener: (event, listener) => windows.set(event, listener) }, AbortController,
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    setInterval: (fn) => { intervals.set(++sequence, fn); return sequence; }, clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { timeouts.set(++sequence, fn); return sequence; }, clearTimeout: (id) => timeouts.delete(id),
  });
  return { badges, requests, windows, documents, document, intervals, timeouts,
    async respond(index, value, ok = true) { requests[index].resolve({ ok, json: async () => value }); await settle(); },
    async poll() { for (const fn of intervals.values()) fn(); await settle(); },
  };
}

test('public deployed version is authoritative, uncached and does not write data', async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const before = fs.readFileSync(s.dataFile);
  const response = await req(s.base, 'GET', '/api/public/version?version=0.0.0', { headers: { 'X-App-Version': '0.0.0' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, version });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal((await req(s.base, 'GET', '/api/public/status')).json.version, version);
  assert.equal((await req(s.base, 'POST', '/api/public/version', { body: {} })).status, 405);
  const missing = await req(s.base, 'GET', '/missing-page');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['cache-control'], 'no-cache');
  assert.ok(missing.body.includes('data-app-version'));
  assert.ok(missing.body.includes('/version.js?v=' + version));
  assert.ok(missing.body.includes('href="/teacher">教师端'));
  assert.ok(!missing.body.includes('/display?class='));
  assert.deepEqual(fs.readFileSync(s.dataFile), before);
});

test('all visible-version badges use the server value rather than an embedded asset version', async () => {
  const b = browser();
  assert.equal(b.requests.length, 1);
  assert.equal(b.requests[0].url, '/api/public/version');
  assert.equal(b.requests[0].options.cache, 'no-store');
  assert.ok(b.badges.every((badge) => badge.hidden));
  await b.respond(0, { ok: true, version: '9.8.7' });
  for (const badge of b.badges) {
    assert.equal(badge.textContent, 'v9.8.7');
    assert.equal(badge.hidden, false);
    assert.equal(badge.attributes['aria-label'], '部署版本 9.8.7');
  }
  await b.poll();
  await b.respond(1, { ok: true, version: '9.8.8-beta.1+build.2' });
  assert.equal(b.badges[0].textContent, 'v9.8.8-beta.1+build.2');
});

test('invalid or failed version responses never fabricate a badge or overwrite a verified value', async () => {
  const b = browser();
  const invalid = [null, {}, { ok: true, version: '<script>bad</script>' }, { ok: true, version: 217 }, { ok: false, version: '2.1.7' }];
  for (let index = 0; index < invalid.length; index++) {
    if (index) await b.poll();
    await b.respond(index, invalid[index]);
    assert.equal(b.badges[0].hidden, true);
  }
  await b.poll();
  await b.respond(invalid.length, { ok: true, version: '2.1.7' });
  await b.poll();
  await b.respond(invalid.length + 1, { ok: true, version: '0.0.0' }, false);
  assert.equal(b.badges[0].textContent, 'v2.1.7');
});

test('page lifecycle cancels polling and ignores old responses after bfcache restoration', async () => {
  const b = browser();
  b.windows.get('pageshow')();
  assert.equal(b.requests.length, 1, 'initial pageshow does not duplicate an in-flight request');
  assert.equal(b.intervals.size, 1);
  b.windows.get('pagehide')();
  assert.equal(b.requests[0].options.signal.aborted, true);
  assert.equal(b.intervals.size, 0);
  b.windows.get('pageshow')();
  assert.equal(b.requests.length, 2);
  await b.respond(1, { ok: true, version: '2.1.8' });
  await b.respond(0, { ok: true, version: '2.1.7' });
  assert.equal(b.badges[0].textContent, 'v2.1.8');
  assert.equal(b.timeouts.size, 0);
});

test('hidden pages and absent version badges do not create unnecessary requests', async () => {
  const empty = browser({ count: 0 });
  assert.equal(empty.requests.length, 0);
  assert.equal(empty.intervals.size, 0);
  const b = browser({ hidden: true });
  assert.equal(b.requests.length, 0);
  b.document.hidden = false;
  b.documents.get('visibilitychange')();
  assert.equal(b.requests.length, 1);
  await b.respond(0, { ok: true, version });
  assert.equal(b.badges[0].textContent, 'v' + version);
});

test('stalled version requests are aborted and a later poll can retry', async () => {
  const b = browser();
  for (const abort of b.timeouts.values()) abort();
  assert.equal(b.requests[0].options.signal.aborted, true);
  b.requests[0].reject(new Error('aborted'));
  await settle();
  assert.equal(b.timeouts.size, 0);
  await b.poll();
  await b.respond(1, { ok: true, version });
  assert.equal(b.badges[0].textContent, 'v' + version);
});
