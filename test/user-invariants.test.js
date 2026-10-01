'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../lib/store');
const { SessionStore } = require('../lib/auth');
const { UserService } = require('../lib/users');
const { Scheduler } = require('../lib/scheduler');
const { CallWindows } = require('../lib/timewin');
const { hashPassword } = require('../lib/passwords');
const { setSink } = require('../lib/logger');

setSink(() => {});
const initialHash = hashPassword('synthetic-password-123');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-user-invariants-'));
  const store = new JsonStore(path.join(dir, 'db.json'));
  t.after(async () => {
    if (store.close) await store.close(); else await store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const passwordHash = await initialHash;
  await store.update((db) => {
    db.users = ['admin-a', 'admin-b', 'teacher'].map((id) => ({
      id, username: id, displayName: id, role: id.startsWith('admin') ? 'admin' : 'teacher',
      status: 'active', passwordHash, mustChangePassword: false, createdAt: 1, updatedAt: 1, passwordChangedAt: 1,
    }));
    db.classes = [{ id: 'class-a', name: 'Synthetic class', status: 'active', students: ['Synthetic student'] }];
  });
  const users = new UserService({ store, scheduler: new Scheduler({ store, windows: new CallWindows(null) }) });
  return { store, users, admin: users.byId('admin-a'), adminB: users.byId('admin-b'), teacher: users.byId('teacher') };
}

/** Hold a real preceding update until every competing service has actually enqueued its write (including hashes). */
async function queuedRace(s, operations) {
  const entered = deferred();
  const release = deferred();
  const allQueued = deferred();
  const original = s.store.update.bind(s.store);
  const blocking = original(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let queued = 0;
  s.store.update = (...args) => {
    const promise = original(...args);
    if (++queued === operations.length) allQueued.resolve();
    return promise;
  };
  try {
    const pending = operations.map((op) => op());
    const settled = Promise.allSettled(pending);
    await allQueued.promise;
    s.store.update = original;
    release.resolve();
    await blocking;
    const results = await settled;
    assert.deepEqual(JSON.parse(fs.readFileSync(s.store.file, 'utf8')), JSON.parse(JSON.stringify(s.store.get())), 'committed memory and disk agree');
    return results.map((r) => {
      if (r.status === 'rejected') throw r.reason;
      return r.value;
    });
  } finally {
    s.store.update = original;
    release.resolve();
    await blocking;
  }
}

const activeAdmins = (s) => s.store.get().users.filter((u) => u.role === 'admin' && u.status === 'active');

test('concurrent self-disable operations preserve the last active administrator', async (t) => {
  const s = await fixture(t);
  const results = await queuedRace(s, [
    () => s.users.updateUser({ admin: s.admin, userId: s.admin.id, changes: { status: 'disabled' } }),
    () => s.users.updateUser({ admin: s.adminB, userId: s.adminB.id, changes: { status: 'disabled' } }),
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, false]);
  assert.equal(results[1].code, 'LAST_ADMIN');
  assert.equal(activeAdmins(s).length, 1);
  assert.equal(s.store.get().auditLogs.filter((r) => r.action === 'user.update').length, 1);
});

test('concurrent cross-deletes recheck the acting account and cannot remove both administrators', async (t) => {
  const s = await fixture(t);
  const results = await queuedRace(s, [
    () => s.users.deleteUser({ admin: s.admin, userId: s.adminB.id }),
    () => s.users.deleteUser({ admin: s.adminB, userId: s.admin.id }),
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, false]);
  assert.equal(results[1].code, 'UNAUTHORIZED');
  assert.equal(activeAdmins(s).length, 1);
  assert.equal(s.store.get().auditLogs.filter((r) => r.action === 'user.delete').length, 1);
});

test('concurrent registration/admin creation cannot save duplicate normalized usernames', async (t) => {
  const s = await fixture(t);
  const value = { username: 'competing-user', displayName: 'Synthetic', title: '', password: 'synthetic-new-password-123' };
  const results = await queuedRace(s, [
    () => s.users.register({ ...value, username: ' COMPETING-USER ' }),
    () => s.users.createUser({ admin: s.admin, value, role: 'teacher' }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.find((r) => !r.ok).code, 'USERNAME_TAKEN');
  assert.equal(s.store.get().users.filter((u) => u.username === value.username).length, 1);
});

test('concurrent duplicate requests create only one pending request', async (t) => {
  const s = await fixture(t);
  const results = await queuedRace(s, [
    () => s.users.requestAccess({ user: s.teacher, classId: 'class-a', reason: 'first' }),
    () => s.users.requestAccess({ user: s.teacher, classId: 'class-a', reason: 'second' }),
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, false]);
  assert.equal(results[1].code, 'REQUEST_PENDING');
  assert.equal(s.store.get().accessRequests.length, 1);
  assert.equal(s.store.get().auditLogs.filter((r) => r.action === 'access.request').length, 1);
});

for (const first of ['approve', 'reject', 'cancel']) {
  test(`${first} wins a competing access-request transition without contradictory membership`, async (t) => {
    const s = await fixture(t);
    const request = await s.users.requestAccess({ user: s.teacher, classId: 'class-a', reason: '' });
    const act = (kind) => kind === 'cancel'
      ? s.users.cancelRequest({ user: s.teacher, requestId: request.request.id })
      : s.users.decideRequest({ admin: s.admin, requestId: request.request.id, approve: kind === 'approve' });
    const second = first === 'approve' ? 'reject' : 'approve';
    const results = await queuedRace(s, [() => act(first), () => act(second)]);
    assert.deepEqual(results.map((r) => r.ok), [true, false]);
    assert.equal(results[1].code, 'REQUEST_ALREADY_DECIDED');
    assert.equal(s.store.get().accessRequests[0].status, { approve: 'approved', reject: 'rejected', cancel: 'cancelled' }[first]);
    assert.equal(s.users.canAccess(s.teacher, 'class-a'), first === 'approve');
    assert.equal(s.store.get().memberships.length, first === 'approve' ? 1 : 0);
  });
}

test('direct grant settles pending requests atomically and competing rejection conflicts', async (t) => {
  const s = await fixture(t);
  const request = await s.users.requestAccess({ user: s.teacher, classId: 'class-a', reason: '' });
  const results = await queuedRace(s, [
    () => s.users.grant({ admin: s.admin, userId: s.teacher.id, classId: 'class-a' }),
    () => s.users.decideRequest({ admin: s.adminB, requestId: request.request.id, approve: false }),
  ]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].code, 'REQUEST_ALREADY_DECIDED');
  assert.equal(s.store.get().accessRequests[0].status, 'approved');
  assert.equal(s.users.canAccess(s.teacher, 'class-a'), true);
});

test('grant first blocks a queued redundant request; duplicate revoke cannot report two successes', async (t) => {
  const s = await fixture(t);
  const results = await queuedRace(s, [
    () => s.users.grant({ admin: s.admin, userId: s.teacher.id, classId: 'class-a' }),
    () => s.users.requestAccess({ user: s.teacher, classId: 'class-a', reason: '' }),
  ]);
  assert.equal(results[1].code, 'ALREADY_MEMBER');
  assert.equal(s.store.get().accessRequests.length, 0);
  const revocations = await queuedRace(s, [
    () => s.users.revoke({ admin: s.admin, userId: s.teacher.id, classId: 'class-a' }),
    () => s.users.revoke({ admin: s.adminB, userId: s.teacher.id, classId: 'class-a' }),
  ]);
  assert.deepEqual(revocations.map((r) => r.ok), [true, false]);
  assert.equal(revocations[1].code, 'NO_CLASS_ACCESS');
  assert.equal(s.store.get().memberships[0].status, 'revoked');
});

test('user deletion wins against delayed reset, grant and approval without orphan state or missing-user crash', async (t) => {
  const s = await fixture(t);
  const request = await s.users.requestAccess({ user: s.teacher, classId: 'class-a', reason: '' });
  const results = await queuedRace(s, [
    () => s.users.deleteUser({ admin: s.admin, userId: s.teacher.id }),
    () => s.users.updateUser({ admin: s.admin, userId: s.teacher.id, changes: { resetPassword: true } }),
    () => s.users.grant({ admin: s.admin, userId: s.teacher.id, classId: 'class-a' }),
    () => s.users.decideRequest({ admin: s.admin, requestId: request.request.id, approve: true }),
  ]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].code, 'USER_NOT_FOUND');
  assert.equal(results[2].code, 'USER_NOT_FOUND');
  assert.equal(results[3].code, 'REQUEST_NOT_FOUND');
  assert.equal(s.store.get().accessRequests.length, 0);
  assert.equal(s.store.get().memberships.length, 0);
});

for (const unavailable of ['archived', 'removed']) {
  test(`class ${unavailable} while work waits blocks grant, request and approval`, async (t) => {
    const s = await fixture(t);
    const pending = await s.users.requestAccess({ user: s.teacher, classId: 'class-a', reason: '' });
    const results = await queuedRace(s, [
      () => s.store.update((db) => {
        if (unavailable === 'removed') db.classes = [];
        else db.classes[0].status = 'archived';
        return { ok: true };
      }),
      () => s.users.grant({ admin: s.admin, userId: s.teacher.id, classId: 'class-a' }),
      () => s.users.requestAccess({ user: s.teacher, classId: 'class-a', reason: 'delayed' }),
      () => s.users.decideRequest({ admin: s.admin, requestId: pending.request.id, approve: true }),
    ]);
    assert.ok(results.slice(1).every((r) => r.code === 'CLASS_NOT_FOUND'));
    assert.equal(s.store.get().memberships.length, 0);
    assert.equal(s.store.get().accessRequests[0].status, 'pending');
  });
}

test('disabled teacher snapshots cannot request/cancel access or receive new authorization', async (t) => {
  const s = await fixture(t);
  const request = await s.users.requestAccess({ user: s.teacher, classId: 'class-a', reason: '' });
  const results = await queuedRace(s, [
    () => s.users.updateUser({ admin: s.admin, userId: s.teacher.id, changes: { status: 'disabled' } }),
    () => s.users.cancelRequest({ user: s.teacher, requestId: request.request.id }),
    () => s.users.requestAccess({ user: s.teacher, classId: 'class-a', reason: '' }),
    () => s.users.grant({ admin: s.admin, userId: s.teacher.id, classId: 'class-a' }),
    () => s.users.decideRequest({ admin: s.admin, requestId: request.request.id, approve: true }),
  ]);
  assert.ok(results.slice(1).every((r) => r.code === 'ACCOUNT_DISABLED'));
  assert.equal(s.store.get().accessRequests[0].status, 'pending');
  assert.equal(s.store.get().memberships.length, 0);
});

test('current administrator state protects delayed account creation and updates', async (t) => {
  const s = await fixture(t);
  const results = await queuedRace(s, [
    () => s.users.updateUser({ admin: s.adminB, userId: s.admin.id, changes: { status: 'disabled' } }),
    () => s.users.createUser({ admin: s.admin, value: { username: 'late-user', displayName: 'Synthetic', password: 'synthetic-new-password-123' }, role: 'admin' }),
    () => s.users.updateUser({ admin: s.admin, userId: s.teacher.id, changes: { displayName: 'Unauthorized replacement' } }),
    () => s.users.deleteUser({ admin: s.admin, userId: s.teacher.id }),
  ]);
  assert.ok(results.slice(1).every((r) => r.code === 'ACCOUNT_DISABLED'));
  assert.equal(s.users.byUsername('late-user'), null);
  assert.equal(s.users.byId(s.teacher.id).displayName, s.teacher.displayName);
});

test('authorize checks live session inside a mutator and stale role snapshots grant no authority', async (t) => {
  const s = await fixture(t);
  const sessions = new SessionStore({ store: s.store });
  const session = await sessions.issue({ userId: s.admin.id, passwordHash: s.admin.passwordHash }, 'ip');
  let checked = false;
  const authorize = (db) => {
    checked = true;
    const resolved = sessions.resolve(session.token, db);
    if (!resolved.user) throw Object.assign(new Error('revoked'), { code: 'UNAUTHORIZED', status: 401 });
    return resolved.user;
  };
  await assert.rejects(queuedRace(s, [
    () => sessions.revoke(session.token),
    () => s.users.grant({ admin: s.admin, userId: s.teacher.id, classId: 'class-a', authorize }),
  ]), { code: 'UNAUTHORIZED' });
  assert.equal(checked, true);
  assert.equal(s.store.get().memberships.length, 0);
  await s.store.update((db) => { db.users.find((u) => u.id === s.admin.id).role = 'teacher'; });
  assert.equal((await s.users.deleteUser({ admin: s.admin, userId: s.teacher.id })).code, 'ADMIN_ONLY');
  assert.equal(s.users.canAccess(s.admin, 'class-a'), false);
  await assert.rejects(s.users.revokeAllSessions({ admin: s.admin }), { code: 'ADMIN_ONLY' });
});
