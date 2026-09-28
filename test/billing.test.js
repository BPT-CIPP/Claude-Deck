'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const prefs = require('../src/prefs');
const { findApiBilling, readRegistryEnv } = require('../src/billing');
const { ChatManager } = require('../src/chat');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const project = path.join(box.root, 'project');
fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
// A second folder for the tests below, with nothing in its own settings.
const other = path.join(box.root, 'other');
fs.mkdirSync(path.join(other, '.claude'), { recursive: true });
prefs.save({ claudePath: FAKE });
const managed = path.join(box.root, 'managed-settings.json');
const none = () => ({});
const find = (opts = {}) => findApiBilling({ env: {}, registry: none, managed, ...opts });

test.after(() => box.cleanup());

test('nothing set up: nothing found', () => {
  assert.deepStrictEqual(find({ cwd: project }), []);
});

test('finds API keys and cloud providers in the environment, by name only', () => {
  const found = find({ env: { ANTHROPIC_API_KEY: 'sk-ant-secret-value', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', CLAUDE_CODE_OAUTH_TOKEN: 'plan-token' } });
  assert.deepStrictEqual(found, ["ANTHROPIC_API_KEY in Claude Deck's environment", "CLAUDE_CODE_USE_BEDROCK in Claude Deck's environment"]);
  assert.ok(!found.join(' ').includes('secret'), 'never the value');
});

test("reads Windows' stored environment variable names", { skip: process.platform !== 'win32' }, () => {
  // The one test that reads this PC's registry (names only; nothing is checked against them).
  delete process.env.CLAUDE_DECK_SKIP_SYSTEM_SETTINGS;
  let env;
  try { env = readRegistryEnv(); } finally { process.env.CLAUDE_DECK_SKIP_SYSTEM_SETTINGS = '1'; }
  // Every Windows account has TEMP in its user environment, and every PC has Path in its own.
  assert.ok('TEMP' in env['your Windows user environment'], Object.keys(env['your Windows user environment'] || {}).join(','));
  assert.ok('PATH' in env["this PC's environment"]);
});

test("finds them in Windows' stored environment too (what Windows Terminal tabs get)", () => {
  assert.deepStrictEqual(find({ registry: () => ({ 'your Windows user environment': { ANTHROPIC_AUTH_TOKEN: 'x' } }) }), ['ANTHROPIC_AUTH_TOKEN in your Windows user environment']);
});

test("finds them in Claude Code's settings: managed, user and the project's own", () => {
  fs.writeFileSync(managed, JSON.stringify({ env: { CLAUDE_CODE_USE_FOUNDRY: '1' } }));
  fs.writeFileSync(path.join(box.claudeDir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'get-key.cmd', env: { SOMETHING_ELSE: '1' } }));
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-x' } }));
  assert.deepStrictEqual(find({ cwd: project }), [
    `CLAUDE_CODE_USE_FOUNDRY in ${managed}`,
    `apiKeyHelper in ${path.join(box.claudeDir, 'settings.json')}`,
    `ANTHROPIC_API_KEY in ${path.join(project, '.claude', 'settings.local.json')}`,
  ]);
  assert.strictEqual(find().length, 2, "without a folder, only what applies everywhere");
  fs.rmSync(managed);
  fs.rmSync(path.join(box.claudeDir, 'settings.json'));
});

test('finds them in managed-settings.d drop-ins and the registry policy', () => {
  const dropIns = path.join(box.root, 'managed-settings.d');
  fs.mkdirSync(dropIns, { recursive: true });
  fs.writeFileSync(path.join(dropIns, '20-keys.json'), JSON.stringify({ apiKeyHelper: 'get-key.cmd' }));
  fs.writeFileSync(path.join(dropIns, 'notes.txt'), JSON.stringify({ apiKeyHelper: 'ignored' }));
  try {
    const found = find({ policy: () => ({ "this PC's Claude Code policy": JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: '1' } }), 'your Claude Code policy': 'not json' }) });
    assert.deepStrictEqual(found, ["CLAUDE_CODE_USE_VERTEX in this PC's Claude Code policy", `apiKeyHelper in ${path.join(dropIns, '20-keys.json')}`]);
  } finally {
    fs.rmSync(dropIns, { recursive: true, force: true });
  }
});

test('checks a --settings argument, file or JSON, and refuses one it cannot read', () => {
  const file = path.join(other, 'extra.json');
  fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-x' } }));
  assert.deepStrictEqual(find({ cwd: other, args: ['--settings', 'extra.json'] }), [`ANTHROPIC_API_KEY in ${file}`], 'relative to the folder');
  assert.deepStrictEqual(find({ args: ['--settings={"apiKeyHelper":"k.cmd"}'] }), ['apiKeyHelper in the --settings argument']);
  assert.deepStrictEqual(find({ args: ['--settings', '{"permissions":{}}'] }), [], 'settings without billing are fine');
  assert.strictEqual(find({ cwd: other, args: ['--settings', 'missing.json'] }).length, 1, 'unreadable counts against it');
  assert.strictEqual(find({ args: ['--settings'] }).length, 1, 'nothing after it counts against it');
  fs.rmSync(file);
});

test('every way of starting Claude Code runs the guard', async () => {
  const { Launcher } = require('../src/launcher');
  const { Registry } = require('../src/registry');
  const launcher = new Launcher({ registry: new Registry() });
  const refused = (e) => e.status === 403 && /Claude Deck didn't start this session/.test(e.message);
  const m = new ChatManager({ file: path.join(box.root, 'chats-guard.json') });
  try {
    // A terminal launch, extra arguments included, is refused before Windows Terminal starts.
    fs.writeFileSync(path.join(other, 'k.json'), JSON.stringify({ apiKeyHelper: 'k.cmd' }));
    assert.throws(() => launcher.launch({ cwd: other, extraArgs: '--settings k.json' }), refused);
    assert.throws(() => m.create({ cwd: other, extraArgs: '--settings k.json' }), refused);
    fs.rmSync(path.join(other, 'k.json'));
    // Resuming a terminal session that was fine when it started, after a key was added.
    launcher.registry.add({ id: 't1', cwd: other, options: {}, expectedSessionId: '11111111-2222-4333-8444-555555555555' });
    fs.writeFileSync(path.join(other, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }));
    assert.throws(() => launcher.resume('t1'), refused);
    // Resuming a chat.
    fs.rmSync(path.join(other, '.claude', 'settings.local.json'));
    const c = m.create({ cwd: other });
    await m.end(c.id, { keep: true });
    fs.writeFileSync(path.join(other, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }));
    assert.throws(() => m.resume(c.id), refused);
  } finally {
    fs.rmSync(path.join(other, '.claude', 'settings.local.json'), { force: true });
    await m.endAll();
    clearInterval(m.sleepTimer);
  }
});

test('a chat is refused until API billing is allowed in Preferences', async () => {
  const m = new ChatManager({ file: path.join(box.root, 'chats.json') });
  try {
    assert.throws(() => m.create({ cwd: project, prompt: 'hi' }), (e) => e.status === 403 && /Claude Deck didn't start this session/.test(e.message) && /settings\.local\.json/.test(e.message) && /Allow API billing/.test(e.message));
    assert.strictEqual(m.list().length, 0, 'nothing was started');
    prefs.save({ allowApiBilling: true });
    const c = m.create({ cwd: project, prompt: 'hi' });
    assert.strictEqual(c.kind, 'chat', 'started once allowed');
  } finally {
    prefs.save({ allowApiBilling: false });
    await m.endAll();
    clearInterval(m.sleepTimer);
  }
});
