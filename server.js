'use strict';

const path = require('path');
const { createApp } = require('./lib/app');
const { log } = require('./lib/logger');

const PORT = Number(process.env.PORT) || 3000;
// 默认只监听回环地址：公网由 Nginx 反代，Node 端口不直接暴露
const HOST = process.env.HOST || '127.0.0.1';

const app = createApp({
  configFile: path.join(__dirname, 'students.json'),
  publicDir: path.join(__dirname, 'public'),
});

app.server.listen(PORT, HOST, () => {
  const c = app.config.get();
  log('server_start', {
    host: HOST,
    port: PORT,
    classes: c.classes.map((k) => ({
      id: k.id,
      name: k.name,
      code: k.code,
      students: k.students.length,
      autoClearSeconds: k.autoClearSeconds,
      launcher: k.launcher.mode,
    })),
  });
});

let shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('server_stop', {
    signal,
    exitCode,
    displays: app.classes.totalCount('display'),
    launchers: app.classes.totalCount('launcher'),
  });
  const force = setTimeout(() => process.exit(exitCode), 5000);
  force.unref();
  try {
    await app.close();
  } finally {
    process.exit(exitCode);
  }
}

// 真正未捕获的错误可能已破坏进程状态：非零退出，让 systemd 的
// Restart=on-failure 接手。正常 stop/SIGTERM 仍以 0 退出，不会被拉起。
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
