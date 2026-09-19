'use strict';

const { AUTH_HEADER, MAX_NAMES_PER_CALL, CLASS_ID_RE } = require('./constants');
const { sendOk, sendError, readJsonBody, serveStatic } = require('./http');
const {
  validateCall, validateRecordId, validateHistoryVersion, validateAck,
} = require('./validate');
const { log } = require('./logger');

/**
 * 路由表（多班级）。
 *
 * /api/public/classes                      —— 班级列表（登录页选班用），只有 id/名称/编号/颜色
 * /api/classes/:id/public/*                —— 大屏用，无需鉴权，绝不含完整学生名单
 * /api/classes/:id/teacher/login           —— 选班 + 密码 → 发短期登录令牌
 * /api/classes/:id/teacher/*               —— 老师用，一律校验令牌且令牌必须属于这个班
 * /api/public/*、/api/teacher/*（旧路径）  —— 410：旧的无班级链接绝不能默认落到某个班
 *
 * 班级只以 URL 路径和登录会话为准，请求体里的 classId 一律不作依据。
 */
function createRouter({ config, classes, sessions, publicDir }) {

  /** 读取并校验 JSON 请求体；返回 null 表示已经回过错误响应了 */
  async function body(req, res) {
    const result = await readJsonBody(req, res);
    if (result.ok) return result.value;
    if (!result.handled) sendError(res, 400, result.code);
    return null;
  }

  function checkedRecordId(parsed, field = 'recordId') {
    return validateRecordId(parsed[field]);
  }

  /** 包一层：校验令牌属于本班 + 交给处理器 */
  const teacher = (handler) => async (req, res, ctx) => {
    const session = sessions.get(req.headers[AUTH_HEADER]);
    if (!session) {
      log('auth_failed', { classId: ctx.classId, path: ctx.pathname, ip: ctx.ip });
      return sendError(res, 401, 'UNAUTHORIZED');
    }
    if (session.classId !== ctx.classId) {
      log('auth_class_mismatch', {
        classId: ctx.classId, sessionClassId: session.classId, path: ctx.pathname, ip: ctx.ip,
      });
      return sendError(res, 403, 'CLASS_MISMATCH');
    }
    ctx.session = session;
    return handler(req, res, ctx);
  };

  const publicClassInfo = (c) => ({
    classId: c.id,
    className: c.name,
    code: c.code,
    color: c.color,
  });

  // ---------- 班级作用域内的路由；ctx.klass / ctx.runtime 已由 dispatcher 填好 ----------
  const classRoutes = {
    // ---------- 公开 ----------
    'public/config': {
      GET(req, res, ctx) {
        const c = ctx.klass;
        sendOk(res, {
          ...publicClassInfo(c),
          autoClearSeconds: c.autoClearSeconds,
          needPassword: true,
          launcher: {
            mode: c.launcher.mode,
            freshSeconds: c.launcher.freshSeconds,
            protocol: 'classcaller',
          },
        });
      },
    },

    'public/stream': {
      GET(req, res, ctx) {
        const requested = ctx.searchParams.get('role');
        const role = requested === 'launcher' || requested === 'teacher' ? requested : 'display';
        ctx.runtime.sse.add(req, res, ctx.runtime.state.snapshot(), role);
      },
    },

    // 大屏上的「收到」按钮。无需鉴权：只能对本班当前正在显示的姓名打勾，
    // 校验对象是当前通知里的姓名，而不是完整名单，因此不会泄露花名册。
    'public/ack': {
      async POST(req, res, ctx) {
        const parsed = await body(req, res);
        if (!parsed) return;
        const { state } = ctx.runtime;
        const check = validateAck(parsed, state.current);
        if (!check.ok) {
          return sendError(res, 400, check.code, check.detail ? { detail: check.detail } : {});
        }
        const result = state.ack(check.value.eventId, check.value.names);
        if (!result.ok) return sendError(res, 409, result.code);
        log('student_ack', {
          classId: ctx.classId,
          id: check.value.eventId,
          added: result.added,
          acked: result.event.acks.length,
          total: result.event.names.length,
        });
        sendOk(res, { added: result.added, allAcked: result.allAcked, event: result.event });
      },
    },

    // ---------- 登录 ----------
    'teacher/login': {
      async POST(req, res, ctx) {
        const parsed = await body(req, res);
        if (!parsed) return;
        const locked = sessions.lockedFor(ctx.ip, ctx.classId);
        if (locked > 0) {
          log('login_locked', { classId: ctx.classId, ip: ctx.ip, retryAfterMs: locked });
          res.setHeader('Retry-After', String(Math.ceil(locked / 1000)));
          return sendError(res, 429, 'TOO_MANY_ATTEMPTS', { retryAfterSeconds: Math.ceil(locked / 1000) });
        }
        if (!config.checkPassword(ctx.classId, parsed.password)) {
          sessions.recordFailure(ctx.ip, ctx.classId);
          log('login_failed', { classId: ctx.classId, ip: ctx.ip });
          return sendError(res, 401, 'INVALID_PASSWORD');
        }
        sessions.clearFailures(ctx.ip, ctx.classId);
        const issued = sessions.issue(ctx.classId);
        log('login_ok', { classId: ctx.classId, ip: ctx.ip, sessions: sessions.count(ctx.classId) });
        sendOk(res, { token: issued.token, expiresAt: issued.expiresAt, class: publicClassInfo(ctx.klass) });
      },
    },

    'teacher/logout': {
      POST: teacher(async (req, res, ctx) => {
        await body(req, res);
        sessions.revoke(ctx.session.token);
        log('logout', { classId: ctx.classId, ip: ctx.ip });
        sendOk(res, {});
      }),
    },

    // ---------- 老师 ----------
    'teacher/students': {
      GET: teacher((req, res, ctx) => {
        const c = ctx.klass;
        sendOk(res, {
          ...publicClassInfo(c),
          students: c.students,
          autoClearSeconds: c.autoClearSeconds,
          maxNamesPerCall: MAX_NAMES_PER_CALL,
          sessionExpiresAt: ctx.session.expiresAt,
        });
      }),
    },

    'teacher/status': {
      GET: teacher((req, res, ctx) => {
        const { state } = ctx.runtime;
        sendOk(res, {
          classId: ctx.classId,
          ...classes.counts(ctx.classId),
          current: state.snapshot(),
          historyVersion: state.historyVersion,
          lastRecordId: state.lastRecordId,
        });
      }),
    },

    'teacher/history': {
      GET: teacher((req, res, ctx) => sendOk(res, {
        classId: ctx.classId,
        ...ctx.runtime.state.historySnapshot(),
      })),
    },

    'teacher/call': {
      POST: teacher(async (req, res, ctx) => {
        const parsed = await body(req, res);
        if (!parsed) return;

        const c = ctx.klass;
        const check = validateCall(parsed, c);
        if (!check.ok) {
          log('api_error', { classId: ctx.classId, path: ctx.pathname, error: check.code });
          return sendError(res, 400, check.code,
            check.detail ? { detail: check.detail } : {});
        }

        const result = ctx.runtime.state.call({
          names: check.value.names,
          message: check.value.message,
          caller: check.value.caller,
          autoClearSeconds: c.autoClearSeconds,
          launchFreshSeconds: c.launcher.freshSeconds,
        });
        const counts = classes.counts(ctx.classId);
        log('student_notice', {
          classId: ctx.classId,
          recordId: result.record.recordId,
          deliveryId: result.event.deliveryId,
          count: result.record.names.length,
          caller: result.record.caller,
          hasMessage: Boolean(result.record.message),
          ...counts,
        });
        sendOk(res, { ...result, ...counts });
      }),
    },

    'teacher/clear': {
      POST: teacher(async (req, res, ctx) => {
        const parsed = await body(req, res);
        if (!parsed) return;
        const { state } = ctx.runtime;
        const event = state.clear();
        const counts = classes.counts(ctx.classId);
        log('display_clear', { classId: ctx.classId, id: event.id, ...counts });
        sendOk(res, { event: state.snapshot(), ...counts });
      }),
    },

    'teacher/history/undo': {
      POST: teacher(async (req, res, ctx) => {
        const parsed = await body(req, res);
        if (!parsed) return;
        const id = checkedRecordId(parsed, 'expectedRecordId');
        if (!id.ok) return sendError(res, 400, id.code);

        const result = ctx.runtime.state.undo(id.value);
        if (!result.ok) {
          const status = result.code === 'HISTORY_CONFLICT' ? 409 : 400;
          return sendError(res, status, result.code);
        }
        log('history_undo', {
          classId: ctx.classId,
          recordId: result.removed.recordId,
          displayCleared: result.displayCleared,
          historyVersion: result.historyVersion,
        });
        sendOk(res, result);
      }),
    },

    'teacher/history/clear': {
      POST: teacher(async (req, res, ctx) => {
        const parsed = await body(req, res);
        if (!parsed) return;
        const version = validateHistoryVersion(parsed.expectedVersion);
        if (!version.ok) return sendError(res, 400, version.code);

        const result = ctx.runtime.state.clearHistory(version.value);
        if (!result.ok) {
          const status = result.code === 'HISTORY_CONFLICT' ? 409 : 400;
          return sendError(res, status, result.code);
        }
        log('history_clear', {
          classId: ctx.classId,
          removedCount: result.removedCount,
          historyVersion: result.historyVersion,
        });
        sendOk(res, result);
      }),
    },

    'teacher/history/resend': {
      POST: teacher(async (req, res, ctx) => {
        const parsed = await body(req, res);
        if (!parsed) return;
        const id = checkedRecordId(parsed);
        if (!id.ok) return sendError(res, 400, id.code);

        const { state } = ctx.runtime;
        const record = state.getRecord(id.value);
        if (!record) return sendError(res, 404, 'HISTORY_RECORD_NOT_FOUND');
        const c = ctx.klass;
        const missing = record.names.find((name) => !c.roster.has(name));
        if (missing) return sendError(res, 400, 'UNKNOWN_STUDENT', { detail: missing });

        const result = state.resend(id.value, {
          autoClearSeconds: c.autoClearSeconds,
          launchFreshSeconds: c.launcher.freshSeconds,
        });
        if (!result.ok) return sendError(res, 404, result.code);

        const counts = classes.counts(ctx.classId);
        log('student_notice_resend', {
          classId: ctx.classId,
          recordId: result.record.recordId,
          deliveryId: result.event.deliveryId,
          deliveryCount: result.record.deliveryCount,
          ...counts,
        });
        sendOk(res, { ...result, ...counts });
      }),
    },

    // 配置文件是全校一份，重载会刷新所有班的名单；被移出的班级会被销毁，新班级会被创建
    'teacher/reload': {
      POST: teacher(async (req, res, ctx) => {
        const parsed = await body(req, res);
        if (!parsed) return;
        const result = config.reload();
        if (!result.ok) {
          log('api_error', { classId: ctx.classId, path: ctx.pathname, error: 'CONFIG_INVALID', detail: result.message });
          return sendError(res, 400, 'CONFIG_INVALID', { detail: result.message });
        }
        classes.sync();
        const mine = result.classes.find((item) => item.id === ctx.classId);
        log('config_reload', { classId: ctx.classId, classes: result.classes });
        sendOk(res, { count: mine ? mine.count : 0, classes: result.classes });
      }),
    },
  };

  function methodNotAllowed(res, entry) {
    const allow = Object.keys(entry).join(', ');
    res.setHeader('Allow', allow);
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', { allow });
  }

  return async function handle(req, res, ctx) {
    const { pathname } = ctx;

    if (pathname === '/api/public/classes') {
      if (req.method !== 'GET') return methodNotAllowed(res, { GET: true });
      return sendOk(res, { classes: config.listPublic() });
    }

    // /api/classes/:id/<rest>
    if (pathname.startsWith('/api/classes/')) {
      const rest = pathname.slice('/api/classes/'.length);
      const slash = rest.indexOf('/');
      const classId = slash === -1 ? rest : rest.slice(0, slash);
      const sub = slash === -1 ? '' : rest.slice(slash + 1);
      if (!CLASS_ID_RE.test(classId)) return sendError(res, 404, 'CLASS_NOT_FOUND');

      const entry = classRoutes[sub];
      if (!entry) return sendError(res, 404, 'NOT_FOUND');

      const klass = config.getClass(classId);
      const runtime = classes.get(classId);
      if (!klass || !runtime) return sendError(res, 404, 'CLASS_NOT_FOUND');

      const handler = entry[req.method];
      if (!handler) return methodNotAllowed(res, entry);
      ctx.classId = classId;
      ctx.klass = klass;
      ctx.runtime = runtime;
      return handler(req, res, ctx);
    }

    // 升级前的旧接口：明确报 410，让还没换链接的大屏/脚本一眼看出原因
    if (pathname.startsWith('/api/public/') || pathname.startsWith('/api/teacher/')) {
      log('legacy_endpoint', { path: pathname, ip: ctx.ip });
      return sendError(res, 410, 'LEGACY_ENDPOINT');
    }

    // 不存在的 API 一律 JSON 404，不要落到静态文件去
    if (pathname.startsWith('/api/')) {
      return sendError(res, 404, 'NOT_FOUND');
    }

    return serveStatic(req, res, pathname, publicDir);
  };
}

module.exports = { createRouter };
