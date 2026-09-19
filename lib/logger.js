'use strict';

/**
 * 结构化日志：每行一条 JSON，直接交给 journald。
 * 只记录运营需要的字段，绝不记录密码等敏感数据。
 */

function localISO(d = new Date()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) +
    ':' + pad(d.getMinutes()) +
    ':' + pad(d.getSeconds()) +
    sign + pad(off / 60 | 0) + ':' + pad(off % 60);
}

let sink = (line) => process.stdout.write(line + '\n');

/** 测试时可以把输出接走 */
function setSink(fn) { sink = fn; }

function log(event, fields = {}) {
  let line;
  try {
    line = JSON.stringify({ time: localISO(), event, ...fields });
  } catch {
    line = JSON.stringify({ time: localISO(), event, error: 'unserializable' });
  }
  sink(line);
}

module.exports = { log, setSink, localISO };
