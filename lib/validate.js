'use strict';

const {
  MAX_NAMES_PER_CALL, MAX_NAME_LENGTH, MAX_MESSAGE_LENGTH, CALLER_IDENTITIES, DEFAULT_CALLER,
} = require('./constants');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 手动推送请求校验。
 * 返回 { ok:true, value } 或 { ok:false, code }，由调用方统一转成 400。
 */
function validateCall(body, config) {
  if (!Array.isArray(body.names)) {
    return { ok: false, code: 'INVALID_NAMES' };
  }
  const rawNames = body.names;

  if (rawNames.length > MAX_NAMES_PER_CALL) {
    return { ok: false, code: 'TOO_MANY_NAMES' };
  }

  const names = [];
  const seen = new Set();
  for (const item of rawNames) {
    if (typeof item !== 'string') return { ok: false, code: 'INVALID_NAMES' };
    const name = item.trim();
    if (!name) return { ok: false, code: 'EMPTY_NAME' };
    if (name.length > MAX_NAME_LENGTH) return { ok: false, code: 'NAME_TOO_LONG' };
    if (seen.has(name)) return { ok: false, code: 'DUPLICATE_NAMES' };
    // 只允许推送名单里真实存在的学生，不能借姓名字段往大屏投任意文字
    if (!config.roster.has(name)) {
      return { ok: false, code: 'UNKNOWN_STUDENT', detail: name };
    }
    seen.add(name);
    names.push(name);
  }

  if (body.message !== undefined && typeof body.message !== 'string') {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
  const message = String(body.message ?? '').trim();
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, code: 'MESSAGE_TOO_LONG' };
  }

  // 旧客户端不传身份：按通用的“老师”记录，不再默认冒充班主任
  const caller = body.caller === undefined ? DEFAULT_CALLER : body.caller;
  if (typeof caller !== 'string' || (caller !== DEFAULT_CALLER && !CALLER_IDENTITIES.includes(caller))) {
    return { ok: false, code: 'INVALID_CALLER' };
  }

  if (names.length === 0) {
    return { ok: false, code: 'EMPTY_CALL' };
  }

  return { ok: true, value: { names, message, caller } };
}

function validateRecordId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    return { ok: false, code: 'INVALID_RECORD_ID' };
  }
  return { ok: true, value };
}

function validateHistoryVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, code: 'INVALID_HISTORY_VERSION' };
  }
  return { ok: true, value };
}

/**
 * 大屏「收到」确认。只对照当前正在显示的姓名，绝不碰完整名单；
 * names 省略或为空数组表示当前显示的所有人都已收到。
 */
function validateAck(body, current) {
  if (!Number.isSafeInteger(body.eventId) || body.eventId <= 0) {
    return { ok: false, code: 'INVALID_EVENT_ID' };
  }
  if (body.names !== undefined && !Array.isArray(body.names)) {
    return { ok: false, code: 'INVALID_NAMES' };
  }
  const rawNames = body.names || [];
  if (rawNames.length > MAX_NAMES_PER_CALL) {
    return { ok: false, code: 'TOO_MANY_NAMES' };
  }
  const names = [];
  const seen = new Set();
  for (const item of rawNames) {
    if (typeof item !== 'string') return { ok: false, code: 'INVALID_NAMES' };
    const name = item.trim();
    if (!name) return { ok: false, code: 'EMPTY_NAME' };
    if (name.length > MAX_NAME_LENGTH) return { ok: false, code: 'NAME_TOO_LONG' };
    if (seen.has(name)) continue;
    if (!current || current.type !== 'call' || !current.names.includes(name)) {
      return { ok: false, code: 'ACK_UNKNOWN_NAME', detail: name };
    }
    seen.add(name);
    names.push(name);
  }
  return { ok: true, value: { eventId: body.eventId, names } };
}

module.exports = { validateCall, validateRecordId, validateHistoryVersion, validateAck };
