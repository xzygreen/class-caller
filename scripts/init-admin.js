#!/usr/bin/env node
'use strict';

/**
 * 创建首个管理员（或在没有可用管理员时补一个）。
 *
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD='强密码' npm run init-admin
 *   或交互式：npm run init-admin
 *
 * 密码只读取一次，不写入任何文件或日志。必须先停止服务；活动单写者锁会拒绝本工具。
 */
const path = require('path');
const readline = require('readline');
const { createApp } = require('../lib/app');
const { setSink } = require('../lib/logger');

setSink(() => {});

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const onData = (ch) => { const s = String(ch); if (s === '\n' || s === '\r' || s === '') process.stdin.removeListener('data', onData); else readline.clearLine(process.stdout, 0); };
      rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
      rl._writeToOutput = () => {};
    } else {
      rl.question(question, (a) => { rl.close(); resolve(a); });
    }
  });
}

(async () => {
  // 先取得生命周期锁再询问密码，避免输入后才发现服务仍在写入。
  const initialAdmin = {};
  const app = createApp({
    dataFile: path.join(DATA_DIR, 'db.json'),
    publicDir: path.join(__dirname, '..', 'public'),
    legacyConfig: process.env.LEGACY_CONFIG || path.join(__dirname, '..', 'students.json'),
    initialAdmin,
    scheduler: false,
  });
  let created = false;
  try {
    if (app.users.hasAdmin()) {
      console.error('已经存在启用的管理员；后续管理员请由现有管理员在管理端创建。');
      process.exitCode = 2;
      return;
    }
    initialAdmin.username = process.env.ADMIN_USERNAME || await ask('管理员登录名：');
    initialAdmin.displayName = process.env.ADMIN_NAME || await ask('显示姓名（默认「管理员」）：') || '管理员';
    initialAdmin.password = process.env.ADMIN_PASSWORD || await ask('密码（至少 8 位）：', { hidden: true });
    await app.bootstrap();
    created = true;
  } finally {
    await app.close();
  }
  if (created) console.log(`已创建管理员 ${initialAdmin.username.toLowerCase()}，数据文件：${path.join(DATA_DIR, 'db.json')}`);
})().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
