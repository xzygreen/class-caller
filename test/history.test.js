'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { LessonState } = require('../lib/state');
const {
  CLASS_A, CLASS_B, configJson, start, req, cp, client, openStream, sleep,
} = require('./helpers');

const TIMEOUT = 15_000;
const t = (name, fn) => test(name, { timeout: TIMEOUT }, fn);
const A = CLASS_A.id;

t('所有找人记录接口都需要登录', async () => {
  const s = await start();
  try {
    const calls = [
      req(s.base, 'GET', cp(A, 'teacher/history')),
      req(s.base, 'POST', cp(A, 'teacher/history/undo'), { body: {} }),
      req(s.base, 'POST', cp(A, 'teacher/history/clear'), { body: {} }),
      req(s.base, 'POST', cp(A, 'teacher/history/resend'), { body: {} }),
    ];
    for (const res of await Promise.all(calls)) {
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.json.error, 'UNAUTHORIZED');
    }
  } finally {
    await s.stop();
  }
});

t('手动发送创建一条记录，公开配置只暴露安全启动设置', async () => {
  const s = await start();
  try {
    const cfg = await req(s.base, 'GET', cp(A, 'public/config'));
    assert.deepStrictEqual(cfg.json.launcher, {
      mode: 'protocol', freshSeconds: 30, protocol: 'classcaller',
    });
    assert.strictEqual(cfg.json.students, undefined);

    const a = await client(s.base, A, CLASS_A.password);
    const sent = await a.send(['学生130', '学生131'], '请到讲台', '语文老师');
    assert.strictEqual(sent.status, 200);
    assert.match(sent.json.record.recordId, /^[0-9a-f-]{36}$/);
    assert.match(sent.json.event.deliveryId, /^[0-9a-f-]{36}$/);
    assert.ok(sent.json.event.launchValidUntil > sent.json.event.createdAt);
    assert.strictEqual(sent.json.event.caller, '语文老师');
    assert.strictEqual(sent.json.record.caller, '语文老师');
    const payload = JSON.parse(Buffer.from(sent.json.event.launchPayload, 'base64url').toString('utf8'));
    assert.deepStrictEqual(payload.students, ['学生130', '学生131']);
    assert.strictEqual(payload.message, '请到讲台');
    assert.strictEqual(payload.classId, A);

    const history = await a.get('teacher/history');
    assert.strictEqual(history.json.classId, A);
    assert.strictEqual(history.json.records.length, 1);
    assert.strictEqual(history.json.records[0].deliveryCount, 1);
    assert.strictEqual(history.json.records[0].caller, '语文老师');
    assert.strictEqual(history.json.version, 1);
  } finally {
    await s.stop();
  }
});

t('清空大屏与自动清除都不删除找人记录', async () => {
  const s = await start({ a: { autoClearSeconds: 1 } });
  try {
    const a = await client(s.base, A, CLASS_A.password);
    await a.send(['学生130']);
    await a.post('teacher/clear');
    let history = await a.get('teacher/history');
    assert.strictEqual(history.json.records.length, 1);

    await a.send(['学生131']);
    await sleep(1150);
    const status = await a.get('teacher/status');
    assert.strictEqual(status.json.current.type, 'clear');
    history = await a.get('teacher/history');
    assert.strictEqual(history.json.records.length, 2);
  } finally {
    await s.stop();
  }
});

t('撤销校验最后记录，并只在大屏显示该记录时清屏', async () => {
  const s = await start();
  try {
    const a = await client(s.base, A, CLASS_A.password);
    const first = await a.send(['学生130']);
    const second = await a.send(['学生131']);

    const stale = await a.post('teacher/history/undo', { expectedRecordId: first.json.record.recordId });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.json.error, 'HISTORY_CONFLICT');

    const undone = await a.post('teacher/history/undo', { expectedRecordId: second.json.record.recordId });
    assert.strictEqual(undone.status, 200);
    assert.strictEqual(undone.json.displayCleared, true);
    assert.strictEqual(undone.json.current.type, 'clear');
  } finally {
    await s.stop();
  }
});

t('撤销最后记录不会清掉正在重发的另一条记录', async () => {
  const s = await start();
  try {
    const a = await client(s.base, A, CLASS_A.password);
    const first = await a.send(['学生130']);
    const second = await a.send(['学生131']);
    await a.post('teacher/history/resend', { recordId: first.json.record.recordId });

    const undone = await a.post('teacher/history/undo', { expectedRecordId: second.json.record.recordId });
    assert.strictEqual(undone.status, 200);
    assert.strictEqual(undone.json.displayCleared, false);
    assert.strictEqual(undone.json.current.recordId, first.json.record.recordId);
  } finally {
    await s.stop();
  }
});

t('清空找人记录保留当前大屏，并拒绝过期版本', async () => {
  const s = await start();
  try {
    const a = await client(s.base, A, CLASS_A.password);
    const sent = await a.send(['学生132']);
    const stale = await a.post('teacher/history/clear', { expectedVersion: 0 });
    assert.strictEqual(stale.status, 409);

    const cleared = await a.post('teacher/history/clear', { expectedVersion: sent.json.historyVersion });
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(cleared.json.removedCount, 1);
    assert.strictEqual(cleared.json.current.recordId, sent.json.record.recordId);

    const history = await a.get('teacher/history');
    assert.strictEqual(history.json.records.length, 0);
  } finally {
    await s.stop();
  }
});

t('重新发送生成新 deliveryId，但不新增记录或重复计数', async () => {
  const s = await start();
  try {
    const a = await client(s.base, A, CLASS_A.password);
    const first = await a.send(['学生130'], '', '物理老师');
    const resent = await a.post('teacher/history/resend', { recordId: first.json.record.recordId });
    assert.strictEqual(resent.status, 200);
    assert.notStrictEqual(resent.json.event.deliveryId, first.json.event.deliveryId);
    assert.strictEqual(resent.json.record.deliveryCount, 2);
    assert.strictEqual(resent.json.event.caller, '物理老师');

    const history = await a.get('teacher/history');
    assert.strictEqual(history.json.records.length, 1);
    assert.strictEqual(history.json.records[0].deliveryCount, 2);
  } finally {
    await s.stop();
  }
});

t('名单重载后，含已移除学生的旧记录不能重发', async () => {
  const s = await start();
  try {
    const a = await client(s.base, A, CLASS_A.password);
    const sent = await a.send(['学生130']);
    fs.writeFileSync(s.configFile, configJson([
      { ...CLASS_A, launcher: { mode: 'native', freshSeconds: 30 }, students: ['学生131', '学生132'] },
      CLASS_B,
    ]));
    await a.post('teacher/reload');

    const resent = await a.post('teacher/history/resend', { recordId: sent.json.record.recordId });
    assert.strictEqual(resent.status, 400);
    assert.strictEqual(resent.json.error, 'UNKNOWN_STUDENT');
  } finally {
    await s.stop();
  }
});

t('status 分开统计大屏和原生启动器连接', async () => {
  const s = await start();
  let display;
  let launcher;
  try {
    const a = await client(s.base, A, CLASS_A.password);
    [display, launcher] = await Promise.all([
      openStream(s.base, A, 'display'),
      openStream(s.base, A, 'launcher'),
    ]);
    const status = await a.get('teacher/status');
    assert.strictEqual(status.json.displays, 1);
    assert.strictEqual(status.json.launchers, 1);
  } finally {
    if (display) display.destroy();
    if (launcher) launcher.destroy();
    await s.stop();
  }
});

t('内存记录超过上限时只淘汰最旧记录', () => {
  const state = new LessonState({ historyLimit: 2 });
  const options = { autoClearSeconds: 0, launchFreshSeconds: 30 };
  const a = state.call({ names: ['甲'], message: '', ...options });
  state.call({ names: ['乙'], message: '', ...options });
  state.call({ names: ['丙'], message: '', ...options });
  const history = state.historySnapshot();
  assert.strictEqual(history.records.length, 2);
  assert.strictEqual(history.droppedRecords, 1);
  assert.strictEqual(state.getRecord(a.record.recordId), null);
  state.dispose();
});
