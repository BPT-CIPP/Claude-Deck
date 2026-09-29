'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const models = require('../src/models');
const { MODEL_ALIASES } = require('../src/launcher');
const { autoUpdateStatus } = require('../src/claude-locate');

test.after(() => box.cleanup());

// initialize's `models` from claude.exe 2.1.284 (effort fields left out).
const REAL = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
];

const family = (menu, name) => menu.families.find((f) => f.name === name);
const values = (f) => f.items.map((i) => i.value);

test('the menu has a flyout per model family, named with its version', () => {
  const menu = models.menu(REAL, MODEL_ALIASES);
  assert.deepStrictEqual(menu.families.map((f) => f.version), ['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 4.5']);
  const sonnet = family(menu, 'Sonnet');
  assert.deepStrictEqual(values(sonnet), ['sonnet', 'sonnet[1m]', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]']);
  assert.deepStrictEqual(sonnet.items.map((i) => i.label), ['Sonnet 5.5', 'Sonnet 5.5 · 1M context', 'Sonnet 5.5 only', 'Sonnet 5.5 only · 1M context']);
  assert.ok(values(family(menu, 'Opus')).includes('opusplan'), 'opusplan is an Opus variant');
  // Claude Code's own value for Fable is the pinned 1M one; it's listed once.
  assert.deepStrictEqual(values(family(menu, 'Fable')), ['fable', 'fable[1m]', 'claude-fable-5-1', 'claude-fable-5-1[1m]']);
  assert.deepStrictEqual(values(family(menu, 'Haiku')), ['haiku', 'claude-haiku-4-5-20251001']);
  assert.deepStrictEqual(menu.extras.map((x) => x.value), ['best']);
  // Every alias the CLI accepts is still somewhere in the menu.
  const all = [...menu.families.flatMap(values), ...menu.extras.map((x) => x.value)];
  for (const a of MODEL_ALIASES) assert.ok(all.includes(a), a);
});

test('without a list from Claude Code, the families come from the aliases, without versions', () => {
  const menu = models.menu([], MODEL_ALIASES);
  assert.deepStrictEqual(menu.families.map((f) => f.name), ['Opus', 'Sonnet', 'Haiku', 'Fable']);
  assert.deepStrictEqual(values(family(menu, 'Sonnet')), ['sonnet', 'sonnet[1m]']);
  assert.deepStrictEqual(family(menu, 'Sonnet').items.map((i) => i.label), ['Sonnet', 'Sonnet · 1M context']);
  assert.deepStrictEqual(menu.extras.map((x) => x.value), ['opusplan', 'best']);
});

// The same Claude Code signed in with an API key (the sandbox): 1M variants listed on their own,
// with different display names, and prices in the descriptions.
const WITH_API_KEY = [
  { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5 (1M context)) · $4/$20 per Mtok' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks · $4/$20 per Mtok' },
  { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok' },
  { value: 'sonnet[1m]', resolvedModel: 'claude-sonnet-5-5[1m]', displayName: 'Sonnet 5.5 (1M context)', description: 'Sonnet 5.5 for long sessions · $2/$10 per Mtok' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok' },
];

test('a family listed more than once, under other names, is still one flyout', () => {
  const menu = models.menu(WITH_API_KEY, MODEL_ALIASES);
  assert.deepStrictEqual(menu.families.map((f) => f.version), ['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 4.5']);
  assert.deepStrictEqual(values(family(menu, 'Opus')), ['opus', 'opus[1m]', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'opusplan']);
  assert.deepStrictEqual(values(family(menu, 'Sonnet')), ['sonnet', 'sonnet[1m]', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]']);
});

test('a model is named with its version where its name or description gives one', () => {
  assert.strictEqual(models.versionName({ displayName: 'Sonnet', description: 'Efficient for routine tasks' }, 'Sonnet'), 'Sonnet');
  assert.strictEqual(models.versionName({ displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient' }, 'Sonnet'), 'Sonnet 5.5');
  assert.strictEqual(models.versionName({ displayName: 'Sonnet 5.5 (1M context)', description: '' }, 'Sonnet'), 'Sonnet 5.5');
  assert.strictEqual(models.familyOf({ value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1' }), 'fable');
  assert.strictEqual(models.familyOf({ value: 'opus[1m]', resolvedModel: '' }), 'opus');
  assert.strictEqual(models.familyOf({ value: 'something-else', resolvedModel: '' }), null);
});

test('the list is kept with the Claude Code version it came from', () => {
  assert.deepStrictEqual(models.load(), { claudeVersion: null, models: [] });
  assert.strictEqual(models.remember(REAL, '2.1.284 (Claude Code)'), true);
  assert.strictEqual(models.remember(REAL, '2.1.284 (Claude Code)'), false, 'unchanged');
  const saved = models.load();
  assert.strictEqual(saved.claudeVersion, '2.1.284 (Claude Code)');
  assert.deepStrictEqual(saved.models[3], { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks' });
  assert.strictEqual(models.remember([], '2.1.285'), false, 'an empty list never replaces one');
  assert.strictEqual(models.remember([{ nope: 1 }], '2.1.285'), false);
});

test('Claude Code is asked for its models without sending a prompt', async () => {
  const fake = path.join(__dirname, 'fixtures', 'fake-claude.js');
  const list = await models.probe(fake);
  assert.deepStrictEqual(models.sanitize(list).map((m) => m.value), ['default', 'opus', 'sonnet', 'haiku']);
  // Nothing was said to Claude, so no conversation was written.
  assert.deepStrictEqual(fs.readdirSync(path.join(box.claudeDir, 'projects')), []);
});

test('a Claude Code that cannot start gives no list', async () => {
  assert.strictEqual(await models.probe(path.join(box.root, 'missing.exe')), null);
});

test('automatic updates are on unless Claude Code is told not to', () => {
  const settingsFile = path.join(box.root, 'settings.json');
  assert.deepStrictEqual(autoUpdateStatus({ env: {}, settingsFile }), { enabled: true, blockedBy: null, channel: 'latest' });
  fs.writeFileSync(settingsFile, JSON.stringify({ autoUpdatesChannel: 'stable', env: { DISABLE_AUTOUPDATER: '1' } }));
  assert.deepStrictEqual(autoUpdateStatus({ env: {}, settingsFile }), { enabled: false, blockedBy: 'DISABLE_AUTOUPDATER', channel: 'stable' });
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { DISABLE_AUTOUPDATER: '0' } }));
  assert.strictEqual(autoUpdateStatus({ env: {}, settingsFile }).enabled, true, '0 leaves them on');
  assert.deepStrictEqual(autoUpdateStatus({ env: { DISABLE_UPDATES: '1' }, settingsFile }).blockedBy, 'DISABLE_UPDATES');
});
