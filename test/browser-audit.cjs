'use strict';
// PUPPETEER_PATH=/path/to/puppeteer-core CHROME_PATH=/path/to/chrome node test/browser-audit.cjs
// Synthetic audit responses only; no screenshots or production credentials/data.
const assert = require('node:assert/strict');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer');
const { start, asAdmin } = require('./helpers');
const pause = (ms = 100) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const s = await start({ at: Date.now() });
  let browser;
  try {
    const admin = await asAdmin(s.base);
    browser = await puppeteer.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const [name, value] = admin.cookie.split('=');
    await page.setCookie({ name, value, url: s.base });
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: 'audit-' + i, at: Date.now() - i * 1000, action: 'notice.call',
      actorName: '测试管理员长姓名', actorRole: 'admin', classId: 'class-a',
      ip: '2001:db8:85a3:8d3:1319:8a2e:370:7348',
      detail: { names: Array.from({ length: 20 }, (_, n) => '长姓名测试同学' + n) },
    }));
    const users = rows.slice(0, 7).map((a, i) => ({ ...a, id: 'user-' + i, action: 'user.update', detail: {} }));
    let mode = 'normal', count = 300, delayed;
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (!r.url().includes('/api/admin/audit?')) return r.continue();
      const action = new URL(r.url()).searchParams.get('action');
      const audit = action === 'user.' ? users : action === 'class.' ? [] : rows.slice(0, count);
      if (mode === 'invalid') return r.respond({ status: 200, contentType: 'text/html', body: '<html>gateway page</html>' });
      if (mode === 'error') return r.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'INTERNAL_ERROR', message: '测试加载失败' }) });
      const respond = () => r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, audit }) });
      if (mode === 'race' && action === 'notice.') delayed = pause(400).then(respond);
      else respond();
    });
    const ids = () => page.$$eval('#auditTable tbody tr[data-audit-id]', (nodes) => nodes.map((n) => n.dataset.auditId));
    const load = () => page.evaluate(() => loadAudit());
    for (const width of [360, 390, 768, 1366]) {
      mode = 'normal'; count = 300;
      await page.setViewport({ width, height: 844 });
      await page.goto('about:blank');
      await page.goto(s.base + '/admin#audit');
      await page.waitForSelector('#auditTable tbody tr[data-audit-id]');
      assert.equal((await ids()).length, 20);
      const seen = [];
      for (let p = 0; p < 15; p++) {
        const current = await ids();
        assert.deepEqual(current, rows.slice(p * 20, p * 20 + 20).map((a) => a.id));
        seen.push(...current);
        const geometry = await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          const last = document.querySelector('#auditTable tbody tr:last-child').getBoundingClientRect();
          const footer = document.querySelector('#app > .project-credit a').getBoundingClientRect();
          const table = document.getElementById('auditTable');
          return { overflow: document.documentElement.scrollWidth - innerWidth, tableOverflow: table.scrollWidth - table.clientWidth, lastBottom: last.bottom, footerBottom: footer.bottom, height: innerHeight, pageHeight: document.documentElement.scrollHeight };
        });
        assert.ok(geometry.overflow <= 1 && geometry.tableOverflow <= 1, JSON.stringify(geometry));
        assert.ok(geometry.lastBottom <= geometry.height && geometry.footerBottom <= geometry.height, 'last record and footer reachable');
        assert.ok(geometry.pageHeight < 12000, 'page must not become a 100,000px list');
        if (p < 14) {
          // Alternate top/bottom controls: either one must change exactly one page.
          await page.evaluate((bottom) => document.querySelectorAll('[data-audit-step="1"]')[bottom ? 1 : 0].click(), p % 2 === 0);
          const titleVisible = await page.$eval('#audTitle', (n) => n.getBoundingClientRect().top >= document.querySelector('.top').getBoundingClientRect().bottom);
          assert.ok(titleVisible, 'paging returns to heading below the sticky header');
        }
      }
      assert.equal(new Set(seen).size, 300, 'all records reachable without duplicates or omissions');
      assert.ok(await page.$$eval('[data-audit-step="1"]', (nodes) => nodes.every((n) => n.disabled)));
      await page.select('#auditFilter', 'user.');
      await page.waitForFunction(() => document.querySelector('[data-audit-page]').textContent.includes('共 7 条'));
      assert.deepEqual(await ids(), users.map((a) => a.id));
      await page.select('#auditFilter', 'class.');
      await page.waitForFunction(() => document.querySelector('[data-audit-page]').textContent === '共 0 条');
      assert.ok(await page.$$eval('[data-audit-step]', (nodes) => nodes.every((n) => n.disabled)));
      await page.select('#auditFilter', '');
      await page.waitForFunction(() => document.querySelector('[data-audit-page]').textContent.includes('共 300 条'));
      for (const n of [0, 1, 20, 21]) {
        count = n; await load();
        assert.equal((await ids()).length, Math.min(n, 20));
        if (n === 21) {
          await page.evaluate(() => document.querySelector('[data-audit-step="1"]').click());
          assert.deepEqual(await ids(), ['audit-20']);
          count = 1; await load();
          assert.deepEqual(await ids(), ['audit-0'], 'refresh resets the page safely');
        }
      }
      console.log('PASS audit 300 long records, all 15 pages, filters/boundaries/scrolling at', width);
    }
    mode = 'invalid'; await load();
    assert.ok(await page.$eval('#auditTable', (n) => n.textContent.includes('非应用响应')));
    mode = 'error'; await load();
    assert.ok(await page.$eval('#auditTable', (n) => n.textContent.includes('测试加载失败')));
    assert.ok(await page.$$eval('[data-audit-step]', (nodes) => nodes.every((n) => n.disabled)));
    mode = 'normal'; count = 300;
    await page.click('#auditTable .error-state button');
    await page.waitForSelector('#auditTable tbody tr[data-audit-id]');
    mode = 'race';
    await page.select('#auditFilter', 'notice.');
    await pause(50);
    await page.select('#auditFilter', 'user.');
    await page.waitForFunction(() => document.querySelector('[data-audit-page]').textContent.includes('共 7 条'));
    await delayed;
    await pause();
    assert.deepEqual(await ids(), users.map((a) => a.id), 'slow previous filter cannot replace current results');
    assert.deepEqual(errors, []);
    console.log('PASS audit failure/retry and out-of-order filter responses; no screenshots');
  } finally {
    if (browser) await browser.close();
    await s.stop();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
