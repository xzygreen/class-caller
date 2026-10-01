'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { JsonStore, emptyDb } = require('../lib/store');
const { parseArgs, planCleanup, cleanup } = require('../scripts/privacy-cleanup');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const OLD = Date.parse('2026-08-01T12:00:00Z');
const RECENT = Date.parse('2026-09-20T12:00:00Z');
function options(file) {
  return parseArgs(['--db', file, '--class', 'class-a', '--before', '2026-09-01', '--collections', 'notices,auditLogs'], NOW);
}
function seed() {
  const db = emptyDb();
  db.classes = [{ id: 'class-a', students: ['Synthetic Student A'] }, { id: 'class-b', students: ['Synthetic Student B'] }];
  db.users = [{ id: 'teacher', displayName: 'Synthetic Teacher', passwordHash: 'synthetic-not-a-password' }];
  db.sessions = [{ token: 'synthetic-session', userId: 'teacher', expiresAt: NOW + 1000 }];
  db.schedules = [{ id: 'schedule', classId: 'class-a', names: ['Synthetic Student A'] }];
  db.scheduleRuns = [{ scheduleId: 'schedule', date: '2026-08-01', at: OLD }];
  db.notices = [
    { id: 'old', classId: 'class-a', status: 'published', type: 'call', createdAt: OLD, names: ['Synthetic Student A'] },
    { id: 'other-class', classId: 'class-b', status: 'published', type: 'call', createdAt: OLD },
    { id: 'recent', classId: 'class-a', status: 'published', type: 'call', createdAt: RECENT },
    { id: 'resent', classId: 'class-a', status: 'published', type: 'call', createdAt: OLD, lastDeliveredAt: RECENT },
    { id: 'future', classId: 'class-a', status: 'scheduled', type: 'announcement', createdAt: OLD, publishAt: NOW + 1000 },
    { id: 'persistent', classId: 'class-a', status: 'published', type: 'announcement', createdAt: OLD, expiresAt: null },
    { id: 'withdrawn', classId: 'class-a', status: 'withdrawn', type: 'announcement', createdAt: OLD, withdrawnAt: OLD },
  ];
  db.auditLogs = [
    { id: 'old-audit', action: 'notice.call', target: 'class-a', at: OLD, actorName: 'Synthetic Teacher' },
    { id: 'new-audit', action: 'notice.call', target: 'class-a', at: RECENT },
    { id: 'other-audit', action: 'notice.call', target: 'class-b', at: OLD },
    { id: 'global-audit', action: 'settings.update', target: null, at: OLD },
    { id: 'user-audit', action: 'user.update', target: 'teacher', at: OLD },
    { id: 'colliding-user-id', action: 'user.update', target: 'class-a', at: OLD },
    { id: 'unknown-action', action: 'unknown', target: 'class-a', at: OLD },
  ];
  return db;
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-privacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, JSON.stringify(seed()), { mode: 0o600 });
  return { dir, file };
}

test('privacy cleanup requires an explicit absolute database, exact scope/date and apply confirmation', () => {
  const args = ['--db', '/synthetic/db.json', '--class', 'class-a', '--before', '2026-09-01'];
  assert.equal(parseArgs(args, NOW).apply, false);
  assert.throws(() => parseArgs([], NOW), /--db/);
  assert.throws(() => parseArgs([...args, '--apply'], NOW), /--confirm/);
  assert.throws(() => parseArgs([...args, '--collections', 'users'], NOW), /only notices,auditLogs/);
  assert.throws(() => parseArgs([...args, '--db', '/other/db.json'], NOW), /Repeated/);
  assert.throws(() => parseArgs(args.map((x) => x === '2026-09-01' ? '2026-02-30' : x), NOW), /real date/);
  assert.throws(() => parseArgs(args.map((x) => x === '2026-09-01' ? '2027-01-01' : x), NOW), /real date/);
  assert.throws(() => parseArgs(args.map((x) => x === 'class-a' ? 'class-a\n' : x), NOW), /exact class ID/);
});

test('cleanup plan excludes other classes, future/live notices, recent resends and global/user audits', () => {
  const db = seed();
  const before = JSON.stringify(db);
  const plan = planCleanup(db, options('/synthetic/db.json'), NOW);
  assert.deepEqual(plan.counts, { notices: 2, auditLogs: 1 });
  assert.deepEqual(plan.replacements.notices.map((n) => n.id), ['other-class', 'recent', 'resent', 'future', 'persistent']);
  assert.deepEqual(plan.replacements.auditLogs.map((n) => n.id), ['new-audit', 'other-audit', 'global-audit', 'user-audit', 'colliding-user-id', 'unknown-action']);
  assert.equal(JSON.stringify(db), before, 'planning never changes the database');
  assert.throws(() => planCleanup(db, { ...options('/synthetic/db.json'), classId: 'typo' }, NOW), /does not exist/);
});

test('F09: users, sessions, notices and audit persist after close/reopen; dry-run changes no database or backups', async (t) => {
  const { file, dir } = fixture(t);
  let store = new JsonStore(file);
  assert.equal(typeof store.close, 'function', 'requires the writer-lock store revision');
  await store.update((db) => { db.settings.synthetic = true; });
  await store.close();
  store = new JsonStore(file);
  for (const key of ['users', 'sessions', 'notices', 'auditLogs']) assert.deepEqual(store.get()[key], seed()[key]);
  await store.close();
  const before = fs.readFileSync(file);
  const files = fs.readdirSync(dir).sort();
  const backups = fs.readdirSync(path.join(dir, 'backups')).sort();
  const result = await cleanup(options(file), NOW);
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(result.counts, { notices: 2, auditLogs: 1 });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), files);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')).sort(), backups);
});

test('F09: apply preserves roster/accounts/schedules and keeps recoverable old data in a protected backup', async (t) => {
  const { file, dir } = fixture(t);
  const before = fs.readFileSync(file);
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir);
  for (let day = 1; day <= 14; day += 1) {
    fs.writeFileSync(path.join(backupDir, `db-2000-01-${String(day).padStart(2, '0')}T00-00-00-000Z.json`), before);
  }
  const result = await cleanup({ ...options(file), apply: true }, NOW);
  assert.equal(result.mode, 'apply');
  assert.deepEqual(fs.readFileSync(result.backup), before);
  if (process.platform !== 'win32') assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
  let store = new JsonStore(file);
  const after = store.get();
  assert.equal(after.notices.some((n) => n.id === 'old'), false);
  assert.equal(after.auditLogs.some((n) => n.id === 'old-audit'), false);
  for (const key of ['classes', 'users', 'sessions', 'schedules', 'scheduleRuns', 'memberships', 'accessRequests', 'settings']) {
    assert.deepEqual(after[key], seed()[key], `${key} preserved`);
  }
  await store.close();
  const automaticBackups = fs.readdirSync(backupDir);
  assert.equal(automaticBackups.length, 14, 'normal store rotation still keeps 14 files');
  assert.ok(automaticBackups.some((name) => name.startsWith('db-2000-')), 'retention is file-count based, not 14 days');
  assert.ok(!automaticBackups.includes('db-2000-01-01T00-00-00-000Z.json'));
  assert.ok(fs.existsSync(result.backup), 'mandatory privacy snapshot is outside automatic rotation');
  // Demonstrate why erasure requests must include backups: restoring one restores the old records.
  fs.copyFileSync(result.backup, file);
  store = new JsonStore(file);
  assert.equal(store.get().notices.some((n) => n.id === 'old'), true);
  assert.equal(store.get().auditLogs.some((n) => n.id === 'old-audit'), true);
  await store.close();
});

test('cleanup refuses an active writer and never creates a nonexistent or symlink database', async (t) => {
  const { file, dir } = fixture(t);
  const store = new JsonStore(file);
  assert.equal(typeof store.close, 'function', 'requires the writer-lock store revision');
  const before = fs.readFileSync(file);
  try {
    await assert.rejects(cleanup({ ...options(file), apply: true }, NOW), /lock|writer|占用|写入|运行/i);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('privacy-backup')), false);
  } finally { await store.close(); }
  const missing = path.join(dir, 'missing.json');
  await assert.rejects(cleanup(options(missing), NOW), /ENOENT/);
  assert.equal(fs.existsSync(missing), false);
  const link = path.join(dir, 'link.json');
  fs.symlinkSync(file, link);
  await assert.rejects(cleanup(options(link), NOW), /regular file/);
});

test('documented cleanup CLI previews by default and requires an explicit confirmation before writing', (t) => {
  const { file } = fixture(t);
  const script = path.join(__dirname, '../scripts/privacy-cleanup.js');
  const args = [script, '--db', file, '--class', 'class-a', '--before', '2020-01-01'];
  const before = fs.readFileSync(file);
  const preview = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).mode, 'dry-run');
  assert.deepEqual(fs.readFileSync(file), before);
  const refused = spawnSync(process.execPath, [...args, '--apply'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--confirm/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('failed mandatory pre-clean backup leaves the database untouched and releases its writer lock', async (t) => {
  const { file } = fixture(t);
  const before = fs.readFileSync(file);
  const original = fs.copyFileSync;
  fs.copyFileSync = (source, target, ...args) => {
    if (target.includes('.privacy-backup.')) throw new Error('synthetic backup ENOSPC');
    return original(source, target, ...args);
  };
  try {
    await assert.rejects(cleanup({ ...options(file), apply: true }, NOW), /synthetic backup ENOSPC/);
  } finally { fs.copyFileSync = original; }
  assert.deepEqual(fs.readFileSync(file), before);
  const store = new JsonStore(file);
  await store.close();
});

test('server remains dependency-free; privacy policy is included and compared inside the release ZIP', () => {
  const pkg = require('../package.json');
  assert.deepEqual(Object.keys(pkg.dependencies || {}), []);
  assert.deepEqual(Object.keys(pkg.optionalDependencies || {}), []);
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release-display.yml'), 'utf8');
  assert.match(workflow, /cp LICENSE NOTICE\.md PRIVACY\.md/);
  assert.match(workflow, /unzip -p .*PRIVACY\.md.*\| cmp PRIVACY\.md -/);
});
