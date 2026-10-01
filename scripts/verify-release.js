#!/usr/bin/env node
'use strict';

// Release tooling only: built-in Node modules, no application/runtime dependencies.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');

const TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?$/;
const MANIFEST = 'release-manifest.json';
const sha256 = (body) => createHash('sha256').update(body).digest('hex');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function resolveTag(repo, tag) {
  if (typeof tag !== 'string' || tag !== tag.trim() || !TAG_RE.test(tag)) throw new Error('Invalid release tag; use v1.2.3 or v1.2.3-beta.1');
  try {
    // Fully qualified ref avoids a branch with the same name, and peels annotated tags.
    return git(repo, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  } catch {
    throw new Error(`Release tag does not exist: ${tag}. Create/review the tag separately; this tool never creates tags.`);
  }
}

function verifySource(repo, tag) {
  const commit = resolveTag(repo, tag);
  const head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head !== commit) throw new Error(`HEAD/tag mismatch: HEAD=${head}, ${tag}=${commit}`);
  if (git(repo, ['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Tracked source changes present; build from a clean tag checkout');
  }
  return commit;
}

function artifactNames(tag) {
  return ['ClassCallerDisplay', 'ClassCallerLauncher'].flatMap((program) => {
    const base = `${program}-${tag}-win7-x86`;
    return [`${base}.exe`, `${base}.zip`];
  });
}

function readRegular(dir, name) {
  const file = path.join(dir, name);
  if (!fs.lstatSync(file).isFile()) throw new Error(`Not a regular release file: ${name}`);
  return fs.readFileSync(file);
}

function checkFileSet(dir, names) {
  const actual = fs.readdirSync(dir).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) {
    throw new Error('Unexpected or missing release files; use an empty staging directory');
  }
}

function writeManifest(repo, tag, dir, toolchain) {
  const commit = verifySource(repo, tag);
  const names = artifactNames(tag);
  checkFileSet(dir, names);
  const artifacts = names.map((name) => {
    const body = readRegular(dir, name);
    if (!body.length) throw new Error(`Empty release file: ${name}`);
    return { name, bytes: body.length, sha256: sha256(body) };
  });
  const manifest = {
    schemaVersion: 1, tag, commit, builtAt: new Date().toISOString(),
    node: process.version, toolchain, artifacts,
  };
  fs.writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  for (const name of [...names, MANIFEST]) {
    fs.writeFileSync(path.join(dir, `${name}.sha256`), `${sha256(readRegular(dir, name))}  ${name}\n`, { flag: 'wx' });
  }
  return manifest;
}

function verifyManifest(repo, tag, dir) {
  const commit = verifySource(repo, tag);
  const manifest = JSON.parse(readRegular(dir, MANIFEST));
  if (manifest.schemaVersion !== 1 || manifest.tag !== tag || manifest.commit !== commit) {
    throw new Error('Manifest tag/commit does not match the checked-out release source');
  }
  const names = artifactNames(tag);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== names.length) {
    throw new Error('Invalid manifest artifact list');
  }
  for (let i = 0; i < names.length; i += 1) {
    const item = manifest.artifacts[i];
    const body = readRegular(dir, names[i]);
    if (!item || item.name !== names[i] || item.bytes !== body.length || item.sha256 !== sha256(body)) {
      throw new Error(`Artifact SHA-256/size mismatch: ${names[i]}`);
    }
  }
  const files = [...names, MANIFEST];
  for (const name of files) {
    const expected = `${sha256(readRegular(dir, name))}  ${name}\n`;
    if (readRegular(dir, `${name}.sha256`).toString('utf8') !== expected) {
      throw new Error(`Checksum mismatch: ${name}`);
    }
  }
  const allFiles = [...files, ...files.map((name) => `${name}.sha256`)];
  checkFileSet(dir, allFiles);
  return allFiles;
}

function publish(repo, tag, dir, notesFile, run = execFileSync) {
  const files = verifyManifest(repo, tag, dir);
  let exists = false;
  try {
    run('gh', ['release', 'view', tag], { cwd: repo, stdio: 'pipe' });
    exists = true;
  } catch {
    // Network/auth failures are NOT permission to upload to an existing release.
    // `create --verify-tag` below also fails on existing releases or missing tags.
  }
  if (exists) throw new Error(`Refusing to overwrite published release/assets: ${tag}`);
  run('gh', [
    'release', 'create', tag, ...files.map((name) => path.resolve(dir, name)),
    '--verify-tag', '--title', `Class Caller ${tag}`,
    '--notes-file', path.resolve(notesFile),
  ], { cwd: repo, stdio: 'inherit' });
}

function main(args) {
  const [command, tag, dir, notesFile] = args;
  const repo = process.cwd();
  if (command === 'resolve' && args.length === 2) {
    process.stdout.write(`${resolveTag(repo, tag)}\n`);
  } else if (command === 'source' && args.length === 2) {
    process.stdout.write(`${verifySource(repo, tag)}\n`);
  } else if (command === 'manifest' && args.length === 3) {
    const version = (name) => execFileSync(name, ['--version'], { encoding: 'utf8' }).split('\n')[0];
    writeManifest(repo, tag, dir, {
      compiler: version('i686-w64-mingw32-gcc'),
      binutils: version('i686-w64-mingw32-objdump'),
    });
  } else if (command === 'verify' && args.length === 3) {
    verifyManifest(repo, tag, dir);
  } else if (command === 'publish' && args.length === 4) {
    publish(repo, tag, dir, notesFile);
  } else {
    throw new Error('Usage: node verify-release.js resolve|source TAG; manifest|verify TAG DIST; publish TAG DIST NOTES_FILE');
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) {
    console.error(`Release refused: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { resolveTag, verifySource, writeManifest, verifyManifest, publish, artifactNames };
