'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { start, req, teacherWithAccess, register, asAdmin, TEACHER2, CLOSED_TIME } = require('./helpers');
const { EXPIRES_MS } = require('../lib/student-calls');

const path = (sub = '') => '/api/classes/class-a/public/student-calls' + sub;
const create = (s, teacherId, extra = {}) => req(s.base, 'POST', path(), { body: { requestId: randomUUID(), studentName: '学生130', teacherId, message: '请来教室', ...extra } });
const receipts = (s, ids, classId = 'class-a') => req(s.base, 'POST', '/api/classes/' + classId + '/public/student-calls/status', { body: { ids } });

test('学生呼叫：收件人隔离、回执、回复、重启保留，不改变原有大屏队列', async (t) => {
  const s = await start(); t.after(() => s.stop());
  const { client, user, admin } = await teacherWithAccess(s.base, ['class-a']);
  const other = await teacherWithAccess(s.base, ['class-a'], TEACHER2);
  const sent = await create(s, user.id);
  assert.equal(sent.status, 200);
  const call = sent.json.call;
  assert.equal(call.status, 'pending'); assert.equal(call.requestId, undefined); assert.equal(call.ip, undefined);
  assert.equal(s.app.classes.get('class-a').display.overview().queue.length, 0);
  assert.equal((await client.get('/api/me/student-calls')).json.pendingCount, 1);
  for (const viewer of [other.client, admin]) {
    assert.deepEqual((await viewer.get('/api/me/student-calls')).json.calls, []);
    assert.equal((await viewer.post('/api/me/student-calls/' + call.id + '/reply', { reply: '我来' })).status, 404);
  }
  assert.equal((await req(s.base, 'GET', '/api/me/student-calls')).status, 401);
  assert.deepEqual((await receipts(s, [call.id], 'class-b')).json.calls, []);
  assert.deepEqual((await receipts(s, [randomUUID()])).json.calls, []);
  const response = await client.post('/api/me/student-calls/' + call.id + '/reply', { reply: '收到，五分钟后到教室' });
  assert.equal(response.status, 200);
  assert.equal((await receipts(s, [call.id])).json.calls[0].reply, '收到，五分钟后到教室');
  assert.equal((await client.post('/api/me/student-calls/' + call.id + '/reply', { reply: '收到，五分钟后到教室' })).status, 200);
  assert.equal((await client.post('/api/me/student-calls/' + call.id + '/reply', { reply: '覆盖旧回复' })).status, 409);
  await s.restart();
  assert.equal((await receipts(s, [call.id])).json.calls[0].status, 'replied');
  assert.equal(s.app.store.get().auditLogs.filter((a) => a.action === 'student_call.reply').length, 1);
});

test('学生呼叫：公开选项仅有本班启用老师，不公开完整名单和账号字段', async (t) => {
  const s = await start(); t.after(() => s.stop());
  const { user, admin } = await teacherWithAccess(s.base, ['class-a']);
  const outsider = await register(s.base, TEACHER2);
  const options = () => req(s.base, 'GET', '/api/classes/class-a/public/student-call-options');
  const data = (await options()).json;
  assert.deepEqual(data.teachers, [{ id: user.id, displayName: user.displayName, title: user.title }]);
  for (const key of ['students', 'username', 'passwordHash', 'sessions']) assert.ok(!JSON.stringify(data).includes('"' + key + '"'));
  assert.equal((await create(s, outsider.user.id)).json.error, 'TEACHER_UNAVAILABLE');
  assert.equal((await create(s, user.id, { studentName: '李四' })).json.error, 'UNKNOWN_STUDENT');
  assert.equal((await create(s, user.id, { message: '字'.repeat(61) })).status, 400);
  assert.equal((await create(s, user.id, { requestId: 'bad-id' })).status, 400);
  s.clock.set(CLOSED_TIME);
  assert.equal((await create(s, user.id)).json.error, 'CALL_WINDOW_CLOSED');
  await admin.patch('/api/admin/users/' + user.id, { status: 'disabled' });
  assert.deepEqual((await options()).json.teachers, []);
  assert.equal((await create(s, user.id)).json.error, 'TEACHER_UNAVAILABLE');
});

test('学生呼叫：并发重试只生成一次，撤回/超时为终态，回复与撤回竞争只成功一个', async (t) => {
  const s = await start(); t.after(() => s.stop());
  const { user, client } = await teacherWithAccess(s.base, ['class-a']);
  const requestId = randomUUID();
  const attempts = await Promise.all([create(s, user.id, { requestId }), create(s, user.id, { requestId })]);
  assert.ok(attempts.every((r) => r.status === 200));
  const id = attempts[0].json.call.id;
  assert.equal(attempts[1].json.call.id, id);
  assert.equal(s.app.store.get().studentCalls.length, 1);
  assert.equal((await create(s, user.id, { requestId, message: '改过的内容' })).status, 409);
  const competing = await Promise.all([
    req(s.base, 'POST', path('/' + id + '/cancel'), { body: {} }),
    client.post('/api/me/student-calls/' + id + '/reply', { reply: '我来了' }),
  ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
  const next = await create(s, user.id, { studentName: '学生131' });
  assert.equal(next.status, 200);
  const expiredId = next.json.call.id;
  s.clock.advance(EXPIRES_MS + 1);
  assert.equal((await receipts(s, [expiredId])).json.calls[0].status, 'expired');
  assert.equal((await client.post('/api/me/student-calls/' + expiredId + '/reply', { reply: '迟来的回复' })).status, 409);
});

test('学生呼叫：同一学生限频、待处理去重，权限撤销后收件与回复即时拒绝', async (t) => {
  const s = await start(); t.after(() => s.stop());
  const { user, client, admin } = await teacherWithAccess(s.base, ['class-a']);
  const call = (await create(s, user.id)).json.call;
  assert.equal((await create(s, user.id)).status, 429);
  s.clock.advance(60_001);
  assert.equal((await create(s, user.id)).json.error, 'STUDENT_CALL_PENDING');
  await admin.post('/api/admin/memberships/revoke', { userId: user.id, classId: 'class-a' });
  assert.deepEqual((await client.get('/api/me/student-calls')).json.calls, []);
  assert.equal((await client.post('/api/me/student-calls/' + call.id + '/reply', { reply: '回复' })).status, 403);
  assert.equal((await receipts(s, [call.id])).json.calls[0].status, 'unavailable');
});

test('学生呼叫：写盘失败不产生呼叫或审计，事务队列内重新检查权限和作息', async (t) => {
  const s = await start(); t.after(() => s.stop());
  const { user, client, admin } = await teacherWithAccess(s.base, ['class-a']);
  const persist = s.app.store._persist.bind(s.app.store), before = JSON.stringify(s.app.store.get());
  s.app.store._persist = async () => { throw new Error('simulated write failure'); };
  assert.equal((await create(s, user.id)).status, 500);
  assert.equal(JSON.stringify(s.app.store.get()), before);
  s.app.store._persist = persist;
  const call = (await create(s, user.id)).json.call;
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const blocker = s.app.store.update(async () => { entered(); await new Promise((resolve) => { release = resolve; }); });
  await waiting;
  const revoke = s.app.store.update((db) => { db.memberships = []; });
  const response = s.app.studentCalls.respond({ callId: call.id, reply: '我来', authorize: () => user });
  release(); await blocker; await revoke;
  assert.equal((await response).code, 'NO_CLASS_ACCESS');
  assert.equal(s.app.store.get().studentCalls[0].status, 'pending');
  assert.equal((await client.get('/api/me/student-calls')).json.pendingCount, 0);
  assert.equal((await admin.get('/api/me/student-calls')).json.pendingCount, 0);
});

test('学生呼叫：跨源写入拒绝、回执批次限量、姓名枚举尝试也受限频', async (t) => {
  const s = await start(); t.after(() => s.stop());
  const { user } = await teacherWithAccess(s.base, ['class-a']);
  assert.equal((await req(s.base, 'POST', path(), { headers: { Origin: 'https://unrelated.example' }, body: {} })).status, 403);
  assert.equal((await receipts(s, Array.from({ length: 11 }, () => randomUUID()))).status, 400);
  for (let i = 0; i < 30; i++) assert.equal((await create(s, user.id, { studentName: '不存在' })).status, 400);
  assert.equal((await create(s, user.id)).status, 429);
});
