'use strict';

const { randomBytes } = require('crypto');
const {
  SESSION_TTL_MS, LOGIN_MAX_FAILURES, LOGIN_LOCK_MS, LOGIN_FAILURE_WINDOW_MS,
} = require('./constants');

/**
 * 教师登录会话（内存）。
 *
 * 老师选班 + 输密码 → 服务端校验后发一枚短期令牌，浏览器只保存令牌、不再保存原始密码。
 * 令牌与班级绑定：一班的令牌访问二班接口会被拒绝。服务重启后所有会话作废。
 * 同一来源对同一班级连续错 LOGIN_MAX_FAILURES 次后短暂锁定，防止反复尝试。
 */
class SessionStore {
  constructor({ ttlMs = SESSION_TTL_MS, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();   // token -> { classId, createdAt, expiresAt }
    this.failures = new Map();   // `${ip}|${classId}` -> { count, lastAt }
  }

  /** 是否处于锁定期；返回剩余毫秒（0 表示未锁定） */
  lockedFor(ip, classId) {
    const entry = this.failures.get(`${ip}|${classId}`);
    if (!entry) return 0;
    const now = this.now();
    if (now - entry.lastAt > LOGIN_FAILURE_WINDOW_MS) {
      this.failures.delete(`${ip}|${classId}`);
      return 0;
    }
    if (entry.count < LOGIN_MAX_FAILURES) return 0;
    const remain = entry.lastAt + LOGIN_LOCK_MS - now;
    return remain > 0 ? remain : 0;
  }

  recordFailure(ip, classId) {
    const key = `${ip}|${classId}`;
    const now = this.now();
    const entry = this.failures.get(key);
    if (!entry || now - entry.lastAt > LOGIN_FAILURE_WINDOW_MS) {
      this.failures.set(key, { count: 1, lastAt: now });
    } else {
      // 锁定期结束后再错，重新从 1 计，不至于一直锁着
      entry.count = entry.count >= LOGIN_MAX_FAILURES && now - entry.lastAt >= LOGIN_LOCK_MS
        ? 1 : entry.count + 1;
      entry.lastAt = now;
    }
    this._pruneFailures();
  }

  clearFailures(ip, classId) {
    this.failures.delete(`${ip}|${classId}`);
  }

  issue(classId) {
    this._pruneSessions();
    const token = randomBytes(32).toString('base64url');
    const createdAt = this.now();
    const session = { token, classId, createdAt, expiresAt: createdAt + this.ttlMs };
    this.sessions.set(token, session);
    return { token, expiresAt: session.expiresAt };
  }

  /** 有效则返回会话，否则 null */
  get(token) {
    if (typeof token !== 'string' || !token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  revoke(token) {
    return this.sessions.delete(token);
  }

  /** 班级被移出配置时，它的会话一并作废 */
  revokeClass(classId) {
    let removed = 0;
    for (const [token, session] of this.sessions) {
      if (session.classId === classId) { this.sessions.delete(token); removed += 1; }
    }
    return removed;
  }

  count(classId) {
    let total = 0;
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (session.expiresAt > now && (classId === undefined || session.classId === classId)) total += 1;
    }
    return total;
  }

  _pruneSessions() {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }

  _pruneFailures() {
    const now = this.now();
    for (const [key, entry] of this.failures) {
      if (now - entry.lastAt > LOGIN_FAILURE_WINDOW_MS) this.failures.delete(key);
    }
    // 兜底：极端情况下也不让这张表无限长大
    if (this.failures.size > 10_000) {
      const oldest = [...this.failures.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
      for (const [key] of oldest.slice(0, oldest.length - 5_000)) this.failures.delete(key);
    }
  }
}

module.exports = { SessionStore };
