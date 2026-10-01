'use strict';

// Dependency-free browser test transport. Node >=22 (built-in WebSocket) + local
// Chrome/Chromium. CHROME_PATH selects an executable; no downloads or user profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const names = process.platform === 'win32' ? ['chrome.exe', 'msedge.exe'] : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((key) => process.env[key] ? [path.join(process.env[key], 'Google/Chrome/Application/chrome.exe'), path.join(process.env[key], 'Microsoft/Edge/Application/msedge.exe')] : []),
    ...(process.env.PATH || '').split(path.delimiter).flatMap((dir) => names.map((name) => path.join(dir, name))),
  ];
  return candidates.find((file) => file && fs.existsSync(file));
}

// Cleanup is deliberately independent of the launcher child's exit event: Linux
// launchers may exit before the real browser and its profile-writing descendants.
async function settleWithin(action, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function removeProfile(profile, { remove = fs.promises.rm, pause = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await remove(profile, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt >= 7 || !['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      // Async backoff lets final process/IO completion callbacks run. Synchronous
      // rimraf retries starved those callbacks and could race Chrome's final writes.
      await pause(Math.min(100 * (attempt + 1), 500));
    }
  }
}

function createBrowserCleanup(child, profile, getConnection, {
  signal = (pid, name) => process.kill(pid, name), pause = delay, remove = fs.promises.rm,
  platform = process.platform, cdpTimeoutMs = 1500, graceMs = 500, termMs = 1500, killMs = 1000,
} = {}) {
  let closing;
  return function close() {
    if (closing) return closing;
    closing = (async () => {
      const connection = getConnection();
      const errors = [];
      // Browser.close addresses the actual browser, even when CHROME_PATH is a
      // shell wrapper. A disconnected/stalled CDP transport is a normal fallback.
      if (connection) {
        try { await settleWithin(() => connection.send('Browser.close'), cdpTimeoutMs); } catch {}
        try { connection.close(); } catch (error) { errors.push(error); }
      }
      try {
        if (child.pid) {
          if (platform === 'win32') {
            await pause(graceMs);
            if (child.exitCode === null && child.signalCode === null) {
              await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: termMs + killMs, windowsHide: true });
            }
          } else {
            // spawn(detached:true) gives just this launch its own process group.
            // Never signal PID 0 or the test runner's process group.
            const group = -child.pid;
            const send = (name) => {
              try { signal(group, name); return true; }
              catch (error) { if (error.code === 'ESRCH') return false; throw error; }
            };
            const waitForExit = async (ms) => {
              for (let elapsed = 0; elapsed < ms; elapsed += 50) {
                if (!send(0)) return true;
                await pause(Math.min(50, ms - elapsed));
              }
              return !send(0);
            };
            if (!await waitForExit(graceMs)) {
              send('SIGTERM');
              if (!await waitForExit(termMs)) {
                send('SIGKILL');
                // Zombie descendants can retain the group ID until init reaps
                // them; they cannot write the profile. Do not wait indefinitely.
                await waitForExit(killMs);
              }
            }
          }
        }
      } catch (error) { errors.push(error); }
      finally {
        // A stuck launcher pipe must not keep the test runner alive after bounded
        // process cleanup. Profile failure must not skip the remaining releases.
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        child.unref();
      }
      try { await removeProfile(profile, { remove, pause }); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Chrome cleanup failed');
    })();
    return closing;
  };
}

async function closeBrowserAndServer(browser, server) {
  const errors = [];
  try { if (browser) await browser.close(); } catch (error) { errors.push(error); }
  try { await server.stop(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Browser test cleanup failed');
}

class Connection {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.errors = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails);
    });
    socket.addEventListener('close', () => this.rejectPending());
  }
  rejectPending() {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Chrome connection closed')); }
    this.pending.clear();
  }
  close() {
    this.rejectPending();
    this.socket.close();
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Chrome connection closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
}

async function launch(executablePath = findChrome()) {
  if (!executablePath) throw new Error('Chrome unavailable. Set CHROME_PATH to a local Chrome/Chromium executable.');
  if (typeof WebSocket !== 'function') throw new Error('Native CDP tests require Node >=22 with built-in WebSocket.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-browser-'));
  const args = ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'];
  // Some root-only CI images require this explicit opt-in; never disable locally by default.
  if (process.env.CHROME_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  const child = spawn(executablePath, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', spawnError, connection;
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-5000); });
  child.on('error', (error) => { spawnError = error; });
  const close = createBrowserCleanup(child, profile, () => connection);
  try {
    let port;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (spawnError || (child.exitCode !== null && child.exitCode !== 0)) throw spawnError || new Error('Chrome exited: ' + stderr);
      try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
      if (port) break;
      await delay(100);
    }
    if (!port) throw new Error('Chrome did not expose CDP: ' + stderr);
    const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    connection = new Connection(socket);
    return {
      version: version.Browser, errors: connection.errors, close,
      async page({ width = 1366, height = 768, cookie, base } = {}) {
        const { browserContextId } = await connection.send('Target.createBrowserContext');
        const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank', browserContextId });
        const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
        const send = (method, params) => connection.send(method, params, sessionId);
        await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        const page = {
          send,
          async evaluate(expression) {
            const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
            return result.result.value;
          },
          async waitFor(expression, timeout = 10000) {
            const until = Date.now() + timeout;
            do { if (await page.evaluate(expression)) return; await delay(30); } while (Date.now() < until);
            throw new Error('Browser condition timed out: ' + expression);
          },
          async goto(url) {
            await send('Page.navigate', { url });
            await page.waitFor('location.href.split("#")[0] === ' + JSON.stringify(url.split('#')[0]) + ' && document.readyState === "complete"');
          },
          async resize(width, height) {
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          },
          async key(key, code = key) {
            await send('Page.bringToFront');
            const virtual = { Tab: 9, Escape: 27, Enter: 13, PageDown: 34, End: 35, ArrowDown: 40 }[key];
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
          },
          async ax() { return (await send('Accessibility.getFullAXTree')).nodes.filter((node) => !node.ignored); },
          async close() { await connection.send('Target.disposeBrowserContext', { browserContextId }); },
        };
        await page.resize(width, height);
        if (cookie) {
          const split = cookie.indexOf('=');
          await send('Network.setCookie', { name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base, httpOnly: true });
        }
        return page;
      },
    };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Chrome launch and cleanup failed'); }
    throw error;
  }
}

module.exports = { findChrome, launch, createBrowserCleanup, closeBrowserAndServer };
