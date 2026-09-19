'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const teacherHtml = fs.readFileSync(path.join(root, 'public', 'teacher.html'), 'utf8');
const teacherJs = fs.readFileSync(path.join(root, 'public', 'teacher.js'), 'utf8');
const displayHtml = fs.readFileSync(path.join(root, 'public', 'display.html'), 'utf8');
const displayJs = fs.readFileSync(path.join(root, 'public', 'display.js'), 'utf8');

test('老师端只保留手动选择，不含随机点名控件或算法', () => {
  const source = teacherHtml + '\n' + teacherJs;
  for (const forbidden of [
    'Math.random', 'shuffle(', 'pickRandom', 'data-pick',
    '随机 1 人', '优先未点过', '完全随机', 'cc.session',
  ]) {
    assert.ok(!source.includes(forbidden), `老师端不应包含 ${forbidden}`);
  }
  assert.ok(source.includes("'teacher/history'"));
  assert.ok(source.includes("'teacher/history/undo'"));
  assert.ok(source.includes("'teacher/history/clear'"));
  assert.ok(source.includes("'teacher/history/resend'"));
  assert.ok(source.includes('老师找人'));
  assert.ok(!source.includes('班主任找人'), '站点名称改为老师找人，不再叫班主任找人');
  assert.ok(source.includes('找人记录'));
  assert.ok(teacherHtml.includes('id="caller"'), '登录后必须能选择找人身份');
  for (const caller of ['班主任', '语文老师', '数学老师', '英语老师', '物理老师', '化学老师', '历史老师']) {
    assert.ok(teacherHtml.includes('<option>' + caller + '</option>'));
  }
  assert.ok(teacherJs.includes("submitCall(names, $('msg').value.trim(), $('caller').value)"));
  assert.ok(!source.includes('课堂推送'));
});

test('老师端：明确选班 + 班级密码 + 登录令牌，不再保存原始密码；切班必须退出', () => {
  assert.ok(teacherHtml.includes('id="gateClass"'), '登录页必须有班级选择');
  assert.ok(teacherJs.includes("fetch('/api/public/classes')"));
  assert.ok(teacherJs.includes("'teacher/login'"));
  assert.ok(teacherJs.includes("'teacher/logout'"));
  assert.ok(teacherJs.includes("'X-Teacher-Token'"));
  assert.ok(!teacherJs.includes('X-Teacher-Password'), '浏览器不得再发送原始密码头');
  assert.ok(!teacherJs.includes("'cc.pw'"), '浏览器不得再保存原始密码');
  assert.ok(teacherJs.includes("'cc.token.' + id"), '令牌按班级分别保存');
  assert.ok(teacherJs.includes("'/api/classes/' + encodeURIComponent(classId)"), '所有接口走班级作用域');
  assert.ok(!/['"]\/api\/teacher\//.test(teacherJs), '不得再调用旧的无班级老师接口');
  assert.ok(teacherHtml.includes('id="switch"') && teacherHtml.includes('退出并切换班级'));
  assert.ok(teacherHtml.includes('id="classBadge"'), '顶栏必须常显当前班级');
  assert.ok(teacherJs.includes("'当前班级：' + label"));
  assert.ok(teacherJs.includes("' · 老师找人'"), '浏览器标题带班级');
  assert.ok(teacherJs.includes("'通知 ' + sel.size + ' 人到' + target"), '发送按钮写明目标班级');
  assert.ok(teacherJs.includes("klass.className + '找人记录'"));
  assert.ok(teacherJs.includes('ev.classId !== classId'), '串班快照必须拒收');
  assert.ok(teacherJs.includes('res.json.classId !== classId'), '串班响应必须拒收');
  assert.ok(teacherJs.includes('function resetWorkspace()'), '切班时清空已选、搜索与消息');
  assert.ok(teacherJs.includes('绝不自动进入某个默认班级'));
});

test('大屏待机没有禁用文案，并具备启动去重', () => {
  const source = displayHtml + '\n' + displayJs;
  assert.ok(!source.includes('等待老师点名'));
  assert.ok(source.includes('老师正在找'));
  assert.ok(displayJs.includes("(ev.caller || '老师') + '正在找'"));
  assert.ok(!source.includes('班主任找人') && !source.includes('班主任正在找'), '大屏不再默认写班主任');
  assert.ok(!source.includes('请以下同学'));
  assert.ok(source.includes('cc.launch.processed.v1'));
  assert.ok(source.includes('deliveryId'));
  assert.ok(source.includes('launchValidUntil'));
  assert.ok(source.includes('classcaller://v1/call?payload='));
  assert.ok(source.includes("classPath('public/stream?role=display')"));
});

test('浏览器大屏：必须通过 ?class= 绑定班级，缺失或不匹配时显示绑定错误且不显示通知', () => {
  assert.ok(displayJs.includes("QUERY.get('class')"));
  assert.ok(displayJs.includes('此设备尚未绑定班级'));
  assert.ok(displayJs.includes('班级绑定错误'));
  assert.ok(displayHtml.includes('id="bind"'));
  assert.ok(displayJs.includes('ev.classId !== classId'), '串班消息必须拒绝显示');
  assert.ok(displayJs.includes('config.classId !== classId'), '公开配置的班级必须与绑定一致');
  assert.ok(displayHtml.includes('id="klassCode"'), '顶栏显示班级编号');
  assert.ok(displayHtml.includes('id="stageKlass"'), '待机画面显示班级');
  assert.ok(!/['"]\/api\/public\//.test(displayJs), '不得再调用旧的无班级公开接口');
  assert.ok(displayJs.includes("const classId = (QUERY.get('class') || '').trim();"), '班级只能来自 URL 参数，没有默认值');
});

test('浏览器大屏在 SSE 断线时仍会按当前通知 id 本地到期清屏', () => {
  assert.ok(displayJs.includes('function scheduleLocalExpiry(ev)'));
  assert.ok(displayJs.includes('Math.max(0, expiryLocal - Date.now())'));
  assert.ok(displayJs.includes('currentEvent.id !== eventId'), '旧通知定时器不得清除新通知');
  assert.ok(displayJs.includes("render({ type: 'clear' }, false)"));
  assert.ok(displayJs.includes('cancelLocalExpiry();'), '服务端清屏或新通知到达时必须取消旧定时器');
});

test('页面脚本使用本地静态文件，不依赖第三方资源', () => {
  assert.ok(teacherHtml.includes('<script src="teacher.js"></script>'));
  assert.ok(displayHtml.includes('<script src="display.js"></script>'));
  assert.ok(!/<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i.test(teacherHtml));
  assert.ok(!/<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i.test(displayHtml));
});

test('大屏与老师端具备「收到」确认：大屏有按钮并调用本班公开 ack 接口，老师端按姓名显示状态', () => {
  const display = displayHtml + '\n' + displayJs;
  assert.ok(displayHtml.includes('id="ack"'));
  assert.ok(displayJs.includes("fetch(classPath('public/ack')"));
  assert.ok(displayJs.includes('eventId: ev.id'));
  assert.ok(display.includes('已收到'));
  assert.ok(displayJs.includes('button.disabled = done || ackBusy'), '全部确认后按钮必须禁用');
  assert.ok(!displayJs.includes('teacher/'), '大屏脚本不得访问老师接口');

  const teacher = teacherHtml + '\n' + teacherJs;
  assert.ok(teacherJs.includes("classPath('public/stream?role=teacher')"));
  assert.ok(teacher.includes('未收到'));
  assert.ok(teacher.includes('已收到'));
  assert.ok(teacherJs.includes('ackSignature'));
});
