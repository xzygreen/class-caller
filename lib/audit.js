'use strict';

const clock = require('./clock');

const { randomUUID } = require('crypto');
const { AUDIT_LIMIT } = require('./constants');
const { log } = require('./logger');

/**
 * 操作审计：谁在何时对什么做了什么。只在一次 store.update 内部调用。
 * 同时也写一行结构化日志，journald 里能直接看到。
 */
function audit(db, { actor, action, target, detail, ip }) {
  const entry = {
    id: randomUUID(),
    at: clock.now(),
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.displayName : '系统',
    actorRole: actor ? actor.role : 'system',
    action,
    target: target || null,
    detail: detail || null,
    ip: ip || null,
  };
  db.auditLogs.push(entry);
  if (db.auditLogs.length > AUDIT_LIMIT) db.auditLogs.splice(0, db.auditLogs.length - AUDIT_LIMIT);
  log('audit', { action, actor: entry.actorName, target: entry.target, detail: entry.detail });
  return entry;
}

module.exports = { audit };
