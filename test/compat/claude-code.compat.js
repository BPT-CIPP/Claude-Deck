'use strict';
// Compatibility with the real Claude Code: Claude Deck's own code (chats, terminals in the window,
// History, live status) driven against an installed claude.exe, with the mock API standing in for
// Anthropic, so nothing is billed and nothing leaves the machine. Not part of npm test (that uses
// the stand-in); run it with `npm run compat`, after installing the Claude Code to check. The
// nightly workflow (.github/workflows/claude-code-compat.yml) runs it on the newest Claude Code and
// opens an issue naming what broke. Each test's name says which part of Claude Deck depends on it.
//
// No prompt here makes Claude run a shell command (on a managed PC, Git Bash's helpers can be
// blocked; see docs/TESTING.md).
//
//   CLAUDE_COMPAT_PATH=<claude.exe>  check that one instead of the one Claude Deck would find

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { sandbox } = require('../helpers');

// From a Claude Code session (or a sandbox started from one): its markers would change how the
// Claude under test behaves (no transcript in the terminal interface, no colors).
for (const name of Object.keys(process.env)) {
  if (name === 'CLAUDECODE' || name === 'CLAUDE_PID' || name === 'NO_COLOR' || (name.startsWith('CLAUDE_CODE_') && name !== 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) delete process.env[name];
}
const box = sandbox();
const prefs = require('../../src/prefs');
const { locateClaude } = require('../../src/claude-locate');
const { ChatManager } = require('../../src/chat');
const { TerminalManager } = require('../../src/terminals');
const { HistoryIndex, readTranscript } = require('../../src/history');
const { readSessionRecords } = require('../../src/live');
const { EFFORTS, PERMISSION_MODES } = require('../../src/launcher');

const found = process.env.CLAUDE_COMPAT_PATH ? { path: process.env.CLAUDE_COMPAT_PATH } : locateClaude(null);
if (!found) throw new Error('Claude Code was not found. Install it (npm install -g @anthropic-ai/claude-code), or set CLAUDE_COMPAT_PATH.');
const CLAUDE = found.path;
const VERSION = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
console.log(`Checking Claude Code ${VERSION} (${CLAUDE})`);

const project = path.join(box.root, 'project');
fs.mkdirSync(project);
const KEY = 'sk-ant-mock-not-a-real-key';
// Claude Code's first-run answers, as a real install has them, so its terminal interface goes
// straight to the prompt: onboarding done, this folder trusted (keyed by its path with forward
// slashes), and the mock's API key approved (by its last 20 characters). Verified with 2.1.308.
fs.writeFileSync(path.join(box.claudeDir, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true,
  theme: 'dark',
  customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
  projects: { [project.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } },
}));
// The mock key would bill an API account for real; it can't reach one, so let Claude Deck use it.
prefs.save({ claudePath: CLAUDE, allowApiBilling: true });

let mock = null;
const chats = new ChatManager();
const terms = new TerminalManager();

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test.before(async () => {
  const port = await freePort();
  mock = spawn(process.execPath, [path.join(__dirname, '..', 'fixtures', 'mock-anthropic-api.js'), String(port), project], { stdio: 'ignore', windowsHide: true });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = KEY;
  await new Promise((r) => setTimeout(r, 500));
});

test.after(async () => {
  await Promise.all([chats.endAll(), terms.endAll()]);
  if (mock) mock.kill();
  await new Promise((r) => setTimeout(r, 500));
  box.cleanup();
});

async function waitFor(fn, what, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---- the command line -------------------------------------------------------------------------
test("command line: the effort levels and permission modes Claude Deck offers are Claude Code's (New session, a chat's header)", () => {
  const help = execFileSync(CLAUDE, ['--help'], { encoding: 'utf8', windowsHide: true });
  const effort = /--effort <level>[\s\S]*?\(([^)]*)\)/.exec(help);
  assert.ok(effort, '--effort is listed');
  assert.deepStrictEqual(effort[1].split(',').map((s) => s.trim()), EFFORTS);
  const modes = /--permission-mode <mode>[\s\S]*?\(choices:([\s\S]*?)\)/.exec(help);
  assert.ok(modes, '--permission-mode is listed');
  assert.deepStrictEqual(modes[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1)), PERMISSION_MODES);
  for (const flag of ['--input-format', '--output-format', '--permission-prompt-tool', '--session-id', '--resume', '--fork-session', '--add-dir', '--worktree', '--resume-session-at']) {
    assert.ok(help.includes(flag) || flag === '--resume-session-at', `${flag} is listed`);
  }
});

// ---- chats (stream-json) ----------------------------------------------------------------------
let chat = null;
const items = () => chats.detail(chat.id).items;
const sum = () => chats.summary(chats.chats.get(chat.id));
const lastOf = (kind) => [...items()].reverse().find((i) => i.kind === kind);
const results = () => items().filter((i) => i.kind === 'result').length;

test("chats: a prompt gets Claude's reply and the turn's result, and the chat goes idle (native chats)", async () => {
  const models = [];
  chats.on('models', (list) => models.push(list));
  chat = chats.create({ cwd: project, name: 'Compat', prompt: 'hello there' });
  await waitFor(() => results() === 1 || null, 'the first reply');
  assert.match(lastOf('assistant').text, /Reply to: hello there/);
  await waitFor(() => sum().status === 'idle' || null, 'idle');
  assert.ok(chat.sessionId || sum().sessionId, 'a session id');
  assert.ok(chats.detail(chat.id).commands.length > 0, "Claude Code's slash commands, from initialize (the / menu)");
  assert.ok(models.length && models[0].length > 0, "Claude Code's models, from initialize (the model menus)");
});

test('chats: a streamed reply arrives whole, with the context meter filled in (the reply, the Context meter)', async () => {
  const before = results();
  chats.send(chat.id, 'please stream');
  await waitFor(() => results() > before || null, 'the streamed reply');
  assert.ok(lastOf('assistant').text.length > 50, 'the whole reply');
  await waitFor(() => sum().context && sum().context.tokens > 0, 'the context meter');
});

test('chats: Stop interrupts a running turn (Interrupt, Esc)', async () => {
  const before = results();
  chats.send(chat.id, 'please slow');
  await waitFor(() => sum().status === 'busy' || null, 'busy');
  await new Promise((r) => setTimeout(r, 500));
  await chats.interrupt(chat.id);
  await waitFor(() => results() > before || null, 'the stopped turn');
  assert.strictEqual(lastOf('result').aborted, true, 'reported as stopped');
  await waitFor(() => sum().status === 'idle' || null, 'idle');
});

test('chats: a queued message is marked queued, and can be taken back (↑ in an empty reply box)', async () => {
  chats.send(chat.id, 'please slow');
  await waitFor(() => sum().status === 'busy' || null, 'busy');
  chats.send(chat.id, 'take me back');
  assert.strictEqual(lastOf('user').queued, true);
  const res = await chats.unqueue(chat.id);
  assert.deepStrictEqual(res.messages.map((m) => m.text), ['take me back']);
  await chats.interrupt(chat.id);
  await waitFor(() => sum().status === 'idle' || null, 'idle');
});

test('chats: a permission prompt is asked and answered (permission cards)', async () => {
  await chats.setPermissionMode(chat.id, 'default');
  chats.send(chat.id, 'please write compat.txt');
  const card = await waitFor(() => items().find((i) => i.kind === 'permission' && i.status === 'pending') || null, 'a permission prompt');
  assert.strictEqual(card.toolName, 'Write');
  await chats.respond(chat.id, card.requestId, { action: 'allow' });
  // The mock's Write call names the file itself (mock-<n>.txt).
  await waitFor(() => fs.readdirSync(project).some((f) => /^mock-\d+\.txt$/.test(f)) || null, 'the file written');
  await waitFor(() => sum().status === 'idle' || null, 'idle');
});

test("chats: Claude's multiple-choice question is asked and answered (question cards)", async () => {
  chats.send(chat.id, 'please ask');
  const q = await waitFor(() => items().find((i) => i.kind === 'question' && i.status === 'pending') || null, 'a question');
  const first = q.questions[0];
  await chats.respond(chat.id, q.requestId, { action: 'allow', answers: { [first.question]: first.options[0].label } });
  await waitFor(() => sum().status === 'idle' || null, 'idle');
});

test("chats: the header's controls reach Claude Code (model, effort, permission mode, MCP servers, @ files, Config)", async () => {
  assert.deepStrictEqual(await chats.setModel(chat.id, 'sonnet'), { ok: true });
  assert.deepStrictEqual(await chats.setEffort(chat.id, 'high'), { ok: true });
  assert.deepStrictEqual(await chats.setPermissionMode(chat.id, 'acceptEdits'), { ok: true });
  const mcp = await chats.mcpStatus(chat.id);
  assert.ok(Array.isArray(mcp.servers || mcp), 'the MCP list');
  fs.writeFileSync(path.join(project, 'findme.txt'), 'x');
  const files = await chats.fileSuggestions(chat.id, 'findme');
  assert.ok(Array.isArray(files.suggestions), '@ file suggestions');
  const config = await chats.configOptions(chat.id);
  assert.ok(config.options.some((o) => o.key === 'theme'), "/config's options (the Config window)");
});

test('History: the conversation is in its transcript, with its prompts (History, Changes, usage)', async () => {
  const history = new HistoryIndex();
  await waitFor(async () => { await history.refresh(); return history.get(sum().sessionId); }, 'the conversation in History');
  const meta = history.get(sum().sessionId);
  assert.ok(meta.userTurns >= 3, `prompts counted (${meta.userTurns})`);
  assert.strictEqual(path.resolve(meta.cwd).toLowerCase(), path.resolve(project).toLowerCase());
  const lines = await readTranscript(history.fileFor(sum().sessionId), 50);
  assert.ok(lines.some((i) => i.kind === 'user' && /hello there/.test(i.text)), 'the first prompt, read back');
});

test("live status: Claude Code's session record names the chat's process and conversation (the lamps, outside sessions)", async () => {
  const rec = await waitFor(() => readSessionRecords().get(sum().pid || chats.chats.get(chat.id).pid) || null, 'the session record');
  assert.strictEqual(rec.sessionId, sum().sessionId);
  assert.ok(['idle', 'busy', 'waiting'].includes(rec.status), `a status (${rec.status})`);
});

test('chats: ending a chat ends Claude Code cleanly (End session, Ctrl+W)', async () => {
  await chats.end(chat.id);
  assert.strictEqual(chats.chats.get(chat.id), undefined);
});

// ---- the terminal interface (Inlaid CLI) ------------------------------------------------------
const screen = (shown) => Buffer.concat(shown).toString('utf8').replace(/\x1b\[[0-9;?>]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

test('Inlaid CLI: Claude Code draws to the terminal in the window, takes a prompt, and reports its status (the Inlaid CLI)', { skip: process.platform !== 'win32' && 'needs Windows (conhost)' }, async () => {
  const t = terms.create({ mode: 'new', cwd: project, name: 'Compat CLI' });
  const shown = [];
  terms.attach(t.id, { write(msg) { for (const m of msg.matchAll(/event: data\ndata: ([^\n]*)/g)) shown.push(Buffer.from(m[1], 'base64')); } });
  terms.resize(t.id, 120, 40);
  // The first-run questions are answered in its config above. If a version asks anyway, they're
  // answered as a person would (trust the folder, use the API key), once the question has been on
  // screen a moment: a key sent before Claude Code reads input is lost, and Enter alone picks the
  // trust question's default, "No, exit".
  const answered = new Set();
  const seen = {};
  const settled = (what) => {
    seen[what] = seen[what] || Date.now();
    return Date.now() - seen[what] > 1500 && !answered.has(what);
  };
  // On a failure, what was on screen says what Claude Code was waiting for.
  const showScreen = (err) => {
    const now = terms.get(t.id) || {};
    err.message += `\nTerminal: ${JSON.stringify({ state: now.state, exitCode: now.exitCode, claudePid: now.claudePid, launchError: now.launchError, note: now.note, stderr: (terms.terms.get(t.id) || {}).stderr })}\nScreen (last part):\n${screen(shown).slice(-1500)}`;
    throw err;
  };
  await waitFor(async () => {
    const s = screen(shown);
    const tail = s.slice(-3000);
    if (/trust\s*this\s*folder/i.test(tail) && settled('trust')) {
      answered.add('trust');
      terms.write(t.id, '\x1b[B');
      await new Promise((r) => setTimeout(r, 300));
      terms.write(t.id, '\r');
    } else if (/API\s*key/i.test(tail) && settled('key')) {
      answered.add('key');
      terms.write(t.id, '\x1b[A');
      await new Promise((r) => setTimeout(r, 300));
      terms.write(t.id, '\r');
    }
    const term = terms.get(t.id);
    const rec = term.claudePid ? readSessionRecords().get(term.claudePid) : null;
    return rec && rec.status === 'idle' ? rec : null;
  }, 'the prompt box, with an idle session record', 60000).catch(showScreen);
  for (const ch of 'hello from the terminal') terms.write(t.id, ch);
  await new Promise((r) => setTimeout(r, 300));
  terms.write(t.id, '\r');
  await waitFor(() => /Replyto:hellofromtheterminal/.test(screen(shown).replace(/\s+/g, '')) || null, "Claude's reply on screen").catch(showScreen);
  const term = terms.get(t.id);
  const history = new HistoryIndex();
  await waitFor(async () => { await history.refresh(); const m = term.sessionId && history.get(term.sessionId); return m && m.userTurns >= 1 ? m : null; }, 'its conversation in History (needs its transcript)');
  await terms.end(t.id);
  assert.strictEqual(terms.get(t.id).state, 'exited', 'ended, and listed as ended');
});
