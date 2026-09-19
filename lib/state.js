'use strict';

const { randomUUID } = require('crypto');
const { HISTORY_LIMIT, DEFAULT_CALLER } = require('./constants');

// 事件 id 在整个进程内唯一且单调：不同班级绝不会产生相同的 id，
// 因此拿着甲班通知 id 去乙班「收到」必然是 ACK_STALE。
let globalSeq = Date.now();
const nextId = () => ++globalSeq;

/**
 * 一个班级的服务端找人通知状态：当前大屏展示与找人记录彼此独立。
 * 展示变化走 SSE；记录保存在内存中，服务重启或老师主动清空后归零。
 * 每个班各自一份实例；所有快照都带 classId，客户端据此拒收串班消息。
 */
class LessonState {
  constructor({ classId = null, onChange, historyLimit = HISTORY_LIMIT } = {}) {
    this.classId = classId;
    this.timer = null;
    this.onChange = onChange || (() => {});
    this.historyLimit = historyLimit;
    this.records = [];
    this.historyVersion = 0;
    this.droppedRecords = 0;
    this.current = this._makeClear();
  }

  _makeClear() {
    return {
      type: 'clear',
      classId: this.classId,
      id: nextId(),
      names: [],
      message: '',
      caller: '',
      createdAt: Date.now(),
      expiresAt: null,
      acks: [],
    };
  }

  _recordSnapshot(record) {
    return { ...record, names: [...record.names] };
  }

  /** 发给客户端的快照附带服务器时间，便于校正倒计时和启动有效期 */
  snapshot() {
    return {
      ...this.current,
      names: [...this.current.names],
      acks: this.current.acks.map((ack) => ({ ...ack })),
      serverTime: Date.now(),
    };
  }

  /**
   * 大屏「收到」确认：只对当前正在显示的这一条通知有效（按 id 匹配）。
   * names 为空表示所有显示中的姓名都确认。已确认过的姓名不会重复记录；
   * 有新增才广播，避免重复点击刷屏。
   */
  ack(eventId, names) {
    if (this.current.type !== 'call' || this.current.id !== eventId) {
      return { ok: false, code: 'ACK_STALE' };
    }
    const wanted = names.length ? names : this.current.names;
    const acked = new Set(this.current.acks.map((ack) => ack.name));
    const now = Date.now();
    let added = 0;
    for (const name of wanted) {
      if (acked.has(name) || !this.current.names.includes(name)) continue;
      this.current.acks.push({ name, at: now });
      acked.add(name);
      added += 1;
    }
    if (added > 0) this.onChange(this.snapshot(), 'ack');
    return {
      ok: true,
      added,
      allAcked: acked.size >= this.current.names.length,
      event: this.snapshot(),
    };
  }

  historySnapshot() {
    return {
      version: this.historyVersion,
      limit: this.historyLimit,
      droppedRecords: this.droppedRecords,
      records: this.records.map((record) => this._recordSnapshot(record)),
    };
  }

  get lastRecordId() {
    const last = this.records[this.records.length - 1];
    return last ? last.recordId : null;
  }

  getRecord(recordId) {
    const record = this.records.find((item) => item.recordId === recordId);
    return record ? this._recordSnapshot(record) : null;
  }

  call({ names, message, caller = DEFAULT_CALLER, autoClearSeconds, launchFreshSeconds }) {
    const record = {
      recordId: randomUUID(),
      names: [...names],
      message,
      caller,
      createdAt: Date.now(),
      deliveryCount: 0,
      lastDeliveredAt: null,
    };

    this.records.push(record);
    if (this.records.length > this.historyLimit) {
      this.records.shift();
      this.droppedRecords += 1;
    }
    this.historyVersion += 1;

    this._deliver(record, { autoClearSeconds, launchFreshSeconds }, 'call');
    return {
      record: this._recordSnapshot(record),
      event: this.snapshot(),
      historyVersion: this.historyVersion,
    };
  }

  resend(recordId, { autoClearSeconds, launchFreshSeconds }) {
    const record = this.records.find((item) => item.recordId === recordId);
    if (!record) return { ok: false, code: 'HISTORY_RECORD_NOT_FOUND' };

    this._deliver(record, { autoClearSeconds, launchFreshSeconds }, 'resend');
    this.historyVersion += 1;
    return {
      ok: true,
      record: this._recordSnapshot(record),
      event: this.snapshot(),
      historyVersion: this.historyVersion,
    };
  }

  undo(expectedRecordId) {
    const last = this.records[this.records.length - 1];
    if (!last) return { ok: false, code: 'EMPTY_HISTORY' };
    if (last.recordId !== expectedRecordId) {
      return { ok: false, code: 'HISTORY_CONFLICT' };
    }

    this.records.pop();
    this.historyVersion += 1;
    const displayCleared = this.current.type === 'call'
      && this.current.recordId === last.recordId;
    if (displayCleared) this.clear('undo');

    return {
      ok: true,
      removed: this._recordSnapshot(last),
      displayCleared,
      current: this.snapshot(),
      historyVersion: this.historyVersion,
    };
  }

  clearHistory(expectedVersion) {
    if (expectedVersion !== this.historyVersion) {
      return { ok: false, code: 'HISTORY_CONFLICT' };
    }
    if (this.records.length === 0) return { ok: false, code: 'EMPTY_HISTORY' };

    const removedCount = this.records.length;
    this.records = [];
    this.droppedRecords = 0;
    this.historyVersion += 1;
    return {
      ok: true,
      removedCount,
      current: this.snapshot(),
      historyVersion: this.historyVersion,
    };
  }

  clear(reason = 'clear') {
    this._cancelTimer();
    this.current = this._makeClear();
    this.onChange(this.snapshot(), reason);
    return this.current;
  }

  _deliver(record, { autoClearSeconds, launchFreshSeconds }, reason) {
    this._cancelTimer();
    const createdAt = Date.now();
    const deliveryId = randomUUID();
    const payload = {
      version: 1,
      classId: this.classId,
      deliveryId,
      recordId: record.recordId,
      issuedAt: createdAt,
      students: [...record.names],
      message: record.message,
    };

    record.deliveryCount += 1;
    record.lastDeliveredAt = createdAt;
    this.current = {
      type: 'call',
      classId: this.classId,
      id: nextId(),
      recordId: record.recordId,
      deliveryId,
      names: [...record.names],
      message: record.message,
      caller: record.caller,
      createdAt,
      expiresAt: autoClearSeconds > 0
        ? createdAt + autoClearSeconds * 1000
        : null,
      launchValidUntil: createdAt + launchFreshSeconds * 1000,
      launchPayload: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'),
      acks: [],
    };

    if (this.current.expiresAt) {
      const delay = this.current.expiresAt - Date.now();
      this.timer = setTimeout(() => {
        this.timer = null;
        this.current = this._makeClear();
        this.onChange(this.snapshot(), 'expire');
      }, Math.max(0, delay));
      if (this.timer.unref) this.timer.unref();
    }

    this.onChange(this.snapshot(), reason);
    return this.current;
  }

  _cancelTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  dispose() { this._cancelTimer(); }
}

module.exports = { LessonState, CallState: LessonState };
