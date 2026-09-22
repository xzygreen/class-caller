'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ADMIN, TEACHER, TEACHER2, CLASS_A, start, req, cp, cookieOf, login, session, asAdmin, register, teacherWithAccess,
} = require('./helpers');

const t = (name, fn) => test(name, { timeout: 20_000 }, fn);
const A = CLASS_A.id;

// ---------------------------------------------------------------- 注册 / 登录

t('教师可以自主注册并直接登录；注册后没有任何班级权限', async () => {
  const s = await start();
  try {
    const res = await req(s.base, 'POST', '/api/auth/register', { body: TEACHER });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.user.role, 'teacher');
    assert.strictEqual(res.json.user.username, 'zhang');
    assert.strictEqual(res.json.user.title, '数学老师');
    assert.strictEqual(res.json.user.passwordHash, undefined, '响应不能带密码摘要');
    const cookie = cookieOf(res);
    assert.match(res.headers['set-cookie'][0], /HttpOnly/);
    assert.match(res.headers['set-cookie'][0], /SameSite=Strict/);
    assert.match(res.headers['set-cookie'][0], /Path=\//);

    const me = await req(s.base, 'GET', '/api/me', { cookie });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.json.user.username, 'zhang');

    const mine = await req(s.base, 'GET', '/api/me/classes', { cookie });
    assert.deepStrictEqual(mine.json.classes, [], '刚注册没有任何班级');
    assert.strictEqual(mine.json.availableClasses.length, 2, '可以看到可申请的班级列表');
    const ws = await req(s.base, 'GET', cp(A, 'workspace'), { cookie });
    assert.strictEqual(ws.status, 403);
    assert.strictEqual(ws.json.error, 'NO_CLASS_ACCESS');
    assert.ok(!ws.body.includes('学生130'), '拒绝时不能泄露名单');
  } finally { await s.stop(); }
});

t('注册参数校验：登录名、姓名、密码强度；重复登录名被拒', async () => {
  const s = await start();
  try {
    const cases = [
      [{ ...TEACHER, username: 'ab' }, 'INVALID_USERNAME'],
      [{ ...TEACHER, username: '张老师' }, 'INVALID_USERNAME'],
      [{ ...TEACHER, displayName: '' }, 'INVALID_DISPLAY_NAME'],
      [{ ...TEACHER, password: 'short' }, 'WEAK_PASSWORD'],
      [{ ...TEACHER, title: '很长很长很长很长很长很长的职务' }, 'INVALID_TITLE'],
    ];
    for (const [body, code] of cases) {
      const res = await req(s.base, 'POST', '/api/auth/register', { body });
      assert.strictEqual(res.status, 400, code);
      assert.strictEqual(res.json.error, code);
    }
    await register(s.base);
    const dup = await req(s.base, 'POST', '/api/auth/register', { body: { ...TEACHER, username: 'ZHANG' } });
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.json.error, 'USERNAME_TAKEN');
    // 管理员登录名也不能被注册占用
    const adminDup = await req(s.base, 'POST', '/api/auth/register', { body: { ...TEACHER, username: ADMIN.username } });
    assert.strictEqual(adminDup.status, 409);
  } finally { await s.stop(); }
});

t('登录：错误凭据 401 且不区分用户是否存在；登出后 Cookie 立即失效', async () => {
  const s = await start();
  try {
    const wrong = await req(s.base, 'POST', '/api/auth/login', { body: { username: ADMIN.username, password: 'nope' } });
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(wrong.json.error, 'INVALID_CREDENTIALS');
    const ghost = await req(s.base, 'POST', '/api/auth/login', { body: { username: 'nobody', password: 'nope' } });
    assert.strictEqual(ghost.status, 401);
    assert.strictEqual(ghost.json.error, 'INVALID_CREDENTIALS');

    const ok = await req(s.base, 'POST', '/api/auth/login', { body: { username: 'ADMIN', password: ADMIN.password } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.user.role, 'admin');
    const cookie = cookieOf(ok);
    const malformed = await req(s.base, 'POST', '/api/auth/logout', { cookie, raw: '{坏json' });
    assert.strictEqual(malformed.status, 400);
    assert.strictEqual(malformed.json.error, 'INVALID_JSON');
    assert.strictEqual((await req(s.base, 'GET', '/api/me', { cookie })).status, 200, '无效请求体不得仍然执行登出');
    const out = await req(s.base, 'POST', '/api/auth/logout', { cookie, body: {} });
    assert.strictEqual(out.status, 200);
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
    const after = await req(s.base, 'GET', '/api/me', { cookie });
    assert.strictEqual(after.status, 401);
  } finally { await s.stop(); }
});

t('仅知道原班级密码无法登录：旧接口已移除（410），共享密码不再是任何凭据', async () => {
  const s = await start();
  try {
    const legacy = await req(s.base, 'POST', cp(A, 'teacher/login'), { body: { password: 'legacy-class-a' } });
    assert.strictEqual(legacy.status, 410);
    for (const p of [cp(A, 'teacher/students'), cp(A, 'teacher/call'), '/api/teacher/students']) {
      const res = await req(s.base, 'POST', p, { body: {} });
      assert.strictEqual(res.status, 410, p);
    }
    // 用班级密码当账号密码也不行
    const asPwd = await req(s.base, 'POST', '/api/auth/login', { body: { username: 'class-a', password: 'legacy-class-a' } });
    assert.strictEqual(asPwd.status, 401);
    // 数据仓库里没有任何明文班级密码
    const raw = require('node:fs').readFileSync(s.dataFile, 'utf8');
    assert.ok(!raw.includes('legacy-class-a'), '班级密码不得进入数据仓库');
    assert.ok(!raw.includes(ADMIN.password) && !raw.includes(TEACHER.password), '明文密码不得进入数据仓库');
  } finally { await s.stop(); }
});

t('按 IP + 用户名限速：连续错 5 次后 429，另一个用户名不受影响', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await req(s.base, 'POST', '/api/auth/login', { body: { username: ADMIN.username, password: 'x' } });
      assert.strictEqual(res.status, 401);
    }
    const locked = await req(s.base, 'POST', '/api/auth/login', { body: { username: ADMIN.username, password: ADMIN.password } });
    assert.strictEqual(locked.status, 429);
    assert.strictEqual(locked.json.error, 'TOO_MANY_ATTEMPTS');
    assert.ok(locked.headers['retry-after']);
    await register(s.base);
    const other = await req(s.base, 'POST', '/api/auth/login', { body: { username: TEACHER.username, password: TEACHER.password } });
    assert.strictEqual(other.status, 200);
  } finally { await s.stop(); }
});

t('修改类请求检查 Origin：跨站 Origin 被拒，同源或无 Origin 放行', async () => {
  const s = await start();
  try {
    const cookie = await login(s.base, ADMIN.username, ADMIN.password);
    const evil = await req(s.base, 'POST', cp(A, 'display/clear'), { cookie, body: {}, headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(evil.status, 403);
    assert.strictEqual(evil.json.error, 'ORIGIN_MISMATCH');
    const same = await req(s.base, 'POST', cp(A, 'display/clear'), { cookie, body: {}, headers: { Origin: `http://127.0.0.1:${s.port}` } });
    assert.strictEqual(same.status, 200);
    const none = await req(s.base, 'POST', cp(A, 'display/clear'), { cookie, body: {} });
    assert.strictEqual(none.status, 200);
  } finally { await s.stop(); }
});

t('经 HTTPS 反代（X-Forwarded-Proto）时 Cookie 带 Secure', async () => {
  const s = await start();
  try {
    const res = await req(s.base, 'POST', '/api/auth/login', { body: { username: ADMIN.username, password: ADMIN.password }, headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(res.headers['set-cookie'][0], /; Secure/);
    const plain = await req(s.base, 'POST', '/api/auth/login', { body: { username: ADMIN.username, password: ADMIN.password } });
    assert.doesNotMatch(plain.headers['set-cookie'][0], /; Secure/);
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- 密码与会话失效

t('修改密码后其它设备的会话立即失效，当前设备保持登录', async () => {
  const s = await start();
  try {
    const { client } = await register(s.base);
    const other = session(s.base, await login(s.base, TEACHER.username, TEACHER.password));
    assert.strictEqual((await other.get('/api/me')).status, 200);

    const bad = await client.post('/api/me/password', { currentPassword: 'wrong', newPassword: 'new-pass-123' });
    assert.strictEqual(bad.status, 401);
    const ok = await client.post('/api/me/password', { currentPassword: TEACHER.password, newPassword: 'new-pass-123' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await client.get('/api/me')).status, 200, '当前会话继续有效');
    assert.strictEqual((await other.get('/api/me')).status, 401, '其它会话失效');
    assert.strictEqual((await req(s.base, 'POST', '/api/auth/login', { body: { username: TEACHER.username, password: TEACHER.password } })).status, 401);
    assert.strictEqual((await req(s.base, 'POST', '/api/auth/login', { body: { username: TEACHER.username, password: 'new-pass-123' } })).status, 200);
  } finally { await s.stop(); }
});

t('管理员停用账号后当前会话立即失效；不能停用最后一名管理员', async () => {
  const s = await start();
  try {
    const { client, user, admin } = await teacherWithAccess(s.base, [A]);
    assert.strictEqual((await client.cget(A, 'workspace')).status, 200);
    const off = await admin.patch(`/api/admin/users/${user.id}`, { status: 'disabled' });
    assert.strictEqual(off.status, 200);
    const denied = await client.cget(A, 'workspace');
    assert.strictEqual(denied.status, 401);
    const relogin = await req(s.base, 'POST', '/api/auth/login', { body: { username: TEACHER.username, password: TEACHER.password } });
    assert.strictEqual(relogin.status, 403);
    assert.strictEqual(relogin.json.error, 'ACCOUNT_DISABLED');

    const me = await admin.get('/api/me');
    const last = await admin.patch(`/api/admin/users/${me.json.user.id}`, { status: 'disabled' });
    assert.strictEqual(last.status, 409);
    assert.strictEqual(last.json.error, 'LAST_ADMIN');
  } finally { await s.stop(); }
});

t('管理端班级列表：teachers 是已授权教师数组，不被连接数覆盖；新建班级后可直接保存名单', async () => {
  const s = await start();
  try {
    const { user, admin } = await teacherWithAccess(s.base, [A]);
    const list = await admin.get('/api/admin/classes');
    assert.strictEqual(list.status, 200);
    const a = list.json.classes.find((c) => c.id === A);
    assert.ok(Array.isArray(a.teachers), 'teachers 必须是数组（曾被 counts().teachers 数字覆盖，导致管理端班级页崩溃）');
    assert.deepStrictEqual(a.teachers.map((x) => x.id), [user.id]);
    assert.strictEqual(typeof a.displays, 'number');
    assert.strictEqual(typeof a.teacherConnections, 'number');
    assert.ok(Array.isArray(a.students));

    const created = await admin.post('/api/admin/classes', { id: 'class-117', name: '初三117班', code: '117', color: 'blue', autoClearSeconds: 30 });
    assert.strictEqual(created.status, 200);
    const fresh = (await admin.get('/api/admin/classes')).json.classes.find((c) => c.id === 'class-117');
    assert.deepStrictEqual(fresh.students, []);
    assert.deepStrictEqual(fresh.teachers, []);
    const saved = await admin.put('/api/admin/classes/class-117/students', { students: ['张三', '李四', '张三', ' '] });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.json.students, ['张三', '李四']);
    assert.strictEqual((await admin.get('/api/admin/classes')).json.classes.find((c) => c.id === 'class-117').students.length, 2);
  } finally { await s.stop(); }
});

t('管理员删除账号：会话、授权、申请、定时任务一并移除；不能删自己或最后一名管理员', async () => {
  const s = await start();
  try {
    const { client, user, admin } = await teacherWithAccess(s.base, [A]);
    const sch = await client.cpost(A, 'schedules', { names: ['学生130'], time: '08:50', weekdays: [1, 2, 3, 4, 5] });
    assert.strictEqual(sch.status, 200);
    const me = await admin.get('/api/me');
    const self = await admin.del(`/api/admin/users/${me.json.user.id}`);
    assert.strictEqual(self.status, 409);
    assert.strictEqual(self.json.error, 'SELF_DELETE');

    const gone = await admin.del(`/api/admin/users/${user.id}`);
    assert.strictEqual(gone.status, 200);
    assert.strictEqual(gone.json.removedSchedules, 1);
    assert.strictEqual((await client.get('/api/me')).status, 401, '被删账号的会话立即失效');
    assert.strictEqual((await req(s.base, 'POST', '/api/auth/login', { body: { username: TEACHER.username, password: TEACHER.password } })).status, 401);
    assert.ok(!(await admin.get('/api/admin/users')).json.users.some((u) => u.id === user.id));
    assert.strictEqual((await admin.get('/api/admin/schedules')).json.schedules.length, 0);
    assert.strictEqual((await admin.get('/api/admin/classes')).json.classes.find((c) => c.id === A).teachers.length, 0);
    assert.strictEqual((await admin.del(`/api/admin/users/${user.id}`)).status, 404);

    // 登录名可以重新注册
    const again = await register(s.base);
    assert.strictEqual(again.user.username, TEACHER.username);

    const audit = await admin.get('/api/admin/audit?limit=50');
    assert.ok(audit.json.audit.some((e) => e.action === 'user.delete'));
  } finally { await s.stop(); }
});

t('管理员发起密码重置：拿到一次性临时密码，看不到旧密码；教师首次登录必须改密码', async () => {
  const s = await start();
  try {
    const { client, user, admin } = await teacherWithAccess(s.base, [A]);
    const reset = await admin.patch(`/api/admin/users/${user.id}`, { resetPassword: true });
    assert.strictEqual(reset.status, 200);
    assert.ok(typeof reset.json.tempPassword === 'string' && reset.json.tempPassword.length >= 10);
    assert.ok(!reset.body.includes(TEACHER.password));
    assert.strictEqual((await client.get('/api/me')).status, 401, '旧会话失效');

    const fresh = session(s.base, await login(s.base, TEACHER.username, reset.json.tempPassword));
    const blocked = await fresh.cget(A, 'workspace');
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.json.error, 'PASSWORD_CHANGE_REQUIRED');
    assert.strictEqual((await fresh.get('/api/me')).json.user.mustChangePassword, true);
    const changed = await fresh.post('/api/me/password', { newPassword: 'brand-new-pass' });
    assert.strictEqual(changed.status, 200);
    assert.strictEqual((await fresh.cget(A, 'workspace')).status, 200);
  } finally { await s.stop(); }
});

t('管理员可创建其他管理员；普通教师访问管理接口一律 403', async () => {
  const s = await start();
  try {
    const admin = await asAdmin(s.base);
    const created = await admin.post('/api/admin/users', { ...TEACHER2, role: 'admin' });
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.json.user.role, 'admin');
    const second = session(s.base, await login(s.base, TEACHER2.username, TEACHER2.password));
    // 管理员创建的账号首次登录需要改密码
    assert.strictEqual((await second.get('/api/admin/overview')).json.error, 'PASSWORD_CHANGE_REQUIRED');
    await second.post('/api/me/password', { newPassword: 'another-pass-1' });
    assert.strictEqual((await second.get('/api/admin/overview')).status, 200);

    const { client } = await register(s.base);
    for (const p of ['/api/admin/overview', '/api/admin/users', '/api/admin/requests', '/api/admin/audit', '/api/admin/call-windows', '/api/admin/classes']) {
      const res = await client.get(p);
      assert.strictEqual(res.status, 403, p);
      assert.strictEqual(res.json.error, 'ADMIN_ONLY');
    }
    assert.strictEqual((await client.put('/api/admin/call-windows', { windows: [] })).status, 403);
  } finally { await s.stop(); }
});

t('首个管理员来自环境变量式初始化；没有管理员时公开状态提示 setupRequired', async () => {
  const s = await start({ admin: null });
  try {
    const status = await req(s.base, 'GET', '/api/public/status');
    assert.strictEqual(status.json.setupRequired, true);
    assert.strictEqual(s.app.users.hasAdmin(), false);
  } finally { await s.stop(); }
  const s2 = await start();
  try {
    assert.strictEqual((await req(s2.base, 'GET', '/api/public/status')).json.setupRequired, false);
    // 已有管理员时再次带同样的初始化参数启动不会重复创建
    await s2.app.bootstrap();
    assert.strictEqual(s2.app.store.get().users.filter((u) => u.role === 'admin').length, 1);
  } finally { await s2.stop(); }
});
