'use strict';

const { SSE_HEARTBEAT_MS, SSE_RETRY_MS } = require('./constants');
const { log } = require('./logger');

// 本机进程共享配额：跨班级、跨角色、跨 app 都不能绕过总量和来源上限。
const SSE_LIMITS = Object.freeze({
  maxTotal: 1024, maxPerSource: 64, maxClientsPerHub: 128, maxPerSourcePerHub: 16,
  maxBufferedBytes: 64 * 1024, maxFrameBytes: 64 * 1024, slowTimeoutMs: 30_000,
});

class SseConnectionLimits {
  constructor({ maxTotal = SSE_LIMITS.maxTotal, maxPerSource = SSE_LIMITS.maxPerSource } = {}) {
    this.maxTotal = maxTotal;
    this.maxPerSource = maxPerSource;
    this.total = 0;
    this.sources = new Map();
  }

  acquire(source) {
    const count = this.sources.get(source) || 0;
    if (this.total >= this.maxTotal || count >= this.maxPerSource) return null;
    this.total += 1;
    this.sources.set(source, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const remaining = this.sources.get(source) - 1;
      if (remaining) this.sources.set(source, remaining);
      else this.sources.delete(source);
    };
  }
}

const sharedLimits = new SseConnectionLimits();

/**
 * 一个班级的最新状态 SSE。慢消费者只保留一个最新快照，不积压旧快照/心跳。
 * write(false) 后等 drain；超出字节上限或持续阻塞则销毁连接，重连会重新同步状态。
 */
class SseHub {
  constructor({ classId = null, limiter = sharedLimits,
    maxClients = SSE_LIMITS.maxClientsPerHub, maxPerSource = SSE_LIMITS.maxPerSourcePerHub,
    maxBufferedBytes = SSE_LIMITS.maxBufferedBytes, maxFrameBytes = SSE_LIMITS.maxFrameBytes,
    slowTimeoutMs = SSE_LIMITS.slowTimeoutMs, heartbeatMs = SSE_HEARTBEAT_MS,
  } = {}) {
    this.classId = classId;
    this.limiter = limiter;
    this.maxClients = maxClients;
    this.maxPerSource = maxPerSource;
    this.maxBufferedBytes = maxBufferedBytes;
    this.maxFrameBytes = maxFrameBytes;
    this.slowTimeoutMs = slowTimeoutMs;
    this.idleTimeoutMs = heartbeatMs * 2 + slowTimeoutMs;
    this.clients = new Set();
    this.sources = new Map();
    this.nextId = 1;
    this.closed = false;
    this.heartbeat = setInterval(() => this._ping(), heartbeatMs);
    this.heartbeat.unref?.();
  }

  get size() { return this.count('display'); }
  get totalSize() { return this.clients.size; }

  count(role) {
    let total = 0;
    for (const client of this.clients) if (client.role === role) total += 1;
    return total;
  }

  /** source 由 app 已验证的 ctx.ip 提供；不在这里信任任意代理头。 */
  add(req, res, snapshot, role = 'display', source = req.socket?.remoteAddress || 'unknown') {
    source = String(source || 'unknown').slice(0, 64);
    const count = this.sources.get(source) || 0;
    const release = !this.closed && this.clients.size < this.maxClients && count < this.maxPerSource
      ? this.limiter.acquire(source) : null;
    if (!release) {
      res.writeHead(this.closed ? 503 : 429, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5',
      });
      res.end(JSON.stringify({ ok: false, error: this.closed ? 'SSE_CLOSED' : 'SSE_LIMIT' }));
      return null;
    }
    const client = {
      id: this.nextId++, req, res, source, release,
      role: role === 'launcher' || role === 'teacher' ? role : 'display',
      connectedAt: Date.now(), blocked: false, pending: null, slowTimer: null,
    };
    this.clients.add(client);
    this.sources.set(source, count + 1);
    client.onClose = () => this._drop(client, 'client_closed');
    client.onRequestError = () => this._drop(client, 'request_error');
    client.onResponseError = () => this._drop(client, 'response_error');
    client.onTimeout = () => this._drop(client, 'socket_timeout');
    client.onDrain = () => {
      if (!this.clients.has(client)) return;
      client.blocked = false;
      clearTimeout(client.slowTimer);
      client.slowTimer = null;
      const frame = client.pending;
      client.pending = null;
      if (frame) this._write(client, frame);
    };
    req.on('close', client.onClose);
    req.on('error', client.onRequestError);
    res.on('close', client.onClose);
    res.on('error', client.onResponseError);
    res.on('drain', client.onDrain);
    res.on('timeout', client.onTimeout);
    try {
      res.setTimeout?.(this.idleTimeoutMs);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      this._send(client, snapshot, `retry: ${SSE_RETRY_MS}\n\n`);
      if (this.clients.has(client)) this._logCount('sse_connect', client);
    } catch {
      this._drop(client, 'response_error');
    }
    return client;
  }

  broadcast(snapshot) {
    // 序列化一次，所有连接共享不可变字符串；每个慢连接最多保留一个引用。
    const frame = this._frame(snapshot);
    for (const client of this.clients) this._offer(client, frame);
  }

  _frame(payload, prefix = '') {
    return `${prefix}id: ${payload.id}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  _send(client, payload, prefix = '') {
    this._offer(client, this._frame(payload, prefix));
  }

  _offer(client, frame) {
    if (!this.clients.has(client)) return;
    if (Buffer.byteLength(frame) > this.maxFrameBytes) return this._drop(client, 'frame_limit');
    if ((client.res.writableLength || 0) > this.maxBufferedBytes) return this._drop(client, 'buffer_limit');
    if (client.blocked) client.pending = frame;
    else this._write(client, frame);
  }

  _write(client, frame) {
    if (!this.clients.has(client)) return;
    const res = client.res;
    if (res.destroyed || res.writableEnded) return this._drop(client, 'response_closed');
    if ((res.writableLength || 0) + Buffer.byteLength(frame) > this.maxBufferedBytes) {
      return this._drop(client, 'buffer_limit');
    }
    try {
      const ready = res.write(frame);
      if ((res.writableLength || 0) > this.maxBufferedBytes) return this._drop(client, 'buffer_limit');
      if (!ready) {
        client.blocked = true;
        client.slowTimer = setTimeout(() => this._drop(client, 'slow_consumer'), this.slowTimeoutMs);
        client.slowTimer.unref?.();
      }
    } catch { this._drop(client, 'write_error'); }
  }

  _ping() {
    for (const client of this.clients) {
      // 不让心跳占据 pending 快照，亦不写入已经阻塞的底层队列。
      if (!client.blocked) this._write(client, ': ping\n\n');
    }
  }

  _drop(client, reason, graceful = false) {
    if (!this.clients.delete(client)) return;
    clearTimeout(client.slowTimer);
    client.slowTimer = null;
    client.pending = null;
    client.req.removeListener('close', client.onClose);
    client.req.removeListener('error', client.onRequestError);
    client.res.removeListener('close', client.onClose);
    client.res.removeListener('error', client.onResponseError);
    client.res.removeListener('drain', client.onDrain);
    client.res.removeListener('timeout', client.onTimeout);
    const remaining = this.sources.get(client.source) - 1;
    if (remaining) this.sources.set(client.source, remaining);
    else this.sources.delete(client.source);
    client.release();
    // destroy() 丢弃积压，end() 不能及时释放慢连接的发送缓冲。
    try {
      if (graceful) client.res.end();
      else client.res.destroy();
    } catch {}
    this._logCount('sse_disconnect', client, reason);
  }

  _logCount(event, client, reason) {
    log(event, {
      classId: this.classId, client: client.id, role: client.role, reason,
      displays: this.count('display'), launchers: this.count('launcher'),
    });
  }

  closeAll(reason = 'server_shutdown') {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const client of this.clients) {
      if (!client.blocked) {
        this._write(client, `event: bye\ndata: ${JSON.stringify({ reason, classId: this.classId })}\n\n`);
      }
      this._drop(client, reason, !client.blocked);
    }
  }
}

module.exports = { SseHub, SseConnectionLimits, SSE_LIMITS };
