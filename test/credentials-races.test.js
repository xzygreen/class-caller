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
const { hashPassword, verifyPassword } = require('../lib/passwords');
const { setSink } = require('../lib/logger');
const clock = require('../lib/clock');
const { LOGIN_LOCK_MS, LOGIN_FAILURE_WINDOW_MS } = require('../lib/constants');

setSink(() => {});
const PASSWORD = 'synthetic-old-password-123';
const initialHash = hashPassword(PASSWORD);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-credentials-races-'));
  const store = new JsonStore(path.join(dir, 'db.json'));
  const now = 1_800_000_000_000;
  clock.use(() => now); // Deliberately keep reset and session timestamps identical.
  t.after(async () => {
    if (store.close) await store.close(); else await store.flush();
    clock.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const hash = await initialHash;
  await store.update((db) => {
    db.users = ['admin', 'teacher'].map((id) => ({
      id, username: id, displayName: id, role: id === 'admin' ? 'admin' : 'teacher', title: '',
      status: 'active', passwordHash: hash, mustChangePassword: false,
      createdAt: now, updatedAt: now, passwordChangedAt: now, lastLoginAt: null,
    }));
  });
  const sessions = new SessionStore({ store });
  const users = new UserService({ store, scheduler: new Scheduler({ store, windows: new CallWindows(null) }) });
  const auth = await users.authenticate('teacher', PASSWORD);
  const session = await sessions.issue(auth.credential, 'test-ip');
  return { store, sessions, users, auth, session, admin: users.byId('admin') };
}

for (const transition of ['reset', 'personal change', 'disable', 'delete']) {
  test(`verified old login cannot issue after ${transition}`, { timeout: 20_000 }, async (t) => {
    const s = await fixture(t);
    const verified = deferred();
    const issue = deferred();
    const login = (async () => {
      const evidence = await s.users.authenticate('teacher', PASSWORD); // Real scrypt; pause only after verification.
      verified.resolve(evidence);
      await issue.promise;
      return s.sessions.issue(evidence.credential, 'in-flight-ip');
    })();
    // Install rejection handling before releasing the deferred request.
    const rejected = assert.rejects(login, { code: transition === 'disable' ? 'ACCOUNT_DISABLED' : 'INVALID_CREDENTIALS' });
    const evidence = await verified.promise;
    assert.notEqual(evidence.user, s.store.get().users.find((u) => u.id === 'teacher'));
    assert.equal(evidence.credential.passwordHash, await initialHash);
    let changed;
    if (transition === 'reset') changed = await s.users.updateUser({ admin: s.admin, userId: 'teacher', changes: { resetPassword: true } });
    if (transition === 'personal change') changed = await s.users.changePassword({ user: s.auth.user, credential: s.auth.credential, newPassword: 'synthetic-new-password-456', keepSessionToken: s.session.token });
    if (transition === 'disable') changed = await s.users.updateUser({ admin: s.admin, userId: 'teacher', changes: { status: 'disabled' } });
    if (transition === 'delete') changed = await s.users.deleteUser({ admin: s.admin, userId: 'teacher' });
    assert.equal(changed.ok, true);
    assert.equal(evidence.credential.passwordHash, await initialHash, 'evidence must not follow the changed live user');
    const before = structuredClone(s.store.get().sessions);
    issue.resolve();
    await rejected;
    assert.deepEqual(s.store.get().sessions, before, 'no session minted by stale login');
    assert.deepEqual(JSON.parse(fs.readFileSync(s.store.file, 'utf8')).sessions, before);
  });
}

test('session issuance validates evidence inside the queued transaction and never accepts a bare user id', async (t) => {
  const s = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const blocking = s.store.update(async (db) => {
    entered.resolve();
    await release.promise;
    db.users.find((u) => u.id === 'teacher').status = 'disabled';
    SessionStore.revokeUserInDb(db, 'teacher');
  });
  await entered.promise;
  const pending = assert.rejects(s.sessions.issue(s.auth.credential, 'ip'), { code: 'ACCOUNT_DISABLED' });
  release.resolve();
  await blocking;
  await pending;
  await assert.rejects(s.sessions.issue('teacher', 'ip'), { code: 'INVALID_CREDENTIALS' });
  assert.equal(s.sessions.count('teacher'), 0);
});

test('resolve uses candidate DB and credential fingerprints, including equal-time password changes', async (t) => {
  const s = await fixture(t);
  const candidate = structuredClone(s.store.get());
  candidate.users.find((u) => u.id === 'teacher').passwordHash = await hashPassword('replacement-password-123');
  assert.equal(s.sessions.resolve(s.session.token).user.id, 'teacher');
  assert.equal(s.sessions.resolve(s.session.token, candidate).reason, 'UNAUTHORIZED');
  const revoked = structuredClone(s.store.get());
  revoked.sessions = [];
  assert.equal(s.sessions.resolve(s.session.token, revoked).reason, 'UNAUTHORIZED');
  const legacy = structuredClone(s.store.get());
  delete legacy.sessions[0].credentialHash;
  assert.equal(s.sessions.resolve(s.session.token, legacy).user.id, 'teacher', 'persisted pre-upgrade sessions still work');
});

test('a queued personal password change cannot overwrite a concurrently committed administrator reset', async (t) => {
  const s = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const blocking = s.store.update(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const originalUpdate = s.store.update.bind(s.store);
  let queued = deferred();
  s.store.update = (...args) => { const result = originalUpdate(...args); queued.resolve(); return result; };
  t.after(() => { s.store.update = originalUpdate; release.resolve(); });
  const reset = s.users.updateUser({ admin: s.admin, userId: 'teacher', changes: { resetPassword: true } });
  await queued.promise;
  queued = deferred();
  const personal = s.users.changePassword({ user: s.auth.user, credential: s.auth.credential, newPassword: 'stale-change-password-123', keepSessionToken: s.session.token });
  await queued.promise;
  release.resolve();
  await blocking;
  const resetResult = await reset;
  assert.equal(resetResult.ok, true);
  assert.deepEqual(await personal, { ok: false, code: 'UNAUTHORIZED' });
  const current = s.users.byId('teacher');
  assert.equal(current.mustChangePassword, true);
  assert.equal(await verifyPassword(resetResult.tempPassword, current.passwordHash), true);
  assert.equal(await verifyPassword('stale-change-password-123', current.passwordHash), false);
  assert.equal(s.sessions.resolve(s.session.token).reason, 'UNAUTHORIZED');
  assert.equal(JSON.parse(fs.readFileSync(s.store.file, 'utf8')).users.find((u) => u.id === 'teacher').passwordHash, current.passwordHash);
});

test('personal change requires a current owned session and verified hash; temporary sessions cannot outlive another reset', async (t) => {
  const s = await fixture(t);
  const input = { user: s.auth.user, credential: s.auth.credential, newPassword: 'new-password-123', keepSessionToken: s.session.token };
  assert.equal((await s.users.changePassword({ ...input, credential: undefined })).code, 'INVALID_PASSWORD');
  assert.equal((await s.users.changePassword({ ...input, credential: { ...s.auth.credential, passwordHash: 'wrong-hash' } })).code, 'INVALID_PASSWORD');
  const adminAuth = await s.users.authenticate('admin', PASSWORD);
  const adminSession = await s.sessions.issue(adminAuth.credential, 'admin-ip');
  assert.equal((await s.users.changePassword({ ...input, keepSessionToken: adminSession.token })).code, 'UNAUTHORIZED');
  const reset = await s.users.updateUser({ admin: s.admin, userId: 'teacher', changes: { resetPassword: true } });
  const temp = await s.users.authenticate('teacher', reset.tempPassword);
  const tempSession = await s.sessions.issue(temp.credential, 'ip');
  const resetAgain = await s.users.updateUser({ admin: s.admin, userId: 'teacher', changes: { resetPassword: true } });
  const rejected = await s.users.changePassword({ user: temp.user, newPassword: 'without-latest-temp-123', keepSessionToken: tempSession.token });
  assert.equal(rejected.code, 'UNAUTHORIZED');
  const fresh = await s.users.authenticate('teacher', resetAgain.tempPassword);
  const freshSession = await s.sessions.issue(fresh.credential, 'ip');
  const changed = await s.users.changePassword({ user: fresh.user, newPassword: 'fresh-password-123', keepSessionToken: freshSession.token });
  assert.equal(changed.ok, true);
  assert.equal(changed.user.mustChangePassword, false);
  assert.equal(s.sessions.resolve(freshSession.token).user.mustChangePassword, false);
  assert.equal(await s.users.authenticate('teacher', resetAgain.tempPassword), null);
});

for (const count of [12, 20]) {
  test(`${count} deferred same-IP registrations reserve at most ten attempts before work`, async () => {
    let now = 1000;
    const sessions = new SessionStore({ store: {}, now: () => now });
    const finish = deferred();
    let started = 0;
    const jobs = Array.from({ length: count }, async () => {
      const attempt = sessions.beginRegistration('same-ip');
      if (!attempt.ok) return attempt;
      started += 1;
      try { await finish.promise; return { ok: true }; }
      finally { attempt.release(); }
    });
    assert.equal(started, 10, 'remaining work rejected synchronously, before the first await');
    assert.equal(sessions.inFlight, 10);
    finish.resolve();
    const results = await Promise.all(jobs);
    assert.equal(results.filter((r) => r.ok).length, 10);
    assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'TOO_MANY_ATTEMPTS'));
    assert.equal(sessions.inFlight, 0);
    assert.equal(sessions.beginRegistration('same-ip').ok, false, 'completion does not refund quota');
    now += 3_600_000;
    const renewed = sessions.beginRegistration('same-ip');
    assert.equal(renewed.ok, true);
    renewed.release();
  });
}

test('failed registrations consume quota and finally releases capacity after errors', async () => {
  const sessions = new SessionStore({ store: {}, maxInFlightPerIp: 1, maxInFlight: 1 });
  for (let i = 0; i < 10; i += 1) {
    const attempt = sessions.beginRegistration('ip');
    assert.equal(attempt.ok, true);
    await assert.rejects((async () => {
      try { throw new Error('synthetic hash or store failure'); }
      finally { attempt.release(); attempt.release(); }
    })(), /synthetic/);
    assert.equal(sessions.inFlight, 0);
  }
  assert.equal(sessions.beginRegistration('ip').ok, false);
  const different = sessions.beginRegistration('different');
  assert.equal(different.ok, true);
  different.release();
});

test('login attempts reserve the failure budget; success never erases other in-flight attempts', () => {
  let now = 1000;
  const sessions = new SessionStore({ store: {}, now: () => now });
  const attempts = Array.from({ length: 5 }, () => sessions.beginLogin('ip', ' Teacher '));
  assert.ok(attempts.every((a) => a.ok));
  assert.equal(sessions.beginLogin('ip', 'teacher').ok, false);
  attempts[0].succeed(); attempts[0].release();
  const replacement = sessions.beginLogin('ip', 'teacher');
  assert.equal(replacement.ok, true);
  assert.equal(sessions.beginLogin('ip', 'teacher').ok, false, 'four pending attempts still occupy the budget');
  for (const a of attempts.slice(1)) a.release();
  replacement.release();
  assert.equal(sessions.inFlight, 0);
  assert.equal(sessions.beginLogin('ip', 'teacher').ok, false);
  now += LOGIN_LOCK_MS;
  const unlocked = sessions.beginLogin('ip', 'teacher');
  assert.equal(unlocked.ok, true);
  unlocked.succeed(); unlocked.release();
  assert.equal(sessions.lockedFor('ip', 'teacher'), 0);
  assert.equal(sessions.failures.size, 0);
});

test('per-IP/global caps are shared across login and registration and remain held beyond rate windows', () => {
  let now = 1000;
  const sessions = new SessionStore({ store: {}, now: () => now, maxInFlightPerIp: 2, maxInFlight: 3 });
  const login = sessions.beginLogin('one', 'user');
  const register = sessions.beginRegistration('one');
  assert.equal(sessions.beginLogin('one', 'other').ok, false);
  const secondIp = sessions.beginLogin('two', 'user');
  assert.equal(sessions.beginRegistration('three').ok, false);
  now += LOGIN_FAILURE_WINDOW_MS + 1;
  assert.equal(sessions.beginLogin('three', 'fresh').ok, false, 'expiry never frees real in-flight work');
  login.succeed(); login.release();
  const available = sessions.beginRegistration('three');
  assert.equal(available.ok, true);
  [register, secondIp, available].forEach((a) => a.release());
  assert.equal(sessions.inFlight, 0);
  assert.equal(sessions.inFlightByIp.size, 0);
});

test('limiter source cardinality is bounded without clearing unexpired quotas', () => {
  const sessions = new SessionStore({ store: {}, now: () => 1000 });
  for (let i = 0; i < 10_000; i += 1) {
    sessions.registrations.set(`ip-${i}`, [1000]);
    sessions.failures.set(JSON.stringify([`ip-${i}`, 'user']), { count: 1, pending: 0, lastAt: 1000 });
  }
  assert.equal(sessions.beginRegistration('new-ip').ok, false);
  assert.equal(sessions.beginLogin('new-ip', 'user').ok, false);
  assert.equal(sessions.registrations.size, 10_000);
  assert.equal(sessions.failures.size, 10_000);
  const known = sessions.beginRegistration('ip-0');
  assert.equal(known.ok, true);
  known.release();
  assert.equal(sessions.registrations.get('ip-0').length, 2);
});
