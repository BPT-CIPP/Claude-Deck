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
  const env = readRegistryEnv();
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
