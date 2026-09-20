'use strict';

const clock = require('./clock');

const { randomUUID } = require('crypto');
const { SCHEDULE_TICK_MS, SCHEDULE_GRACE_MS, SCHEDULE_RUN_RETENTION_DAYS, PRIORITY } = require('./constants');
const { zoned, zonedToMs, toMinutes, WEEKDAY_NAMES } = require('./timewin');
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
    for (let offset = 0; offset < 8; offset += 1) {
      const z = zoned(from + offset * 86_400_000, tz);
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
  fitsWindows(s) {
    return s.weekdays.every((d) => this.windows.containsTime(d, s.time));
  }

  /* ---------- 创建 / 修改 ---------- */

  async create({ klass, actor, value, ip }) {
    if (!value.weekdays.every((d) => this.windows.containsTime(d, value.time))) return { ok: false, code: 'SCHEDULE_OUT_OF_WINDOW' };
    const now = this.now();
    const s = {
      id: randomUUID(), classId: klass.id, createdBy: actor.id, createdByName: actor.displayName,
      names: value.names, time: value.time, weekdays: value.weekdays, message: value.message,
      enabled: value.enabled, status: 'active', pauseReason: null,
      startDate: value.startDate, endDate: value.endDate,
      lastRunAt: null, lastRunDate: null, lastResult: null, createdAt: now, updatedAt: now,
    };
    await this.store.update((db) => {
      db.schedules.push(s);
      audit(db, { actor, action: 'schedule.create', target: klass.id, detail: { scheduleId: s.id, time: s.time, names: s.names }, ip });
    });
    return { ok: true, schedule: this.describe(s) };
  }

  async update({ klass, actor, scheduleId, value, ip }) {
    const existing = this.store.get().schedules.find((s) => s.id === scheduleId && s.classId === klass.id);
    if (!existing) return { ok: false, code: 'SCHEDULE_NOT_FOUND' };
    const merged = { ...existing, ...value };
    if (!merged.weekdays.every((d) => this.windows.containsTime(d, merged.time))) return { ok: false, code: 'SCHEDULE_OUT_OF_WINDOW' };
    let result;
    await this.store.update((db) => {
      const s = db.schedules.find((x) => x.id === scheduleId);
      Object.assign(s, value, { updatedAt: this.now() });
      // 手动修改后恢复运行（暂停原因清除）；若明确 enabled=false 则保持禁用
      s.status = 'active';
      s.pauseReason = null;
      audit(db, { actor, action: 'schedule.update', target: klass.id, detail: { scheduleId, changes: Object.keys(value) }, ip });
      result = this.describe(s);
    });
    return { ok: true, schedule: result };
  }

  async remove({ klass, actor, scheduleId, ip }) {
    const existing = this.store.get().schedules.find((s) => s.id === scheduleId && s.classId === klass.id);
    if (!existing) return { ok: false, code: 'SCHEDULE_NOT_FOUND' };
    await this.store.update((db) => {
      db.schedules = db.schedules.filter((s) => s.id !== scheduleId);
      audit(db, { actor, action: 'schedule.delete', target: klass.id, detail: { scheduleId }, ip });
    });
    return { ok: true };
  }

  /**
   * 作息或权限变化后重新审视全部任务：不再合法的暂停，并记下原因。
   * 在一次 store.update 内调用（db 由调用方传入）。返回被暂停的任务数。
   */
  reconcileInDb(db, { actor, reason } = {}) {
    let paused = 0;
    for (const s of db.schedules) {
      if (s.status !== 'active') continue;
      const why = this._invalidReason(db, s);
      if (!why) continue;
      s.status = 'paused';
      s.pauseReason = why;
      s.updatedAt = this.now();
      paused += 1;
      audit(db, { actor, action: 'schedule.auto_pause', target: s.classId, detail: { scheduleId: s.id, reason: why, trigger: reason } });
    }
    return paused;
  }

  _invalidReason(db, s) {
    if (!this.fitsWindows(s)) return 'CALL_WINDOW_CHANGED';
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

  async _fire(s, date, now, dueAt) {
    const db = this.store.get();
    const why = this._invalidReason(db, s);
    if (why) {
      await this.store.update((d) => {
        const x = d.schedules.find((i) => i.id === s.id);
        if (x) { x.status = 'paused'; x.pauseReason = why; x.updatedAt = now; }
        audit(d, { actor: null, action: 'schedule.auto_pause', target: s.classId, detail: { scheduleId: s.id, reason: why, trigger: 'run' } });
      });
      await this._record(s, date, 'skipped', { dueAt, detail: why });
      return;
    }
    if (!this.windows.isOpen(now)) {
      await this._record(s, date, 'skipped', { dueAt, detail: 'CALL_WINDOW_CLOSED' });
      return;
    }
    const klass = this.classes.klass(s.classId);
    const user = db.users.find((u) => u.id === s.createdBy);
    // 先登记执行，再发送：即使发送过程中崩溃也不会重复
    await this._record(s, date, 'sent', { dueAt });
    const result = await this.notices.call({
      klass, names: s.names, message: s.message, actor: user, source: 'schedule', priority: PRIORITY.SCHEDULED, scheduleId: s.id,
    });
    if (!result.ok) {
      await this._record(s, date, 'failed', { dueAt, detail: result.code, replace: true });
      return;
    }
    log('schedule_fired', { scheduleId: s.id, classId: s.classId, date, noticeId: result.notice.id });
  }

  async _record(s, date, status, { dueAt, detail, replace = false } = {}) {
    const at = this.now();
    await this.store.update((db) => {
      if (replace) db.scheduleRuns = db.scheduleRuns.filter((r) => !(r.scheduleId === s.id && r.date === date));
      db.scheduleRuns.push({ scheduleId: s.id, date, status, at, dueAt, detail: detail || null });
      const x = db.schedules.find((i) => i.id === s.id);
      if (x) { x.lastRunAt = at; x.lastRunDate = date; x.lastResult = { status, detail: detail || null }; }
    });
    if (status !== 'sent') log('schedule_' + status, { scheduleId: s.id, classId: s.classId, date, detail });
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
