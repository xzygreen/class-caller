'use strict';

const { CallWindows } = require('./timewin');

/** 当前事务中的账号、班级与名单；调用方不能把请求开始时的快照当作授权。 */
function classContext(db, classId, actor, authorize) {
  if (authorize) authorize(db);
  const user = actor && db.users.find((u) => u.id === actor.id);
  if (!user) return { ok: false, code: 'UNAUTHORIZED' };
  if (user.status !== 'active') return { ok: false, code: 'ACCOUNT_DISABLED' };
  if (user.mustChangePassword) return { ok: false, code: 'PASSWORD_CHANGE_REQUIRED' };
  const klass = db.classes.find((c) => c.id === classId && c.status === 'active');
  if (!klass) return { ok: false, code: 'CLASS_NOT_FOUND' };
  if (user.role !== 'admin' && !db.memberships.some((m) => m.userId === user.id && m.classId === classId && m.status === 'approved')) {
    return { ok: false, code: 'NO_CLASS_ACCESS' };
  }
  return { ok: true, actor: user, klass: { ...klass, roster: new Set(klass.students) }, windows: new CallWindows(db.callWindows) };
}

function announcementPolicy(db, actor, { urgent, publishAt }, now) {
  if (urgent && actor.role !== 'admin') return { ok: false, code: 'ADMIN_ONLY' };
  let when = publishAt && publishAt > now ? publishAt : now;
  if (!urgent && actor.role !== 'admin' && db.settings.announcementPolicy === 'next_window' && when <= now) {
    const status = new CallWindows(db.callWindows).status(now);
    if (!status.open) {
      if (!status.next) return { ok: false, code: 'NO_PUBLISH_WINDOW' };
      when = status.next.startsAt;
    }
  }
  return { ok: true, when };
}

module.exports = { classContext, announcementPolicy };
