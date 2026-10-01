'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { verifyManifest } = require('../scripts/verify-release');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release-display.yml'), 'utf8');
const TAG = 'v1.2.3';
const common = { LICENSE: 'LICENSE', 'NOTICE.md': 'NOTICE.md', 'PRIVACY.md': 'PRIVACY.md' };
const bundles = [
  {
    name: `ClassCallerDisplay-${TAG}-win7-x86`,
    exe: 'display.exe',
    files: {
      'windows-display/build/display.exe': 'display.exe',
      'windows-display/display.ini.example': 'display.ini.example',
      'windows-display/start-display.cmd': 'start-display.cmd',
      'windows-display/install-autostart.cmd': 'install-autostart.cmd',
      'windows-display/uninstall-autostart.cmd': 'uninstall-autostart.cmd',
      'docs/windows-display.md': 'README.md',
      ...common,
    },
  },
  {
    name: `ClassCallerLauncher-${TAG}-win7-x86`,
    exe: 'win7-launcher.exe',
    files: {
      'windows-launcher/build/win7-launcher.exe': 'win7-launcher.exe',
      'windows-launcher/win7-launcher.ini.example': 'win7-launcher.ini.example',
      'windows-launcher/start-native-watcher.cmd': 'start-native-watcher.cmd',
      'windows-launcher/register-protocol.cmd': 'register-protocol.cmd',
      'windows-launcher/unregister-protocol.cmd': 'unregister-protocol.cmd',
      'docs/windows-launcher.md': 'README.md',
      ...common,
    },
  },
];

// Execute only the checked-in packaging body, not a reimplementation of its copy
// commands. No build, application, GitHub, workflow dispatch or publication runs.
function packagingShell() {
  const section = workflow.split('      - name: Prepare release files\n')[1]?.split('\n      - name: ')[0];
  assert.ok(section, 'release packaging step exists');
  const body = section.split('        run: |\n')[1];
  assert.ok(body, 'release packaging step is an inline shell block');
  return body.split('\n').map((line) => {
    assert.ok(!line.trim() || line.startsWith('          '), 'shell block indentation');
    return line.slice(10);
  }).join('\n');
}

test('release workflow resolves an existing tag, checks out its commit and guards source before packaging/publishing', () => {
  const markers = [
    'node scripts/verify-release.js resolve "$RELEASE_TAG"',
    'cp scripts/verify-release.js "$RUNNER_TEMP/verify-release.js"',
    'ref: ${{ steps.source.outputs.commit }}',
    'node "$RUNNER_TEMP/verify-release.js" source "$RELEASE_TAG"',
    'bash windows-display/build-mingw-x86.sh',
    'bash windows-launcher/build-mingw-x86.sh',
    'run: npm test',
    '- name: Prepare release files',
    'node "$RUNNER_TEMP/verify-release.js" manifest "$RELEASE_TAG" dist',
    'node "$RUNNER_TEMP/verify-release.js" verify "$RELEASE_TAG" dist',
    '- name: Upload workflow artifact',
    'node "$RUNNER_TEMP/verify-release.js" publish "$RELEASE_TAG" dist',
  ];
  let previous = -1;
  for (const marker of markers) {
    const index = workflow.indexOf(marker);
    assert.ok(index > previous, `required source/build/release order: ${marker}`);
    previous = index;
  }
  assert.match(workflow, /group: release-display-\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /path: dist\/\*/);
  assert.doesNotMatch(workflow, /--clobber|gh release (?:upload|delete)/);
  assert.match(workflow, /display\.ini\.example` 为 `display\.ini`/);
  assert.match(workflow, /win7-launcher\.ini\.example` 为 `win7-launcher\.ini`/);
  assert.match(workflow, /保留原有 `display\.ini`、`win7-launcher\.ini` 和启动器状态文件/);
});

test('packaging builds both complete ZIPs with current policy, safe examples and no private deployment files', (t) => {
  for (const tool of ['bash', 'zip', 'unzip']) {
    const probe = spawnSync(tool, ['--version'], { stdio: 'ignore' });
    if (probe.error) {
      assert.notEqual(process.env.CC_NATIVE_REQUIRE, '1', `${tool} is required for release packaging tests`);
      t.skip(`${tool} is unavailable; packaging requires the release runner's archive tools`);
      return;
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-release-packaging-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const put = (name, content) => {
    const file = path.join(repo, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const publicFiles = [...new Set(bundles.flatMap((bundle) => Object.keys(bundle.files)))];
  for (const name of publicFiles) {
    // Native PE compatibility is tested elsewhere; these are synthetic payloads.
    put(name, name.endsWith('.exe') ? `Synthetic fresh build: ${name}\n` : fs.readFileSync(path.join(root, name)));
  }
  fs.appendFileSync(path.join(repo, 'PRIVACY.md'), '\nSynthetic updated release policy: packaging must include this tagged revision.\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'synthetic@example.invalid');
  git('config', 'user.name', 'Packaging regression');
  git('add', '--', ...publicFiles.filter((name) => !name.endsWith('.exe')));
  git('commit', '-qm', 'synthetic tagged public release inputs');
  git('tag', '-a', TAG, '-m', 'synthetic release');
  const commit = git('rev-parse', 'HEAD');

  // Deliberately place private-looking decoys adjacent to every likely glob.
  const privateFiles = [
    'windows-display/display.ini', 'windows-display/display.log',
    'windows-display/build/display.ini', 'windows-display/build/students.json',
    'windows-launcher/win7-launcher.ini', 'windows-launcher/win7-launcher.state',
    'windows-launcher/win7-launcher.log', 'windows-launcher/build/win7-launcher.ini',
    'windows-launcher/build/userdata.json', 'students.json', 'data/db.json',
  ];
  for (const name of privateFiles) put(name, `SYNTHETIC-PRIVATE-DO-NOT-PUBLISH: ${name}\n`);

  // Stub only informational PE/toolchain probes; real zip/unzip/cmp and the
  // production manifest CLI operate on the fixture. No compiler is invoked.
  for (const tool of ['file', 'i686-w64-mingw32-gcc', 'i686-w64-mingw32-objdump']) {
    fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nprintf "%s\\n" "synthetic tool; file format fixture; architecture fixture"\n', { mode: 0o755 });
  }
  fs.copyFileSync(path.join(root, 'scripts/verify-release.js'), path.join(tmp, 'verify-release.js'));
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', packagingShell()], {
    cwd: repo, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: tmp, RELEASE_TAG: TAG },
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  const dist = path.join(repo, 'dist');
  const files = verifyManifest(repo, TAG, dist);
  assert.equal(files.length, 10);
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.artifacts.length, 4);

  for (const bundle of bundles) {
    const archive = path.join(dist, `${bundle.name}.zip`);
    const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(entries.sort(), [
      `${bundle.name}/`, ...Object.values(bundle.files).map((name) => `${bundle.name}/${name}`),
    ].sort(), 'archive has the exact public allowlist (no active INI, log, state, roster or user data)');
    for (const [source, destination] of Object.entries(bundle.files)) {
      const bytes = execFileSync('unzip', ['-p', archive, `${bundle.name}/${destination}`]);
      assert.deepEqual(bytes, fs.readFileSync(path.join(repo, source)), `current tagged input: ${source}`);
      assert.ok(!bytes.includes('SYNTHETIC-PRIVATE-DO-NOT-PUBLISH'), 'private decoy never packaged');
      if (destination === bundle.exe) {
        assert.deepEqual(bytes, fs.readFileSync(path.join(dist, `${bundle.name}.exe`)), 'standalone and bundled EXE match');
      }
    }
  }
  for (const name of privateFiles) {
    assert.equal(fs.readFileSync(path.join(repo, name), 'utf8'), `SYNTHETIC-PRIVATE-DO-NOT-PUBLISH: ${name}\n`, 'packaging leaves local configuration and user data untouched');
  }
});
