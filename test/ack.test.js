'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { LessonState } = require('../lib/state');
const { CLASS_A, start, client, ack, sse, sleep } = require('./helpers');

const TIMEOUT = 15_000;
const t = (name, fn) => test(name, { timeout: TIMEOUT }, fn);
const A = CLASS_A.id;

t('通知快照带 acks 字段，初始为空；clear 也带空数组；快照带 classId', () => {
  const state = new LessonState({ classId: 'x', onChange() {} });
  assert.deepStrictEqual(state.snapshot().acks, []);
  assert.strictEqual(state.snapshot().classId, 'x');
  state.call({ names: ['学生130'], message: '', autoClearSeconds: 0, launchFreshSeconds: 30 });
  assert.deepStrictEqual(state.snapshot().acks, []);
  assert.strictEqual(state.snapshot().classId, 'x');
  state.dispose();
});

t('POST 班级 public/ack 不需要密码，把当前通知的姓名标记为已收到并广播', async () => {
  const s = await start();
  try {
    const a = await client(s.base, A, CLASS_A.password);
    const call = await a.send(['学生130', '学生131'], '请到办公室');
    assert.strictEqual(call.status, 200);
    const eventId = call.json.event.id;

    const stream = sse(s.base, A, 2, { timeoutMs: 3000 });
    const res = await ack(s.base, A, { eventId, names: ['学生130'] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(res.json.added, 1);
    assert.strictEqual(res.json.allAcked, false);
    assert.deepStrictEqual(res.json.event.acks.map((x) => x.name), ['学生130']);
    assert.ok(res.json.event.acks[0].at > 0);
    assert.strictEqual(res.json.event.id, eventId, '确认不会改变通知 id，大屏不应重新响铃');

    const events = await stream;
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(events[1].acks.map((x) => x.name), ['学生130']);
    assert.strictEqual(events[1].type, 'call');

    // 教师端也能通过 status 看到 acks
    const status = await a.get('teacher/status');
    assert.deepStrictEqual(status.json.current.acks.map((x) => x.name), ['学生130']);
  } finally {
    await s.stop();
  }
});

t('不带 names 表示全部收到；重复确认幂等且不再广播', async () => {
  const s = await start();
  try {
    const a = await client(s.base, A, CLASS_A.password);
    const call = await a.send(['学生130', '学生131']);
    const eventId = call.json.event.id;

    const first = await ack(s.base, A, { eventId });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.json.added, 2);
    assert.strictEqual(first.json.allAcked, true);

    const stream = sse(s.base, A, 2, { timeoutMs: 800 });
    const again = await ack(s.base, A, { eventId, names: ['学生131'] });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.json.added, 0);
    assert.strictEqual(again.json.allAcked, true);
    assert.strictEqual(again.json.event.acks.length, 2);
    const events = await stream;
    assert.strictEqual(events.length, 1, '没有新增确认时不应广播');
  } finally {
    await s.stop();
  }
});

t('过期或错误的 eventId、不在当前通知中的姓名都被拒绝，且不泄露名单', async () => {
  const s = await start();
  try {
    const a = await client(s.base, A, CLASS_A.password);
    const stale = await ack(s.base, A, { eventId: 12345 });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.json.error, 'ACK_STALE');

    const bad = await ack(s.base, A, { eventId: 'x' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.error, 'INVALID_EVENT_ID');

    const call = await a.send(['学生130']);
    const eventId = call.json.event.id;
    // 学生132在名单里但不在本条通知里：必须被拒，且响应和名单里的其他人无关
    const unknown = await ack(s.base, A, { eventId, names: ['学生132'] });
    assert.strictEqual(unknown.status, 400);
    assert.strictEqual(unknown.json.error, 'ACK_UNKNOWN_NAME');
    const nobody = await ack(s.base, A, { eventId, names: ['路人甲'] });
    assert.strictEqual(nobody.status, 400);
    assert.strictEqual(nobody.json.error, 'ACK_UNKNOWN_NAME');
    const notArray = await ack(s.base, A, { eventId, names: '学生130' });
    assert.strictEqual(notArray.status, 400);

    await a.post('teacher/clear');
    const afterClear = await ack(s.base, A, { eventId });
    assert.strictEqual(afterClear.status, 409);
    assert.strictEqual(afterClear.json.error, 'ACK_STALE');
  } finally {
    await s.stop();
  }
});

t('再次通知产生新的 id 并清空 acks；撤销当前通知后确认失效', async () => {
  const s = await start();
  try {
    const a = await client(s.base, A, CLASS_A.password);
    const call = await a.send(['学生130']);
    const first = call.json.event.id;
    await ack(s.base, A, { eventId: first });

    const resend = await a.post('teacher/history/resend', { recordId: call.json.record.recordId });
    assert.strictEqual(resend.status, 200);
    assert.notStrictEqual(resend.json.event.id, first);
    assert.deepStrictEqual(resend.json.event.acks, []);

    const old = await ack(s.base, A, { eventId: first });
    assert.strictEqual(old.status, 409);

    const undo = await a.post('teacher/history/undo', { expectedRecordId: call.json.record.recordId });
    assert.strictEqual(undo.status, 200);
    assert.strictEqual(undo.json.displayCleared, true);
    const gone = await ack(s.base, A, { eventId: resend.json.event.id });
    assert.strictEqual(gone.status, 409);
  } finally {
    await s.stop();
  }
});

t('teacher 角色的 SSE 连接不计入大屏数，但能实时收到 acks', async () => {
  const s = await start();
  try {
    const a = await client(s.base, A, CLASS_A.password);
    const stream = sse(s.base, A, 3, { role: 'teacher', timeoutMs: 3000 });
    await sleep(150);
    const status = await a.get('teacher/status');
    assert.strictEqual(status.json.displays, 0);
    assert.strictEqual(status.json.launchers, 0);

    const call = await a.send(['学生131']);
    await ack(s.base, A, { eventId: call.json.event.id });
    const events = await stream;
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[2].type, 'call');
    assert.deepStrictEqual(events[2].acks.map((x) => x.name), ['学生131']);
  } finally {
    await s.stop();
  }
});
