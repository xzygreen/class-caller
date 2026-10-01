'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { TEACHER, start, req, cookieOf, asAdmin, register } = require('./helpers');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const t = (name, fn) => test(name, { timeout: 20_000 }, fn);
const disk = (s) => JSON.parse(fs.readFileSync(s.dataFile, 'utf8'));

for (const count of [12, 20]) {
  t(`HTTP ${count} concurrent registrations admit at most ten before expensive work and return 429 for the rest`, async () => {
    const s = await start();
    const examined = deferred();
    const release = deferred();
    const beginRegistration = s.app.sessions.beginRegistration.bind(s.app.sessions);
    const realRegister = s.app.users.register.bind(s.app.users);
    let attempts = 0;
    let admitted = 0;
    let requests = [];
    try {
      // Observe the real limiter; pause only admitted work, without replacing any validation/hash/persistence.
      s.app.sessions.beginRegistration = (ip) => {
        const result = beginRegistration(ip);
        if (++attempts === count) examined.resolve();
        return result;
      };
      s.app.users.register = async (input) => {
        admitted += 1;
        await release.promise;
        return realRegister(input);
      };
      requests = Array.from({ length: count }, (_, i) => req(s.base, 'POST', '/api/auth/register', {
        body: { ...TEACHER, username: `burst-user-${i}` },
      }));
      const finished = Promise.all(requests);
      await examined.promise;
      assert.ok(admitted > 0 && admitted <= 10, `${admitted} admitted before any registration completed`);
      assert.equal(s.app.sessions.inFlight, admitted);
      assert.equal(s.app.store.get().users.length, 1, 'only the synthetic bootstrap admin exists while work is paused');
      release.resolve();
      const responses = await finished;
      const accepted = responses.filter((r) => r.status === 200);
      const rejected = responses.filter((r) => r.status === 429);
      assert.equal(accepted.length, admitted);
      assert.equal(rejected.length, count - admitted);
      assert.ok(rejected.length >= count - 10);
      for (const response of rejected) {
        assert.equal(response.json.error, 'TOO_MANY_ATTEMPTS');
        assert.ok(Number(response.headers['retry-after']) >= 1);
        assert.equal(cookieOf(response), '');
      }
      assert.equal(s.app.store.get().users.filter((u) => u.username.startsWith('burst-user-')).length, admitted);
      assert.equal(disk(s).users.filter((u) => u.username.startsWith('burst-user-')).length, admitted);
      assert.equal(disk(s).sessions.length, admitted);
      assert.equal(s.app.sessions.inFlight, 0, 'finally releases successful and refused work');
      assert.equal(s.app.sessions.inFlightByIp.size, 0);
      assert.equal((await req(s.base, 'GET', '/api/me', { cookie: cookieOf(accepted[0]) })).status, 200);
      // Completed registrations remain counted; concurrency capacity is not the hourly quota.
      if (admitted === 10) {
        const next = await req(s.base, 'POST', '/api/auth/register', { body: { ...TEACHER, username: 'burst-extra' } });
        assert.equal(next.status, 429);
        assert.equal(disk(s).users.length, 11);
      }
    } finally {
      release.resolve();
      await Promise.allSettled(requests);
      s.app.sessions.beginRegistration = beginRegistration;
      s.app.users.register = realRegister;
      await s.stop(); // app.close awaits store.close before the temporary directory is removed.
    }
  });
}

for (const transition of ['reset', 'personal change', 'disable', 'delete']) {
  t(`HTTP verified old-password login is refused after concurrent ${transition}`, async () => {
    const s = await start();
    const release = deferred();
    const verified = deferred();
    const realAuthenticate = s.app.users.authenticate.bind(s.app.users);
    let pending;
    let held = false;
    try {
      const admin = await asAdmin(s.base);
      const { user, client } = await register(s.base);
      s.app.users.authenticate = async (...args) => {
        const result = await realAuthenticate(...args);
        if (!held && args[0] === TEACHER.username && args[1] === TEACHER.password) {
          held = true;
          verified.resolve(result);
          await release.promise;
        }
        return result;
      };
      pending = req(s.base, 'POST', '/api/auth/login', { body: { username: TEACHER.username, password: TEACHER.password } });
      const evidence = await verified.promise;
      assert.ok(evidence && evidence.credential, 'the old password actually passed real scrypt verification');
      const verifiedHash = evidence.credential.passwordHash;
      let changed;
      if (transition === 'reset') changed = await admin.patch(`/api/admin/users/${user.id}`, { resetPassword: true });
      if (transition === 'personal change') changed = await client.post('/api/me/password', { currentPassword: TEACHER.password, newPassword: 'synthetic-replacement-123' });
      if (transition === 'disable') changed = await admin.patch(`/api/admin/users/${user.id}`, { status: 'disabled' });
      if (transition === 'delete') changed = await admin.del(`/api/admin/users/${user.id}`);
      assert.equal(changed.status, 200, changed.body);
      assert.equal(evidence.credential.passwordHash, verifiedHash, 'credential evidence remains the originally checked hash');
      const before = structuredClone(s.app.store.get().sessions);
      const lastLoginAt = s.app.users.byId(user.id)?.lastLoginAt;
      release.resolve();
      const response = await pending;
      assert.equal(response.status, transition === 'disable' ? 403 : 401, response.body);
      assert.equal(response.json.error, transition === 'disable' ? 'ACCOUNT_DISABLED' : 'INVALID_CREDENTIALS');
      assert.equal(cookieOf(response), '', 'the refused login cannot return a usable cookie');
      assert.deepEqual(s.app.store.get().sessions, before);
      assert.deepEqual(disk(s).sessions, before);
      assert.equal(s.app.users.byId(user.id)?.lastLoginAt, lastLoginAt);
      assert.equal(s.app.sessions.inFlight, 0, 'failed issuance releases the anonymous-work reservation');
      const existing = await client.get('/api/me');
      assert.equal(existing.status, transition === 'personal change' ? 200 : 401);
      if (transition === 'reset') {
        assert.equal(s.app.users.byId(user.id).mustChangePassword, true);
        const takeover = await req(s.base, 'POST', '/api/me/password', { cookie: cookieOf(response), body: { newPassword: 'unauthorized-takeover-123' } });
        assert.equal(takeover.status, 401);
      }
    } finally {
      release.resolve();
      if (pending) await pending.catch(() => {});
      s.app.users.authenticate = realAuthenticate;
      await s.stop();
    }
  });
}

t('HTTP password-change request verified before reset cannot overwrite the reset password', async () => {
  const s = await start();
  const entered = deferred();
  const release = deferred();
  const realChangePassword = s.app.users.changePassword.bind(s.app.users);
  let pending;
  try {
    const admin = await asAdmin(s.base);
    const { user, client } = await register(s.base);
    s.app.users.changePassword = async (input) => {
      entered.resolve(input);
      await release.promise;
      return realChangePassword(input);
    };
    pending = client.post('/api/me/password', { currentPassword: TEACHER.password, newPassword: 'stale-request-password-123' });
    const input = await entered.promise;
    assert.ok(input.credential, 'route passes the actually verified old credential');
    assert.equal(typeof input.authorize, 'function');
    const reset = await admin.patch(`/api/admin/users/${user.id}`, { resetPassword: true });
    assert.equal(reset.status, 200, reset.body);
    const resetHash = s.app.users.byId(user.id).passwordHash;
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 401, response.body);
    assert.equal(response.json.error, 'UNAUTHORIZED');
    assert.equal(s.app.users.byId(user.id).passwordHash, resetHash);
    assert.equal(disk(s).users.find((u) => u.id === user.id).passwordHash, resetHash);
    assert.equal(s.app.users.byId(user.id).mustChangePassword, true);
    assert.equal((await client.get('/api/me')).status, 401);
    const correct = await req(s.base, 'POST', '/api/auth/login', { body: { username: TEACHER.username, password: reset.json.tempPassword } });
    assert.equal(correct.status, 200, correct.body);
    const stale = await req(s.base, 'POST', '/api/auth/login', { body: { username: TEACHER.username, password: 'stale-request-password-123' } });
    assert.equal(stale.status, 401);
  } finally {
    release.resolve();
    if (pending) await pending.catch(() => {});
    s.app.users.changePassword = realChangePassword;
    await s.stop();
  }
});

t('HTTP same-account concurrent failures reserve five attempts before scrypt, then lock subsequent login', async () => {
  const s = await start();
  const release = deferred();
  const examined = deferred();
  const beginLogin = s.app.sessions.beginLogin.bind(s.app.sessions);
  const realAuthenticate = s.app.users.authenticate.bind(s.app.users);
  const count = 12;
  let attempts = 0;
  let admitted = 0;
  let requests = [];
  try {
    s.app.sessions.beginLogin = (...args) => {
      const result = beginLogin(...args);
      if (++attempts === count) examined.resolve();
      return result;
    };
    s.app.users.authenticate = async (...args) => {
      admitted += 1;
      await release.promise;
      return realAuthenticate(...args);
    };
    requests = Array.from({ length: count }, () => req(s.base, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'synthetic-wrong-password' } }));
    const finished = Promise.all(requests);
    await examined.promise;
    assert.equal(admitted, 5);
    assert.equal(s.app.sessions.inFlight, 5);
    release.resolve();
    const responses = await finished;
    assert.equal(responses.filter((r) => r.status === 401).length, 5);
    assert.equal(responses.filter((r) => r.status === 429).length, count - 5);
    assert.ok(responses.every((r) => cookieOf(r) === ''));
    assert.equal(disk(s).sessions.length, 0);
    assert.equal(s.app.sessions.inFlight, 0);
    const locked = await req(s.base, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin-pass-123' } });
    assert.equal(locked.status, 429);
    assert.equal(admitted, 5, 'locked attempt never invokes scrypt');
  } finally {
    release.resolve();
    await Promise.allSettled(requests);
    s.app.sessions.beginLogin = beginLogin;
    s.app.users.authenticate = realAuthenticate;
    await s.stop();
  }
});
