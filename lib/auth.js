'use strict';

const clock = require('./clock');
const { randomBytes, createHash } = require('crypto');
const {
  SESSION_TTL_MS, LOGIN_MAX_FAILURES, LOGIN_LOCK_MS, LOGIN_FAILURE_WINDOW_MS, REGISTER_MAX_PER_HOUR,
} = require('./constants');

const REGISTER_WINDOW_MS = 3_600_000;
const MAX_TRACKED_SOURCES = 10_000;
const credentialHash = (hash) => createHash('sha256').update(hash).digest('hex');
const deniedAttempt = (retryAfterMs) => ({ ok: false, code: 'TOO_MANY_ATTEMPTS', retryAfterMs: Math.max(1000, retryAfterMs) });

/** Persistent sessions, atomic attempt reservations and bounded anonymous authentication work. */
class SessionStore {
  constructor({ store, ttlMs = SESSION_TTL_MS, now = clock.now, maxInFlightPerIp = 10, maxInFlight = 32 }) {
    if (!Number.isInteger(maxInFlightPerIp) || maxInFlightPerIp < 1 || !Number.isInteger(maxInFlight) || maxInFlight < 1) {
      throw new TypeError('Authentication concurrency limits must be positive integers');
    }
    this.store = store;
    this.ttlMs = ttlMs;
    this.now = now;
    this.maxInFlightPerIp = maxInFlightPerIp;
    this.maxInFlight = maxInFlight;
    this.inFlight = 0;
    this.inFlightByIp = new Map();
    // count includes unfinished attempts, so parallel work cannot bypass the failure limit.
    this.failures = new Map(); // [ip, username] -> { count, pending, lastAt }
    this.registrations = new Map(); // ip -> admitted attempt timestamps (including failures)
  }

  /* ---------- Limits: acquire synchronously before hashing, release in finally ---------- */

  _loginKey(ip, username) { return JSON.stringify([ip, String(username || '').trim().toLowerCase()]); }

  lockedFor(ip, username) {
    const key = this._loginKey(ip, username);
    const entry = this.failures.get(key);
    if (!entry) return 0;
    const now = this.now();
    if (!entry.pending && now - entry.lastAt >= LOGIN_FAILURE_WINDOW_MS) {
      this.failures.delete(key);
      return 0;
    }
    if (entry.count < LOGIN_MAX_FAILURES) return 0;
    // An unfinished attempt continues occupying a slot even if hashing/writing takes too long.
    return entry.pending ? Math.max(1000, entry.lastAt + LOGIN_LOCK_MS - now) : Math.max(0, entry.lastAt + LOGIN_LOCK_MS - now);
  }

  beginRegistration(ip) {
    this._pruneLimits();
    const now = this.now();
    const list = this.registrations.get(ip) || [];
    if (list.length >= REGISTER_MAX_PER_HOUR) return deniedAttempt(list[0] + REGISTER_WINDOW_MS - now);
    if (!this.registrations.has(ip) && this.registrations.size >= MAX_TRACKED_SOURCES) return deniedAttempt(REGISTER_WINDOW_MS);
    const release = this._reserveWork(ip);
    if (!release) return deniedAttempt(1000);
    // Admitted failures consume quota too; only rejected reservations leave it untouched.
    list.push(now);
    this.registrations.set(ip, list);
    return { ok: true, release };
  }

  beginLogin(ip, username) {
    this._pruneLimits();
    const locked = this.lockedFor(ip, username);
    if (locked) return deniedAttempt(locked);
    const key = this._loginKey(ip, username);
    if (!this.failures.has(key) && this.failures.size >= MAX_TRACKED_SOURCES) return deniedAttempt(LOGIN_FAILURE_WINDOW_MS);
    const releaseWork = this._reserveWork(ip);
    if (!releaseWork) return deniedAttempt(1000);
    const now = this.now();
    let entry = this.failures.get(key);
    if (!entry || (!entry.pending && entry.count >= LOGIN_MAX_FAILURES && now - entry.lastAt >= LOGIN_LOCK_MS)) {
      entry = { count: 0, pending: 0, lastAt: now };
      this.failures.set(key, entry);
    }
    entry.count += 1;
    entry.pending += 1;
    entry.lastAt = now;
    let released = false;
    let succeeded = false;
    return {
      ok: true,
      // Only mark success after a session has been committed, not merely after password verification.
      succeed() { if (!released) succeeded = true; },
      release: () => {
        if (released) return;
        released = true;
        if (succeeded) entry.count = entry.pending - 1; // clear failures, but retain other reservations
        entry.pending -= 1;
        entry.lastAt = this.now();
        if (!entry.count && !entry.pending) this.failures.delete(key);
        releaseWork();
      },
    };
  }

  _reserveWork(ip) {
    const current = this.inFlightByIp.get(ip) || 0;
    if (this.inFlight >= this.maxInFlight || current >= this.maxInFlightPerIp) return null;
    this.inFlight += 1;
    this.inFlightByIp.set(ip, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      const remaining = this.inFlightByIp.get(ip) - 1;
      if (remaining) this.inFlightByIp.set(ip, remaining);
      else this.inFlightByIp.delete(ip);
    };
  }

  _pruneLimits() {
    const now = this.now();
    for (const [key, entry] of this.failures) {
      if (!entry.pending && now - entry.lastAt >= LOGIN_FAILURE_WINDOW_MS) this.failures.delete(key);
    }
    for (const [ip, timestamps] of this.registrations) {
      const current = timestamps.filter((at) => now - at < REGISTER_WINDOW_MS);
      if (current.length) this.registrations.set(ip, current);
      else this.registrations.delete(ip);
    }
  }

  /* ---------- Sessions ---------- */

  /** Evidence must describe the password actually verified, never a subsequently reloaded user. */
  async issue(credential, ip) {
    const { userId, passwordHash } = credential || {};
    return this.store.update((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user || typeof passwordHash !== 'string' || !passwordHash || user.passwordHash !== passwordHash) {
        throw Object.assign(new Error('Credentials changed or user no longer exists'), { code: 'INVALID_CREDENTIALS', status: 401 });
      }
      if (user.status !== 'active') throw Object.assign(new Error('Account disabled'), { code: 'ACCOUNT_DISABLED', status: 403 });
      const now = this.now();
      const session = {
        token: randomBytes(32).toString('base64url'), userId, createdAt: now, expiresAt: now + this.ttlMs, ip,
        credentialHash: credentialHash(passwordHash),
      };
      db.sessions = db.sessions.filter((s) => s.expiresAt > now);
      db.sessions.push(session);
      user.lastLoginAt = now;
      return { ...session };
    });
  }

  /** Pass the transaction's candidate DB when authorization protects a write. */
  resolve(token, db = this.store.get()) {
    return SessionStore.resolveInDb(token, db, this.now());
  }

  static resolveInDb(token, db, now = clock.now()) {
    if (typeof token !== 'string' || !token) return { reason: 'UNAUTHORIZED' };
    const session = db.sessions.find((s) => s.token === token);
    if (!session || session.expiresAt <= now) return { reason: 'UNAUTHORIZED' };
    const user = db.users.find((u) => u.id === session.userId);
    if (!user) return { reason: 'UNAUTHORIZED' };
    if (user.status !== 'active') return { reason: 'ACCOUNT_DISABLED' };
    if (session.credentialHash && session.credentialHash !== credentialHash(user.passwordHash)) return { reason: 'UNAUTHORIZED' };
    // Compatibility with sessions issued before credential fingerprints were added.
    if (user.passwordChangedAt && session.createdAt < user.passwordChangedAt) return { reason: 'UNAUTHORIZED' };
    return { session: { ...session }, user: { ...user } };
  }

  static refreshCredentialInDb(session, passwordHash, now) {
    session.createdAt = now;
    session.credentialHash = credentialHash(passwordHash);
  }

  revoke(token) {
    return this.store.update((db) => {
      const before = db.sessions.length;
      db.sessions = db.sessions.filter((s) => s.token !== token);
      return before - db.sessions.length;
    });
  }

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
}

module.exports = { SessionStore };
