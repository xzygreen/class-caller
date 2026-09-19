'use strict';

const { SSE_HEARTBEAT_MS, SSE_RETRY_MS } = require('./constants');
const { log } = require('./logger');

/**
 * 一个班级的 SSE 连接池。
 * 负责：新连接立即同步当前状态、广播、心跳保活、断开清理、关服时优雅收尾。
 * 每个班各一个实例，因此一个班的广播在结构上就到不了另一个班的大屏。
 */
class SseHub {
  constructor({ classId = null } = {}) {
    this.classId = classId;
    this.clients = new Set();
    this.nextId = 1;
    this.heartbeat = setInterval(() => this._ping(), SSE_HEARTBEAT_MS);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  /** 兼容原接口：size 只统计真正的大屏，不把原生启动器算进去 */
  get size() { return this.count('display'); }
  get totalSize() { return this.clients.size; }

  count(role) {
    let total = 0;
    for (const client of this.clients) {
      if (client.role === role) total += 1;
    }
    return total;
  }

  /** 接入客户端并立刻推送当前状态（哪怕是 clear）。teacher 角色只用于实时刷新，不计入大屏数 */
  add(req, res, snapshot, role = 'display') {
    const clientRole = role === 'launcher' || role === 'teacher' ? role : 'display';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',     // 让 Nginx 不缓冲
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    const client = {
      id: this.nextId++, res, role: clientRole, connectedAt: Date.now(),
    };
    this.clients.add(client);
    this._send(client, snapshot);
    this._logCount('sse_connect', client);

    const drop = (reason) => {
      if (!this.clients.delete(client)) return;      // 只处理一次
      this._logCount('sse_disconnect', client, reason);
      try { res.end(); } catch {}
    };

    req.on('close', () => drop('client_closed'));
    req.on('error', () => drop('request_error'));
    res.on('error', () => drop('response_error'));
    return client;
  }

  broadcast(snapshot) {
    for (const client of this.clients) this._send(client, snapshot);
  }

  _send(client, payload) {
    try {
      client.res.write(`id: ${payload.id}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      this.clients.delete(client);
      try { client.res.end(); } catch {}
    }
  }

  _ping() {
    for (const client of this.clients) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        this.clients.delete(client);
        try { client.res.end(); } catch {}
      }
    }
  }

  _logCount(event, client, reason) {
    log(event, {
      classId: this.classId,
      client: client.id,
      role: client.role,
      reason,
      displays: this.count('display'),
      launchers: this.count('launcher'),
    });
  }

  /** 关服或班级被移除：告诉客户端这不是异常断线，然后逐个关闭 */
  closeAll(reason = 'server_shutdown') {
    clearInterval(this.heartbeat);
    for (const client of this.clients) {
      try {
        client.res.write(`event: bye\ndata: ${JSON.stringify({ reason, classId: this.classId })}\n\n`);
        client.res.end();
      } catch {}
    }
    this.clients.clear();
  }
}

module.exports = { SseHub };
