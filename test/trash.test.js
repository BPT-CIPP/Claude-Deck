'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox, line } = require('./helpers');

const box = sandbox();
const { HistoryIndex } = require('../src/history');
const trash = require('../src/trash');

const SID = '44444444-5555-4666-8777-888888888888';
const OTHER = '55555555-6666-4777-8888-999999999999';
const proj = path.join(box.claudeDir, 'projects', 'C--work');
fs.mkdirSync(proj, { recursive: true });
const transcript = path.join(proj, `${SID}.jsonl`);
const convo = (id) => [line({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd: 'C:\\work', message: { role: 'user', content: 'Fix the build' }, timestamp: '2026-09-25T10:00:00Z' })].join('');
fs.writeFileSync(transcript, convo(SID));
fs.writeFileSync(path.join(proj, `${OTHER}.jsonl`), convo(OTHER));
// The other things Claude Code keeps per conversation.
const sideDir = path.join(proj, SID, 'tool-results');
fs.mkdirSync(sideDir, { recursive: true });
fs.writeFileSync(path.join(sideDir, 'r1.txt'), 'output');
const fileHistory = path.join(box.claudeDir, 'file-history', SID);
fs.mkdirSync(fileHistory, { recursive: true });
fs.writeFileSync(path.join(fileHistory, 'abc@v1'), 'backup');
const sessionEnv = path.join(box.claudeDir, 'session-env', SID);
fs.mkdirSync(sessionEnv, { recursive: true });

test.after(() => box.cleanup());

test('deleting moves everything kept for that conversation to the trash, and Undo puts it back', async () => {
  const history = new HistoryIndex();
  await history.refresh();
  assert.ok(history.get(SID) && history.get(OTHER));

  const { trashId, moved } = trash.trashSession(SID, history.fileFor(SID), { title: 'Fix the build' });
  assert.strictEqual(moved, 4);
  for (const p of [transcript, path.join(proj, SID), fileHistory, sessionEnv]) assert.ok(!fs.existsSync(p), `${p} is gone`);
  assert.ok(fs.existsSync(path.join(proj, `${OTHER}.jsonl`)), 'other conversations are untouched');
  await history.refresh();
  assert.strictEqual(history.get(SID), null, 'gone from History');
  assert.ok(history.get(OTHER));

  const r = trash.restore(trashId);
  assert.deepStrictEqual(r, { sessionId: SID, restored: 4 });
  assert.strictEqual(fs.readFileSync(transcript, 'utf8'), convo(SID));
  assert.strictEqual(fs.readFileSync(path.join(sideDir, 'r1.txt'), 'utf8'), 'output');
  assert.strictEqual(fs.readFileSync(path.join(fileHistory, 'abc@v1'), 'utf8'), 'backup');
  assert.ok(fs.existsSync(sessionEnv));
  await history.refresh();
  assert.ok(history.get(SID), 'back in History');
  assert.throws(() => trash.restore(trashId), /no longer in the trash/);
});

test('Undo will not overwrite something that has appeared in the conversation\'s place', () => {
  const { trashId } = trash.trashSession(OTHER, path.join(proj, `${OTHER}.jsonl`));
  fs.writeFileSync(path.join(proj, `${OTHER}.jsonl`), 'new');
  assert.throws(() => trash.restore(trashId), /already exists/);
  assert.strictEqual(fs.readFileSync(path.join(proj, `${OTHER}.jsonl`), 'utf8'), 'new');
});

test('only transcripts where Claude Code keeps them can be deleted', () => {
  const stray = path.join(box.root, `${SID}.jsonl`);
  fs.writeFileSync(stray, 'x');
  assert.throws(() => trash.trashSession(SID, stray), /not where Claude Code keeps/);
  assert.throws(() => trash.trashSession('../../etc', transcript), /Invalid session ID/);
  assert.throws(() => trash.trashSession(OTHER, transcript), /not where Claude Code keeps/, 'the file must be named after the session');
  assert.ok(fs.existsSync(stray) && fs.existsSync(transcript));
});

// Every file of the conversation, with its content, to check nothing was lost.
const snapshot = () => [transcript, path.join(sideDir, 'r1.txt'), path.join(fileHistory, 'abc@v1')].map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null)).concat(fs.existsSync(sessionEnv));
const realRename = fs.renameSync;
const realRm = fs.rmSync;
const realCp = fs.cpSync;
const busy = (p) => Object.assign(new Error(`EBUSY: resource busy or locked, '${p}'`), { code: 'EBUSY' });
// As if the data folder were on another drive: every move is a copy, then removing the original.
// (Claude Deck's own manifest writes, a rename within the trash, still work.)
const acrossDrives = (t) => t.mock.method(fs, 'renameSync', (a, b) => {
  if (a.endsWith('.tmp')) return realRename(a, b);
  throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
});

test('across drives, an original that cannot be removed is put back whole, and nothing is lost', (t) => {
  const before = snapshot();
  acrossDrives(t);
  // Removing the original gets partway (one file gone) before a locked file stops it.
  t.mock.method(fs, 'rmSync', (p, o) => {
    if (p === fileHistory) { realRm(path.join(fileHistory, 'abc@v1')); throw busy(p); }
    return realRm(p, o);
  });
  assert.throws(() => trash.trashSession(SID, transcript), (e) => e.status === 409 && /in use/.test(e.message));
  t.mock.restoreAll();
  assert.deepStrictEqual(snapshot(), before);
});

test('what cannot be put back after a failed delete stays in the trash, and Undo restores it', (t) => {
  const before = snapshot();
  acrossDrives(t);
  t.mock.method(fs, 'rmSync', (p, o) => { if (p === sessionEnv) throw busy(p); return realRm(p, o); });
  t.mock.method(fs, 'cpSync', (a, b, o) => { if (b === transcript) throw busy(b); return realCp(a, b, o); });
  assert.throws(() => trash.trashSession(SID, transcript), (e) => e.status === 409 && /Nothing is lost/.test(e.message));
  t.mock.restoreAll();
  assert.ok(!fs.existsSync(transcript), 'the transcript could not be put back');
  const trashRoot = path.join(box.dataDir, 'trash');
  const kept = fs.readdirSync(trashRoot).find((n) => (JSON.parse(fs.readFileSync(path.join(trashRoot, n, 'manifest.json'), 'utf8')).items || []).some((it) => it.from === transcript));
  assert.ok(kept, 'kept in the trash with a manifest');
  trash.restore(kept);
  assert.deepStrictEqual(snapshot(), before);
});

test('an Undo that fails partway can be tried again and finishes', (t) => {
  const before = snapshot();
  const { trashId } = trash.trashSession(SID, transcript);
  const dir = path.join(box.dataDir, 'trash', trashId);
  t.mock.method(fs, 'renameSync', (a, b) => { if (a === path.join(dir, '2')) throw busy(a); return realRename(a, b); });
  assert.throws(() => trash.restore(trashId), (e) => e.status === 409 && /try Undo again/.test(e.message));
  t.mock.restoreAll();
  assert.ok(fs.existsSync(transcript), 'the first items are back');
  trash.restore(trashId);
  assert.deepStrictEqual(snapshot(), before);
  assert.throws(() => trash.restore('..'), /Invalid trash ID/);
});

test('the trash is emptied of conversations deleted more than 30 days ago', () => {
  const { trashId } = trash.trashSession(SID, transcript);
  const dir = path.join(box.dataDir, 'trash', trashId);
  assert.strictEqual(trash.purgeOld(), 0);
  const inTrash = fs.readdirSync(path.join(box.dataDir, 'trash')).length;
  assert.ok(inTrash >= 1);
  assert.strictEqual(trash.purgeOld(Date.now() + 31 * 86400000), inTrash);
  assert.ok(!fs.existsSync(dir));
});
