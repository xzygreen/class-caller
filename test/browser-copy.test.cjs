'use strict';

// Real DOM, text, native validation and AX checks with synthetic data only.
// Run: node --test test/browser-copy.test.cjs (Node >=22 + local Chrome).
const test = require('node:test');
const assert = require('node:assert/strict');
const { findChrome, launch, closeBrowserAndServer } = require('./browser-cdp-support.cjs');
const { start, asAdmin, teacherWithAccess, CLASS_A, CLASS_B, CLOSED_TIME } = require('./helpers');
const { version } = require('../package.json');
const chrome = findChrome();
const missing = !chrome ? 'No local Chrome; set CHROME_PATH' : typeof WebSocket !== 'function' ? 'Node >=22 required' : false;

const banned = /使用个人账号登录|注册后申请管理班级|继续之前需要|进入班级开始点人|管理员批准后立即生效|学生不需要点|缩略示意|不代表全文|重要地点和时间建议|长留言在大屏|时间必须在允许|定时提醒只能设在|默认每个上课日|比如每天第二节|发送后，这里|可以先选好学生|每个班对应一块大屏|账号属于个人|开始时间包含|结束时间不包含|暂停的任务不会执行|谁在什么时候做了什么|每页 20 条|紧急广播不受此设置|升级系统或怀疑|只用于编号章|不需要就保持关闭|首次登录时必须修改|只想临时|Managed Challenge|auth_basic|HTTP Basic Auth|ADMIN_USERNAME|init-admin|D:\\tools|API\/|由 xzygreen 开发|GitHub 开源项目|基于 MIT License/;
async function click(page, selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function setValue(page, selector, value, event = 'input') {
  await page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
}
async function noFiller(page, selector = 'body') {
  const text = await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).innerText`);
  assert.doesNotMatch(text, banned);
}
async function badge(page, selector) {
  await page.waitFor(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); return n && !n.hidden && n.textContent.includes(${JSON.stringify(version)}); })()`);
  const bounds = await page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}), r = n.getBoundingClientRect(); return { width: r.width, height: r.height, right: r.right, viewport: innerWidth, size: parseFloat(getComputedStyle(n).fontSize) }; })()`);
  assert.ok(bounds.width > 0 && bounds.height > 0 && bounds.right <= bounds.viewport + 1, JSON.stringify(bounds));
  assert.ok(bounds.size >= 12, JSON.stringify(bounds));
}
async function axName(page, role, name) {
  assert.ok((await page.ax()).some(n => n.role?.value === role && n.name?.value === name), role + ': ' + name);
}
async function submit(page, selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`); }

test('Task-only copy preserves controls, data, errors and full preview accessibility', { skip: missing, timeout: 180000 }, async t => {
  const s = await start({ classes: [{ ...CLASS_A, autoClearSeconds: 0, launcher: { mode: 'off', freshSeconds: 30 } }, CLASS_B] });
  let browser;
  try {
    const admin = await asAdmin(s.base);
    const { client: teacher, user } = await teacherWithAccess(s.base, ['class-a']);
    browser = await launch(chrome);
    t.diagnostic(browser.version + '; DOM/text/AX only, no screenshots');

    await t.test('login, registration and password gates keep labels and native constraints without tutorials', async () => {
      const page = await browser.page({ width: 390, height: 844 });
      await page.goto(s.base + '/teacher');
      await page.waitFor('!document.getElementById("gate").hidden');
      await badge(page, '#loginForm [data-app-version]');
      await noFiller(page);
      await axName(page, 'textbox', '登录名');
      await submit(page, '#loginForm');
      assert.equal(await page.evaluate('document.getElementById("loginErr").textContent'), '请输入登录名和密码');
      await click(page, '#toRegister');
      await badge(page, '#registerForm [data-app-version]');
      await noFiller(page);
      await setValue(page, '#regUser', 'bad name');
      assert.equal(await page.evaluate('document.getElementById("regUser").validity.patternMismatch'), true);
      await setValue(page, '#regUser', 'teacher.copy-7');
      assert.equal(await page.evaluate('document.getElementById("regUser").validity.valid'), true);
      assert.deepEqual(await page.evaluate('({required: regPwd.required, min: regPwd.minLength, max: regPwd.maxLength, nameMax: regName.maxLength})'), { required: true, min: 8, max: 128, nameMax: 20 });
      await page.evaluate('showPasswordGate()');
      await badge(page, '#passwordForm [data-app-version]');
      await noFiller(page);
      assert.equal(await page.evaluate('document.getElementById("newPwd2").required'), true);
      await page.evaluate('showGate("loginForm")');
      await click(page, '#forgot');
      assert.equal(await page.evaluate('document.getElementById("loginInfo").textContent'), '请联系管理员重置密码。');
      await setValue(page, '#loginUser', 'missing-user');
      await setValue(page, '#loginPwd', 'wrong-password');
      await submit(page, '#loginForm');
      await page.waitFor('document.getElementById("loginErr").textContent !== "请输入登录名和密码" && !document.getElementById("loginBtn").disabled');
      assert.ok(await page.evaluate('document.getElementById("loginErr").textContent.length > 0'));
      await page.close();

      const adminGate = await browser.page({ width: 390, height: 844 });
      await adminGate.goto(s.base + '/admin');
      await adminGate.waitFor('!document.getElementById("gate").hidden');
      await badge(adminGate, '#loginForm [data-app-version]');
      await noFiller(adminGate);
      await axName(adminGate, 'link', '教师端');
      assert.equal(await adminGate.evaluate('document.getElementById("loginPwd").required'), true);
      await adminGate.close();
    });

    await t.test('home and call show current data; closed windows disable sending without repeated warning prose', async () => {
      const page = await browser.page({ cookie: teacher.cookie, base: s.base, width: 390, height: 844 });
      await page.goto(s.base + '/teacher');
      await page.waitFor('document.querySelector("#myClasses .item")');
      await badge(page, '#app .top [data-app-version]');
      await noFiller(page);
      assert.match(await page.evaluate('document.getElementById("myClasses").innerText'), /甲班[\s\S]*3 名学生[\s\S]*进入班级/);
      assert.equal(await page.evaluate('document.getElementById("homeIntro")'), null);
      assert.equal(await page.evaluate('document.getElementById("requestClass").required'), true);
      assert.equal(await page.evaluate('document.getElementById("requestPanel").hidden'), false);
      await click(page, '#myClasses .btn-primary');
      await page.waitFor('classId === "class-a" && document.querySelector("#grid button")');
      await noFiller(page);
      assert.equal(await page.evaluate('document.getElementById("send").disabled'), true);
      await click(page, '#grid button');
      assert.equal(await page.evaluate('document.getElementById("send").disabled'), false);
      s.clock.set(CLOSED_TIME);
      await page.evaluate('pollStatus()');
      assert.equal(await page.evaluate('document.getElementById("send").disabled'), true);
      assert.match(await page.evaluate('document.getElementById("windowText").textContent'), /下次 .*可点人/);
      assert.equal(await page.evaluate('document.getElementById("windowNotice")'), null);
      assert.equal(await page.evaluate('sel.size'), 1);
      await noFiller(page);
      await page.close();
    });

    await t.test('announcement timing lives in the control and full preview remains keyboard/AX accessible', async () => {
      await admin.patch('/api/admin/settings', { announcementPolicy: 'next_window' });
      const page = await browser.page({ cookie: teacher.cookie, base: s.base });
      await page.goto(s.base + '/teacher?class=class-a');
      await page.waitFor('classId === "class-a"');
      await click(page, '#tabbtn-announce');
      await page.waitFor('document.getElementById("annList").textContent.includes("还没有留言")');
      await noFiller(page);
      assert.match(await page.evaluate('document.querySelector("#annWhen [value=now]").textContent'), /09:45–10:15 显示/);
      assert.equal(await page.evaluate('document.getElementById("annPolicyNote")'), null);
      assert.equal(await page.evaluate('document.getElementById("pvWarning")'), null);
      await setValue(page, '#annWhen', 'later', 'change');
      assert.equal(await page.evaluate('document.getElementById("annAt").required'), true);
      await setValue(page, '#annWhen', 'now', 'change');
      assert.equal(await page.evaluate('document.getElementById("annAt").required'), false);
      const body = ('完整正文\n').repeat(50).trim();
      await setValue(page, '#annTitle', '明日集合');
      await setValue(page, '#annBody', body);
      await page.send('Page.bringToFront');
      await page.evaluate('document.querySelector(".preview-full summary").focus(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await page.key(' ', 'Space');
      await page.waitFor('document.querySelector(".preview-full").open');
      assert.equal(await page.evaluate('document.getElementById("pvFullBody").textContent'), body);
      assert.ok((await page.ax()).some(n => n.name?.value.includes('完整正文')));
      assert.deepEqual(await page.evaluate('({titleMax: annTitle.maxLength, bodyMax: annBody.maxLength, titleRequired: annTitle.required, bodyRequired: annBody.required})'), { titleMax: 30, bodyMax: 300, titleRequired: true, bodyRequired: true });
      await noFiller(page);
      await page.close();

      const urgent = await browser.page({ cookie: admin.cookie, base: s.base });
      await urgent.goto(s.base + '/teacher?class=class-a');
      await urgent.waitFor('classId === "class-a"');
      await click(urgent, '#tabbtn-announce');
      await setValue(urgent, '#annTitle', '定时集合'); await setValue(urgent, '#annBody', '请前往操场');
      await click(urgent, '#annUrgent');
      await setValue(urgent, '#annWhen', 'later', 'change');
      await urgent.evaluate('(() => { const d = new Date(Date.now() + 3600000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); document.getElementById("annAt").value = d.toISOString().slice(0, 16); })()');
      await submit(urgent, '#announceForm');
      await noFiller(urgent, 'dialog[open]');
      assert.equal(await urgent.evaluate('document.querySelector("dialog[open] .btn-danger").textContent'), '安排广播');
      assert.doesNotMatch(await urgent.evaluate('document.querySelector("dialog[open]").innerText'), /立即抢占/);
      await urgent.key('Escape');
      await urgent.close();
    });

    await t.test('schedule form replaces persistent rules with in-context, retained errors and server validation', async () => {
      const page = await browser.page({ cookie: teacher.cookie, base: s.base });
      await page.goto(s.base + '/teacher?class=class-a');
      await page.waitFor('classId === "class-a"');
      await click(page, '#tabbtn-schedule');
      await page.waitFor('document.querySelector("#schWindows .status")');
      await noFiller(page);
      assert.match(await page.evaluate('document.getElementById("schWindows").innerText'), /08:45–09:00/);
      await setValue(page, '#schTime', '09:05');
      await submit(page, '#scheduleForm');
      assert.equal(await page.evaluate('document.getElementById("schError").textContent'), '请选择要提醒的学生');
      assert.equal(await page.evaluate('document.activeElement.id'), 'schSearch');
      await click(page, '#schGrid button');
      await submit(page, '#scheduleForm');
      await page.waitFor('document.getElementById("schError").textContent.includes("该时间不在允许点人的时段内")');
      assert.equal(await page.evaluate('document.getElementById("schTime").getAttribute("aria-invalid")'), 'true');
      assert.equal(await page.evaluate('schSel.size'), 1);
      assert.ok((await page.ax()).some(n => n.name?.value.includes('该时间不在允许点人的时段内')));
      await setValue(page, '#schTime', '09:50');
      await submit(page, '#scheduleForm');
      await page.waitFor('document.getElementById("schList").textContent.includes("09:50")');
      assert.equal(await page.evaluate('document.getElementById("schError").hidden'), true);
      await noFiller(page);
      await page.evaluate('[...document.querySelectorAll("#schList button")].find(b => b.textContent === "改时间").click()');
      await noFiller(page, 'dialog[open]');
      assert.equal(await page.evaluate('document.querySelector("dialog[open] input").required'), true);
      await setValue(page, 'dialog[open] input', '09:05');
      await submit(page, 'dialog[open] form');
      assert.match(await page.evaluate('document.querySelector("dialog[open] [role=alert]").textContent'), /请选择可点人时段/);
      await page.key('Escape');
      await page.close();
    });

    await t.test('admin panels and drawers keep labels, native constraints, backend errors and consequential confirmations', async () => {
      const page = await browser.page({ cookie: admin.cookie, base: s.base });
      await page.goto(s.base + '/admin');
      await page.waitFor('!document.getElementById("app").hidden && ovData');
      await badge(page, '#app .top [data-app-version]');
      await page.resize(390, 844);
      await badge(page, '#app .top [data-app-version]');
      await page.resize(1366, 768);
      const ready = {
        overview: 'document.querySelector("#ovDisplays .dossier")',
        requests: 'document.getElementById("requests").textContent.includes("没有待审批")',
        classes: 'document.querySelector("#classList .class-card")',
        users: 'document.querySelector("#userTable tbody strong")',
        windows: 'windowsDraft && document.querySelector("#wTable input")',
        schedules: 'document.querySelector("#schedules .item")',
        displays: 'document.querySelector("#displays .item")',
        audit: 'document.querySelector("#auditTable [data-audit-id]")',
        settings: 'document.getElementById("setPolicy").value === "next_window"',
      };
      for (const [view, loaded] of Object.entries(ready)) {
        await page.evaluate(`switchView(${JSON.stringify(view)})`);
        await page.waitFor(`!document.getElementById(${JSON.stringify('view-' + view)}).hidden && (${loaded})`);
        await noFiller(page);
      }
      await page.evaluate('switchView("classes")');
      await page.waitFor('document.querySelector("#classList .class-card")');
      await click(page, '#newClass');
      await axName(page, 'dialog', '新建班级');
      await noFiller(page, 'dialog[open]');
      await setValue(page, 'dialog[open] input[name=id]', 'bad id');
      assert.equal(await page.evaluate('document.querySelector("dialog[open] input[name=id]").validity.patternMismatch'), true);
      await setValue(page, 'dialog[open] input[name=id]', 'class-a');
      await setValue(page, 'dialog[open] input[name=name]', '合成班');
      await submit(page, 'dialog[open] form');
      await page.waitFor('document.querySelector("dialog[open] [role=alert]").textContent.includes("班级标识已存在")');
      assert.equal(await page.evaluate('document.querySelector("dialog[open] input[name=id]").getAttribute("aria-invalid")'), 'true');
      assert.equal(await page.evaluate('document.querySelector("dialog[open] input[name=name]").value'), '合成班');
      await page.key('Escape');

      await page.evaluate('editClass(classesCache.find(c => c.id === "class-a"))');
      await noFiller(page, 'dialog[open]');
      assert.equal(await page.evaluate('document.querySelector("dialog[open] input[name=autoClearSeconds]").disabled'), true);
      await setValue(page, 'dialog[open] select:not([name])', 'auto', 'change');
      await setValue(page, 'dialog[open] input[name=autoClearSeconds]', '3601');
      assert.equal(await page.evaluate('document.querySelector("dialog[open] input[name=autoClearSeconds]").validity.rangeOverflow'), true);
      await setValue(page, 'dialog[open] select:not([name])', 'manual', 'change');
      await submit(page, 'dialog[open] form');
      await page.waitFor('!document.querySelector("dialog[open]")');
      assert.equal((await admin.get('/api/admin/classes')).json.classes.find(c => c.id === 'class-a').autoClearSeconds, 0);

      await page.evaluate('switchView("users")');
      await page.waitFor('usersCache.some(u => u.username === "zhang")');
      await click(page, '#newUser');
      await noFiller(page, 'dialog[open]');
      assert.deepEqual(await page.evaluate('(() => { const f = document.querySelector("dialog[open] form"); return { min: f.elements.password.minLength, max: f.elements.password.maxLength, required: f.elements.username.required }; })()'), { min: 8, max: 128, required: true });
      await setValue(page, 'dialog[open] input[name=username]', 'x y');
      assert.equal(await page.evaluate('document.querySelector("dialog[open] input[name=username]").validity.patternMismatch'), true);
      await page.key('Escape');
      await page.evaluate(`editUser(usersCache.find(u => u.id === ${JSON.stringify(user.id)}))`);
      await noFiller(page, 'dialog[open]');
      await page.key('Escape');
      await page.evaluate(`void revokeAccess(usersCache.find(u => u.id === ${JSON.stringify(user.id)}), { classId: 'class-a', className: '甲班' })`);
      await noFiller(page, 'dialog[open]');
      assert.match(await page.evaluate('document.querySelector("dialog[open]").innerText'), /1 个定时任务将暂停/);
      await page.key('Escape');

      await page.evaluate('switchView("windows")');
      await page.waitFor('windowsDraft && document.querySelector("#wTable input")');
      await click(page, '#wSave');
      await noFiller(page, 'dialog[open]');
      assert.match(await page.evaluate('document.querySelector("dialog[open]").innerText'), /不符合新作息的定时任务将暂停/);
      await page.key('Escape');
      await page.evaluate('switchView("displays")');
      await page.waitFor('document.querySelector("#ugClass option")');
      await setValue(page, '#ugDuration', '0');
      await setValue(page, '#ugTitle', '紧急集合'); await setValue(page, '#ugBody', '请前往操场');
      await submit(page, '#urgentForm');
      await noFiller(page, 'dialog[open]');
      assert.match(await page.evaluate('document.querySelector("dialog[open]").innerText'), /手动撤回/);
      assert.doesNotMatch(await page.evaluate('document.querySelector("dialog[open]").innerText'), /手动撤回自动下屏/);
      await page.key('Escape');
      await page.close();
    });

    await t.test('display binding and launcher recovery use actionable copy, not implementation details', async () => {
      const page = await browser.page();
      await page.goto(s.base + '/display');
      await page.waitFor('document.body.classList.contains("bind-error")');
      await badge(page, '.display-brand [data-app-version]');
      await noFiller(page);
      assert.equal(await page.evaluate('document.getElementById("bindDetail").textContent'), '请向管理员获取本班大屏链接。');
      await page.goto(s.base + '/display?class=class-a');
      await page.waitFor('document.getElementById("conn").classList.contains("ok")');
      await badge(page, '.display-brand [data-app-version]');
      await page.evaluate('showLaunchWarning()');
      await noFiller(page);
      assert.match(await page.evaluate('document.getElementById("launchWarning").textContent'), /请联系管理员检查启动器后重新发送/);
      await page.close();
    });
    assert.deepEqual(browser.errors, [], 'No uncaught page errors');
  } finally { await closeBrowserAndServer(browser, s); }
});

test('uninitialized admin offers recovery without setup commands', { skip: missing, timeout: 30000 }, async () => {
  const s = await start({ classes: [], admin: null });
  let browser;
  try {
    browser = await launch(chrome);
    const page = await browser.page();
    await page.goto(s.base + '/admin');
    await page.waitFor('!document.getElementById("setupPanel").hidden');
    await badge(page, '#setupPanel [data-app-version]');
    await noFiller(page);
    assert.equal(await page.evaluate('document.querySelectorAll("#setupPanel pre, #setupPanel code").length'), 0);
    await axName(page, 'link', '重新检查');
    assert.match(await page.evaluate('document.getElementById("setupPanel").innerText'), /请联系部署负责人创建管理员账号/);
  } finally { await closeBrowserAndServer(browser, s); }
});
