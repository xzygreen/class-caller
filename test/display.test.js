'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { compileParser, snapshots, freshPE } = require('./native/helpers.cjs');

const root = path.join(__dirname, '..');
const displayRoot = path.join(root, 'windows-display');
const source = fs.readFileSync(path.join(displayRoot, 'src', 'display.c'), 'utf8');
const msvc = fs.readFileSync(path.join(displayRoot, 'build-msvc-x86.cmd'), 'utf8');
const mingwCmd = fs.readFileSync(path.join(displayRoot, 'build-mingw-x86.cmd'), 'utf8');
const mingwSh = fs.readFileSync(path.join(displayRoot, 'build-mingw-x86.sh'), 'utf8');
const ini = fs.readFileSync(path.join(displayRoot, 'display.ini.example'), 'utf8');
const guide = fs.readFileSync(path.join(root, 'docs', 'windows-display.md'), 'utf8');

test('大屏 exe 固定为 Windows 7 x86 GUI 程序，只用本班公开接口', () => {
  assert.ok(source.includes('#define _WIN32_WINNT 0x0601'));
  assert.ok(source.includes('wWinMain'));
  assert.ok(source.includes('/api/classes/%ls/public/stream?role=display'));
  assert.ok(source.includes('/api/classes/%ls/public/config'));
  assert.ok(source.includes('/api/classes/%ls/public/ack'));
  assert.ok(!source.includes('/api/public/'), '不得再调用旧的无班级公开接口');
  assert.ok(source.includes('WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2'));
  assert.ok(source.includes('SetForegroundWindow'));
  assert.ok(source.includes('AttachThreadInput'));
  assert.ok(source.includes('HWND_TOPMOST'));
  assert.ok(source.includes('SW_RESTORE'));
  assert.ok(!source.includes('/api/teacher/') && !source.includes('/teacher/'), '大屏程序不得访问老师接口');
  assert.ok(!/\bsystem\s*\(/.test(source));
  assert.equal((source.match(/ShellExecuteW\(/g) || []).length, 1, '唯一外部打开操作是学生主动调出系统屏幕键盘');
  assert.match(source, /ShellExecuteW\(g_hwnd, L"open", L"osk\.exe"/);
  assert.match(source, /wparam == VK_F2/);
  assert.ok(!source.includes('CreateProcess'));
  assert.ok(!source.includes('等待老师点名'));
  assert.ok(!source.includes('等待点名'));
});

test('大屏 exe 必须绑定 class_id：缺失拒绝启动，串班帧拒收，班级不存在时显示绑定错误', () => {
  assert.ok(source.includes('L"class_id"'), '从 display.ini 读取 class_id');
  assert.ok(source.includes('L"--class"'));
  assert.ok(source.includes('static int class_id_valid('));
  assert.ok(source.includes('refusing to start: class_id is not configured'), '没有 class_id 不能默认进入任何班');
  assert.ok(source.includes('此设备尚未绑定班级'));
  assert.ok(source.includes('wcscmp(event->class_id, g_config.class_id) != 0'), '快照 classId 必须与绑定一致');
  assert.ok(source.includes('wcscmp(info->class_id, g_config.class_id) != 0'), '公开配置 classId 必须与绑定一致');
  assert.ok(source.includes('CLASS_NOT_FOUND'));
  assert.ok(source.includes('static void paint_bind_error('));
  assert.ok(source.includes('L"班级绑定错误"'));
  assert.ok(source.includes('if (g_bind_error && (event->is_call || event->is_announcement))'), '绑定错误期间不显示任何通知');
  assert.ok(source.includes('g_class_code'), '顶栏显示班级编号');
  assert.ok(source.includes('#define CC_APP_TITLE     L"老师找人通知大屏"'), '程序名改为老师找人通知大屏');
  assert.ok(source.includes('L"%ls · " CC_APP_TITLE, info->name'), '窗口标题带班级名');
  assert.ok(!source.includes('班主任'), '大屏程序不再出现班主任字样');
});

test('大屏 exe 支持班级留言版式：解析 title/body/author/priority/queued，留言没有「收到」按钮', () => {
  assert.ok(source.includes('int is_announcement;'));
  assert.ok(source.includes('wcscmp(key, L"title") == 0') && source.includes('wcscmp(key, L"body") == 0'));
  assert.ok(source.includes('wcscmp(key, L"author") == 0') && source.includes('wcscmp(key, L"priority") == 0') && source.includes('wcscmp(key, L"queued") == 0'));
  assert.ok(source.includes('wcscmp(type, L"announcement") == 0'));
  assert.ok(source.includes('static void paint_announcement('), '留言有独立版式');
  assert.ok(source.includes('static void paint_queue_hint('), '显示等待队列提示');
  assert.ok(source.includes('L"班级留言"') && source.includes('L"紧急通知"'));
  assert.ok(source.includes('text_has_control_except_newline(event->body)'), '正文允许换行');
  assert.ok(source.includes('} else if (g_current.is_announcement) {\n        memset(&g_ack_rect, 0, sizeof(g_ack_rect));'), '留言版式下没有「收到」命中区域');
  assert.ok(source.includes('--preview-notice'));
});

test('大屏 exe 实现「收到」按钮、开机自启，标题栏没有关闭指引', () => {
  assert.ok(source.includes('WM_APP_ACK'));
  assert.ok(source.includes('parse_acks'));
  assert.ok(source.includes('wcscmp(key, L"caller") == 0'));
  assert.ok(!/caller[^\n]*\n[^\n]*units == 0/.test(source), 'clear 快照的 caller 是空串，解析器不得因此丢帧');
  assert.ok(source.includes('clear 快照的 caller 是空串'), '空 caller 必须被明确接受');
  assert.ok(source.includes('#define CC_DEFAULT_CALLER L"老师"'));
  assert.ok(source.includes('g_current.caller[0] ? g_current.caller : CC_DEFAULT_CALLER'), '快照没带身份时显示“老师正在找”');
  assert.ok(source.includes('paint_ack_button'));
  assert.ok(source.includes('L"已收到"'));
  assert.ok(source.includes('--install-autostart'));
  assert.ok(source.includes('CurrentVersion\\\\Run'));
  assert.ok(source.includes('        CC_APP_TITLE,\n        g_config.fullscreen'), '窗口初始标题只能是程序名');
  assert.ok(!source.includes('× 为最小化'));
  assert.ok(!source.includes('Ctrl+Q 退出，F11'));
  assert.ok(!source.includes('关闭指引'));
  assert.ok(!source.includes('点右上角'));
});

test('构建脚本都明确生成 PE32 x86 且不依赖 UCRT', () => {
  assert.ok(msvc.includes('/MACHINE:X86'));
  assert.ok(msvc.includes('/SUBSYSTEM:WINDOWS,6.01'));
  assert.ok(msvc.includes('/MT'));
  for (const script of [mingwCmd, mingwSh]) {
    assert.ok(script.includes('i686-w64-mingw32-gcc'));
    assert.ok(script.includes('-D_WIN32_WINNT=0x0601'));
    assert.ok(script.includes('-mwindows'));
    assert.ok(script.includes('-static'));
    assert.ok(script.includes('display.exe'));
  }
});

test('示例配置与文档覆盖 class_id、D 盘路径、自启、SSE 与前置说明', () => {
  assert.ok(/^server=https:\/\//m.test(ini));
  assert.ok(/^class_id=class-/m.test(ini), '示例配置必须演示 class_id');
  for (const required of [
    'class_id',
    'D:\\class-caller\\display.exe',
    'D:\\class-caller\\display.ini',
    'install-autostart.cmd',
    'schtasks',
    '/api/classes/<class_id>/public/stream?role=display',
    '班级绑定错误',
    'SetForegroundWindow',
    'expiresAt',
    'C 盘',
    'TLS 1.2',
    'PE32',
  ]) {
    assert.ok(guide.includes(required), `Windows 大屏文档缺少 ${required}`);
  }
});

test('compiled display parser consumes actual call, ACK, clear and announcement snapshots', async (t) => {
  const parse = compileParser(t, 'display');
  if (!parse) return;
  const { call, ack, clear, announcement } = snapshots();
  for (const [event, expected] of [
    [call, `call ${call.id} 2 0 0 0`], [ack, `call ${ack.id} 2 1 0 0`],
    [clear, `clear ${clear.id} 0 0 0 0`],
    [announcement, `announcement ${announcement.id} 0 0 ${announcement.title.length} ${announcement.body.length}`],
  ]) await t.test(`real ${event.type} with ${event.acks.length} ACKs`, () => {
    assert.equal(parse('snapshot', JSON.stringify(event)), expected);
  });
  await t.test('full permitted announcement lengths and UTF-16 names', () => {
    parse('snapshot', JSON.stringify({ ...announcement, title: '标'.repeat(30), body: '正'.repeat(300) }));
    parse('snapshot', JSON.stringify({ ...call, names: ['😀'.repeat(10)] }));
    parse('snapshot', JSON.stringify({ ...call, names: ['😀'.repeat(11)] }), 2);
    parse('snapshot', JSON.stringify({ ...announcement, body: '正'.repeat(301) }), 2);
  });
  for (const mode of ['class-cli', 'class-ini']) {
    for (const length of [1, 31, 32, 33, 500]) {
      await t.test(`${mode} original identity length ${length}`, () => {
        const result = parse(mode, 'a'.repeat(length), length <= 32 ? 0 : 2);
        if (length <= 32) assert.equal(result, String(length));
      });
    }
    for (const invalid of ['', '-a', 'A', 'a_', 'a/b', 'a b', 'a '.repeat(16), 'a'.repeat(32) + '-suffix']) {
      await t.test(`${mode} rejects ${JSON.stringify(invalid)}`, () => parse(mode, invalid, 2));
    }
  }
  for (const classId of ['', null, '-a', 'A', '班级', 'a'.repeat(33)]) {
    await t.test(`snapshot invalid classId ${JSON.stringify(classId)}`, () => parse('snapshot', JSON.stringify({ ...call, classId }), 2));
  }
  await t.test('snapshot requires unambiguous classId/type/id and valid JSON numbers', () => {
    for (const key of ['classId', 'type', 'id']) {
      const missing = { ...call }; delete missing[key];
      parse('snapshot', JSON.stringify(missing), 2);
      parse('snapshot', JSON.stringify(call).replace(/}$/, `,${JSON.stringify(key)}:${JSON.stringify(call[key])}}`), 2);
    }
    parse('snapshot', JSON.stringify({ ...call, type: 'unexpected' }), 2);
    for (const bad of ['01', '-1', '9007199254740992', '1e3']) {
      parse('snapshot', JSON.stringify(call).replace(/"id":\d+/, `"id":${bad}`), 2);
    }
    for (const bad of ['+', '-', '1.', '1e', '1e+', '00', '--1']) {
      parse('snapshot', JSON.stringify(call).replace(/}$/, `,"extra":${bad}}`), 2);
    }
    parse('snapshot', JSON.stringify(call).replace(/}$/, ',"extra":-1.5e+2}'));
  });
  await t.test('reject invalid UTF-8, NUL, surrogates, controls, trailing data and excessive depth', () => {
    parse('snapshot', Buffer.concat([Buffer.from(JSON.stringify(call).slice(0, -1) + ',"extra":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')]), 2);
    for (const message of ['\u0000', '\ud800', '\n', 'a'.repeat(61)]) {
      parse('snapshot', JSON.stringify({ ...call, message }), 2);
    }
    parse('snapshot', JSON.stringify(call) + '{}', 2);
    parse('snapshot', JSON.stringify(call).replace(/}$/, ',"extra":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}'), 2);
    parse('snapshot', JSON.stringify({ ...call, extra: { compatible: [true, null, 1.5] } }));
  });
  await t.test('public config identity cannot be truncated, duplicated or followed by junk', () => {
    const config = { classId: 'class-a', className: '示例班级', code: '01' };
    assert.equal(parse('config', JSON.stringify(config)), 'configured');
    assert.equal(parse('config', '{"error":"CLASS_NOT_FOUND"}'), 'not-found');
    for (const invalid of ['{}', JSON.stringify({ ...config, classId: 'a'.repeat(33) }),
      JSON.stringify(config) + '{}', '{"classId":"class-a","classId":"class-b"}']) parse('config', invalid, 2);
  });
});

test('学生呼叫老师在程序内完成：不打开浏览器，只用本班公开接口', () => {
  assert.ok(!source.includes('callTeacher') && !source.includes('/display?'), '不得再跳转到网页大屏');
  assert.ok(!/L"https?:/.test(source), '不得内置任何网址');
  for (const api of ['public/student-call-options', 'public/student-calls"', 'public/student-calls/status', 'public/student-calls/%ls/cancel']) {
    assert.ok(source.includes('/api/classes/%ls/' + api), api);
  }
  assert.ok(source.includes('wcscmp(job->options.class_id, g_config.class_id) == 0'), '老师列表必须属于绑定班级');
  assert.ok(source.includes('L"EDIT"') && source.includes('WS_CLIPCHILDREN'), '姓名与留言用系统输入框，支持输入法');
  assert.ok(source.includes('static void sc_sync(void)') && /g_current = \*event;\n    KillTimer\(g_hwnd, TIMER_EXPIRE\);\n    sc_sync\(\);/.test(source), '通知到来时面板让位');
  assert.ok(source.includes('CryptGenRandom'), '重试键使用系统随机数');
  assert.ok(!/log_line\([^;]*(student|message|reply)\b[^;]*%ls/.test(source.slice(source.indexOf('学生呼叫老师：程序内面板'))), '日志不记录姓名、留言与回复');
  assert.ok(guide.includes('屏幕键盘') && !guide.includes('callTeacher=1'), '文档描述程序内呼叫');
});

test('compiled display parser consumes real student-call responses and builds matching requests', async (t) => {
  const parse = compileParser(t, 'display');
  if (!parse) return;
  const { randomUUID } = require('node:crypto');
  const { start, req, teacherWithAccess, TEACHER2 } = require('./helpers');
  const units = (text) => text ? [...Array(text.length).keys()].map((i) => text.charCodeAt(i).toString(16).padStart(4, '0')).join('') : '-';
  const STATUS = { pending: 0, replied: 1, cancelled: 2, expired: 3, unavailable: 4 };
  const line = (c, settled = 0) => [c.id, STATUS[c.status], c.createdAt, settled, units(c.studentName), units(c.teacherName), units(c.message), units(c.reply)].join(' ');
  const s = await start(); t.after(() => s.stop());
  const { client, user } = await teacherWithAccess(s.base, ['class-a']);
  const other = await teacherWithAccess(s.base, ['class-a'], TEACHER2);
  const api = (sub, body) => req(s.base, body ? 'POST' : 'GET', '/api/classes/class-a/public/' + sub, body ? { body } : {});

  const options = await api('student-call-options');
  await t.test('real teacher options', () => {
    const [head, ...rows] = parse('call-options', options.body).split('\n');
    assert.equal(head, `class-a ${options.json.callWindow.open ? 1 : 0} 2`);
    assert.deepEqual(rows.sort(), options.json.teachers.map((x) => `${x.id} ${units(x.displayName)} ${units(x.title)}`).sort());
    assert.ok(rows.some((row) => row.startsWith(user.id)) && rows.some((row) => row.startsWith(other.user.id)));
  });
  await t.test('options reject failures, foreign shapes and oversize fields; extra teachers are ignored', () => {
    const base = options.json;
    for (const bad of [{ ...base, ok: false }, { ...base, classId: 'A' }, { ...base, callWindow: {} }, { ...base, teachers: undefined },
      { ...base, teachers: [{ id: 'x', displayName: '张' }] }, { ...base, teachers: [{ ...base.teachers[0], displayName: '' }] },
      { ...base, teachers: [{ ...base.teachers[0], displayName: '张'.repeat(41) }] }, { ...base, callWindow: { open: 1 } }]) {
      parse('call-options', JSON.stringify(bad), 2);
    }
    parse('call-options', JSON.stringify(base) + 'x', 2);
    parse('call-options', '{"ok":false,"error":"CLASS_NOT_FOUND","message":"x"}', 2);
    const many = { ...base, teachers: Array.from({ length: 30 }, () => ({ id: randomUUID(), displayName: '老师', title: '' })) };
    assert.equal(parse('call-options', JSON.stringify(many)).split('\n')[0], `class-a ${base.callWindow.open ? 1 : 0} 24`);
  });

  const body = { requestId: randomUUID(), studentName: '学生130', teacherId: user.id, message: '请来教室 "A\\B" 😀' };
  const created = await api('student-calls', body);
  assert.equal(created.status, 200, created.body);
  const call = created.json.call;
  await t.test('real create receipt', () => assert.equal(parse('call-reply', created.body), 'ok 1\n' + line(call)));
  await t.test('request body re-encoded by the native builder is accepted JSON with identical text', () => {
    const rebuilt = JSON.parse(parse('call-body', created.body));
    assert.deepEqual(rebuilt, { studentName: call.studentName, teacherId: call.id, message: call.message, requestId: call.id });
    parse('call-body', JSON.stringify({ ok: true, call: { ...call, message: '\ud83d' } }), 2);
  });
  await t.test('a body built natively is idempotent on the real server', async () => {
    const native = parse('call-body', JSON.stringify({ ok: true, call: { ...call, id: body.requestId } }));
    const retry = await api('student-calls', { ...JSON.parse(native), teacherId: user.id });
    assert.equal(retry.status, 200, retry.body);
    assert.equal(retry.json.call.id, call.id);
  });
  await t.test('real server rejections expose code and message', async () => {
    const duplicate = await api('student-calls', { ...body, requestId: randomUUID() });
    assert.equal(duplicate.status, 429, duplicate.body);
    assert.equal(parse('call-reply', duplicate.body), `error ${duplicate.json.error} ${units(duplicate.json.message)}`);
    const unknown = await api('student-calls', { ...body, requestId: randomUUID(), studentName: '不在名单' });
    assert.equal(parse('call-reply', unknown.body), `error ${unknown.json.error} ${units(unknown.json.message)}`);
  });
  const replied = await client.post('/api/me/student-calls/' + call.id + '/reply', { reply: '收到，五分钟后到教室' });
  assert.equal(replied.status, 200);
  const status = await api('student-calls/status', { ids: [call.id] });
  await t.test('real status with teacher reply', () => {
    assert.equal(status.json.calls[0].status, 'replied');
    assert.equal(parse('call-reply', status.body), 'ok 1\n' + line(status.json.calls[0]));
  });
  await t.test('real cancel rejection after reply', async () => {
    const cancel = await api('student-calls/' + call.id + '/cancel', {});
    assert.equal(cancel.status, 409);
    assert.equal(parse('call-reply', cancel.body), `error STUDENT_CALL_CLOSED ${units(cancel.json.message)}`);
  });
  await t.test('receipt list: pending first, newest first, reply detected once, capped at 10', () => {
    const mk = (i, st) => ({ ...call, id: randomUUID(), status: st, createdAt: 1000 + i, reply: st === 'replied' ? '好' : '' });
    const pendingOld = mk(1, 'pending'), done = mk(5, 'cancelled'), pendingNew = mk(3, 'pending');
    const answered = { ...pendingOld, status: 'replied', reply: '来了' };
    const out = parse('call-merge', JSON.stringify({ ok: true, calls: [pendingOld, done, pendingNew, answered, answered] })).split('\n');
    assert.equal(out[0], '3 1');
    assert.deepEqual(out.slice(1), [line(pendingNew), line(done, 1), line(answered, 1)]);
    const ten = Array.from({ length: 10 }, (_, i) => mk(i, i < 9 ? 'expired' : 'pending'));
    const full = parse('call-merge', JSON.stringify({ ok: true, calls: ten })).split('\n');
    assert.equal(full[0], '10 0');
    assert.equal(full[1], line(ten[9]));
    parse('call-reply', JSON.stringify({ ok: true, calls: [...ten, mk(11, 'pending')] }), 2);
  });
  await t.test('reply parser rejects malformed receipts', () => {
    for (const bad of [{ ok: true }, { ok: true, call: { ...call, id: 'not-a-uuid' } }, { ok: true, call: { ...call, status: 'other' } },
      { ok: true, call: { ...call, studentName: '' } }, { ok: true, call: { ...call, reply: 'a'.repeat(61) } },
      { ok: true, call: { ...call, message: 'a\u0001' } }, { ok: false }, { call }, { ok: 'true', call }]) {
      parse('call-reply', JSON.stringify(bad), 2);
    }
    parse('call-reply', JSON.stringify({ ok: true, call }) + '{}', 2);
  });
});

test('fresh display build is PE32 i386 GUI 6.01 with MSVCRT and no UCRT', (t) => {
  const data = freshPE(t, 'display', 2);
  if (!data) return;
  assert.ok(data.includes(Buffer.from('老师找人通知大屏', 'utf16le')), '编译产物必须带新的程序名');
  assert.ok(data.includes(Buffer.from('announcement', 'utf16le')), '编译产物必须识别留言快照');
  assert.ok(data.includes(Buffer.from('/public/student-calls', 'utf16le')), '编译产物必须内置学生呼叫');
  assert.ok(!data.includes(Buffer.from('callTeacher', 'utf16le')), '编译产物不得再跳转浏览器');
});

test('autostart distinguishes automatic idempotent start from manual wake', () => {
  const install = fs.readFileSync(path.join(displayRoot, 'install-autostart.cmd'), 'utf8');
  assert.ok(install.includes('if errorlevel 1 goto fallback'));
  assert.ok(install.includes('reg delete "%RUNKEY%" /v ClassCallerDisplay'));
  assert.ok(install.indexOf('exit /b 0') < install.indexOf(':fallback'));
  assert.ok(install.includes('--autostart'));
  assert.ok(source.includes('autostart_arg ? NULL : FindWindowW'));
});

test('Windows integration: delayed double autostart stays minimized; real INI/CLI binding and static proxy GET/SSE/ACK', {
  skip: 'Requires a disposable interactive Windows 7/10 session, registry and controlled proxy network; portable tests do not verify these APIs',
}, () => {});
