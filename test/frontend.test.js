'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, 'public', p), 'utf8');
const teacherHtml = read('teacher.html');
const teacherJs = read('teacher.js');
const adminHtml = read('admin.html');
const adminJs = read('admin.js');
const displayHtml = read('display.html');
const displayJs = read('display.js');
const nginx = fs.readFileSync(path.join(root, 'nginx.conf.example'), 'utf8');

test('教师端：个人账号登录 / 注册，不再有共享班级密码；令牌只在 HttpOnly Cookie 里', () => {
  const source = teacherHtml + '\n' + teacherJs;
  assert.ok(teacherHtml.includes('id="loginForm"') && teacherHtml.includes('id="registerForm"'));
  assert.ok(teacherHtml.includes('autocomplete="username"'));
  assert.ok(teacherJs.includes("'/api/auth/login'") && teacherJs.includes("'/api/auth/register'") && teacherJs.includes("'/api/auth/logout'"));
  assert.ok(teacherJs.includes("credentials: 'same-origin'"), '请求必须带 Cookie');
  assert.ok(!source.includes('X-Teacher-Token'), '不得再使用令牌请求头');
  assert.ok(!source.includes('localStorage') && !source.includes('sessionStorage'), '浏览器不得再保存令牌');
  assert.ok(!source.includes('teacher/login') && !source.includes('gateClass'), '不再先选班再输共享密码');
  assert.ok(!/['"]\/api\/classes\/[^'"]*\/teacher\//.test(teacherJs), '不得调用旧教师接口');
  assert.ok(!teacherHtml.includes('id="caller"'), '不再允许自选身份冒充他人');
  assert.ok(teacherJs.includes('function callerLabel()'), '发起人来自登录账号');
  assert.ok(teacherHtml.includes('id="passwordForm"'), '临时密码首次登录必须改密码');
  assert.ok(teacherHtml.includes('忘记密码'));
});

test('教师端：个人工作台（已授权班级、申请、被拒理由、即将执行的定时提醒）', () => {
  for (const id of ['myClasses', 'requestForm', 'myRequests', 'homeSchedules', 'homeWindow']) {
    assert.ok(teacherHtml.includes(`id="${id}"`), `缺少 #${id}`);
  }
  assert.ok(teacherJs.includes("'/api/me/classes'") && teacherJs.includes("'/api/me/class-requests'"));
  assert.ok(teacherJs.includes("'理由：' + r.note"), '被拒申请显示理由');
});

test('教师端：班级工作台四个标签（点人 / 班级留言 / 定时提醒 / 记录）', () => {
  for (const tab of ['call', 'announce', 'schedule', 'activity']) {
    assert.ok(teacherHtml.includes(`data-tab="${tab}"`) && teacherHtml.includes(`id="tab-${tab}"`), tab);
  }
  // 点人：作息、下一可用时间、搜索、说明、当前大屏与确认、等待队列
  assert.ok(teacherHtml.includes('id="windowNotice"') && teacherJs.includes('当前正在上课，暂不能点人') && teacherJs.includes('下次可用时间'));
  assert.ok(teacherHtml.includes('id="search"') && teacherHtml.includes('id="msg"') && teacherHtml.includes('id="queue"'));
  assert.ok(teacherJs.includes("cpath('calls')") && teacherJs.includes("cpath('stream')") && teacherJs.includes("cpath('display/clear')"));
  assert.ok(teacherJs.includes('CALL_WINDOW_CLOSED'));
  assert.ok(teacherHtml.includes('未收到') || teacherJs.includes('未收到'));
  assert.ok(teacherJs.includes('已收到'));
  // 留言：标题、正文、立即/定时、自动下屏、预览；无学生选择
  assert.ok(teacherHtml.includes('id="annTitle"') && teacherHtml.includes('id="annBody"') && teacherHtml.includes('id="annWhen"') && teacherHtml.includes('id="annDuration"') && teacherHtml.includes('id="annPreview"'));
  assert.ok(teacherJs.includes("cpath('announcements')"));
  // 定时：列表、启用/暂停、最近结果、暂停原因
  assert.ok(teacherHtml.includes('id="scheduleForm"') && teacherHtml.includes('id="schList"'));
  assert.ok(teacherJs.includes("cpath('schedules')") && teacherJs.includes('PAUSE_REASONS') && teacherJs.includes('CALL_WINDOW_CHANGED'));
  // 记录：统一时间线 + 筛选
  assert.ok(teacherHtml.includes('id="actType"') && teacherHtml.includes('id="actAuthor"') && teacherHtml.includes('id="actDate"'));
  assert.ok(teacherJs.includes("cpath('activity'"));
  assert.ok(teacherJs.includes('ev.classId !== classId'), '串班快照必须拒收');
  assert.ok(teacherJs.includes('res.json.classId !== classId'), '串班响应必须拒收');
});

test('管理端：独立页面，覆盖概览、审批、班级、教师、作息、定时、大屏、审计、设置', () => {
  for (const v of ['overview', 'requests', 'classes', 'users', 'windows', 'schedules', 'displays', 'audit', 'settings']) {
    assert.ok(adminHtml.includes(`data-view="${v}"`) && adminHtml.includes(`id="view-${v}"`), v);
  }
  for (const p of ['/api/admin/overview', '/api/admin/requests', '/api/admin/users', '/api/admin/classes', '/api/admin/call-windows', '/api/admin/schedules', '/api/admin/audit', '/api/admin/settings', '/api/admin/memberships']) {
    assert.ok(adminJs.includes(p), `管理端缺少 ${p}`);
  }
  assert.ok(adminJs.includes('/approve') && adminJs.includes('/reject'));
  assert.ok(adminJs.includes('resetPassword: true') && adminJs.includes('tempPassword'), '重置密码只显示一次临时密码');
  assert.ok(adminJs.includes("role !== 'admin'"), '非管理员不能进入管理端');
  assert.ok(adminHtml.includes('setupPanel') && adminJs.includes('setupRequired'), '未初始化时给出初始化指引，不提供默认密码');
  assert.ok(!adminHtml.includes('admin123') && !adminJs.includes('admin123'));
  assert.ok(adminJs.includes('待审批申请') && adminJs.includes('暂停的定时任务') && adminJs.includes('离线的大屏'), '首页优先展示待处理事项');
  assert.ok(adminJs.includes("credentials: 'same-origin'"));
});

test('浏览器大屏：点人与留言两种版式；留言没有「收到」按钮；显示等待队列提示', () => {
  assert.ok(displayHtml.includes('id="notice"') && displayHtml.includes('id="noticeTitle"') && displayHtml.includes('id="noticeBody"') && displayHtml.includes('id="noticeAuthor"'));
  assert.ok(displayJs.includes('function renderAnnouncement('));
  assert.ok(displayJs.includes("ev.type === 'announcement'"));
  assert.ok(displayJs.includes("currentEvent = ev.type === 'call' ? ev : null"), '留言不参与「收到」流程');
  assert.ok(displayHtml.includes('id="queueHint"') && displayJs.includes('等待显示'));
  assert.ok(displayJs.includes('shownEventId'), '留言到期也要本地清屏');
  // 原有点人能力保留
  assert.ok(displayJs.includes("classPath('public/stream?role=display')"));
  assert.ok(displayJs.includes("fetch(classPath('public/ack')"));
  assert.ok(displayJs.includes("(ev.caller || '老师') + '正在找'"));
  assert.ok(displayJs.includes("QUERY.get('class')") && displayJs.includes('班级绑定错误'));
  assert.ok(displayJs.includes('ev.classId !== classId'));
  assert.ok(!displayJs.includes('teacher/'), '大屏脚本不得访问老师接口');
  assert.ok(!displayJs.includes('role=teacher'));
  assert.ok(displayJs.includes('cf-mitigated') && displayJs.includes('www-authenticate'), '应明确诊断 Cloudflare / Basic Auth 网关拦截');
  assert.ok(displayJs.includes('setTimeout(loadRemoteConfig') && displayJs.includes('自动重试'), '配置请求失败后应自动恢复');
});

test('教师端和管理端能区分应用登录失效与网关拦截', () => {
  for (const source of [teacherJs, adminJs]) {
    assert.ok(source.includes('cf-mitigated'));
    assert.ok(source.includes('www-authenticate'));
    assert.ok(source.includes('gatewayError'));
  }
  assert.ok(teacherJs.includes("['UNAUTHORIZED', 'ACCOUNT_DISABLED'].includes(json.error)"));
  assert.ok(adminJs.includes("['UNAUTHORIZED', 'ACCOUNT_DISABLED'].includes(json.error)"));
});

test('页面脚本使用本地静态文件，不依赖第三方资源', () => {
  for (const html of [teacherHtml, adminHtml, displayHtml]) {
    assert.ok(!/<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i.test(html));
  }
  assert.ok(teacherHtml.includes('<script src="teacher.js"></script>'));
  assert.ok(adminHtml.includes('<script src="admin.js"></script>'));
  assert.ok(displayHtml.includes('<script src="display.js"></script>'));
});

test('反向代理显式关闭 Basic Auth，并为 SSE 关闭缓冲', () => {
  assert.ok((nginx.match(/auth_basic off;/g) || []).length >= 3);
  assert.ok(nginx.includes('proxy_hide_header WWW-Authenticate'));
  assert.ok(nginx.includes('proxy_buffering    off'));
  assert.ok(nginx.includes('proxy_request_buffering off'));
  assert.ok(nginx.includes('gzip               off'));
});
