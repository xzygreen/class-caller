'use strict';

const { randomUUID } = require('crypto');
const clock = require('./clock');
const { CallWindows } = require('./timewin');
const { UUID_RE, validateCall } = require('./validate');
const { audit } = require('./audit');

const EXPIRES_MS = 30 * 60_000;
const HISTORY_LIMIT = 200;

function recipient(db, classId, teacherId) {
  return db.users.find((u) => u.id === teacherId && u.role === 'teacher' && u.status === 'active'
    && db.memberships.some((m) => m.userId === u.id && m.classId === classId && m.status === 'approved'));
}

function statusOf(db, call, now) {
  if (call.status !== 'pending') return call.status;
  if (call.expiresAt <= now) return 'expired';
  const klass = db.classes.find((c) => c.id === call.classId && c.status === 'active');
  if (!klass || !klass.students.includes(call.studentName) || !recipient(db, call.classId, call.teacherId)) return 'unavailable';
  return 'pending';
}

function view(db, call, now) {
  // requestId 是重试键，ip 仅用于服务端限速；都不发给浏览器。
  const { requestId, ip, ...safe } = call;
  return { ...safe, status: statusOf(db, call, now) };
}

class StudentCallService {
  constructor({ store }) { this.store = store; this.attempts = new Map(); }

  allowAttempt(ip) {
    const now = clock.now();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    let value = this.attempts.get(ip);
    if (!value) {
      if (this.attempts.size >= 2048) return false;
      value = { until: now + 60_000, count: 0 }; this.attempts.set(ip, value);
    }
    return ++value.count <= 30;
  }

  options(classId) {
    const db = this.store.get();
    return db.users.filter((u) => recipient(db, classId, u.id))
      .map((u) => ({ id: u.id, displayName: u.displayName, title: u.title }));
  }

  receipts(classId, ids) {
    const db = this.store.get(), now = clock.now();
    return db.studentCalls.filter((c) => c.classId === classId && ids.includes(c.id)).map((c) => view(db, c, now));
  }

  inbox(user) {
    const db = this.store.get(), now = clock.now();
    // 即使同班教师和管理员也不能代替收件教师查看或回复。
    const calls = db.studentCalls.filter((c) => c.teacherId === user.id && recipient(db, c.classId, user.id)
      && db.classes.some((k) => k.id === c.classId && k.status === 'active'));
    return calls.map((c) => view(db, c, now)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async create({ classId, input, ip }) {
    if (!this.allowAttempt(ip)) return { ok: false, code: 'STUDENT_CALL_RATE_LIMIT' };
    return this.store.update((db) => {
      const now = clock.now();
      const klass = db.classes.find((c) => c.id === classId && c.status === 'active');
      if (!klass) return { ok: false, code: 'CLASS_NOT_FOUND' };
      if (typeof input.requestId !== 'string' || !UUID_RE.test(input.requestId)) return { ok: false, code: 'INVALID_EVENT_ID' };
      const check = validateCall({ names: [input.studentName], message: input.message }, new Set(klass.students));
      if (!check.ok) return check;
      const teacher = recipient(db, classId, input.teacherId);
      if (!teacher) return { ok: false, code: 'TEACHER_UNAVAILABLE' };
      const old = db.studentCalls.find((c) => c.classId === classId && c.requestId === input.requestId);
      if (old) {
        if (old.studentName !== check.value.names[0] || old.teacherId !== teacher.id || old.message !== check.value.message) {
          return { ok: false, code: 'STUDENT_CALL_CONFLICT' };
        }
        return { ok: true, call: view(db, old, now), duplicate: true };
      }
      if (!new CallWindows(db.callWindows).status(now).open) return { ok: false, code: 'CALL_WINDOW_CLOSED' };
      const recent = db.studentCalls.filter((c) => c.createdAt > now - 60_000);
      if (recent.filter((c) => c.classId === classId).length >= 10 || recent.filter((c) => c.ip === ip).length >= 20
        || recent.some((c) => c.classId === classId && c.studentName === check.value.names[0])) {
        return { ok: false, code: 'STUDENT_CALL_RATE_LIMIT' };
      }
      const pending = db.studentCalls.filter((c) => c.classId === classId && statusOf(db, c, now) === 'pending');
      if (pending.some((c) => c.studentName === check.value.names[0] && c.teacherId === teacher.id)) {
        return { ok: false, code: 'STUDENT_CALL_PENDING' };
      }
      if (pending.length >= 20) return { ok: false, code: 'QUEUE_FULL' };
      const call = {
        id: randomUUID(), requestId: input.requestId, classId, className: klass.name,
        studentName: check.value.names[0], teacherId: teacher.id, teacherName: teacher.displayName,
        message: check.value.message, status: 'pending', createdAt: now, expiresAt: now + EXPIRES_MS,
        repliedAt: null, reply: '', ip,
      };
      db.studentCalls.push(call);
      // 每班最多 200 条；20 条待处理上限确保不会裁掉有效呼叫。
      const history = db.studentCalls.filter((c) => c.classId === classId && statusOf(db, c, now) !== 'pending');
      const remove = new Set(history.slice(0, Math.max(0, history.length + pending.length + 1 - HISTORY_LIMIT)).map((c) => c.id));
      db.studentCalls = db.studentCalls.filter((c) => !remove.has(c.id));
      audit(db, { actor: { id: null, displayName: '学生（大屏）', role: 'student' }, action: 'student_call.create', target: classId, detail: { callId: call.id, teacherId: teacher.id }, ip });
      return { ok: true, call: view(db, call, now) };
    });
  }

  async respond({ callId, reply, authorize, ip }) {
    if (typeof reply !== 'string' || !reply.trim() || reply.trim().length > 60 || /[\x00-\x09\x0b-\x1f\x7f]/.test(reply)) return { ok: false, code: 'INVALID_STUDENT_REPLY' };
    return this.store.update((db) => {
      const user = authorize(db), now = clock.now();
      const call = db.studentCalls.find((c) => c.id === callId && c.teacherId === user.id);
      if (!call) return { ok: false, code: 'STUDENT_CALL_NOT_FOUND' };
      if (!recipient(db, call.classId, user.id)) return { ok: false, code: 'NO_CLASS_ACCESS' };
      const status = statusOf(db, call, now);
      if (status === 'replied' && call.reply === reply.trim()) return { ok: true, call: view(db, call, now) };
      if (status !== 'pending') return { ok: false, code: 'STUDENT_CALL_CLOSED' };
      call.status = 'replied'; call.reply = reply.trim(); call.repliedAt = now;
      audit(db, { actor: user, action: 'student_call.reply', target: call.classId, detail: { callId }, ip });
      return { ok: true, call: view(db, call, now) };
    });
  }

  async cancel({ classId, callId, ip }) {
    return this.store.update((db) => {
      const now = clock.now();
      const call = db.studentCalls.find((c) => c.classId === classId && c.id === callId);
      if (!call) return { ok: false, code: 'STUDENT_CALL_NOT_FOUND' };
      if (call.status === 'cancelled') return { ok: true, call: view(db, call, now) };
      if (statusOf(db, call, now) !== 'pending') return { ok: false, code: 'STUDENT_CALL_CLOSED' };
      call.status = 'cancelled'; call.cancelledAt = now;
      audit(db, { actor: { id: null, displayName: '学生（大屏）', role: 'student' }, action: 'student_call.cancel', target: classId, detail: { callId }, ip });
      return { ok: true, call: view(db, call, now) };
    });
  }
}

module.exports = { StudentCallService, EXPIRES_MS, HISTORY_LIMIT };
