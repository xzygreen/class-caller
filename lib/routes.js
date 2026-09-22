'use strict';

const clock = require('./clock');

const { MAX_NAMES_PER_CALL, CLASS_ID_RE, SESSION_COOKIE, PRIORITY } = require('./constants');
const {
  sendOk, sendError, readJsonBody, serveStatic, sessionToken, sessionCookie, originAllowed,
} = require('./http');
const {
  validateCall, validateAnnouncement, validateSchedule, validateRegistration, validatePassword,
  validateReason, validateId, validateAck, UUID_RE,
} = require('./validate');
const { normalizeClass, normalizeStudents } = require('./config');
const { normalizeWindows, zoned } = require('./timewin');
const { audit } = require('./audit');
const { log } = require('./logger');

/**
 * 路由表。
 *
 *   /api/public/*                 —— 无需登录：班级列表、作息状态
 *   /api/classes/:id/public/*     —— 大屏用：配置、事件流、「收到」；绝不含完整名单
 *   /api/auth/*  /api/me/*        —— 个人账号
 *   /api/classes/:id/*            —— 教师：必须登录且拥有该班级已批准的权限（管理员天然拥有）
 *   /api/admin/*                  —— 管理员
 *
 * 每个请求都重新检查：会话有效 → 账号启用 → 角色 → 班级权限 → 作息 → 学生在册。
 */
function createRouter({ store, classes, sessions, users, notices, scheduler, windows, publicDir }) {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, pattern });
  };

  async function body(req, res) {
    const result = await readJsonBody(req, res);
    if (result.ok) return result.value;
    if (!result.handled) sendError(res, 400, result.code);
    return null;
  }

  const fail = (res, status, check) => sendError(res, status, check.code, check.detail ? { detail: check.detail } : {});

  /* ---------- 鉴权包装 ---------- */

  const authed = (handler, { allowPasswordChangeRequired = false } = {}) => async (req, res, ctx) => {
    const resolved = sessions.resolve(sessionToken(req));
    if (!resolved.user) {
      log('auth_failed', { path: ctx.pathname, ip: ctx.ip, reason: resolved.reason });
      res.setHeader('Set-Cookie', sessionCookie(req, '', null));
      return sendError(res, 401, resolved.reason === 'ACCOUNT_DISABLED' ? 'ACCOUNT_DISABLED' : 'UNAUTHORIZED');
    }
    if (resolved.user.mustChangePassword && !allowPasswordChangeRequired) {
      return sendError(res, 403, 'PASSWORD_CHANGE_REQUIRED');
    }
    ctx.user = resolved.user;
    ctx.session = resolved.session;
    return handler(req, res, ctx);
  };

  const admin = (handler) => authed(async (req, res, ctx) => {
    if (ctx.user.role !== 'admin') {
      log('admin_denied', { path: ctx.pathname, userId: ctx.user.id, ip: ctx.ip });
      return sendError(res, 403, 'ADMIN_ONLY');
    }
    return handler(req, res, ctx);
  });

  /** 班级作用域：路径里的班级必须存在、启用，且当前用户有权限 */
  const member = (handler) => authed(async (req, res, ctx) => {
    const classId = ctx.params.classId;
    if (!CLASS_ID_RE.test(classId)) return sendError(res, 404, 'CLASS_NOT_FOUND');
    const klass = classes.klass(classId);
    const runtime = classes.get(classId);
    if (!klass || !runtime) return sendError(res, 404, 'CLASS_NOT_FOUND');
    if (!users.canAccess(ctx.user, classId)) {
      log('class_denied', { classId, userId: ctx.user.id, path: ctx.pathname, ip: ctx.ip });
      return sendError(res, 403, 'NO_CLASS_ACCESS');
    }
    ctx.classId = classId;
    ctx.klass = klass;
    ctx.runtime = runtime;
    return handler(req, res, ctx);
  });

  /** 公开的班级作用域（大屏） */
  const publicClass = (handler) => (req, res, ctx) => {
    const classId = ctx.params.classId;
    if (!CLASS_ID_RE.test(classId)) return sendError(res, 404, 'CLASS_NOT_FOUND');
    const klass = classes.klass(classId);
    const runtime = classes.get(classId);
    if (!klass || !runtime) return sendError(res, 404, 'CLASS_NOT_FOUND');
    ctx.classId = classId;
    ctx.klass = klass;
    ctx.runtime = runtime;
    return handler(req, res, ctx);
  };

  const publicClassInfo = (c) => ({ classId: c.id, className: c.name, code: c.code, color: c.color });
  const classSummary = (c) => ({ id: c.id, name: c.name, code: c.code, color: c.color, status: c.status, autoClearSeconds: c.autoClearSeconds, launcher: c.launcher, studentCount: c.students.length });

  /* ======================= 公开 ======================= */

  add('GET', '/api/public/classes', (req, res) => {
    sendOk(res, { classes: store.get().classes.filter((c) => c.status === 'active').map((c) => ({ id: c.id, name: c.name, code: c.code, color: c.color })) });
  });

  add('GET', '/api/public/status', (req, res) => {
    sendOk(res, { callWindow: windows.status(), setupRequired: !users.hasAdmin(), serverTime: clock.now() });
  });

  add('GET', '/api/classes/:classId/public/config', publicClass((req, res, ctx) => {
    const c = ctx.klass;
    sendOk(res, {
      ...publicClassInfo(c),
      autoClearSeconds: c.autoClearSeconds,
      launcher: { mode: c.launcher.mode, freshSeconds: c.launcher.freshSeconds, protocol: 'classcaller' },
    });
  }));

  // 大屏事件流：只接受 display / launcher 角色；教师实时流走鉴权的 /stream
  add('GET', '/api/classes/:classId/public/stream', publicClass((req, res, ctx) => {
    const requested = ctx.searchParams.get('role');
    const role = requested === 'launcher' ? 'launcher' : 'display';
    ctx.runtime.sse.add(req, res, ctx.runtime.display.snapshot(), role);
  }));

  add('POST', '/api/classes/:classId/public/ack', publicClass(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const { display } = ctx.runtime;
    const check = validateAck(parsed, display.snapshot());
    if (!check.ok) return fail(res, 400, check);
    const result = display.ack(check.value.eventId, check.value.names);
    if (!result.ok) return sendError(res, 409, result.code);
    log('student_ack', { classId: ctx.classId, id: check.value.eventId, added: result.added, acked: result.event.acks.length, total: result.event.names.length });
    sendOk(res, { added: result.added, allAcked: result.allAcked, event: result.event });
  }));

  /* ======================= 账号 ======================= */

  add('POST', '/api/auth/register', async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    if (!sessions.registrationAllowed(ctx.ip)) return sendError(res, 429, 'TOO_MANY_ATTEMPTS');
    const check = validateRegistration(parsed);
    if (!check.ok) return fail(res, 400, check);
    const result = await users.register({ ...check.value, ip: ctx.ip });
    if (!result.ok) return sendError(res, 409, result.code);
    sessions.recordRegistration(ctx.ip);
    const session = await sessions.issue(result.user.id, ctx.ip);
    res.setHeader('Set-Cookie', sessionCookie(req, session.token, session.expiresAt));
    sendOk(res, { user: users.public(result.user), expiresAt: session.expiresAt });
  });

  add('POST', '/api/auth/login', async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const username = typeof parsed.username === 'string' ? parsed.username.trim().toLowerCase() : '';
    const password = typeof parsed.password === 'string' ? parsed.password : '';
    if (!username || !password) return sendError(res, 401, 'INVALID_CREDENTIALS');
    const locked = sessions.lockedFor(ctx.ip, username);
    if (locked > 0) {
      log('login_locked', { username, ip: ctx.ip, retryAfterMs: locked });
      res.setHeader('Retry-After', String(Math.ceil(locked / 1000)));
      return sendError(res, 429, 'TOO_MANY_ATTEMPTS', { retryAfterSeconds: Math.ceil(locked / 1000) });
    }
    const user = await users.authenticate(username, password);
    if (!user) {
      sessions.recordFailure(ctx.ip, username);
      log('login_failed', { username, ip: ctx.ip });
      return sendError(res, 401, 'INVALID_CREDENTIALS');
    }
    if (user.status !== 'active') {
      log('login_disabled', { userId: user.id, ip: ctx.ip });
      return sendError(res, 403, 'ACCOUNT_DISABLED');
    }
    sessions.clearFailures(ctx.ip, username);
    const session = await sessions.issue(user.id, ctx.ip);
    await users.touchLogin(user.id);
    res.setHeader('Set-Cookie', sessionCookie(req, session.token, session.expiresAt));
    log('login_ok', { userId: user.id, role: user.role, ip: ctx.ip });
    sendOk(res, { user: users.public(users.byId(user.id)), expiresAt: session.expiresAt });
  });

  add('POST', '/api/auth/logout', async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const token = sessionToken(req);
    if (token) await sessions.revoke(token);
    res.setHeader('Set-Cookie', sessionCookie(req, '', null));
    log('logout', { ip: ctx.ip });
    sendOk(res, {});
  });

  add('GET', '/api/me', authed((req, res, ctx) => {
    sendOk(res, { user: users.public(ctx.user), sessionExpiresAt: ctx.session.expiresAt, callWindow: windows.status() });
  }, { allowPasswordChangeRequired: true }));

  add('POST', '/api/me/password', authed(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const next = validatePassword(parsed.newPassword);
    if (!next.ok) return fail(res, 400, next);
    // 首次登录被要求改密码时不必再输旧密码（旧密码是管理员发的临时密码，已经验证过一次）
    if (!ctx.user.mustChangePassword) {
      const ok = await users.authenticate(ctx.user.username, typeof parsed.currentPassword === 'string' ? parsed.currentPassword : '');
      if (!ok) return sendError(res, 401, 'INVALID_PASSWORD');
    }
    await users.changePassword({ user: ctx.user, newPassword: next.value, ip: ctx.ip, keepSessionToken: ctx.session.token });
    sendOk(res, { user: users.public(users.byId(ctx.user.id)) });
  }, { allowPasswordChangeRequired: true }));

  add('GET', '/api/me/classes', authed((req, res, ctx) => {
    const mine = users.classesFor(ctx.user).map(classSummary);
    const requests = users.requestsFor(ctx.user).map((r) => ({ ...r, className: (store.get().classes.find((c) => c.id === r.classId) || {}).name || r.classId }));
    const all = store.get().classes.filter((c) => c.status === 'active').map((c) => ({ id: c.id, name: c.name, code: c.code, color: c.color }));
    const upcoming = scheduler.list({ userId: ctx.user.id }).filter((s) => s.nextRunAt).sort((a, b) => a.nextRunAt - b.nextRunAt).slice(0, 10);
    const paused = scheduler.list({ userId: ctx.user.id }).filter((s) => s.status === 'paused');
    sendOk(res, { classes: mine, requests, availableClasses: all, upcomingSchedules: upcoming, pausedSchedules: paused, callWindow: windows.status() });
  }));

  add('POST', '/api/me/class-requests', authed(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const classId = typeof parsed.classId === 'string' ? parsed.classId.trim() : '';
    if (!CLASS_ID_RE.test(classId)) return sendError(res, 404, 'CLASS_NOT_FOUND');
    const reason = validateReason(parsed.reason);
    if (!reason.ok) return fail(res, 400, reason);
    const result = await users.requestAccess({ user: ctx.user, classId, reason: reason.value, ip: ctx.ip });
    if (!result.ok) return sendError(res, result.code === 'CLASS_NOT_FOUND' ? 404 : 409, result.code);
    sendOk(res, { request: result.request });
  }));

  add('DELETE', '/api/me/class-requests/:requestId', authed(async (req, res, ctx) => {
    const id = validateId(ctx.params.requestId, 'REQUEST_NOT_FOUND');
    if (!id.ok) return fail(res, 404, id);
    const result = await users.cancelRequest({ user: ctx.user, requestId: id.value, ip: ctx.ip });
    if (!result.ok) return sendError(res, result.code === 'REQUEST_NOT_FOUND' ? 404 : 409, result.code);
    sendOk(res, {});
  }));

  /* ======================= 教师：班级工作台 ======================= */

  add('GET', '/api/classes/:classId/workspace', member((req, res, ctx) => {
    const c = ctx.klass;
    sendOk(res, {
      ...publicClassInfo(c),
      students: c.students,
      autoClearSeconds: c.autoClearSeconds,
      maxNamesPerCall: MAX_NAMES_PER_CALL,
      callWindow: windows.status(),
      display: ctx.runtime.display.overview(),
      ...classes.counts(ctx.classId),
      settings: { announcementPolicy: (store.get().settings || {}).announcementPolicy || 'immediate' },
      me: users.public(ctx.user),
      sessionExpiresAt: ctx.session.expiresAt,
    });
  }));

  add('GET', '/api/classes/:classId/call-window', member((req, res) => sendOk(res, { callWindow: windows.status() })));

  // 教师实时流：需要登录与班级权限；不计入大屏数
  add('GET', '/api/classes/:classId/stream', member((req, res, ctx) => {
    ctx.runtime.sse.add(req, res, ctx.runtime.display.snapshot(), 'teacher');
  }));

  add('GET', '/api/classes/:classId/status', member((req, res, ctx) => {
    sendOk(res, { classId: ctx.classId, ...classes.counts(ctx.classId), display: ctx.runtime.display.overview(), callWindow: windows.status() });
  }));

  add('POST', '/api/classes/:classId/calls', member(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const check = validateCall(parsed, ctx.klass.roster);
    if (!check.ok) {
      log('api_error', { classId: ctx.classId, path: ctx.pathname, error: check.code });
      return fail(res, 400, check);
    }
    const status = windows.status();
    if (!status.open) {
      log('call_window_closed', { classId: ctx.classId, userId: ctx.user.id });
      return sendError(res, 403, 'CALL_WINDOW_CLOSED', { callWindow: status });
    }
    const result = await notices.call({ klass: ctx.klass, names: check.value.names, message: check.value.message, actor: ctx.user, ip: ctx.ip });
    if (!result.ok) return sendError(res, result.code === 'QUEUE_FULL' ? 429 : 400, result.code);
    sendOk(res, { notice: result.notice, event: result.event, displayedNow: result.displayedNow, display: ctx.runtime.display.overview(), ...classes.counts(ctx.classId) });
  }));

  add('POST', '/api/classes/:classId/announcements', member(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const check = validateAnnouncement(parsed);
    if (!check.ok) return fail(res, 400, check);
    if (check.value.urgent && ctx.user.role !== 'admin') return sendError(res, 403, 'ADMIN_ONLY');
    const result = await notices.announce({ klass: ctx.klass, ...check.value, actor: ctx.user, ip: ctx.ip });
    if (!result.ok) return sendError(res, result.code === 'QUEUE_FULL' ? 429 : 400, result.code);
    sendOk(res, { notice: result.notice, event: result.event, displayedNow: result.displayedNow, display: ctx.runtime.display.overview(), ...classes.counts(ctx.classId) });
  }));

  add('GET', '/api/classes/:classId/notices', member((req, res, ctx) => {
    const q = ctx.searchParams;
    const list = notices.list(ctx.classId, {
      type: ['call', 'announcement'].includes(q.get('type')) ? q.get('type') : undefined,
      authorId: q.get('author') || undefined,
      date: /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : undefined,
    });
    sendOk(res, { classId: ctx.classId, notices: list });
  }));

  add('GET', '/api/classes/:classId/activity', member((req, res, ctx) => {
    const q = ctx.searchParams;
    const items = notices.list(ctx.classId, { limit: 300 }).map((n) => ({ kind: 'notice', at: n.publishedAt || n.createdAt, ...n }));
    const runs = store.get().scheduleRuns
      .filter((r) => store.get().schedules.some((s) => s.id === r.scheduleId && s.classId === ctx.classId) && r.status !== 'sent')
      .map((r) => ({ kind: 'schedule_run', at: r.at, ...r }));
    let all = [...items, ...runs].sort((a, b) => b.at - a.at);
    const type = q.get('type');
    if (type === 'call' || type === 'announcement') all = all.filter((x) => x.kind === 'notice' && x.type === type);
    if (type === 'schedule') all = all.filter((x) => x.kind === 'schedule_run' || x.source === 'schedule');
    if (q.get('author')) all = all.filter((x) => x.authorId === q.get('author'));
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '')) {
      const d = q.get('date');
      all = all.filter((x) => zoned(x.at, windows.get().timezone).date === d);
    }
    sendOk(res, { classId: ctx.classId, activity: all.slice(0, 300) });
  }));

  add('POST', '/api/classes/:classId/notices/:noticeId/resend', member(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const id = validateId(ctx.params.noticeId);
    if (!id.ok) return fail(res, 404, id);
    const notice = notices.get(ctx.classId, id.value);
    if (!notice) return sendError(res, 404, 'NOTICE_NOT_FOUND');
    if (notice.type === 'call' && !windows.isOpen()) return sendError(res, 403, 'CALL_WINDOW_CLOSED', { callWindow: windows.status() });
    const result = await notices.resend({ klass: ctx.klass, noticeId: id.value, actor: ctx.user, ip: ctx.ip });
    if (!result.ok) return sendError(res, result.code === 'NOTICE_NOT_FOUND' ? 404 : 400, result.code, result.detail ? { detail: result.detail } : {});
    sendOk(res, { notice: result.notice, event: result.event, displayedNow: result.displayedNow, alreadyQueued: Boolean(result.alreadyQueued), display: ctx.runtime.display.overview(), ...classes.counts(ctx.classId) });
  }));

  add('POST', '/api/classes/:classId/notices/:noticeId/withdraw', member(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const id = validateId(ctx.params.noticeId);
    if (!id.ok) return fail(res, 404, id);
    const result = await notices.withdraw({ klass: ctx.klass, noticeId: id.value, actor: ctx.user, ip: ctx.ip });
    if (!result.ok) return sendError(res, 404, result.code);
    sendOk(res, { displayCleared: result.displayCleared, event: result.event, display: ctx.runtime.display.overview() });
  }));

  add('POST', '/api/classes/:classId/display/clear', member(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const result = await notices.clear({ klass: ctx.klass, all: parsed.all === true, actor: ctx.user, ip: ctx.ip });
    sendOk(res, { event: result.event, display: ctx.runtime.display.overview(), ...classes.counts(ctx.classId) });
  }));

  /* ---------- 定时提醒 ---------- */

  const ownSchedule = (ctx, scheduleId) => {
    const s = store.get().schedules.find((x) => x.id === scheduleId && x.classId === ctx.classId);
    if (!s) return { code: 'SCHEDULE_NOT_FOUND', status: 404 };
    if (ctx.user.role !== 'admin' && s.createdBy !== ctx.user.id) return { code: 'FORBIDDEN', status: 403 };
    return { schedule: s };
  };

  add('GET', '/api/classes/:classId/schedules', member((req, res, ctx) => {
    sendOk(res, { classId: ctx.classId, schedules: scheduler.list({ classId: ctx.classId }).map((s) => ({ ...s, mine: s.createdBy === ctx.user.id })), callWindows: windows.get() });
  }));

  add('POST', '/api/classes/:classId/schedules', member(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const check = validateSchedule(parsed, ctx.klass.roster);
    if (!check.ok) return fail(res, 400, check);
    const result = await scheduler.create({ klass: ctx.klass, actor: ctx.user, value: check.value, ip: ctx.ip });
    if (!result.ok) return sendError(res, 400, result.code, { callWindows: windows.get() });
    sendOk(res, { schedule: result.schedule });
  }));

  add('GET', '/api/classes/:classId/schedules/:scheduleId/runs', member((req, res, ctx) => {
    const id = validateId(ctx.params.scheduleId, 'SCHEDULE_NOT_FOUND');
    if (!id.ok) return fail(res, 404, id);
    const own = ownSchedule(ctx, id.value);
    if (own.code) return sendError(res, own.status, own.code);
    sendOk(res, { runs: scheduler.runsFor(id.value) });
  }));

  add('PATCH', '/api/classes/:classId/schedules/:scheduleId', member(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const id = validateId(ctx.params.scheduleId, 'SCHEDULE_NOT_FOUND');
    if (!id.ok) return fail(res, 404, id);
    const own = ownSchedule(ctx, id.value);
    if (own.code) return sendError(res, own.status, own.code);
    // 用完整任务合并后再校验。否则只改 endDate / enabled 时，可能绕过
    // 日期范围或已被移出名单的学生校验，并错误恢复一条无效任务。
    const check = validateSchedule({ ...own.schedule, ...parsed }, ctx.klass.roster);
    if (!check.ok) return fail(res, 400, check);
    const result = await scheduler.update({ klass: ctx.klass, actor: ctx.user, scheduleId: id.value, value: check.value, ip: ctx.ip });
    if (!result.ok) return sendError(res, result.code === 'SCHEDULE_NOT_FOUND' ? 404 : 400, result.code, { callWindows: windows.get() });
    sendOk(res, { schedule: result.schedule });
  }));

  add('DELETE', '/api/classes/:classId/schedules/:scheduleId', member(async (req, res, ctx) => {
    const id = validateId(ctx.params.scheduleId, 'SCHEDULE_NOT_FOUND');
    if (!id.ok) return fail(res, 404, id);
    const own = ownSchedule(ctx, id.value);
    if (own.code) return sendError(res, own.status, own.code);
    const result = await scheduler.remove({ klass: ctx.klass, actor: ctx.user, scheduleId: id.value, ip: ctx.ip });
    if (!result.ok) return sendError(res, 404, result.code);
    sendOk(res, {});
  }));

  /* ======================= 管理员 ======================= */

  const userWithClasses = (u) => {
    const db = store.get();
    const memberships = db.memberships.filter((m) => m.userId === u.id && m.status === 'approved')
      .map((m) => ({ classId: m.classId, className: (db.classes.find((c) => c.id === m.classId) || {}).name || m.classId, grantedAt: m.grantedAt }));
    return { ...users.public(u), classes: memberships, sessions: sessions.count(u.id) };
  };
  const requestView = (r) => {
    const db = store.get();
    const u = db.users.find((x) => x.id === r.userId);
    const c = db.classes.find((x) => x.id === r.classId);
    const decider = r.decidedBy ? db.users.find((x) => x.id === r.decidedBy) : null;
    return { ...r, user: users.public(u), className: c ? c.name : r.classId, classCode: c ? c.code : '', decidedByName: decider ? decider.displayName : null };
  };

  add('GET', '/api/admin/overview', admin((req, res) => {
    const db = store.get();
    const pending = db.accessRequests.filter((r) => r.status === 'pending');
    const paused = db.schedules.filter((s) => s.status === 'paused');
    const displays = db.classes.filter((c) => c.status === 'active').map((c) => ({ classId: c.id, className: c.name, code: c.code, ...classes.counts(c.id), current: (classes.get(c.id) || { display: { snapshot: () => null } }).display.snapshot() }));
    sendOk(res, {
      pendingRequests: pending.map(requestView),
      pausedSchedules: paused.map((s) => scheduler.describe(s)),
      offlineDisplays: displays.filter((d) => d.displays === 0),
      displays,
      callWindow: windows.status(),
      counts: { users: db.users.length, teachers: db.users.filter((u) => u.role === 'teacher').length, classes: db.classes.filter((c) => c.status === 'active').length, schedules: db.schedules.length },
      setupRequired: !users.hasAdmin(),
    });
  }));

  add('GET', '/api/admin/requests', admin((req, res, ctx) => {
    const status = ctx.searchParams.get('status');
    let list = store.get().accessRequests;
    if (status) list = list.filter((r) => r.status === status);
    sendOk(res, { requests: list.slice(-200).reverse().map(requestView) });
  }));

  for (const [action, approve] of [['approve', true], ['reject', false]]) {
    add('POST', `/api/admin/requests/:requestId/${action}`, admin(async (req, res, ctx) => {
      const parsed = await body(req, res);
      if (!parsed) return;
      const id = validateId(ctx.params.requestId, 'REQUEST_NOT_FOUND');
      if (!id.ok) return fail(res, 404, id);
      const note = validateReason(parsed.note);
      if (!note.ok) return fail(res, 400, note);
      const result = await users.decideRequest({ admin: ctx.user, requestId: id.value, approve, note: note.value, ip: ctx.ip });
      if (!result.ok) return sendError(res, result.code === 'REQUEST_NOT_FOUND' ? 404 : 409, result.code);
      sendOk(res, { request: requestView(result.request) });
    }));
  }

  add('GET', '/api/admin/users', admin((req, res) => {
    sendOk(res, { users: store.get().users.map(userWithClasses) });
  }));

  add('POST', '/api/admin/users', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const check = validateRegistration(parsed);
    if (!check.ok) return fail(res, 400, check);
    const role = parsed.role === 'admin' ? 'admin' : 'teacher';
    const result = await users.createUser({ admin: ctx.user, value: check.value, role, ip: ctx.ip });
    if (!result.ok) return sendError(res, 409, result.code);
    sendOk(res, { user: userWithClasses(result.user) });
  }));

  add('PATCH', '/api/admin/users/:userId', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const id = validateId(ctx.params.userId, 'USER_NOT_FOUND');
    if (!id.ok) return fail(res, 404, id);
    const changes = {};
    if (parsed.displayName !== undefined || parsed.title !== undefined) {
      const target = users.byId(id.value);
      if (!target) return sendError(res, 404, 'USER_NOT_FOUND');
      const check = validateRegistration({ username: target.username, displayName: parsed.displayName ?? target.displayName, title: parsed.title ?? target.title }, { requirePassword: false });
      if (!check.ok) return fail(res, 400, check);
      if (parsed.displayName !== undefined) changes.displayName = check.value.displayName;
      if (parsed.title !== undefined) changes.title = check.value.title;
    }
    if (parsed.status !== undefined) {
      if (!['active', 'disabled'].includes(parsed.status)) return sendError(res, 400, 'INVALID_JSON');
      changes.status = parsed.status;
    }
    if (parsed.resetPassword === true) changes.resetPassword = true;
    const result = await users.updateUser({ admin: ctx.user, userId: id.value, changes, ip: ctx.ip });
    if (!result.ok) return sendError(res, result.code === 'USER_NOT_FOUND' ? 404 : 409, result.code);
    classes.sync();
    sendOk(res, { user: userWithClasses(result.user), tempPassword: result.tempPassword, pausedSchedules: result.pausedSchedules });
  }));

  add('DELETE', '/api/admin/users/:userId', admin(async (req, res, ctx) => {
    const id = validateId(ctx.params.userId, 'USER_NOT_FOUND');
    if (!id.ok) return fail(res, 404, id);
    if (id.value === ctx.user.id) return sendError(res, 409, 'SELF_DELETE');
    const result = await users.deleteUser({ admin: ctx.user, userId: id.value, ip: ctx.ip });
    if (!result.ok) return sendError(res, result.code === 'USER_NOT_FOUND' ? 404 : 409, result.code);
    classes.sync();
    sendOk(res, { deleted: result.user.id, removedSchedules: result.removedSchedules });
  }));

  add('POST', '/api/admin/memberships', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const uid = validateId(parsed.userId, 'USER_NOT_FOUND');
    if (!uid.ok) return fail(res, 404, uid);
    if (!CLASS_ID_RE.test(String(parsed.classId || ''))) return sendError(res, 404, 'CLASS_NOT_FOUND');
    const result = await users.grant({ admin: ctx.user, userId: uid.value, classId: parsed.classId, ip: ctx.ip });
    if (!result.ok) return sendError(res, 404, result.code);
    sendOk(res, { user: userWithClasses(users.byId(uid.value)) });
  }));

  add('POST', '/api/admin/memberships/revoke', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const uid = validateId(parsed.userId, 'USER_NOT_FOUND');
    if (!uid.ok) return fail(res, 404, uid);
    if (!CLASS_ID_RE.test(String(parsed.classId || ''))) return sendError(res, 404, 'CLASS_NOT_FOUND');
    const result = await users.revoke({ admin: ctx.user, userId: uid.value, classId: parsed.classId, ip: ctx.ip });
    if (!result.ok) return sendError(res, 404, result.code);
    sendOk(res, { user: userWithClasses(users.byId(uid.value)), pausedSchedules: result.pausedSchedules });
  }));

  add('POST', '/api/admin/sessions/revoke-all', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const count = await users.revokeAllSessions({ admin: ctx.user, ip: ctx.ip });
    res.setHeader('Set-Cookie', sessionCookie(req, '', null));
    sendOk(res, { revoked: count });
  }));

  /* ---------- 班级与学生 ---------- */

  add('GET', '/api/admin/classes', admin((req, res) => {
    const db = store.get();
    sendOk(res, {
      classes: db.classes.map((c) => {
        // counts() 里也有一个叫 teachers 的数字（教师端实时连接数），必须先展开，
        // 否则会覆盖下面的教师列表数组，管理端渲染班级列表时直接崩溃。
        const counts = classes.counts(c.id);
        return {
          ...classSummary(c), students: c.students, createdAt: c.createdAt, updatedAt: c.updatedAt,
          displays: counts.displays, launchers: counts.launchers, teacherConnections: counts.teachers,
          teachers: db.memberships.filter((m) => m.classId === c.id && m.status === 'approved')
            .map((m) => users.public(db.users.find((u) => u.id === m.userId))).filter(Boolean),
        };
      }),
    });
  }));

  add('POST', '/api/admin/classes', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    let value;
    try { value = normalizeClass({ ...parsed, students: parsed.students || [] }, store.get().classes.length, { requireStudents: false }); } catch (e) { return sendError(res, 400, 'INVALID_CLASS', { detail: e.message }); }
    if (store.get().classes.some((c) => c.id === value.id)) return sendError(res, 409, 'CLASS_ID_TAKEN');
    const now = clock.now();
    await store.update((db) => {
      db.classes.push({ ...value, createdAt: now, updatedAt: now });
      audit(db, { actor: ctx.user, action: 'class.create', target: value.id, detail: { name: value.name }, ip: ctx.ip });
    });
    classes.sync();
    sendOk(res, { class: classSummary(store.get().classes.find((c) => c.id === value.id)) });
  }));

  add('PATCH', '/api/admin/classes/:classId', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const existing = classes.klass(ctx.params.classId, { includeArchived: true });
    if (!existing) return sendError(res, 404, 'CLASS_NOT_FOUND');
    let value;
    try {
      value = normalizeClass({ ...existing, ...parsed, id: existing.id, students: existing.students }, null, { requireStudents: false });
    } catch (e) { return sendError(res, 400, 'INVALID_CLASS', { detail: e.message }); }
    let paused = 0;
    await store.update((db) => {
      const c = db.classes.find((x) => x.id === existing.id);
      Object.assign(c, { name: value.name, code: value.code, color: value.color, autoClearSeconds: value.autoClearSeconds, launcher: value.launcher, status: value.status, updatedAt: clock.now() });
      paused = scheduler.reconcileInDb(db, { actor: ctx.user, reason: 'class.update' });
      audit(db, { actor: ctx.user, action: 'class.update', target: c.id, detail: { fields: Object.keys(parsed) }, ip: ctx.ip });
    });
    classes.sync();
    sendOk(res, { class: classSummary(store.get().classes.find((c) => c.id === existing.id)), pausedSchedules: paused });
  }));

  add('PUT', '/api/admin/classes/:classId/students', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const existing = classes.klass(ctx.params.classId, { includeArchived: true });
    if (!existing) return sendError(res, 404, 'CLASS_NOT_FOUND');
    let students;
    try { students = normalizeStudents(parsed.students); } catch (e) { return sendError(res, 400, 'INVALID_CLASS', { detail: e.message }); }
    let paused = 0;
    await store.update((db) => {
      const c = db.classes.find((x) => x.id === existing.id);
      const added = students.filter((s) => !c.students.includes(s)).length;
      const removed = c.students.filter((s) => !students.includes(s)).length;
      c.students = students;
      c.updatedAt = clock.now();
      paused = scheduler.reconcileInDb(db, { actor: ctx.user, reason: 'students.update' });
      audit(db, { actor: ctx.user, action: 'class.students', target: c.id, detail: { count: students.length, added, removed }, ip: ctx.ip });
    });
    sendOk(res, { classId: existing.id, students, pausedSchedules: paused });
  }));

  /* ---------- 作息 ---------- */

  add('GET', '/api/admin/call-windows', admin((req, res) => sendOk(res, { callWindows: windows.get(), status: windows.status() })));

  add('PUT', '/api/admin/call-windows', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    let value;
    try { value = normalizeWindows(parsed); } catch (e) { return sendError(res, 400, 'INVALID_CALL_WINDOWS', { detail: e.message }); }
    let paused = 0;
    await store.update((db) => {
      db.callWindows = { ...value, updatedAt: clock.now(), updatedBy: ctx.user.id };
      windows.set(value);
      paused = scheduler.reconcileInDb(db, { actor: ctx.user, reason: 'call_windows.update' });
      audit(db, { actor: ctx.user, action: 'call_windows.update', detail: { windows: value.windows.length, weekdays: value.weekdays, pausedSchedules: paused }, ip: ctx.ip });
    });
    sendOk(res, { callWindows: windows.get(), status: windows.status(), pausedSchedules: paused });
  }));

  /* ---------- 定时任务（全校） ---------- */

  add('GET', '/api/admin/schedules', admin((req, res) => {
    const db = store.get();
    sendOk(res, { schedules: scheduler.list().map((s) => ({ ...s, className: (db.classes.find((c) => c.id === s.classId) || {}).name || s.classId })) });
  }));

  add('PATCH', '/api/admin/schedules/:scheduleId', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const id = validateId(ctx.params.scheduleId, 'SCHEDULE_NOT_FOUND');
    if (!id.ok) return fail(res, 404, id);
    const s = store.get().schedules.find((x) => x.id === id.value);
    if (!s) return sendError(res, 404, 'SCHEDULE_NOT_FOUND');
    const klass = classes.klass(s.classId, { includeArchived: true });
    const check = validateSchedule({ ...s, ...parsed }, klass ? klass.roster : new Set());
    if (!check.ok) return fail(res, 400, check);
    const result = await scheduler.update({ klass: { id: s.classId }, actor: ctx.user, scheduleId: id.value, value: check.value, ip: ctx.ip });
    if (!result.ok) return sendError(res, 400, result.code);
    sendOk(res, { schedule: result.schedule });
  }));

  add('DELETE', '/api/admin/schedules/:scheduleId', admin(async (req, res, ctx) => {
    const id = validateId(ctx.params.scheduleId, 'SCHEDULE_NOT_FOUND');
    if (!id.ok) return fail(res, 404, id);
    const s = store.get().schedules.find((x) => x.id === id.value);
    if (!s) return sendError(res, 404, 'SCHEDULE_NOT_FOUND');
    await scheduler.remove({ klass: { id: s.classId }, actor: ctx.user, scheduleId: id.value, ip: ctx.ip });
    sendOk(res, {});
  }));

  /* ---------- 大屏、审计、设置 ---------- */

  add('POST', '/api/admin/classes/:classId/display/clear', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    const klass = classes.klass(ctx.params.classId);
    if (!klass) return sendError(res, 404, 'CLASS_NOT_FOUND');
    const result = await notices.clear({ klass, all: parsed.all === true, actor: ctx.user, ip: ctx.ip });
    sendOk(res, { event: result.event });
  }));

  add('GET', '/api/admin/audit', admin((req, res, ctx) => {
    const limit = Math.min(1000, Math.max(1, Number(ctx.searchParams.get('limit')) || 200));
    const action = ctx.searchParams.get('action');
    let list = store.get().auditLogs;
    if (action) list = list.filter((a) => a.action.startsWith(action));
    sendOk(res, { audit: list.slice(-limit).reverse() });
  }));

  add('GET', '/api/admin/settings', admin((req, res) => sendOk(res, { settings: store.get().settings })));

  add('PATCH', '/api/admin/settings', admin(async (req, res, ctx) => {
    const parsed = await body(req, res);
    if (!parsed) return;
    if (parsed.announcementPolicy !== undefined && !['immediate', 'next_window'].includes(parsed.announcementPolicy)) return sendError(res, 400, 'INVALID_JSON');
    await store.update((db) => {
      if (parsed.announcementPolicy !== undefined) db.settings.announcementPolicy = parsed.announcementPolicy;
      audit(db, { actor: ctx.user, action: 'settings.update', detail: parsed, ip: ctx.ip });
    });
    sendOk(res, { settings: store.get().settings });
  }));

  /* ======================= 分发 ======================= */

  function methodNotAllowed(res, allow) {
    res.setHeader('Allow', allow.join(', '));
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', { allow: allow.join(', ') });
  }

  return async function handle(req, res, ctx) {
    const { pathname } = ctx;

    if (pathname.startsWith('/api/')) {
      // 旧接口：明确报 410
      if (/^\/api\/classes\/[^/]+\/teacher(\/|$)/.test(pathname) || pathname.startsWith('/api/teacher/')) {
        log('legacy_endpoint', { path: pathname, ip: ctx.ip });
        return sendError(res, 410, 'NOT_FOUND', { message: '旧的班级密码登录接口已移除，请使用个人账号登录' });
      }
      const allowed = [];
      for (const route of routes) {
        const m = route.re.exec(pathname);
        if (!m) continue;
        if (route.method !== req.method) { allowed.push(route.method); continue; }
        if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) {
          log('origin_rejected', { path: pathname, origin: req.headers.origin, ip: ctx.ip });
          return sendError(res, 403, 'ORIGIN_MISMATCH');
        }
        ctx.params = {};
        route.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
        return route.handler(req, res, ctx);
      }
      if (allowed.length) return methodNotAllowed(res, [...new Set(allowed)]);
      return sendError(res, 404, 'NOT_FOUND');
    }

    return serveStatic(req, res, pathname, publicDir);
  };
}

module.exports = { createRouter, PRIORITY, SESSION_COOKIE, UUID_RE };
