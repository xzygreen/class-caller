'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createBrowserCleanup, closeBrowserAndServer } = require('./browser-cdp-support.cjs');

const gone = () => Object.assign(new Error('No such process'), { code: 'ESRCH' });
const notEmpty = () => Object.assign(new Error('Profile is still being written'), { code: 'ENOTEMPTY' });
function fakeChild(log, exitCode = null) {
  return { pid: 4321, exitCode, signalCode: null,
    stderr: { destroy() { log.push('pipe.destroy'); } },
    unref() { log.push('child.unref'); },
  };
}

test('browser cleanup asks actual Chrome to close, retries async profile removal, and is idempotent', async () => {
  const log = [], child = fakeChild(log);
  let attempts = 0;
  const connection = { async send(method) { log.push(method); }, close() { log.push('connection.close'); } };
  const close = createBrowserCleanup(child, '/synthetic-profile', () => connection, {
    platform: 'linux', signal() { throw gone(); },
    pause: async (ms) => { log.push('pause:' + ms); },
    remove: async (file, options) => {
      assert.equal(file, '/synthetic-profile'); assert.deepEqual(options, { recursive: true, force: true });
      log.push('remove'); if (++attempts < 3) throw notEmpty();
    },
  });
  const first = close(), second = close();
  assert.equal(first, second, 'concurrent callers share one cleanup');
  await Promise.all([first, second]);
  assert.equal(close(), first, 'cleanup remains idempotent after completion');
  assert.deepEqual(log, ['Browser.close', 'connection.close', 'pipe.destroy', 'child.unref', 'remove', 'pause:100', 'remove', 'pause:200', 'remove']);
});

test('cleanup signals the detached group after the launcher exits and escalates ignored TERM to KILL', async () => {
  const log = [], child = fakeChild(log, 0);
  let alive = true;
  const close = createBrowserCleanup(child, '/synthetic-profile', () => ({
    async send(method) { log.push(method); throw new Error('CDP disconnected'); },
    close() { log.push('connection.close'); },
  }), {
    platform: 'linux', graceMs: 0, termMs: 100, killMs: 100,
    pause: async () => {},
    signal(pid, name) {
      assert.equal(pid, -4321, 'must signal the isolated group, not only the exited wrapper');
      if (!alive) throw gone();
      if (name) log.push(name);
      if (name === 'SIGKILL') alive = false;
    },
    remove: async () => { assert.equal(alive, false); log.push('remove'); },
  });
  await close();
  assert.deepEqual(log, ['Browser.close', 'connection.close', 'SIGTERM', 'SIGKILL', 'pipe.destroy', 'child.unref', 'remove']);
});

test('stalled CDP close is bounded and still reaches process and profile cleanup', { timeout: 2000 }, async () => {
  const log = [];
  const close = createBrowserCleanup(fakeChild(log), '/synthetic-profile', () => ({
    send() { log.push('Browser.close'); return new Promise(() => {}); },
    close() { log.push('connection.close'); },
  }), {
    platform: 'linux', cdpTimeoutMs: 1, signal() { throw gone(); },
    remove: async () => { log.push('remove'); },
  });
  await close();
  assert.deepEqual(log, ['Browser.close', 'connection.close', 'pipe.destroy', 'child.unref', 'remove']);
});

test('permanent ENOTEMPTY is bounded and never prevents the HTTP fixture from stopping', async () => {
  const log = [], server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let attempts = 0, pauses = 0;
  const close = createBrowserCleanup(fakeChild(log, 0), '/synthetic-profile', () => null, {
    platform: 'linux', signal() { throw gone(); }, pause: async () => { pauses++; },
    remove: async () => { attempts++; throw notEmpty(); },
  });
  try {
    await assert.rejects(closeBrowserAndServer({ close }, { stop: async () => {
      log.push('server.stop');
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } }), (error) => error instanceof AggregateError && error.errors[0].errors[0].code === 'ENOTEMPTY');
    assert.equal(server.listening, false);
    assert.equal(attempts, 8); assert.equal(pauses, 7);
    assert.equal(log.at(-1), 'server.stop');
    await assert.rejects(close());
    assert.equal(attempts, 8, 'a rejected cleanup must not start another deletion/signal race');
  } finally { if (server.listening) await new Promise((resolve) => server.close(resolve)); }
});

test('browser and server cleanup failures are both retained, including missing browser startup', async () => {
  const browserError = new Error('browser cleanup'), serverError = new Error('server cleanup');
  let stopped = 0;
  await assert.rejects(closeBrowserAndServer({ close: async () => { throw browserError; } }, {
    stop: async () => { stopped++; throw serverError; },
  }), (error) => { assert.deepEqual(error.errors, [browserError, serverError]); return true; });
  assert.equal(stopped, 1);
  await closeBrowserAndServer(undefined, { stop: async () => { stopped++; } });
  assert.equal(stopped, 2);
});

test('POSIX wrapper fixture: exited launcher and TERM-resistant profile writer leave no live descendant', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-cleanup-test-'));
  const writer = `const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    setInterval(() => { fs.mkdirSync(${JSON.stringify(profile)}, { recursive: true }); fs.writeFileSync(${JSON.stringify(path.join(profile, 'heartbeat'))}, 'synthetic'); }, 5);
    process.send('ready');`;
  const wrapper = `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', () => { console.log(child.pid); child.disconnect(); child.unref(); process.exit(0); });`;
  const child = spawn(process.execPath, ['-e', wrapper], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  const ready = new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (data) => { output += data; if (output.includes('\n')) resolve(Number(output.trim())); });
    child.on('error', reject);
  });
  let readyTimer;
  try {
    const descendant = await Promise.race([
      ready,
      exited.then(() => { throw new Error('Wrapper exited before reporting its descendant'); }),
      new Promise((resolve, reject) => { readyTimer = setTimeout(() => reject(new Error('Wrapper startup timed out')), 5000); }),
    ]);
    clearTimeout(readyTimer);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.ok(descendant > 0);
    process.kill(descendant, 0);
    const close = createBrowserCleanup(child, profile, () => null, { graceMs: 0, termMs: 100, killMs: 100 });
    await close(); await close();
    assert.equal(fs.existsSync(profile), false);
    // Orphans may briefly remain as zombies on Linux until init reaps them;
    // SIGKILLed zombies are not running profile writers.
    let state = '';
    try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(descendant)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch (error) { if (error.status !== 1) throw error; }
    assert.ok(!state || state.startsWith('Z'), 'descendant must be gone or reaped-pending zombie, got ' + state);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    child.stdout?.destroy(); child.unref();
    await fs.promises.rm(profile, { recursive: true, force: true });
  }
});
