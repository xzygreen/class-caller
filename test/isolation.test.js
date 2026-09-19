'use strict';

/**
 * 跨班隔离：上线前必须全部通过的清单。
 * 甲班 class-a / 乙班 class-b，两个班有同名学生「学生131」。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const {
  CLASS_A, CLASS_B, configJson, start, req, cp, client, ack, sse, openStream, sleep,
} = require('./helpers');

const TIMEOUT = 20_000;
const t = (name, fn) => test(name, { timeout: TIMEOUT }, fn);
const A = CLASS_A.id;
const B = CLASS_B.id;

t('两个班能同时发送不同通知，互不覆盖', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const b = await client(s.base, B, CLASS_B.password);

  const ra = await a.send(['学生130'], '甲班到办公室');
  const rb = await b.send(['李四'], '乙班到操场');
  assert.strictEqual(ra.status, 200);
  assert.strictEqual(rb.status, 200);

  const sa = await a.get('teacher/status');
  const sb = await b.get('teacher/status');
  assert.deepStrictEqual(sa.json.current.names, ['学生130']);
  assert.strictEqual(sa.json.current.message, '甲班到办公室');
  assert.strictEqual(sa.json.current.classId, A);
  assert.deepStrictEqual(sb.json.current.names, ['李四']);
  assert.strictEqual(sb.json.current.message, '乙班到操场');
  assert.strictEqual(sb.json.current.classId, B);
  await s.stop();
});

t('甲班令牌不能访问乙班的名单、历史、状态和操作接口', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const attempts = [
    ['GET', 'teacher/students'], ['GET', 'teacher/history'], ['GET', 'teacher/status'],
    ['POST', 'teacher/call', { names: ['李四'] }], ['POST', 'teacher/clear', {}],
    ['POST', 'teacher/history/undo', {}], ['POST', 'teacher/history/clear', {}],
    ['POST', 'teacher/history/resend', {}], ['POST', 'teacher/reload', {}], ['POST', 'teacher/logout', {}],
  ];
  for (const [method, sub, body] of attempts) {
    const res = await a.cross(B, method, sub, body);
    assert.strictEqual(res.status, 403, `${method} ${sub} 应拒绝`);
    assert.strictEqual(res.json.error, 'CLASS_MISMATCH');
    assert.ok(!res.body.includes('李四') && !res.body.includes('赵六'), '拒绝时不能泄露乙班名单');
  }
  // 乙班状态没有被上面任何一次尝试改动
  const b = await client(s.base, B, CLASS_B.password);
  const status = await b.get('teacher/status');
  assert.strictEqual(status.json.current.type, 'clear');
  // 甲班自己的令牌在甲班依然有效（被拒时不会被吊销）
  assert.strictEqual((await a.get('teacher/status')).status, 200);
  await s.stop();
});

t('甲班密码不能登录乙班', async () => {
  const s = await start();
  const res = await req(s.base, 'POST', cp(B, 'teacher/login'), { body: { password: CLASS_A.password } });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.json.error, 'INVALID_PASSWORD');
  await s.stop();
});

t('请求体里的 classId 不作依据，只认路径与会话', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  // 在甲班路径上冒充乙班：照常在甲班执行，只通知甲班的人
  const res = await a.post('teacher/call', { classId: B, names: ['学生130'] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.event.classId, A);
  const b = await client(s.base, B, CLASS_B.password);
  assert.strictEqual((await b.get('teacher/status')).json.current.type, 'clear');
  await s.stop();
});

t('甲班大屏收不到乙班消息', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const b = await client(s.base, B, CLASS_B.password);
  const streamA = sse(s.base, A, 2, { timeoutMs: 1200 });
  await sleep(100);
  await b.send(['李四']);
  await sleep(300);
  await a.send(['学生130']);
  const got = await streamA;
  assert.strictEqual(got.length, 2, '甲班只应收到首帧 clear 和自己的 call');
  assert.strictEqual(got[0].type, 'clear');
  assert.strictEqual(got[1].type, 'call');
  assert.deepStrictEqual(got[1].names, ['学生130']);
  assert.ok(got.every((ev) => ev.classId === A));
  await s.stop();
});

t('跨班「收到」确认被拒绝', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const b = await client(s.base, B, CLASS_B.password);
  const ra = await a.send(['学生131']);
  const rb = await b.send(['学生131']);          // 两个班都在找各自的学生131

  // 用甲班的 eventId 去乙班确认：id 对不上 → 409
  const wrong = await ack(s.base, B, { eventId: ra.json.event.id, names: ['学生131'] });
  assert.strictEqual(wrong.status, 409);
  assert.strictEqual(wrong.json.error, 'ACK_STALE');

  // 乙班正常确认，只影响乙班
  const ok = await ack(s.base, B, { eventId: rb.json.event.id, names: ['学生131'] });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.event.classId, B);
  const sa = await a.get('teacher/status');
  assert.deepStrictEqual(sa.json.current.acks, [], '甲班的学生131不应被标记为已收到');
  await s.stop();
});

t('清空甲班大屏不影响乙班', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const b = await client(s.base, B, CLASS_B.password);
  await a.send(['学生130']);
  await b.send(['李四']);
  await a.post('teacher/clear');
  assert.strictEqual((await a.get('teacher/status')).json.current.type, 'clear');
  const sb = await b.get('teacher/status');
  assert.strictEqual(sb.json.current.type, 'call');
  assert.deepStrictEqual(sb.json.current.names, ['李四']);
  await s.stop();
});

t('撤销、重发、清空历史只影响本班', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const b = await client(s.base, B, CLASS_B.password);
  const ra = await a.send(['学生130']);
  const rb = await b.send(['李四']);

  // 甲班用乙班的 recordId 撤销/重发：乙班记录对甲班不可见
  const undo = await a.post('teacher/history/undo', { expectedRecordId: rb.json.record.recordId });
  assert.strictEqual(undo.status, 409);
  const resend = await a.post('teacher/history/resend', { recordId: rb.json.record.recordId });
  assert.strictEqual(resend.status, 404);
  assert.strictEqual(resend.json.error, 'HISTORY_RECORD_NOT_FOUND');

  // 甲班清空自己的历史，乙班历史原样
  const wipe = await a.post('teacher/history/clear', { expectedVersion: ra.json.historyVersion });
  assert.strictEqual(wipe.status, 200);
  assert.strictEqual((await a.get('teacher/history')).json.records.length, 0);
  const hb = await b.get('teacher/history');
  assert.strictEqual(hb.json.records.length, 1);
  assert.strictEqual(hb.json.classId, B);

  // 乙班撤销自己的：只清乙班大屏
  const undoB = await b.post('teacher/history/undo', { expectedRecordId: rb.json.record.recordId });
  assert.strictEqual(undoB.status, 200);
  assert.strictEqual(undoB.json.displayCleared, true);
  assert.strictEqual((await a.get('teacher/status')).json.current.type, 'call', '甲班大屏仍显示');
  await s.stop();
});

t('两个班的自动清屏计时器互不影响', async () => {
  const s = await start({ a: { autoClearSeconds: 1 }, b: { autoClearSeconds: 0 } });
  const a = await client(s.base, A, CLASS_A.password);
  const b = await client(s.base, B, CLASS_B.password);
  await a.send(['学生130']);
  await b.send(['李四']);
  await sleep(1200);
  assert.strictEqual((await a.get('teacher/status')).json.current.type, 'clear', '甲班 1 秒后清屏');
  assert.strictEqual((await b.get('teacher/status')).json.current.type, 'call', '乙班常驻，不受甲班计时器影响');
  await s.stop();
});

t('不同班级存在同名学生时不会串记录', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const b = await client(s.base, B, CLASS_B.password);
  await a.send(['学生131']);
  await a.send(['学生131']);
  await b.send(['学生131']);
  const ha = await a.get('teacher/history');
  const hb = await b.get('teacher/history');
  assert.strictEqual(ha.json.records.length, 2);
  assert.strictEqual(hb.json.records.length, 1);
  assert.ok(ha.json.records.every((r) => r.names[0] === '学生131'));
  await s.stop();
});

t('同一浏览器同时持有两个班的令牌：各自只在自己的班有效', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const b = await client(s.base, B, CLASS_B.password);
  assert.notStrictEqual(a.token, b.token);
  assert.strictEqual((await a.get('teacher/students')).json.classId, A);
  assert.strictEqual((await b.get('teacher/students')).json.classId, B);
  assert.strictEqual((await a.cross(B, 'GET', 'teacher/students')).status, 403);
  assert.strictEqual((await b.cross(A, 'GET', 'teacher/students')).status, 403);
  // 甲班登出不影响乙班
  await a.post('teacher/logout');
  assert.strictEqual((await a.get('teacher/status')).status, 401);
  assert.strictEqual((await b.get('teacher/status')).status, 200);
  await s.stop();
});

t('大屏缺少班级参数或班级不存在时，不会加入任何班', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const b = await client(s.base, B, CLASS_B.password);

  const missing = await req(s.base, 'GET', '/api/classes//public/stream');
  assert.strictEqual(missing.status, 404);
  const unknown = await req(s.base, 'GET', cp('class-zz', 'public/stream?role=display'));
  assert.strictEqual(unknown.status, 404);
  assert.strictEqual(unknown.json.error, 'CLASS_NOT_FOUND');
  const legacy = await req(s.base, 'GET', '/api/public/stream?role=display');
  assert.strictEqual(legacy.status, 410);

  await sleep(100);
  assert.strictEqual((await a.get('teacher/status')).json.displays, 0);
  assert.strictEqual((await b.get('teacher/status')).json.displays, 0);
  await s.stop();
});

t('大屏在线数按班级分别统计', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const b = await client(s.base, B, CLASS_B.password);
  const streams = [
    await openStream(s.base, A), await openStream(s.base, A), await openStream(s.base, B),
    await openStream(s.base, B, 'launcher'), await openStream(s.base, A, 'teacher'),
  ];
  try {
    const sa = await a.get('teacher/status');
    const sb = await b.get('teacher/status');
    assert.strictEqual(sa.json.displays, 2);
    assert.strictEqual(sa.json.launchers, 0);
    assert.strictEqual(sb.json.displays, 1);
    assert.strictEqual(sb.json.launchers, 1);
  } finally {
    for (const r of streams) r.destroy();
    await s.stop();
  }
});

t('服务重启后各班均为空闲状态，不残留旧通知', async () => {
  const first = await start();
  const a = await client(first.base, A, CLASS_A.password);
  await a.send(['学生130']);
  await first.stop();

  const second = await start();
  for (const id of [A, B]) {
    const events = await sse(second.base, id, 1, { timeoutMs: 1500 });
    assert.strictEqual(events[0].type, 'clear');
  }
  // 旧令牌也失效
  const stale = await req(second.base, 'GET', cp(A, 'teacher/status'), { token: a.token });
  assert.strictEqual(stale.status, 401);
  await second.stop();
});

t('配置重载：移除的班级连接被关闭、会话作废；保留的班级状态不变', async () => {
  const s = await start();
  const a = await client(s.base, A, CLASS_A.password);
  const b = await client(s.base, B, CLASS_B.password);
  await a.send(['学生130']);

  const byeB = sse(s.base, B, 1, { timeoutMs: 100 }); // 先拿首帧，连接保持到超时被销毁
  await byeB;
  const streamB = await openStream(s.base, B);
  let closed = false;
  streamB.on('close', () => { closed = true; });

  fs.writeFileSync(s.configFile, configJson([CLASS_A]));
  const reload = await a.post('teacher/reload');
  assert.strictEqual(reload.status, 200);
  assert.deepStrictEqual(reload.json.classes, [{ id: A, count: 3 }]);

  await sleep(200);
  assert.strictEqual(closed, true, '被移除班级的大屏连接应被关闭');
  assert.strictEqual((await b.get('teacher/status')).status, 404);
  assert.strictEqual((await req(s.base, 'GET', cp(B, 'public/config'))).status, 404);

  // 甲班正在显示的通知不受影响
  const sa = await a.get('teacher/status');
  assert.strictEqual(sa.json.current.type, 'call');
  assert.deepStrictEqual(sa.json.current.names, ['学生130']);
  await s.stop();
});
