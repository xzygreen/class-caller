'use strict';

const clock = require('./clock');
const { randomUUID } = require('crypto');
const { hashPassword, verifyPassword, temporaryPassword } = require('./passwords');
const { SessionStore } = require('./auth');
const { audit } = require('./audit');
const { log } = require('./logger');

const failure = (code) => ({ ok: false, code });
const credentialFor = (user) => Object.freeze({ userId: user.id, passwordHash: user.passwordHash });

/** Accounts, class access and approvals. All write-side decisions use the transaction's current DB. */
class UserService {
  constructor({ store, scheduler }) {
    this.store = store;
    this.scheduler = scheduler;
  }

  public(user) {
    if (!user) return null;
    return {
      id: user.id, username: user.username, displayName: user.displayName, role: user.role, title: user.title || '',
      status: user.status, mustChangePassword: Boolean(user.mustChangePassword),
      createdAt: user.createdAt, lastLoginAt: user.lastLoginAt || null,
    };
  }

  byId(id) {
    const user = this.store.get().users.find((u) => u.id === id);
    return user ? { ...user } : null;
  }

  byUsername(username) {
    const wanted = String(username || '').trim().toLowerCase();
    const user = this.store.get().users.find((u) => u.username === wanted);
    return user ? { ...user } : null;
  }

  hasAdmin() { return this.store.get().users.some((u) => u.role === 'admin' && u.status === 'active'); }

  canAccess(user, classId, db = this.store.get()) {
    const current = user && db.users.find((u) => u.id === user.id);
    if (!current || current.status !== 'active' || !db.classes.some((c) => c.id === classId && c.status === 'active')) return false;
    return current.role === 'admin' || db.memberships.some((m) => m.userId === current.id && m.classId === classId && m.status === 'approved');
  }

  classesFor(user) {
    const db = this.store.get();
    return db.classes.filter((c) => c.status === 'active' && this.canAccess(user, c.id, db));
  }

  requestsFor(user) {
    return this.store.get().accessRequests.filter((r) => r.userId === user.id).slice(-50).reverse();
  }

  /** authorize checks the live session; service checks also protect callers without an HTTP context. */
  _actorInDb(db, actor, { authorize, admin = false, allowPasswordChangeRequired = false } = {}) {
    if (authorize) authorize(db);
    const user = actor && db.users.find((u) => u.id === actor.id);
    if (!user) return failure('UNAUTHORIZED');
    if (user.status !== 'active') return failure('ACCOUNT_DISABLED');
    if (actor.passwordHash !== undefined && user.passwordHash !== actor.passwordHash) return failure('UNAUTHORIZED');
    if (admin && user.role !== 'admin') return failure('ADMIN_ONLY');
    if (user.mustChangePassword && !allowPasswordChangeRequired) return failure('PASSWORD_CHANGE_REQUIRED');
    return { ok: true, user };
  }

  /* ---------- Registration / credentials ---------- */

  async register({ username, displayName, title, password, ip }) {
    username = String(username || '').trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const result = await this.store.update((db) => {
      if (db.users.some((u) => u.username === username)) return failure('USERNAME_TAKEN');
      const now = clock.now();
      const user = {
        id: randomUUID(), username, displayName, role: 'teacher', title, passwordHash,
        status: 'active', mustChangePassword: false, createdAt: now, updatedAt: now, passwordChangedAt: now, lastLoginAt: null,
      };
      db.users.push(user);
      audit(db, { actor: user, action: 'user.register', target: user.id, detail: { username }, ip });
      return { ok: true, user: { ...user }, credential: credentialFor(user) };
    });
    if (result.ok) log('user_registered', { userId: result.user.id, username, ip });
    return result;
  }

  /** Detached evidence captures exactly the hash supplied to the asynchronous verifier. */
  async authenticate(username, password) {
    const user = this.byUsername(username);
    const hash = user ? user.passwordHash : 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ok = await verifyPassword(password, hash);
    if (!user || !ok) return null;
    return { user: Object.freeze(user), credential: credentialFor(user) };
  }

  async changePassword({ user, newPassword, ip, keepSessionToken, credential, authorize }) {
    user = { ...user };
    credential = credential && { ...credential };
    const passwordHash = await hashPassword(newPassword);
    return this.store.update((db) => {
      const actor = this._actorInDb(db, user, { authorize, allowPasswordChangeRequired: true });
      if (!actor.ok) return actor;
      const u = actor.user;
      const resolved = SessionStore.resolveInDb(keepSessionToken, db);
      if (!resolved.user || resolved.user.id !== u.id || !user.passwordHash || user.passwordHash !== u.passwordHash) return failure('UNAUTHORIZED');
      // A temporary-password session may omit the old password only while its original credential is still current.
      if (!u.mustChangePassword || !user.mustChangePassword) {
        if (!credential || credential.userId !== u.id || credential.passwordHash !== u.passwordHash) return failure('INVALID_PASSWORD');
      }
      const now = clock.now();
      u.passwordHash = passwordHash;
      u.passwordChangedAt = now;
      u.mustChangePassword = false;
      u.updatedAt = now;
      db.sessions = db.sessions.filter((s) => s.userId !== u.id || s.token === keepSessionToken);
      const retained = db.sessions.find((s) => s.token === keepSessionToken && s.userId === u.id);
      SessionStore.refreshCredentialInDb(retained, passwordHash, now);
      audit(db, { actor: u, action: 'user.password_change', target: u.id, ip });
      return { ok: true, user: { ...u } };
    });
  }

  /* ---------- Teacher access requests ---------- */

  async requestAccess({ user, classId, reason, ip, authorize }) {
    user = { ...user };
    return this.store.update((db) => {
      const actor = this._actorInDb(db, user, { authorize });
      if (!actor.ok) return actor;
      if (!db.classes.some((c) => c.id === classId && c.status === 'active')) return failure('CLASS_NOT_FOUND');
      if (this.canAccess(actor.user, classId, db)) return failure('ALREADY_MEMBER');
      if (db.accessRequests.some((r) => r.userId === user.id && r.classId === classId && r.status === 'pending')) return failure('REQUEST_PENDING');
      const request = {
        id: randomUUID(), userId: user.id, classId, reason, status: 'pending',
        createdAt: clock.now(), decidedBy: null, decidedAt: null, note: null,
      };
      db.accessRequests.push(request);
      audit(db, { actor: actor.user, action: 'access.request', target: classId, detail: { requestId: request.id }, ip });
      return { ok: true, request: { ...request } };
    });
  }

  async cancelRequest({ user, requestId, ip, authorize }) {
    user = { ...user };
    return this.store.update((db) => {
      const actor = this._actorInDb(db, user, { authorize });
      if (!actor.ok) return actor;
      const r = db.accessRequests.find((x) => x.id === requestId && x.userId === actor.user.id);
      if (!r) return failure('REQUEST_NOT_FOUND');
      if (r.status !== 'pending') return failure('REQUEST_ALREADY_DECIDED');
      r.status = 'cancelled'; r.decidedAt = clock.now();
      audit(db, { actor: actor.user, action: 'access.cancel', target: r.classId, detail: { requestId }, ip });
      return { ok: true };
    });
  }

  /* ---------- Administrator approvals / access ---------- */

  async decideRequest({ admin, requestId, approve, note, ip, authorize }) {
    admin = { ...admin };
    return this.store.update((db) => {
      const actor = this._actorInDb(db, admin, { authorize, admin: true });
      if (!actor.ok) return actor;
      const r = db.accessRequests.find((x) => x.id === requestId);
      if (!r) return failure('REQUEST_NOT_FOUND');
      if (r.status !== 'pending') return failure('REQUEST_ALREADY_DECIDED');
      const user = db.users.find((u) => u.id === r.userId);
      if (!user) return failure('USER_NOT_FOUND');
      if (approve && user.status !== 'active') return failure('ACCOUNT_DISABLED');
      if (approve && !db.classes.some((c) => c.id === r.classId && c.status === 'active')) return failure('CLASS_NOT_FOUND');
      const now = clock.now();
      r.status = approve ? 'approved' : 'rejected';
      r.decidedBy = actor.user.id; r.decidedAt = now; r.note = note || null;
      if (approve) this._grantInDb(db, { userId: r.userId, classId: r.classId, admin: actor.user, now });
      audit(db, { actor: actor.user, action: approve ? 'access.approve' : 'access.reject', target: r.classId, detail: { requestId, userId: r.userId, note }, ip });
      return { ok: true, request: { ...r } };
    });
  }

  _grantInDb(db, { userId, classId, admin, now }) {
    const existing = db.memberships.find((m) => m.userId === userId && m.classId === classId);
    if (existing) {
      existing.status = 'approved'; existing.grantedBy = admin.id; existing.grantedAt = now; existing.revokedBy = null; existing.revokedAt = null;
    } else {
      db.memberships.push({ id: randomUUID(), userId, classId, status: 'approved', grantedBy: admin.id, grantedAt: now, revokedBy: null, revokedAt: null });
    }
    for (const s of db.schedules) {
      if (s.createdBy === userId && s.classId === classId && s.status === 'paused' && s.pauseReason === 'ACCESS_REVOKED') {
        s.status = 'active'; s.pauseReason = null; s.updatedAt = now;
      }
    }
  }

  async grant({ admin, userId, classId, ip, authorize }) {
    admin = { ...admin };
    return this.store.update((db) => {
      const actor = this._actorInDb(db, admin, { authorize, admin: true });
      if (!actor.ok) return actor;
      const user = db.users.find((u) => u.id === userId);
      if (!user) return failure('USER_NOT_FOUND');
      if (user.status !== 'active') return failure('ACCOUNT_DISABLED');
      if (!db.classes.some((c) => c.id === classId && c.status === 'active')) return failure('CLASS_NOT_FOUND');
      const now = clock.now();
      this._grantInDb(db, { userId, classId, admin: actor.user, now });
      for (const r of db.accessRequests) {
        if (r.userId === userId && r.classId === classId && r.status === 'pending') { r.status = 'approved'; r.decidedBy = actor.user.id; r.decidedAt = now; }
      }
      audit(db, { actor: actor.user, action: 'access.grant', target: classId, detail: { userId }, ip });
      return { ok: true };
    });
  }

  async revoke({ admin, userId, classId, ip, authorize }) {
    admin = { ...admin };
    return this.store.update((db) => {
      const actor = this._actorInDb(db, admin, { authorize, admin: true });
      if (!actor.ok) return actor;
      if (!db.users.some((u) => u.id === userId)) return failure('USER_NOT_FOUND');
      if (!db.classes.some((c) => c.id === classId)) return failure('CLASS_NOT_FOUND');
      const m = db.memberships.find((x) => x.userId === userId && x.classId === classId && x.status === 'approved');
      if (!m) return failure('NO_CLASS_ACCESS');
      m.status = 'revoked'; m.revokedBy = actor.user.id; m.revokedAt = clock.now();
      const paused = this.scheduler.reconcileInDb(db, { actor: actor.user, reason: 'access.revoke' });
      audit(db, { actor: actor.user, action: 'access.revoke', target: classId, detail: { userId, pausedSchedules: paused }, ip });
      return { ok: true, pausedSchedules: paused };
    });
  }

  /* ---------- Administrator accounts ---------- */

  async createUser({ admin, value, role, ip, authorize }) {
    admin = { ...admin };
    value = { ...value, username: String(value.username || '').trim().toLowerCase() };
    const passwordHash = await hashPassword(value.password);
    return this.store.update((db) => {
      const actor = this._actorInDb(db, admin, { authorize, admin: true });
      if (!actor.ok) return actor;
      if (db.users.some((u) => u.username === value.username)) return failure('USERNAME_TAKEN');
      const now = clock.now();
      const user = {
        id: randomUUID(), username: value.username, displayName: value.displayName, role, title: value.title, passwordHash,
        status: 'active', mustChangePassword: true, createdAt: now, updatedAt: now, passwordChangedAt: now, lastLoginAt: null,
      };
      db.users.push(user);
      audit(db, { actor: actor.user, action: role === 'admin' ? 'user.create_admin' : 'user.create', target: user.id, detail: { username: value.username }, ip });
      return { ok: true, user: { ...user } };
    });
  }

  /** Disable/reset revoke sessions; last-active-admin protection is checked in the same transaction. */
  async updateUser({ admin, userId, changes, ip, authorize }) {
    admin = { ...admin };
    changes = { ...changes };
    let tempPassword = null;
    let passwordHash = null;
    if (changes.resetPassword) {
      tempPassword = temporaryPassword();
      passwordHash = await hashPassword(tempPassword);
    }
    return this.store.update((db) => {
      const actor = this._actorInDb(db, admin, { authorize, admin: true });
      if (!actor.ok) return actor;
      const u = db.users.find((x) => x.id === userId);
      if (!u) return failure('USER_NOT_FOUND');
      if (changes.status === 'disabled' && u.role === 'admin' && u.status === 'active' && !db.users.some((x) => x.role === 'admin' && x.status === 'active' && x.id !== userId)) return failure('LAST_ADMIN');
      const now = clock.now();
      const detail = {};
      if (changes.displayName !== undefined) { u.displayName = changes.displayName; detail.displayName = true; }
      if (changes.title !== undefined) { u.title = changes.title; detail.title = true; }
      if (changes.status !== undefined && changes.status !== u.status) {
        u.status = changes.status; detail.status = changes.status;
        if (changes.status !== 'active') SessionStore.revokeUserInDb(db, u.id);
      }
      if (passwordHash) {
        u.passwordHash = passwordHash; u.passwordChangedAt = now; u.mustChangePassword = true; detail.resetPassword = true;
        SessionStore.revokeUserInDb(db, u.id);
      }
      u.updatedAt = now;
      const paused = this.scheduler.reconcileInDb(db, { actor: actor.user, reason: 'user.update' });
      audit(db, { actor: actor.user, action: 'user.update', target: u.id, detail, ip });
      return { ok: true, user: { ...u }, tempPassword, pausedSchedules: paused };
    });
  }

  /** Delete dependent sessions/access/tasks but retain historical notices and audit records. */
  async deleteUser({ admin, userId, ip, authorize }) {
    admin = { ...admin };
    const result = await this.store.update((db) => {
      const actor = this._actorInDb(db, admin, { authorize, admin: true });
      if (!actor.ok) return actor;
      const user = db.users.find((u) => u.id === userId);
      if (!user) return failure('USER_NOT_FOUND');
      if (user.role === 'admin' && user.status === 'active' && !db.users.some((u) => u.role === 'admin' && u.status === 'active' && u.id !== userId)) return failure('LAST_ADMIN');
      if (actor.user.id === userId) return failure('SELF_DELETE');
      db.users = db.users.filter((u) => u.id !== userId);
      SessionStore.revokeUserInDb(db, userId);
      db.memberships = db.memberships.filter((m) => m.userId !== userId);
      db.accessRequests = db.accessRequests.filter((r) => r.userId !== userId);
      const before = db.schedules.length;
      db.schedules = db.schedules.filter((s) => s.createdBy !== userId);
      const removedSchedules = before - db.schedules.length;
      audit(db, { actor: actor.user, action: 'user.delete', target: userId, detail: { username: user.username, role: user.role, removedSchedules }, ip });
      return { ok: true, user: { ...user }, removedSchedules };
    });
    if (result.ok) log('user_deleted', { userId, role: result.user.role, removedSchedules: result.removedSchedules });
    return result;
  }

  async revokeAllSessions({ admin, ip, authorize }) {
    admin = { ...admin };
    return this.store.update((db) => {
      const actor = this._actorInDb(db, admin, { authorize, admin: true });
      if (!actor.ok) throw Object.assign(new Error(actor.code), { code: actor.code, status: actor.code === 'UNAUTHORIZED' ? 401 : 403 });
      const n = SessionStore.revokeAllInDb(db);
      audit(db, { actor: actor.user, action: 'session.revoke_all', detail: { count: n }, ip });
      return n;
    });
  }
}

module.exports = { UserService };
