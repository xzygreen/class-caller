'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, req } = require('./helpers');

const publicDir = path.join(__dirname, '..', 'public');

test('短地址直接返回对应 HTML，根路径仍是教师端快捷入口；HEAD 与 GET 一致', async (t) => {
  const s = await start();
  t.after(() => s.stop());
  for (const [url, file] of [['/', 'teacher'], ['/teacher', 'teacher'], ['/admin', 'admin'], ['/display?class=class-a', 'display']]) {
    const html = fs.readFileSync(path.join(publicDir, file + '.html'), 'utf8');
    const get = await req(s.base, 'GET', url);
    assert.equal(get.status, 200, url);
    assert.equal(get.body, html);
    assert.match(get.headers['content-type'], /^text\/html/);
    assert.equal(get.headers['cache-control'], 'no-cache');
    assert.equal(get.headers.location, undefined);
    const head = await req(s.base, 'HEAD', url);
    assert.equal(head.status, 200, url);
    assert.equal(head.body, '');
    assert.equal(Number(head.headers['content-length']), Buffer.byteLength(html));
    assert.equal(head.headers['content-type'], get.headers['content-type']);
  }
});

test('旧 .html 与尾斜杠地址永久跳转，完整保留班级和原始查询编码', async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const queries = ['', '?class=class-a', '?class=class%2Da&preview=%E5%AD%A6%E7%94%9F&msg=a%20b%2Fc&x=a+b&x=%2B&empty=&flag'];
  for (const page of ['teacher', 'admin', 'display']) {
    for (const suffix of ['.html', '/']) {
      for (const query of queries) {
        for (const method of ['GET', 'HEAD']) {
          const from = '/' + page + suffix + query;
          const res = await req(s.base, method, from);
          assert.equal(res.status, 301, from);
          assert.equal(res.headers.location, '/' + page + query, from);
          assert.equal(res.body, '');
        }
      }
    }
  }
  const redirected = await req(s.base, 'GET', '/display.html?class=class-a');
  const destination = await req(s.base, 'GET', redirected.headers.location);
  assert.equal(destination.status, 200);
  assert.ok(destination.body.includes('Caller 大屏'));
});

test('未知页面、文件和 API 保持 404，不回退教师端；路径穿越仍拒绝', async (t) => {
  const s = await start();
  t.after(() => s.stop());
  for (const url of ['/typo', '/teacher/typo', '/unknown.html', '/missing.js', '/constructor', '/__proto__']) {
    const res = await req(s.base, 'GET', url);
    assert.equal(res.status, 404, url);
    assert.ok(res.body.includes('页面不存在'));
    assert.ok(res.body.includes('href="/teacher"') && res.body.includes('href="/admin"'));
    assert.ok(!res.body.includes('loginForm'));
    const head = await req(s.base, 'HEAD', url);
    assert.equal(head.status, 404);
    assert.equal(head.body, '');
  }
  const api = await req(s.base, 'GET', '/api/does-not-exist');
  assert.equal(api.status, 404);
  assert.match(api.headers['content-type'], /application\/json/);
  const traversal = await req(s.base, 'GET', '/%2e%2e%2fpackage.json');
  assert.equal(traversal.status, 404);
  assert.ok(!traversal.body.includes('"class-caller"'), '不得读到 public 之外的 package.json');
});

test('短地址不改变静态资源、健康检查和不支持方法的处理', async (t) => {
  const s = await start();
  t.after(() => s.stop());
  for (const url of ['/', '/teacher', '/admin', '/display', '/display.html', '/admin/']) {
    const res = await req(s.base, 'POST', url);
    assert.equal(res.status, 405, url);
    assert.equal(res.headers.allow, 'GET, HEAD');
    assert.equal(res.headers.location, undefined);
  }
  for (const [file, type] of [
    ['tokens.css', 'text/css'], ['teacher.js', 'text/javascript'],
    ['favicon.svg', 'image/svg+xml'], ['favicon.ico', 'image/x-icon'], ['apple-touch-icon.png', 'image/png'],
  ]) {
    const res = await req(s.base, 'GET', '/' + file + '?v=check');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].startsWith(type));
    assert.equal(res.headers['cache-control'], 'no-cache');
  }
  assert.equal((await req(s.base, 'GET', '/api/public/status')).json.ok, true);
});
