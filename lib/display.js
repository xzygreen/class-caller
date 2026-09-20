'use strict';

const clock = require('./clock');

const { randomUUID } = require('crypto');
const { DEFAULT_CALLER, PRIORITY, MAX_QUEUE_LENGTH } = require('./constants');

// 事件 id 在整个进程内唯一且单调：不同班级绝不会产生相同的 id
let globalSeq = clock.now();
const nextId = () => ++globalSeq;

/**
 * 一个班级的大屏状态：当前内容 + 等待队列。
 *
 * 内容分两类：
 *   call         —— 点人：姓名、找人教师、说明、收到确认
 *   announcement —— 留言：标题、正文、发布人；没有「收到」流程
 *
 * 多条内容同时到达时按优先级排队（数字越小越优先）：
 *   1 管理员紧急通知 → 2 已到点的定时提醒 → 3 手动点人 → 4 普通留言
 * 优先级更高的新内容会抢占当前内容，被抢占的内容回到队列，稍后继续显示。
 * 持续显示（expiresAt=null）的留言作为「底色」：任何点人都能盖过它，点完后它自动回来。
 */
class DisplayQueue {
  constructor({ classId = null, onChange, now = clock.now } = {}) {
    this.classId = classId;
    this.onChange = onChange || (() => {});
    this.now = now;
    this.timer = null;
    this.queue = [];             // 等待显示的条目
    this.current = null;         // 正在显示的条目（null = 待机）
    this.clearId = nextId();
  }

  /* ---------- 快照 ---------- */

  _queueSummary() {
    return this.queue.map((item) => ({
      noticeId: item.noticeId, type: item.type, priority: item.priority,
      names: item.type === 'call' ? [...item.names] : undefined,
      title: item.type === 'announcement' ? item.title : undefined,
      author: item.author,
    }));
  }

  snapshot() {
    const now = this.now();
    if (!this.current) {
      return {
        type: 'clear', classId: this.classId, id: this.clearId,
        names: [], message: '', caller: '', createdAt: now, expiresAt: null, acks: [],
        queued: this.queue.length, serverTime: now,
      };
    }
    const c = this.current;
    const base = {
      type: c.type, classId: this.classId, id: c.eventId, noticeId: c.noticeId, priority: c.priority, source: c.source,
      createdAt: c.shownAt, expiresAt: c.expiresAt, serverTime: now, queued: this.queue.length,
      names: [], message: '', caller: '', acks: [],
    };
    if (c.type === 'call') {
      return {
        ...base,
        names: [...c.names], message: c.message, caller: c.caller,
        acks: c.acks.map((a) => ({ ...a })),
        deliveryId: c.deliveryId, launchValidUntil: c.launchValidUntil, launchPayload: c.launchPayload,
      };
    }
    return { ...base, title: c.title, body: c.body, author: c.author, caller: c.author };
  }

  /** 教师端用：当前 + 完整等待列表 */
  overview() {
    return { current: this.snapshot(), queue: this._queueSummary() };
  }

  /* ---------- 入队 ---------- */

  /**
   * 推送一条内容。返回 { ok, event, displayedNow }。
   * item: { noticeId, type, priority, source, names, message, caller, title, body, author,
   *         durationSeconds (0 = 持续显示), expiresAt (绝对时间，可选), launchFreshSeconds }
   */
  push(item) {
    if (this.queue.length >= MAX_QUEUE_LENGTH) return { ok: false, code: 'QUEUE_FULL' };
    const entry = {
      ...item,
      priority: item.priority || (item.type === 'call' ? PRIORITY.CALL : PRIORITY.ANNOUNCEMENT),
      enqueuedAt: this.now(),
      acks: [],
      remainingMs: null,
    };
    if (!this.current || entry.priority < this.current.priority) {
      if (this.current) this._preempt();
      this._show(entry, 'push');
      return { ok: true, event: this.snapshot(), displayedNow: true };
    }
    this._enqueue(entry);
    this.onChange(this.snapshot(), 'queue');
    return { ok: true, event: this.snapshot(), displayedNow: false };
  }

  _enqueue(entry) {
    // 稳定按优先级插入：同优先级先到先显示
    let index = this.queue.findIndex((q) => q.priority > entry.priority);
    if (index === -1) index = this.queue.length;
    this.queue.splice(index, 0, entry);
  }

  _preempt() {
    const cur = this.current;
    this._cancelTimer();
    if (cur.expiresAt) {
      cur.remainingMs = Math.max(1000, cur.expiresAt - this.now());
    }
    // 被抢占的内容回到队列前列（同优先级里排最前）
    let index = this.queue.findIndex((q) => q.priority >= cur.priority);
    if (index === -1) index = this.queue.length;
    this.queue.splice(index, 0, cur);
    this.current = null;
  }

  _show(entry, reason) {
    this._cancelTimer();
    const now = this.now();
    entry.eventId = nextId();
    entry.shownAt = now;
    if (entry.type === 'call') {
      entry.deliveryId = randomUUID();
      entry.launchValidUntil = now + (entry.launchFreshSeconds || 30) * 1000;
      entry.launchPayload = Buffer.from(JSON.stringify({
        version: 1, classId: this.classId, deliveryId: entry.deliveryId, recordId: entry.noticeId,
        issuedAt: now, students: [...entry.names], message: entry.message,
      }), 'utf8').toString('base64url');
      entry.acks = [];
    }
    if (entry.remainingMs) {
      entry.expiresAt = now + entry.remainingMs;
      entry.remainingMs = null;
    } else if (entry.absoluteExpiresAt) {
      entry.expiresAt = entry.absoluteExpiresAt;
    } else if (entry.durationSeconds > 0) {
      entry.expiresAt = now + entry.durationSeconds * 1000;
    } else {
      entry.expiresAt = null;
    }
    this.current = entry;
    if (entry.expiresAt) {
      const delay = Math.max(0, entry.expiresAt - now);
      this.timer = setTimeout(() => { this.timer = null; this._advance('expire'); }, delay);
      if (this.timer.unref) this.timer.unref();
    }
    this.onChange(this.snapshot(), reason);
  }

  /** 当前内容结束：显示队列里的下一条，或回到待机 */
  _advance(reason) {
    this._cancelTimer();
    const finished = this.current;
    this.current = null;
    // 已过期的排队内容直接跳过
    const now = this.now();
    while (this.queue.length) {
      const next = this.queue.shift();
      if (next.absoluteExpiresAt && next.absoluteExpiresAt <= now) continue;
      this._show(next, reason);
      return finished;
    }
    this.clearId = nextId();
    this.onChange(this.snapshot(), reason);
    return finished;
  }

  /* ---------- 操作 ---------- */

  /** 清空当前显示（不清队列时下一条会顶上来） */
  clear({ all = false } = {}) {
    if (all) this.queue = [];
    if (this.current) this._advance('clear');
    else if (all) this.onChange(this.snapshot(), 'clear');
    return this.snapshot();
  }

  /** 撤回某条通知：从大屏和队列里都移除 */
  remove(noticeId) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.noticeId !== noticeId);
    let displayCleared = false;
    if (this.current && this.current.noticeId === noticeId) {
      this._advance('withdraw');
      displayCleared = true;
    } else if (this.queue.length !== before) {
      this.onChange(this.snapshot(), 'withdraw');
    }
    return { displayCleared, dequeued: before - this.queue.length };
  }

  /**
   * 大屏「收到」确认：只对当前正在显示的点人有效（按事件 id 匹配）。
   */
  ack(eventId, names) {
    const c = this.current;
    if (!c || c.type !== 'call' || c.eventId !== eventId) return { ok: false, code: 'ACK_STALE' };
    const wanted = names.length ? names : c.names;
    const acked = new Set(c.acks.map((a) => a.name));
    const now = this.now();
    let added = 0;
    for (const name of wanted) {
      if (acked.has(name) || !c.names.includes(name)) continue;
      c.acks.push({ name, at: now });
      acked.add(name);
      added += 1;
    }
    if (added > 0) this.onChange(this.snapshot(), 'ack');
    return { ok: true, added, allAcked: acked.size >= c.names.length, event: this.snapshot() };
  }

  /** 队列里是否已经有这条通知（防重复入队） */
  has(noticeId) {
    return (this.current && this.current.noticeId === noticeId) || this.queue.some((q) => q.noticeId === noticeId);
  }

  _cancelTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  dispose() { this._cancelTimer(); }
}

module.exports = { DisplayQueue, DEFAULT_CALLER };
