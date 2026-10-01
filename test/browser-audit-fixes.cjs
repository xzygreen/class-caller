'use strict';

// Run cleanly with: node --test test/browser-audit-fixes.cjs
// Requires Node >=22 and local Chrome (or CHROME_PATH). No Puppeteer, screenshots,
// production server, or roster files: helpers.start() owns temporary synthetic data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { findChrome, launch, closeBrowserAndServer } = require('./browser-cdp-support.cjs');
const { start, asAdmin, teacherWithAccess, CLASS_A } = require('./helpers');
const chrome = findChrome();
const missing = !chrome ? 'No local Chrome; set CHROME_PATH' : typeof WebSocket !== 'function' ? 'Node >=22 required (native WebSocket)' : false;
const allDay = { weekdays: [0,1,2,3,4,5,6], windows: [{ start: '00:00', end: '23:59' }] };

async function setValue(page, selector, value) {
  await page.evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
async function click(page, selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function assertDialogName(page, title) {
  const dialogs = (await page.ax()).filter((node) => node.role?.value === 'dialog');
  assert.ok(dialogs.some((node) => node.name?.value === title), 'AX dialog name: ' + title);
  assert.equal(await page.evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true);
}

test('F18–F22 real browser DOM, geometry and accessibility regressions', { skip: missing, timeout: 180000 }, async (t) => {
  const s = await start({ at: Date.now(), classes: [{ ...CLASS_A, autoClearSeconds: 0, launcher: { mode: 'off', freshSeconds: 30 } }] });
  let browser;
  try {
    const admin = await asAdmin(s.base);
    const { client: teacher } = await teacherWithAccess(s.base, ['class-a']);
    assert.equal((await admin.put('/api/admin/call-windows', allDay)).status, 200);
    browser = await launch(chrome);
    t.diagnostic(browser.version + '; DOM/text/geometry/AX only');

    await t.test('F18 delayed real ACK cannot resurrect clear, replacement, urgent or expired content', async () => {
      const page = await browser.page();
      await page.goto(s.base + '/display?class=class-a');
      await page.waitFor('document.getElementById("conn").classList.contains("ok")');
      await page.evaluate(`(() => {
        const original = window.fetch;
        window.fetch = async (...args) => {
          const response = await original(...args);
          if (String(args[0]).endsWith('/public/ack')) {
            window.__ackStatus = response.status;
            await new Promise(resolve => { window.__releaseAck = resolve; });
          }
          return response;
        };
      })()`);
      for (const transition of ['clear', 'call', 'urgent', 'expiry']) {
        await admin.cpost('class-a', 'display/clear', { all: true });
        const sent = await teacher.send('class-a', ['学生130', '学生131'], '原始点人');
        assert.equal(sent.status, 200);
        await page.waitFor('currentEvent && currentEvent.message === "原始点人"');
        const oldId = await page.evaluate('shownEventId');
        await page.evaluate('window.__releaseAck = null; window.__ackStatus = null;');
        await click(page, '#names .name');
        await page.waitFor('typeof window.__releaseAck === "function"');
        assert.equal(await page.evaluate('window.__ackStatus'), 200);
        if (transition === 'expiry') {
          // A controlled local deadline exercises the real expiry callback, without sleeping 30s.
          await page.evaluate('expiryLocal = Date.now(); scheduleLocalExpiry(currentEvent);');
          await page.waitFor('shownEventId === 0');
        } else {
          await admin.cpost('class-a', 'display/clear', { all: true });
          if (transition === 'call') assert.equal((await teacher.send('class-a', ['学生132'], '新的点人')).status, 200);
          if (transition === 'urgent') assert.equal((await admin.announce('class-a', { title: '新的紧急通知', body: '请到指定地点集合', urgent: true, durationSeconds: 0 })).status, 200);
          await page.waitFor('shownEventId !== ' + oldId);
          if (transition === 'call') await page.waitFor('currentEvent && currentEvent.message === "新的点人"');
          if (transition === 'urgent') await page.waitFor('document.body.classList.contains("urgent")');
        }
        const before = await page.evaluate('({id: shownEventId, classes: document.body.className, title: document.getElementById("noticeTitle").textContent, names: currentNames})');
        await page.evaluate('window.__releaseAck();');
        await page.waitFor('!ackBusy');
        // Drain response microtasks rather than just inspecting before the promise resolves.
        await page.evaluate('new Promise(resolve => setTimeout(resolve, 30))');
        const after = await page.evaluate('({id: shownEventId, classes: document.body.className, title: document.getElementById("noticeTitle").textContent, names: currentNames})');
        assert.deepEqual(after, before, transition);
        assert.equal(await page.evaluate('document.getElementById("ackNote").textContent'), '', transition);
      }
      await page.close();
    });

    await t.test('F19 weekday draft survives add/delete, saves to real API, empty/default changes are explicit', async () => {
      const page = await browser.page({ cookie: admin.cookie, base: s.base });
      await page.goto(s.base + '/admin'); await page.waitFor('!document.getElementById("app").hidden');
      await click(page, '[data-view="windows"]'); await page.waitFor('windowsDraft && document.querySelector("#wTable tbody input")');
      await page.evaluate(`document.querySelectorAll('#wDays input').forEach(input => {
        input.checked = [2,3,4,5,6].includes(Number(input.value));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });`);
      await click(page, '#wAdd');
      await page.evaluate('document.querySelector("#wTable tbody button").click()');
      assert.deepEqual(await page.evaluate('windowsDraft.weekdays'), [2,3,4,5,6]);
      assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#wDays input:checked")].map(x => +x.value)'), [2,3,4,5,6]);
      await click(page, '#wSave'); await assertDialogName(page, '保存全校作息？');
      await click(page, 'dialog[open] .btn-primary');
      await page.waitFor('!document.getElementById("wSave").disabled && document.getElementById("toast").textContent.includes("作息已保存")');
      const saved = await admin.get('/api/admin/call-windows');
      assert.deepEqual(saved.json.callWindows.weekdays, [2,3,4,5,6]);
      assert.equal(saved.json.callWindows.windows.length, 1);
      assert.equal(saved.json.callWindows.windows[0].start, '12:00');
      await page.evaluate("document.querySelectorAll('#wDays input').forEach(i => { i.checked = false; i.dispatchEvent(new Event('change', { bubbles: true })); });");
      await click(page, '#wAdd');
      assert.deepEqual(await page.evaluate('windowsDraft.weekdays'), []);
      assert.equal(await page.evaluate('document.querySelectorAll("#wDays input:checked").length'), 0);
      await click(page, '#wDefault');
      assert.deepEqual(await page.evaluate('windowsDraft.weekdays'), [1,2,3,4,5]);
      await page.close();
      await admin.put('/api/admin/call-windows', allDay);
    });

    await t.test('F20 accepted full-range announcements remain readable at three viewport sizes', async () => {
      const page = await browser.page();
      await page.goto(s.base + '/display?class=class-a');
      await page.waitFor('document.getElementById("conn").classList.contains("ok")');
      const bodies = ['短正文', '请全体同学注意明日活动安排。'.repeat(20), '文'.repeat(300), ('行\n').repeat(149) + '末', 'W'.repeat(300)];
      const titles = ['题', '标题'.repeat(15)];
      let cases = 0, scrollCases = 0;
      for (const [width, height] of [[1366,768], [1920,1080], [390,844]]) {
        await page.resize(width, height);
        for (const urgent of [false, true]) for (const title of titles) for (const body of bodies) {
          await admin.cpost('class-a', 'display/clear', { all: true });
          const response = await admin.announce('class-a', { title, body, urgent, durationSeconds: 0 });
          assert.equal(response.status, 200, JSON.stringify(response.json));
          const noticeId = response.json.notice.id;
          await page.waitFor('document.body.classList.contains("notice") && shownEventId === ' + response.json.display.current.id);
          await page.evaluate('Promise.allSettled(document.getElementById("notice").getAnimations({ subtree: true }).map(a => a.finished))');
          const geometry = await page.evaluate(`(() => {
            layoutAnnouncement();
            const main = document.getElementById('noticeMain'), body = document.getElementById('noticeBody');
            const r = main.getBoundingClientRect(), foot = document.getElementById('foot').getBoundingClientRect();
            return { title: document.getElementById('noticeTitle').textContent, body: body.textContent,
              overflow: main.scrollHeight > main.clientHeight + 1, overflowX: main.scrollWidth > main.clientWidth + 1,
              hint: !document.getElementById('noticeReadHint').hidden, tabIndex: main.tabIndex,
              description: main.getAttribute('aria-describedby'), font: parseFloat(getComputedStyle(body).fontSize),
              top: r.top, bottom: r.bottom, footer: foot.top, height: r.height,
              documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, urgent: document.body.classList.contains('urgent') };
          })()`);
          assert.equal(geometry.title, title, noticeId); assert.equal(geometry.body, body, noticeId);
          assert.equal(geometry.urgent, urgent);
          assert.ok(geometry.font >= 22 && geometry.height > 0, JSON.stringify(geometry));
          assert.equal(geometry.overflowX, false, JSON.stringify(geometry));
          assert.ok(geometry.documentWidth <= geometry.viewportWidth + 1, JSON.stringify(geometry));
          if (width > 900) assert.ok(geometry.bottom <= geometry.footer + 1 && geometry.bottom <= height, JSON.stringify(geometry));
          if (geometry.overflow) {
            scrollCases++;
            assert.equal(geometry.hint, true); assert.equal(geometry.tabIndex, 0);
            assert.equal(geometry.description, 'noticeReadHint');
            await page.evaluate('document.getElementById("noticeMain").scrollTop = 0; document.getElementById("btnFull").focus();');
            await page.key('Tab');
            assert.equal(await page.evaluate('document.activeElement.id'), 'noticeMain');
            await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            await page.key('PageDown');
            try { await page.waitFor('document.getElementById("noticeMain").scrollTop > 0'); }
            catch (error) {
              const state = await page.evaluate('({active: document.activeElement.id, focus: document.hasFocus(), top: document.getElementById("noticeMain").scrollTop, height: document.getElementById("noticeMain").scrollHeight, client: document.getElementById("noticeMain").clientHeight, font: getComputedStyle(document.getElementById("noticeBody")).fontSize})');
              throw new Error(error.message + ' ' + JSON.stringify({ width, height, urgent, length: body.length, geometry, state }));
            }
            const bottomReachable = await page.evaluate(`(() => { const main = document.getElementById('noticeMain'); main.scrollTop = main.scrollHeight; return document.getElementById('noticeBody').getBoundingClientRect().bottom <= main.getBoundingClientRect().bottom + 1; })()`);
            assert.equal(bottomReachable, true, noticeId);
          } else {
            assert.equal(geometry.hint, false);
            assert.equal(await page.evaluate('document.getElementById("noticeBody").getBoundingClientRect().bottom <= document.getElementById("noticeMain").getBoundingClientRect().bottom + 1'), true);
          }
          cases++;
        }
      }
      // Empty titles are not accepted by the public input contract; display still
      // handles a title-less protocol event without hiding its body.
      assert.equal((await admin.announce('class-a', { title: '', body: '正文', durationSeconds: 0 })).status, 400);
      await page.evaluate("render({ type: 'announcement', classId: 'class-a', id: 1, title: '', body: '无标题正文', priority: 4 }, false)");
      assert.equal(await page.evaluate('document.getElementById("noticeBody").textContent'), '无标题正文');
      assert.equal(await page.evaluate('getComputedStyle(document.getElementById("noticeTitle")).display'), 'none');
      assert.ok(scrollCases > 0);
      t.diagnostic(cases + ' real API announcement/viewport combinations; ' + scrollCases + ' accessible scrolling fallbacks');
      await page.close();
    });

    await t.test('F21 shared dialogs have AX names, validation errors remain inside, Tab/Escape restore focus', async () => {
      const page = await browser.page({ cookie: admin.cookie, base: s.base });
      await page.goto(s.base + '/admin'); await page.waitFor('!document.getElementById("app").hidden');
      await click(page, '[data-view="classes"]'); await page.waitFor('document.querySelector("#classList .class-card")');
      for (const [title, open] of [
        ['确认测试', "void confirmDialog({title:'确认测试', danger:true, impact:['测试影响']})"],
        ['选择测试', "void choiceDialog({title:'选择测试', choices:[{value:'one', label:'选择一'}]})"],
        ['输入测试', "void promptDialog({title:'输入测试', label:'输入值', validate: () => '输入不合要求'})"],
      ]) {
        await page.evaluate('document.getElementById("newClass").focus(); ' + open);
        await assertDialogName(page, title);
        if (title === '输入测试') {
          await page.evaluate('document.querySelector("dialog[open] form").requestSubmit()');
          await page.waitFor('document.querySelector("dialog[open] [role=alert]").textContent === "输入不合要求"');
          assert.ok((await page.ax()).some((node) => node.name?.value === '输入不合要求'));
          assert.equal(await page.evaluate('document.querySelector("dialog[open] input").getAttribute("aria-invalid")'), 'true');
        }
        await page.key('Tab');
        // Native dialogs may allow focus into browser chrome (activeElement=body)
        // at the tab boundary, but never into an inert background control.
        if (await page.evaluate('document.activeElement === document.body')) await page.key('Tab');
        assert.equal(await page.evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true);
        await page.key('Escape'); await page.waitFor('!document.querySelector("dialog[open]")');
        assert.equal(await page.evaluate('document.activeElement.id'), 'newClass');
      }
      await click(page, '#newClass'); await assertDialogName(page, '新建班级');
      await setValue(page, 'dialog[open] input[name=id]', 'class-a');
      await setValue(page, 'dialog[open] input[name=name]', '合成新班');
      await page.evaluate('document.querySelector("dialog[open] form").requestSubmit()');
      await page.waitFor('document.querySelector("dialog[open] [role=alert]").textContent.includes("班级标识已存在")');
      assert.ok((await page.ax()).some((node) => node.name?.value.includes('班级标识已存在')));
      assert.equal(await page.evaluate('document.querySelector("dialog[open] input[name=id]").getAttribute("aria-invalid")'), 'true');
      assert.equal(await page.evaluate('document.querySelector("dialog[open] input[name=name]").value'), '合成新班');
      assert.equal(await page.evaluate('document.activeElement.getAttribute("role")'), 'alert');
      await setValue(page, 'dialog[open] input[name=id]', 'synthetic-new-class');
      await page.evaluate('document.querySelector("dialog[open] form").requestSubmit()');
      await page.waitFor('!document.querySelector("dialog[open]")');
      assert.ok((await admin.get('/api/admin/classes')).json.classes.some((c) => c.id === 'synthetic-new-class'));
      // A server-side failure with no field mapping still has a focusable in-dialog
      // alert and keeps the submitted inputs. Failure source here is deliberately controlled.
      await page.evaluate(`(() => { const body = document.createElement('input'); body.value = '保留输入';
        openDrawer({ title: '失败测试', body, onSubmit: async () => { throw new Error('simulated connection failure'); } }); })()`);
      await assertDialogName(page, '失败测试');
      await page.evaluate('document.querySelector("dialog[open] form").requestSubmit()');
      await page.waitFor('document.querySelector("dialog[open] [role=alert]").textContent.includes("保存失败")');
      assert.ok((await page.ax()).some((node) => node.name?.value.includes('保存失败')));
      assert.equal(await page.evaluate('document.querySelector("dialog[open] input").value'), '保留输入');
      await page.key('Escape'); await page.close();

      const teacherPage = await browser.page({ cookie: teacher.cookie, base: s.base });
      await teacherPage.goto(s.base + '/teacher'); await teacherPage.waitFor('!document.getElementById("app").hidden');
      await teacherPage.evaluate('document.getElementById("changePwd").click()');
      await assertDialogName(teacherPage, '修改密码');
      await setValue(teacherPage, '#curPwd', 'wrong-password'); await setValue(teacherPage, '#nxtPwd', 'synthetic-new-password');
      await teacherPage.evaluate('document.getElementById("pwdChangeForm").requestSubmit()');
      await teacherPage.waitFor('!document.getElementById("pwdChangeErr").hidden');
      const error = await teacherPage.evaluate('document.getElementById("pwdChangeErr").textContent');
      assert.ok(error.length > 0); assert.ok((await teacherPage.ax()).some((node) => node.name?.value === error));
      assert.equal(await teacherPage.evaluate('document.getElementById("nxtPwd").value'), 'synthetic-new-password');
      await teacherPage.key('Escape'); await teacherPage.close();
    });

    await t.test('F22 real same-class response preserves newer edits; preview exposes warning and full content', async () => {
      await admin.cpost('class-a', 'display/clear', { all: true });
      const page = await browser.page({ cookie: teacher.cookie, base: s.base, width: 390, height: 844 });
      await page.goto(s.base + '/teacher?class=class-a');
      await page.waitFor('classId === "class-a" && document.querySelector("#grid button")');
      await page.evaluate(`(() => { const original = window.fetch; window.fetch = async (...args) => {
        const response = await original(...args);
        if (String(args[0]).endsWith('/calls')) await new Promise(resolve => { window.__releaseCall = resolve; });
        return response;
      }; })()`);
      await click(page, '#grid button[data-name="学生130"]'); await setValue(page, '#msg', 'first');
      await click(page, '#send'); await page.waitFor('typeof window.__releaseCall === "function"');
      await click(page, '#grid button[data-name="学生131"]');
      await click(page, '#grid button[data-name="学生130"]');
      await setValue(page, '#msg', 'next draft'); await setValue(page, '#search', '学生131');
      await page.evaluate('window.__releaseCall()'); await page.waitFor('!sending');
      assert.deepEqual(await page.evaluate('[...sel]'), ['学生131']);
      assert.equal(await page.evaluate('document.getElementById("msg").value'), 'next draft');
      assert.equal(await page.evaluate('document.getElementById("search").value'), '学生131');
      assert.deepEqual(await page.evaluate('lastSent.names'), ['学生130']);
      assert.equal(await page.evaluate('lastSent.message'), 'first');
      assert.ok(await page.evaluate('document.getElementById("toast").textContent.includes("草稿已保留")'));
      await click(page, '#tabbtn-announce');
      const body = '完整正文\n'.repeat(50);
      await setValue(page, '#annTitle', '完整预览'); await setValue(page, '#annBody', body);
      await click(page, '.preview-full summary');
      assert.equal(await page.evaluate('document.getElementById("pvFullBody").textContent'), body.trim());
      assert.ok(await page.evaluate('document.getElementById("pvWarning").textContent.includes("滚动阅读")'));
      assert.ok((await page.ax()).some((node) => node.name?.value.includes('完整正文')));
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true);
      await page.close();
    });
    assert.deepEqual(browser.errors, [], 'No uncaught page exceptions');
  } finally {
    await closeBrowserAndServer(browser, s);
  }
});
