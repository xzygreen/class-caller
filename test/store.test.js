'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonStore, emptyDb } = require('../lib/store');
const { normalizeClass, normalizeStudents, importLegacyConfig } = require('../lib/config');
const { hashPassword, verifyPassword, temporaryPassword } = require('../lib/passwords');
const { setSink } = require('../lib/logger');

setSink(() => {});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-'));

test('数据仓库：首次创建、权限 0600、原子写入、串行更新', async () => {
  const dir = tmp();
  const file = path.join(dir, 'db.json');
  const store = new JsonStore(file);
  assert.ok(fs.existsSync(file));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(store.get().version, 1);
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => store.update((db) => { db.users.push({ id: String(i) }); return i; })));
  assert.deepStrictEqual(results, [1, 2, 3, 4, 5]);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).users.length, 5);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), '没有残留临时文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('数据仓库：mutator 抛错或写盘失败时内存回滚到上一份有效数据', async () => {
  const dir = tmp();
  const file = path.join(dir, 'db.json');
  const store = new JsonStore(file);
  await store.update((db) => { db.users.push({ id: 'keep' }); });
  await assert.rejects(store.update((db) => { db.users.push({ id: 'bad' }); throw new Error('boom'); }), /boom/);
  assert.deepStrictEqual(store.get().users.map((u) => u.id), ['keep']);
  // 写盘失败：把文件换成目录让 rename 失败
  fs.rmSync(file);
  fs.mkdirSync(file);
  await assert.rejects(store.update((db) => { db.users.push({ id: 'lost' }); }));
  assert.deepStrictEqual(store.get().users.map((u) => u.id), ['keep']);
  fs.rmdirSync(file);
  // 之后队列仍可用
  await store.update((db) => { db.users.push({ id: 'after' }); });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).users.map((u) => u.id), ['keep', 'after']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('数据仓库：旧版本文件自动补齐集合并升级版本号；更高版本拒绝载入；每日备份', async () => {
  const dir = tmp();
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, JSON.stringify({ version: 0, users: [{ id: 'u' }] }));
  const store = new JsonStore(file);
  assert.strictEqual(store.get().version, 1);
  assert.deepStrictEqual(store.get().classes, []);
  assert.deepStrictEqual(store.get().users, [{ id: 'u' }]);
  await store.update((db) => { db.users.push({ id: 'v' }); });
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.strictEqual(backups.length, 1);
  assert.match(backups[0], /^db-.*\.json$/);
  await store.update((db) => { db.users.push({ id: 'w' }); });
  assert.strictEqual(fs.readdirSync(path.join(dir, 'backups')).length, 1, '同一天只备份一次');

  fs.writeFileSync(file, JSON.stringify({ ...emptyDb(), version: 99 }));
  assert.throws(() => new JsonStore(file), /版本/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('密码摘要：scrypt 加盐，可验证，不可逆；临时密码足够长', async () => {
  const hash = await hashPassword('secret-pass-1');
  assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(!hash.includes('secret-pass-1'));
  assert.notStrictEqual(hash, await hashPassword('secret-pass-1'), '每次盐不同');
  assert.strictEqual(await verifyPassword('secret-pass-1', hash), true);
  assert.strictEqual(await verifyPassword('secret-pass-2', hash), false);
  assert.strictEqual(await verifyPassword('secret-pass-1', 'garbage'), false);
  assert.strictEqual(await verifyPassword(null, hash), false);
  assert.ok(temporaryPassword().length >= 12);
});

test('班级校验：id、名称、编号、颜色、名单去重与上限；不再要求密码', () => {
  const base = { id: 'class-1', name: '一班', students: ['甲', '乙', '甲', ' 乙 ', ''] };
  const c = normalizeClass(base, 0);
  assert.deepStrictEqual(c.students, ['甲', '乙']);
  assert.strictEqual(c.code, '01');
  assert.strictEqual(c.color, 'blue');
  assert.strictEqual(c.password, undefined);
  assert.strictEqual(c.status, 'active');
  assert.deepStrictEqual(c.launcher, { mode: 'off', freshSeconds: 30 });
  for (const id of ['', 'Class-1', 'class 1', '-x', 'x'.repeat(33), '中文']) {
    assert.throws(() => normalizeClass({ ...base, id }), /id/, `id=${id}`);
  }
  assert.throws(() => normalizeClass({ ...base, color: 'pink' }), /color/);
  assert.throws(() => normalizeClass({ ...base, name: '' }), /name/);
  assert.throws(() => normalizeClass({ ...base, launcher: { mode: 'auto' } }), /launcher\.mode/);
  assert.throws(() => normalizeStudents(new Array(201).fill(0).map((_, i) => 's' + i)), /200/);
  assert.throws(() => normalizeStudents(['x'.repeat(21)]), /过长/);
  assert.deepStrictEqual(normalizeStudents([]), []);
});

test('旧版 students.json 可导入：忽略密码，保留班级与名单', () => {
  const dir = tmp();
  const file = path.join(dir, 'students.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, classes: [
    { id: 'class-a', name: '甲', password: 'p1', students: ['x'] },
    { id: 'class-b', name: '乙', password: 'p2', students: ['y'], code: '23', color: 'purple' },
  ] }));
  const classes = importLegacyConfig(file);
  assert.strictEqual(classes.length, 2);
  assert.strictEqual(classes[0].password, undefined);
  assert.strictEqual(classes[1].code, '23');
  fs.writeFileSync(file, JSON.stringify({ className: '旧', students: ['x'] }));
  assert.throws(() => importLegacyConfig(file), /version/);
  fs.writeFileSync(file, JSON.stringify({ version: 2, classes: [{ id: 'a', name: 'a', students: ['x'] }, { id: 'a', name: 'b', students: ['y'] }] }));
  assert.throws(() => importLegacyConfig(file), /重复/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('本地 students.json（若存在）仍可被导入', () => {
  const file = path.join(__dirname, '..', 'students.json');
  if (!fs.existsSync(file)) return;
  const classes = importLegacyConfig(file);
  assert.ok(classes.length >= 1);
  assert.ok(classes.every((c) => c.students.length > 0 && c.password === undefined));
});
