'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { sandbox } = require('./helpers');
const { build, verify } = require('../tools/release-manifest');

const box = sandbox();
const repo = path.join(box.root, 'repo');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], { cwd: repo, stdio: 'pipe' });
const write = (p, content) => {
  fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
  fs.writeFileSync(path.join(repo, p), content);
};
// Bytes a text conversion would mangle, so a binary file shows it came through untouched.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

test.before(() => {
  fs.mkdirSync(repo);
  git('init', '-q');
  write('.gitattributes', '* text=auto eol=lf\n*.png binary\n');
  write('package.json', '{ "version": "9.9.9" }\n');
  write('src/a.js', 'x\n');
  write('docs/read me.md', '# Spaces in the name\n');
  write('icons/b.png', PNG);
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  git('tag', 'v9.9.9');
});
test.after(() => box.cleanup());

test('the manifest lists every file in the commit with its size and SHA-256', () => {
  const m = build('HEAD', repo);
  assert.strictEqual(m.version, '9.9.9');
  assert.match(m.commit, /^[0-9a-f]{40}$/);
  assert.deepStrictEqual(m.files.map((f) => f.path).sort(), ['.gitattributes', 'docs/read me.md', 'icons/b.png', 'package.json', 'src/a.js']);
  assert.deepStrictEqual(m.files.find((f) => f.path === 'src/a.js'), { path: 'src/a.js', bytes: 2, sha256: sha('x\n') });
  assert.strictEqual(m.files.find((f) => f.path === 'icons/b.png').sha256, sha(PNG));
});

test('a matching copy passes; changed and missing files are named; extra files are ignored', () => {
  const m = build('HEAD', repo);
  assert.deepStrictEqual(verify(m, repo), { ok: true, checked: 5, missing: [], changed: [] });
  write('src/a.js', 'x\r\n'); // the same text with Windows line endings is a different file
  fs.rmSync(path.join(repo, 'docs', 'read me.md'));
  write('CLAUDE.local.md', 'personal notes\n');
  assert.deepStrictEqual(verify(m, repo), { ok: false, checked: 5, missing: ['docs/read me.md'], changed: ['src/a.js'] });
});

test('the manifest comes from git, not from the folder, so a tag describes that release', () => {
  write('src/a.js', 'y\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'second');
  assert.strictEqual(build('v9.9.9', repo).files.find((f) => f.path === 'src/a.js').sha256, sha('x\n'));
  assert.strictEqual(build('HEAD', repo).files.find((f) => f.path === 'src/a.js').sha256, sha('y\n'));
  assert.throws(() => build('v0.0.0', repo));
});
