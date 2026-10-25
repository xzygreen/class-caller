'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { launch, closeBrowserAndServer } = require('./browser-cdp-support.cjs');
const { start, teacherWithAccess } = require('./helpers');

const click = (page, id) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const set = (page, id, value) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}`);
async function capture(page, name) {
  if (!process.env.CC_STUDENT_SCREENSHOTS) return;
  fs.mkdirSync(process.env.CC_STUDENT_SCREENSHOTS, { recursive: true });
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.env.CC_STUDENT_SCREENSHOTS, name + '.png'), Buffer.from(data, 'base64'));
}
async function fits(page, selector) {
  assert.equal(await page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}), r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && n.scrollWidth <= n.clientWidth + 1; })()`), true, selector + ' fits viewport');
}

test('大屏反向呼叫：真实浏览器发送/重试/回复/刷新/撤回与桌面手机布局', { timeout: 120000 }, async (t) => {
  const s = await start({ at: Date.now() }); let browser;
  try {
    const { user, client, admin } = await teacherWithAccess(s.base, ['class-a']);
    await admin.put('/api/admin/call-windows', { weekdays: [0,1,2,3,4,5,6], windows: [{ start: '00:00', end: '23:59' }] });
    browser = await launch(); t.diagnostic(browser.version);
    const display = await browser.page(), teacher = await browser.page({ cookie: client.cookie, base: s.base });
    await display.goto(s.base + '/display?class=class-a');
    await display.waitFor('!document.getElementById("btnCallTeacher").hidden');
    await click(display, 'btnCallTeacher');
    await display.waitFor('!document.getElementById("studentCallSend").disabled');
    await set(display, 'studentCallName', '学生130');
    await set(display, 'studentCallTeacher', user.id);
    await set(display, 'studentCallMessage', '请到教室，有一道题想请教');
    assert.ok((await display.ax()).some((n) => n.role?.value === 'dialog' && n.name?.value === '呼叫老师'));
    await capture(display, 'display-desktop');
    await display.resize(390, 844); await fits(display, '#studentCallDialog'); await fits(display, '#studentCallFields');
    await capture(display, 'display-mobile');
    // 服务器已收下，但浏览器未收到成功响应：重试必须回到同一回执。
    await display.evaluate(`(() => { const original = fetch; let lose = true; window.fetch = async (...args) => { const result = await original(...args); if (lose && String(args[0]).endsWith('/public/student-calls')) { lose = false; throw new TypeError('synthetic lost response'); } return result; }; })()`);
    await click(display, 'studentCallSend');
    await display.waitFor('document.getElementById("studentCallError").textContent.includes("连接中断") && !document.getElementById("studentCallSend").disabled');
    assert.equal(s.app.store.get().studentCalls.length, 1);
    await click(display, 'studentCallSend');
    await display.waitFor('document.getElementById("studentCallReceipts").textContent.includes("等待老师回应")');
    assert.equal(s.app.store.get().studentCalls.length, 1);
    const id = s.app.store.get().studentCalls[0].id;
    await teacher.goto(s.base + '/teacher');
    await teacher.waitFor('document.getElementById("studentInboxButton").textContent.includes("1 待回应")');
    await click(teacher, 'studentInboxButton');
    await teacher.waitFor('document.getElementById("reply-' + id + '")');
    await teacher.evaluate('Promise.all(document.getElementById("studentInboxDialog").getAnimations().map(a => a.finished))');
    const hitHeights = await teacher.evaluate('["studentInboxButton", "studentInboxRefresh"].map(id => ({ id, height: document.getElementById(id).getBoundingClientRect().height }))');
    assert.ok(hitHeights.every(item => item.height >= 44), '新增入口和刷新按钮适合触控：' + JSON.stringify(hitHeights));
    await capture(teacher, 'teacher-desktop');
    await teacher.resize(390, 844); await fits(teacher, '#studentInboxDialog'); await fits(teacher, '.student-inbox-form');
    await capture(teacher, 'teacher-mobile');
    await set(teacher, 'reply-' + id, '收到，五分钟后到教室');
    await click(teacher, 'studentInboxRefresh');
    await teacher.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
    assert.equal(await teacher.evaluate(`document.getElementById('reply-${id}').value`), '收到，五分钟后到教室', '轮询保留回复草稿');
    await teacher.evaluate('document.querySelector(".student-inbox-form").requestSubmit()');
    await display.waitFor('document.getElementById("studentCallReceipts").textContent.includes("五分钟后到教室")');
    await display.goto(s.base + '/display?class=class-a&callTeacher=1');
    await display.waitFor('document.getElementById("studentCallDialog").open && document.getElementById("studentCallReceipts").textContent.includes("五分钟后到教室")');
    await display.waitFor('!document.getElementById("studentCallSend").disabled');
    await set(display, 'studentCallName', '学生131'); await set(display, 'studentCallTeacher', user.id);
    await click(display, 'studentCallSend');
    await display.waitFor('document.querySelector(".student-receipt button:not([hidden])")');
    const secondId = s.app.store.get().studentCalls.at(-1).id;
    await teacher.waitFor('document.getElementById("reply-' + secondId + '")');
    await teacher.evaluate(`document.getElementById('reply-${secondId}').focus()`);
    await display.evaluate('document.querySelector(".student-receipt button:not([hidden])").click()');
    await display.waitFor('document.getElementById("studentCallReceipts").textContent.includes("已撤回")');
    await teacher.waitFor('document.getElementById("studentInbox").textContent.includes("学生已撤回")');
    assert.equal(await teacher.evaluate('document.activeElement.textContent.includes("学生已撤回")'), true, '学生撤回时将教师输入焦点留在该条状态');
    // 正向呼叫在反向呼叫弹窗打开/关闭后仍正常接收、确认。
    await click(display, 'studentCallClose');
    assert.equal((await client.send('class-a', ['学生132'], '带上作业本')).status, 200);
    await display.waitFor('currentEvent && currentEvent.message === "带上作业本"');
    await click(display, 'ack');
    await display.waitFor('currentEvent.acks.length === 1');
    await teacher.goto(s.base + '/teacher?class=class-a');
    await teacher.waitFor('classId === "class-a" && !document.getElementById("klassView").hidden');
    await fits(teacher, '.top-in');
    await teacher.resize(768, 1024); await fits(teacher, '.top-in');

    // 已打开收件箱时若服务端要求改密，弹窗必须让出闸门并清除旧收件内容。
    await click(teacher, 'studentInboxButton');
    await s.app.store.update((db) => { db.users.find((u) => u.id === user.id).mustChangePassword = true; });
    await click(teacher, 'studentInboxRefresh');
    await teacher.waitFor('!document.getElementById("gate").hidden && !document.getElementById("passwordForm").hidden');
    assert.equal(await teacher.evaluate('document.getElementById("studentInboxDialog").open'), false);
    assert.equal(await teacher.evaluate('document.getElementById("studentInbox").children.length'), 0);
    assert.equal(await teacher.evaluate('document.activeElement.id'), 'newPwd');
    await s.app.store.update((db) => { db.users.find((u) => u.id === user.id).mustChangePassword = false; });
    await teacher.goto(s.base + '/teacher');
    await teacher.waitFor('!document.getElementById("app").hidden');

    // 最早一条仍待回应，九条已结束：第十一条不能挤掉那个有效回执。
    const sample = s.app.store.get().studentCalls[0], stamp = Date.now();
    const history = Array.from({ length: 10 }, (_, i) => ({ ...sample, id: randomUUID(), requestId: randomUUID(), createdAt: stamp - 120000 - (10 - i) * 1000,
      expiresAt: stamp + 30 * 60_000, status: i === 0 ? 'pending' : 'replied', reply: i === 0 ? '' : '合成历史回应', repliedAt: i === 0 ? null : stamp }));
    await s.app.store.update((db) => { db.studentCalls = history; });
    await display.evaluate(`localStorage.setItem('cc.student-calls.class-a', ${JSON.stringify(JSON.stringify(history.map((c) => c.id)))});`);
    await display.goto(s.base + '/display?class=class-a&callTeacher=1');
    await display.waitFor('document.querySelectorAll(".student-receipt").length === 10 && !document.getElementById("studentCallSend").disabled');
    await set(display, 'studentCallName', '学生132'); await set(display, 'studentCallTeacher', user.id);
    await click(display, 'studentCallSend');
    await display.waitFor('document.querySelectorAll(".student-receipt button:not([hidden])").length === 2');
    const saved = await display.evaluate('JSON.parse(localStorage.getItem("cc.student-calls.class-a"))');
    assert.equal(saved.length, 10); assert.ok(saved.includes(history[0].id));
    const newId = s.app.store.get().studentCalls.at(-1).id;
    const target = '[data-call-id="' + history[0].id + '"] button';
    assert.deepEqual(await display.evaluate('[...document.querySelectorAll(".student-receipt button:not([hidden])")].map(n => n.parentElement.dataset.callId)'), [newId, history[0].id]);
    await display.evaluate('document.querySelector(".student-receipt button:not([hidden])").focus()');
    await display.key('Tab');
    assert.equal(await display.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(target)})`), true, 'Tab 从顶部新呼叫到下方旧呼叫，与视觉顺序一致');
    await display.evaluate(`document.querySelector(${JSON.stringify(target)}).focus()`);
    await client.post('/api/me/student-calls/' + newId + '/reply', { reply: '另一条的新回应' });
    await display.waitFor('document.getElementById("studentCallReceipts").textContent.includes("另一条的新回应")');
    assert.equal(await display.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(target)})`), true, '其他回执更新不夺走撤回按钮的焦点');
    await display.evaluate(`document.querySelector(${JSON.stringify(target)}).click()`);
    await display.waitFor(`document.querySelector('[data-call-id="${history[0].id}"]').textContent.includes('已撤回')`);
    assert.equal(await display.evaluate(`document.activeElement === document.querySelector('[data-call-id="${history[0].id}"] p')`), true, '当前撤回完成后焦点留在该条状态');
    await capture(display, 'receipts-mobile');
    await display.send('Page.bringToFront');
    await display.resize(1366, 768); await fits(display, '#studentCallDialog'); await capture(display, 'receipts-desktop');
    assert.deepEqual(browser.errors, []);
  } catch (error) {
    t.diagnostic(error.stack || String(error));
    throw error;
  } finally {
    try { await closeBrowserAndServer(browser, s); }
    catch (error) { t.diagnostic(require('node:util').inspect(error, { depth: 6 })); throw error; }
  }
});
