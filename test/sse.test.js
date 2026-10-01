'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { Writable } = require('node:stream');
const { setImmediate: immediate, setTimeout: delay } = require('node:timers/promises');
const { SseHub, SseConnectionLimits } = require('../lib/sse');
const { setSink } = require('../lib/logger');
const { start, openStream } = require('./helpers');

setSink(() => {});

class ControlledResponse extends Writable {
  constructor({ slow = false, highWaterMark = 16 } = {}) {
    super({ highWaterMark });
    this.slow = slow;
    this.chunks = [];
    this.callbacks = [];
    this.status = null;
  }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  setTimeout(ms) { this.timeoutMs = ms; }
  _write(chunk, encoding, callback) {
    this.chunks.push(chunk.toString());
    if (this.slow) this.callbacks.push(callback);
    else callback();
  }
  release() {
    const callback = this.callbacks.shift();
    assert.ok(callback, 'there is a blocked write to complete');
    callback();
  }
}

function connect(hub, { source = 'synthetic-source', role = 'display', slow = false, snapshot = { id: 1, type: 'clear' } } = {}) {
  const req = new EventEmitter();
  req.socket = { remoteAddress: source };
  const res = new ControlledResponse({ slow, highWaterMark: slow ? 16 : 64 * 1024 });
  const client = hub.add(req, res, snapshot, role, source);
  return { req, res, client };
}

function setup(t, options = {}) {
  const limiter = new SseConnectionLimits();
  const hub = new SseHub({ limiter, ...options });
  t.after(() => hub.closeAll());
  return { hub, limiter };
}

test('slow Writable buffering stays bounded; drain sends only latest state and drops stale snapshots/pings', async (t) => {
  const { hub } = setup(t, { maxBufferedBytes: 8192, maxFrameBytes: 8192 });
  const { res, client } = connect(hub, { slow: true, snapshot: { id: 1, body: 'x'.repeat(4096) } });
  const initialBytes = res.writableLength;
  assert.equal(client.blocked, true);
  for (let id = 2; id <= 200; id += 1) {
    hub.broadcast({ id, body: 'x'.repeat(4096) });
    hub._ping();
    assert.equal(res.writableLength, initialBytes, 'write(false) must stop all subsequent writes');
  }
  assert.equal(res.chunks.length, 1);
  assert.ok(Buffer.byteLength(client.pending) < 8192);
  assert.match(client.pending, /id: 200\n/);
  res.release();
  await immediate();
  assert.equal(res.chunks.length, 2);
  assert.match(res.chunks[1], /id: 200\n/);
  assert.equal(client.pending, null);
  assert.equal(client.blocked, true);
  res.release();
  await immediate();
  assert.equal(client.blocked, false);
  assert.equal(res.writableLength, 0);
  assert.equal(res.chunks.some((frame) => frame.includes(': ping')), false);
  hub._ping();
  assert.equal(res.chunks[2], ': ping\n\n');
});

test('latest clear replaces pending call, including backpressure on initial retry/snapshot frame', async (t) => {
  const { hub } = setup(t);
  const { res, client } = connect(hub, { slow: true });
  assert.match(res.chunks[0], /^retry: \d+\n\nid: 1/);
  hub.broadcast({ id: 2, type: 'call', names: ['synthetic'] });
  hub.broadcast({ id: 3, type: 'clear' });
  res.release();
  await immediate();
  assert.match(res.chunks[1], /"type":"clear"/);
  assert.doesNotMatch(res.chunks.join(''), /synthetic/);
  assert.equal(client.pending, null);
});

test('stalled consumers time out, destroy buffered writes and release every quota/listener', async (t) => {
  const { hub, limiter } = setup(t, { slowTimeoutMs: 20 });
  const { req, res, client } = connect(hub, { slow: true });
  hub.broadcast({ id: 2 });
  assert.equal(hub.size, 1);
  await delay(50);
  assert.equal(res.destroyed, true);
  assert.equal(hub.totalSize, 0);
  assert.equal(hub.size, 0);
  assert.equal(limiter.total, 0);
  assert.equal(limiter.sources.size, 0);
  assert.equal(hub.sources.size, 0);
  assert.equal(client.pending, null);
  assert.equal(client.slowTimer, null);
  for (const event of ['error', 'close']) assert.equal(req.listenerCount(event), 0);
  for (const event of ['error', 'close', 'drain', 'timeout']) assert.equal(res.listenerCount(event), 0);
});

test('oversize frame and underlying buffer excess disconnect instead of retaining unbounded state', (t) => {
  const { hub, limiter } = setup(t, { maxFrameBytes: 128, maxBufferedBytes: 128 });
  const first = connect(hub, { slow: true });
  hub.broadcast({ id: 2, body: 'large'.repeat(100) });
  assert.equal(first.res.destroyed, true);
  assert.equal(first.client.pending, null);
  assert.equal(limiter.total, 0);
  const second = connect(hub, { slow: true, source: 'second' });
  Object.defineProperty(second.res, 'writableLength', { value: 129 });
  hub.broadcast({ id: 3 });
  assert.equal(second.res.destroyed, true);
  assert.equal(hub.totalSize, 0);
  assert.equal(limiter.total, 0);
});

test('disconnect/error/socket timeout/closeAll clean up exactly once for every client role', (t) => {
  const { hub, limiter } = setup(t);
  const a = connect(hub, { role: 'display', source: 'a' });
  const b = connect(hub, { role: 'launcher', source: 'b' });
  const c = connect(hub, { role: 'teacher', source: 'c' });
  assert.equal(hub.size, 1);
  assert.equal(hub.count('launcher'), 1);
  assert.equal(hub.count('teacher'), 1);
  assert.equal(a.res.timeoutMs > 0, true, 'SSE socket timeout must not be disabled');
  a.req.emit('close');
  a.req.emit('close');
  b.res.emit('error', new Error('synthetic response error'));
  c.res.emit('timeout');
  assert.equal(hub.totalSize, 0);
  assert.equal(limiter.total, 0);
  assert.equal(limiter.sources.size, 0);
  const fast = connect(hub, { source: 'fast' });
  const slow = connect(hub, { source: 'slow', slow: true });
  hub.closeAll('class_removed');
  assert.match(fast.res.chunks.join(''), /event: bye/);
  assert.equal(fast.res.writableEnded, true);
  assert.equal(slow.res.destroyed, true);
  assert.equal(limiter.total, 0);
  assert.equal(hub.heartbeat._destroyed, true);
  assert.equal(connect(hub).res.status, 503);
  hub.closeAll();
  assert.equal(limiter.total, 0);
});

test('per-hub, per-source and shared global quotas apply to all roles and recover on disconnect', (t) => {
  const limiter = new SseConnectionLimits({ maxTotal: 3, maxPerSource: 2 });
  const hubs = Array.from({ length: 3 }, (_, index) => new SseHub({ classId: String(index), limiter, maxClients: 2, maxPerSource: 1 }));
  t.after(() => hubs.forEach((hub) => hub.closeAll()));
  const first = connect(hubs[0], { source: 'a' });
  const sameHub = connect(hubs[0], { source: 'a', role: 'teacher' });
  assert.equal(sameHub.res.status, 429);
  assert.equal(sameHub.client, null);
  connect(hubs[1], { source: 'a', role: 'launcher' });
  assert.equal(connect(hubs[2], { source: 'a' }).res.status, 429, 'cross-hub source quota');
  connect(hubs[1], { source: 'b', role: 'teacher' });
  assert.equal(limiter.total, 3);
  assert.equal(connect(hubs[2], { source: 'c' }).res.status, 429, 'shared total quota');
  first.req.emit('close');
  const replacement = connect(hubs[2], { source: 'c' });
  assert.equal(replacement.res.status, 200);
  assert.equal(limiter.total, 3);
  replacement.req.emit('close');
  assert.equal(connect(hubs[1], { source: 'd' }).res.status, 429, 'per-hub quota even with global capacity');
  assert.equal(limiter.total, 2, 'denied connections must never consume reservations');
});

test('default hubs use the same process-wide limiter', (t) => {
  const first = new SseHub();
  const second = new SseHub();
  t.after(() => { first.closeAll(); second.closeAll(); });
  assert.strictEqual(first.limiter, second.limiter);
  const baseline = first.limiter.total;
  const a = connect(first, { source: 'shared-test' });
  const b = connect(second, { source: 'shared-test', role: 'launcher' });
  assert.equal(first.limiter.total, baseline + 2);
  a.req.emit('close');
  b.req.emit('close');
  assert.equal(first.limiter.total, baseline);
});

test('real HTTP stream disconnect and app shutdown release global reservations and allow restart', { timeout: 10_000 }, async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const stream = await openStream(s.base, 'class-a');
  const runtime = s.app.classes.get('class-a');
  assert.equal(runtime.sse.size, 1);
  const shared = runtime.sse.limiter;
  const baseline = shared.total - 1;
  const closed = once(stream, 'close');
  stream.destroy();
  await closed;
  await s.app.close();
  assert.equal(runtime.sse.totalSize, 0);
  assert.equal(shared.total, baseline);
  await s.restart();
  const second = await openStream(s.base, 'class-a', 'launcher');
  assert.equal(s.app.classes.get('class-a').sse.count('launcher'), 1);
  second.destroy();
  await s.app.close();
  assert.equal(shared.total, baseline);
});
