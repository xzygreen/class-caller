'use strict';

const clock = require('./clock');

const { randomBytes } = require('crypto');
const {
  SESSION_TTL_MS, LOGIN_MAX_FAILURES, LOGIN_LOCK_MS, LOGIN_FAILURE_WINDOW_MS, REGISTER_MAX_PER_HOUR,
} = require('./constants');

/**
 * 登录会话与登录限速。
 *
 * 会话持久化在数据仓库的 sessions 集合里（服务重启不会把所有老师踢下线），
 * 但每次请求都重新核对：会话未过期、账号仍启用、密码未在会话签发之后被修改。
 * 密码修改、账号停用、管理员撤销会话都立即生效。
 */
class SessionStore {
  constructor({ store, ttlMs = SESSION_TTL_MS, now = clock.now }) {
    this.store = store;
    this.ttlMs = ttlMs;
    this.now = now;
    this.failures = new Map();   // `${ip}|${username}` -> { count, lastAt }
    this.registrations = new Map();  // ip -> [timestamps]
  }

  /* ---------- 限速 ---------- */

  lockedFor(ip, username) {
    const key = `${ip}|${username}`;
    const entry = this.failures.get(key);
    if (!entry) return 0;
    const now = this.now();
    if (now - entry.lastAt > LOGIN_FAILURE_WINDOW_MS) {
      this.failures.delete(key);
      return 0;
    }
    if (entry.count < LOGIN_MAX_FAILURES) return 0;
    const remain = entry.lastAt + LOGIN_LOCK_MS - now;
    return remain > 0 ? remain : 0;
  }

  recordFailure(ip, username) {
    const key = `${ip}|${username}`;
    const now = this.now();
    const entry = this.failures.get(key);
    if (!entry || now - entry.lastAt > LOGIN_FAILURE_WINDOW_MS) {
      this.failures.set(key, { count: 1, lastAt: now });
    } else {
      entry.count = entry.count >= LOGIN_MAX_FAILURES && now - entry.lastAt >= LOGIN_LOCK_MS ? 1 : entry.count + 1;
      entry.lastAt = now;
    }
    this._pruneFailures();
  }

  clearFailures(ip, username) {
    this.failures.delete(`${ip}|${username}`);
  }

  registrationAllowed(ip) {
    const now = this.now();
    const list = (this.registrations.get(ip) || []).filter((t) => now - t < 3_600_000);
    this.registrations.set(ip, list);
    return list.length < REGISTER_MAX_PER_HOUR;
  }

  recordRegistration(ip) {
    const list = this.registrations.get(ip) || [];
    list.push(this.now());
    this.registrations.set(ip, list);
    if (this.registrations.size > 10_000) this.registrations.clear();
  }

  /* ---------- 会话 ---------- */

  async issue(userId, ip) {
    const token = randomBytes(32).toString('base64url');
    const createdAt = this.now();
    const session = { token, userId, createdAt, expiresAt: createdAt + this.ttlMs, ip };
    await this.store.update((db) => {
      const now = this.now();
      db.sessions = db.sessions.filter((s) => s.expiresAt > now);
      db.sessions.push(session);
    });
    return session;
  }

  /**
   * 解析令牌 → { session, user }；无效返回 { reason }。
   * 不在这里写盘：过期会话延迟到下次签发时清理。
   */
  resolve(token) {
    if (typeof token !== 'string' || !token) return { reason: 'UNAUTHORIZED' };
    const db = this.store.get();
    const session = db.sessions.find((s) => s.token === token);
    if (!session || session.expiresAt <= this.now()) return { reason: 'UNAUTHORIZED' };
    const user = db.users.find((u) => u.id === session.userId);
    if (!user) return { reason: 'UNAUTHORIZED' };
    if (user.status !== 'active') return { reason: 'ACCOUNT_DISABLED' };
    // 密码改过之后签发的会话才有效
    if (user.passwordChangedAt && session.createdAt < user.passwordChangedAt) return { reason: 'UNAUTHORIZED' };
    return { session, user };
  }

  revoke(token) {
    return this.store.update((db) => {
      const before = db.sessions.length;
      db.sessions = db.sessions.filter((s) => s.token !== token);
      return before - db.sessions.length;
    });
  }

  /** 直接在一次 update 里调用：撤销某用户的全部会话 */
  static revokeUserInDb(db, userId) {
    const before = db.sessions.length;
    db.sessions = db.sessions.filter((s) => s.userId !== userId);
    return before - db.sessions.length;
  }

  static revokeAllInDb(db) {
    const n = db.sessions.length;
    db.sessions = [];
    return n;
  }

  count(userId) {
    const now = this.now();
    return this.store.get().sessions.filter((s) => s.expiresAt > now && (userId === undefined || s.userId === userId)).length;
  }

  _pruneFailures() {
    const now = this.now();
    for (const [key, entry] of this.failures) {
      if (now - entry.lastAt > LOGIN_FAILURE_WINDOW_MS) this.failures.delete(key);
    }
    if (this.failures.size > 10_000) {
      const oldest = [...this.failures.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
      for (const [key] of oldest.slice(0, oldest.length - 5_000)) this.failures.delete(key);
    }
  }
}

module.exports = { SessionStore };
