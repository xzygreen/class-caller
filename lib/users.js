'use strict';

const clock = require('./clock');

const { randomUUID } = require('crypto');
const { hashPassword, verifyPassword, temporaryPassword } = require('./passwords');
const { SessionStore } = require('./auth');
const { audit } = require('./audit');
const { log } = require('./logger');

/**
 * 账号、班级授权与申请审批。
 *
 * user: { id, username, displayName, role:'admin'|'teacher', title, passwordHash, status:'active'|'disabled',
 *         mustChangePassword, createdAt, updatedAt, passwordChangedAt, lastLoginAt }
 * membership: { id, userId, classId, status:'approved'|'revoked', grantedBy, grantedAt, revokedBy, revokedAt }
 * accessRequest: { id, userId, classId, reason, status:'pending'|'approved'|'rejected'|'cancelled',
 *                  createdAt, decidedBy, decidedAt, note }
 */
class UserService {
  constructor({ store, scheduler }) {
    this.store = store;
    this.scheduler = scheduler;
  }

  /* ---------- 查询 ---------- */

  public(user) {
    if (!user) return null;
    return {
      id: user.id, username: user.username, displayName: user.displayName, role: user.role, title: user.title || '',
      status: user.status, mustChangePassword: Boolean(user.mustChangePassword),
      createdAt: user.createdAt, lastLoginAt: user.lastLoginAt || null,
    };
  }

  byId(id) { return this.store.get().users.find((u) => u.id === id) || null; }

  byUsername(username) {
    const wanted = String(username || '').toLowerCase();
    return this.store.get().users.find((u) => u.username === wanted) || null;
  }

  hasAdmin() { return this.store.get().users.some((u) => u.role === 'admin' && u.status === 'active'); }

  /** 用户对班级是否有已批准的权限（管理员对所有班级都有） */
  canAccess(user, classId) {
    if (!user || user.status !== 'active') return false;
    if (user.role === 'admin') return true;
    return this.store.get().memberships.some((m) => m.userId === user.id && m.classId === classId && m.status === 'approved');
  }

  classesFor(user) {
    const db = this.store.get();
    const active = db.classes.filter((c) => c.status === 'active');
    if (user.role === 'admin') return active;
    const ids = new Set(db.memberships.filter((m) => m.userId === user.id && m.status === 'approved').map((m) => m.classId));
    return active.filter((c) => ids.has(c.id));
  }

  requestsFor(user) {
    return this.store.get().accessRequests.filter((r) => r.userId === user.id).slice(-50).reverse();
  }

  /* ---------- 注册 / 登录 ---------- */

  async register({ username, displayName, title, password, ip }) {
    if (this.byUsername(username)) return { ok: false, code: 'USERNAME_TAKEN' };
    const passwordHash = await hashPassword(password);
    const now = clock.now();
    const user = {
      id: randomUUID(), username, displayName, role: 'teacher', title, passwordHash,
      status: 'active', mustChangePassword: false, createdAt: now, updatedAt: now, passwordChangedAt: now, lastLoginAt: null,
    };
    try {
      await this.store.update((db) => {
        if (db.users.some((u) => u.username === username)) throw Object.assign(new Error('taken'), { code: 'USERNAME_TAKEN' });
        db.users.push(user);
        audit(db, { actor: user, action: 'user.register', target: user.id, detail: { username }, ip });
      });
    } catch (err) {
      if (err.code === 'USERNAME_TAKEN') return { ok: false, code: 'USERNAME_TAKEN' };
      throw err;
    }
    log('user_registered', { userId: user.id, username, ip });
    return { ok: true, user };
  }

  /** 校验凭据；成功返回 user，失败返回 null（不区分用户不存在与密码错误） */
  async authenticate(username, password) {
    const user = this.byUsername(username);
    const hash = user ? user.passwordHash : 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ok = await verifyPassword(password, hash);   // 用户不存在也走一遍摘要，避免时间差泄露
    if (!user || !ok) return null;
    return user;
  }

  async touchLogin(userId) {
    await this.store.update((db) => {
      const u = db.users.find((x) => x.id === userId);
      if (u) u.lastLoginAt = clock.now();
    });
  }

  async changePassword({ user, newPassword, ip, keepSessionToken }) {
    const passwordHash = await hashPassword(newPassword);
    await this.store.update((db) => {
      const u = db.users.find((x) => x.id === user.id);
      if (!u) return;
      const now = clock.now();
      u.passwordHash = passwordHash;
      u.passwordChangedAt = now;
      u.mustChangePassword = false;
      u.updatedAt = now;
      // 其它设备上的会话全部失效；当前会话重新签发时间戳以保持登录
      db.sessions = db.sessions.filter((s) => s.userId !== u.id || s.token === keepSessionToken);
      for (const s of db.sessions) if (s.token === keepSessionToken) s.createdAt = now;
      audit(db, { actor: user, action: 'user.password_change', target: user.id, ip });
    });
  }

  /* ---------- 教师：申请班级 ---------- */

  async requestAccess({ user, classId, reason, ip }) {
    const db = this.store.get();
    const klass = db.classes.find((c) => c.id === classId && c.status === 'active');
    if (!klass) return { ok: false, code: 'CLASS_NOT_FOUND' };
    if (this.canAccess(user, classId)) return { ok: false, code: 'ALREADY_MEMBER' };
    if (db.accessRequests.some((r) => r.userId === user.id && r.classId === classId && r.status === 'pending')) {
      return { ok: false, code: 'REQUEST_PENDING' };
    }
    const request = {
      id: randomUUID(), userId: user.id, classId, reason, status: 'pending',
      createdAt: clock.now(), decidedBy: null, decidedAt: null, note: null,
    };
    await this.store.update((d) => {
      d.accessRequests.push(request);
      audit(d, { actor: user, action: 'access.request', target: classId, detail: { requestId: request.id }, ip });
    });
    return { ok: true, request };
  }

  async cancelRequest({ user, requestId, ip }) {
    const request = this.store.get().accessRequests.find((r) => r.id === requestId && r.userId === user.id);
    if (!request) return { ok: false, code: 'REQUEST_NOT_FOUND' };
    if (request.status !== 'pending') return { ok: false, code: 'REQUEST_ALREADY_DECIDED' };
    await this.store.update((d) => {
      const r = d.accessRequests.find((x) => x.id === requestId);
      r.status = 'cancelled'; r.decidedAt = clock.now();
      audit(d, { actor: user, action: 'access.cancel', target: r.classId, detail: { requestId }, ip });
    });
    return { ok: true };
  }

  /* ---------- 管理员：审批与授权 ---------- */

  async decideRequest({ admin, requestId, approve, note, ip }) {
    const request = this.store.get().accessRequests.find((r) => r.id === requestId);
    if (!request) return { ok: false, code: 'REQUEST_NOT_FOUND' };
    if (request.status !== 'pending') return { ok: false, code: 'REQUEST_ALREADY_DECIDED' };
    await this.store.update((db) => {
      const r = db.accessRequests.find((x) => x.id === requestId);
      const now = clock.now();
      r.status = approve ? 'approved' : 'rejected';
      r.decidedBy = admin.id; r.decidedAt = now; r.note = note || null;
      if (approve) this._grantInDb(db, { userId: r.userId, classId: r.classId, admin, now });
      audit(db, { actor: admin, action: approve ? 'access.approve' : 'access.reject', target: r.classId, detail: { requestId, userId: r.userId, note }, ip });
    });
    return { ok: true, request: this.store.get().accessRequests.find((r) => r.id === requestId) };
  }

  _grantInDb(db, { userId, classId, admin, now }) {
    const existing = db.memberships.find((m) => m.userId === userId && m.classId === classId);
    if (existing) {
      existing.status = 'approved'; existing.grantedBy = admin.id; existing.grantedAt = now; existing.revokedBy = null; existing.revokedAt = null;
    } else {
      db.memberships.push({ id: randomUUID(), userId, classId, status: 'approved', grantedBy: admin.id, grantedAt: now, revokedBy: null, revokedAt: null });
    }
    // 该用户对该班级已恢复权限：之前因权限撤销暂停的任务恢复
    for (const s of db.schedules) {
      if (s.createdBy === userId && s.classId === classId && s.status === 'paused' && s.pauseReason === 'ACCESS_REVOKED') {
        s.status = 'active'; s.pauseReason = null; s.updatedAt = now;
      }
    }
  }

  async grant({ admin, userId, classId, ip }) {
    const db = this.store.get();
    const user = db.users.find((u) => u.id === userId);
    if (!user) return { ok: false, code: 'USER_NOT_FOUND' };
    if (!db.classes.some((c) => c.id === classId && c.status === 'active')) return { ok: false, code: 'CLASS_NOT_FOUND' };
    await this.store.update((d) => {
      const now = clock.now();
      this._grantInDb(d, { userId, classId, admin, now });
      // 同一用户对该班级的待审申请随之视为已批准
      for (const r of d.accessRequests) {
        if (r.userId === userId && r.classId === classId && r.status === 'pending') { r.status = 'approved'; r.decidedBy = admin.id; r.decidedAt = now; }
      }
      audit(d, { actor: admin, action: 'access.grant', target: classId, detail: { userId }, ip });
    });
    return { ok: true };
  }

  async revoke({ admin, userId, classId, ip }) {
    const existing = this.store.get().memberships.find((m) => m.userId === userId && m.classId === classId && m.status === 'approved');
    if (!existing) return { ok: false, code: 'NO_CLASS_ACCESS' };
    let paused = 0;
    await this.store.update((db) => {
      const m = db.memberships.find((x) => x.id === existing.id);
      const now = clock.now();
      m.status = 'revoked'; m.revokedBy = admin.id; m.revokedAt = now;
      paused = this.scheduler.reconcileInDb(db, { actor: admin, reason: 'access.revoke' });
      audit(db, { actor: admin, action: 'access.revoke', target: classId, detail: { userId, pausedSchedules: paused }, ip });
    });
    return { ok: true, pausedSchedules: paused };
  }

  /* ---------- 管理员：账号 ---------- */

  async createUser({ admin, value, role, ip }) {
    if (this.byUsername(value.username)) return { ok: false, code: 'USERNAME_TAKEN' };
    const passwordHash = await hashPassword(value.password);
    const now = clock.now();
    const user = {
      id: randomUUID(), username: value.username, displayName: value.displayName, role, title: value.title, passwordHash,
      status: 'active', mustChangePassword: true, createdAt: now, updatedAt: now, passwordChangedAt: now, lastLoginAt: null,
    };
    await this.store.update((db) => {
      if (db.users.some((u) => u.username === value.username)) throw Object.assign(new Error('taken'), { code: 'USERNAME_TAKEN' });
      db.users.push(user);
      audit(db, { actor: admin, action: role === 'admin' ? 'user.create_admin' : 'user.create', target: user.id, detail: { username: value.username }, ip });
    }).catch((err) => { if (err.code !== 'USERNAME_TAKEN') throw err; });
    return this.byId(user.id) ? { ok: true, user } : { ok: false, code: 'USERNAME_TAKEN' };
  }

  /**
   * 修改账号：displayName / title / status / resetPassword。
   * 停用账号或重置密码会立即撤销其全部会话并暂停相关定时任务。
   */
  async updateUser({ admin, userId, changes, ip }) {
    const user = this.byId(userId);
    if (!user) return { ok: false, code: 'USER_NOT_FOUND' };
    let tempPassword = null;
    let passwordHash = null;
    if (changes.resetPassword) {
      tempPassword = temporaryPassword();
      passwordHash = await hashPassword(tempPassword);
    }
    if (changes.status === 'disabled' && user.role === 'admin') {
      const others = this.store.get().users.filter((u) => u.role === 'admin' && u.status === 'active' && u.id !== userId);
      if (!others.length) return { ok: false, code: 'LAST_ADMIN' };
    }
    let paused = 0;
    await this.store.update((db) => {
      const u = db.users.find((x) => x.id === userId);
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
      paused = this.scheduler.reconcileInDb(db, { actor: admin, reason: 'user.update' });
      audit(db, { actor: admin, action: 'user.update', target: u.id, detail, ip });
    });
    return { ok: true, user: this.byId(userId), tempPassword, pausedSchedules: paused };
  }

  /**
   * 删除账号：连同其会话、班级授权、申请与定时任务一起移除。
   * 已发出的通知记录与审计保留（authorName 已冗余存储，不依赖用户存在）。
   * 最后一名启用的管理员不能删除。
   */
  async deleteUser({ admin, userId, ip }) {
    const user = this.byId(userId);
    if (!user) return { ok: false, code: 'USER_NOT_FOUND' };
    if (user.role === 'admin' && user.status === 'active') {
      const others = this.store.get().users.filter((u) => u.role === 'admin' && u.status === 'active' && u.id !== userId);
      if (!others.length) return { ok: false, code: 'LAST_ADMIN' };
    }
    let removedSchedules = 0;
    await this.store.update((db) => {
      db.users = db.users.filter((u) => u.id !== userId);
      SessionStore.revokeUserInDb(db, userId);
      db.memberships = db.memberships.filter((m) => m.userId !== userId);
      db.accessRequests = db.accessRequests.filter((r) => r.userId !== userId);
      const before = db.schedules.length;
      db.schedules = db.schedules.filter((s) => s.createdBy !== userId);
      removedSchedules = before - db.schedules.length;
      audit(db, { actor: admin, action: 'user.delete', target: userId, detail: { username: user.username, role: user.role, removedSchedules }, ip });
    });
    log('user_deleted', { userId, role: user.role, removedSchedules });
    return { ok: true, user, removedSchedules };
  }

  /** 管理员强制所有人重新登录（例如升级后） */
  async revokeAllSessions({ admin, ip }) {
    let n = 0;
    await this.store.update((db) => {
      n = SessionStore.revokeAllInDb(db);
      audit(db, { actor: admin, action: 'session.revoke_all', detail: { count: n }, ip });
    });
    return n;
  }
}

module.exports = { UserService };
