'use strict';

const clock = require('./clock');

const { randomUUID } = require('crypto');
const { HISTORY_LIMIT, PRIORITY, DEFAULT_CALLER } = require('./constants');
const { audit } = require('./audit');
const { log } = require('./logger');

/**
 * 通知服务：点人与留言的创建、发布、撤回、重发。
 * 记录持久化在 store.notices；大屏当前内容与队列在各班的 DisplayQueue 内存中。
 *
 * notice: {
 *   id, classId, type: 'call'|'announcement', source: 'manual'|'schedule'|'admin',
 *   priority, authorId, authorName, authorTitle,
 *   names, message,                 // call
 *   title, body,                    // announcement
 *   createdAt, publishAt, publishedAt, expiresAt (绝对，可 null), durationSeconds,
 *   status: 'scheduled'|'published'|'withdrawn', deliveryCount, scheduleId
 * }
 */

function callerLabel(user) {
  if (!user) return DEFAULT_CALLER;
  const name = user.displayName || DEFAULT_CALLER;
  const short = name.length <= 2 ? `${name}老师` : name;
  return user.title ? `${user.title} · ${short}` : short;
}

class NoticeService {
  constructor({ store, classes, windows }) {
    this.store = store;
    this.classes = classes;
    this.windows = windows;
  }

  /* ---------- 查询 ---------- */

  list(classId, { type, authorId, date, limit = 200 } = {}) {
    const all = this.store.get().notices.filter((n) => n.classId === classId);
    let out = all;
    if (type) out = out.filter((n) => n.type === type);
    if (authorId) out = out.filter((n) => n.authorId === authorId);
    if (date) out = out.filter((n) => new Date(n.createdAt).toISOString().slice(0, 10) === date);
    return out.slice(-limit).reverse();
  }

  get(classId, id) {
    return this.store.get().notices.find((n) => n.classId === classId && n.id === id) || null;
  }

  /* ---------- 点人 ---------- */

  /**
   * 创建并立即发布一条点人通知。调用方已经校验了权限、名单和作息。
   */
  async call({ klass, names, message, actor, source = 'manual', priority = PRIORITY.CALL, scheduleId = null, ip }) {
    const runtime = this.classes.get(klass.id);
    if (!runtime) return { ok: false, code: 'CLASS_NOT_FOUND' };
    const now = clock.now();
    const notice = {
      id: randomUUID(), classId: klass.id, type: 'call', source, priority,
      authorId: actor ? actor.id : null, authorName: actor ? actor.displayName : '系统', authorTitle: actor ? actor.title || '' : '',
      caller: callerLabel(actor),
      names: [...names], message,
      createdAt: now, publishAt: now, publishedAt: now, expiresAt: null,
      durationSeconds: klass.autoClearSeconds, status: 'published', deliveryCount: 0, scheduleId,
    };
    const pushed = this._push(runtime, klass, notice);
    if (!pushed.ok) return pushed;
    notice.deliveryCount = 1;
    notice.lastDeliveredAt = now;
    await this.store.update((db) => {
      db.notices.push(notice);
      this._trim(db);
      if (actor) audit(db, { actor, action: 'notice.call', target: klass.id, detail: { noticeId: notice.id, names: notice.names, source }, ip });
    });
    log('student_notice', { classId: klass.id, noticeId: notice.id, count: names.length, caller: notice.caller, source, ...this.classes.counts(klass.id) });
    return { ok: true, notice, event: pushed.event, displayedNow: pushed.displayedNow };
  }

  /* ---------- 留言 ---------- */

  async announce({ klass, title, body, durationSeconds, publishAt, urgent, actor, ip }) {
    const runtime = this.classes.get(klass.id);
    if (!runtime) return { ok: false, code: 'CLASS_NOT_FOUND' };
    const now = clock.now();
    const settings = this.store.get().settings || {};
    let when = publishAt && publishAt > now ? publishAt : now;
    // 「下一课间显示」策略：非管理员在上课期间发的留言推迟到下一次课间
    if (!urgent && actor && actor.role !== 'admin' && settings.announcementPolicy === 'next_window' && when <= now) {
      const status = this.windows.status(now);
      if (!status.open && status.next) when = status.next.startsAt;
    }
    const notice = {
      id: randomUUID(), classId: klass.id, type: 'announcement', source: actor && actor.role === 'admin' ? 'admin' : 'manual',
      priority: urgent ? PRIORITY.URGENT : PRIORITY.ANNOUNCEMENT,
      authorId: actor ? actor.id : null, authorName: actor ? actor.displayName : '系统', authorTitle: actor ? actor.title || '' : '',
      author: callerLabel(actor),
      title, body,
      createdAt: now, publishAt: when, publishedAt: null,
      expiresAt: durationSeconds > 0 ? when + durationSeconds * 1000 : null,
      durationSeconds, status: 'scheduled', deliveryCount: 0, scheduleId: null,
    };
    let pushed = null;
    if (when <= now) {
      pushed = this._push(runtime, klass, notice);
      if (!pushed.ok) return pushed;
      notice.status = 'published';
      notice.publishedAt = now;
      notice.deliveryCount = 1;
    }
    await this.store.update((db) => {
      db.notices.push(notice);
      this._trim(db);
      if (actor) audit(db, { actor, action: urgent ? 'notice.urgent' : 'notice.announce', target: klass.id, detail: { noticeId: notice.id, title, publishAt: when }, ip });
    });
    log('announcement', { classId: klass.id, noticeId: notice.id, urgent, scheduled: !pushed, ...this.classes.counts(klass.id) });
    return { ok: true, notice, event: pushed ? pushed.event : runtime.display.snapshot(), displayedNow: pushed ? pushed.displayedNow : false };
  }

  /** 调度器：把到点的定时留言推上大屏 */
  async publishDue(now = clock.now()) {
    const due = this.store.get().notices.filter((n) => n.status === 'scheduled' && n.publishAt <= now);
    if (!due.length) return 0;
    let published = 0;
    await this.store.update((db) => {
      for (const n of db.notices) {
        if (n.status !== 'scheduled' || n.publishAt > now) continue;
        const runtime = this.classes.get(n.classId);
        const klass = this.classes.klass(n.classId);
        if (!runtime || !klass) { n.status = 'withdrawn'; n.withdrawReason = 'CLASS_NOT_FOUND'; continue; }
        if (n.expiresAt && n.expiresAt <= now) { n.status = 'withdrawn'; n.withdrawReason = 'EXPIRED'; continue; }
        const pushed = this._push(runtime, klass, n);
        if (!pushed.ok) continue;      // 队列满：下次再试
        n.status = 'published';
        n.publishedAt = now;
        n.deliveryCount += 1;
        published += 1;
      }
    });
    return published;
  }

  /* ---------- 撤回 / 重发 / 清屏 ---------- */

  async withdraw({ klass, noticeId, actor, ip }) {
    const runtime = this.classes.get(klass.id);
    const notice = this.get(klass.id, noticeId);
    if (!runtime || !notice) return { ok: false, code: 'NOTICE_NOT_FOUND' };
    const result = runtime.display.remove(noticeId);
    await this.store.update((db) => {
      const n = db.notices.find((x) => x.id === noticeId);
      if (n) { n.status = 'withdrawn'; n.withdrawnAt = clock.now(); n.withdrawnBy = actor ? actor.id : null; }
      audit(db, { actor, action: 'notice.withdraw', target: klass.id, detail: { noticeId, displayCleared: result.displayCleared }, ip });
    });
    return { ok: true, ...result, event: runtime.display.snapshot() };
  }

  async resend({ klass, noticeId, actor, ip }) {
    const runtime = this.classes.get(klass.id);
    const notice = this.get(klass.id, noticeId);
    if (!runtime || !notice) return { ok: false, code: 'NOTICE_NOT_FOUND' };
    if (notice.type === 'call') {
      const missing = notice.names.find((name) => !klass.roster.has(name));
      if (missing) return { ok: false, code: 'UNKNOWN_STUDENT', detail: missing };
    }
    if (runtime.display.has(noticeId)) return { ok: true, notice, event: runtime.display.snapshot(), displayedNow: false, alreadyQueued: true };
    const fresh = { ...notice, expiresAt: notice.type === 'call' ? null : notice.expiresAt, priority: notice.type === 'call' ? PRIORITY.CALL : notice.priority };
    const pushed = this._push(runtime, klass, fresh);
    if (!pushed.ok) return pushed;
    await this.store.update((db) => {
      const n = db.notices.find((x) => x.id === noticeId);
      if (n) { n.deliveryCount += 1; n.lastDeliveredAt = clock.now(); n.status = 'published'; }
      audit(db, { actor, action: 'notice.resend', target: klass.id, detail: { noticeId }, ip });
    });
    log('student_notice_resend', { classId: klass.id, noticeId, ...this.classes.counts(klass.id) });
    return { ok: true, notice: this.get(klass.id, noticeId), event: pushed.event, displayedNow: pushed.displayedNow };
  }

  async clear({ klass, all, actor, ip }) {
    const runtime = this.classes.get(klass.id);
    if (!runtime) return { ok: false, code: 'CLASS_NOT_FOUND' };
    const event = runtime.display.clear({ all });
    await this.store.update((db) => audit(db, { actor, action: all ? 'display.clear_all' : 'display.clear', target: klass.id, ip }));
    log('display_clear', { classId: klass.id, all, ...this.classes.counts(klass.id) });
    return { ok: true, event };
  }

  /* ---------- 内部 ---------- */

  _push(runtime, klass, notice) {
    return runtime.display.push({
      noticeId: notice.id, type: notice.type, priority: notice.priority, source: notice.source,
      names: notice.names, message: notice.message, caller: notice.caller,
      title: notice.title, body: notice.body, author: notice.author,
      durationSeconds: notice.type === 'call' ? klass.autoClearSeconds : notice.durationSeconds,
      absoluteExpiresAt: notice.type === 'announcement' ? notice.expiresAt : null,
      launchFreshSeconds: klass.launcher.freshSeconds,
    });
  }

  _trim(db) {
    // 每班最多保留 HISTORY_LIMIT 条
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
