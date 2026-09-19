'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const launcherRoot = path.join(root, 'windows-launcher');
const source = fs.readFileSync(path.join(launcherRoot, 'src', 'win7-launcher.c'), 'utf8');
const msvc = fs.readFileSync(path.join(launcherRoot, 'build-msvc-x86.cmd'), 'utf8');
const mingw = fs.readFileSync(path.join(launcherRoot, 'build-mingw-x86.cmd'), 'utf8');
const guide = fs.readFileSync(path.join(root, 'docs', 'windows-launcher.md'), 'utf8');

test('Win32 启动器固定为 Windows 7 x86 且不经过命令解释器', () => {
  assert.ok(source.includes('#define _WIN32_WINNT 0x0601'));
  assert.ok(source.includes('CreateProcessW(config->target_path'));
  assert.ok(source.includes('WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2'));
  assert.ok(source.includes('RegCreateKeyExW(HKEY_CURRENT_USER'));
  assert.ok(source.includes('classcaller://v1/call?payload='));
  assert.ok(!/\bsystem\s*\(/.test(source));
  assert.ok(!source.includes('ShellExecute'));
  assert.ok(!source.includes('cmd.exe'));
  assert.ok(!source.includes('powershell.exe'));
});

test('两套构建脚本都明确生成 PE32 x86', () => {
  assert.ok(msvc.includes('/MACHINE:X86'));
  assert.ok(msvc.includes('/SUBSYSTEM:CONSOLE,6.01'));
  assert.ok(msvc.includes('/MT'));
  assert.ok(mingw.includes('i686-w64-mingw32-gcc'));
  assert.ok(mingw.includes('-D_WIN32_WINNT=0x0601'));
  assert.ok(mingw.includes('win7-launcher.exe'));
});

test('Windows 文档给出 D 盘、协议、watcher 与参数契约', () => {
  for (const required of [
    'D:\\tools\\win7-launcher.exe',
    '--register-protocol',
    '--watch',
    '--class-caller-v1',
    'deliveryId',
    'students',
    'working_directory',
    'C 盘',
  ]) {
    assert.ok(guide.includes(required), `Windows 文档缺少 ${required}`);
  }
});

test('存在编译产物时验证 MZ、i386 与 PE32 头', () => {
  const binary = path.join(launcherRoot, 'build', 'win7-launcher.exe');
  if (!fs.existsSync(binary)) return;
  const data = fs.readFileSync(binary);
  assert.strictEqual(data.toString('ascii', 0, 2), 'MZ');
  const pe = data.readUInt32LE(0x3c);
  assert.strictEqual(data.toString('ascii', pe, pe + 4), 'PE\0\0');
  assert.strictEqual(data.readUInt16LE(pe + 4), 0x014c, '必须是 IMAGE_FILE_MACHINE_I386');
  assert.strictEqual(data.readUInt16LE(pe + 24), 0x010b, '必须是 PE32，不能是 PE32+');
});
