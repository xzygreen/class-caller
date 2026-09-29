'use strict';
// Optional DOM/geometry smoke test; no screenshots and no production data.
// PUPPETEER_PATH=/path/to/puppeteer-core CHROME_PATH=/path/to/chrome node test/browser-layout.cjs
const assert = require('node:assert/strict');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer');
const { start, asAdmin, teacherWithAccess, CLASS_A, ADMIN, TEACHER } = require('./helpers');
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));

async function credit(page, label) {
  const result = await page.evaluate(async () => {
    const links = [...document.querySelectorAll('.project-credit a')].filter((a) => a.getClientRects().length);
    if (links.length !== 1) return { error: `visible credits: ${links.length}` };
    const a = links[0];
    a.scrollIntoView({ block: 'center' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const r = a.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const tray = document.getElementById('tray');
    const title = document.querySelector('.top .ident h1');
    const titleClipped = title && title.getClientRects().length && title.scrollHeight > title.clientHeight + 1;
    const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const fg = luminance(getComputedStyle(a).color), bg = luminance(getComputedStyle(document.body).backgroundColor);
    return {
      titleClipped,
      contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
      text: a.parentElement.textContent.replace(/\s+/g, ' ').trim(),
      height: r.height, hit: hit === a || a.contains(hit),
      overflow: document.documentElement.scrollWidth - innerWidth,
      position: getComputedStyle(a.parentElement).position,
      clearOfTray: !tray || tray.hidden || r.bottom <= tray.getBoundingClientRect().top + 1,
      href: a.href, target: a.target, rel: a.rel,
    };
  });
  assert.ok(!result.error, label + ': ' + result.error);
  assert.ok(result.text.includes('由 xzygreen 开发') && result.text.includes('基于 MIT License 发布'), label);
  assert.ok(result.height >= 44 && result.hit && result.clearOfTray, label + ': credit obstructed ' + JSON.stringify(result));
  assert.ok(result.overflow <= 1, label + ': horizontal overflow ' + result.overflow);
  assert.ok(!result.titleClipped, label + ': header text clipped vertically');
  assert.ok(result.contrast >= 4.5, label + ': small-text contrast ' + result.contrast);
  assert.ok(!['fixed', 'sticky'].includes(result.position), label + ': floating credit');
  assert.equal(result.href, 'https://github.com/xzygreen/class-caller');
  assert.equal(result.target, '_blank');
  assert.ok(result.rel.includes('noopener') && result.rel.includes('noreferrer'));
  console.log('PASS', label);
}

async function displayGeometry(page, label, mobile) {
  await wait(650);
  await credit(page, label);
  const errors = await page.evaluate((mobile) => {
    const errors = [];
    const rect = (id) => document.getElementById(id).getBoundingClientRect();
    const foot = rect('foot'), stage = document.querySelector('.stage').getBoundingClientRect();
    if (!mobile && document.documentElement.scrollHeight > innerHeight + 1) errors.push('viewport overflow');
    if (stage.bottom > foot.top + 1) errors.push('stage overlaps footer');
    if (document.body.classList.contains('active')) {
      const box = rect('names'), ack = rect('ackRow');
      for (const name of document.querySelectorAll('#names .name')) {
        const r = name.getBoundingClientRect();
        if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) errors.push('name outside container');
        if (r.bottom > ack.top + 1) errors.push('name overlaps ack');
      }
      if (ack.bottom > foot.top + 1) errors.push('ack overlaps footer');
      const msg = rect('message');
      if (msg.height && msg.bottom > document.querySelector('.foot-status').getBoundingClientRect().top + 1) errors.push('message overlaps credit');
    }
    if (document.body.classList.contains('notice')) {
      const title = rect('noticeTitle'), body = rect('noticeBody'), author = rect('noticeAuthor'), main = rect('noticeMain');
      if (title.top < main.top - 1 || body.bottom > main.bottom + 1) errors.push('notice clipped');
      if (body.bottom > author.top + 1) errors.push('notice overlaps author');
      const progress = rect('progress');
      if (progress.height !== 4) errors.push('progress missing');
      if (progress.bottom > document.querySelector('.foot-status').getBoundingClientRect().top + 1) errors.push('progress overlaps status');
    }
    const items = [...document.querySelectorAll('.foot-status > *')].filter((n) => n.getBoundingClientRect().height);
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i].getBoundingClientRect(), b = items[j].getBoundingClientRect();
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) errors.push('status overlap');
    }
    return errors;
  }, mobile);
  assert.deepEqual(errors, [], label);
}

(async () => {
  const students = Array.from({ length: 198 }, (_, i) => '测试学生' + (i + 1));
  students.push('欧阳同学', '买买提·艾力');
  const s = await start({ at: Date.now(), classes: [{ ...CLASS_A, students, autoClearSeconds: 0, launcher: { mode: 'off', freshSeconds: 30 } }] });
  let browser;
  try {
    const admin = await asAdmin(s.base);
    await teacherWithAccess(s.base, ['class-a']);
    const windows = await admin.put('/api/admin/call-windows', { weekdays: [0, 1, 2, 3, 4, 5, 6], windows: [{ start: '00:00', end: '23:59' }] });
    assert.equal(windows.status, 200);
    browser = await puppeteer.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--host-resolver-rules=MAP github.com ~NOTFOUND'],
    });
    const errors = [];
    const pageFor = async () => {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      return page;
    };
    const login = async (page, who) => {
      await page.waitForSelector('#gate:not([hidden])');
      await page.type('#loginUser', who.username);
      await page.type('#loginPwd', who.password);
      await page.click('#loginBtn');
      await page.waitForSelector('#app:not([hidden])');
      await wait();
    };
    for (const width of [360, 390, 1366]) {
      const page = await pageFor();
      await page.setViewport({ width, height: width < 500 ? 844 : 768 });
      await page.goto(s.base + '/admin.html#classes');
      assert.ok(page.url().endsWith('/admin#classes'));
      await page.waitForSelector('#gate:not([hidden])');
      await credit(page, 'admin login ' + width);
      await login(page, ADMIN);
      for (const view of ['overview', 'requests', 'classes', 'users', 'windows', 'schedules', 'displays', 'audit', 'settings']) {
        await page.evaluate((view) => { location.hash = view; }, view);
        await page.waitForSelector('#view-' + view + ':not([hidden])');
        await wait();
        await credit(page, 'admin ' + view + ' ' + width);
      }
      await page.evaluate(() => {
        navigator.clipboard.writeText = async (value) => { window.copied = value; };
        copyDisplayLink('class-a');
      });
      assert.equal(await page.evaluate(() => window.copied), s.base + '/display?class=class-a');
      await page.browserContext().close();
    }
    for (const width of [360, 390, 1366]) {
      const page = await pageFor();
      await page.setViewport({ width, height: width < 500 ? 844 : 768 });
      await page.goto(s.base + '/teacher');
      await page.waitForSelector('#gate:not([hidden])');
      await credit(page, 'teacher login ' + width);
      await page.click('#toRegister');
      await credit(page, 'teacher register ' + width);
      await page.evaluate(() => showPasswordGate());
      await credit(page, 'teacher password ' + width);
      await page.evaluate(() => showGate('loginForm'));
      await login(page, TEACHER);
      await page.waitForSelector('#home:not([hidden])');
      await credit(page, 'teacher home ' + width);
      await page.evaluate(() => openClass('class-a'));
      await page.waitForSelector('#grid .s');
      for (const tab of ['call', 'announce', 'schedule', 'activity']) {
        await page.evaluate((tab) => switchTab(tab), tab);
        await wait();
        await credit(page, 'teacher ' + tab + ' ' + width);
      }
      await page.evaluate(() => switchTab('call'));
      await page.click('#grid .s');
      await wait();
      await credit(page, 'teacher selected/tray ' + width);
      await page.click('#pickedBtn');
      await page.waitForSelector('#sheet:not([hidden])');
      await page.click('#sheetClose');
      await credit(page, 'teacher tray restored ' + width);
      // Actual popup navigation, with github.com blocked locally; parent remains untouched.
      const before = page.url();
      const popupPromise = new Promise((resolve) => page.once('popup', resolve));
      await page.click('#app .project-credit a');
      const popup = await popupPromise;
      assert.equal(page.url(), before);
      assert.equal(await popup.evaluate(() => window.opener), null);
      await popup.close();
      await page.browserContext().close();
    }
    const page = await pageFor();
    for (const [width, height] of [[390, 844], [1366, 768], [1920, 1080], [3840, 2160]]) {
      await page.setViewport({ width, height });
      await page.goto(s.base + '/display?preview=');
      await displayGeometry(page, 'display idle ' + width, width < 900);
      for (const count of [1, 8, 20]) {
        await page.evaluate(({ students, count }) => render({ type: 'call', id: count, names: students.slice(0, count), caller: '测试老师', message: '请带上作业本到办公室，谢谢。', createdAt: Date.now(), serverTime: Date.now(), expiresAt: null, queued: 3, acks: [] }, false), { students, count });
        await page.evaluate(() => document.getElementById('audioTip').classList.add('show'));
        await displayGeometry(page, `display ${count} names ${width}`, width < 900);
      }
      for (const priority of [0, 1]) {
        await page.evaluate((priority) => render({ type: 'announcement', id: 50 + priority, title: '明日班级活动安排', body: '请全体同学明天穿校服，带好水杯和笔记本。\n请各组组长提前清点人数，在教室集合。', author: '班主任', priority, queued: 2, createdAt: Date.now(), serverTime: Date.now(), expiresAt: Date.now() + 60000 }, false), priority);
        await displayGeometry(page, 'display notice ' + priority + ' ' + width, width < 900);
      }
      await page.goto(s.base + '/display');
      await page.waitForSelector('body.bind-error');
      await displayGeometry(page, 'display binding error ' + width, width < 900);
    }
    // No-admin setup gate is also covered without changing any actual users.
    const setup = await pageFor();
    await setup.setViewport({ width: 360, height: 640 });
    await setup.goto(s.base + '/admin');
    await setup.waitForSelector('#gate:not([hidden])');
    await setup.evaluate(() => { document.getElementById('loginForm').hidden = true; document.getElementById('setupPanel').hidden = false; });
    await credit(setup, 'admin setup 360');
    assert.deepEqual(errors, [], 'browser runtime errors');
    console.log('PASS all browser layout and navigation checks (no screenshots)');
  } finally {
    if (browser) await browser.close();
    await s.stop();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
