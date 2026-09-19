'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalize } = require('../lib/config');

const klass = (over = {}) => ({
  id: 'class-1',
  name: '一班',
  password: 'strong-pass',
  autoClearSeconds: 30,
  students: ['学生130'],
  ...over,
});
const base = (classes = [klass()]) => ({ version: 2, classes });

test('旧的单班格式与错误 version 都被拒绝，并给出升级提示', () => {
  assert.throws(() => normalize({ className: '旧', password: 'x', students: ['甲'] }), /旧的单班配置|version 2/);
  assert.throws(() => normalize({ version: 1, classes: [klass()] }), /version/);
  assert.throws(() => normalize({ version: 2, classes: [] }), /classes/);
});

test('老师密码缺失、类型错误或为空时配置失败关闭', () => {
  for (const password of [undefined, null, 1234, '', '   ']) {
    assert.throws(() => normalize(base([klass({ password })])), /password/);
  }
});

test('班级 id 必须合法且唯一；密码不能重复', () => {
  for (const id of ['', 'Class-1', 'class 1', '-x', 'x'.repeat(33), '中文']) {
    assert.throws(() => normalize(base([klass({ id })])), /id/, `id=${id}`);
  }
  assert.throws(() => normalize(base([klass(), klass({ name: '二班', password: 'other' })])), /id 重复/);
  assert.throws(() => normalize(base([klass(), klass({ id: 'class-2', name: '二班' })])), /密码重复/);
});

test('编号与颜色有默认值，可覆盖；非法颜色被拒绝', () => {
  const config = normalize(base([
    klass(),
    klass({ id: 'class-2', name: '二班', password: 'p2', code: '23', color: 'purple' }),
  ]));
  assert.strictEqual(config.classes[0].code, '01');
  assert.strictEqual(config.classes[0].color, 'blue');
  assert.strictEqual(config.classes[1].code, '23');
  assert.strictEqual(config.classes[1].color, 'purple');
  assert.strictEqual(config.byId.get('class-2').name, '二班');
  assert.throws(() => normalize(base([klass({ color: 'pink' })])), /color/);
});

test('同一班内学生去重；不同班允许同名', () => {
  const config = normalize(base([
    klass({ students: ['甲', '乙', '甲', ' 乙 ', ''] }),
    klass({ id: 'class-2', name: '二班', password: 'p2', students: ['甲'] }),
  ]));
  assert.deepStrictEqual(config.classes[0].students, ['甲', '乙']);
  assert.deepStrictEqual(config.classes[1].students, ['甲']);
});

test('launcher 配置只接受三个模式和 5..300 秒有效期', () => {
  for (const mode of ['off', 'protocol', 'native']) {
    const config = normalize(base([klass({ launcher: { mode, freshSeconds: 30 } })]));
    assert.deepStrictEqual(config.classes[0].launcher, { mode, freshSeconds: 30 });
  }
  assert.throws(() => normalize(base([klass({ launcher: { mode: 'auto', freshSeconds: 30 } })])), /launcher\.mode/);
  assert.throws(() => normalize(base([klass({ launcher: { mode: 'native', freshSeconds: 301 } })])), /freshSeconds/);
});

test('仓库自带的 students.example.json 是合法的匿名示例配置', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'students.example.json'), 'utf8'));
  const config = normalize(raw);
  assert.deepStrictEqual(config.classes.map((c) => [c.id, c.name, c.code, c.students.length]), [
    ['class-a', '示例班级1', '01', 3],
    ['class-b', '示例班级2', '02', 3],
    ['class-c', '示例班级3', '03', 3],
    ['class-d', '示例班级4', '04', 3],
  ]);
});
