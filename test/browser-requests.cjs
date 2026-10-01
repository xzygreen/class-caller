'use strict';
// Optional real-browser regression with isolated accounts; no screenshots or production data.
// PUPPETEER_PATH=/path/to/puppeteer-core CHROME_PATH=/path/to/chrome node test/browser-requests.cjs
const assert = require('node:assert/strict');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer');
const { start, asAdmin, teacherWithAccess, CLASS_A, ADMIN, TEACHER } = require('./helpers');

(async () => {
  const s = await start({ at: Date.now(), classes: [CLASS_A] });
  let browser;
  try {
    const admin = await asAdmin(s.base);
    const { user } = await teacherWithAccess(s.base, [CLASS_A.id]);
    browser = await puppeteer.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      headless: true,
    });
    const errors = [];
    async function login(who, width) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewport({ width, height: width < 500 ? 844 : 900 });
      await page.goto(s.base + '/teacher');
      await page.waitForSelector('#loginForm:not([hidden])');
      await page.type('#loginUser', who.username);
      await page.type('#loginPwd', who.password);
      await page.click('#loginBtn');
      await page.waitForSelector('#home:not([hidden]) #myClasses .item');
      return page;
    }
    async function panel(page, hidden) {
      await page.waitForFunction((hidden) => document.getElementById('requestPanel').hidden === hidden, { timeout: 22000 }, hidden);
      assert.equal(await page.$eval('#requestPanel', (n) => n.getClientRects().length === 0), hidden);
      assert.equal(await page.$('#homeIntro'), null, '申请入口不依赖教程文案');
      assert.equal(await page.$eval('#requestForm', (form) => form.querySelector('select').required), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
    }
    for (const width of [390, 1366]) {
      const adminPage = await login(ADMIN, width);
      const teacher = await login(TEACHER, width);
      await panel(teacher, true);
      await panel(adminPage, true);
      const cid = 'class-new-' + width;
      assert.equal((await admin.post('/api/admin/classes', { id: cid, name: '新增测试班级', code: String(width) })).status, 200);
      await teacher.bringToFront();
      await panel(teacher, false);
      assert.deepEqual(await teacher.$$eval('#requestClass option', (options) => options.map((o) => o.value)), ['', cid]);
      await teacher.select('#requestClass', cid);
      await teacher.type('#requestReason', '新增班级数学教师');
      const unchanged = await teacher.evaluate(async () => {
        const option = document.querySelector('#requestClass option:last-child');
        const input = document.getElementById('requestReason');
        input.focus();
        const refreshed = new Promise((resolve) => {
          const fetchBefore = window.fetch;
          window.fetch = async (...args) => {
            const result = await fetchBefore(...args);
            if (args[0] === '/api/me/classes') {
              window.fetch = fetchBefore;
              setTimeout(resolve, 50);
            }
            return result;
          };
        });
        window.dispatchEvent(new Event('focus'));
        await refreshed;
        return option === document.querySelector('#requestClass option:last-child') && document.activeElement === input;
      });
      assert.equal(unchanged, true, 'unchanged polling must not replace focused controls');
      assert.equal(await teacher.$eval('#requestClass', (n) => n.value), cid);
      assert.equal(await teacher.$eval('#requestReason', (n) => n.value), '新增班级数学教师');
      await teacher.click('#requestBtn');
      await teacher.waitForFunction(() => document.getElementById('myRequests').textContent.includes('待审批'));
      await panel(teacher, false);
      assert.equal(await teacher.$eval('#requestClass', (n) => n.disabled), true);
      assert.equal(await teacher.$eval('#requestBtn', (n) => n.disabled), true);
      assert.ok(await teacher.$eval('#myRequests', (n) => n.textContent.includes('撤回申请')));
      const pending = (await admin.get('/api/admin/requests?status=pending')).json.requests.find((r) => r.classId === cid);
      assert.ok(pending);
      assert.equal((await admin.post(`/api/admin/requests/${pending.id}/approve`, {})).status, 200);
      await panel(teacher, true);
      assert.ok(await teacher.$eval('#myClasses', (n) => n.textContent.includes('新增测试班级')));
      await adminPage.bringToFront();
      await adminPage.waitForFunction(() => document.getElementById('myClasses').textContent.includes('新增测试班级'), { timeout: 22000 });
      await panel(adminPage, true);
      console.log(`PASS ${width}px: admin hidden; teacher all-authorized hidden; new class appears automatically; draft retained; pending cancellable; approval hides panel`);
      await teacher.browserContext().close();
      await adminPage.browserContext().close();
      assert.equal((await admin.post('/api/admin/memberships/revoke', { userId: user.id, classId: cid })).status, 200);
      assert.equal((await admin.patch('/api/admin/classes/' + cid, { status: 'archived' })).status, 200);
    }
    assert.deepEqual(errors, [], 'browser runtime errors');
    console.log('PASS request visibility browser checks (no screenshots)');
  } finally {
    if (browser) await browser.close();
    await s.stop();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
