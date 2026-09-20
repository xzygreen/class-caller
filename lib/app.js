'use strict';

const clock = require('./clock');

const http = require('http');
const path = require('path');
const fs = require('fs');
const {
  HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, KEEPALIVE_TIMEOUT_MS,
} = require('./constants');
const { JsonStore } = require('./store');
const { SessionStore } = require('./auth');
const { ClassRegistry } = require('./classes');
const { CallWindows } = require('./timewin');
const { NoticeService } = require('./notices');
const { Scheduler } = require('./scheduler');
const { UserService } = require('./users');
const { createRouter } = require('./routes');
const { sendError } = require('./http');
const { importLegacyConfig } = require('./config');
const { hashPassword } = require('./passwords');
const { audit } = require('./audit');
const { validateRegistration } = require('./validate');
const { log } = require('./logger');

const STREAM_PATH_RE = /^\/api\/classes\/[a-z0-9-]+\/(?:public\/)?stream(?:\?|$)/;

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 只在请求确实来自本机反代时才相信 X-Real-IP */
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  if (isLoopback(remote)) {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return real.trim().slice(0, 64);
  }
  return remote;
}

/**
 * 组装一个可运行的实例。
 *   dataFile      —— JSON 数据仓库路径
 *   legacyConfig  —— 旧版 students.json；数据仓库里还没有班级时导入一次（忽略密码）
 *   initialAdmin  —— { username, password, displayName }；没有任何管理员时创建首个管理员
 *   scheduler     —— false 则不启动调度器（测试里手动 tick）
 */
function createApp({ dataFile, publicDir, legacyConfig, initialAdmin, scheduler: startScheduler = true, now }) {
  const store = new JsonStore(dataFile);
  const windows = new CallWindows(store.get().callWindows);
  const sessions = new SessionStore({ store, now });
  const classes = new ClassRegistry({ store });
  const notices = new NoticeService({ store, classes, windows });
  const scheduler = new Scheduler({ store, classes, windows, notices, now });
  const users = new UserService({ store, scheduler });

  const router = createRouter({
    store, classes, sessions, users, notices, scheduler, windows,
    publicDir: path.resolve(publicDir),
  });

  const server = http.createServer((req, res) => {
    let requestUrl;
    try {
      requestUrl = new URL(req.url, 'http://localhost');
    } catch {
      return sendError(res, 400, 'NOT_FOUND');
    }
    const ctx = { pathname: requestUrl.pathname, searchParams: requestUrl.searchParams, ip: clientIp(req) };
    Promise.resolve(router(req, res, ctx)).catch((err) => {
      log('api_error', { path: ctx.pathname, error: 'INTERNAL', detail: String(err && err.stack || err) });
      if (!res.headersSent) sendError(res, 500, 'INTERNAL');
      else res.destroy();
    });
  });

  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;

  server.on('request', (req, res) => {
    if (req.url && STREAM_PATH_RE.test(req.url)) {
      req.setTimeout(0);
      res.setTimeout(0);
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  /** 首次启动的初始化：导入旧名单、创建首个管理员 */
  async function bootstrap() {
    if (legacyConfig && store.get().classes.length === 0 && fs.existsSync(legacyConfig)) {
      const imported = importLegacyConfig(legacyConfig);
      const now = clock.now();
      await store.update((db) => {
        for (const c of imported) db.classes.push({ ...c, createdAt: now, updatedAt: now });
        audit(db, { actor: null, action: 'class.import_legacy', detail: { count: imported.length, file: path.basename(legacyConfig) } });
      });
      classes.sync();
      log('legacy_config_imported', { classes: imported.map((c) => ({ id: c.id, students: c.students.length })) });
    }
    if (initialAdmin && !users.hasAdmin()) {
      const check = validateRegistration({ username: initialAdmin.username, displayName: initialAdmin.displayName || '管理员', password: initialAdmin.password });
      if (!check.ok) throw new Error(`初始管理员信息无效：${check.code}`);
      if (users.byUsername(check.value.username)) throw new Error(`初始管理员登录名已被占用：${check.value.username}`);
      const passwordHash = await hashPassword(check.value.password);
      const now = clock.now();
      await store.update((db) => {
        db.users.push({
          id: require('crypto').randomUUID(), username: check.value.username, displayName: check.value.displayName, role: 'admin', title: '',
          passwordHash, status: 'active', mustChangePassword: false, createdAt: now, updatedAt: now, passwordChangedAt: now, lastLoginAt: null,
        });
        audit(db, { actor: null, action: 'user.bootstrap_admin', detail: { username: check.value.username } });
      });
      log('admin_bootstrapped', { username: check.value.username });
    }
    if (!users.hasAdmin()) log('admin_missing', { hint: '设置 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量或运行 npm run init-admin 创建首个管理员' });
    if (startScheduler) scheduler.start();
  }

  async function close() {
    scheduler.stop();
    classes.dispose();
    if (server.closeIdleConnections) server.closeIdleConnections();
    const done = new Promise((resolve) => server.close(resolve));
    const force = setTimeout(() => { if (server.closeAllConnections) server.closeAllConnections(); }, 1000);
    force.unref();
    await done;
    clearTimeout(force);
    await store.flush();
  }

  return { server, store, classes, sessions, users, notices, scheduler, windows, bootstrap, close };
}

module.exports = { createApp };
