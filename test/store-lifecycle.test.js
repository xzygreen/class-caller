'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { JsonStore, afterCommit } = require('../lib/store');
const { audit } = require('../lib/audit');
const { setSink } = require('../lib/logger');
const { start, login, register, ADMIN } = require('./helpers');

const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const storeModule = path.join(root, 'lib', 'store.js');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-lifecycle-'));
  const file = path.join(dir, 'db.json');
  const store = new JsonStore(file);
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, store };
}

function owner(t, file) {
  const child = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(root, 'lib/logger.js'))}).setSink(() => {});
    const { JsonStore } = require(${JSON.stringify(storeModule)});
    let store;
    process.on('message', async (message) => {
      if (message === 'open') {
        try {
          store = new JsonStore(process.argv[1]);
          await store.update(db => { db.settings.child = 'committed'; });
          process.send({ acquired: true });
        } catch (err) { process.send({ acquired: false, code: err.code }); }
      } else if (message === 'close') {
        if (store) await store.close();
        process.exit(0);
      }
    });
    process.send({ ready: true });
  `, file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGKILL');
      await done;
    }
  });
  return child;
}

test('lifetime lock rejects another instance, symlink aliases and flush-only reopen', async (t) => {
  const { dir, file, store } = fixture(t);
  const alias = path.join(dir, 'alias');
  fs.symlinkSync(dir, alias, 'dir');
  assert.throws(() => new JsonStore(file), { code: 'STORE_LOCKED' });
  assert.throws(() => new JsonStore(path.join(alias, 'db.json')), { code: 'STORE_LOCKED' });
  await store.flush();
  assert.throws(() => new JsonStore(file), { code: 'STORE_LOCKED' });
  await store.close();
  const reopened = new JsonStore(file);
  await reopened.close();
  await assert.rejects(store.update(() => {}), { code: 'STORE_CLOSED' });
});

test('close drains accepted transactions and effects before releasing writer ownership', async (t) => {
  const { file, store } = fixture(t);
  const entered = deferred();
  const release = deferred();
  const effects = [];
  const first = store.update(async (db, tx) => {
    db.settings.first = true;
    tx.afterCommit(() => effects.push('committed'));
    entered.resolve();
    await release.promise;
  });
  const second = store.update((db) => { db.settings.second = true; });
  await entered.promise;
  const closing = store.close();
  assert.strictEqual(store.close(), closing);
  assert.throws(() => new JsonStore(file), { code: 'STORE_LOCKED' });
  await assert.rejects(store.update(() => {}), { code: 'STORE_CLOSED' });
  release.resolve();
  await Promise.all([first, second, closing]);
  const reopened = new JsonStore(file);
  try {
    assert.equal(reopened.get().settings.first, true);
    assert.equal(reopened.get().settings.second, true);
    assert.deepEqual(effects, ['committed']);
  } finally { await reopened.close(); }
});

test('simultaneous processes never acquire two lifetime writer claims', { timeout: 10_000 }, async (t) => {
  const { file, store } = fixture(t);
  await store.close();
  const children = Array.from({ length: 5 }, () => owner(t, file));
  await Promise.all(children.map((child) => once(child, 'message')));
  const replies = children.map((child) => once(child, 'message'));
  children.forEach((child) => child.send('open'));
  const results = (await Promise.all(replies)).map(([message]) => message);
  assert.ok(results.filter((r) => r.acquired).length <= 1, JSON.stringify(results));
  assert.ok(results.every((r) => r.acquired || r.code === 'STORE_LOCKED'));
  await Promise.all(children.map((child) => {
    const done = once(child, 'exit');
    child.send('close');
    return done;
  }));
  const reopened = new JsonStore(file);
  await reopened.close();
});

test('killed writer recovers safely without deleting a live claimant or losing committed data', { timeout: 10_000 }, async (t) => {
  const { file, store } = fixture(t);
  await store.close();
  const child = owner(t, file);
  await once(child, 'message');
  const opened = once(child, 'message');
  child.send('open');
  assert.equal((await opened)[0].acquired, true);
  assert.throws(() => new JsonStore(file), { code: 'STORE_LOCKED' });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const recovered = new JsonStore(file);
  try {
    assert.equal(recovered.get().settings.child, 'committed');
    assert.equal(fs.readdirSync(`${file}.lock`).length, 1, 'dead claim replaced by exactly one live claim');
  } finally { await recovered.close(); }
});

test('failed load releases own claim and unknown lock entries fail closed', async (t) => {
  const { file, store } = fixture(t);
  await store.close();
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new JsonStore(file), SyntaxError);
  assert.deepEqual(fs.readdirSync(`${file}.lock`), []);
  fs.writeFileSync(file, original);
  const unknown = path.join(`${file}.lock`, 'unrecognized-owner');
  fs.writeFileSync(unknown, '');
  assert.throws(() => new JsonStore(file), { code: 'STORE_LOCKED' });
  assert.equal(fs.existsSync(unknown), true);
  fs.unlinkSync(unknown);
  const reopened = new JsonStore(file);
  await reopened.close();
});

test('failed claim creation cleans up its partial owner file', async (t) => {
  const { file, store } = fixture(t);
  await store.close();
  const original = fs.writeFileSync.bind(fs);
  const replacement = t.mock.method(fs, 'writeFileSync', (...args) => {
    original(...args);
    if (String(args[0]).endsWith('.owner')) throw Object.assign(new Error('synthetic claim failure'), { code: 'EIO' });
  });
  assert.throws(() => new JsonStore(file), /synthetic claim failure/);
  assert.deepEqual(fs.readdirSync(`${file}.lock`), []);
  replacement.mock.restore();
  const reopened = new JsonStore(file);
  await reopened.close();
});

test('candidate remains invisible until persistence; effects and success audit run before next transaction', async (t) => {
  const { file, store } = fixture(t);
  const entered = deferred();
  const release = deferred();
  const committed = store.get();
  const events = [];
  const order = [];
  setSink((line) => events.push(JSON.parse(line)));
  t.after(() => setSink(() => {}));
  const persist = store._persist.bind(store);
  store._persist = async (candidate) => {
    assert.notStrictEqual(candidate, store.get());
    entered.resolve();
    await release.promise;
    await persist(candidate);
  };
  const first = store.update((db, tx) => {
    db.settings.value = 'new';
    audit(db, { action: 'synthetic.commit' });
    tx.afterCommit(() => {
      assert.equal(store.get().settings.value, 'new');
      assert.equal(JSON.parse(fs.readFileSync(file)).settings.value, 'new');
      order.push('tx-effect');
    });
    afterCommit(db, () => order.push('db-effect'));
    return 42;
  });
  await entered.promise;
  assert.strictEqual(store.get(), committed);
  assert.equal(store.get().settings.value, undefined);
  assert.equal(events.filter((e) => e.event === 'audit').length, 0);
  const second = store.update(() => { order.push('next-mutator'); });
  release.resolve();
  assert.equal(await first, 42);
  await second;
  assert.deepEqual(order, ['tx-effect', 'db-effect', 'next-mutator']);
  assert.equal(events.filter((e) => e.event === 'audit').length, 1);
  assert.throws(() => afterCommit(store.get(), () => {}), /inside a store.update/);
});

test('mutator or injected persistence failure discards candidate and every success effect', async (t) => {
  const { file, store } = fixture(t);
  const committed = store.get();
  const disk = fs.readFileSync(file, 'utf8');
  const events = [];
  setSink((line) => events.push(JSON.parse(line)));
  t.after(() => setSink(() => {}));
  let calls = 0;
  const mutate = (db, tx) => {
    db.settings.value = 'not-committed';
    audit(db, { action: 'synthetic.rollback' });
    tx.afterCommit(() => { calls += 1; });
  };
  await assert.rejects(store.update((db, tx) => { mutate(db, tx); throw new Error('mutator failed'); }), /mutator failed/);
  const persist = store._persist;
  store._persist = async () => { throw new Error('synthetic ENOSPC'); };
  await assert.rejects(store.update(mutate), /ENOSPC/);
  assert.strictEqual(store.get(), committed);
  assert.equal(fs.readFileSync(file, 'utf8'), disk);
  assert.equal(calls, 0);
  assert.equal(events.filter((e) => e.event === 'audit').length, 0);
  store._persist = persist;
  await store.update(mutate);
  assert.equal(calls, 1);
  assert.equal(events.filter((e) => e.event === 'audit').length, 1);
});

for (const operation of ['writeFile', 'rename']) {
  test(`failed ${operation} leaves disk, committed view and audit unchanged and removes temporary files`, async (t) => {
    const { dir, file, store } = fixture(t);
    const before = fs.readFileSync(file, 'utf8');
    const original = fs.promises[operation].bind(fs.promises);
    const replacement = t.mock.method(fs.promises, operation, async (...args) => {
      if (String(args[0]).startsWith(`${store.file}.`) && String(args[0]).endsWith('.tmp')) {
        if (operation === 'writeFile') await original(...args); // partial temporary file also must be cleaned.
        throw Object.assign(new Error(`synthetic ${operation} failure`), { code: 'ENOSPC' });
      }
      return original(...args);
    });
    await assert.rejects(store.update((db) => {
      db.settings.failed = true;
      audit(db, { action: 'synthetic.failed' });
    }), /synthetic/);
    assert.equal(store.get().settings.failed, undefined);
    assert.equal(store.get().auditLogs.length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
    replacement.mock.restore();
    await store.update((db) => { db.settings.recovered = true; });
    assert.equal(store.get().settings.recovered, true);
  });
}

test('throwing postcommit effect is reported as committed; later effects and transactions still run', async (t) => {
  const { file, store } = fixture(t);
  const events = [];
  setSink((line) => events.push(JSON.parse(line)));
  t.after(() => setSink(() => {}));
  const order = [];
  const value = await store.update((db, tx) => {
    db.settings.committed = true;
    tx.afterCommit(() => { throw new Error('synthetic delivery failure'); });
    tx.afterCommit(() => order.push('later-effect'));
    return 'success';
  });
  await store.update(() => { order.push('next-update'); });
  assert.equal(value, 'success');
  assert.equal(JSON.parse(fs.readFileSync(file)).settings.committed, true);
  assert.deepEqual(order, ['later-effect', 'next-update']);
  assert.equal(events.find((e) => e.event === 'store_after_commit_failed').committed, true);
  await assert.rejects(store.update((db, tx) => {
    db.settings.invalid = true;
    tx.afterCommit(async () => {});
  }), /synchronous/);
  assert.equal(store.get().settings.invalid, undefined);
});

test('real init-admin refuses active app, then initializes offline; restart/login/registration retain admin', { timeout: 15_000 }, async (t) => {
  const s = await start({ admin: null });
  t.after(() => s.stop());
  const env = {
    ...process.env, DATA_DIR: path.dirname(s.dataFile), LEGACY_CONFIG: path.join(s.dir, 'students.json'),
    ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password, ADMIN_NAME: ADMIN.displayName,
  };
  const initialize = () => exec(process.execPath, [path.join(root, 'scripts/init-admin.js')], { cwd: root, env, timeout: 5000 });
  const before = fs.readFileSync(s.dataFile, 'utf8');
  await assert.rejects(initialize(), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /数据仓库正在使用|先停止服务/);
    assert.doesNotMatch(err.stdout, /已创建管理员/);
    return true;
  });
  assert.equal(fs.readFileSync(s.dataFile, 'utf8'), before);
  assert.equal(s.app.users.hasAdmin(), false);
  await s.app.close();
  const result = await initialize();
  assert.match(result.stdout, /已创建管理员/);
  assert.deepEqual(fs.readdirSync(`${s.dataFile}.lock`), [], 'CLI explicitly releases its claim');
  await s.restart();
  assert.ok(await login(s.base, ADMIN.username, ADMIN.password));
  await register(s.base);
  assert.equal(s.app.users.hasAdmin(), true);
  assert.equal(JSON.parse(fs.readFileSync(s.dataFile)).users.filter((u) => u.role === 'admin').length, 1);
  await s.app.close();
  await assert.rejects(initialize(), (err) => err.code === 2 && /已经存在/.test(err.stderr));
  assert.deepEqual(fs.readdirSync(`${s.dataFile}.lock`), []);
});
