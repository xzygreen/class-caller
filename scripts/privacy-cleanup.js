#!/usr/bin/env node
'use strict';

// Offline maintenance, intentionally NOT a general database editor or erasure tool.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { JsonStore } = require('../lib/store');
const { CLASS_ID_RE, DB_VERSION } = require('../lib/constants');

const COLLECTIONS = ['notices', 'auditLogs'];
const CLASS_AUDIT_ACTIONS = new Set([
  'class.create', 'class.update', 'class.students',
  'access.request', 'access.cancel', 'access.approve', 'access.reject', 'access.grant', 'access.revoke',
  'notice.call', 'notice.announce', 'notice.urgent', 'notice.withdraw', 'notice.resend',
  'notice.publish_due', 'notice.auto_withdraw',
  'display.clear', 'display.clear_all',
  'schedule.create', 'schedule.update', 'schedule.delete', 'schedule.auto_pause',
]);

function parseArgs(args, now = Date.now()) {
  const values = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!['--db', '--class', '--before', '--collections', '--apply', '--confirm'].includes(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
    if (Object.hasOwn(values, key)) throw new Error(`Repeated option: ${key}`);
    if (key === '--apply') values[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${key}`);
      values[key] = value;
    }
  }
  if (!values['--db'] || !path.isAbsolute(values['--db'])) throw new Error('--db must name an existing absolute db.json path');
  const classId = values['--class'];
  if (!classId || !CLASS_ID_RE.test(classId) || classId !== classId.trim()) throw new Error('--class must be an exact class ID');
  const before = values['--before'];
  const cutoff = Date.parse(`${before}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before || '') || !Number.isFinite(cutoff)
      || new Date(cutoff).toISOString().slice(0, 10) !== before || cutoff > now) {
    throw new Error('--before must be a real date YYYY-MM-DD, no later than today (UTC)');
  }
  const collections = (values['--collections'] || 'notices').split(',');
  if (new Set(collections).size !== collections.length || collections.some((key) => !COLLECTIONS.includes(key))) {
    throw new Error('--collections allows only notices,auditLogs; accounts, roster, sessions and schedules are never edited');
  }
  const apply = values['--apply'] === true;
  if (apply && values['--confirm'] !== classId) throw new Error('--apply also requires --confirm with the exact class ID');
  if (!apply && values['--confirm']) throw new Error('--confirm is only used with --apply');
  return { file: values['--db'], classId, before, cutoff, collections, apply };
}

function planCleanup(db, options, now = Date.now()) {
  if (db.version !== DB_VERSION || !Array.isArray(db.classes)
      || COLLECTIONS.some((key) => !Array.isArray(db[key]))) {
    throw new Error('Unsupported or malformed database; cleanup does not migrate or repair data');
  }
  if (!db.classes.some((item) => item.id === options.classId)) throw new Error('Class does not exist; no data changed');
  const remove = (collection, item) => {
    if (collection === 'auditLogs') {
      // User/global audit entries may mention this class in free text: keep them.
      return CLASS_AUDIT_ACTIONS.has(item.action) && item.target === options.classId
        && Number.isFinite(item.at) && item.at < options.cutoff;
    }
    if (item.classId !== options.classId || !['published', 'withdrawn'].includes(item.status)) return false;
    // Preserve scheduled/paused notices and potentially live announcements.
    if (item.status === 'published' && item.type === 'announcement'
        && (!Number.isFinite(item.expiresAt) || item.expiresAt > now)) return false;
    const timestamps = [item.createdAt, item.publishedAt, item.lastDeliveredAt, item.lastResentAt, item.withdrawnAt, item.publishAt, item.expiresAt]
      .filter((value) => value !== null && value !== undefined);
    return timestamps.length > 0 && timestamps.every((value) => Number.isFinite(value) && value < options.cutoff);
  };
  const replacements = {};
  const counts = {};
  for (const collection of options.collections) {
    replacements[collection] = db[collection].filter((item) => !remove(collection, item));
    counts[collection] = db[collection].length - replacements[collection].length;
  }
  return { replacements, counts };
}

async function cleanup(options, now = Date.now()) {
  if (typeof JsonStore.prototype.close !== 'function') {
    throw new Error('This command requires the writer-lock/close() version of JsonStore; upgrade before cleanup');
  }
  if (!fs.lstatSync(options.file).isFile()) throw new Error('--db must be a regular file, not a symlink');
  // Validate without creating/migrating a missing or legacy database.
  planCleanup(JSON.parse(fs.readFileSync(options.file, 'utf8')), options, now);
  const store = new JsonStore(options.file); // Active service/maintenance writer => fail closed.
  try {
    const plan = planCleanup(store.get(), options, now);
    const summary = { mode: options.apply ? 'apply' : 'dry-run', classId: options.classId, beforeUTC: options.before, counts: plan.counts };
    if (!options.apply || !Object.values(plan.counts).some((count) => count > 0)) return summary;
    // Retained deliberately; deleting it is a separate, operator-reviewed action.
    const backup = `${options.file}.privacy-backup.${new Date(now).toISOString().replace(/[:.]/g, '-')}.${randomUUID()}.json`;
    fs.copyFileSync(options.file, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
    await store.update((db) => {
      for (const [key, value] of Object.entries(plan.replacements)) db[key] = value;
    });
    return { ...summary, backup, warning: 'Old data remains in this snapshot, automatic/deployment/off-site backups and logs; review retention separately.' };
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
    console.log('Stop every writer first. Default is dry-run.\nUsage: node scripts/privacy-cleanup.js --db /absolute/data/db.json --class class-a --before YYYY-MM-DD [--collections notices,auditLogs] [--apply --confirm class-a]\nOnly old class-scoped notices/audit records are eligible. The pre-clean snapshot is retained; normal automatic-backup rotation still applies. See PRIVACY.md.');
  } else {
    Promise.resolve().then(() => cleanup(parseArgs(process.argv.slice(2))))
      .then((summary) => console.log(JSON.stringify(summary, null, 2)))
      .catch((err) => { console.error(`Cleanup refused: ${err.message}`); process.exitCode = 1; });
  }
}

module.exports = { parseArgs, planCleanup, cleanup };
