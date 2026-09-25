'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox, line } = require('./helpers');

const box = sandbox();
const { HistoryIndex, readTranscript, promptText } = require('../src/history');

const SID = '11111111-2222-4333-8444-555555555555';
const projDir = path.join(box.claudeDir, 'projects', 'C--work-demo');
const file = path.join(projDir, `${SID}.jsonl`);
fs.mkdirSync(projDir, { recursive: true });

const base = { sessionId: SID, cwd: 'C:\\work\\demo', gitBranch: 'main', version: '2.1.280' };
fs.writeFileSync(file, [
  line({ ...base, type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' }, timestamp: '2026-09-20T10:00:00.000Z' }),
  line({ ...base, type: 'user', message: { role: 'user', content: 'Fix the login bug' }, timestamp: '2026-09-20T10:00:01.000Z' }),
  line({ ...base, type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5', content: [{ type: 'thinking', thinking: '' }] }, timestamp: '2026-09-20T10:00:02.000Z' }),
  line({ ...base, type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5', content: [{ type: 'text', text: 'Looking at `auth.js` now.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'C:\\work\\demo\\auth.js' } }] }, timestamp: '2026-09-20T10:00:03.000Z' }),
  line({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'file text' }] }, timestamp: '2026-09-20T10:00:04.000Z' }),
  line({ ...base, type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' }, timestamp: '2026-09-20T10:00:05.000Z' }),
  line({ type: 'ai-title', aiTitle: 'Login bug fix', sessionId: SID }),
  line({ type: 'cost-state', sessionId: SID, totalCostUSD: 1.25 }),
].join(''));

test.after(() => box.cleanup());

test('promptText skips tool results, wrappers and interruptions', () => {
  assert.strictEqual(promptText({ content: 'hello' }), 'hello');
  assert.strictEqual(promptText({ content: [{ type: 'text', text: ' hi ' }] }), 'hi');
  assert.strictEqual(promptText({ content: [{ type: 'tool_result', content: 'x' }] }), null);
  assert.strictEqual(promptText({ content: '<command-name>/clear</command-name>' }), null);
  assert.strictEqual(promptText({ content: '[Request interrupted by user]' }), null);
});

test('promptText keeps prompts that are only images', () => {
  assert.strictEqual(promptText({ content: [{ type: 'image', source: {} }] }), '[1 image]');
  assert.strictEqual(promptText({ content: [{ type: 'image' }, { type: 'image' }] }), '[2 images]');
  assert.strictEqual(promptText({ content: [{ type: 'image' }, { type: 'text', text: 'what is this' }] }), 'what is this');
});

test('indexes a transcript into a summary', async () => {
  const idx = new HistoryIndex();
  await idx.refresh();
  const m = idx.get(SID);
  assert.ok(m, 'session indexed');
  assert.strictEqual(m.cwd, 'C:\\work\\demo');
  assert.strictEqual(m.gitBranch, 'main');
  assert.strictEqual(m.userTurns, 1, 'only the real prompt counts');
  assert.strictEqual(m.assistantTurns, 1, 'lines sharing a message id count once');
  assert.strictEqual(m.firstPrompt, 'Fix the login bug');
  assert.strictEqual(m.title, 'Login bug fix');
  assert.strictEqual(m.costUSD, 1.25);
  assert.strictEqual(m.model, 'claude-opus-5');
  assert.strictEqual(m.startedAt, Date.parse('2026-09-20T10:00:00.000Z'));
  assert.strictEqual(idx.list().length, 1);
});

test('picks up appended lines incrementally and ignores a half-written line', async () => {
  const idx = new HistoryIndex();
  await idx.refresh();
  fs.appendFileSync(file, line({ ...base, type: 'user', message: { role: 'user', content: 'Now add a test' }, timestamp: '2026-09-20T11:00:00.000Z' }));
  fs.appendFileSync(file, '{"type":"custom-title","customTitle":"Renamed","sessionId"');
  await idx.refresh();
  let m = idx.get(SID);
  assert.strictEqual(m.userTurns, 2);
  assert.strictEqual(m.lastPrompt, 'Now add a test');
  assert.strictEqual(m.title, 'Login bug fix', 'partial custom-title line not applied yet');

  fs.appendFileSync(file, `:"${SID}"}\n`);
  await idx.refresh();
  m = idx.get(SID);
  assert.strictEqual(m.title, 'Renamed', 'custom title wins once the line is complete');
  assert.strictEqual(m.userTurns, 2, 'earlier lines not double counted');
});

test('rescans from scratch when a file shrinks', async () => {
  const idx = new HistoryIndex();
  await idx.refresh();
  fs.writeFileSync(file, line({ ...base, type: 'user', message: { role: 'user', content: 'Only prompt' }, timestamp: '2026-09-21T09:00:00.000Z' }));
  await idx.refresh();
  const m = idx.get(SID);
  assert.strictEqual(m.userTurns, 1);
  assert.strictEqual(m.firstPrompt, 'Only prompt');
  assert.strictEqual(m.aiTitle, null);
});

test('cache survives a new index instance', async () => {
  const a = new HistoryIndex();
  await a.refresh();
  a.saveNow();
  const b = new HistoryIndex();
  assert.ok(b.get(SID), 'loaded from cache without a refresh');
});

test('readTranscript returns prompts, assistant text and tool calls', async () => {
  fs.writeFileSync(file, [
    line({ ...base, type: 'user', message: { role: 'user', content: 'Hi' }, timestamp: '2026-09-20T10:00:01.000Z' }),
    line({ ...base, type: 'assistant', message: { id: 'm', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Hello' }, { type: 'tool_use', name: 'Bash', input: { command: 'git status' } }] } }),
  ].join(''));
  const items = await readTranscript(file, 50);
  assert.deepStrictEqual(items.map((i) => i.kind), ['user', 'assistant', 'tool']);
  assert.strictEqual(items[2].detail, 'git status');
  assert.ok(!JSON.stringify(items).includes('secret'), 'thinking is not exposed');
});
