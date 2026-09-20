'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { DisplayQueue } = require('../lib/display');
const { PRIORITY } = require('../lib/constants');
const {
  CLASS_A, CLASS_B, TEACHER2, start, req, cp, asAdmin, register, teacherWithAccess, ack, sse, openStream, sleep,
} = require('./helpers');

const t = (name, fn) => test(name, { timeout: 20_000 }, fn);
const A = CLASS_A.id;
const B = CLASS_B.id;

// ---------------------------------------------------------------- 点人

t('点人：快照带班级、找人教师、姓名、说明与过期时间；记录写入数据仓库', async () => {
  const s = await start();
  try {
    const { client } = await teacherWithAccess(s.base, [A]);
    const res = await client.send(A, ['学生130', '学生131'], '到讲台来');
    assert.strictEqual(res.status, 200);
    const ev = res.json.event;
    assert.strictEqual(ev.type, 'call');
    assert.strictEqual(ev.classId, A);
    assert.deepStrictEqual(ev.names, ['学生130', '学生131']);
    assert.strictEqual(ev.message, '到讲台来');
    assert.strictEqual(ev.caller, '数学老师 · 张老师');
    assert.ok(ev.id > 0);
    assert.ok(ev.expiresAt > ev.createdAt);
    assert.strictEqual(ev.queued, 0);
    assert.strictEqual(res.json.displayedNow, true);
    const payload = JSON.parse(Buffer.from(ev.launchPayload, 'base64url').toString('utf8'));
    assert.strictEqual(payload.classId, A);
    assert.deepStrictEqual(payload.students, ['学生130', '学生131']);

    const list = await client.cget(A, 'notices');
    assert.strictEqual(list.json.notices.length, 1);
    assert.strictEqual(list.json.notices[0].type, 'call');
    assert.strictEqual(list.json.notices[0].authorName, '张老师');
    assert.strictEqual(list.json.notices[0].source, 'manual');
  } finally { await s.stop(); }
});

t('点人参数校验：只能选本班名单内的学生', async () => {
  const s = await start();
  try {
    const { client } = await teacherWithAccess(s.base, [A]);
    const cases = [
      [{ names: '学生130' }, 'INVALID_NAMES'],
      [{ names: ['  '] }, 'EMPTY_NAME'],
      [{ names: ['学生130', '学生130'] }, 'DUPLICATE_NAMES'],
      [{ names: ['查无此人'] }, 'UNKNOWN_STUDENT'],
      [{ names: ['李四'] }, 'UNKNOWN_STUDENT'],
      [{ names: new Array(21).fill('学生130') }, 'TOO_MANY_NAMES'],
      [{ names: ['学生130'], message: '啊'.repeat(61) }, 'MESSAGE_TOO_LONG'],
      [{ names: ['学生130'], message: 123 }, 'INVALID_MESSAGE'],
      [{ names: [] }, 'EMPTY_CALL'],
      [{}, 'INVALID_NAMES'],
    ];
    for (const [body, code] of cases) {
      const res = await client.cpost(A, 'calls', body);
      assert.strictEqual(res.status, 400, code);
      assert.strictEqual(res.json.error, code, JSON.stringify(body));
    }
    const raw = await req(s.base, 'POST', cp(A, 'calls'), { cookie: client.cookie, raw: '{不是json' });
    assert.strictEqual(raw.json.error, 'INVALID_JSON');
  } finally { await s.stop(); }
});

t('自动清屏到点后广播 clear；大屏「收到」只对当前点人有效', async () => {
  const s = await start();
  try {
    const admin = await asAdmin(s.base);
    await admin.patch(`/api/admin/classes/${A}`, { autoClearSeconds: 1 });
    const { client } = await teacherWithAccess(s.base, [A]);
    const events = sse(s.base, A, 3, { timeoutMs: 3000 });
    await sleep(120);
    const call = await client.send(A, ['学生130']);
    const got = await events;
    assert.strictEqual(got[0].type, 'clear');
    assert.strictEqual(got[1].type, 'call');
    assert.strictEqual(got[2].type, 'clear');
    const stale = await ack(s.base, A, { eventId: call.json.event.id });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.json.error, 'ACK_STALE');
  } finally { await s.stop(); }
});

t('「收到」确认：逐个或全部确认，结果同步到教师流', async () => {
  const s = await start();
  try {
    const { client } = await teacherWithAccess(s.base, [A]);
    const call = await client.send(A, ['学生130', '学生131']);
    const eventId = call.json.event.id;
    const teacherStream = sse(s.base, A, 2, { role: 'teacher', cookie: client.cookie, timeoutMs: 3000 });
    await sleep(100);
    const one = await ack(s.base, A, { eventId, names: ['学生130'] });
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.json.added, 1);
    assert.strictEqual(one.json.allAcked, false);
    const unknown = await ack(s.base, A, { eventId, names: ['学生132'] });
    assert.strictEqual(unknown.json.error, 'ACK_UNKNOWN_NAME');
    const all = await ack(s.base, A, { eventId });
    assert.strictEqual(all.json.allAcked, true);
    const events = await teacherStream;
    assert.deepStrictEqual(events[1].acks.map((a) => a.name), ['学生130']);
    const status = await client.cget(A, 'status');
    assert.strictEqual(status.json.display.current.acks.length, 2);
    assert.strictEqual(status.json.teachers, 0, '教师流已断开');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- 留言

t('留言不需要选择学生，不显示学生确认；快照带标题、正文、发布人', async () => {
  const s = await start();
  try {
    const { client } = await teacherWithAccess(s.base, [A]);
    const res = await client.announce(A, { title: '班级通知', body: '明天统一穿校服，请带好实验报告。', durationSeconds: 600 });
    assert.strictEqual(res.status, 200);
    const ev = res.json.event;
    assert.strictEqual(ev.type, 'announcement');
    assert.strictEqual(ev.title, '班级通知');
    assert.strictEqual(ev.body, '明天统一穿校服，请带好实验报告。');
    assert.strictEqual(ev.author, '数学老师 · 张老师');
    assert.deepStrictEqual(ev.names, []);
    assert.deepStrictEqual(ev.acks, []);
    assert.ok(ev.expiresAt > ev.createdAt);
    // 大屏对留言点「收到」被拒
    const bad = await ack(s.base, A, { eventId: ev.id });
    assert.strictEqual(bad.status, 409);

    const persistent = await client.announce(A, { title: '常驻', body: '持续显示', durationSeconds: 0 });
    assert.strictEqual(persistent.json.notice.expiresAt, null);
    assert.strictEqual(persistent.json.displayedNow, false, '同优先级排队');
    for (const [body, code] of [[{ body: 'x' }, 'INVALID_ANNOUNCEMENT'], [{ title: 'x'.repeat(31), body: 'y' }, 'TITLE_TOO_LONG'], [{ title: 't', body: 'y'.repeat(301) }, 'BODY_TOO_LONG']]) {
      const r = await client.announce(A, body);
      assert.strictEqual(r.json.error, code);
    }
    // 紧急广播仅管理员
    const urgent = await client.announce(A, { title: '紧急', body: '立即集合', urgent: true });
    assert.strictEqual(urgent.status, 403);
    const admin = await asAdmin(s.base);
    const ok = await admin.announce(A, { title: '紧急', body: '立即集合', urgent: true });
    assert.strictEqual(ok.json.event.priority, PRIORITY.URGENT);
  } finally { await s.stop(); }
});

t('定时发布的留言到点后由调度器推上大屏；「下一课间显示」策略推迟教师留言', async () => {
  const s = await start();
  try {
    const { client, admin } = await teacherWithAccess(s.base, [A]);
    const later = await client.announce(A, { title: '晚点', body: '稍后显示', publishAt: s.clock.now() + 60_000 });
    assert.strictEqual(later.json.notice.status, 'scheduled');
    assert.strictEqual(later.json.displayedNow, false);
    assert.strictEqual((await client.cget(A, 'status')).json.display.current.type, 'clear');
    s.clock.advance(61_000);
    await s.app.scheduler.tick();
    const st = await client.cget(A, 'status');
    assert.strictEqual(st.json.display.current.type, 'announcement');
    assert.strictEqual(st.json.display.current.title, '晚点');

    await admin.patch('/api/admin/settings', { announcementPolicy: 'next_window' });
    s.clock.set(require('../lib/timewin').zonedToMs('2026-09-21', 9 * 60 + 5));   // 上课中
    const deferred = await client.announce(A, { title: '课中', body: '推迟' });
    assert.strictEqual(deferred.json.notice.status, 'scheduled');
    assert.strictEqual(deferred.json.notice.publishAt, require('../lib/timewin').zonedToMs('2026-09-21', 9 * 60 + 45));
    const now = await admin.announce(A, { title: '管理员', body: '不推迟' });
    assert.strictEqual(now.json.notice.status, 'published');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- 队列

test('队列：高优先级抢占、被抢占者回队、持续留言作为底色、优先级顺序', () => {
  let fake = 1_000_000;
  const now = () => fake;
  const q = new DisplayQueue({ classId: 'x', now });
  q.push({ noticeId: 'a1', type: 'announcement', title: '常驻', body: 'b', author: 'x', durationSeconds: 0 });
  assert.strictEqual(q.snapshot().type, 'announcement');
  const r = q.push({ noticeId: 'c1', type: 'call', names: ['甲'], message: '', caller: '老师', durationSeconds: 30, launchFreshSeconds: 30 });
  assert.strictEqual(r.displayedNow, true, '点人抢占留言');
  assert.strictEqual(q.snapshot().type, 'call');
  assert.strictEqual(q.snapshot().queued, 1);
  const r2 = q.push({ noticeId: 'c2', type: 'call', names: ['乙'], message: '', caller: '老师', durationSeconds: 30, launchFreshSeconds: 30 });
  assert.strictEqual(r2.displayedNow, false, '同优先级排队');
  const r3 = q.push({ noticeId: 's1', type: 'call', priority: PRIORITY.SCHEDULED, names: ['丙'], message: '', caller: '老师', durationSeconds: 30, launchFreshSeconds: 30 });
  assert.strictEqual(r3.displayedNow, true, '定时提醒优先于手动点人');
  assert.deepStrictEqual(q.overview().queue.map((i) => i.noticeId), ['c1', 'c2', 'a1']);
  q.clear();
  assert.strictEqual(q.snapshot().noticeId, 'c1', '被抢占的点人回来继续显示');
  q.clear();
  assert.strictEqual(q.snapshot().noticeId, 'c2');
  q.clear();
  assert.strictEqual(q.snapshot().noticeId, 'a1', '常驻留言最后回来');
  assert.strictEqual(q.snapshot().expiresAt, null);
  q.clear({ all: true });
  assert.strictEqual(q.snapshot().type, 'clear');
  q.dispose();
});

t('教师端能看到正在显示与等待显示；撤回会同时移出大屏和队列；重发不重复入队', async () => {
  const s = await start();
  try {
    const { client } = await teacherWithAccess(s.base, [A]);
    const ann = await client.announce(A, { title: '底色', body: '常驻', durationSeconds: 0 });
    const c1 = await client.send(A, ['学生130']);
    const c2 = await client.send(A, ['学生131']);
    const ws = await client.cget(A, 'workspace');
    assert.strictEqual(ws.json.display.current.noticeId, c1.json.notice.id);
    assert.deepStrictEqual(ws.json.display.queue.map((q) => q.noticeId), [c2.json.notice.id, ann.json.notice.id]);

    const wd = await client.cpost(A, `notices/${c2.json.notice.id}/withdraw`);
    assert.strictEqual(wd.status, 200);
    assert.strictEqual(wd.json.displayCleared, false);
    assert.strictEqual(wd.json.display.queue.length, 1);
    const wd2 = await client.cpost(A, `notices/${c1.json.notice.id}/withdraw`);
    assert.strictEqual(wd2.json.displayCleared, true);
    assert.strictEqual(wd2.json.event.type, 'announcement', '撤回后底色留言回到大屏');
    const list = await client.cget(A, 'notices');
    assert.strictEqual(list.json.notices.find((n) => n.id === c1.json.notice.id).status, 'withdrawn');

    const re = await client.cpost(A, `notices/${c1.json.notice.id}/resend`);
    assert.strictEqual(re.status, 200);
    assert.strictEqual(re.json.event.noticeId, c1.json.notice.id);
    assert.notStrictEqual(re.json.event.id, c1.json.event.id, '重发产生新的事件 id');
    const again = await client.cpost(A, `notices/${c1.json.notice.id}/resend`);
    assert.strictEqual(again.json.alreadyQueued, true);
    assert.strictEqual((await client.cget(A, 'notices')).json.notices.find((n) => n.id === c1.json.notice.id).deliveryCount, 2);
    const missing = await client.cpost(A, `notices/00000000-0000-4000-8000-000000000000/resend`);
    assert.strictEqual(missing.status, 404);

    const clear = await client.cpost(A, 'display/clear', { all: true });
    assert.strictEqual(clear.json.event.type, 'clear');
    assert.strictEqual(clear.json.display.queue.length, 0);
  } finally { await s.stop(); }
});

t('队列满时返回 QUEUE_FULL', async () => {
  const s = await start();
  try {
    const { client } = await teacherWithAccess(s.base, [A]);
    await client.send(A, ['学生130']);
    for (let i = 0; i < 20; i += 1) assert.strictEqual((await client.send(A, ['学生131'])).status, 200);
    const full = await client.send(A, ['学生132']);
    assert.strictEqual(full.status, 429);
    assert.strictEqual(full.json.error, 'QUEUE_FULL');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- 记录与隔离

t('记录页统一时间线：可按类型、教师、日期筛选', async () => {
  const s = await start();
  try {
    const { client, admin } = await teacherWithAccess(s.base, [A]);
    const { user: liUser } = await register(s.base, TEACHER2);
    await admin.post('/api/admin/memberships', { userId: liUser.id, classId: A });
    await client.send(A, ['学生130']);
    await client.announce(A, { title: 't', body: 'b' });
    const all = await client.cget(A, 'activity');
    assert.strictEqual(all.json.activity.length, 2);
    assert.strictEqual((await client.cget(A, 'activity?type=call')).json.activity.length, 1);
    assert.strictEqual((await client.cget(A, 'activity?type=announcement')).json.activity.length, 1);
    assert.strictEqual((await client.cget(A, `activity?author=${liUser.id}`)).json.activity.length, 0);
    const today = new Date(s.clock.now()).toISOString().slice(0, 10);
    assert.strictEqual((await client.cget(A, `activity?date=${today}`)).json.activity.length, 2);
    assert.strictEqual((await client.cget(A, 'activity?date=2000-01-01')).json.activity.length, 0);
  } finally { await s.stop(); }
});

t('多班级的通知、队列、历史和权限完全隔离；大屏收不到别班消息；同名学生不串记录', async () => {
  const s = await start();
  try {
    const { client: zhang, admin } = await teacherWithAccess(s.base, [A]);
    const { user: liUser } = await register(s.base, TEACHER2);
    await admin.post('/api/admin/memberships', { userId: liUser.id, classId: B });
    const li = require('./helpers').session(s.base, await require('./helpers').login(s.base, TEACHER2.username, TEACHER2.password));

    const streamA = sse(s.base, A, 2, { timeoutMs: 1200 });
    await sleep(80);
    await li.send(B, ['学生131'], '乙班');
    await sleep(200);
    await zhang.send(A, ['学生131'], '甲班');
    const got = await streamA;
    assert.strictEqual(got.length, 2);
    assert.ok(got.every((ev) => ev.classId === A));
    assert.strictEqual(got[1].message, '甲班');

    const ra = await zhang.cget(A, 'status');
    const rb = await li.cget(B, 'status');
    assert.strictEqual(ra.json.display.current.message, '甲班');
    assert.strictEqual(rb.json.display.current.message, '乙班');
    // 用甲班事件 id 去乙班确认
    const wrong = await ack(s.base, B, { eventId: ra.json.display.current.id });
    assert.strictEqual(wrong.status, 409);
    // 甲班清屏不影响乙班
    await zhang.cpost(A, 'display/clear');
    assert.strictEqual((await li.cget(B, 'status')).json.display.current.type, 'call');
    // 历史各自一份
    assert.strictEqual((await zhang.cget(A, 'notices')).json.notices.length, 1);
    assert.strictEqual((await li.cget(B, 'notices')).json.notices.length, 1);
    // 甲班老师不能撤回乙班通知
    const foreign = await zhang.cpost(B, `notices/${rb.json.display.current.noticeId}/withdraw`);
    assert.strictEqual(foreign.status, 403);
    // 用乙班 noticeId 在甲班路径撤回：找不到
    const cross = await zhang.cpost(A, `notices/${rb.json.display.current.noticeId}/withdraw`);
    assert.strictEqual(cross.status, 404);
  } finally { await s.stop(); }
});

t('大屏在线数按班级分别统计；公开流首帧同步当前状态；重连拿到同一事件 id', async () => {
  const s = await start();
  try {
    const { client } = await teacherWithAccess(s.base, [A, B]);
    const streams = [await openStream(s.base, A), await openStream(s.base, A), await openStream(s.base, B, 'launcher')];
    try {
      const sa = await client.cget(A, 'status');
      const sb = await client.cget(B, 'status');
      assert.strictEqual(sa.json.displays, 2);
      assert.strictEqual(sb.json.displays, 0);
      assert.strictEqual(sb.json.launchers, 1);
    } finally { for (const r of streams) r.destroy(); }
    const first = await client.send(A, ['学生132']);
    const x = await sse(s.base, A, 1, { timeoutMs: 1500 });
    const y = await sse(s.base, A, 1, { timeoutMs: 1500 });
    assert.strictEqual(x[0].id, y[0].id);
    assert.strictEqual(x[0].id, first.json.event.id);
    assert.ok(x[0].serverTime > 0);
    assert.strictEqual(x[0].students, undefined, '公开流不带名单');
  } finally { await s.stop(); }
});

t('服务重启后大屏为空闲，但通知记录与账号会话仍在', async () => {
  const first = await start();
  const dir = first.dir;
  const { client } = await teacherWithAccess(first.base, [A]);
  await client.send(first.base && A, ['学生130']);
  await first.app.close();

  const path = require('node:path');
  const { createApp } = require('../lib/app');
  const app = createApp({ dataFile: path.join(dir, 'data', 'db.json'), publicDir: path.join(__dirname, '..', 'public'), scheduler: false });
  await app.bootstrap();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const ev = await sse(base, A, 1, { timeoutMs: 1500 });
    assert.strictEqual(ev[0].type, 'clear');
    const me = await req(base, 'GET', '/api/me', { cookie: client.cookie });
    assert.strictEqual(me.status, 200, '会话持久化，重启不踢人');
    const list = await req(base, 'GET', cp(A, 'notices'), { cookie: client.cookie });
    assert.strictEqual(list.json.notices.length, 1);
  } finally {
    await app.close();
    require('node:fs').rmSync(dir, { recursive: true, force: true });
  }
});
