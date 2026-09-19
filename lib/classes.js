'use strict';

const { LessonState } = require('./state');
const { SseHub } = require('./sse');
const { log } = require('./logger');

/**
 * 班级运行空间注册表。
 *
 * 每个班一份独立的：当前大屏通知、找人历史、自动清屏计时器、收到确认、大屏连接。
 * 配置重载后新增的班级会被创建，被移出的班级会被销毁（连接关闭、会话作废）；
 * 仍然存在的班级保留运行状态，不会因为改了名单就把正在显示的通知清掉。
 */
class ClassRegistry {
  constructor({ config, sessions }) {
    this.config = config;
    this.sessions = sessions;
    this.runtimes = new Map();   // classId -> { id, state, sse }
    this.sync();
  }

  get(classId) { return this.runtimes.get(classId); }

  ids() { return [...this.runtimes.keys()]; }

  /** 让运行空间集合与当前配置一致 */
  sync() {
    const wanted = new Set(this.config.get().classes.map((c) => c.id));

    for (const [id, runtime] of this.runtimes) {
      if (wanted.has(id)) continue;
      runtime.state.dispose();
      runtime.sse.closeAll('class_removed');
      const revoked = this.sessions ? this.sessions.revokeClass(id) : 0;
      this.runtimes.delete(id);
      log('class_removed', { classId: id, revokedSessions: revoked });
    }

    for (const id of wanted) {
      if (this.runtimes.has(id)) continue;
      const sse = new SseHub({ classId: id });
      const state = new LessonState({
        classId: id,
        onChange: (snapshot) => sse.broadcast(snapshot),
      });
      this.runtimes.set(id, { id, state, sse });
    }
  }

  counts(classId) {
    const runtime = this.runtimes.get(classId);
    if (!runtime) return { displays: 0, launchers: 0 };
    return {
      displays: runtime.sse.count('display'),
      launchers: runtime.sse.count('launcher'),
    };
  }

  totalCount(role) {
    let total = 0;
    for (const runtime of this.runtimes.values()) total += runtime.sse.count(role);
    return total;
  }

  dispose() {
    for (const runtime of this.runtimes.values()) {
      runtime.state.dispose();
      runtime.sse.closeAll('server_shutdown');
    }
    this.runtimes.clear();
  }
}

module.exports = { ClassRegistry };
