'use strict';

const clock = require('./clock');
const { randomUUID } = require('crypto');
const { HISTORY_LIMIT, PRIORITY, DEFAULT_CALLER } = require('./constants');
const { audit } = require('./audit');
const { zoned } = require('./timewin');
const { validateCall } = require('./validate');
const { classContext, announcementPolicy } = require('./policy');
const { log } = require('./logger');

function callerLabel(user) {
  if (!user) return DEFAULT_CALLER;
  const name = user.displayName || DEFAULT_CALLER;
  const short = name.length <= 2 ? `${name}老师` : name;
  return user.title ? `${user.title} · ${short}` : short;
}

/** 通知历史先提交，显示与广播在同一串行写队列的提交后阶段执行。 */
class NoticeService {
  constructor({ store, classes, windows }) {
    this.store = store;
    this.classes = classes;
    this.windows = windows;
  }

  list(classId, { type, authorId, date, limit = 200 } = {}) {
    let out = this.store.get().notices.filter((n) => n.classId === classId);
    if (type) out = out.filter((n) => n.type === type);
    if (authorId) out = out.filter((n) => n.authorId === authorId);
    if (date) out = out.filter((n) => zoned(n.createdAt, this.windows.get().timezone).date === date);
    return out.slice(-limit).reverse();
  }

  get(classId, id) {
    return this.store.get().notices.find((n) => n.classId === classId && n.id === id) || null;
  }

  _context(db, klass, actor, authorize) {
    const context = classContext(db, klass.id, actor, authorize);
    if (!context.ok) return context;
    const runtime = this.classes.get(klass.id);
    if (!runtime) return { ok: false, code: 'CLASS_NOT_FOUND' };
    return { ...context, runtime };
  }

  call(args) {
    return this.store.update((db, tx) => this.callInDb(db, tx, args));
  }

  /** 调度执行标记与通知必须在同一事务提交，避免失败后留下虚假的 sent。 */
  callInDb(db, tx, { klass, names, message, actor, source = 'manual', priority = PRIORITY.CALL, scheduleId = null, ip, authorize }) {
    const context = this._context(db, klass, actor, authorize);
    if (!context.ok) return context;
    ({ klass, actor } = context);
    const { runtime, windows } = context;
    const check = validateCall({ names, message }, klass.roster);
    if (!check.ok) return check;
    if (!windows.isOpen()) return { ok: false, code: 'CALL_WINDOW_CLOSED' };
    if (!runtime.display.canPush()) return { ok: false, code: 'QUEUE_FULL' };
    const now = clock.now();
    const notice = {
      id: randomUUID(), classId: klass.id, type: 'call', source, priority,
      authorId: actor.id, authorName: actor.displayName, authorTitle: actor.title || '', caller: callerLabel(actor),
      names: check.value.names, message: check.value.message,
      createdAt: now, publishAt: now, publishedAt: now, expiresAt: null,
      durationSeconds: klass.autoClearSeconds, status: 'published', deliveryCount: 1, lastDeliveredAt: now, scheduleId,
    };
    db.notices.push(notice);
    this._trim(db);
    const result = { ok: true, notice };
    tx.afterCommit(() => Object.assign(result, this._push(runtime, klass, notice)));
    audit(db, { actor, action: 'notice.call', target: klass.id, detail: { noticeId: notice.id, names: notice.names, source }, ip });
    tx.afterCommit(() => log('student_notice', { classId: klass.id, noticeId: notice.id, count: names.length, source, ...this.classes.counts(klass.id) }));
    return result;
  }

  announce({ klass, title, body, durationSeconds, publishAt, urgent, actor, ip, authorize }) {
    return this.store.update((db, tx) => {
      const context = this._context(db, klass, actor, authorize);
      if (!context.ok) return context;
      ({ klass, actor } = context);
      const { runtime } = context;
      const now = clock.now();
      const policy = announcementPolicy(db, actor, { urgent, publishAt }, now);
      if (!policy.ok) return policy;
      const when = policy.when;
      if (when <= now && !runtime.display.canPush()) return { ok: false, code: 'QUEUE_FULL' };
      const notice = {
        id: randomUUID(), classId: klass.id, type: 'announcement', source: actor.role === 'admin' ? 'admin' : 'manual',
        priority: urgent ? PRIORITY.URGENT : PRIORITY.ANNOUNCEMENT,
        authorId: actor.id, authorName: actor.displayName, authorTitle: actor.title || '', author: callerLabel(actor),
        title, body, createdAt: now, publishAt: when, publishedAt: when <= now ? now : null,
        expiresAt: durationSeconds > 0 ? when + durationSeconds * 1000 : null,
        durationSeconds, status: when <= now ? 'published' : 'scheduled', deliveryCount: when <= now ? 1 : 0, scheduleId: null,
      };
      db.notices.push(notice);
      this._trim(db);
      const result = { ok: true, notice, displayedNow: false };
      tx.afterCommit(() => {
        if (when <= now) Object.assign(result, this._push(runtime, klass, notice));
        else result.event = runtime.display.snapshot();
      });
      audit(db, { actor, action: urgent ? 'notice.urgent' : 'notice.announce', target: klass.id, detail: { noticeId: notice.id, title, publishAt: when }, ip });
      tx.afterCommit(() => log('announcement', { classId: klass.id, noticeId: notice.id, urgent, scheduled: when > now, ...this.classes.counts(klass.id) }));
      return result;
    });
  }

  async publishDue(now = clock.now()) {
    if (!this.store.get().notices.some((n) => n.status === 'scheduled' && n.publishAt <= now)) return 0;
    return this.store.update((db, tx) => {
      let published = 0;
      const reserved = new Map();
      for (const n of db.notices) {
        if (n.status !== 'scheduled' || n.publishAt > now) continue;
        const authorId = n.lastResentBy || n.authorId;
        const actor = db.users.find((u) => u.id === authorId);
        const context = this._context(db, { id: n.classId }, actor);
        const policy = context.ok ? announcementPolicy(db, actor, { urgent: n.priority === PRIORITY.URGENT }, now) : context;
        const reason = !policy.ok ? policy.code : n.expiresAt && n.expiresAt <= now ? 'EXPIRED' : null;
        if (reason) {
          n.status = 'withdrawn'; n.withdrawReason = reason; n.withdrawnAt = now;
          audit(db, { action: 'notice.auto_withdraw', target: n.classId, detail: { noticeId: n.id, reason } });
          continue;
        }
        if (policy.when > now) {
          n.publishAt = policy.when;
          n.expiresAt = n.durationSeconds > 0 ? policy.when + n.durationSeconds * 1000 : null;
          continue;
        }
        const { runtime, klass } = context;
        const count = reserved.get(n.classId) || 0;
        if (!runtime.display.canPush(count)) continue;
        reserved.set(n.classId, count + 1);
        n.status = 'published'; n.publishedAt = now; n.deliveryCount += 1; n.lastDeliveredAt = now;
        tx.afterCommit(() => this._push(runtime, klass, n));
        audit(db, { actor, action: 'notice.publish_due', target: n.classId, detail: { noticeId: n.id } });
        published += 1;
      }
      return published;
    });
  }

  withdraw({ klass, noticeId, actor, ip, authorize }) {
    return this.store.update((db, tx) => {
      const context = this._context(db, klass, actor, authorize);
      if (!context.ok) return context;
      const notice = db.notices.find((n) => n.classId === klass.id && n.id === noticeId);
      if (!notice) return { ok: false, code: 'NOTICE_NOT_FOUND' };
      notice.status = 'withdrawn'; notice.withdrawnAt = clock.now(); notice.withdrawnBy = context.actor.id;
      const result = { ok: true };
      tx.afterCommit(() => {
        Object.assign(result, context.runtime.display.remove(noticeId));
        result.event = context.runtime.display.snapshot();
      });
      audit(db, { actor: context.actor, action: 'notice.withdraw', target: klass.id, detail: { noticeId }, ip });
      return result;
    });
  }

  resend({ klass, noticeId, actor, ip, authorize }) {
    return this.store.update((db, tx) => {
      const context = this._context(db, klass, actor, authorize);
      if (!context.ok) return context;
      ({ klass, actor } = context);
      const { runtime, windows } = context;
      const n = db.notices.find((item) => item.classId === klass.id && item.id === noticeId);
      if (!n) return { ok: false, code: 'NOTICE_NOT_FOUND' };
      const now = clock.now();
      let when = now;
      if (n.type === 'call') {
        const check = validateCall({ names: n.names, message: n.message }, klass.roster);
        if (!check.ok) return check;
        if (!windows.isOpen(now)) return { ok: false, code: 'CALL_WINDOW_CLOSED' };
      } else {
        const policy = announcementPolicy(db, actor, { urgent: n.priority === PRIORITY.URGENT, publishAt: n.status === 'scheduled' ? n.publishAt : null }, now);
        if (!policy.ok) return policy;
        when = policy.when;
      }
      if (runtime.display.has(noticeId)) return { ok: true, notice: n, event: runtime.display.snapshot(), displayedNow: false, alreadyQueued: true };
      if (when <= now && !runtime.display.canPush()) return { ok: false, code: 'QUEUE_FULL' };
      // 保留原作者用于历史查询；本轮显示署名和执行授权属于明确记录的重发者。
      n.lastResentBy = actor.id; n.lastResentByName = actor.displayName; n.lastResentAt = now;
      n.deliveryAuthor = callerLabel(actor);
      n.publishAt = when;
      n.expiresAt = when > now && n.durationSeconds > 0 ? when + n.durationSeconds * 1000 : null;
      n.status = when <= now ? 'published' : 'scheduled';
      if (when <= now) { n.deliveryCount += 1; n.lastDeliveredAt = now; n.publishedAt = now; }
      const result = { ok: true, notice: n, displayedNow: false };
      tx.afterCommit(() => {
        if (when <= now) Object.assign(result, this._push(runtime, klass, n));
        else result.event = runtime.display.snapshot();
      });
      audit(db, { actor, action: 'notice.resend', target: klass.id, detail: { noticeId, publishAt: when, originalAuthorId: n.authorId }, ip });
      return result;
    });
  }

  clear({ klass, all, actor, ip, authorize }) {
    return this.store.update((db, tx) => {
      const context = this._context(db, klass, actor, authorize);
      if (!context.ok) return context;
      const result = { ok: true };
      tx.afterCommit(() => { result.event = context.runtime.display.clear({ all }); });
      audit(db, { actor: context.actor, action: all ? 'display.clear_all' : 'display.clear', target: klass.id, ip });
      tx.afterCommit(() => log('display_clear', { classId: klass.id, all, ...this.classes.counts(klass.id) }));
      return result;
    });
  }

  _push(runtime, klass, notice) {
    return runtime.display.push({
      noticeId: notice.id, type: notice.type, priority: notice.type === 'call' && notice.lastResentBy ? PRIORITY.CALL : notice.priority, source: notice.lastResentBy ? 'manual' : notice.source,
      names: notice.names, message: notice.message, caller: notice.deliveryAuthor || notice.caller,
      title: notice.title, body: notice.body, author: notice.deliveryAuthor || notice.author,
      durationSeconds: notice.type === 'call' ? klass.autoClearSeconds : notice.durationSeconds,
      absoluteExpiresAt: notice.type === 'announcement' ? notice.expiresAt : null,
      launchFreshSeconds: klass.launcher.freshSeconds,
    });
  }

  _trim(db) {
    const perClass = new Map();
    for (const n of db.notices) perClass.set(n.classId, (perClass.get(n.classId) || 0) + 1);
    for (const [classId, count] of perClass) {
      if (count <= HISTORY_LIMIT) continue;
      let drop = count - HISTORY_LIMIT;
      db.notices = db.notices.filter((n) => {
        if (n.classId === classId && drop > 0 && n.status !== 'scheduled') { drop -= 1; return false; }
        return true;
      });
    }
  }
}

module.exports = { NoticeService, callerLabel };
