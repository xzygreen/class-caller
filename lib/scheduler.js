'use strict';

const clock = require('./clock');

const { randomUUID } = require('crypto');
const { SCHEDULE_TICK_MS, SCHEDULE_GRACE_MS, SCHEDULE_RUN_RETENTION_DAYS, PRIORITY } = require('./constants');
const { zoned, zonedToMs, toMinutes, WEEKDAY_NAMES, CallWindows } = require('./timewin');
const { classContext } = require('./policy');
const { validateSchedule } = require('./validate');
const { audit } = require('./audit');
const { log } = require('./logger');

/**
 * 每日定时提醒调度器。
 *
 * schedule: { id, classId, createdBy, createdByName, names, time:'HH:MM', weekdays:[1..5], message,
 *             enabled, status:'active'|'paused', pauseReason, startDate, endDate,
 *             lastRunAt, lastRunDate, lastResult, createdAt, updatedAt }
 *
 *  - 以「任务 id + 日期」作为唯一执行标识（scheduleRuns），服务重启或重复扫描都不会一天发两次；
 *  - 到点 2 分钟内（SCHEDULE_GRACE_MS）可补发；超过就记「已错过」，绝不在上课途中补发；
 *  - 执行前重新校验：任务启用、班级存在、创建教师仍有该班权限、姓名仍在名单、当前处于允许点人时段；
 *  - 作息修改后不再合法的任务自动暂停并记录原因。
 */
class Scheduler {
  constructor({ store, classes, windows, notices, now = clock.now, tickMs = SCHEDULE_TICK_MS }) {
    this.store = store;
    this.classes = classes;
    this.windows = windows;
    this.notices = notices;
    this.now = now;
    this.tickMs = tickMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((err) => log('scheduler_error', { detail: String(err && err.stack || err) })); }, this.tickMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /* ---------- 查询 ---------- */

  list({ classId, userId } = {}) {
    let out = this.store.get().schedules;
    if (classId) out = out.filter((s) => s.classId === classId);
    if (userId) out = out.filter((s) => s.createdBy === userId);
    return out.map((s) => this.describe(s));
  }

  describe(s) {
    return { ...s, names: [...s.names], nextRunAt: this.nextRunAt(s), weekdayNames: s.weekdays.map((d) => WEEKDAY_NAMES[d]) };
  }

  /** 下一次应执行的绝对时间（考虑星期、日期范围），无则 null */
  nextRunAt(s, from = this.now()) {
    if (!s.enabled || s.status !== 'active') return null;
    const tz = this.windows.get().timezone;
    const min = toMinutes(s.time);
    const today = zoned(from, tz).date;
    // 开始日期可能在数周或数月后。直接只从今天扫描 8 天会错误地返回 null；
    // 从 startDate 当天开始扫描，仍只需覆盖完整的一周。
    const base = s.startDate && s.startDate > today
      ? zonedToMs(s.startDate, 0, tz)
      : from;
    for (let offset = 0; offset < 8; offset += 1) {
      const z = zoned(base + offset * 86_400_000, tz);
      if (!s.weekdays.includes(z.weekday)) continue;
      if (s.startDate && z.date < s.startDate) continue;
      if (s.endDate && z.date > s.endDate) return null;
      const at = zonedToMs(z.date, min, tz);
      if (at <= from) continue;
      return at;
    }
    return null;
  }

  /** 任务的时间是否落在允许点人的时段（所有执行星期都要合法） */
  fitsWindows(s, windows = this.windows) {
    return s.weekdays.every((d) => windows.containsTime(d, s.time));
  }

  /* ---------- 创建 / 修改 ---------- */

  create({ klass, actor, value, ip, authorize }) {
    return this.store.update((db) => {
      const context = classContext(db, klass.id, actor, authorize);
      if (!context.ok) return context;
      const check = validateSchedule(value, context.klass.roster);
      if (!check.ok) return check;
      value = check.value;
      if (!value.weekdays.every((d) => context.windows.containsTime(d, value.time))) return { ok: false, code: 'SCHEDULE_OUT_OF_WINDOW' };
      const now = this.now();
      const s = {
        id: randomUUID(), classId: klass.id, createdBy: context.actor.id, createdByName: context.actor.displayName,
        names: value.names, time: value.time, weekdays: value.weekdays, message: value.message,
        enabled: value.enabled, status: 'active', pauseReason: null,
        startDate: value.startDate, endDate: value.endDate,
        lastRunAt: null, lastRunDate: null, lastResult: null, createdAt: now, updatedAt: now,
      };
      db.schedules.push(s);
      audit(db, { actor: context.actor, action: 'schedule.create', target: klass.id, detail: { scheduleId: s.id, time: s.time, names: s.names }, ip });
      return { ok: true, schedule: this.describe(s) };
    });
  }

  update({ klass, actor, scheduleId, value, ip, authorize }) {
    return this.store.update((db) => {
      const context = classContext(db, klass.id, actor, authorize);
      if (!context.ok) return context;
      const s = db.schedules.find((x) => x.id === scheduleId && x.classId === klass.id);
      if (!s) return { ok: false, code: 'SCHEDULE_NOT_FOUND' };
      if (context.actor.role !== 'admin' && s.createdBy !== context.actor.id) return { ok: false, code: 'FORBIDDEN' };
      const check = validateSchedule({ ...s, ...value }, context.klass.roster);
      if (!check.ok) return check;
      if (!check.value.weekdays.every((d) => context.windows.containsTime(d, check.value.time))) return { ok: false, code: 'SCHEDULE_OUT_OF_WINDOW' };
      Object.assign(s, check.value, { updatedAt: this.now(), status: 'active', pauseReason: null });
      audit(db, { actor: context.actor, action: 'schedule.update', target: klass.id, detail: { scheduleId, changes: Object.keys(value) }, ip });
      return { ok: true, schedule: this.describe(s) };
    });
  }

  remove({ klass, actor, scheduleId, ip, authorize }) {
    return this.store.update((db) => {
      if (authorize) authorize(db);
      const user = db.users.find((u) => u.id === actor.id && u.status === 'active');
      if (!user) return { ok: false, code: 'UNAUTHORIZED' };
      const existing = db.schedules.find((s) => s.id === scheduleId && s.classId === klass.id);
      if (!existing) return { ok: false, code: 'SCHEDULE_NOT_FOUND' };
      if (user.role !== 'admin') {
        const context = classContext(db, klass.id, user);
        if (!context.ok) return context;
        if (existing.createdBy !== user.id) return { ok: false, code: 'FORBIDDEN' };
      }
      db.schedules = db.schedules.filter((s) => s.id !== scheduleId);
      audit(db, { actor: user, action: 'schedule.delete', target: klass.id, detail: { scheduleId }, ip });
      return { ok: true };
    });
  }

  /**
   * 作息或权限变化后重新审视全部任务：不再合法的暂停，并记下原因。
   * 在一次 store.update 内调用（db 由调用方传入）。返回被暂停的任务数。
   */
  reconcileInDb(db, { actor, reason, windows = new CallWindows(db.callWindows) } = {}) {
    let paused = 0;
    for (const s of db.schedules) {
      if (s.status !== 'active') continue;
      const why = this._invalidReason(db, s, windows);
      if (!why) continue;
      s.status = 'paused';
      s.pauseReason = why;
      s.updatedAt = this.now();
      paused += 1;
      audit(db, { actor, action: 'schedule.auto_pause', target: s.classId, detail: { scheduleId: s.id, reason: why, trigger: reason } });
    }
    return paused;
  }

  _invalidReason(db, s, windows = new CallWindows(db.callWindows)) {
    if (!this.fitsWindows(s, windows)) return 'CALL_WINDOW_CHANGED';
    const klass = db.classes.find((c) => c.id === s.classId && c.status === 'active');
    if (!klass) return 'CLASS_UNAVAILABLE';
    const user = db.users.find((u) => u.id === s.createdBy);
    if (!user || user.status !== 'active') return 'USER_DISABLED';
    if (user.role !== 'admin') {
      const member = db.memberships.find((m) => m.userId === s.createdBy && m.classId === s.classId && m.status === 'approved');
      if (!member) return 'ACCESS_REVOKED';
    }
    const missing = s.names.find((n) => !klass.students.includes(n));
    if (missing) return 'STUDENT_REMOVED';
    return null;
  }

  /* ---------- 执行 ---------- */

  async tick(now = this.now()) {
    if (this.running) return;
    this.running = true;
    try {
      await this.notices.publishDue(now);
      const tz = this.windows.get().timezone;
      const z = zoned(now, tz);
      const db = this.store.get();
      const runKeys = new Set(db.scheduleRuns.map((r) => `${r.scheduleId}|${r.date}`));
      for (const s of db.schedules) {
        if (!s.enabled || s.status !== 'active') continue;
        if (!s.weekdays.includes(z.weekday)) continue;
        if (s.startDate && z.date < s.startDate) continue;
        if (s.endDate && z.date > s.endDate) continue;
        const dueAt = zonedToMs(z.date, toMinutes(s.time), tz);
        if (dueAt > now) continue;
        if (runKeys.has(`${s.id}|${z.date}`)) continue;
        if (now - dueAt > SCHEDULE_GRACE_MS) {
          await this._record(s, z.date, 'missed', { dueAt, detail: '服务不在线，超过补偿窗口' });
          continue;
        }
        await this._fire(s, z.date, now, dueAt);
      }
      await this._pruneRuns(now);
    } finally {
      this.running = false;
    }
  }

  async _fire(snapshot, date, now, dueAt) {
    await this.store.update((db, tx) => {
      const s = db.schedules.find((item) => item.id === snapshot.id);
      if (!s || !s.enabled || s.status !== 'active') return;
      if (db.scheduleRuns.some((r) => r.scheduleId === s.id && r.date === date)) return;
      const windows = new CallWindows(db.callWindows);
      const currentDate = zoned(now, windows.get().timezone);
      const currentDueAt = zonedToMs(date, toMinutes(s.time), windows.get().timezone);
      if (currentDate.date !== date || !s.weekdays.includes(currentDate.weekday) || currentDueAt !== dueAt
          || (s.startDate && date < s.startDate) || (s.endDate && date > s.endDate)) return;
      let status = 'sent';
      let detail = this._invalidReason(db, s, windows);
      if (detail) {
        s.status = 'paused'; s.pauseReason = detail; s.updatedAt = now;
        audit(db, { actor: null, action: 'schedule.auto_pause', target: s.classId, detail: { scheduleId: s.id, reason: detail, trigger: 'run' } });
        status = 'skipped';
      } else if (!windows.isOpen(now)) {
        status = 'skipped'; detail = 'CALL_WINDOW_CLOSED';
      } else {
        const result = this.notices.callInDb(db, tx, {
          klass: { id: s.classId }, names: s.names, message: s.message,
          actor: db.users.find((u) => u.id === s.createdBy), source: 'schedule', priority: PRIORITY.SCHEDULED, scheduleId: s.id,
        });
        if (!result.ok) { status = 'failed'; detail = result.code; }
        else tx.afterCommit(() => log('schedule_fired', { scheduleId: s.id, classId: s.classId, date, noticeId: result.notice.id }));
      }
      this._recordInDb(db, s, date, status, { dueAt, detail });
    });
  }

  _recordInDb(db, s, date, status, { dueAt, detail } = {}) {
    if (db.scheduleRuns.some((r) => r.scheduleId === s.id && r.date === date)) return;
    const at = this.now();
    db.scheduleRuns.push({ scheduleId: s.id, date, status, at, dueAt, detail: detail || null });
    s.lastRunAt = at; s.lastRunDate = date; s.lastResult = { status, detail: detail || null };
  }

  async _record(s, date, status, { dueAt, detail } = {}) {
    await this.store.update((db, tx) => {
      const current = db.schedules.find((item) => item.id === s.id);
      if (!current || !current.enabled || current.status !== 'active' || current.time !== s.time) return;
      this._recordInDb(db, current, date, status, { dueAt, detail });
      if (status !== 'sent') tx.afterCommit(() => log('schedule_' + status, { scheduleId: s.id, classId: s.classId, date, detail }));
    });
  }

  async _pruneRuns(now) {
    const cutoff = now - SCHEDULE_RUN_RETENTION_DAYS * 86_400_000;
    const db = this.store.get();
    if (!db.scheduleRuns.some((r) => r.at < cutoff)) return;
    await this.store.update((d) => { d.scheduleRuns = d.scheduleRuns.filter((r) => r.at >= cutoff); });
  }

  runsFor(scheduleId, limit = 30) {
    return this.store.get().scheduleRuns.filter((r) => r.scheduleId === scheduleId).slice(-limit).reverse();
  }
}

module.exports = { Scheduler };
