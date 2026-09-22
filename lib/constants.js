'use strict';

/** 全局常量：所有魔法数字集中在这里 */
module.exports = {
  // --- 请求限制 ---
  MAX_BODY_BYTES: 64 * 1024,     // 单次请求体上限（名单批量导入需要略大）
  HEADERS_TIMEOUT_MS: 10_000,    // 请求头读取超时
  REQUEST_TIMEOUT_MS: 15_000,    // 整个请求超时
  KEEPALIVE_TIMEOUT_MS: 65_000,

  // --- 业务限制 ---
  MAX_NAMES_PER_CALL: 20,        // 单次最多通知人数
  MAX_NAME_LENGTH: 20,           // 单个姓名最大字数
  MAX_MESSAGE_LENGTH: 60,        // 点人附加说明最大字数
  MAX_TITLE_LENGTH: 30,          // 留言标题
  MAX_BODY_LENGTH: 300,          // 留言正文
  MAX_REASON_LENGTH: 200,        // 申请说明 / 审批备注
  DEFAULT_CALLER: '老师',        // 没有职务时显示的通用身份
  MAX_AUTO_CLEAR_SECONDS: 3600,
  MAX_ANNOUNCEMENT_SECONDS: 7 * 24 * 3600,
  HISTORY_LIMIT: 500,            // 每个班保留的通知记录数
  MAX_QUEUE_LENGTH: 20,          // 每个班等待显示的队列上限
  DEFAULT_LAUNCH_FRESH_SECONDS: 30,
  MIN_LAUNCH_FRESH_SECONDS: 5,
  MAX_LAUNCH_FRESH_SECONDS: 300,
  MAX_STUDENTS_PER_CLASS: 200,

  // --- 账号 ---
  USERNAME_RE: /^[a-z0-9][a-z0-9._-]{2,31}$/i,
  MIN_PASSWORD_LENGTH: 8,
  MAX_PASSWORD_LENGTH: 128,
  MAX_DISPLAY_NAME_LENGTH: 20,
  MAX_TITLE_FIELD_LENGTH: 12,    // 职务，如「数学老师」「班主任」

  // --- 班级 ---
  CLASS_ID_RE: /^[a-z0-9][a-z0-9-]{0,31}$/,   // 内部固定标识：小写字母、数字、连字符
  MAX_CLASS_NAME_LENGTH: 32,
  MAX_CLASS_CODE_LENGTH: 4,
  CLASS_COLORS: ['blue', 'green', 'orange', 'purple', 'teal', 'red'],

  // --- 登录会话 ---
  SESSION_COOKIE: 'cc_session',
  SESSION_TTL_MS: 12 * 60 * 60 * 1000,   // 登录后 12 小时失效，跨天必须重新登录
  LOGIN_MAX_FAILURES: 5,                 // 同一来源对同一用户名连续错 5 次
  LOGIN_LOCK_MS: 60_000,                 // 之后锁 60 秒
  LOGIN_FAILURE_WINDOW_MS: 10 * 60_000,  // 10 分钟内不再出错则计数清零
  REGISTER_MAX_PER_HOUR: 10,             // 同一来源每小时最多注册次数

  // --- 作息与定时 ---
  TIMEZONE: 'Asia/Shanghai',
  SCHEDULE_TICK_MS: 15_000,              // 调度器扫描间隔
  SCHEDULE_GRACE_MS: 2 * 60_000,         // 重启补偿窗口：超过 2 分钟就记为「已错过」
  SCHEDULE_RUN_RETENTION_DAYS: 30,

  // --- 优先级（数字越小越先显示） ---
  PRIORITY: { URGENT: 1, SCHEDULED: 2, CALL: 3, ANNOUNCEMENT: 4 },

  // --- SSE ---
  SSE_HEARTBEAT_MS: 25_000,      // 心跳间隔，防中间代理掐断空闲连接
  SSE_RETRY_MS: 2_000,           // 告诉浏览器断线后多久重连

  // --- 审计 ---
  AUDIT_LIMIT: 5000,

  // --- 数据存储 ---
  DB_VERSION: 1,
  BACKUP_KEEP: 14,

  // --- 统一错误码 ---
  ERR: {
    INVALID_JSON: '请求格式不是合法的 JSON',
    BODY_TOO_LARGE: '请求内容过大',
    UNAUTHORIZED: '未登录或登录已失效，请重新登录',
    FORBIDDEN: '没有权限执行此操作',
    ADMIN_ONLY: '此操作仅限管理员',
    ACCOUNT_DISABLED: '账号已停用，请联系管理员',
    PASSWORD_CHANGE_REQUIRED: '请先修改初始密码',
    INVALID_CREDENTIALS: '用户名或密码错误',
    INVALID_PASSWORD: '密码错误',
    TOO_MANY_ATTEMPTS: '尝试次数过多，请稍后再试',
    ORIGIN_MISMATCH: '请求来源不被允许',
    INVALID_USERNAME: '登录名只能由 3–32 位字母、数字、点、下划线或连字符组成',
    USERNAME_TAKEN: '该登录名已被使用',
    WEAK_PASSWORD: '密码至少 8 位，最多 128 位',
    INVALID_DISPLAY_NAME: '姓名不能为空且不超过 20 字',
    INVALID_TITLE: '职务不超过 12 字',
    USER_NOT_FOUND: '用户不存在',
    LAST_ADMIN: '至少要保留一名启用的管理员',
    SELF_DELETE: '不能删除当前登录的账号',
    CLASS_NOT_FOUND: '班级不存在',
    CLASS_ARCHIVED: '班级已归档',
    CLASS_ID_TAKEN: '班级标识已存在',
    INVALID_CLASS: '班级信息有误',
    NO_CLASS_ACCESS: '你没有该班级的管理权限',
    REQUEST_NOT_FOUND: '申请不存在',
    REQUEST_ALREADY_DECIDED: '该申请已经处理过了',
    REQUEST_PENDING: '已有待审批的申请，请等待管理员处理',
    ALREADY_MEMBER: '你已经拥有该班级的权限',
    INVALID_REASON: '申请说明不超过 200 字',
    CALL_WINDOW_CLOSED: '当前正在上课，暂不能点人',
    INVALID_CALL_WINDOWS: '作息时间格式有误',
    NOT_FOUND: '接口不存在',
    METHOD_NOT_ALLOWED: '不支持的请求方法',
    INVALID_NAMES: 'names 必须是数组',
    EMPTY_CALL: '请至少选择一名同学',
    EMPTY_NAME: '姓名不能为空',
    TOO_MANY_NAMES: '一次最多选择 20 人',
    NAME_TOO_LONG: '姓名过长',
    DUPLICATE_NAMES: '姓名重复',
    UNKNOWN_STUDENT: '该姓名不在本班名单中',
    INVALID_MESSAGE: '附加说明必须是文字',
    MESSAGE_TOO_LONG: '附加说明过长',
    INVALID_ANNOUNCEMENT: '留言标题和正文不能为空',
    TITLE_TOO_LONG: '留言标题不超过 30 字',
    BODY_TOO_LONG: '留言正文不超过 300 字',
    INVALID_TIME: '时间格式应为 HH:MM',
    INVALID_DATE: '日期格式应为 YYYY-MM-DD',
    INVALID_WEEKDAYS: '执行星期无效',
    INVALID_SCHEDULE: '定时任务信息有误',
    SCHEDULE_OUT_OF_WINDOW: '该时间不在允许点人的时段内',
    SCHEDULE_NOT_FOUND: '定时任务不存在',
    NOTICE_NOT_FOUND: '找不到这条通知',
    QUEUE_FULL: '等待显示的内容过多，请稍后再试',
    INVALID_EVENT_ID: '通知编号格式有误',
    ACK_STALE: '该通知已不在大屏显示',
    ACK_UNKNOWN_NAME: '该姓名不在当前通知中',
    CONFIG_INVALID: '配置格式有误',
    STORE_ERROR: '数据保存失败，请稍后重试',
    INTERNAL: '服务器内部错误',
  },
};
