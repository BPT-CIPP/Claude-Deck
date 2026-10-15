'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const prefs = require('../src/prefs');
const { ChatManager, describeSuggestion, safeFileName, STREAM_ARGS } = require('../src/chat');

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

test('MCP servers are listed, turned off and on, and reconnected through Claude', async () => {
  const c = mgr.create({ cwd });
  const sum = () => mgr.summary(mgr.chats.get(c.id));
  try {
    await waitFor(() => sum().mcp && sum().mcp.length === 2, 'MCP servers after start-up');
    assert.deepStrictEqual(sum().mcp, [{ name: 'docs', status: 'connected' }, { name: 'broken', status: 'failed' }]);
    const { servers } = await mgr.mcpStatus(c.id);
    assert.deepStrictEqual(servers[0], { name: 'docs', status: 'connected', error: null, scope: 'user', source: 'user', version: '1.0.0', tools: ['search', 'read_page'] });
    assert.strictEqual(servers[1].error, 'Connection closed');
    assert.ok(!JSON.stringify(servers).includes('not-for-the-page'), "a server's config stays on the server");
    const off = await mgr.setMcpEnabled(c.id, 'docs', false);
    assert.strictEqual(off.servers[0].status, 'disabled');
    assert.strictEqual(off.servers[0].tools, null);
    assert.strictEqual(sum().mcp[0].status, 'disabled');
    assert.strictEqual([...mgr.detail(c.id).items].reverse().find((i) => i.kind === 'note').text, 'MCP server docs is off.');
    assert.strictEqual((await mgr.setMcpEnabled(c.id, 'docs', true)).servers[0].status, 'connected');
    await assert.rejects(mgr.setMcpEnabled(c.id, 'nope', false), /Server not found: nope/);
    await assert.rejects(mgr.setMcpEnabled(c.id, '', false), /Which MCP server/);
    assert.strictEqual((await mgr.reconnectMcp(c.id, 'docs')).servers[0].status, 'connected');
    await assert.rejects(mgr.reconnectMcp(c.id, 'broken'), { message: 'Connection closed' });
  } finally {
    await mgr.end(c.id);
  }
});

test("long pastes are kept with your message, shown as placeholders in its preview, and come back with it out of the queue", async () => {
  const c = mgr.create({ cwd });
  const its = () => mgr.detail(c.id).items;
  const block = 'one\ntwo\nthree\nfour';
  try {
    await waitFor(() => mgr.summary(mgr.chats.get(c.id)).status === 'idle', 'chat ready');
    mgr.send(c.id, { text: `look: ${block} thanks`, pasted: [[6, 6 + block.length]] });
    await waitFor(() => its().some((i) => i.kind === 'result'), 'reply');
    const user = its().find((i) => i.kind === 'user');
    assert.deepStrictEqual(user.pasted, [[6, 24]]);
    // Claude gets the whole text.
    assert.strictEqual([...its()].reverse().find((i) => i.kind === 'assistant').text, `Echo: look: ${block} thanks`);
    assert.strictEqual(mgr.summary(mgr.chats.get(c.id)).lastPrompt, 'look: [Pasted text #1 +3 lines] thanks');
    // Positions that don't fit the text are dropped, and the message shows in full.
    for (const bad of [[[6, 99]], [[5, 3]], [[0, 2], [1, 3]], 'nope', [[0.5, 2]]]) {
      mgr.send(c.id, { text: 'short', pasted: bad });
      assert.strictEqual([...its()].reverse().find((i) => i.kind === 'user').pasted, undefined, JSON.stringify(bad));
    }
    // Queued, then taken back: the positions come back too.
    await waitFor(() => its().filter((i) => i.kind === 'result').length === 6 && mgr.summary(mgr.chats.get(c.id)).status === 'idle', 'the short messages answered');
    mgr.send(c.id, 'please slow');
    await waitFor(() => mgr.summary(mgr.chats.get(c.id)).status === 'busy', 'busy');
    mgr.send(c.id, { text: `again ${block}`, pasted: [[6, 6 + block.length]] });
    const { messages } = await mgr.unqueue(c.id);
    assert.deepStrictEqual(messages.map((m) => m.pasted), [[[6, 24]]]);
  } finally {
    await mgr.end(c.id);
  }
});

// A chat of its own for each of the terminal features below.
async function withChat(fn, manager = mgr) {
  const c = manager.create({ cwd });
  const its = () => manager.detail(c.id).items;
  const sum = () => manager.summary(manager.chats.get(c.id));
  const replies = () => its().filter((i) => i.kind === 'result').length;
  const last = (kind) => [...its()].reverse().find((i) => i.kind === kind);
  const say = async (text) => {
    const before = replies();
    manager.send(c.id, text);
    await waitFor(() => replies() > before, `reply to "${text}"`);
  };
  try {
    await waitFor(() => sum().status === 'idle', 'chat ready');
    await fn({ id: c.id, its, sum, last, say });
  } finally {
    await manager.end(c.id);
  }
}

test("thinking, edits' diffs and the to-do list come through as Claude Code shows them", () => withChat(async ({ id, sum, last, say, its }) => {
  await say('show thinking');
  assert.strictEqual(last('thinking').text, 'Let me think about this for a moment.');
  await say('make an edit');
  const edit = its().findLast((i) => i.kind === 'tool' && i.name === 'Edit');
  assert.deepStrictEqual(edit.diff.hunks, [{ oldStart: 1, newStart: 1, lines: ['-I like apples.', '+I like oranges.', ' And pears.'] }]);
  assert.match(edit.diff.file, /edit-me\.txt$/);
  await say('keep a todo');
  assert.deepStrictEqual(sum().todos.map((t) => [t.content, t.status]), [['Read the code', 'completed'], ['Write the fix', 'in_progress'], ['Run the tests', 'pending']]);
  assert.strictEqual(sum().todos[1].activeForm, 'Writing the fix');
  await say('track tasks');
  assert.deepStrictEqual(sum().todos.map((t) => [t.content, t.status]), [['Write the tests', 'completed'], ['Ship it', 'pending']]);
  // /clear empties the chat too, so wait on the list itself.
  mgr.send(id, '/clear');
  await waitFor(() => sum().todos === null, 'the list cleared with the conversation');
}));

test("an expired sign-in says how to sign in from PowerShell, and /login isn't sent to Claude", () => withChat(async ({ id, its, last, say }) => {
  await say('please expire my sign-in');
  assert.match(last('error').text, /OAuth session expired/);
  const help = last('signin');
  assert.ok(help, 'sign-in instructions after the error');
  assert.strictEqual(help.command, 'claude auth login');
  assert.match(help.text, /PowerShell/);
  // An ordinary reply afterwards brings no instructions with it.
  const before = its().filter((i) => i.kind === 'signin').length;
  await say('hello again');
  assert.strictEqual(its().filter((i) => i.kind === 'signin').length, before);
  // /login only works in Claude Code's terminal: it stays here, with the instructions, and no reply.
  const replies = its().filter((i) => i.kind === 'result').length;
  mgr.send(id, '/login');
  assert.strictEqual(its().at(-2).kind, 'user');
  assert.strictEqual(its().at(-1).kind, 'signin');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(its().filter((i) => i.kind === 'result').length, replies, 'Claude got no /login turn');
}));

test('a plan is approved with how Claude carries on, or sent back to keep planning', () => withChat(async ({ id, sum, last, its }) => {
  mgr.send(id, 'plan it');
  await waitFor(() => last('plan') && last('plan').status === 'pending', 'the plan');
  assert.strictEqual(last('plan').plan, '## Plan\n\n1. Read `app.js`\n2. Add the **menu**');
  mgr.respond(id, last('plan').requestId, { action: 'deny', message: 'Add tests too' });
  await waitFor(() => /Still planning/.test((last('assistant') || {}).text || ''), 'kept planning');
  assert.strictEqual(last('assistant').text, 'Still planning: Add tests too');
  assert.strictEqual(last('plan').outcome, 'Kept planning: Add tests too');
  const before = its().filter((i) => i.kind === 'plan').length;
  mgr.send(id, 'plan it');
  await waitFor(() => its().filter((i) => i.kind === 'plan').length > before && last('plan').status === 'pending', 'the plan again');
  mgr.respond(id, last('plan').requestId, { action: 'allow', mode: 'acceptEdits' });
  await waitFor(() => /Plan approved/.test((last('assistant') || {}).text || ''), 'approved');
  assert.strictEqual(last('assistant').text, 'Plan approved; mode acceptEdits.');
  assert.strictEqual(sum().permissionMode, 'acceptEdits');
}));

test('@ file suggestions, /btw side questions and MCP sign-in go through Claude Code', () => withChat(async ({ id, its }) => {
  assert.deepStrictEqual((await mgr.fileSuggestions(id, 'src/')).suggestions, ['src/app.js', 'src/server.js', 'src/']);
  const before = its().length;
  assert.deepStrictEqual(await mgr.sideQuestion(id, '  what is this?  '), { question: 'what is this?', answer: 'Aside: what is this?' });
  assert.strictEqual(its().length, before, 'a side question stays out of the conversation');
  await assert.rejects(mgr.sideQuestion(id, ' '), /Type a question/);
  assert.deepStrictEqual(await mgr.authenticateMcp(id, 'broken'), { authUrl: 'https://auth.example.com/authorize?server=broken', requiresUserAction: true, callbackExpected: true });
  await assert.rejects(mgr.authenticateMcp(id, 'nope'), /Server not found: nope/);
}));

test('fast mode needs Allow API billing, since it bills extra usage', () => withChat(async ({ id, sum, say }) => {
  assert.deepStrictEqual(sum().fast, { state: 'off', reason: 'sdk_opt_in_required' });
  await assert.rejects(mgr.setFastMode(id, true), /Allow API billing/);
  prefs.save({ allowApiBilling: true });
  try {
    await mgr.setFastMode(id, true);
    await say('hello');
    assert.strictEqual(sum().fast.state, 'on');
    await mgr.setFastMode(id, false);
    assert.strictEqual(sum().fast.state, 'off');
  } finally {
    prefs.save({ allowApiBilling: false });
  }
  // Turning it off never needs the preference.
  await mgr.setFastMode(id, false);
}));

test("Claude Code's suggested next prompt is kept until you send something", () => withChat(async ({ id, sum, say }) => {
  await say('hello');
  assert.strictEqual(sum().suggestion, 'Run the tests');
  mgr.send(id, 'something else');
  assert.strictEqual(sum().suggestion, null);
}));

test('Ctrl+B sends what Claude is waiting on to the background, and it can still be stopped', () => withChat(async ({ id, sum, last }) => {
  mgr.send(id, 'delegate wait');
  await waitFor(() => sum().foregroundTasks === 1, 'a task Claude waits for');
  await mgr.background(id);
  await waitFor(() => sum().foregroundTasks === 0 && sum().bgTasks.length === 1, 'backgrounded');
  assert.strictEqual(sum().bgTasks[0].description, 'Wait check');
  await waitFor(() => (last('assistant') || {}).text === 'Carrying on while it runs.', 'the turn carries on');
  await waitFor(() => sum().bgTasks.length === 0, 'the background task finishing');
}));

test('!command runs in PowerShell, and Claude gets it and its output with your next message', { skip: process.platform !== 'win32' }, () => withChat(async ({ id, its, last, say }) => {
  const results = () => its().filter((i) => i.kind === 'result').length;
  const before = results();
  assert.deepStrictEqual(await mgr.runShell(id, 'Write-Output "hello-shell"'), { exitCode: 0 });
  const item = last('shell');
  assert.deepStrictEqual({ command: item.command, stdout: item.stdout, stderr: item.stderr, running: item.running }, { command: 'Write-Output "hello-shell"', stdout: 'hello-shell', stderr: '', running: false });
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(results(), before, 'no reply, so no result line');
  await say('what did it print?');
  assert.strictEqual(last('assistant').text, 'Echo: what did it print? [with: <bash-input>Write-Output "hello-shell"</bash-input> <bash-stdout>hello-shell</bash-stdout><bash-stderr></bash-stderr>]');
  // A failing command: its error as PowerShell prints it, and the exit code.
  const failed = await mgr.runShell(id, 'Get-Item C:\\no-such-folder-here');
  assert.strictEqual(failed.exitCode, 1);
  assert.match(last('shell').stderr, /Cannot find path 'C:\\no-such-folder-here'/);
  await assert.rejects(mgr.runShell(id, '   '), /Type a command/);
}));

test('going back to before a message starts Claude again from the transcript up to there, as a new session', async () => {
  const transcript = path.join(box.root, 'rewind.jsonl');
  const history = { refresh: async () => {}, fileFor: () => transcript, get: () => null, stamp: () => null };
  const m2 = new ChatManager({ history });
  await withChat(async ({ id, its, last, say }) => {
    await say('first message');
    m2.send(id, { text: 'paste: one\ntwo\nthree\nfour', pasted: [[7, 25]] });
    await waitFor(() => its().filter((i) => i.kind === 'result').length === 2, 'second reply');
    const [first, second] = its().filter((i) => i.kind === 'user');
    // As Claude Code writes the transcript: each entry's parent is the one before it.
    const middle = 'aaaaaaaa-1111-4111-8111-111111111111';
    fs.writeFileSync(transcript, [{ uuid: first.commandUuid, parentUuid: null }, { uuid: middle, parentUuid: first.commandUuid }, { uuid: second.commandUuid, parentUuid: middle }].map((e) => JSON.stringify(e)).join('\n'));
    assert.deepStrictEqual(await m2.rewind(id, second.commandUuid), { text: 'paste: one\ntwo\nthree\nfour', pasted: [[7, 25]] });
    assert.deepStrictEqual(its().filter((i) => i.kind === 'user').map((i) => i.text), ['first message']);
    assert.match(last('note').text, /Went back to before your message/);
    await waitFor(() => m2.summary(m2.chats.get(id)).state === 'running', 'Claude started again');
    await say('show args');
    const args = JSON.parse(last('assistant').text.replace(/^Args: /, ''));
    assert.ok(args.includes('--fork-session'));
    assert.strictEqual(args[args.indexOf('--resume-session-at') + 1], middle);
    await assert.rejects(m2.rewind(id, 'bbbbbbbb-1111-4111-8111-111111111111'), /no longer in this chat/);
  }, m2);
});

test("an MCP server's status from init updates the chat's list", () => {
  // A stand-in for a running chat; init marks a chat busy, so the demo chat is left alone.
  const chat = mgr._blank({ id: 'mcp-init', cwd });
  Object.assign(chat, { proc: {}, state: 'running' });
  mgr.chats.set(chat.id, chat);
  try {
    mgr._onMessage(chat, { type: 'system', subtype: 'init', mcp_servers: [{ name: 'docs', status: 'needs-auth', source: 'claudeai' }] });
    assert.deepStrictEqual(mgr.summary(chat).mcp, [{ name: 'docs', status: 'needs-auth' }]);
  } finally {
    mgr.chats.delete(chat.id);
  }
});

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('the current cost and tokens start again after /clear', async () => {
  // The chat keeps its messages here, so every reply can be counted across the /clear.
  prefs.save({ clearChatOnClear: false });
  const c = mgr.create({ cwd, prompt: 'hello' });
  const its = () => mgr.detail(c.id).items;
  const replies = () => its().filter((i) => i.kind === 'result').length;
  const sum = () => mgr.summary(mgr.chats.get(c.id));
  try {
    await waitFor(() => replies() === 1, 'first reply');
    assert.ok(near(sum().chatCost, 0.01));
    assert.deepStrictEqual(sum().tokens, { input: 100, output: 20, cacheRead: 1000, cacheWrite: 0 }, "the conversation's tokens");
    assert.deepStrictEqual(its().find((i) => i.kind === 'result').tokens, { input: 100, output: 20, cacheRead: 1000, cacheWrite: 0 }, "the reply's own tokens");
    assert.strictEqual(its().find((i) => i.kind === 'result').subagentTokens, 0, 'no subagents in this reply');
    await waitFor(() => sum().context && sum().context.tokens === 6000, 'context after the first reply');
    assert.deepStrictEqual(sum().context, { tokens: 6000, max: 200000, percent: 3 });

    const firstSession = sum().sessionId;
    mgr.send(c.id, '/clear');
    await waitFor(() => replies() === 2, '/clear done');
    assert.ok(its().some((i) => i.kind === 'note' && /^Context cleared/.test(i.text)));
    assert.notStrictEqual(sum().sessionId, firstSession, 'a new conversation');
    assert.strictEqual(sum().chatCost, 0, 'the current cost starts again');
    assert.deepStrictEqual(sum().tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'the current tokens start again');
    assert.strictEqual(its().filter((i) => i.kind === 'result')[1].tokens.input, 0, '/clear itself used nothing');
    await waitFor(() => sum().context && sum().context.tokens === 5000, 'context after /clear');

    mgr.send(c.id, 'after the clear');
    await waitFor(() => replies() === 3, 'reply after /clear');
    assert.ok(near(sum().chatCost, 0.01));
    assert.strictEqual(sum().tokens.input, 100, 'only the new conversation');
  } finally {
    prefs.save({ clearChatOnClear: true });
    await mgr.end(c.id);
  }
});

test('/clear empties the chat too, unless that preference is off', async () => {
  assert.strictEqual(prefs.load().clearChatOnClear, true, 'on by default');
  const c = mgr.create({ cwd, prompt: 'first prompt' });
  const its = () => mgr.detail(c.id).items;
  const replies = () => its().filter((i) => i.kind === 'result').length;
  const cleared = () => its().some((i) => i.kind === 'note' && /^Context cleared/.test(i.text));
  let resets = 0;
  const onItem = (e) => { if (e.id === c.id && e.reset) resets++; };
  mgr.on('item', onItem);
  try {
    await waitFor(() => replies() === 1, 'first reply');
    mgr.send(c.id, '/clear');
    await waitFor(() => cleared() && replies() === 1, '/clear done');
    assert.deepStrictEqual(its().map((i) => i.kind), ['note', 'result'], 'only the note and the /clear result are left');
    assert.strictEqual(resets, 1, 'the page is told to load the chat again');
    assert.deepStrictEqual(mgr.detail(c.id).earlierPrompts, ['first prompt', '/clear'], 'kept for ↑ in the reply box');

    mgr.send(c.id, 'second prompt');
    await waitFor(() => replies() === 2, 'reply after /clear');
    prefs.save({ clearChatOnClear: false });
    mgr.send(c.id, '/clear');
    await waitFor(() => replies() === 3, 'second /clear');
    assert.ok(its().some((i) => i.kind === 'user' && i.text === 'second prompt'), 'with the preference off, the messages stay');
    assert.strictEqual(its().filter((i) => i.kind === 'note' && /^Context cleared/.test(i.text)).length, 2);
    assert.strictEqual(resets, 1);
  } finally {
    mgr.off('item', onItem);
    prefs.save({ clearChatOnClear: true });
    await mgr.end(c.id);
  }
});

test('/clear keeps messages still waiting in line', () => {
  const chat = mgr._blank({ id: 'clear-queue' });
  chat.past = [{ kind: 'user', text: 'from the transcript' }, { kind: 'assistant', text: 'reply' }];
  chat.items = [
    { kind: 'user', text: 'sent', n: 1 },
    { kind: 'assistant', text: 'reply', n: 2 },
    { kind: 'user', text: 'taken back', withdrawn: true, n: 3 },
    { kind: 'user', text: 'waiting', queued: true, n: 4 },
  ];
  mgr._clearItems(chat);
  assert.deepStrictEqual(chat.items.map((i) => i.text), ['waiting']);
  assert.deepStrictEqual(chat.past, []);
  assert.deepStrictEqual(chat.earlierPrompts, ['from the transcript', 'sent']);
});

test('a dropped file is kept in the data folder under a safe name', async () => {
  const c = mgr.create({ cwd });
  try {
    const data = Buffer.from('%PDF-1.4 not really a PDF');
    const res = mgr.saveFile(c.id, { name: 'Q3 report.pdf', data: data.toString('base64') });
    assert.ok(res.path.startsWith(path.join(box.dataDir, 'attachments', c.id) + path.sep), res.path);
    assert.strictEqual(path.basename(res.path), 'Q3 report.pdf');
    assert.deepStrictEqual(fs.readFileSync(res.path), data);
    // The same name twice doesn't overwrite the first.
    const again = mgr.saveFile(c.id, { name: 'Q3 report.pdf', data: '' });
    assert.notStrictEqual(again.path, res.path);
    assert.strictEqual(fs.readFileSync(res.path).length, data.length);
    assert.throws(() => mgr.saveFile(c.id, { name: 'x.txt', data: 'not base64!' }), /couldn't be read/);
  } finally {
    await mgr.end(c.id);
  }
});

test('dropped file names are made safe for Windows', () => {
  assert.strictEqual(safeFileName('..\\..\\evil.txt'), 'evil.txt');
  assert.strictEqual(safeFileName('a/b/c.pdf'), 'c.pdf');
  assert.strictEqual(safeFileName('what?<now>.md'), 'what__now_.md');
  assert.strictEqual(safeFileName('trailing. . '), 'trailing');
  assert.strictEqual(safeFileName('..'), 'file');
  assert.strictEqual(safeFileName('CON.txt'), 'file');
  assert.strictEqual(safeFileName(''), 'file');
  assert.strictEqual(safeFileName(`${'x'.repeat(200)}.pdf`).length, 120);
  assert.ok(safeFileName(`${'x'.repeat(200)}.pdf`).endsWith('.pdf'));
});

test('compact summarizes the conversation, and waits until Claude is done', async () => {
  const c = mgr.create({ cwd, prompt: 'hello' });
  const its = () => mgr.detail(c.id).items;
  const replies = () => its().filter((i) => i.kind === 'result').length;
  const sum = () => mgr.summary(mgr.chats.get(c.id));
  try {
    await waitFor(() => replies() === 1, 'first reply');
    mgr.send(c.id, 'slow please');
    await waitFor(() => sum().status === 'busy' || null, 'busy');
    assert.throws(() => mgr.compact(c.id), (e) => e.status === 409);
    await waitFor(() => replies() === 2 && sum().status === 'idle', 'slow reply');
    mgr.compact(c.id);
    await waitFor(() => replies() === 3, 'compacted');
    const notes = its().filter((i) => i.kind === 'note').map((i) => i.text);
    assert.ok(notes.includes('Compacting the conversation…'));
    assert.ok(notes.includes('Conversation compacted (7,000 → 1,500 tokens). Claude now works from a summary of the earlier turns.'), notes.join(' | '));
    assert.ok(its().some((i) => i.kind === 'user' && i.text === '/compact'), 'sent as /compact');
    await waitFor(() => sum().context && sum().context.tokens === 1500, 'smaller context');
    assert.strictEqual(sum().tokens.input, 300, 'summarizing uses tokens too');
    assert.strictEqual(its().filter((i) => i.kind === 'result')[2].subagentTokens, 0, "compacting's own call isn't a subagent's");
    assert.strictEqual(its().filter((i) => i.kind === 'result')[2].tokens.input, 100);
  } finally {
    await mgr.end(c.id);
  }
});

test("a reply's tokens leave out a resumed conversation's earlier ones", () => {
  // Claude carries on from the conversation's saved cost-state; a reply counts only what it added.
  const RESUMED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const history = { get: (sid) => (sid === RESUMED ? { costState: { costUSD: 5, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } } : null) };
  const m = new ChatManager({ history, file: path.join(box.root, 'resumed-chats.json') });
  const chat = m._blank({ id: 'resumed', cwd, sessionId: RESUMED });
  const usage = (input, output) => ({ 'claude-x': { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
  const result = (sessionId, cost, input, output) => m._onMessage(chat, { type: 'result', subtype: 'success', session_id: sessionId, total_cost_usd: cost, modelUsage: usage(input, output) });
  const replyTokens = (c) => { const t = [...c.items].reverse().find((i) => i.kind === 'result').tokens; return [t.input, t.output]; };
  result(RESUMED, 5.25, 1100, 120);
  assert.deepStrictEqual(replyTokens(chat), [100, 20]);
  result(RESUMED, 5.5, 1200, 140);
  assert.deepStrictEqual(replyTokens(chat), [100, 20]);
  // After /clear: a new session, counted from zero.
  result('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 0.1, 50, 5);
  assert.deepStrictEqual(replyTokens(chat), [50, 5]);
  // A fork has a new session id but carries on the original's totals (checked with 2.1.281).
  const fork = m._blank({ id: 'fork', cwd });
  fork.forkedFrom = RESUMED;
  m._onMessage(fork, { type: 'result', subtype: 'success', session_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', total_cost_usd: 5.1, modelUsage: usage(1010, 101) });
  assert.deepStrictEqual(replyTokens(fork), [10, 1]);
  clearInterval(m.sleepTimer);
});

test('time the PC spends asleep is not counted as working time', () => {
  // A stand-in for a chat whose Claude is mid-turn; the demo chat (idle) is left as it is.
  const chat = mgr._blank({ id: 'sleep-check', cwd });
  Object.assign(chat, { proc: {}, state: 'running', busy: true, statusKey: 'busy' });
  mgr.chats.set(chat.id, chat);
  const idle = mgr.chats.get(id);
  try {
    const now = Date.now();
    chat.statusSince = now - 30 * 60000; // working for 30 minutes by the clock...
    const idleSince = idle.statusSince;
    mgr.lastAwake = now - 20 * 60000; // ...20 of them asleep
    mgr._checkSleep(now);
    assert.strictEqual(mgr.summary(chat).statusSince, now - 10 * 60000);
    assert.strictEqual(idle.statusSince, idleSince, 'an idle chat really was idle that long');
    // An ordinary gap between checks isn't sleep.
    mgr._checkSleep(now + 5000);
    assert.strictEqual(chat.statusSince, now - 10 * 60000);
    // Waiting on you: the timer keeps counting, but the turn's "Done in" still leaves sleep out.
    chat.pending.set('req-1', { requestId: 'req-1', toolName: 'Write' });
    const waitingSince = chat.statusSince;
    mgr._checkSleep(now + 5000 + 5 * 60000);
    assert.strictEqual(chat.statusSince, waitingSince);
    chat.pending.clear();
    mgr._onMessage(chat, { type: 'result', subtype: 'success', duration_ms: 40 * 60000, total_cost_usd: 0 });
    assert.strictEqual([...chat.items].reverse().find((i) => i.kind === 'result').durationMs, 15 * 60000);
    assert.strictEqual(chat.turnSleptMs, 0, 'the next turn starts fresh');
  } finally {
    mgr.chats.delete(chat.id);
    mgr.lastAwake = Date.now();
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
  // The reply's tokens include the subagent's, and say how many were its.
  const reply = await waitFor(() => { const r = lastOf('result'); return r && r.subagentTokens > 0 ? r : null; }, 'the reply after the subagent');
  assert.deepStrictEqual(reply.tokens, { input: 350, output: 70, cacheRead: 3000, cacheWrite: 0 });
  assert.strictEqual(reply.subagentTokens, 2300);
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
  assert.ok(restored.tokens && restored.tokens.input > 0, "the conversation's tokens are kept");
  assert.deepStrictEqual(restored.tokens, mgr.summary(mgr.chats.get(id)).tokens);

  await mgr.end(id);
  assert.ok(!mgr.list().some((c) => c.id === id), 'ended chat is gone');
  assert.throws(() => mgr.send(id, 'hi'), (e) => e.status === 404);
});

test('a chat restored after a restart shows its conversation so far, from the transcript', async () => {
  const { HistoryIndex } = require('../src/history');
  const SID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const proj = path.join(box.claudeDir, 'projects', 'restored-project');
  fs.mkdirSync(proj, { recursive: true });
  const rec = (o) => `${JSON.stringify({ sessionId: SID, cwd, timestamp: new Date().toISOString(), ...o })}\n`;
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), rec({ type: 'user', message: { role: 'user', content: 'Fix the lockout script' } })
    + rec({ type: 'assistant', message: { id: 'm1', model: 'claude-x', content: [{ type: 'text', text: 'Done: logging added.' }] } }));
  const file = path.join(box.root, 'restored-chats.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'restored', name: 'Lockout', cwd, sessionId: SID }]));
  const history = new HistoryIndex({ cacheFile: path.join(box.root, 'restored-history.json') });
  const m = new ChatManager({ history, file });
  try {
    assert.strictEqual(m.summary(m.chats.get('restored')).state, 'exited', 'back as ended');
    assert.deepStrictEqual(m.detail('restored').past, [], 'nothing in memory at first');
    await waitFor(() => m.detail('restored').past.length === 2, 'the conversation read from its transcript');
    assert.deepStrictEqual(m.detail('restored').past.map((x) => [x.kind, x.text]), [['user', 'Fix the lockout script'], ['assistant', 'Done: logging added.']]);
  } finally {
    clearInterval(m.sleepTimer);
    // Saved now, not by its timer after this file's tests have removed the folder.
    history.saveNow();
  }
});

test('suggestion labels read like choices', () => {
  assert.strictEqual(describeSuggestion({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], destination: 'localSettings' }), 'Always allow Bash(npm test:*) in this project (just you)');
  assert.strictEqual(describeSuggestion({ type: 'addDirectories', directories: ['C:\\x'], destination: 'session' }), 'Allow access to C:\\x for this session');
});
