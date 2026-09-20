'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { zonedToMs } = require('../lib/timewin');
const { CLASS_A, TEACHER2, start, req, cp, asAdmin, register, teacherWithAccess, sse, sleep } = require('./helpers');

const t = (name, fn) => test(name, { timeout: 20_000 }, fn);
const A = CLASS_A.id;
const at = (date, h, m, s = 0) => zonedToMs(date, h * 60 + m) + s * 1000;
const MON = '2026-09-21';

t('创建定时提醒：必须落在允许点人的时段；字段校验；教师只能改自己的', async () => {
  const s = await start();
  try {
    const { client, admin } = await teacherWithAccess(s.base, [A]);
    const bad = await client.cpost(A, 'schedules', { names: ['学生130'], time: '09:20' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.error, 'SCHEDULE_OUT_OF_WINDOW');
    assert.ok(Array.isArray(bad.json.callWindows.windows), '响应附带作息供前端提示');
    assert.strictEqual((await client.cpost(A, 'schedules', { names: ['学生130'], time: '11:40', weekdays: [6] })).json.error, 'SCHEDULE_OUT_OF_WINDOW');
    for (const [body, code] of [
      [{ names: ['学生130'], time: '11:4' }, 'INVALID_TIME'],
      [{ names: ['学生130'], time: '11:40', weekdays: [] }, 'INVALID_WEEKDAYS'],
      [{ names: ['学生130'], time: '11:40', weekdays: [9] }, 'INVALID_WEEKDAYS'],
      [{ names: ['李四'], time: '11:40' }, 'UNKNOWN_STUDENT'],
      [{ names: ['学生130'], time: '11:40', startDate: '2026/09/21' }, 'INVALID_DATE'],
      [{ names: ['学生130'], time: '11:40', startDate: '2026-09-30', endDate: '2026-09-21' }, 'INVALID_DATE'],
      [{ names: [], time: '11:40' }, 'EMPTY_CALL'],
    ]) {
      const res = await client.cpost(A, 'schedules', body);
      assert.strictEqual(res.json.error, code, JSON.stringify(body));
    }
    const ok = await client.cpost(A, 'schedules', { names: ['学生130', '学生131'], time: '11:40', message: '去数学办公室找张老师' });
    assert.strictEqual(ok.status, 200);
    const sch = ok.json.schedule;
    assert.deepStrictEqual(sch.weekdays, [1, 2, 3, 4, 5], '默认周一至周五');
    assert.strictEqual(sch.enabled, true);
    assert.strictEqual(sch.status, 'active');
    assert.strictEqual(sch.nextRunAt, at(MON, 11, 40));
    assert.strictEqual(sch.createdByName, '张老师');

    const { user: liUser } = await register(s.base, TEACHER2);
    await admin.post('/api/admin/memberships', { userId: liUser.id, classId: A });
    const li = require('./helpers').session(s.base, await require('./helpers').login(s.base, TEACHER2.username, TEACHER2.password));
    const listByLi = await li.cget(A, 'schedules');
    assert.strictEqual(listByLi.json.schedules.length, 1);
    assert.strictEqual(listByLi.json.schedules[0].mine, false);
    assert.strictEqual((await li.patch(cp(A, `schedules/${sch.id}`), { enabled: false })).status, 403);
    assert.strictEqual((await li.del(cp(A, `schedules/${sch.id}`))).status, 403);
    assert.strictEqual((await client.patch(cp(A, `schedules/${sch.id}`), { enabled: false })).json.schedule.enabled, false);
    // 管理员可以管理全部任务
    const adminList = await admin.get('/api/admin/schedules');
    assert.strictEqual(adminList.json.schedules.length, 1);
    assert.strictEqual(adminList.json.schedules[0].className, '甲班');
    assert.strictEqual((await admin.patch(`/api/admin/schedules/${sch.id}`, { enabled: true })).status, 200);
    assert.strictEqual((await admin.patch(`/api/admin/schedules/${sch.id}`, { time: '09:20' })).json.error, 'SCHEDULE_OUT_OF_WINDOW');
    assert.strictEqual((await client.del(cp(A, `schedules/${sch.id}`))).status, 200);
    assert.strictEqual((await client.cget(A, 'schedules')).json.schedules.length, 0);
  } finally { await s.stop(); }
});

t('到点执行：以定时提醒优先级点人，署名为创建教师；同一天不重复；重复 tick 幂等', async () => {
  const s = await start();
  try {
    const { client } = await teacherWithAccess(s.base, [A]);
    await client.cpost(A, 'schedules', { names: ['学生130'], time: '11:40', message: '去数学办公室找张老师' });
    s.clock.set(at(MON, 11, 39, 50));
    await s.app.scheduler.tick();
    assert.strictEqual((await client.cget(A, 'status')).json.display.current.type, 'clear', '未到点不发');

    s.clock.set(at(MON, 11, 40, 5));
    const stream = sse(s.base, A, 2, { timeoutMs: 2000 });
    await sleep(80);
    await s.app.scheduler.tick();
    const events = await stream;
    assert.strictEqual(events[1].type, 'call');
    assert.deepStrictEqual(events[1].names, ['学生130']);
    assert.strictEqual(events[1].message, '去数学办公室找张老师');
    assert.strictEqual(events[1].caller, '数学老师 · 张老师');
    assert.strictEqual(events[1].priority, 2);
    assert.strictEqual(events[1].source, 'schedule');

    await s.app.scheduler.tick();
    s.clock.set(at(MON, 11, 41));
    await s.app.scheduler.tick();
    const notices = await client.cget(A, 'notices?type=call');
    assert.strictEqual(notices.json.notices.length, 1, '一天只发一次');
    const list = await client.cget(A, 'schedules');
    assert.strictEqual(list.json.schedules[0].lastResult.status, 'sent');
    assert.strictEqual(list.json.schedules[0].lastRunDate, MON);
    const runs = await client.cget(A, `schedules/${list.json.schedules[0].id}/runs`);
    assert.strictEqual(runs.json.runs.length, 1);

    // 第二天正常再发（会话 12 小时到期，重新登录）
    s.clock.set(at('2026-09-22', 11, 40, 30));
    await s.app.scheduler.tick();
    const { session, login, TEACHER } = require('./helpers');
    let again = session(s.base, await login(s.base, TEACHER.username, TEACHER.password));
    assert.strictEqual((await again.cget(A, 'notices?type=call')).json.notices.length, 2);
    // 周六不发
    s.clock.set(at('2026-09-26', 11, 40, 30));
    await s.app.scheduler.tick();
    again = session(s.base, await login(s.base, TEACHER.username, TEACHER.password));
    assert.strictEqual((await again.cget(A, 'notices?type=call')).json.notices.length, 2);
  } finally { await s.stop(); }
});

t('服务重启后不会重复发送；超过两分钟补偿窗口记为已错过，不在上课途中补发', async () => {
  const first = await start();
  const dir = first.dir;
  const { client } = await teacherWithAccess(first.base, [A]);
  await client.cpost(A, 'schedules', { names: ['学生130'], time: '11:40' });
  await client.cpost(A, 'schedules', { names: ['学生131'], time: '12:00' });
  first.clock.set(at(MON, 11, 40, 20));
  await first.app.scheduler.tick();
  assert.strictEqual((await client.cget(A, 'notices')).json.notices.length, 1);
  await first.app.close();

  const { createApp } = require('../lib/app');
  const clock = require('../lib/clock');
  // 重启：仍在 11:40 的补偿窗口内
  clock.use(() => at(MON, 11, 41, 30));
  let app = createApp({ dataFile: path.join(dir, 'data', 'db.json'), publicDir: path.join(__dirname, '..', 'public'), scheduler: false });
  await app.bootstrap();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    await app.scheduler.tick();
    const list = await req(base, 'GET', cp(A, 'notices'), { cookie: client.cookie });
    assert.strictEqual(list.json.notices.length, 1, '重启后同一天不再重发');
  } finally { await app.close(); }

  // 再次重启：12:00 的任务已错过 5 分钟
  clock.use(() => at(MON, 12, 5, 0));
  app = createApp({ dataFile: path.join(dir, 'data', 'db.json'), publicDir: path.join(__dirname, '..', 'public'), scheduler: false });
  await app.bootstrap();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    await app.scheduler.tick();
    const list = await req(base, 'GET', cp(A, 'notices'), { cookie: client.cookie });
    assert.strictEqual(list.json.notices.length, 1, '错过的不补发');
    const schedules = await req(base, 'GET', cp(A, 'schedules'), { cookie: client.cookie });
    const noon = schedules.json.schedules.find((x) => x.time === '12:00');
    assert.strictEqual(noon.lastResult.status, 'missed');
    const activity = await req(base, 'GET', cp(A, 'activity?type=schedule'), { cookie: client.cookie });
    assert.ok(activity.json.activity.some((x) => x.kind === 'schedule_run' && x.status === 'missed'), '记录页能看到已错过');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 在 1 分 50 秒的补偿窗口内重启：应补发
  const second = await start();
  try {
    const { client: c2 } = await teacherWithAccess(second.base, [A]);
    await c2.cpost(A, 'schedules', { names: ['学生130'], time: '11:40' });
    second.clock.set(at(MON, 11, 41, 50));
    await second.app.scheduler.tick();
    assert.strictEqual((await c2.cget(A, 'notices')).json.notices.length, 1, '补偿窗口内补发');
  } finally { await second.stop(); }
});

t('执行时重新校验：作息已关闭则跳过；学生被移出名单则暂停', async () => {
  const s = await start();
  try {
    const { client, admin } = await teacherWithAccess(s.base, [A]);
    const sch = await client.cpost(A, 'schedules', { names: ['学生130'], time: '11:40' });
    // 直接改内存里的作息（模拟作息在执行瞬间已关闭但任务未被 reconcile 的边界）
    s.app.windows.set({ windows: [{ start: '11:40', end: '11:50' }] });
    s.app.windows.set({ windows: [{ start: '11:41', end: '11:50' }] });
    s.clock.set(at(MON, 11, 40, 10));
    await s.app.scheduler.tick();
    assert.strictEqual((await client.cget(A, 'notices')).json.notices.length, 0);
    const list = await client.cget(A, 'schedules');
    assert.strictEqual(list.json.schedules[0].status, 'paused');

    await client.patch(cp(A, `schedules/${sch.json.schedule.id}`), { time: '11:45' });
    await admin.put(`/api/admin/classes/${A}/students`, { students: ['学生131'] });
    const paused = await client.cget(A, 'schedules');
    assert.strictEqual(paused.json.schedules[0].status, 'paused');
    assert.strictEqual(paused.json.schedules[0].pauseReason, 'STUDENT_REMOVED');
    s.clock.set(at(MON, 11, 45, 10));
    await s.app.scheduler.tick();
    assert.strictEqual((await client.cget(A, 'notices')).json.notices.length, 0);
  } finally { await s.stop(); }
});
