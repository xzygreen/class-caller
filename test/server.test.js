'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const {
  CLASS_A, CLASS_B, configJson, start, req, cp, client, sse, openStream, sleep,
} = require('./helpers');

// 超时写在这里而不是用 --test-timeout 命令行参数：
// 那个参数要 Node 18.19+ / 20.11+ 才有，而 options.timeout 从 18.7 起就支持。
const TIMEOUT = 20_000;
const t = (name, fn) => test(name, { timeout: TIMEOUT }, fn);

const A = CLASS_A.id;
const STUDENTS = CLASS_A.students;

// ---------------------------------------------------------------- 公开接口

t('GET /api/public/classes 只返回班级 id/名称/编号/颜色', async () => {
  const s = await start();
  const res = await req(s.base, 'GET', '/api/public/classes');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.json.classes, [
    { id: 'class-a', name: '甲班', code: '01', color: 'blue' },
    { id: 'class-b', name: '乙班', code: '02', color: 'green' },
  ]);
  assert.ok(!res.body.includes('pass-a'), '不能泄露密码');
  assert.ok(!res.body.includes('学生130'), '不能泄露名单');
  await s.stop();
});

t('GET 班级 public/config 不暴露学生名单，并带 classId', async () => {
  const s = await start();
  const res = await req(s.base, 'GET', cp(A, 'public/config'));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.strictEqual(res.json.classId, 'class-a');
  assert.strictEqual(res.json.className, '甲班');
  assert.strictEqual(res.json.code, '01');
  assert.strictEqual(res.json.autoClearSeconds, 30);
  assert.strictEqual(res.json.needPassword, true);
  assert.strictEqual(res.json.students, undefined, '公开接口不能带学生名单');
  await s.stop();
});

t('不存在的班级返回 404 CLASS_NOT_FOUND', async () => {
  const s = await start();
  for (const p of [cp('class-zz', 'public/config'), cp('class-zz', 'public/stream'), cp('Bad_Id', 'public/config')]) {
    const res = await req(s.base, 'GET', p);
    assert.strictEqual(res.status, 404, p);
    assert.strictEqual(res.json.error, 'CLASS_NOT_FOUND');
  }
  await s.stop();
});

t('旧的无班级接口返回 410，不落到任何班', async () => {
  const s = await start();
  for (const [method, p] of [
    ['GET', '/api/public/config'], ['GET', '/api/public/stream'], ['POST', '/api/public/ack'],
    ['GET', '/api/teacher/students'], ['POST', '/api/teacher/call'],
  ]) {
    const res = await req(s.base, method, p, { body: {} });
    assert.strictEqual(res.status, 410, p);
    assert.strictEqual(res.json.error, 'LEGACY_ENDPOINT');
  }
  await s.stop();
});

// ---------------------------------------------------------------- 登录

t('学生名单需要登录令牌；密码错误不发令牌', async () => {
  const s = await start();
  const anon = await req(s.base, 'GET', cp(A, 'teacher/students'));
  assert.strictEqual(anon.status, 401);
  assert.strictEqual(anon.json.error, 'UNAUTHORIZED');

  const wrong = await req(s.base, 'POST', cp(A, 'teacher/login'), { body: { password: 'nope' } });
  assert.strictEqual(wrong.status, 401);
  assert.strictEqual(wrong.json.error, 'INVALID_PASSWORD');
  assert.strictEqual(wrong.json.token, undefined);

  const bogus = await req(s.base, 'GET', cp(A, 'teacher/students'), { token: 'not-a-token' });
  assert.strictEqual(bogus.status, 401);

  const a = await client(s.base, A, CLASS_A.password);
  const ok = await a.get('teacher/students');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.classId, 'class-a');
  assert.deepStrictEqual(ok.json.students, STUDENTS);
  await s.stop();
});

t('登录响应带班级信息与过期时间；登出后令牌立即失效', async () => {
  const s = await start();
  const res = await req(s.base, 'POST', cp(A, 'teacher/login'), { body: { password: CLASS_A.password } });
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.json.token === 'string' && res.json.token.length >= 32);
  assert.ok(res.json.expiresAt > Date.now());
  assert.deepStrictEqual(res.json.class, { classId: 'class-a', className: '甲班', code: '01', color: 'blue' });

  const out = await req(s.base, 'POST', cp(A, 'teacher/logout'), { token: res.json.token, body: {} });
  assert.strictEqual(out.status, 200);
  const after = await req(s.base, 'GET', cp(A, 'teacher/status'), { token: res.json.token });
  assert.strictEqual(after.status, 401);
  await s.stop();
});

t('连续密码错误后短暂锁定，返回 429', async () => {
  const s = await start();
  for (let i = 0; i < 5; i += 1) {
    const res = await req(s.base, 'POST', cp(A, 'teacher/login'), { body: { password: 'x' } });
    assert.strictEqual(res.status, 401);
  }
  const locked = await req(s.base, 'POST', cp(A, 'teacher/login'), { body: { password: CLASS_A.password } });
  assert.strictEqual(locked.status, 429, '正确密码在锁定期内也不放行');
  assert.strictEqual(locked.json.error, 'TOO_MANY_ATTEMPTS');
  assert.ok(locked.headers['retry-after']);
  // 锁定只针对这个班：乙班仍可正常登录
  const b = await req(s.base, 'POST', cp(CLASS_B.id, 'teacher/login'), { body: { password: CLASS_B.password } });
  assert.strictEqual(b.status, 200);
  await s.stop();
});

t('GET teacher/status 返回本班大屏数与当前状态', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const res = await a.get('teacher/status');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.classId, 'class-a');
  assert.strictEqual(res.json.displays, 0);
  assert.strictEqual(res.json.current.type, 'clear');
  assert.strictEqual(res.json.current.classId, 'class-a');
  assert.ok(res.json.current.serverTime > 0);
  await s.stop();
});

// ---------------------------------------------------------------- 找人通知

t('POST teacher/call 正常发送找人通知，快照带 classId 与找人身份', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const res = await a.send(['学生130', '学生131'], '到讲台来', '数学老师');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  const ev = res.json.event;
  assert.strictEqual(ev.type, 'call');
  assert.strictEqual(ev.classId, 'class-a');
  assert.deepStrictEqual(ev.names, ['学生130', '学生131']);
  assert.strictEqual(ev.caller, '数学老师');
  assert.strictEqual(res.json.record.caller, '数学老师');
  assert.ok(ev.id > 0, '事件必须有 id');
  assert.ok(ev.createdAt > 0);
  assert.ok(ev.expiresAt > ev.createdAt, 'autoClearSeconds>0 时必须有过期时间');
  const payload = JSON.parse(Buffer.from(ev.launchPayload, 'base64url').toString('utf8'));
  assert.strictEqual(payload.classId, 'class-a', '启动载荷也要带班级');
  assert.strictEqual(payload.caller, undefined, '旧启动器载荷格式保持不变');
  await s.stop();
});

t('事件 id 单调递增', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const x = await a.send(['学生130']);
  const y = await a.send(['学生131']);
  assert.ok(y.json.event.id > x.json.event.id);
  await s.stop();
});

t('旧客户端不传找人身份时记为通用的“老师”，而不是默认班主任', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const res = await a.send(['学生130']);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.event.caller, '老师');
  assert.strictEqual(res.json.record.caller, '老师');
  const history = await a.get('teacher/history');
  assert.strictEqual(history.json.records[0].caller, '老师');
  await s.stop();
});

t('autoClearSeconds=0 时不产生过期时间', async () => {
  const s = await start({ a: { autoClearSeconds: 0 } });
  const cfg = await req(s.base, 'GET', cp(A, 'public/config'));
  assert.strictEqual(cfg.json.autoClearSeconds, 0);
  const a = await client(s.base, A, CLASS_A.password);
  const res = await a.send(['学生130']);
  assert.strictEqual(res.json.event.expiresAt, null, '不自动清除时 expiresAt 必须为 null');
  await s.stop();
});

t('自动清屏会在到点后广播 clear', async () => {
  const s = await start({ a: { autoClearSeconds: 1 } });
  const a = await client(s.base, A, CLASS_A.password);
  const events = sse(s.base, A, 3, { timeoutMs: 3000 });
  await sleep(120);
  await a.send(['学生130']);
  const got = await events;
  assert.strictEqual(got[0].type, 'clear', '首帧应是当前状态');
  assert.strictEqual(got[1].type, 'call');
  assert.strictEqual(got[2].type, 'clear', '到点后应自动清屏');
  assert.ok(got[2].id > got[1].id);
  await s.stop();
});

t('POST teacher/clear 清屏', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  await a.send(['学生130']);
  const res = await a.post('teacher/clear');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.event.type, 'clear');
  // clear 快照的 caller 固定是空串：display.exe 的解析器必须接受，否则 exe 收到清屏帧会当成畸形帧丢掉
  assert.strictEqual(res.json.event.caller, '');
  assert.deepStrictEqual(res.json.event.names, []);
  await s.stop();
});

// ---------------------------------------------------------------- 参数校验

t('非法参数统一返回 400 与错误码', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const cases = [
    [{ names: '学生130' }, 'INVALID_NAMES'],
    [{ names: [123] }, 'INVALID_NAMES'],
    [{ names: ['  '] }, 'EMPTY_NAME'],
    [{ names: ['学生130', '学生130'] }, 'DUPLICATE_NAMES'],
    [{ names: ['查无此人'] }, 'UNKNOWN_STUDENT'],
    [{ names: ['李四'] }, 'UNKNOWN_STUDENT'],          // 李四是乙班的：甲班不能通知
    [{ names: ['x'.repeat(21)] }, 'NAME_TOO_LONG'],
    [{ names: new Array(21).fill('学生130') }, 'TOO_MANY_NAMES'],
    [{ names: [], message: '啊'.repeat(61) }, 'MESSAGE_TOO_LONG'],
    [{ names: ['学生130'], message: 123 }, 'INVALID_MESSAGE'],
    [{ names: ['学生130'], caller: '校长' }, 'INVALID_CALLER'],
    [{ names: ['学生130'], caller: 123 }, 'INVALID_CALLER'],
    [{ names: [], message: '' }, 'EMPTY_CALL'],
    [{}, 'INVALID_NAMES'],
  ];
  for (const [body, code] of cases) {
    const res = await a.post('teacher/call', body);
    assert.strictEqual(res.status, 400, `${code} 应返回 400`);
    assert.strictEqual(res.json.ok, false);
    assert.strictEqual(res.json.error, code, JSON.stringify(body));
    assert.ok(typeof res.json.message === 'string' && res.json.message.length > 0);
  }
  await s.stop();
});

t('请求体不是合法 JSON 返回 INVALID_JSON', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const res = await req(s.base, 'POST', cp(A, 'teacher/call'), { token: a.token, raw: '{不是json' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'INVALID_JSON');
  await s.stop();
});

t('超大请求体返回 413 且不撑爆内存', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const huge = JSON.stringify({ names: [], message: 'x'.repeat(64 * 1024) });
  const res = await req(s.base, 'POST', cp(A, 'teacher/call'), { token: a.token, raw: huge })
    .catch((e) => ({ status: 0, err: e }));
  // 服务端会在超限处立即掐断连接，可能拿到 413，也可能连接被重置
  if (res.status !== 0) {
    assert.strictEqual(res.status, 413);
    assert.strictEqual(res.json.error, 'BODY_TOO_LARGE');
  }
  // 关键是进程仍然健康
  const alive = await req(s.base, 'GET', cp(A, 'public/config'));
  assert.strictEqual(alive.status, 200);
  await s.stop();
});

// ---------------------------------------------------------------- reload

t('reload 需要登录，且能载入改动后的名单', async () => {
  const s = await start();
  const anon = await req(s.base, 'POST', cp(A, 'teacher/reload'), { body: {} });
  assert.strictEqual(anon.status, 401);

  const a = await client(s.base, A, CLASS_A.password);
  fs.writeFileSync(s.configFile, configJson([
    { ...CLASS_A, students: [...STUDENTS, '新同学'] }, CLASS_B,
  ]));
  const ok = await a.post('teacher/reload');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.count, 4);

  const list = await a.get('teacher/students');
  assert.ok(list.json.students.includes('新同学'));
  await s.stop();
});

t('reload 遇到坏文件或旧格式时保留旧名单', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);

  fs.writeFileSync(s.configFile, '{ 坏掉的 json');
  let res = await a.post('teacher/reload');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'CONFIG_INVALID');

  // 旧的单班格式也必须整体拒绝，而不是只更新一半
  fs.writeFileSync(s.configFile, JSON.stringify({ className: '旧班', password: 'x', students: ['甲'] }));
  res = await a.post('teacher/reload');
  assert.strictEqual(res.status, 400);
  assert.match(res.json.detail, /version 2|多班级/);

  const list = await a.get('teacher/students');
  assert.deepStrictEqual(list.json.students, STUDENTS, '坏文件不该清空线上名单');
  const b = await req(s.base, 'GET', cp(CLASS_B.id, 'public/config'));
  assert.strictEqual(b.status, 200, '另一个班也必须原样保留');
  await s.stop();
});

// ---------------------------------------------------------------- HTTP 语义

t('不存在的 API 返回 JSON 404', async () => {
  const s = await start();
  const res = await req(s.base, 'GET', '/api/nope');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.json.error, 'NOT_FOUND');
  const sub = await req(s.base, 'GET', cp(A, 'teacher/nope'));
  assert.strictEqual(sub.status, 404);
  assert.strictEqual(sub.json.error, 'NOT_FOUND');
  await s.stop();
});

t('错误的 HTTP 方法返回 405 并带 Allow', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const res = await req(s.base, 'GET', cp(A, 'teacher/call'), { token: a.token });
  assert.strictEqual(res.status, 405);
  assert.strictEqual(res.json.error, 'METHOD_NOT_ALLOWED');
  assert.strictEqual(res.headers.allow, 'POST');
  await s.stop();
});

t('POST 静态页面返回 405，不再回吐 HTML', async () => {
  const s = await start();
  const res = await req(s.base, 'POST', '/teacher.html', { raw: '' });
  assert.strictEqual(res.status, 405);
  assert.ok(!res.body.includes('<!DOCTYPE'), '不应返回页面内容');
  await s.stop();
});

t('不存在的静态文件返回 404', async () => {
  const s = await start();
  const res = await req(s.base, 'GET', '/nope.html');
  assert.strictEqual(res.status, 404);
  await s.stop();
});

// ---------------------------------------------------------------- SSE

t('SSE 首帧同步当前状态', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  await a.send(['学生132']);
  const events = await sse(s.base, A, 1, { timeoutMs: 1500 });
  assert.strictEqual(events.length >= 1, true);
  assert.strictEqual(events[0].type, 'call');
  assert.strictEqual(events[0].classId, 'class-a');
  assert.deepStrictEqual(events[0].names, ['学生132']);
  assert.ok(events[0].serverTime > 0, '必须带服务器时间供客户端校正倒计时');
  await s.stop();
});

t('重连拿到的是同一个事件 id，可据此判定为状态恢复', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const first = await a.send(['学生132']);
  const x = await sse(s.base, A, 1, { timeoutMs: 1500 });
  const y = await sse(s.base, A, 1, { timeoutMs: 1500 });
  assert.strictEqual(x[0].id, y[0].id);
  assert.strictEqual(x[0].id, first.json.event.id);
  await s.stop();
});

t('刚启动时每个班的新连接都收到 clear，不残留旧名字', async () => {
  const s = await start();
  for (const id of [A, CLASS_B.id]) {
    const events = await sse(s.base, id, 1, { timeoutMs: 1500 });
    assert.strictEqual(events[0].type, 'clear');
    assert.strictEqual(events[0].classId, id);
  }
  await s.stop();
});

t('大屏连接数会反映在本班 status 上，断开后归零', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const r = await openStream(s.base, A);
  await sleep(100);

  const on = await a.get('teacher/status');
  assert.strictEqual(on.json.displays, 1);

  r.destroy();
  await sleep(200);
  const off = await a.get('teacher/status');
  assert.strictEqual(off.json.displays, 0, '客户端断开后必须清理连接');
  await s.stop();
});
