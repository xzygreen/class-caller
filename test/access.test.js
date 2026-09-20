'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  TEACHER, TEACHER2, CLASS_A, CLASS_B, start, req, cp, asAdmin, register, teacherWithAccess, sse, openStream, sleep,
} = require('./helpers');

const t = (name, fn) => test(name, { timeout: 20_000 }, fn);
const A = CLASS_A.id;
const B = CLASS_B.id;

t('申请 → 管理员批准 → 权限立即生效；拒绝会带理由返回给教师', async () => {
  const s = await start();
  try {
    const admin = await asAdmin(s.base);
    const { client } = await register(s.base);

    const reqA = await client.post('/api/me/class-requests', { classId: A, reason: '本班数学教师' });
    assert.strictEqual(reqA.status, 200);
    assert.strictEqual(reqA.json.request.status, 'pending');
    const dup = await client.post('/api/me/class-requests', { classId: A, reason: '再来一次' });
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.json.error, 'REQUEST_PENDING');
    const reqB = await client.post('/api/me/class-requests', { classId: B, reason: '' });
    assert.strictEqual(reqB.status, 200);
    const nope = await client.post('/api/me/class-requests', { classId: 'class-zz', reason: '' });
    assert.strictEqual(nope.status, 404);

    const pending = await admin.get('/api/admin/requests?status=pending');
    assert.strictEqual(pending.json.requests.length, 2);
    assert.strictEqual(pending.json.requests[0].user.displayName, '张老师');
    const overview = await admin.get('/api/admin/overview');
    assert.strictEqual(overview.json.pendingRequests.length, 2);

    assert.strictEqual((await client.cget(A, 'workspace')).status, 403, '批准前不能访问');
    const ok = await admin.post(`/api/admin/requests/${reqA.json.request.id}/approve`, {});
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.request.status, 'approved');
    const ws = await client.cget(A, 'workspace');
    assert.strictEqual(ws.status, 200, '批准后立即生效，不必重新登录');
    assert.deepStrictEqual(ws.json.students, CLASS_A.students);

    const rej = await admin.post(`/api/admin/requests/${reqB.json.request.id}/reject`, { note: '乙班已有数学老师' });
    assert.strictEqual(rej.status, 200);
    assert.strictEqual((await client.cget(B, 'workspace')).status, 403);
    const mine = await client.get('/api/me/classes');
    assert.deepStrictEqual(mine.json.classes.map((c) => c.id), [A]);
    const rejected = mine.json.requests.find((r) => r.classId === B);
    assert.strictEqual(rejected.status, 'rejected');
    assert.strictEqual(rejected.note, '乙班已有数学老师');

    const again = await admin.post(`/api/admin/requests/${reqB.json.request.id}/approve`, {});
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.json.error, 'REQUEST_ALREADY_DECIDED');
  } finally { await s.stop(); }
});

t('教师可以撤回自己的待审申请；已有权限时再申请被拒', async () => {
  const s = await start();
  try {
    const { client, admin } = await teacherWithAccess(s.base, [A]);
    const already = await client.post('/api/me/class-requests', { classId: A, reason: '' });
    assert.strictEqual(already.json.error, 'ALREADY_MEMBER');
    const r = await client.post('/api/me/class-requests', { classId: B, reason: '' });
    const cancel = await client.del(`/api/me/class-requests/${r.json.request.id}`);
    assert.strictEqual(cancel.status, 200);
    assert.strictEqual((await admin.get('/api/admin/requests?status=pending')).json.requests.length, 0);
  } finally { await s.stop(); }
});

t('未获批教师无法访问班级名单、状态、通知、定时、记录，也不能连教师流', async () => {
  const s = await start();
  try {
    const { client } = await register(s.base);
    const attempts = [
      ['GET', 'workspace'], ['GET', 'status'], ['GET', 'notices'], ['GET', 'activity'], ['GET', 'schedules'],
      ['POST', 'calls', { names: ['学生130'] }], ['POST', 'announcements', { title: 'x', body: 'y' }],
      ['POST', 'display/clear', {}], ['POST', 'schedules', { names: ['学生130'], time: '11:40' }],
    ];
    for (const [method, sub, body] of attempts) {
      const res = await req(s.base, method, cp(A, sub), { cookie: client.cookie, body });
      assert.strictEqual(res.status, 403, `${method} ${sub}`);
      assert.strictEqual(res.json.error, 'NO_CLASS_ACCESS');
      assert.ok(!res.body.includes('学生130'));
    }
    const stream = await sse(s.base, A, 1, { role: 'teacher', cookie: client.cookie });
    assert.strictEqual(stream.status, 403);
    const anon = await sse(s.base, A, 1, { role: 'teacher' });
    assert.strictEqual(anon.status, 401, '教师流必须鉴权');
    // 公开流再也不接受 role=teacher：会被当成大屏
    const stream2 = await openStream(s.base, A, 'teacher-as-public');
    await sleep(80);
    const admin = await asAdmin(s.base);
    assert.strictEqual((await admin.cget(A, 'status')).json.displays, 1);
    stream2.destroy();
  } finally { await s.stop(); }
});

t('教师不能操作其他班级；同一教师可管理多个班，同一班可授权多名教师', async () => {
  const s = await start();
  try {
    const { client: zhang, admin } = await teacherWithAccess(s.base, [A]);
    const { client: li, user: liUser } = await register(s.base, TEACHER2);
    await admin.post('/api/admin/memberships', { userId: liUser.id, classId: A });
    await admin.post('/api/admin/memberships', { userId: liUser.id, classId: B });

    assert.strictEqual((await zhang.cget(B, 'workspace')).status, 403);
    assert.strictEqual((await zhang.send(B, ['李四'])).status, 403);
    assert.strictEqual((await li.cget(A, 'workspace')).status, 200);
    assert.strictEqual((await li.cget(B, 'workspace')).status, 200);
    const mine = await li.get('/api/me/classes');
    assert.deepStrictEqual(mine.json.classes.map((c) => c.id).sort(), [A, B]);

    // 甲班点人由张老师发出，署名来自登录账号，不能冒充
    const sent = await zhang.cpost(A, 'calls', { names: ['学生130'], caller: '校长' });
    assert.strictEqual(sent.status, 200);
    assert.strictEqual(sent.json.event.caller, '数学老师 · 张老师');
    assert.strictEqual(sent.json.notice.authorName, '张老师');
    // 请求体里的 classId 不作依据
    const spoof = await zhang.cpost(A, 'calls', { classId: B, names: ['学生131'] });
    assert.strictEqual(spoof.status, 200);
    assert.strictEqual(spoof.json.event.classId, A);
    assert.strictEqual((await li.cget(B, 'status')).json.display.current.type, 'clear');
  } finally { await s.stop(); }
});

t('管理员撤销权限后当前会话立即失去班级访问权，其定时任务自动暂停', async () => {
  const s = await start();
  try {
    const { client, user, admin } = await teacherWithAccess(s.base, [A]);
    const sch = await client.cpost(A, 'schedules', { names: ['学生130'], time: '11:40' });
    assert.strictEqual(sch.status, 200);
    assert.strictEqual((await client.cget(A, 'workspace')).status, 200);

    const revoke = await admin.post('/api/admin/memberships/revoke', { userId: user.id, classId: A });
    assert.strictEqual(revoke.status, 200);
    assert.strictEqual(revoke.json.pausedSchedules, 1);
    const denied = await client.cget(A, 'workspace');
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.json.error, 'NO_CLASS_ACCESS');
    assert.strictEqual((await client.get('/api/me')).status, 200, '账号本身仍可登录');
    const mine = await client.get('/api/me/classes');
    assert.strictEqual(mine.json.pausedSchedules.length, 1);
    assert.strictEqual(mine.json.pausedSchedules[0].pauseReason, 'ACCESS_REVOKED');

    // 重新授权后任务恢复
    await admin.post('/api/admin/memberships', { userId: user.id, classId: A });
    const list = await client.cget(A, 'schedules');
    assert.strictEqual(list.json.schedules[0].status, 'active');
  } finally { await s.stop(); }
});

t('所有管理员修改都有操作者和时间记录', async () => {
  const s = await start();
  try {
    const { user, admin } = await teacherWithAccess(s.base, [A]);
    await admin.post('/api/admin/memberships/revoke', { userId: user.id, classId: A });
    await admin.put('/api/admin/call-windows', { windows: [{ start: '08:00', end: '09:00' }] });
    await admin.patch(`/api/admin/classes/${A}`, { name: '甲班（改）' });
    await admin.put(`/api/admin/classes/${A}/students`, { students: ['学生130', '新同学'] });
    const audit = await admin.get('/api/admin/audit');
    assert.strictEqual(audit.status, 200);
    const actions = audit.json.audit.map((a) => a.action);
    for (const expected of ['access.grant', 'access.revoke', 'call_windows.update', 'class.update', 'class.students', 'user.register']) {
      assert.ok(actions.includes(expected), `缺少审计 ${expected}`);
    }
    for (const entry of audit.json.audit) {
      assert.ok(entry.at > 0);
      assert.ok(entry.actorName);
    }
    const adminEntries = audit.json.audit.filter((a) => a.actorRole === 'admin');
    assert.ok(adminEntries.every((a) => a.actorName === '管理员'));
    const filtered = await admin.get('/api/admin/audit?action=access.');
    assert.ok(filtered.json.audit.every((a) => a.action.startsWith('access.')));
  } finally { await s.stop(); }
});

t('管理端可新增、修改、归档班级并维护名单；归档班级的大屏连接被关闭', async () => {
  const s = await start();
  try {
    const admin = await asAdmin(s.base);
    const created = await admin.post('/api/admin/classes', { id: 'class-c', name: '丙班', code: '03', students: ['甲', '乙'] });
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.json.class.studentCount, 2);
    assert.strictEqual((await admin.post('/api/admin/classes', { id: 'class-c', name: '重复' })).status, 409);
    assert.strictEqual((await admin.post('/api/admin/classes', { id: 'Bad Id', name: 'x' })).status, 400);
    assert.strictEqual((await req(s.base, 'GET', '/api/public/classes')).json.classes.length, 3);

    const put = await admin.put('/api/admin/classes/class-c/students', { students: ['甲', '乙', '乙', ' 丙 ', ''] });
    assert.deepStrictEqual(put.json.students, ['甲', '乙', '丙']);

    const stream = await openStream(s.base, B);
    let closed = false;
    stream.on('close', () => { closed = true; });
    const archived = await admin.patch(`/api/admin/classes/${B}`, { status: 'archived' });
    assert.strictEqual(archived.status, 200);
    await sleep(150);
    assert.strictEqual(closed, true);
    assert.strictEqual((await req(s.base, 'GET', cp(B, 'public/config'))).status, 404);
    assert.strictEqual((await req(s.base, 'GET', '/api/public/classes')).json.classes.some((c) => c.id === B), false);
    const all = await admin.get('/api/admin/classes');
    assert.strictEqual(all.json.classes.find((c) => c.id === B).status, 'archived');
  } finally { await s.stop(); }
});
