'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const { listDir, makeDir } = require('../src/folders');

test.after(() => box.cleanup());

const root = path.join(box.root, 'browse');
fs.mkdirSync(root);
for (const d of ['beta', 'Alpha', 'item10', 'item2']) fs.mkdirSync(path.join(root, d));
fs.writeFileSync(path.join(root, 'file.txt'), 'x');

test('lists only subfolders, sorted naturally, with the parent', async () => {
  const r = await listDir(root);
  assert.strictEqual(r.path, root);
  assert.strictEqual(r.parent, box.root);
  assert.deepStrictEqual(r.entries.map((e) => e.name), ['Alpha', 'beta', 'item2', 'item10']);
  assert.strictEqual(r.entries[0].path, path.join(root, 'Alpha'));
});

test('an empty path lists drives; a drive root has no parent folder', async () => {
  const r = await listDir('');
  assert.strictEqual(r.parent, null);
  assert.ok(r.entries.some((e) => /^[A-Z]:\\$/.test(e.name)), 'at least one drive');
  assert.ok(Array.isArray(r.places));
  const drive = await listDir(r.entries[0].path);
  assert.strictEqual(drive.parent, '', 'going up from a drive shows the drive list');
});

test('rejects relative and missing paths', async () => {
  await assert.rejects(() => listDir('relative\\path'), /full folder path/);
  await assert.rejects(() => listDir(path.join(root, 'nope')), (e) => e.status === 404);
});

test('creates a folder and refuses bad or duplicate names', () => {
  const r = makeDir(root, 'New project');
  assert.ok(fs.statSync(r.path).isDirectory());
  assert.throws(() => makeDir(root, 'New project'), (e) => e.status === 409);
  for (const bad of ['', '..', 'a/b', 'a:b', 'con', 'trailing.', 'what?']) {
    assert.throws(() => makeDir(root, bad), `rejects "${bad}"`);
  }
  assert.throws(() => makeDir('relative', 'x'), /Open the folder/);
});
