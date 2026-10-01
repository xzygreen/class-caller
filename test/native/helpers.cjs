'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { DisplayQueue } = require('../../lib/display');
const root = path.resolve(__dirname, '../..');

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 120000, ...options });
}
function checked(result) {
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, `signal: ${result.signal}\n${result.stderr}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}
function unavailable(t, reason) {
  if (process.env.CC_NATIVE_REQUIRE === '1') assert.fail(reason);
  t.skip(reason);
  return null;
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-native-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function compileParser(t, name) {
  const cc = process.env.NATIVE_CC || 'cc';
  const version = run(cc, ['--version']);
  if (version.error?.code === 'ENOENT') return unavailable(t, `Host C compiler unavailable: ${cc}`);
  checked(version);
  const binary = path.join(temporary(t), `${name}-contract`);
  checked(run(cc, ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function',
    ...(process.env.NATIVE_SANITIZE === '1' ? ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : []),
    path.join(__dirname, `${name}-contract.c`), '-o', binary]));
  t.diagnostic(`Compiled actual ${name} parser: ${version.stdout.split('\n')[0]}`);
  return (mode, input, expected = 0) => {
    const result = run(binary, [mode], { input });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null, `native parser signal: ${result.signal}\n${result.stderr}`);
    assert.equal(result.status, expected, `${name}/${mode}: ${result.stderr}`);
    return result.stdout.trim();
  };
}
function snapshots(classId = 'class-a', options = {}) {
  const queue = new DisplayQueue({ classId, now: () => 1790812800000 });
  try {
    const call = queue.push({ type: 'call', noticeId: randomUUID(), names: ['学生130', '学生131'],
      message: '请到讲台', caller: '数学老师', durationSeconds: 0, ...options }).event;
    const ack = queue.ack(call.id, [call.names[0]]).event;
    const clear = queue.clear({ all: true });
    const announcement = queue.push({ type: 'announcement', noticeId: randomUUID(),
      title: '班级通知', body: '请全体同学注意。\n明天集合。', author: '数学老师', durationSeconds: 0 }).event;
    return { call, ack, clear, announcement };
  } finally { queue.dispose(); }
}

// Parse the PE import directory, not arbitrary strings in an old executable.
function inspectPE(data, subsystem) {
  assert.equal(data.toString('ascii', 0, 2), 'MZ');
  const pe = data.readUInt32LE(0x3c);
  assert.equal(data.toString('ascii', pe, pe + 4), 'PE\0\0');
  assert.equal(data.readUInt16LE(pe + 4), 0x14c, 'IMAGE_FILE_MACHINE_I386');
  const optional = pe + 24;
  assert.equal(data.readUInt16LE(optional), 0x10b, 'PE32');
  assert.equal(data.readUInt16LE(optional + 68), subsystem);
  assert.equal(data.readUInt16LE(optional + 48), 6, 'Win7 subsystem major');
  assert.equal(data.readUInt16LE(optional + 50), 1, 'Win7 subsystem minor');
  const sections = pe + 24 + data.readUInt16LE(pe + 20);
  function offset(rva) {
    for (let i = 0; i < data.readUInt16LE(pe + 6); ++i) {
      const section = sections + 40 * i;
      const base = data.readUInt32LE(section + 12);
      const size = data.readUInt32LE(section + 16);
      if (rva >= base && rva < base + size) return data.readUInt32LE(section + 20) + rva - base;
    }
    assert.fail(`Unmapped PE RVA ${rva}`);
  }
  assert.ok(data.readUInt32LE(optional + 96 + 2 * 8), 'embedded icon resource directory');
  const imports = [];
  const importOffset = offset(data.readUInt32LE(optional + 96 + 8));
  for (let entry = importOffset; data.readUInt32LE(entry + 12); entry += 20) {
    const name = offset(data.readUInt32LE(entry + 12));
    const end = data.indexOf(0, name);
    assert.ok(end > name);
    imports.push(data.toString('ascii', name, end).toLowerCase());
    assert.ok(imports.length < 100);
  }
  assert.ok(imports.includes('msvcrt.dll'), 'system MSVCRT required');
  assert.ok(!imports.some((name) => /^(ucrtbase\.dll|api-ms-win-crt-)/i.test(name)), 'no UCRT imports');
  assert.ok(!imports.some((name) => /^(libgcc|libstdc\+\+|libwinpthread)/i.test(name)), 'no extra MinGW runtime DLLs');
  return imports;
}
function freshPE(t, component, subsystem) {
  const cc = process.env.NATIVE_MINGW_CC || 'i686-w64-mingw32-gcc';
  const docker = process.env.NATIVE_DOCKER_IMAGE;
  if (!docker) {
    for (const tool of [cc, cc.replace(/-gcc$/, '-windres'), cc.replace(/-gcc$/, '-objdump'), 'bash']) {
      if (run(tool, ['--version']).error?.code === 'ENOENT') return unavailable(t, `Fresh PE build skipped: ${tool} unavailable`);
    }
  }
  const directory = temporary(t);
  const project = `windows-${component}`;
  fs.mkdirSync(path.join(directory, project));
  fs.cpSync(path.join(root, project, 'src'), path.join(directory, project, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, project, 'build-mingw-x86.sh'), path.join(directory, project, 'build-mingw-x86.sh'));
  fs.mkdirSync(path.join(directory, 'public'));
  fs.copyFileSync(path.join(root, 'public/favicon.ico'), path.join(directory, 'public/favicon.ico'));
  const result = docker
    ? run('docker', ['run', '--rm', '--platform', 'linux/amd64', '-v', `${directory}:/work`,
      docker, 'bash', `/work/${project}/build-mingw-x86.sh`])
    : run('bash', [path.join(directory, project, 'build-mingw-x86.sh')], {
      env: { ...process.env, CC: cc, WINDRES: cc.replace(/-gcc$/, '-windres'), OBJDUMP: cc.replace(/-gcc$/, '-objdump') },
    });
  checked(result);
  const name = component === 'launcher' ? 'win7-launcher.exe' : 'display.exe';
  const data = fs.readFileSync(path.join(directory, project, 'build', name));
  const imports = inspectPE(data, subsystem);
  t.diagnostic(`Fresh ${name}; SHA256=${createHash('sha256').update(data).digest('hex')}; imports=${imports.join(', ')}`);
  return data;
}
module.exports = { compileParser, snapshots, freshPE, run, checked, root };
