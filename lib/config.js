'use strict';

const fs = require('fs');
const { timingSafeEqual } = require('crypto');
const {
  MAX_NAME_LENGTH, MAX_AUTO_CLEAR_SECONDS, MAX_TEACHER_PASSWORD_LENGTH,
  DEFAULT_LAUNCH_FRESH_SECONDS, MIN_LAUNCH_FRESH_SECONDS, MAX_LAUNCH_FRESH_SECONDS,
  CLASS_ID_RE, MAX_CLASS_NAME_LENGTH, MAX_CLASS_CODE_LENGTH, CLASS_COLORS,
} = require('./constants');

/**
 * 名单与班级配置的唯一入口（version 2：多班级）。
 *
 *   { "version": 2, "classes": [ { id, name, code?, color?, password, autoClearSeconds?, launcher?, students } ] }
 *
 * 每个班有独立密码、名单、自动清屏与启动器设置。班级 id 是设备绑定用的内部固定标识，
 * 名称可以改、id 不能改。reload 失败时保留上一份完整可用的配置，不会只更新一半。
 */

function normalizeLauncher(raw, where) {
  if (raw === undefined) {
    return { mode: 'off', freshSeconds: DEFAULT_LAUNCH_FRESH_SECONDS };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}launcher 必须是对象`);
  }

  const mode = raw.mode === undefined ? 'off' : raw.mode;
  if (!['off', 'protocol', 'native'].includes(mode)) {
    throw new Error(`${where}launcher.mode 只能是 off、protocol 或 native`);
  }

  const supplied = raw.freshSeconds === undefined
    ? DEFAULT_LAUNCH_FRESH_SECONDS
    : Number(raw.freshSeconds);
  if (!Number.isFinite(supplied)) throw new Error(`${where}launcher.freshSeconds 必须是数字`);
  const freshSeconds = Math.round(supplied);
  if (freshSeconds < MIN_LAUNCH_FRESH_SECONDS || freshSeconds > MAX_LAUNCH_FRESH_SECONDS) {
    throw new Error(`${where}launcher.freshSeconds 必须在 ${MIN_LAUNCH_FRESH_SECONDS} 到 ${MAX_LAUNCH_FRESH_SECONDS} 秒之间`);
  }

  return { mode, freshSeconds };
}

function normalizeStudents(raw, where) {
  if (!Array.isArray(raw)) throw new Error(`${where}students 必须是数组`);
  const seen = new Set();
  const students = [];
  for (const item of raw) {
    const name = String(item ?? '').trim();
    if (!name) continue;                                  // 跳过空行
    if (name.length > MAX_NAME_LENGTH) {
      throw new Error(`${where}姓名过长（超过 ${MAX_NAME_LENGTH} 字）：${name.slice(0, 24)}`);
    }
    if (seen.has(name)) continue;                         // 同一班内去重；不同班允许同名
    seen.add(name);
    students.push(name);
  }
  if (students.length === 0) throw new Error(`${where}students 里没有有效姓名`);
  return { students, roster: seen };
}

function normalizeClass(raw, index) {
  const where = `classes[${index}] `;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}必须是对象`);
  }

  const id = String(raw.id ?? '').trim();
  if (!CLASS_ID_RE.test(id)) {
    throw new Error(`${where}id 只能由小写字母、数字和连字符组成（1–32 位），且以字母或数字开头：${id || '(空)'}`);
  }

  const name = String(raw.name ?? '').trim();
  if (!name) throw new Error(`${where}name 不能为空`);
  if (name.length > MAX_CLASS_NAME_LENGTH) throw new Error(`${where}name 不能超过 ${MAX_CLASS_NAME_LENGTH} 字`);

  // 编号：默认按顺序 01、02…；一般直接写班号（如 23）更直观
  const code = raw.code === undefined
    ? String(index + 1).padStart(2, '0')
    : String(raw.code).trim();
  if (!code || code.length > MAX_CLASS_CODE_LENGTH) {
    throw new Error(`${where}code 必须是 1–${MAX_CLASS_CODE_LENGTH} 个字符`);
  }

  const color = raw.color === undefined
    ? CLASS_COLORS[index % CLASS_COLORS.length]
    : String(raw.color).trim();
  if (!CLASS_COLORS.includes(color)) {
    throw new Error(`${where}color 只能是 ${CLASS_COLORS.join('、')} 之一`);
  }

  if (typeof raw.password !== 'string' || !raw.password.trim()) {
    throw new Error(`${where}password 必须是非空字符串`);
  }
  if (raw.password.length > MAX_TEACHER_PASSWORD_LENGTH) {
    throw new Error(`${where}password 不能超过 ${MAX_TEACHER_PASSWORD_LENGTH} 字`);
  }

  let secs = Number(raw.autoClearSeconds);
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  secs = Math.min(Math.round(secs), MAX_AUTO_CLEAR_SECONDS);

  const { students, roster } = normalizeStudents(raw.students, where);

  return {
    id,
    name,
    code,
    color,
    password: raw.password,
    autoClearSeconds: secs,
    launcher: normalizeLauncher(raw.launcher, where),
    students,
    roster,                                               // 用于 O(1) 校验姓名是否在册
  };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('配置根节点必须是对象');
  }
  if (raw.version !== 2) {
    if (Array.isArray(raw.students) || raw.className !== undefined) {
      throw new Error('检测到旧的单班配置：请升级为 { "version": 2, "classes": [ ... ] } 多班级格式（见 README）');
    }
    throw new Error('version 必须是 2');
  }
  if (!Array.isArray(raw.classes) || raw.classes.length === 0) {
    throw new Error('classes 必须是非空数组');
  }

  const classes = raw.classes.map(normalizeClass);

  const ids = new Set();
  const passwords = new Set();
  for (const c of classes) {
    if (ids.has(c.id)) throw new Error(`班级 id 重复：${c.id}`);
    ids.add(c.id);
    // 密码一旦相同，一个班的老师就自然拿到了另一个班的权限，隔离形同虚设
    if (passwords.has(c.password)) throw new Error(`班级密码重复：${c.name}（${c.id}）与另一个班使用了相同密码`);
    passwords.add(c.password);
  }

  return {
    version: 2,
    classes,
    byId: new Map(classes.map((c) => [c.id, c])),
  };
}

class ConfigStore {
  constructor(file) {
    this.file = file;
    this.current = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  get() { return this.current; }

  /** 返回班级配置；不存在时返回 undefined */
  getClass(classId) { return this.current.byId.get(classId); }

  /** 所有班级的公开摘要：不含密码和名单 */
  listPublic() {
    return this.current.classes.map((c) => ({
      id: c.id, name: c.name, code: c.code, color: c.color,
    }));
  }

  /** 成功返回 {ok:true, classes}；失败保留旧配置并返回 {ok:false, message} */
  reload() {
    try {
      this.current = normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      return {
        ok: true,
        classes: this.current.classes.map((c) => ({ id: c.id, count: c.students.length })),
      };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  checkPassword(classId, value) {
    const c = this.getClass(classId);
    if (!c || typeof value !== 'string') return false;
    const expected = Buffer.from(c.password, 'utf8');
    const supplied = Buffer.from(value, 'utf8');
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }
}

module.exports = { ConfigStore, normalize };
