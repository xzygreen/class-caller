'use strict';

/**
 * 测试公用：起一个多班级实例，提供带班级作用域的请求、登录与 SSE 帮手。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createApp } = require('../lib/app');
const { setSink } = require('../lib/logger');

setSink(() => {});   // 测试期间不往 stdout 刷日志

const CLASS_A = {
  id: 'class-a', name: '甲班', code: '01', color: 'blue', password: 'pass-a',
  autoClearSeconds: 30, launcher: { mode: 'protocol', freshSeconds: 30 },
  students: ['学生130', '学生131', '学生132'],
};
const CLASS_B = {
  id: 'class-b', name: '乙班', code: '02', color: 'green', password: 'pass-b',
  autoClearSeconds: 30, launcher: { mode: 'off', freshSeconds: 30 },
  // 与甲班有同名学生「学生131」，用于验证同名不串记录
  students: ['学生131', '李四', '赵六'],
};

function configJson(classes) {
  return JSON.stringify({ version: 2, classes });
}

function writeConfig(classes = [CLASS_A, CLASS_B]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const file = path.join(dir, 'students.json');
  fs.writeFileSync(file, configJson(classes));
  return { dir, file };
}

/** 覆盖某个班的字段后启动 */
async function start({ a = {}, b = {}, classes } = {}) {
  const list = classes || [{ ...CLASS_A, ...a }, { ...CLASS_B, ...b }];
  const { dir, file } = writeConfig(list);
  const app = createApp({ configFile: file, publicDir: path.join(__dirname, '..', 'public') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    app, port, base, configFile: file, classes: list,
    async stop() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function req(base, method, urlPath, { body, token, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : null);
    const h = { ...headers };
    if (token) h['x-teacher-token'] = token;
    if (payload !== null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: h, agent: false },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: data, json });
        });
      },
    );
    r.on('error', reject);
    if (payload !== null) r.write(payload);
    r.end();
  });
}

const cp = (classId, sub) => `/api/classes/${classId}/${sub}`;

/** 选班 + 密码 → 令牌 */
async function login(base, classId, password) {
  const res = await req(base, 'POST', cp(classId, 'teacher/login'), { body: { password } });
  if (res.status !== 200) throw new Error(`login ${classId} failed: ${res.status} ${res.body}`);
  return res.json.token;
}

/** 已登录的班级客户端 */
async function client(base, classId, password) {
  const token = await login(base, classId, password);
  const call = (method, sub, body) => req(base, method, cp(classId, sub), { token, body });
  return {
    classId, token,
    get: (sub) => call('GET', sub),
    post: (sub, body = {}) => call('POST', sub, body),
    send: (names, message = '', caller) => call('POST', 'teacher/call', {
      names, message, ...(caller ? { caller } : {}),
    }),
    // 用这个班的令牌去访问另一个班
    cross: (otherId, method, sub, body) => req(base, method, cp(otherId, sub), { token, body }),
  };
}

const ack = (base, classId, body) => req(base, 'POST', cp(classId, 'public/ack'), { body });

/** 连上某个班的 SSE，收集事件，直到拿够 n 条或超时 */
function sse(base, classId, n, { role = 'display', timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(cp(classId, `public/stream?role=${role}`), base);
    const events = [];
    let buf = '';
    const r = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, agent: false },
      (res) => {
        res.on('data', (c) => {
          buf += c.toString();
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = block.split('\n').find((l) => l.startsWith('data: '));
            if (line) {
              try { events.push(JSON.parse(line.slice(6))); } catch {}
            }
          }
          if (events.length >= n) { r.destroy(); resolve(events); }
        });
      },
    );
    r.on('error', (e) => { if (events.length >= n) resolve(events); else reject(e); });
    setTimeout(() => { r.destroy(); resolve(events); }, timeoutMs).unref();
  });
}

/** 打开并保持一条 SSE 连接（返回 request，调用方负责 destroy） */
function openStream(base, classId, role = 'display') {
  return new Promise((resolve, reject) => {
    const url = new URL(cp(classId, `public/stream?role=${role}`), base);
    const r = http.get({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, agent: false });
    r.on('response', (res) => { res.once('data', () => resolve(r)); });
    r.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  CLASS_A, CLASS_B, configJson, writeConfig, start, req, cp, login, client, ack, sse, openStream, sleep,
};
