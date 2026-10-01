'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { start, CLASS_A, teacherWithAccess, cp } = require('./helpers');
const A = CLASS_A.id;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

for (const role of ['teacher', 'admin']) {
  test(`Concurrent ${role} partial schedule edit cannot undo a committed disable`, { timeout: 20_000 }, async () => {
    const s = await start();
    const gate = deferred();
    const pending = [];
    try {
      const { client, admin } = await teacherWithAccess(s.base, [A]);
      const created = await client.cpost(A, 'schedules', { names: ['学生130'], time: '08:51', message: 'original' });
      assert.equal(created.status, 200);
      const id = created.json.schedule.id;
      const api = role === 'admin' ? admin : client;
      const url = role === 'admin' ? `/api/admin/schedules/${id}` : cp(A, `schedules/${id}`);
      const holding = s.app.store.update(() => gate.promise);
      const first = deferred();
      const second = deferred();
      const update = s.app.scheduler.update.bind(s.app.scheduler);
      let count = 0;
      s.app.scheduler.update = (args) => {
        (++count === 1 ? first : second).resolve();
        return update(args);
      };
      pending.push(api.patch(url, { enabled: false }));
      await first.promise;
      pending.push(api.patch(url, { message: 'new message only' }));
      await second.promise;
      gate.resolve();
      await holding;
      for (const response of await Promise.all(pending)) assert.equal(response.status, 200, response.body);
      const stored = JSON.parse(fs.readFileSync(s.dataFile)).schedules.find((item) => item.id === id);
      assert.equal(stored.enabled, false);
      assert.equal(stored.message, 'new message only');
      s.clock.advance(60_000);
      await s.app.scheduler.tick();
      assert.equal(s.app.store.get().notices.length, 0);
    } finally {
      gate.resolve();
      await Promise.allSettled(pending);
      await s.stop();
    }
  });
}

test('Queued admin deletion reports a concurrently removed schedule as not found', { timeout: 20_000 }, async () => {
  const s = await start();
  const gate = deferred();
  const pending = [];
  try {
    const { client, admin } = await teacherWithAccess(s.base, [A]);
    const created = await client.cpost(A, 'schedules', { names: ['学生130'], time: '08:51' });
    const id = created.json.schedule.id;
    const holding = s.app.store.update(() => gate.promise);
    const queued = deferred();
    const remove = s.app.scheduler.remove.bind(s.app.scheduler);
    let count = 0;
    s.app.scheduler.remove = (args) => {
      const result = remove(args);
      if (++count === 2) queued.resolve();
      return result;
    };
    pending.push(admin.del(`/api/admin/schedules/${id}`), admin.del(`/api/admin/schedules/${id}`));
    await queued.promise;
    gate.resolve();
    await holding;
    assert.deepEqual((await Promise.all(pending)).map((r) => r.status).sort(), [200, 404]);
    assert.equal(JSON.parse(fs.readFileSync(s.dataFile)).schedules.length, 0);
  } finally {
    gate.resolve();
    await Promise.allSettled(pending);
    await s.stop();
  }
});
