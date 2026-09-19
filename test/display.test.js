'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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
  assert.ok(!source.includes('ShellExecute'));
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
  assert.ok(source.includes('if (g_bind_error && event->is_call)'), '绑定错误期间不显示任何通知');
  assert.ok(source.includes('g_class_code'), '顶栏显示班级编号');
  assert.ok(source.includes('#define CC_APP_TITLE     L"老师找人通知大屏"'), '程序名改为老师找人通知大屏');
  assert.ok(source.includes('L"%ls · " CC_APP_TITLE, info->name'), '窗口标题带班级名');
  assert.ok(!source.includes('班主任'), '大屏程序不再出现班主任字样');
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

test('存在编译产物时验证 MZ、i386、PE32 与 GUI 子系统', () => {
  const binary = path.join(displayRoot, 'build', 'display.exe');
  if (!fs.existsSync(binary)) return;
  const data = fs.readFileSync(binary);
  assert.strictEqual(data.toString('ascii', 0, 2), 'MZ');
  const pe = data.readUInt32LE(0x3c);
  assert.strictEqual(data.toString('ascii', pe, pe + 4), 'PE\0\0');
  assert.strictEqual(data.readUInt16LE(pe + 4), 0x014c, '必须是 IMAGE_FILE_MACHINE_I386');
  assert.strictEqual(data.readUInt16LE(pe + 24), 0x010b, '必须是 PE32，不能是 PE32+');
  assert.strictEqual(data.readUInt16LE(pe + 24 + 68), 2, '必须是 IMAGE_SUBSYSTEM_WINDOWS_GUI');
  assert.ok(!data.includes('ucrtbase.dll'), 'Windows 7 镜像不一定有 UCRT，不能依赖 ucrtbase');
  assert.ok(!data.includes('api-ms-win-crt-'), 'mingw-w64 12 起默认链 UCRT（api-ms-win-crt-*），必须用 -mcrtdll=msvcrt-os 或 msvcrt 默认的工具链');
  assert.ok(data.includes('msvcrt.dll'), '应只依赖系统自带的 msvcrt.dll');
  assert.ok(data.includes(Buffer.from('老师找人通知大屏', 'utf16le')), '编译产物必须带新的程序名');
  assert.ok(!data.includes(Buffer.from('班主任', 'utf16le')), '编译产物不得再出现班主任字样');
  assert.ok(data.includes(Buffer.from('caller', 'utf16le')), '编译产物必须解析通知里的找人身份');
});
