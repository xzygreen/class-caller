'use strict';

/** 全局常量：所有魔法数字集中在这里 */
module.exports = {
  // --- 请求限制 ---
  MAX_BODY_BYTES: 16 * 1024,     // 单次请求体上限
  HEADERS_TIMEOUT_MS: 10_000,    // 请求头读取超时
  REQUEST_TIMEOUT_MS: 15_000,    // 整个请求超时
  KEEPALIVE_TIMEOUT_MS: 65_000,

  // --- 业务限制 ---
  MAX_NAMES_PER_CALL: 20,        // 单次最多通知人数
  MAX_NAME_LENGTH: 20,           // 单个姓名最大字数
  MAX_MESSAGE_LENGTH: 60,        // 附加通知最大字数
  CALLER_IDENTITIES: ['班主任', '语文老师', '数学老师', '英语老师', '物理老师', '化学老师', '历史老师'],
  DEFAULT_CALLER: '老师',        // 旧客户端未传 caller 时记录并显示的通用身份
  MAX_AUTO_CLEAR_SECONDS: 3600,
  HISTORY_LIMIT: 500,            // 每个班最多保留的找人记录数
  DEFAULT_LAUNCH_FRESH_SECONDS: 30,
  MIN_LAUNCH_FRESH_SECONDS: 5,
  MAX_LAUNCH_FRESH_SECONDS: 300,
  MAX_TEACHER_PASSWORD_LENGTH: 128,

  // --- 班级 ---
  CLASS_ID_RE: /^[a-z0-9][a-z0-9-]{0,31}$/,   // 内部固定标识：小写字母、数字、连字符
  MAX_CLASS_NAME_LENGTH: 32,
  MAX_CLASS_CODE_LENGTH: 4,
  CLASS_COLORS: ['blue', 'green', 'orange', 'purple', 'teal', 'red'],

  // --- 登录会话 ---
  SESSION_TTL_MS: 12 * 60 * 60 * 1000,   // 登录后 12 小时失效，跨天必须重新登录
  LOGIN_MAX_FAILURES: 5,                 // 同一来源对同一班级连续错 5 次
  LOGIN_LOCK_MS: 60_000,                 // 之后锁 60 秒
  LOGIN_FAILURE_WINDOW_MS: 10 * 60_000,  // 10 分钟内不再出错则计数清零

  // --- SSE ---
  SSE_HEARTBEAT_MS: 25_000,      // 心跳间隔，防中间代理掐断空闲连接
  SSE_RETRY_MS: 2_000,           // 告诉浏览器断线后多久重连

  // --- 鉴权 ---
  AUTH_HEADER: 'x-teacher-token',

  // --- 统一错误码 ---
  ERR: {
    INVALID_JSON: '请求格式不是合法的 JSON',
    BODY_TOO_LARGE: '请求内容过大',
    UNAUTHORIZED: '未登录或登录已失效，请重新登录',
    INVALID_PASSWORD: '密码错误',
    TOO_MANY_ATTEMPTS: '密码错误次数过多，请稍后再试',
    CLASS_NOT_FOUND: '班级不存在',
    CLASS_MISMATCH: '当前登录的不是这个班级',
    LEGACY_ENDPOINT: '系统已升级为多班级模式，请使用带班级的新链接',
    NOT_FOUND: '接口不存在',
    METHOD_NOT_ALLOWED: '不支持的请求方法',
    INVALID_NAMES: 'names 必须是数组',
    EMPTY_CALL: '请至少选择一名同学',
    EMPTY_NAME: '姓名不能为空',
    TOO_MANY_NAMES: '一次最多选择 20 人',
    NAME_TOO_LONG: '姓名过长',
    DUPLICATE_NAMES: '姓名重复',
    UNKNOWN_STUDENT: '该姓名不在本班名单中',
    INVALID_MESSAGE: '附加消息必须是文字',
    MESSAGE_TOO_LONG: '附加消息过长',
    INVALID_CALLER: '请选择有效的找人身份',
    INVALID_RECORD_ID: '记录编号格式有误',
    INVALID_HISTORY_VERSION: '记录版本格式有误',
    EMPTY_HISTORY: '还没有找人记录',
    HISTORY_CONFLICT: '找人记录已被其他页面更新，请刷新后重试',
    HISTORY_RECORD_NOT_FOUND: '找不到这条找人记录',
    INVALID_EVENT_ID: '通知编号格式有误',
    ACK_STALE: '该通知已不在大屏显示',
    ACK_UNKNOWN_NAME: '该姓名不在当前通知中',
    CONFIG_INVALID: '名单文件格式有误',
    INTERNAL: '服务器内部错误',
  },
};
