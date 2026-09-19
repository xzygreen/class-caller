'use strict';

const http = require('http');
const path = require('path');
const {
  HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, KEEPALIVE_TIMEOUT_MS,
} = require('./constants');
const { ConfigStore } = require('./config');
const { SessionStore } = require('./auth');
const { ClassRegistry } = require('./classes');
const { createRouter } = require('./routes');
const { sendError } = require('./http');
const { log } = require('./logger');

const STREAM_PATH_RE = /^\/api\/classes\/[a-z0-9-]+\/public\/stream(?:\?|$)/;

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 只在请求确实来自本机反代时才相信 X-Real-IP，直连时不给伪造来源的机会 */
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  if (isLoopback(remote)) {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return real.trim().slice(0, 64);
  }
  return remote;
}

/**
 * 组装一个可运行的实例。测试直接调它，拿到 server 后监听随机端口。
 */
function createApp({ configFile, publicDir }) {
  const config = new ConfigStore(configFile);
  const sessions = new SessionStore();
  const classes = new ClassRegistry({ config, sessions });

  const router = createRouter({
    config, classes, sessions,
    publicDir: path.resolve(publicDir),
  });

  const server = http.createServer((req, res) => {
    let requestUrl;
    try {
      requestUrl = new URL(req.url, 'http://localhost');
    } catch {
      return sendError(res, 400, 'NOT_FOUND');
    }

    const pathname = requestUrl.pathname;
    const ctx = {
      pathname,
      searchParams: requestUrl.searchParams,
      ip: clientIp(req),
    };

    // 任何处理器抛错都只毁掉这一个请求，不牵连整个进程
    Promise.resolve(router(req, res, ctx)).catch((err) => {
      log('api_error', { path: pathname, error: 'INTERNAL', detail: String(err && err.message || err) });
      if (!res.headersSent) sendError(res, 500, 'INTERNAL');
      else res.destroy();
    });
  });

  // 慢连接 / 挂死连接的兜底
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;

  // SSE 是长连接，不能被 requestTimeout 掐掉
  server.on('request', (req, res) => {
    if (req.url && STREAM_PATH_RE.test(req.url)) {
      req.setTimeout(0);
      res.setTimeout(0);
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
    socket.destroy();
  });

  async function close() {
    classes.dispose();
    // keep-alive 的空闲连接会让 server.close() 一直等下去
    if (server.closeIdleConnections) server.closeIdleConnections();
    const done = new Promise((resolve) => server.close(resolve));
    const force = setTimeout(() => {
      if (server.closeAllConnections) server.closeAllConnections();
    }, 1000);
    force.unref();
    await done;
    clearTimeout(force);
  }

  return { server, config, classes, sessions, close };
}

module.exports = { createApp };
