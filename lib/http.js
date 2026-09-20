'use strict';

const fs = require('fs');
const path = require('path');
const { MAX_BODY_BYTES, ERR, SESSION_COOKIE } = require('./constants');

/** 统一的 JSON 响应、请求体读取、Cookie 与来源检查 */

function sendJson(res, code, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendOk(res, fields = {}) {
  sendJson(res, 200, { ok: true, ...fields });
}

/** 所有错误响应长同一个样：{ ok:false, error:CODE, message:中文 } */
function sendError(res, code, errorCode, extra = {}) {
  sendJson(res, code, {
    ok: false,
    error: errorCode,
    message: ERR[errorCode] || ERR.INTERNAL,
    ...extra,
  });
}

/**
 * 读取并解析 JSON 请求体。
 * 超限立刻停止读取并回 413，不把超大请求继续吃进内存。
 */
function readJsonBody(req, res, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const chunks = [];

    const finish = (value) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onError);
      resolve(value);
    };

    function onData(chunk) {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        sendError(res, 413, 'BODY_TOO_LARGE');
        req.destroy();
        finish({ ok: false, handled: true });
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return finish({ ok: true, value: {} });
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return finish({ ok: false, code: 'INVALID_JSON' });
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return finish({ ok: false, code: 'INVALID_JSON' });
      }
      finish({ ok: true, value: parsed });
    }

    function onError() { finish({ ok: false, handled: true }); }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onError);
  });
}

/* ---------- Cookie ---------- */

function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function sessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
}

/** 请求是否经 HTTPS 到达（直连或经 Nginx 反代） */
function isSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

function sessionCookie(req, token, expiresAt) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (expiresAt) attrs.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  else attrs.push('Max-Age=0');
  if (isSecure(req) || process.env.COOKIE_SECURE === '1') attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * 修改类请求的来源检查：浏览器跨站发起的 POST 一定带 Origin，
 * 与 Host 不一致就拒绝。没有 Origin 头的（curl、脚本）不受此限制——
 * 它们本来就拿不到 HttpOnly Cookie。
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin || origin === 'null') return origin !== 'null';
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const forwarded = req.headers['x-forwarded-host'];
  const expected = typeof forwarded === 'string' && forwarded ? forwarded.split(',')[0].trim() : req.headers.host;
  return typeof expected === 'string' && host.toLowerCase() === expected.toLowerCase();
}

/* ---------- 静态文件 ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const NOT_FOUND_PAGE = `<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8">
<title>页面不存在</title>
<body style="font:16px/1.6 system-ui,'PingFang SC',sans-serif;padding:15vh 24px;text-align:center;color:#3A4356">
<h1 style="font-size:28px;color:#0E1420;margin:0 0 8px">页面不存在</h1>
<p>请检查网址。教师端在 <a href="/teacher.html">/teacher.html</a>，管理端在 <a href="/admin.html">/admin.html</a>，大屏在 <code>/display.html?class=班级标识</code>。</p>
</body></html>`;

function serveStatic(req, res, urlPath, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method Not Allowed');
  }

  const rel = urlPath === '/' ? '/teacher.html' : urlPath;
  const decoded = (() => { try { return decodeURIComponent(rel); } catch { return rel; } })();
  const file = path.join(publicDir, path.normalize(decoded));
  if (!file.startsWith(publicDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? '' : NOT_FOUND_PAGE);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

module.exports = {
  sendJson, sendOk, sendError, readJsonBody, serveStatic,
  parseCookies, sessionToken, sessionCookie, isSecure, originAllowed,
};
