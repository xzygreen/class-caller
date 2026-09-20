'use strict';

const path = require('path');
const { createApp } = require('./lib/app');
const { log } = require('./lib/logger');

const PORT = Number(process.env.PORT) || 3000;
// 默认只监听回环地址：公网由 Nginx 反代，Node 端口不直接暴露
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const app = createApp({
  dataFile: path.join(DATA_DIR, 'db.json'),
  publicDir: path.join(__dirname, 'public'),
  legacyConfig: process.env.LEGACY_CONFIG || path.join(__dirname, 'students.json'),
  // 首个管理员只从环境变量读一次：创建成功后即使变量还在也不再使用
  initialAdmin: process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD
    ? { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, displayName: process.env.ADMIN_NAME }
    : null,
});

app.bootstrap().then(() => {
  app.server.listen(PORT, HOST, () => {
    const db = app.store.get();
    log('server_start', {
      host: HOST, port: PORT, dataDir: DATA_DIR,
      classes: db.classes.filter((c) => c.status === 'active').map((k) => ({ id: k.id, name: k.name, students: k.students.length })),
      users: db.users.length,
      callWindow: app.windows.status().open,
    });
  });
}).catch((err) => {
  log('bootstrap_failed', { detail: String(err && err.stack || err) });
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('server_stop', { signal, exitCode, displays: app.classes.totalCount('display') });
  const force = setTimeout(() => process.exit(exitCode), 5000);
  force.unref();
  try {
    await app.close();
  } finally {
    process.exit(exitCode);
  }
}

app.server.on('error', (err) => {
  log('server_error', { detail: String(err && err.stack || err) });
  shutdown('SERVER_ERROR', 1);
});
process.on('uncaughtException', (err) => {
  log('uncaught_exception', { detail: String(err && err.stack || err) });
  shutdown('UNCAUGHT_EXCEPTION', 1);
});
process.on('unhandledRejection', (reason) => {
  log('unhandled_rejection', { detail: String(reason) });
  shutdown('UNHANDLED_REJECTION', 1);
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
