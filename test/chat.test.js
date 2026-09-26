'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const prefs = require('../src/prefs');
const { ChatManager, describeSuggestion, STREAM_ARGS } = require('../src/chat');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const cwd = path.join(box.root, 'project');
fs.mkdirSync(cwd);
prefs.save({ claudePath: FAKE });

async function waitFor(fn, what, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const mgr = new ChatManager();
let id;
const items = () => mgr.detail(id).items;
const lastOf = (kind) => [...items()].reverse().find((i) => i.kind === kind);
const turnsDone = () => items().filter((i) => i.kind === 'result').length;

test.after(async () => {
  await mgr.endAll();
  box.cleanup();
});

test('starts a chat, sends the first prompt, gets the reply', async () => {
  const s = mgr.create({ cwd, name: 'Demo', model: 'sonnet', prompt: 'hello there' });
  id = s.id;
  assert.strictEqual(s.kind, 'chat');
  await waitFor(() => turnsDone() === 1, 'first reply');
  assert.strictEqual(lastOf('user').text, 'hello there');
  assert.strictEqual(lastOf('assistant').text, 'Echo: hello there');
  const sum = mgr.summary(mgr.chats.get(id));
  assert.strictEqual(sum.state, 'running');
  assert.strictEqual(sum.status, 'idle');
  assert.strictEqual(sum.chatModel, 'sonnet');
  assert.strictEqual(sum.lastReply, 'Echo: hello there');
  await waitFor(() => mgr.detail(id).commands.length, 'slash commands from initialize');
  assert.strictEqual(mgr.detail(id).commands[0].name, 'compact');
});

test('replies arrive whole: Claude is not asked for text as it is written', async () => {
  assert.ok(!STREAM_ARGS.includes('--include-partial-messages'));
  const chat = mgr.chats.get(id);
  const seen = [];
  const onItem = (e) => { if (e.item) seen.push(e.item); };
  mgr.on('item', onItem);
  // Even if a stream event did arrive, it changes nothing; the finished message is the reply.
  mgr._onMessage(chat, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } });
  assert.strictEqual(seen.length, 0);
  mgr._onMessage(chat, { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello, **all** at once.' }] } });
  mgr.off('item', onItem);
  assert.deepStrictEqual(seen.map((i) => [i.kind, i.text]), [['assistant', 'Hello, **all** at once.']]);
  assert.ok(!('partial' in mgr.detail(id)));
});

test('effort changes for the running session, and back to the default', async () => {
  const c = mgr.create({ cwd, effort: 'low', prompt: 'which effort at the start?' });
  const its = () => mgr.detail(c.id).items;
  const last = (kind) => [...its()].reverse().find((i) => i.kind === kind);
  const replies = () => its().filter((i) => i.kind === 'result').length;
  try {
    await waitFor(() => replies() === 1, 'first reply');
    assert.strictEqual(last('assistant').text, 'Effort: low');
    assert.strictEqual(mgr.summary(mgr.chats.get(c.id)).requestedEffort, 'low');
    await assert.rejects(mgr.setEffort(c.id, 'extreme'), /Unknown effort level/);
    await mgr.setEffort(c.id, 'xhigh');
    assert.strictEqual(mgr.summary(mgr.chats.get(c.id)).requestedEffort, 'xhigh');
    assert.strictEqual(mgr.optionsOf(c.id).effort, 'xhigh');
    assert.strictEqual(last('note').text, 'Effort changed to xhigh.');
    mgr.send(c.id, 'which effort now?');
    await waitFor(() => replies() === 2, 'reply at xhigh');
    assert.strictEqual(last('assistant').text, 'Effort: xhigh');
    await mgr.setEffort(c.id, '');
    assert.strictEqual(mgr.summary(mgr.chats.get(c.id)).requestedEffort, '');
    assert.strictEqual(last('note').text, 'Effort changed to the default.');
    mgr.send(c.id, 'which effort now?');
    await waitFor(() => replies() === 3, 'reply at the default');
    assert.strictEqual(last('assistant').text, 'Effort: default');
  } finally {
    await mgr.end(c.id);
  }
});

test('a permission prompt waits for an answer; deny sends the message back', async () => {
  mgr.send(id, 'please write a file');
  const perm = await waitFor(() => { const p = lastOf('permission'); return p && p.status === 'pending' ? p : null; }, 'permission prompt');
  const sum = mgr.summary(mgr.chats.get(id));
  assert.strictEqual(sum.status, 'waiting');
  assert.strictEqual(sum.waitingFor, 'permission to use Write');
  assert.deepStrictEqual(perm.suggestions, ['Allow all edits for this session']);
  assert.strictEqual(sum.pending.requestId, perm.requestId);

  mgr.respond(id, perm.requestId, { action: 'deny', message: 'Not in this folder' });
  await waitFor(() => turnsDone() === 2, 'turn after deny');
  assert.strictEqual(lastOf('permission').status, 'denied');
  assert.match(lastOf('tool').result, /Not in this folder/);
  assert.strictEqual(lastOf('tool').isError, true);
  assert.throws(() => mgr.respond(id, perm.requestId, { action: 'allow' }), (e) => e.status === 409, 'cannot answer twice');
});

test('"always" sends the chosen suggestion as a permission update', async () => {
  mgr.send(id, 'write again');
  const perm = await waitFor(() => { const p = lastOf('permission'); return p && p.status === 'pending' ? p : null; }, 'second prompt');
  mgr.respond(id, perm.requestId, { action: 'always', suggestion: 0 });
  await waitFor(() => turnsDone() === 3, 'turn after allow');
  assert.match(lastOf('tool').result, /rule saved/);
  assert.strictEqual(lastOf('permission').outcome, 'Allow all edits for this session');
});

test('questions are answered with the chosen option', async () => {
  mgr.send(id, 'please ask me');
  const q = await waitFor(() => { const p = lastOf('question'); return p && p.status === 'pending' ? p : null; }, 'question');
  assert.strictEqual(q.questions[0].question, 'Which color?');
  assert.deepStrictEqual(q.questions[0].options.map((o) => o.label), ['Red', 'Blue']);
  assert.strictEqual(mgr.summary(mgr.chats.get(id)).waitingFor, 'a question');
  assert.throws(() => mgr.respond(id, q.requestId, { action: 'allow', answers: {} }), /Choose or type an answer/);
  mgr.respond(id, q.requestId, { action: 'allow', answers: { 'Which color?': 'Blue' } });
  await waitFor(() => turnsDone() === 4, 'turn after answer');
  assert.strictEqual(lastOf('assistant').text, 'You picked Blue.');
});

test('stop interrupts a running turn', async () => {
  mgr.send(id, 'slow please');
  await waitFor(() => mgr.summary(mgr.chats.get(id)).status === 'busy' || null, 'busy');
  await mgr.interrupt(id);
  await waitFor(() => turnsDone() === 5, 'aborted result');
  assert.strictEqual(lastOf('note').text, 'Stopped.');
  assert.strictEqual(lastOf('result').aborted, true);
  assert.ok(!items().some((i) => i.kind === 'error'), 'an interrupt is not shown as an error');
  assert.strictEqual(mgr.summary(mgr.chats.get(id)).status, 'idle');
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('images are sent to Claude as image blocks, with a thumbnail kept for the chat', async () => {
  const before = turnsDone();
  mgr.send(id, { text: 'what is this', images: [{ mediaType: 'image/png', data: PNG, thumb: `data:image/png;base64,${PNG}` }] });
  await waitFor(() => turnsDone() === before + 1, 'image reply');
  assert.strictEqual(lastOf('assistant').text, 'Saw 1 image (image/png) with: what is this.');
  const u = lastOf('user');
  assert.strictEqual(u.imageCount, 1);
  assert.deepStrictEqual(u.images, [`data:image/png;base64,${PNG}`]);
  assert.strictEqual(mgr.summary(mgr.chats.get(id)).lastPrompt, '[1 image] what is this');

  mgr.send(id, { images: [{ mediaType: 'image/jpeg', data: PNG }] });
  await waitFor(() => turnsDone() === before + 2, 'image-only reply');
  assert.strictEqual(lastOf('assistant').text, 'Saw 1 image (image/jpeg).');

  assert.throws(() => mgr.send(id, { images: [{ mediaType: 'image/bmp', data: PNG }] }), /PNG, JPEG, GIF or WebP/);
  assert.throws(() => mgr.send(id, { images: [{ mediaType: 'image/png', data: 'A'.repeat(7 * 1024 * 1024) }] }), /larger than 5 MB/);
  assert.throws(() => mgr.send(id, { text: '  ' }), /Type a message or attach an image/);
});

test('interrupt-and-send stops the running turn, then sends the new message', async () => {
  const before = turnsDone();
  mgr.send(id, 'slow please');
  await waitFor(() => mgr.summary(mgr.chats.get(id)).status === 'busy' || null, 'busy');
  await mgr.sendInterrupting(id, 'change of plan');
  await waitFor(() => lastOf('assistant') && lastOf('assistant').text === 'Echo: change of plan', 'reply to the new message');
  assert.ok(items().some((i) => i.kind === 'note' && i.text === 'Stopped.' && i.n > items().find((x) => x.text === 'slow please').n), 'the slow turn was stopped');
  assert.ok(turnsDone() >= before + 2);
});

test('a message sent while Claude works is marked queued until Claude picks it up', async () => {
  mgr.send(id, 'slow first');
  await waitFor(() => mgr.summary(mgr.chats.get(id)).status === 'busy' || null, 'busy');
  mgr.send(id, 'then this');
  const queued = lastOf('user');
  assert.strictEqual(queued.text, 'then this');
  assert.strictEqual(queued.queued, true, 'labelled queued while the slow turn runs');
  assert.ok(queued.commandUuid, 'sent with an id Claude reports back');
  await new Promise((r) => setTimeout(r, 1000));
  assert.strictEqual(items().find((i) => i.n === queued.n).queued, true, 'still queued mid-turn');
  await waitFor(() => items().find((i) => i.n === queued.n).queued === false || null, 'picked up after the slow turn');
  await waitFor(() => lastOf('assistant') && lastOf('assistant').text === 'Echo: then this' || null, 'reply to the queued message');
  const idle = items().filter((i) => i.kind === 'user').slice(-2)[0];
  assert.strictEqual(idle.queued, false, 'a message sent while idle is never labelled queued');
});

test('queued messages can be taken back to edit, with their images, and Claude never answers them', async () => {
  mgr.send(id, 'slow first');
  await waitFor(() => mgr.summary(mgr.chats.get(id)).status === 'busy' || null, 'busy');
  mgr.send(id, { text: 'take me back', images: [{ mediaType: 'image/png', data: PNG, thumb: `data:image/png;base64,${PNG}` }] });
  mgr.send(id, 'and me');
  const [a, b] = items().filter((i) => i.kind === 'user').slice(-2);
  assert.ok(a.queued && b.queued);

  const res = await mgr.unqueue(id);
  assert.deepStrictEqual(res.messages.map((m) => [m.text, m.images.length]), [['take me back', 1], ['and me', 0]], 'oldest first, with the full image');
  assert.strictEqual(res.messages[0].images[0].data, PNG);
  for (const n of [a.n, b.n]) {
    const it = items().find((i) => i.n === n);
    assert.strictEqual(it.withdrawn, true);
    assert.strictEqual(it.queued, false);
  }
  await waitFor(() => lastOf('assistant') && lastOf('assistant').text === 'Slow reply done.' || null, 'the slow turn finishes');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!items().some((i) => i.kind === 'assistant' && /take me back|and me/.test(i.text)), 'Claude never answered them');
  assert.strictEqual(mgr.summary(mgr.chats.get(id)).status, 'idle');
  assert.deepStrictEqual((await mgr.unqueue(id)).messages, [], 'nothing left to take back');
  // The chat carries on normally, and the edited message is simply sent again.
  mgr.send(id, 'take me back, edited');
  await waitFor(() => lastOf('assistant') && lastOf('assistant').text === 'Echo: take me back, edited' || null, 'reply to the edited message');
});

test('after an interrupt, the chat shows busy while Claude works on the new message', async () => {
  mgr.send(id, 'slow one');
  await waitFor(() => mgr.summary(mgr.chats.get(id)).status === 'busy' || null, 'busy');
  const stoppedBefore = items().filter((i) => i.kind === 'note' && i.text === 'Stopped.').length;
  await mgr.sendInterrupting(id, 'slow two');
  // The interrupted turn's result arrives first; the new turn is still running after it.
  await waitFor(() => items().filter((i) => i.kind === 'note' && i.text === 'Stopped.').length > stoppedBefore || null, 'the first turn stopped');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(mgr.summary(mgr.chats.get(id)).status, 'busy', 'still working on "slow two"');
  await waitFor(() => lastOf('assistant') && lastOf('assistant').text === 'Slow reply done.' || null, 'second slow reply');
  assert.strictEqual(mgr.summary(mgr.chats.get(id)).status, 'idle');
});

test('subagents are tracked with their activity, and finish with a summary', async () => {
  const seen = [];
  const onTasks = (e) => seen.push(e);
  mgr.on('tasks', onTasks);
  mgr.send(id, 'please delegate the checks');
  const done = await waitFor(() => mgr.detail(id).tasks.find((t) => t.status === 'completed'), 'subagent completed');
  mgr.off('tasks', onTasks);
  assert.strictEqual(done.description, 'Check the build');
  assert.strictEqual(done.subagentType, 'general-purpose');
  assert.strictEqual(done.summary, 'All 12 tests pass.');
  assert.strictEqual(done.toolUses, 1);
  assert.strictEqual(done.tokens, 150, "no transcript for this one, so Claude's own count is used once it's done");
  assert.deepStrictEqual(done.log.map((e) => [e.kind, e.name, e.result]), [['tool', 'Bash', '12 passing']]);
  assert.ok(seen.some((e) => e.tasks.some((t) => t.status === 'running')), 'running state was broadcast');
  assert.strictEqual(mgr.summary(mgr.chats.get(id)).runningTasks, 0);
  assert.ok(!items().some((i) => i.kind === 'tool' && i.name === 'Bash' && i.detail === 'npm test'), "a subagent's tool calls stay out of the main conversation");
});

test('a running subagent can be stopped', async () => {
  mgr.send(id, 'please delegate slow');
  const running = await waitFor(() => mgr.detail(id).tasks.find((t) => t.status === 'running'), 'running subagent');
  assert.strictEqual(mgr.summary(mgr.chats.get(id)).runningTasks, 1);
  await mgr.stopTask(id, running.taskId);
  await waitFor(() => mgr.detail(id).tasks.find((t) => t.taskId === running.taskId && t.status === 'stopped'), 'stopped subagent');
  assert.strictEqual(mgr.summary(mgr.chats.get(id)).runningTasks, 0);
});

test('slow shell commands, which Claude also reports as tasks, are not listed as subagents', async () => {
  const before = mgr.detail(id).tasks.length;
  const turns = turnsDone();
  mgr.send(id, 'please run slow');
  await waitFor(() => turnsDone() === turns + 1, 'shell command turn');
  assert.strictEqual(mgr.detail(id).tasks.length, before);
  assert.ok(!mgr.detail(id).tasks.some((t) => t.taskId === 'bash_1'));
});

test('a foreground subagent shows while it runs, with live steps and token usage from its transcript', async () => {
  mgr.send(id, 'please delegate foreground');
  const running = await waitFor(() => mgr.detail(id).tasks.find((t) => t.description === 'Review the code' && t.status === 'running'), 'running foreground subagent');
  // Its own messages never reach stdout; the steps come from its transcript file while it runs.
  const live = await waitFor(() => { const t = mgr.detail(id).tasks.find((x) => x.taskId === running.taskId); return t.status === 'running' && t.tokens > 0 && t; }, 'live token count while running');
  assert.ok(live.activity, 'shows what it is doing');
  const d = await waitFor(() => { const x = mgr.taskDetail(id, running.taskId); return x.status === 'completed' && x.steps.length === 3 && x; }, 'finished with all steps');
  assert.deepStrictEqual(d.steps.map((s) => [s.kind, s.name || s.text, s.result || null]), [
    ['text', 'Reading the source.', null],
    ['tool', 'Grep', '3 matches'],
    ['text', 'Found 3 TODOs.', null],
  ]);
  assert.strictEqual(d.model, 'claude-fake-sub');
  // msg_sub_1 was written as two records: counted once.
  assert.deepStrictEqual(d.usage, { input: 250, output: 50, cacheRead: 2000, cacheWrite: 0, total: 2300, calls: 2 });
  assert.strictEqual(d.tokens, 2300);
  assert.throws(() => mgr.taskDetail(id, 'nope'), (e) => e.status === 404);
});

test('chats turn on file checkpoints, so a turn\'s files can be rewound through Claude', async () => {
  const made = path.join(cwd, 'made-by-claude.txt');
  fs.writeFileSync(made, 'new file\n');
  process.env.FAKE_REWIND_FILE = made;
  const c = mgr.create({ cwd, name: 'Rewind', prompt: 'hello' });
  try {
    await waitFor(() => mgr.detail(c.id).items.some((i) => i.kind === 'result') || null, 'first reply');
    const promptId = mgr.detail(c.id).items.find((i) => i.kind === 'user').commandUuid;
    assert.strictEqual(mgr.findBySession(mgr.detail(c.id).sessionId).id, c.id);
    const dry = await mgr.rewindFiles(c.id, promptId, true);
    assert.deepStrictEqual(dry.filesChanged, [made], 'checkpointing is enabled for the chat');
    assert.ok(fs.existsSync(made), 'a dry run changes nothing');
    await mgr.rewindFiles(c.id, promptId, false);
    assert.ok(!fs.existsSync(made), 'the real rewind restored the files');
  } finally {
    delete process.env.FAKE_REWIND_FILE;
    await mgr.end(c.id);
  }
});

test('ending with keep leaves the chat listed as ended, ready to resume or remove', async () => {
  const c = mgr.create({ cwd, name: 'Keep me', prompt: 'hello' });
  await waitFor(() => mgr.detail(c.id).items.some((i) => i.kind === 'result') || null, 'first reply');
  await mgr.end(c.id, { keep: true });
  const s = mgr.summary(mgr.chats.get(c.id));
  assert.strictEqual(s.state, 'exited', 'still listed, as ended');
  assert.ok(mgr.detail(c.id).items.some((i) => i.kind === 'note' && i.text === 'Claude Code ended.'));
  await mgr.resume(c.id);
  await waitFor(() => mgr.summary(mgr.chats.get(c.id)).state === 'running' || null, 'resumed');
  await mgr.end(c.id, { keep: true });
  await mgr.end(c.id); // a second, plain end removes it
  assert.ok(!mgr.list().some((x) => x.id === c.id), 'removed');
});

test('a chat waiting for its first message shows as idle, not starting', async () => {
  const c = mgr.create({ cwd, name: 'Quiet' });
  await waitFor(() => mgr.summary(mgr.chats.get(c.id)).status === 'idle' || null, 'idle after the handshake');
  assert.strictEqual(mgr.summary(mgr.chats.get(c.id)).state, 'running');
  await mgr.end(c.id);
});

test('chats survive a restart as ended conversations, and end removes them', async () => {
  const sessionId = mgr.detail(id).sessionId;
  await new Promise((r) => setTimeout(r, 400)); // debounced save
  const again = new ChatManager();
  const restored = again.list().find((c) => c.id === id);
  assert.ok(restored, 'restored from chats.json');
  assert.strictEqual(restored.state, 'exited');
  assert.strictEqual(restored.sessionId, sessionId);

  await mgr.end(id);
  assert.ok(!mgr.list().some((c) => c.id === id), 'ended chat is gone');
  assert.throws(() => mgr.send(id, 'hi'), (e) => e.status === 404);
});

test('suggestion labels read like choices', () => {
  assert.strictEqual(describeSuggestion({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], destination: 'localSettings' }), 'Always allow Bash(npm test:*) in this project (just you)');
  assert.strictEqual(describeSuggestion({ type: 'addDirectories', directories: ['C:\\x'], destination: 'session' }), 'Allow access to C:\\x for this session');
});
