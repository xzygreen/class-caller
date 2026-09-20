'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { CallWindows, normalizeWindows, zonedToMs } = require('../lib/timewin');
const { CLASS_A, start, req, cp, teacherWithAccess } = require('./helpers');

const t = (name, fn) => test(name, { timeout: 20_000 }, fn);
const A = CLASS_A.id;
const at = (date, h, m, s = 0) => zonedToMs(date, h * 60 + m) + s * 1000;
const MON = '2026-09-21';
const SAT = '2026-09-19';

test('作息规则：开始包含、结束不包含；周末禁止；16:15–17:00 禁止', () => {
  const cw = new CallWindows(null);
  assert.strictEqual(cw.isOpen(at(MON, 8, 45, 0)), true, '08:45:00 可以');
  assert.strictEqual(cw.isOpen(at(MON, 8, 59, 59)), true, '08:59:59 可以');
  assert.strictEqual(cw.isOpen(at(MON, 9, 0, 0)), false, '09:00:00 不行');
  assert.strictEqual(cw.isOpen(at(MON, 8, 44, 59)), false);
  assert.strictEqual(cw.isOpen(at(MON, 11, 35)), true);
  assert.strictEqual(cw.isOpen(at(MON, 12, 29, 59)), true, '11:35–12:30 视为连续时段');
  assert.strictEqual(cw.isOpen(at(MON, 12, 30)), false);
  assert.strictEqual(cw.isOpen(at(MON, 13, 5)), true);
  assert.strictEqual(cw.isOpen(at(MON, 16, 14, 59)), true);
  for (const [h, m] of [[16, 15], [16, 30], [16, 59], [17, 0]]) {
    assert.strictEqual(cw.isOpen(at(MON, h, m)), false, `${h}:${m} 禁止`);
  }
  assert.strictEqual(cw.isOpen(at(SAT, 11, 5)), false, '周六禁止');
  assert.strictEqual(cw.isOpen(at('2026-09-20', 11, 5)), false, '周日禁止');
  assert.strictEqual(cw.isOpen(at('2026-09-25', 11, 5)), true, '周五可以');
});

test('作息状态给出下一次可用时段，跨天与跨周末都正确', () => {
  const cw = new CallWindows(null);
  let s = cw.status(at(MON, 9, 5));
  assert.strictEqual(s.open, false);
  assert.strictEqual(s.next.start, '09:45');
  assert.strictEqual(s.next.date, MON);
  s = cw.status(at(MON, 16, 20));
  assert.strictEqual(s.next.date, '2026-09-22');
  assert.strictEqual(s.next.start, '08:45');
  s = cw.status(at('2026-09-25', 16, 20));   // 周五放学后
  assert.strictEqual(s.next.date, '2026-09-28');
  assert.strictEqual(s.next.weekdayName, '周一');
  s = cw.status(at(MON, 8, 50));
  assert.strictEqual(s.open, true);
  assert.strictEqual(s.current.end, '09:00');
  assert.strictEqual(s.current.endsAt, at(MON, 9, 0));
  assert.strictEqual(s.now.time, '08:50');
});

test('作息校验：时间格式、重叠、排序、星期', () => {
  assert.throws(() => normalizeWindows({ windows: [{ start: '8:45', end: '09:00' }] }), /HH:MM/);
  assert.throws(() => normalizeWindows({ windows: [{ start: '09:00', end: '08:45' }] }), /晚于/);
  assert.throws(() => normalizeWindows({ windows: [{ start: '08:45', end: '09:00' }, { start: '08:50', end: '09:10' }] }), /重叠/);
  assert.throws(() => normalizeWindows({ weekdays: [7], windows: [] }), /weekdays/);
  const ok = normalizeWindows({ windows: [{ start: '10:00', end: '10:10', label: 'b' }, { start: '08:00', end: '08:10', label: 'a' }] });
  assert.deepStrictEqual(ok.windows.map((w) => w.start), ['08:00', '10:00']);
  assert.deepStrictEqual(ok.weekdays, [1, 2, 3, 4, 5]);
  assert.strictEqual(ok.timezone, 'Asia/Shanghai');
});

t('服务端按上海时间拒绝上课期间的点人：08:45 可以，09:00 不能，周末不能', async () => {
  const s = await start();
  try {
    const { client } = await teacherWithAccess(s.base, [A]);
    s.clock.set(at(MON, 8, 45));
    let res = await client.send(A, ['学生130']);
    assert.strictEqual(res.status, 200, '08:45 可以点人');

    s.clock.set(at(MON, 9, 0));
    res = await client.send(A, ['学生130']);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.error, 'CALL_WINDOW_CLOSED');
    assert.strictEqual(res.json.callWindow.open, false);
    assert.strictEqual(res.json.callWindow.next.start, '09:45', '响应附带下次可用时间');

    s.clock.set(at(SAT, 11, 5));
    res = await client.send(A, ['学生130']);
    assert.strictEqual(res.status, 403);

    s.clock.set(at(MON, 16, 30));
    res = await client.send(A, ['学生130']);
    assert.strictEqual(res.status, 403);

    // 工作台随时能看到当前状态和下一次可用时间
    const ws = await client.cget(A, 'workspace');
    assert.strictEqual(ws.json.callWindow.open, false);
    assert.strictEqual(ws.json.callWindow.next.date, '2026-09-22');
    // 公开状态接口也能查
    const pub = await req(s.base, 'GET', '/api/public/status');
    assert.strictEqual(pub.json.callWindow.open, false);
    // 留言不受作息限制
    const ann = await client.announce(A, { title: '通知', body: '明天穿校服' });
    assert.strictEqual(ann.status, 200);
  } finally { await s.stop(); }
});

t('管理员编辑作息后立即生效；不再合法的定时任务自动暂停并记入审计；教师只能查看', async () => {
  const s = await start();
  try {
    const { client, admin } = await teacherWithAccess(s.base, [A]);
    const sch = await client.cpost(A, 'schedules', { names: ['学生130'], time: '11:40', message: '去数学办公室' });
    assert.strictEqual(sch.status, 200);
    const view = await client.cget(A, 'schedules');
    assert.strictEqual(view.json.callWindows.windows.length, 8, '教师可以查看作息');
    assert.strictEqual((await client.put('/api/admin/call-windows', { windows: [] })).status, 403, '教师不能改作息');

    const bad = await admin.put('/api/admin/call-windows', { windows: [{ start: '09:00', end: '08:00' }] });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.error, 'INVALID_CALL_WINDOWS');

    const put = await admin.put('/api/admin/call-windows', { windows: [{ start: '08:45', end: '09:00', label: '课间' }, { start: '15:00', end: '15:15' }] });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.json.pausedSchedules, 1);
    assert.strictEqual(put.json.callWindows.windows.length, 2);

    s.clock.set(at(MON, 11, 40));
    assert.strictEqual((await client.send(A, ['学生130'])).status, 403, '新作息下 11:40 不能点人');
    s.clock.set(at(MON, 15, 5));
    assert.strictEqual((await client.send(A, ['学生130'])).status, 200);

    const list = await client.cget(A, 'schedules');
    assert.strictEqual(list.json.schedules[0].status, 'paused');
    assert.strictEqual(list.json.schedules[0].pauseReason, 'CALL_WINDOW_CHANGED');
    const audit = await admin.get('/api/admin/audit?action=schedule.auto_pause');
    assert.strictEqual(audit.json.audit.length, 1);
    assert.strictEqual(audit.json.audit[0].detail.reason, 'CALL_WINDOW_CHANGED');

    // 重启后作息仍然是修改后的
    const dataFile = s.dataFile;
    const { JsonStore } = require('../lib/store');
    const db = new JsonStore(dataFile).get();
    assert.strictEqual(db.callWindows.windows.length, 2);
  } finally { await s.stop(); }
});
