'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox, line } = require('./helpers');

const box = sandbox();
const { HistoryIndex } = require('../src/history');
const { Timeline, diffLines, toHunks } = require('../src/timeline');

// A session in the on-disk shape Claude Code writes (claude.exe 2.1.281):
//   turn A: creates notes.txt, edits app.js ("line2" -> "line2 changed")
//   turn B: edits app.js again (adds "line3"); notes.txt untouched
const SID = '22222222-3333-4444-8555-666666666666';
const proj = path.join(box.root, 'proj');
fs.mkdirSync(proj);
const fh = path.join(box.claudeDir, 'file-history', SID);
fs.mkdirSync(fh, { recursive: true });
fs.writeFileSync(path.join(fh, 'aaaa@v1'), 'line1\nline2\n'); // app.js before turn A
fs.writeFileSync(path.join(fh, 'aaaa@v2'), 'line1\nline2 changed\n'); // app.js before turn B
fs.writeFileSync(path.join(fh, 'bbbb@v2'), 'hello\n'); // notes.txt before turn B
fs.writeFileSync(path.join(proj, 'app.js'), 'line1\nline2 changed\nline3\n'); // now
fs.writeFileSync(path.join(proj, 'notes.txt'), 'hello\n');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const rel = (name, backupFileName, version) => ({ backupFileName, version, realParentDir: proj });
const edit = (name, file) => line({ type: 'assistant', cwd: proj, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${name}-${file}`, name, input: { file_path: path.join(proj, file) } }] } });
const tdir = path.join(box.claudeDir, 'projects', 'C--proj');
fs.mkdirSync(tdir, { recursive: true });
fs.writeFileSync(path.join(tdir, `${SID}.jsonl`), [
  line({ type: 'user', uuid: A, sessionId: SID, cwd: proj, message: { role: 'user', content: 'Make the notes file' }, timestamp: '2026-09-24T10:00:00Z' }),
  line({ type: 'file-history-snapshot', messageId: A, snapshot: { messageId: A, trackedFileBackups: {} } }),
  edit('Write', 'notes.txt'),
  line({ type: 'file-history-delta', messageId: 'm1', snapshotMessageId: A, trackingPath: 'notes.txt', backup: rel('notes.txt', null, 1) }),
  edit('Edit', 'app.js'),
  line({ type: 'file-history-delta', messageId: 'm2', snapshotMessageId: A, trackingPath: 'app.js', backup: rel('app.js', 'aaaa@v1', 1) }),
  line({ type: 'user', uuid: B, sessionId: SID, cwd: proj, message: { role: 'user', content: 'Add line3' }, timestamp: '2026-09-24T10:05:00Z' }),
  line({ type: 'file-history-snapshot', messageId: B, snapshot: { messageId: B, trackedFileBackups: { 'notes.txt': rel('notes.txt', 'bbbb@v2', 2), 'app.js': rel('app.js', 'aaaa@v2', 2) } } }),
  edit('Edit', 'app.js'),
].join(''));

// A second session where x.txt also changes outside Claude's edit tools:
//   turn 1: Claude creates x.txt ("claude")   then, by hand: "hand"
//   turn 2: no edits                          then, by hand: "hand 2"
//   turn 3: no edits                          then, by hand: "hand 3" (on disk now)
const SID2 = '33333333-4444-4555-8666-777777777777';
const fh2 = path.join(box.claudeDir, 'file-history', SID2);
fs.mkdirSync(fh2, { recursive: true });
fs.writeFileSync(path.join(fh2, 'xxxx@v2'), 'hand\n');
fs.writeFileSync(path.join(fh2, 'xxxx@v3'), 'hand 2\n');
fs.writeFileSync(path.join(proj, 'x.txt'), 'hand 3\n');
const [T1, T2, T3] = ['11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000003'];
fs.writeFileSync(path.join(tdir, `${SID2}.jsonl`), [
  line({ type: 'user', uuid: T1, sessionId: SID2, cwd: proj, message: { role: 'user', content: 'Make x' } }),
  line({ type: 'file-history-snapshot', messageId: T1, snapshot: { messageId: T1, trackedFileBackups: {} } }),
  edit('Write', 'x.txt'),
  line({ type: 'file-history-delta', messageId: 'n1', snapshotMessageId: T1, trackingPath: 'x.txt', backup: rel('x.txt', null, 1) }),
  line({ type: 'user', uuid: T2, sessionId: SID2, cwd: proj, message: { role: 'user', content: 'Just talk' } }),
  line({ type: 'file-history-snapshot', messageId: T2, snapshot: { messageId: T2, trackedFileBackups: { 'x.txt': rel('x.txt', 'xxxx@v2', 2) } } }),
  line({ type: 'user', uuid: T3, sessionId: SID2, cwd: proj, message: { role: 'user', content: 'Talk more' } }),
  line({ type: 'file-history-snapshot', messageId: T3, snapshot: { messageId: T3, trackedFileBackups: { 'x.txt': rel('x.txt', 'xxxx@v3', 3) } } }),
].join(''));

let tl;
test.before(async () => {
  const history = new HistoryIndex();
  await history.refresh();
  tl = new Timeline({ history });
});
test.after(() => box.cleanup());

test('lists each turn with the files it changed, newest first', () => {
  const t = tl.list(SID);
  assert.strictEqual(t.checkpoints, true);
  assert.deepStrictEqual(t.turns.map((x) => x.prompt), ['Add line3', 'Make the notes file']);
  const [b, a] = t.turns;
  assert.deepStrictEqual(b.files.map((f) => [f.rel, f.change, f.added, f.removed]), [['app.js', 'edited', 1, 0]], 'turn B only touched app.js');
  assert.deepStrictEqual(a.files.map((f) => [f.rel, f.change, f.added, f.removed]), [['app.js', 'edited', 1, 1], ['notes.txt', 'created', 1, 0]]);
  assert.strictEqual(b.latest, true);
  assert.strictEqual(path.join(proj, 'app.js'), b.files[0].path, 'relative keys resolve to the real file');
});

test('diffs show the lines a turn changed', () => {
  const d = tl.diff(SID, A, 'app.js');
  assert.deepStrictEqual(d.hunks[0].lines.map((l) => `${l.t}${l.s}`), [' line1', '-line2', '+line2 changed']);
  const created = tl.diff(SID, A, 'notes.txt');
  assert.deepStrictEqual(created.hunks[0].lines.filter((l) => l.t === '+').map((l) => l.s), ['hello']);
});

test('restoring to before a turn undoes it and everything after, and can be undone', () => {
  assert.deepStrictEqual(tl.plan(SID, B).map((p) => [path.basename(p.path), p.action]), [['app.js', 'restore']]);
  const plan = tl.plan(SID, A);
  assert.deepStrictEqual(plan.map((p) => [path.basename(p.path), p.action]), [['app.js', 'restore'], ['notes.txt', 'delete']]);

  const r = tl.restore(SID, A);
  assert.strictEqual(r.restored, 2);
  assert.strictEqual(fs.readFileSync(path.join(proj, 'app.js'), 'utf8'), 'line1\nline2\n');
  assert.ok(!fs.existsSync(path.join(proj, 'notes.txt')), 'the file created in turn A is gone');
  assert.deepStrictEqual(tl.plan(SID, A), [], 'nothing left to restore');

  tl.undo(r.undoId);
  assert.strictEqual(fs.readFileSync(path.join(proj, 'app.js'), 'utf8'), 'line1\nline2 changed\nline3\n');
  assert.strictEqual(fs.readFileSync(path.join(proj, 'notes.txt'), 'utf8'), 'hello\n');
  assert.throws(() => tl.undo(r.undoId), /no longer be undone/);
});

test('a restore that fails partway puts back the files it already restored', (t) => {
  const app = path.join(proj, 'app.js');
  const notes = path.join(proj, 'notes.txt');
  const before = [fs.readFileSync(app, 'utf8'), fs.readFileSync(notes, 'utf8')];
  // app.js is restored first (sorted by path); deleting notes.txt then fails, as a locked file would.
  const realRm = fs.rmSync;
  t.mock.method(fs, 'rmSync', (p, o) => {
    if (p === notes) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return realRm(p, o);
  });
  assert.throws(() => tl.restore(SID, A), (e) => e.status === 409 && /nothing was restored/.test(e.message));
  t.mock.restoreAll();
  assert.deepStrictEqual([fs.readFileSync(app, 'utf8'), fs.readFileSync(notes, 'utf8')], before, 'both files as they were');
});

test('Undo refuses to overwrite a file that changed after the restore', () => {
  const app = path.join(proj, 'app.js');
  const r = tl.restore(SID, B);
  fs.writeFileSync(app, 'kept working on this\n');
  assert.throws(() => tl.undo(r.undoId), (e) => e.status === 409 && /changed since the restore/.test(e.message));
  assert.strictEqual(fs.readFileSync(app, 'utf8'), 'kept working on this\n', 'the newer work is untouched');
  // Once it's back to what the restore left, Undo works.
  fs.writeFileSync(app, 'line1\nline2 changed\n');
  tl.undo(r.undoId);
  assert.strictEqual(fs.readFileSync(app, 'utf8'), 'line1\nline2 changed\nline3\n');
});

test('a file that cannot be read stops the restore before anything changes', () => {
  // A folder where the file should be: reading it fails with something other than "not found".
  const notes = path.join(proj, 'notes.txt');
  fs.renameSync(notes, `${notes}.bak`);
  fs.mkdirSync(notes);
  try {
    assert.throws(() => tl.plan(SID, A), (e) => e.status === 409 && /can't read/.test(e.message));
    assert.strictEqual(fs.readFileSync(path.join(proj, 'app.js'), 'utf8'), 'line1\nline2 changed\nline3\n', 'nothing was written');
  } finally {
    fs.rmdirSync(notes);
    fs.renameSync(`${notes}.bak`, notes);
  }
});

test('changes made outside Claude are marked, and never blamed on the latest turn', () => {
  const t = tl.list(SID2);
  const byPrompt = Object.fromEntries(t.turns.map((x) => [x.prompt, x.files.map((f) => [f.rel, f.change, f.outside])]));
  assert.deepStrictEqual(byPrompt['Make x'], [['x.txt', 'created', false]], 'Claude wrote it: its own change');
  assert.deepStrictEqual(byPrompt['Just talk'], [['x.txt', 'edited', true]], 'changed between snapshots without an edit tool');
  assert.deepStrictEqual(byPrompt['Talk more'], [], 'the latest turn is compared with the disk, so a hand edit is left out');
  assert.deepStrictEqual(tl.plan(SID2, T3).map((p) => p.action), ['restore'], 'restoring still puts the file back');
});

test('line diff handles edits in the middle and far-apart changes', () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const b = [...a];
  b[2] = 'X';
  b[17] = 'Y';
  const hunks = toHunks(diffLines(a, b));
  assert.strictEqual(hunks.length, 2, 'far-apart changes get separate hunks');
  assert.deepStrictEqual(hunks[0].lines.map((l) => l.o), [1, 2, 3, null, 4, 5, 6]);
  assert.deepStrictEqual(diffLines(['a'], ['a']).map((o) => o[0]), ['=']);
});
