'use strict';

const fs = require('fs');
const path = require('path');
const { MAX_BODY_BYTES, ERR } = require('./constants');
const { log } = require('./logger');

/** 统一的 JSON 响应与请求体读取 */

function sendJson(res, code, payload) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
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
 * 超限立刻停止读取并回 413，不把超大请求继续吃进内存；
 * settled 标志保证 resolve/reject 只会发生一次。
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
        req.destroy();                       // 立即掐掉，不再读后续数据
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
<p>请检查网址。老师端在 <a href="/teacher.html">/teacher.html</a>，大屏在 <code>/display.html?class=班级编号</code>（例如 <code>?class=class-a</code>）。</p>
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
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

module.exports = { sendJson, sendOk, sendError, readJsonBody, serveStatic };
