'use strict';

/**
 * 测试公用：起一个实例（临时数据目录），提供登录、班级作用域请求与 SSE 帮手。
 * 时间可注入：start({ now }) 后通过 s.clock.set(ms) 控制服务端「当前时间」。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createApp } = require('../lib/app');
const { setSink } = require('../lib/logger');
const { zonedToMs } = require('../lib/timewin');
const clock = require('../lib/clock');

setSink(() => {});

const CLASS_A = {
  id: 'class-a', name: '甲班', code: '01', color: 'blue',
  autoClearSeconds: 30, launcher: { mode: 'protocol', freshSeconds: 30 },
  students: ['学生130', '学生131', '学生132'],
};
const CLASS_B = {
  id: 'class-b', name: '乙班', code: '02', color: 'green',
  autoClearSeconds: 30, launcher: { mode: 'off', freshSeconds: 30 },
  // 与甲班有同名学生「学生131」，用于验证同名不串记录
  students: ['学生131', '李四', '赵六'],
};

const ADMIN = { username: 'admin', password: 'admin-pass-123', displayName: '管理员' };
const TEACHER = { username: 'zhang', password: 'teacher-pass-1', displayName: '张老师', title: '数学老师' };
const TEACHER2 = { username: 'liwei', password: 'teacher-pass-2', displayName: '李老师', title: '班主任' };

/** 2026-09-21（周一）08:50 上海时间：在允许点人的时段内 */
const OPEN_TIME = zonedToMs('2026-09-21', 8 * 60 + 50);
/** 2026-09-21（周一）09:05：上课中 */
const CLOSED_TIME = zonedToMs('2026-09-21', 9 * 60 + 5);

function makeClock(initial) {
  let offset = initial === undefined ? 0 : initial - Date.now();
  return {
    now: () => Date.now() + offset,
    set(ms) { offset = ms - Date.now(); },
    advance(ms) { offset += ms; },
  };
}

/** 启动实例：默认两个班、一个管理员；可选 at 指定服务端时间 */
async function start({ classes = [CLASS_A, CLASS_B], at = OPEN_TIME, admin = ADMIN, seedClasses = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const legacy = path.join(dir, 'students.json');
  if (seedClasses) fs.writeFileSync(legacy, JSON.stringify({ version: 2, classes: classes.map((c) => ({ ...c, password: 'legacy-' + c.id })) }));
  const clk = makeClock(at);
  clock.use(clk.now);
  const app = createApp({
    dataFile: path.join(dir, 'data', 'db.json'),
    publicDir: path.join(__dirname, '..', 'public'),
    legacyConfig: seedClasses ? legacy : null,
    initialAdmin: admin,
    scheduler: false,
  });
  await app.bootstrap();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    app, port, base, dir, clock: clk, classes,
    dataFile: path.join(dir, 'data', 'db.json'),
    async stop() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function req(base, method, urlPath, { body, cookie, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : null);
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
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

function cookieOf(res) {
  const set = res.headers['set-cookie'];
  if (!set || !set.length) return '';
  return set[0].split(';')[0];
}

const cp = (classId, sub) => `/api/classes/${classId}/${sub}`;

/** 登录 → 会话 Cookie */
async function login(base, username, password) {
  const res = await req(base, 'POST', '/api/auth/login', { body: { username, password } });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${res.body}`);
  return cookieOf(res);
}

/** 已登录的客户端 */
function session(base, cookie) {
  const call = (method, p, body) => req(base, method, p, { cookie, body });
  return {
    cookie,
    get: (p) => call('GET', p),
    post: (p, body = {}) => call('POST', p, body),
    patch: (p, body = {}) => call('PATCH', p, body),
    put: (p, body = {}) => call('PUT', p, body),
    del: (p) => call('DELETE', p),
    // 班级作用域
    cget: (classId, sub) => call('GET', cp(classId, sub)),
    cpost: (classId, sub, body = {}) => call('POST', cp(classId, sub), body),
    send: (classId, names, message = '') => call('POST', cp(classId, 'calls'), { names, message }),
    announce: (classId, body) => call('POST', cp(classId, 'announcements'), body),
  };
}

async function asAdmin(base) { return session(base, await login(base, ADMIN.username, ADMIN.password)); }

/** 注册教师并返回已登录客户端 */
async function register(base, t = TEACHER) {
  const res = await req(base, 'POST', '/api/auth/register', { body: t });
  if (res.status !== 200) throw new Error(`register ${t.username} failed: ${res.status} ${res.body}`);
  return { client: session(base, cookieOf(res)), user: res.json.user };
}

/** 注册教师 + 管理员直接授权若干班级 */
async function teacherWithAccess(base, classIds, t = TEACHER) {
  const admin = await asAdmin(base);
  const { client, user } = await register(base, t);
  for (const classId of classIds) {
    const res = await admin.post('/api/admin/memberships', { userId: user.id, classId });
    if (res.status !== 200) throw new Error(`grant failed: ${res.body}`);
  }
  return { client, user, admin };
}

const ack = (base, classId, body) => req(base, 'POST', cp(classId, 'public/ack'), { body });

/** 连上某个班的公开 SSE，收集事件，直到拿够 n 条或超时 */
function sse(base, classId, n, { role = 'display', timeoutMs = 2500, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const p = role === 'teacher' ? cp(classId, 'stream') : cp(classId, `public/stream?role=${role}`);
    const url = new URL(p, base);
    const events = [];
    let buf = '';
    const r = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, agent: false, headers: cookie ? { Cookie: cookie } : {} },
      (res) => {
        if (res.statusCode !== 200) { r.destroy(); return resolve({ status: res.statusCode, events }); }
        res.on('data', (c) => {
          buf += c.toString();
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = block.split('\n').find((l) => l.startsWith('data: '));
            if (line) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
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
function openStream(base, classId, role = 'display', cookie) {
  return new Promise((resolve, reject) => {
    const p = role === 'teacher' ? cp(classId, 'stream') : cp(classId, `public/stream?role=${role}`);
    const url = new URL(p, base);
    const r = http.get({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, agent: false, headers: cookie ? { Cookie: cookie } : {} });
    r.on('response', (res) => { if (res.statusCode !== 200) { r.destroy(); return reject(new Error('stream ' + res.statusCode)); } res.once('data', () => resolve(r)); });
    r.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  CLASS_A, CLASS_B, ADMIN, TEACHER, TEACHER2, OPEN_TIME, CLOSED_TIME,
  start, req, cp, cookieOf, login, session, asAdmin, register, teacherWithAccess, ack, sse, openStream, sleep, zonedToMs,
};
