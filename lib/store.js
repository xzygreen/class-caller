'use strict';

const fs = require('fs');
const path = require('path');
const { DB_VERSION, BACKUP_KEEP } = require('./constants');
const { log } = require('./logger');

/**
 * 带版本号的 JSON 数据仓库。
 *
 *  - 串行写入：所有 update() 排队执行，永远不会并发改同一份数据；
 *  - 原子替换：先写临时文件再 rename，进程被杀也不会留下半个文件；
 *  - 自动备份：每天第一次写入前把上一份完整文件复制到 backups/，保留最近 BACKUP_KEEP 份；
 *  - 写入失败时把内存数据回滚到上一份有效数据，并抛错让调用方返回 STORE_ERROR；
 *  - 文件权限 0600，目录 0700；
 *  - 迁移按版本号逐级执行，DB_VERSION 就是当前代码认识的最高版本。
 *
 * 路由与业务逻辑只通过 get()/update() 访问数据；将来换 SQLite 只需换这一层。
 */

function emptyDb() {
  return {
    version: DB_VERSION,
    users: [],
    sessions: [],
    classes: [],
    memberships: [],
    accessRequests: [],
    callWindows: null,           // null = 使用默认作息（见 timewin.js）
    schedules: [],
    scheduleRuns: [],
    notices: [],
    auditLogs: [],
    settings: { announcementPolicy: 'immediate' },
  };
}

/** 逐版本迁移；键是「迁移到的版本号」 */
const MIGRATIONS = {
  // 1: 初始版本，无需迁移
};

function migrate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('数据文件根节点必须是对象');
  let version = Number.isInteger(raw.version) ? raw.version : 0;
  if (version > DB_VERSION) throw new Error(`数据文件版本 ${version} 高于程序支持的 ${DB_VERSION}，请升级程序`);
  let data = raw;
  while (version < DB_VERSION) {
    const next = version + 1;
    const fn = MIGRATIONS[next];
    if (fn) data = fn(data);
    data.version = next;
    version = next;
    log('store_migrated', { toVersion: next });
  }
  // 补齐缺失的集合，旧文件缺字段也能用
  const base = emptyDb();
  for (const key of Object.keys(base)) {
    if (data[key] === undefined) data[key] = base[key];
  }
  return data;
}

class JsonStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.dir = path.dirname(this.file);
    this.backupDir = path.join(this.dir, 'backups');
    this.queue = Promise.resolve();
    this.lastBackupDay = null;
    this.data = this._load();
  }

  _load() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.file)) {
      const fresh = emptyDb();
      this._writeSync(fresh);
      log('store_created', { file: this.file });
      return fresh;
    }
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const before = raw.version;
    const data = migrate(raw);
    if (before !== data.version) this._writeSync(data);
    try { fs.chmodSync(this.file, 0o600); } catch {}
    return data;
  }

  get() { return this.data; }

  /**
   * 串行修改并持久化。mutator 可以是同步或异步函数，返回值原样带回。
   * mutator 抛错或写盘失败时内存数据回滚，不会出现「内存改了、磁盘没改」。
   */
  update(mutator) {
    const run = async () => {
      const snapshot = JSON.stringify(this.data);
      try {
        const result = await mutator(this.data);
        await this._persist();
        return result;
      } catch (err) {
        this.data = JSON.parse(snapshot);
        throw err;
      }
    };
    const next = this.queue.then(run, run);
    // 不让一次失败把整条队列卡死
    this.queue = next.catch(() => {});
    return next;
  }

  async _persist() {
    this._backupIfNeeded();
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const body = JSON.stringify(this.data);
    await fs.promises.writeFile(tmp, body, { mode: 0o600 });
    try {
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      try { await fs.promises.unlink(tmp); } catch {}
      throw err;
    }
  }

  _writeSync(data) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  _backupIfNeeded() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.lastBackupDay === day || !fs.existsSync(this.file)) return;
    this.lastBackupDay = day;
    try {
      fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(this.file, path.join(this.backupDir, `db-${stamp}.json`));
      const files = fs.readdirSync(this.backupDir).filter((f) => /^db-.*\.json$/.test(f)).sort();
      for (const stale of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
        fs.unlinkSync(path.join(this.backupDir, stale));
      }
    } catch (err) {
      log('store_backup_failed', { detail: String(err && err.message || err) });
    }
  }

  /** 等待所有排队中的写入完成（关服时用） */
  flush() { return this.queue; }
}

module.exports = { JsonStore, emptyDb, migrate };
