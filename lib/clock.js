'use strict';

/**
 * 进程内统一时钟。业务代码一律用 now() 取「当前时间」，
 * 测试通过 use() 注入可控时间，让作息、会话、定时任务的判断都可复现。
 */
let source = Date.now;

function now() { return source(); }
function use(fn) { source = typeof fn === 'function' ? fn : Date.now; }
function reset() { source = Date.now; }

module.exports = { now, use, reset };
