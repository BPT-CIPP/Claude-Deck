'use strict';
// The release manifest: every file in a release with its size and SHA-256, attached to each GitHub
// release (docs/CONTRIBUTING.md#versioning-and-releases), so a copy can be checked against it.
//
//   node tools/release-manifest.js build [ref]                  print the manifest for a commit or tag
//                                                                (default HEAD), from git, not the folder
//   node tools/release-manifest.js verify <manifest> [folder]    check a copy (default: this repo's folder)
//
// Hashes are of the files as git stores them. .gitattributes keeps text files LF in every checkout
// and in GitHub's source downloads, so a copy made either way hashes the same.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function git(args, cwd, input) {
  return execFileSync('git', args, { cwd, input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

function build(ref = 'HEAD', cwd = root) {
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`], cwd).toString().trim();
  // "<mode> <type> <object>\t<path>", NUL-separated so any path survives.
  const entries = git(['ls-tree', '-r', '-z', commit], cwd).toString().split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, object] = line.slice(0, tab).split(' ');
    return { mode, type, object, path: line.slice(tab + 1) };
  }).filter((e) => e.type === 'blob');
  // One git process for every file's contents: "<object> blob <size>\n<bytes>\n" per file.
  const out = git(['cat-file', '--batch'], cwd, entries.map((e) => e.object).join('\n') + '\n');
  let at = 0;
  const files = entries.map((e) => {
    const eol = out.indexOf(0x0a, at);
    const size = Number(out.slice(at, eol).toString().split(' ')[2]);
    const content = out.subarray(eol + 1, eol + 1 + size);
    at = eol + 1 + size + 1;
    return { path: e.path, bytes: size, sha256: sha256(content) };
  });
  let version = null;
  try { version = JSON.parse(git(['show', `${commit}:package.json`], cwd).toString()).version; } catch { /* no package.json */ }
  return { name: 'claude-deck', version, commit, files };
}

// Compares a folder with a manifest. Files that aren't in the manifest (logs, CLAUDE.local.md,
// node_modules and the like) are ignored.
function verify(manifest, folder = root) {
  const missing = [];
  const changed = [];
  for (const f of manifest.files) {
    const p = path.join(folder, ...f.path.split('/'));
    let buf;
    try { buf = fs.readFileSync(p); } catch { missing.push(f.path); continue; }
    if (buf.length !== f.bytes || sha256(buf) !== f.sha256) changed.push(f.path);
  }
  return { ok: !missing.length && !changed.length, checked: manifest.files.length, missing, changed };
}

function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'build') {
    process.stdout.write(`${JSON.stringify(build(a || 'HEAD'), null, 2)}\n`);
  } else if (cmd === 'verify' && a) {
    const manifest = JSON.parse(fs.readFileSync(a, 'utf8'));
    const r = verify(manifest, b ? path.resolve(b) : root);
    const label = `Claude Deck ${manifest.version || ''} (${String(manifest.commit).slice(0, 7)})`.replace('  ', ' ');
    if (r.ok) {
      console.log(`Matches ${label}: all ${r.checked} files.`);
      return;
    }
    console.error(`Doesn't match ${label}:`);
    for (const p of r.missing) console.error(`  missing  ${p}`);
    for (const p of r.changed) console.error(`  changed  ${p}`);
    process.exit(1);
  } else {
    console.error('Usage: node tools/release-manifest.js build [ref] | verify <manifest> [folder]');
    process.exit(2);
  }
}

if (require.main === module) main();
module.exports = { build, verify };
