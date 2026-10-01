'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  resolveTag, verifySource, writeManifest, verifyManifest, publish, artifactNames,
} = require('../scripts/verify-release');

const script = path.resolve(__dirname, '../scripts/verify-release.js');
const TAG = 'v1.2.3';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'synthetic@example.invalid');
  git('config', 'user.name', 'Release regression');
  fs.writeFileSync(path.join(dir, 'source.txt'), 'tagged source\n');
  git('add', 'source.txt');
  git('commit', '-qm', 'tagged source');
  const tagged = git('rev-parse', 'HEAD');
  git('tag', '-a', TAG, '-m', 'annotated release tag');
  fs.writeFileSync(path.join(dir, 'source.txt'), 'newer branch source\n');
  git('commit', '-qam', 'newer branch source');
  const latest = git('rev-parse', 'HEAD');
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(dist);
  for (const name of artifactNames(TAG)) fs.writeFileSync(path.join(dist, name), `synthetic ${name}`);
  return { dir, git, tagged, latest, dist };
}

function stage(f) {
  f.git('checkout', '--detach', f.tagged);
  return writeManifest(f.dir, TAG, f.dist, { compiler: 'synthetic compiler', binutils: 'synthetic binutils' });
}

test('F10: resolve an existing annotated tag, explicitly check out its commit, never the dispatch branch', (t) => {
  const f = fixture(t);
  assert.notEqual(f.latest, f.tagged);
  assert.equal(resolveTag(f.dir, TAG), f.tagged);
  assert.throws(() => verifySource(f.dir, TAG), /HEAD\/tag mismatch/);
  const failed = spawnSync(process.execPath, [script, 'source', TAG], { cwd: f.dir, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /HEAD\/tag mismatch/);
  const resolved = execFileSync(process.execPath, [script, 'resolve', TAG], { cwd: f.dir, encoding: 'utf8' }).trim();
  f.git('checkout', '--detach', resolved);
  assert.equal(verifySource(f.dir, TAG), f.tagged);
  assert.equal(fs.readFileSync(path.join(f.dir, 'source.txt'), 'utf8'), 'tagged source\n');
});

test('F10: a missing manual tag or branch masquerading as a tag is refused', (t) => {
  const f = fixture(t);
  f.git('branch', 'v9.9.9');
  assert.throws(() => resolveTag(f.dir, 'v9.9.9'), /does not exist/);
  assert.throws(() => resolveTag(f.dir, 'v9.9.8'), /does not exist/);
  for (const value of ['main', '--help', 'v1.2.3\n', 'v1.2.3;touch bad', 'refs/tags/v1.2.3']) {
    assert.throws(() => resolveTag(f.dir, value), /Invalid release tag/);
  }
  assert.equal(f.git('tag', '--list'), TAG);
});

test('release manifests bind tag, commit, exact artifact set, SHA-256 and size', (t) => {
  const f = fixture(t);
  const manifest = stage(f);
  assert.equal(manifest.commit, f.tagged);
  assert.equal(manifest.tag, TAG);
  assert.equal(verifyManifest(f.dir, TAG, f.dist).length, 6);
  const file = path.join(f.dist, artifactNames(TAG)[0]);
  const original = fs.readFileSync(file);
  fs.appendFileSync(file, 'tampered');
  assert.throws(() => verifyManifest(f.dir, TAG, f.dist), /SHA-256\/size mismatch/);
  fs.writeFileSync(file, original);
  fs.writeFileSync(`${file}.sha256`, 'invalid checksum\n');
  assert.throws(() => verifyManifest(f.dir, TAG, f.dist), /Checksum mismatch/);
});

test('release verification refuses forged commit metadata, dirty source and extra private files', (t) => {
  const f = fixture(t);
  stage(f);
  const file = path.join(f.dist, 'release-manifest.json');
  const original = fs.readFileSync(file);
  const manifest = JSON.parse(original);
  manifest.commit = f.latest;
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => verifyManifest(f.dir, TAG, f.dist), /Manifest tag\/commit/);
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(f.dist, 'students.json'), '{}');
  assert.throws(() => verifyManifest(f.dir, TAG, f.dist), /Unexpected or missing/);
  fs.unlinkSync(path.join(f.dist, 'students.json'));
  fs.appendFileSync(path.join(f.dir, 'source.txt'), 'changed');
  assert.throws(() => verifyManifest(f.dir, TAG, f.dist), /Tracked source changes/);
});

test('publication refuses existing releases without any upload/create call', (t) => {
  const f = fixture(t);
  stage(f);
  const calls = [];
  const run = (command, args) => { calls.push([command, ...args]); return ''; };
  assert.throws(() => publish(f.dir, TAG, f.dist, 'notes.txt', run), /Refusing to overwrite/);
  assert.deepEqual(calls, [['gh', 'release', 'view', TAG]]);
});

test('new publication uses only create --verify-tag and checks source again before invoking gh', (t) => {
  const f = fixture(t);
  stage(f);
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === 'view') throw new Error('release not found');
    return '';
  };
  publish(f.dir, TAG, f.dist, 'notes.txt', run);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(0, 4), ['gh', 'release', 'create', TAG]);
  assert.ok(calls[1].includes('--verify-tag'));
  assert.ok(!calls.flat().includes('--clobber'));
  assert.ok(!calls.flat().includes('--target'));
  f.git('checkout', '--detach', f.latest);
  assert.throws(() => publish(f.dir, TAG, f.dist, 'notes.txt', run), /HEAD\/tag mismatch/);
  assert.equal(calls.length, 2, 'mismatched source never reaches GitHub');
});

test('a failed or racing create cannot fall through to asset overwrite', (t) => {
  const f = fixture(t);
  stage(f);
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    throw new Error(args[1] === 'view' ? 'network error' : 'release already exists');
  };
  assert.throws(() => publish(f.dir, TAG, f.dist, 'notes.txt', run), /already exists/);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [['gh', 'release', 'view'], ['gh', 'release', 'create']]);
});
