'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { compileParser, snapshots, freshPE } = require('./native/helpers.cjs');

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

test('compiled launcher consumes actual DisplayQueue payloads through direct, URI and watch validators', async (t) => {
  const parse = compileParser(t, 'launcher');
  if (!parse) return;
  const { call, clear, announcement } = snapshots();
  const payload = JSON.parse(Buffer.from(call.launchPayload, 'base64url'));
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const encodeRaw = (text) => Buffer.from(text).toString('base64url');
  const expected = `${payload.classId} ${payload.deliveryId} ${payload.recordId} ${payload.issuedAt}`;
  for (const [mode, input] of [
    ['payload', call.launchPayload], ['uri', `classcaller://v1/call?payload=${call.launchPayload}`],
    ['watch', JSON.stringify(call)],
  ]) await t.test(`real server call via ${mode}`, () => assert.equal(parse(mode, input), expected));
  for (const event of [clear, announcement]) {
    await t.test(`${event.type} never launches`, () => assert.equal(parse('watch', JSON.stringify(event)), 'ignored'));
  }
  for (const id of ['a', '0', 'class-a', 'a'.repeat(31), 'a'.repeat(32)]) {
    await t.test(`classId valid ${id.length}: ${id}`, () => {
      const actual = snapshots(id).call;
      assert.ok(parse('payload', actual.launchPayload).startsWith(`${id} `));
      assert.ok(parse('watch', JSON.stringify(actual)).startsWith(`${id} `));
    });
  }
  for (const id of ['', null, 1, {}, [], '-a', 'A', 'class_a', 'a/b', 'a b', 'a\t', 'é', '班级', 'a'.repeat(33), 'a'.repeat(500)]) {
    await t.test(`reject classId ${JSON.stringify(id).slice(0, 50)}`, () => {
      parse('payload', encode({ ...payload, classId: id }), 2);
    });
  }
  for (const key of Object.keys(payload)) {
    await t.test(`reject missing/duplicate ${key}`, () => {
      const missing = { ...payload }; delete missing[key];
      parse('payload', encode(missing), 2);
      parse('payload', encodeRaw(JSON.stringify(payload).replace(/}$/, `,${JSON.stringify(key)}:${JSON.stringify(payload[key])}}`)), 2);
    });
  }
  const badPayloads = [
    { ...payload, extra: true }, { ...payload, version: 2 }, { ...payload, students: [] },
    { ...payload, students: ['one', 'one'] }, { ...payload, students: ['a'.repeat(21)] },
    { ...payload, students: ['😀'.repeat(11)] }, { ...payload, students: Array.from({ length: 21 }, (_, i) => `s${i}`) },
    { ...payload, message: 'x'.repeat(61) }, { ...payload, message: '\n' }, { ...payload, message: '\u0000' },
    { ...payload, message: '\ud800' }, { ...payload, deliveryId: 'not-a-uuid' }, { ...payload, issuedAt: 0 },
    { ...payload, issuedAt: -1 }, { ...payload, issuedAt: 9007199254740992 },
  ];
  for (let i = 0; i < badPayloads.length; ++i) {
    await t.test(`reject malformed schema ${i + 1}`, () => parse('payload', encode(badPayloads[i]), 2));
  }
  for (const encoded of ['', 'a', 'Zh', 'e30=', '+///', call.launchPayload + '=', 'A'.repeat(8193),
    Buffer.from([0xc0, 0xaf]).toString('base64url'), Buffer.from([0xed, 0xa0, 0x80]).toString('base64url'),
    encodeRaw(JSON.stringify(payload) + '{}'), encodeRaw(JSON.stringify(payload).replace('"version":1', '"version":01'))]) {
    await t.test(`reject malformed encoding ${encoded.slice(0, 24)}`, () => parse('payload', encoded, 2));
  }
  await t.test('strict URI does not permit extra query parameters or percent escapes', () => {
    parse('uri', `classcaller://v1/call?payload=${call.launchPayload}&target=evil`, 2);
    parse('uri', 'classcaller://v1/call?payload=%41', 2);
  });
  await t.test('watch rejects mismatched identities, stale time, malformed UTF-8 and excessive depth', () => {
    for (const change of [{ classId: 'class-b' }, { deliveryId: 'fe630bdf-2af4-4795-bb8b-3aa66e1a3f14' },
      { serverTime: call.launchValidUntil + 1 }, { launchValidUntil: payload.issuedAt + 1 }]) {
      parse('watch', JSON.stringify({ ...call, ...change }), 2);
    }
    const missing = { ...call }; delete missing.classId;
    parse('watch', JSON.stringify(missing), 2);
    parse('watch', JSON.stringify(call).replace(/}$/, ',"classId":"class-a"}'), 2);
    parse('watch', Buffer.concat([Buffer.from(JSON.stringify(call).slice(0, -1) + ',"extra":"'), Buffer.from([0xff]), Buffer.from('"}')]), 2);
    parse('watch', JSON.stringify(call).replace(/}$/, ',"extra":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}'), 2);
    assert.equal(parse('watch', JSON.stringify({ ...call, extra: { compatible: [true, null, 1.5] } })), expected);
  });
  await t.test('UTF-16 unit limits accept legitimate astral text', () => {
    parse('payload', encode({ ...payload, students: ['😀'.repeat(10)], message: '😀'.repeat(30) }));
  });
});

test('fresh launcher build is PE32 i386 console 6.01 with MSVCRT and no UCRT', (t) => {
  freshPE(t, 'launcher', 3);
});

test('Windows integration: synthetic target starts once across URI/watch, persistent dedupe and rollback', {
  skip: 'Requires a disposable Windows 7/10 runtime and D: state volume; portable parser/PE checks do not execute CreateProcessW or persistence',
}, () => {});
