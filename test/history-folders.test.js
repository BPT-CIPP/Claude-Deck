'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const folders = require('../src/history-folders');

test.after(() => box.cleanup());

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const sessions = [
  { sessionId: A, cwd: 'C:\\work\\demo', title: 'Demo' },
  { sessionId: B, cwd: 'C:\\work\\other', title: 'Other' },
  { sessionId: 'cccccccc-3333-4333-8333-333333333333', cwd: null, title: 'No folder' },
];

test('a conversation is filed where it was started until it is moved, and can be put back', () => {
  assert.deepStrictEqual(folders.annotate(sessions).map((m) => [m.folder, m.movedFrom]), [['C:\\work\\demo', null], ['C:\\work\\other', null], [null, null]]);
  folders.set(A, 'C:\\work\\other');
  let list = folders.annotate(sessions);
  assert.deepStrictEqual([list[0].folder, list[0].movedFrom], ['C:\\work\\other', 'C:\\work\\demo']);
  assert.deepStrictEqual([list[1].folder, list[1].movedFrom], ['C:\\work\\other', null], 'the others are untouched');
  assert.strictEqual(list[0].cwd, 'C:\\work\\demo', 'where it resumes from is unchanged');
  // The same folder, differently cased: Windows paths, so not a move.
  folders.set(A, 'c:\\WORK\\demo');
  list = folders.annotate(sessions);
  assert.strictEqual(list[0].movedFrom, null);
  folders.set(A, null);
  assert.deepStrictEqual(folders.load(), {});
  assert.deepStrictEqual(folders.annotate(sessions)[0].folder, 'C:\\work\\demo');
});

test('only a real session id and a full folder path are accepted', () => {
  assert.throws(() => folders.set('nope', 'C:\\x'), /Invalid session ID/);
  assert.throws(() => folders.set(A, 'relative\\path'), /Choose a folder/);
  assert.throws(() => folders.set(A, 42), /Choose a folder/);
  // A file edited by hand: entries that aren't an id and a path are left out.
  fs.writeFileSync(path.join(box.dataDir, 'history-folders.json'), JSON.stringify({ [A]: 'C:\\kept', nope: 'C:\\x', [B]: 7 }));
  assert.deepStrictEqual(folders.load(), { [A]: 'C:\\kept' });
  fs.writeFileSync(path.join(box.dataDir, 'history-folders.json'), '[1, 2]');
  assert.deepStrictEqual(folders.load(), {});
});

test('notes for conversations that are gone are forgotten', () => {
  folders.set(A, 'C:\\work\\other');
  folders.set(B, 'C:\\work\\demo');
  assert.deepStrictEqual(Object.keys(folders.prune([B])), [B]);
  assert.deepStrictEqual(Object.keys(folders.load()), [B]);
  folders.set(B, null);
});
