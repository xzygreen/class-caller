'use strict';

const { DisplayQueue } = require('./display');
const { SseHub } = require('./sse');
const { log } = require('./logger');

/**
 * 班级运行空间注册表：每个启用中的班级一份独立的大屏队列与 SSE 连接池。
 * 数据仓库里的班级变化后调用 sync()：新增的班级被创建，归档/删除的班级被销毁（连接关闭）。
 */
class ClassRegistry {
  constructor({ store }) {
    this.store = store;
    this.runtimes = new Map();   // classId -> { id, display, sse }
    this.sync();
  }

  get(classId) { return this.runtimes.get(classId); }

  ids() { return [...this.runtimes.keys()]; }

  /** 班级记录（含 roster Set），不存在或已归档返回 undefined */
  klass(classId, { includeArchived = false } = {}) {
    const c = this.store.get().classes.find((k) => k.id === classId);
    if (!c || (!includeArchived && c.status !== 'active')) return undefined;
    return { ...c, roster: new Set(c.students) };
  }

  sync() {
    const wanted = new Set(this.store.get().classes.filter((c) => c.status === 'active').map((c) => c.id));

    for (const [id, runtime] of this.runtimes) {
      if (wanted.has(id)) continue;
      runtime.display.dispose();
      runtime.sse.closeAll('class_removed');
      this.runtimes.delete(id);
      log('class_removed', { classId: id });
    }

    for (const id of wanted) {
      if (this.runtimes.has(id)) continue;
      const sse = new SseHub({ classId: id });
      const display = new DisplayQueue({ classId: id, onChange: (snapshot) => sse.broadcast(snapshot) });
      this.runtimes.set(id, { id, display, sse });
    }
  }

  counts(classId) {
    const runtime = this.runtimes.get(classId);
    if (!runtime) return { displays: 0, launchers: 0, teachers: 0 };
    return {
      displays: runtime.sse.count('display'),
      launchers: runtime.sse.count('launcher'),
      teachers: runtime.sse.count('teacher'),
    };
  }

  totalCount(role) {
    let total = 0;
    for (const runtime of this.runtimes.values()) total += runtime.sse.count(role);
    return total;
  }

  dispose() {
    for (const runtime of this.runtimes.values()) {
      runtime.display.dispose();
      runtime.sse.closeAll('server_shutdown');
    }
    this.runtimes.clear();
  }
}

module.exports = { ClassRegistry };
