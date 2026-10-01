'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { start, CLASS_A, CLOSED_TIME, teacherWithAccess, asAdmin, cp } = require('./helpers');
const { setSink } = require('../lib/logger');
const A = CLASS_A.id;
const t = (name, fn) => test(name, { timeout: 20_000 }, fn);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function observe(s) {
  const frames = [];
  const hub = s.app.classes.get(A).sse;
  const broadcast = hub.broadcast.bind(hub);
  hub.broadcast = (frame) => { frames.push(structuredClone(frame)); return broadcast(frame); };
  return frames;
}

async function slowPost(s, cookie, path, value) {
  const firstChunk = deferred();
  const listener = (req) => {
    if (req.url === path) req.once('data', () => firstChunk.resolve());
  };
  s.app.server.on('request', listener);
  const payload = JSON.stringify(value);
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request({ hostname: '127.0.0.1', port: s.port, path, method: 'POST', agent: false,
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    });
    request.on('error', reject);
    request.write(payload.slice(0, 1));
  });
  await firstChunk.promise;
  s.app.server.removeListener('request', listener);
  return { finish: () => { request.end(payload.slice(1)); return response; }, close: () => request.destroy() };
}

for (const [kind, expected] of [['revoke', 403], ['disable', 401], ['logout', 401], ['remove-student', 400], ['archive', 404]]) {
  t(`F03 slow body revalidates ${kind} before publishing`, async () => {
    const s = await start();
    let slow;
    try {
      const { client, admin, user } = await teacherWithAccess(s.base, [A]);
      slow = await slowPost(s, client.cookie, cp(A, 'calls'), { names: ['学生130'], message: 'late body' });
      if (kind === 'revoke') await admin.post('/api/admin/memberships/revoke', { userId: user.id, classId: A });
      if (kind === 'disable') await admin.patch(`/api/admin/users/${user.id}`, { status: 'disabled' });
      if (kind === 'logout') await client.post('/api/auth/logout');
      if (kind === 'remove-student') await admin.put(`/api/admin/classes/${A}/students`, { students: ['学生131'] });
      const frames = observe(s);
      if (kind === 'archive') await admin.patch(`/api/admin/classes/${A}`, { status: 'archived' });
      const before = fs.readFileSync(s.dataFile, 'utf8');
      const result = await slow.finish();
      assert.equal(result.status, expected, JSON.stringify(result));
      assert.equal(fs.readFileSync(s.dataFile, 'utf8'), before);
      assert.equal(s.app.store.get().notices.length, 0);
      assert.equal(frames.length, 0);
      if (kind !== 'archive') assert.equal(s.app.classes.get(A).display.snapshot().type, 'clear');
    } finally { if (slow) slow.close(); await s.stop(); }
  });
}

t('F03 queued transaction rechecks authorization after body and route validation', async () => {
  const s = await start();
  const gate = deferred();
  try {
    const { client, user } = await teacherWithAccess(s.base, [A]);
    const admin = s.app.store.get().users.find((u) => u.role === 'admin');
    const holding = s.app.store.update(() => gate.promise);
    const revoking = s.app.users.revoke({ admin, userId: user.id, classId: A });
    const reached = deferred();
    const original = s.app.notices.call.bind(s.app.notices);
    s.app.notices.call = (args) => { reached.resolve(); return original(args); };
    const frames = observe(s);
    const pending = client.send(A, ['学生130']);
    await reached.promise;
    gate.resolve();
    await holding;
    assert.equal((await revoking).ok, true);
    const res = await pending;
    assert.equal(res.status, 403);
    assert.equal(s.app.store.get().notices.length, 0);
    assert.equal(frames.length, 0);
  } finally { gate.resolve(); await s.stop(); }
});

t('F04 concurrent duplicate class creation returns conflict and preserves one disk row', async () => {
  const s = await start();
  const gate = deferred();
  const pending = [];
  try {
    const admin = await asAdmin(s.base);
    const holding = s.app.store.update(() => gate.promise);
    const queued = deferred();
    const update = s.app.store.update.bind(s.app.store);
    let count = 0;
    s.app.store.update = (mutator) => {
      const result = update(mutator);
      if (++count === 2) queued.resolve();
      return result;
    };
    pending.push(...['first', 'second'].map((name) => admin.post('/api/admin/classes', { id: 'same-id', name, students: [] })));
    await queued.promise;
    gate.resolve();
    await holding;
    const responses = await Promise.all(pending);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(JSON.parse(fs.readFileSync(s.dataFile)).classes.filter((c) => c.id === 'same-id').length, 1);
    assert.ok(s.app.classes.get('same-id'));
  } finally { gate.resolve(); await Promise.allSettled(pending); await s.stop(); }
});

t('F05 resend enforces urgent role, future publication, next-window policy and current signature', async () => {
  const s = await start();
  try {
    const { client, admin } = await teacherWithAccess(s.base, [A]);
    const urgent = await admin.announce(A, { title: '紧急', body: '合成内容', urgent: true });
    assert.equal((await client.cpost(A, `notices/${urgent.json.notice.id}/resend`)).status, 403, 'even while already queued');
    await admin.cpost(A, 'display/clear', { all: true });
    const frames = observe(s);
    assert.equal((await client.cpost(A, `notices/${urgent.json.notice.id}/resend`)).status, 403);
    const future = await client.announce(A, { title: '未来', body: '尚未到时', publishAt: s.clock.now() + 60_000 });
    const pending = await client.cpost(A, `notices/${future.json.notice.id}/resend`);
    assert.equal(pending.status, 200);
    assert.equal(pending.json.notice.status, 'scheduled');
    assert.equal(pending.json.displayedNow, false);
    assert.equal(frames.length, 0);
    await admin.patch('/api/admin/settings', { announcementPolicy: 'next_window' });
    s.clock.set(CLOSED_TIME);
    const n = await client.announce(A, { title: '课间', body: '课间再显示' });
    const resent = await client.cpost(A, `notices/${n.json.notice.id}/resend`);
    assert.equal(resent.json.notice.status, 'scheduled');
    assert.equal(frames.length, 0);
    assert.equal((await admin.cpost(A, `notices/${urgent.json.notice.id}/resend`)).status, 200);
    await admin.cpost(A, 'display/clear', { all: true });
    const normal = await admin.announce(A, { title: '原管理员', body: '重新署名', durationSeconds: 1 });
    await admin.cpost(A, 'display/clear', { all: true });
    await admin.patch('/api/admin/settings', { announcementPolicy: 'immediate' });
    const signed = await client.cpost(A, `notices/${normal.json.notice.id}/resend`);
    assert.equal(signed.json.event.author, '数学老师 · 张老师');
    assert.equal(signed.json.notice.authorName, '管理员', 'original history author is retained');
    assert.equal(signed.json.notice.lastResentByName, '张老师');
    assert.equal(signed.json.event.expiresAt - signed.json.event.createdAt, 1000);
  } finally { await s.stop(); }
});

for (const kind of ['revoke', 'disable', 'delete', 'disable-admin']) {
  t(`F06 scheduled announcements do not publish after ${kind}`, async () => {
    const s = await start();
    try {
      const { client, user, admin } = await teacherWithAccess(s.base, [A]);
      const adminUser = s.app.store.get().users.find((u) => u.role === 'admin');
      const author = kind === 'disable-admin' ? admin : client;
      const response = await author.announce(A, { title: '待发', body: '失权后不广播', publishAt: s.clock.now() + 60_000 });
      if (kind === 'revoke') await admin.post('/api/admin/memberships/revoke', { userId: user.id, classId: A });
      if (kind === 'disable') await admin.patch(`/api/admin/users/${user.id}`, { status: 'disabled' });
      if (kind === 'delete') await admin.del(`/api/admin/users/${user.id}`);
      if (kind === 'disable-admin') await s.app.store.update((db) => { db.users.find((u) => u.id === adminUser.id).status = 'disabled'; });
      const frames = observe(s);
      s.clock.advance(61_000);
      await s.app.scheduler.tick();
      const notice = s.app.notices.get(A, response.json.notice.id);
      assert.equal(notice.status, 'withdrawn');
      assert.ok(notice.withdrawReason);
      assert.equal(frames.length, 0);
      assert.ok(s.app.store.get().auditLogs.some((a) => a.action === 'notice.auto_withdraw' && a.detail.noticeId === notice.id));
      if (kind === 'revoke') {
        await admin.post('/api/admin/memberships', { userId: user.id, classId: A });
        await s.app.scheduler.tick();
        assert.equal(s.app.notices.get(A, notice.id).status, 'withdrawn', 'regrant does not resurrect cancelled publication');
        assert.equal(frames.length, 0);
      }
    } finally { await s.stop(); }
  });
}

for (const failure of ['writeFile', 'rename']) {
  for (const operation of ['call', 'announce', 'publishDue', 'withdraw', 'clear', 'resend', 'windows']) {
    t(`F07 ${operation} leaves disk, runtime and SSE unchanged on ${failure} failure`, async () => {
      const s = await start({ classes: [{ ...CLASS_A, autoClearSeconds: 3600 }] });
      let original;
      try {
        const { client, admin } = await teacherWithAccess(s.base, [A]);
        const seed = await client.announce(A, { title: 'existing', body: 'synthetic', durationSeconds: 0 });
        if (operation === 'resend') await client.cpost(A, 'display/clear', { all: true });
        if (operation === 'publishDue') {
          await client.announce(A, { title: 'due', body: 'synthetic', publishAt: s.clock.now() + 60_000 });
          s.clock.advance(61_000);
        }
        const before = fs.readFileSync(s.dataFile, 'utf8');
        const db = JSON.stringify(s.app.store.get());
        const display = JSON.stringify({ current: s.app.classes.get(A).display.current, queue: s.app.classes.get(A).display.queue });
        const windows = JSON.stringify(s.app.windows.get());
        const frames = observe(s);
        const logs = [];
        setSink((line) => logs.push(JSON.parse(line)));
        original = fs.promises[failure];
        fs.promises[failure] = async (file, ...args) => {
          if (String(file).startsWith(s.app.store.file + '.')) throw Object.assign(new Error('synthetic disk failure'), { code: 'ENOSPC' });
          return original.call(fs.promises, file, ...args);
        };
        const run = () => {
          if (operation === 'call') return client.send(A, ['学生130']);
          if (operation === 'announce') return client.announce(A, { title: 'failed', body: 'synthetic' });
          if (operation === 'publishDue') return s.app.notices.publishDue(s.clock.now());
          if (operation === 'withdraw') return client.cpost(A, `notices/${seed.json.notice.id}/withdraw`);
          if (operation === 'clear') return client.cpost(A, 'display/clear', { all: true });
          if (operation === 'resend') return client.cpost(A, `notices/${seed.json.notice.id}/resend`);
          return admin.put('/api/admin/call-windows', { weekdays: [], windows: [] });
        };
        if (operation === 'publishDue') await assert.rejects(run(), /synthetic disk failure/);
        else assert.equal((await run()).status, 500);
        assert.equal(fs.readFileSync(s.dataFile, 'utf8'), before);
        assert.equal(JSON.stringify(s.app.store.get()), db);
        assert.equal(JSON.stringify({ current: s.app.classes.get(A).display.current, queue: s.app.classes.get(A).display.queue }), display);
        assert.equal(JSON.stringify(s.app.windows.get()), windows);
        assert.equal(frames.length, 0);
        assert.equal(logs.filter((entry) => entry.event === 'audit').length, 0);
        fs.promises[failure] = original;
        original = null;
        const result = await run();
        if (operation === 'publishDue') assert.equal(result, 1);
        else assert.equal(result.status, 200, result.body);
        assert.ok(frames.length <= 1, 'retry performs at most one delivery');
      } finally {
        if (original) fs.promises[failure] = original;
        setSink(() => {});
        await s.stop();
      }
    });
  }
}

t('F07 concurrent publishers reserve capacity within serialized commit queue', async () => {
  const s = await start({ classes: [{ ...CLASS_A, autoClearSeconds: 3600 }] });
  try {
    const { client } = await teacherWithAccess(s.base, [A]);
    const frames = observe(s);
    const results = await Promise.all(Array.from({ length: 30 }, () => client.send(A, ['学生130'])));
    assert.equal(results.filter((r) => r.status === 200).length, 21);
    assert.equal(results.filter((r) => r.status === 429).length, 9);
    assert.equal(s.app.classes.get(A).display.queue.length, 20);
    assert.equal(s.app.store.get().notices.length, 21);
    assert.equal(JSON.parse(fs.readFileSync(s.dataFile)).notices.length, 21);
    assert.equal(frames.length, 21);
  } finally { await s.stop(); }
});

t('F07 scheduled call and sent marker commit atomically, then retry exactly once', async () => {
  const s = await start();
  try {
    const { client } = await teacherWithAccess(s.base, [A]);
    const scheduled = await client.cpost(A, 'schedules', { names: ['学生130'], time: '08:51', weekdays: [1], message: 'once' });
    assert.equal(scheduled.status, 200);
    s.clock.advance(60_000);
    const persist = s.app.store._persist;
    s.app.store._persist = async () => { throw new Error('synthetic write failure'); };
    const frames = observe(s);
    await assert.rejects(s.app.scheduler.tick(), /synthetic write failure/);
    assert.equal(s.app.store.get().scheduleRuns.length, 0);
    assert.equal(s.app.store.get().notices.length, 0);
    assert.equal(frames.length, 0);
    s.app.store._persist = persist;
    await s.app.scheduler.tick();
    await s.app.scheduler.tick();
    assert.equal(s.app.store.get().scheduleRuns.length, 1);
    assert.equal(s.app.store.get().scheduleRuns[0].status, 'sent');
    assert.equal(s.app.store.get().notices.length, 1);
    assert.equal(frames.length, 1);
  } finally { await s.stop(); }
});

t('F05 deferred policy is rechecked at publication and rejects missing school windows', async () => {
  const s = await start();
  try {
    const { client, admin } = await teacherWithAccess(s.base, [A]);
    const future = await client.announce(A, { title: 'scheduled', body: 'synthetic', publishAt: CLOSED_TIME + 60_000 });
    await admin.patch('/api/admin/settings', { announcementPolicy: 'next_window' });
    const frames = observe(s);
    s.clock.set(CLOSED_TIME + 61_000);
    await s.app.notices.publishDue(s.clock.now());
    assert.equal(s.app.notices.get(A, future.json.notice.id).status, 'scheduled');
    assert.ok(s.app.notices.get(A, future.json.notice.id).publishAt > s.clock.now());
    assert.equal(frames.length, 0);
    await admin.put('/api/admin/call-windows', { weekdays: [], windows: [] });
    const result = await client.announce(A, { title: 'no window', body: 'must not publish' });
    assert.equal(result.status, 403);
    assert.equal(result.json.error, 'NO_PUBLISH_WINDOW');
    assert.equal(frames.length, 0);
  } finally { await s.stop(); }
});
