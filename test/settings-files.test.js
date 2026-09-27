'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const settings = require('../src/settings-files');

test.after(() => box.cleanup());

const userFile = () => path.join(box.claudeDir, 'settings.json');

test('reads a missing file as empty and creates it on save', () => {
  const r = settings.read('user');
  assert.strictEqual(r.exists, false);
  assert.strictEqual(r.path, userFile());
  const w = settings.write('user', null, '{"model":"opus"}\n', null, false);
  assert.strictEqual(w.exists, true);
  assert.strictEqual(w.backupPath, null, 'nothing to back up the first time');
  assert.strictEqual(fs.readFileSync(userFile(), 'utf8'), '{"model":"opus"}\n');
});

test('backs up before overwriting and refuses stale writes', () => {
  const r = settings.read('user');
  const w = settings.write('user', null, '{"model":"sonnet"}', r.mtimeMs, false);
  assert.ok(w.backupPath && fs.existsSync(w.backupPath));
  assert.strictEqual(fs.readFileSync(w.backupPath, 'utf8'), '{"model":"opus"}\n');

  // Simulate Claude Code changing the file after the editor loaded it.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(userFile(), later, later);
  assert.throws(() => settings.write('user', null, '{"model":"haiku"}', w.mtimeMs, false), (err) => err.status === 409);
  const forced = settings.write('user', null, '{"model":"haiku"}', w.mtimeMs, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(forced.path, 'utf8')).model, 'haiku');
});

test('rejects invalid JSON and non-objects', () => {
  const r = settings.read('user');
  assert.throws(() => settings.write('user', null, '{nope', r.mtimeMs, false), /Not valid JSON/);
  assert.throws(() => settings.write('user', null, '[1,2]', r.mtimeMs, false), /JSON object/);
});

test('lists backups newest first and restores one', () => {
  const { backups } = settings.listBackups('user');
  assert.ok(backups.length >= 2);
  assert.ok(backups[0].name > backups[1].name, 'newest first');
  assert.ok(backups[0].savedAt > 0);
  const oldest = backups[backups.length - 1];
  const now = settings.read('user');
  const later = new Date(Date.now() + 9000);
  fs.utimesSync(userFile(), later, later);
  assert.throws(() => settings.restore('user', null, oldest.name, now.mtimeMs), (err) => err.status === 409, 'refused: the file changed since it was loaded');
  const restored = settings.restore('user', null, oldest.name, settings.read('user').mtimeMs);
  assert.strictEqual(restored.text, '{"model":"opus"}\n');
  assert.throws(() => settings.restore('user', null, '..\\secret.json'), /Invalid backup name/);
  assert.throws(() => settings.restore('user', null, 'source.txt'), /Invalid backup name/, 'not a backup, though it is in the folder');
});

test('a file that appeared after the editor found none is not overwritten', () => {
  const proj = path.join(box.root, 'appeared');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  const r = settings.read('project', proj);
  assert.strictEqual(r.mtimeMs, null);
  fs.writeFileSync(r.path, '{"from":"claude"}');
  assert.throws(() => settings.write('project', proj, '{}', r.mtimeMs, false), (err) => err.status === 409);
  assert.strictEqual(fs.readFileSync(r.path, 'utf8'), '{"from":"claude"}');
});

test("saving keeps the file's byte-order mark and Windows line endings", () => {
  const proj = path.join(box.root, 'format');
  fs.mkdirSync(proj);
  const file = path.join(proj, 'CLAUDE.md');
  fs.writeFileSync(file, '﻿# Notes\r\nold\r\n');
  const r = settings.read('memory-project', proj);
  assert.strictEqual(r.text, '# Notes\r\nold\r\n');
  settings.write('memory-project', proj, '# Notes\nnew\n', r.mtimeMs, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '﻿# Notes\r\nnew\r\n');
});

test('saving through a symbolic link writes the file it points to and keeps the link', { skip: process.platform !== 'win32' }, (t) => {
  const real = path.join(box.root, 'dotfiles-settings.json');
  fs.writeFileSync(real, '{}');
  const proj = path.join(box.root, 'linked');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  const link = path.join(proj, '.claude', 'settings.json');
  try { fs.symlinkSync(real, link, 'file'); } catch (err) { return t.skip(`can't make symbolic links here (${err.code})`); }
  settings.write('project', proj, '{"a":1}', settings.read('project', proj).mtimeMs, false);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'still a link');
  assert.strictEqual(fs.readFileSync(real, 'utf8'), '{"a":1}');
});

test('project scopes need an existing folder and write under .claude', () => {
  assert.throws(() => settings.read('project', ''), /project folder/);
  assert.throws(() => settings.read('project', path.join(box.root, 'missing')), /not found/);
  const proj = path.join(box.root, 'proj');
  fs.mkdirSync(proj);
  const w = settings.write('local', proj, '{}', null, false);
  assert.strictEqual(w.path, path.join(proj, '.claude', 'settings.local.json'));
  const mem = settings.write('memory-project', proj, '# Notes\n', null, false);
  assert.strictEqual(mem.path, path.join(proj, 'CLAUDE.md'));
  assert.strictEqual(mem.kind, 'text');
});
