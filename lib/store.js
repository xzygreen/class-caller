'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash, randomUUID } = require('crypto');
const { DB_VERSION, BACKUP_KEEP } = require('./constants');
const { log } = require('./logger');

/**
 * 带版本号的 JSON 数据仓库。
 *
 *  - 进程生命周期单写者锁：同一路径只允许一个活动实例，必须 close() 后才能重新打开；
 *  - 串行事务：mutator 只修改候选数据，get() 始终返回已提交数据；
 *  - 原子替换：先写临时文件再 rename，进程被杀也不会留下半个文件；
 *  - 自动备份：每天第一次写入前把上一份完整文件复制到 backups/，保留最近 BACKUP_KEEP 份；
 *  - 写盘失败丢弃候选数据；外部副作用须用 tx.afterCommit()，不能在 mutator 里直接执行；
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

const transactions = new WeakMap();
const hostId = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);

/** 供 audit 等只拿到候选 db 的组件注册同步提交后动作。事务外调用是编程错误。 */
function afterCommit(db, fn) {
  const tx = transactions.get(db);
  if (!tx) throw new Error('afterCommit must be registered inside a store.update mutator');
  tx.afterCommit(fn);
}

function storeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    if (err.code === 'ESRCH') return false;
    // EPERM / 无法确定时不能冒险夺取锁。
    return true;
  }
}

class JsonStore {
  constructor(file) {
    const resolved = path.resolve(file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    // 目录/文件软链接也必须使用同一个锁。只支持本机文件系统上的单写者。
    this.file = fs.existsSync(resolved) ? fs.realpathSync(resolved)
      : path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    this.dir = path.dirname(this.file);
    this.backupDir = path.join(this.dir, 'backups');
    this.lockDir = `${this.file}.lock`;
    this.claim = null;
    this.queue = Promise.resolve();
    this.closing = false;
    this.closePromise = null;
    this.lastBackupDay = null;
    this._acquireLock();
    try { this.data = this._load(); }
    catch (err) { this._releaseLock(); throw err; }
  }

  _acquireLock() {
    fs.mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
    this.claim = path.join(this.lockDir, `${hostId}-${process.pid}-${randomUUID()}.owner`);
    // 先公布唯一 claim，再检查其他 claim。并发申请可能都被拒绝，但绝不会都成功。
    // 锁目录始终保留；只删除唯一的自己/已死进程 claim，避免 stale unlink 删除新锁的竞态。
    try {
      fs.writeFileSync(this.claim, '', { flag: 'wx', mode: 0o600 });
      for (const name of fs.readdirSync(this.lockDir)) {
        const claim = path.join(this.lockDir, name);
        if (claim === this.claim) continue;
        const match = /^([a-f0-9]{16})-([1-9]\d*)-([a-f0-9-]{36})\.owner$/.exec(name);
        if (match && match[1] === hostId && !processAlive(Number(match[2]))) {
          try { fs.unlinkSync(claim); } catch (err) { if (err.code !== 'ENOENT') throw err; }
          continue;
        }
        throw storeError('STORE_LOCKED', `数据仓库正在使用或锁所有者无法确认：${this.file}。请先停止服务/关闭其他 JsonStore，再运行初始化；不要删除活动锁。`);
      }
    } catch (err) {
      // 即使创建 claim 后 close/write 失败也清理；极小概率的名字冲突不属于自己。
      if (err.code === 'EEXIST') this.claim = null;
      else this._releaseLock();
      throw err;
    }
  }

  _releaseLock() {
    if (!this.claim) return;
    try { fs.unlinkSync(this.claim); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    this.claim = null;
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
   * 串行修改候选数据并持久化，返回 mutator 的结果。读者看不到候选数据。
   * 同步 afterCommit 动作在提交后、下一事务前运行；失败仅记日志，不能谎称已回滚。
   * get() / 返回值是只读约定；所有修改都必须通过下一个 update。
   */
  update(mutator) {
    if (this.closing) return Promise.reject(storeError('STORE_CLOSED', '数据仓库已关闭'));
    const run = async () => {
      const candidate = JSON.parse(JSON.stringify(this.data));
      const effects = [];
      let accepting = true;
      const tx = Object.freeze({
        afterCommit(fn) {
          if (!accepting) throw new Error('Transaction is no longer accepting afterCommit effects');
          if (typeof fn !== 'function' || fn.constructor.name === 'AsyncFunction') {
            throw new TypeError('afterCommit requires a synchronous function');
          }
          effects.push(fn);
        },
      });
      transactions.set(candidate, tx);
      let result;
      try {
        result = await mutator(candidate, tx);
      } finally {
        accepting = false;
        transactions.delete(candidate);
      }
      await this._persist(candidate);
      this.data = candidate;
      const report = (err) => {
        // 日志 sink 自己出错也不应把已经提交的事务报告成失败。
        try { log('store_after_commit_failed', { committed: true, detail: String(err && err.stack || err) }); } catch {}
      };
      for (const effect of effects) {
        try {
          const value = effect();
          if (value && typeof value.then === 'function') {
            Promise.resolve(value).catch(report);
            report(new TypeError('afterCommit effects must not return a Promise'));
          }
        } catch (err) { report(err); }
      }
      return result;
    };
    const next = this.queue.then(run, run);
    // 不让一次失败把整条队列卡死
    this.queue = next.catch(() => {});
    return next;
  }

  async _persist(candidate) {
    this._backupIfNeeded();
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const body = JSON.stringify(candidate);
    try {
      await fs.promises.writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      try { await fs.promises.unlink(tmp); } catch {}
      throw err;
    }
  }

  _writeSync(data) {
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
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

  /** 等待已排队的写入；flush 不释放单写者锁。 */
  flush() { return this.queue; }

  /** 禁止新事务，等所有已接收的事务及提交后动作结束，再释放进程生命周期锁。 */
  close() {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = this.flush().then(() => this._releaseLock());
    }
    return this.closePromise;
  }
}

module.exports = { JsonStore, emptyDb, migrate, afterCommit };
