'use strict';
// src/recycle.js: what may go to the Recycle Bin. The Recycle Bin call itself is replaced with one
// that removes the folder, so nothing here reaches the real Recycle Bin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const recycle = require('../src/recycle');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deck-recycle-'));
// Removes the folder, as the Recycle Bin would: only ever pointed at scratch folders made here.
const fakeBin = (calls) => async (full) => { calls.push(full); fs.rmSync(full, { recursive: true, force: true }); };
// Only notes the call, touching nothing: for every case that must be refused, so a broken check
// fails the test instead of removing a real folder.
const noteOnly = (calls) => async (full) => { calls.push(full); };

test('a folder (and what is in it) goes to the Recycle Bin', async () => {
  const dir = path.join(scratch(), 'old project');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'x');
  const calls = [];
  assert.deepStrictEqual(await recycle.recycleFolder(dir, { run: fakeBin(calls) }), { recycled: dir });
  assert.deepStrictEqual(calls, [dir]);
  assert.ok(!fs.existsSync(dir));
});

test('folders Windows, Claude Code or Claude Deck need are refused, and so is anything holding them', async () => {
  const calls = [];
  for (const p of [os.homedir(), path.dirname(os.homedir()), process.env.SystemRoot || 'C:\\Windows', path.resolve(__dirname, '..'), path.parse(os.tmpdir()).root]) {
    await assert.rejects(recycle.recycleFolder(p, { run: noteOnly(calls) }), /needs|holds|whole drive/, p);
  }
  assert.deepStrictEqual(calls, [], 'the Recycle Bin call never ran');
});

test('a folder a session is open in (or under) is refused', async () => {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, 'app'));
  const calls = [];
  await assert.rejects(recycle.recycleFolder(dir, { openIn: [path.join(dir, 'app')], run: noteOnly(calls) }), /session is open/);
  await assert.rejects(recycle.recycleFolder(dir, { openIn: [dir.toUpperCase()], run: noteOnly(calls) }), /session is open in this folder/);
  assert.deepStrictEqual(calls, []);
  assert.ok(fs.existsSync(dir));
});

test('a missing folder, a file, a relative path and a link are refused', async () => {
  const dir = scratch();
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, 'x');
  const calls = [];
  await assert.rejects(recycle.recycleFolder(path.join(dir, 'nope'), { run: noteOnly(calls) }), /not found/);
  await assert.rejects(recycle.recycleFolder(file, { run: noteOnly(calls) }), /isn't a folder/);
  await assert.rejects(recycle.recycleFolder('relative\\folder', { run: noteOnly(calls) }), /Choose a folder/);
  const target = path.join(dir, 'target');
  fs.mkdirSync(target);
  const link = path.join(dir, 'link');
  fs.symlinkSync(target, link, 'junction');
  await assert.rejects(recycle.recycleFolder(link, { run: noteOnly(calls) }), /link to another folder/);
  assert.deepStrictEqual(calls, []);
});

test('a folder with a file open in it is refused before the Recycle Bin call', async (t) => {
  const dir = scratch();
  const file = path.join(dir, 'open.txt');
  fs.writeFileSync(file, 'x');
  const fd = fs.openSync(file, 'r');
  t.after(() => fs.closeSync(fd));
  const calls = [];
  await assert.rejects(recycle.recycleFolder(dir, { run: noteOnly(calls) }), /in use/);
  assert.deepStrictEqual(calls, []);
  assert.ok(fs.existsSync(file));
});
