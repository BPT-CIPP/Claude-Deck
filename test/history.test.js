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
  assert.strictEqual(promptText({ content: '<local-command-stdout>done</local-command-stdout>' }), null);
  assert.strictEqual(promptText({ content: '<task-notification>\n<task-id>x</task-id>' }), null);
});

test("promptText keeps the person's own prompts that start with <", () => {
  assert.strictEqual(promptText({ content: "<Button> doesn't render" }), "<Button> doesn't render");
  assert.strictEqual(promptText({ content: '<div class="x">fix this</div>' }), '<div class="x">fix this</div>');
  assert.strictEqual(promptText({ content: '<pasted_content id="1">the log</pasted_content>\nwhat broke?' }), 'the log\nwhat broke?', 'pasted text, without its wrapper');
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

test('counts token usage per conversation and per hour, subagents included, with the context size', async () => {
  const SID2 = '22222222-3333-4444-8555-666666666666';
  const dir = path.join(box.claudeDir, 'projects', 'C--work-usage');
  fs.mkdirSync(path.join(dir, SID2, 'subagents'), { recursive: true });
  const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
  const u = (input, output, cacheRead) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 });
  const b2 = { sessionId: SID2, cwd: 'C:\\work\\usage' };
  fs.writeFileSync(path.join(dir, `${SID2}.jsonl`), [
    line({ ...b2, type: 'user', message: { role: 'user', content: 'Count my tokens' }, timestamp: at(30 * 24) }),
    // A month ago: counts toward the total, not toward this week.
    line({ ...b2, type: 'assistant', message: { id: 'old', model: 'claude-opus-5', usage: u(1000, 0, 0), content: [] }, timestamp: at(30 * 24) }),
    // One API message split over two records: counted once, the latest record winning.
    line({ ...b2, type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', usage: u(10, 5, 100), content: [{ type: 'thinking', thinking: '' }] }, timestamp: at(2) }),
    line({ ...b2, type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', usage: u(10, 50, 100), content: [{ type: 'text', text: 'Done.' }] }, timestamp: at(2) }),
    // Claude Code's own synthetic messages are not API usage.
    line({ ...b2, type: 'assistant', message: { id: 's1', model: '<synthetic>', usage: u(0, 0, 0), content: [] }, timestamp: at(1) }),
    line({ type: 'cost-state', sessionId: SID2, totalCostUSD: 0.5, modelUsage: { 'claude-opus-5': { inputTokens: 1010, outputTokens: 50, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 } } }),
  ].join(''));
  fs.writeFileSync(path.join(dir, SID2, 'subagents', 'agent-a1.jsonl'),
    line({ isSidechain: true, sessionId: SID2, type: 'assistant', message: { id: 'sub1', model: 'claude-haiku', usage: u(200, 20, 0), content: [] }, timestamp: at(1) }));

  const idx = new HistoryIndex();
  await idx.refresh();
  const m = idx.get(SID2);
  assert.deepStrictEqual(m.tokens, { input: 1010, output: 50, cacheRead: 100, cacheWrite: 0 });
  assert.strictEqual(m.contextTokens, 160, 'the latest reply: input + cache + output');
  assert.deepStrictEqual(m.costState, { costUSD: 0.5, input: 1010, output: 50, cacheRead: 100, cacheWrite: 0 });
  assert.ok(!('tokenHours' in m), 'hourly counts stay on the server');
  assert.deepStrictEqual(idx.tokensFor(SID2), m.tokens, 'subagents are read only when asked for');

  await idx.refreshSubagents([SID2]);
  assert.deepStrictEqual(idx.tokensFor(SID2), { input: 1210, output: 70, cacheRead: 100, cacheWrite: 0 });
  const week = idx.usageSince(Date.now() - 7 * 24 * 3600000);
  assert.deepStrictEqual(week.map((r) => [r.sessionId, r.tokens]), [[SID2, 160 + 220]], 'this week only, subagents included');
  assert.strictEqual(week[0].meta.title, 'Count my tokens');

  fs.appendFileSync(path.join(dir, `${SID2}.jsonl`), line({ ...b2, type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 160, postTokens: 40 }, timestamp: at(0) }));
  await idx.refresh();
  assert.strictEqual(idx.get(SID2).contextTokens, 40, 'the size after compacting');

  idx.saveNow();
  assert.deepStrictEqual(new HistoryIndex().tokensFor(SID2), idx.tokensFor(SID2), 'subagent counts are cached too');
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

test('readTranscript reads only what was added to a transcript that grew', async () => {
  const first = line({ ...base, type: 'user', message: { role: 'user', content: 'One' } });
  fs.writeFileSync(file, first);
  assert.deepStrictEqual((await readTranscript(file, 50)).map((i) => i.text), ['One']);
  fs.appendFileSync(file, line({ ...base, type: 'user', message: { role: 'user', content: 'Two' } }));
  assert.deepStrictEqual((await readTranscript(file, 50)).map((i) => i.text), ['One', 'Two']);
  // Rewritten (shorter): read again from the start.
  fs.writeFileSync(file, line({ ...base, type: 'user', message: { role: 'user', content: 'Z' } }));
  assert.deepStrictEqual((await readTranscript(file, 50)).map((i) => i.text), ['Z']);
});
