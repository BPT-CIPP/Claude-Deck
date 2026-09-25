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

test('the trash is emptied of conversations deleted more than 30 days ago', () => {
  const { trashId } = trash.trashSession(SID, transcript);
  const dir = path.join(box.dataDir, 'trash', trashId);
  assert.strictEqual(trash.purgeOld(), 0);
  const inTrash = fs.readdirSync(path.join(box.dataDir, 'trash')).length;
  assert.ok(inTrash >= 1);
  assert.strictEqual(trash.purgeOld(Date.now() + 31 * 86400000), inTrash);
  assert.ok(!fs.existsSync(dir));
});
