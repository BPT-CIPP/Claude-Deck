'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const models = require('../src/models');
const { MODEL_ALIASES } = require('../src/launcher');
const { autoUpdateStatus, locateClaude, compareVersions, latestRelease, binaryStamp, updateFailure } = require('../src/claude-locate');

test('versions compare as numbers, read from what claude --version prints', () => {
  assert.ok(compareVersions('2.1.309', '2.1.308 (Claude Code)') > 0);
  assert.ok(compareVersions('2.1.10', '2.1.9') > 0, 'not as text');
  assert.strictEqual(compareVersions('2.1.308', '2.1.308 (Claude Code)'), 0);
  assert.ok(compareVersions('2.1.299', '2.2.0') < 0);
  assert.strictEqual(compareVersions('garbage', '2.1.308'), 0, "can't tell: not newer");
});

test("the newest release is the one on Claude Code's own update channel", async () => {
  // npm's dist-tags for @anthropic-ai/claude-code, as of 2026-10-23.
  const fetcher = async () => ({ latest: '2.1.309', stable: '2.1.308', next: '2.1.309' });
  assert.deepStrictEqual(await latestRelease('latest', { fetcher }), { version: '2.1.309', channel: 'latest' });
  assert.deepStrictEqual(await latestRelease('stable', { fetcher }), { version: '2.1.308', channel: 'stable' });
  assert.strictEqual(await latestRelease('beta', { fetcher }), null, 'a channel npm has no tag for');
  assert.strictEqual(await latestRelease('latest', { fetcher: async () => ({ latest: 'soon' }) }), null, 'not a version');
  await assert.rejects(latestRelease('latest', { fetcher: async () => { throw new Error('offline'); } }), /offline/);
});

test("a failed claude update gives its reason, not its last line of advice", () => {
  // What 2.1.309 prints when npm doesn't name the newest version in the 5 seconds it allows. The
  // last line once became the whole error ("check if you need to login"), read as Claude's sign-in.
  const npmSlow = 'Current version: 2.1.309\nChecking for updates to latest version...\n\x1b[31mFailed to check for updates\x1b[39m\nUnable to fetch latest version from npm registry\n\nPossible causes:\n  • Network connectivity issues\n\nTry:\n  • Check your internet connection\n  • Check if you need to login: npm whoami';
  assert.deepStrictEqual(updateFailure(npmSlow), { npmLookup: true, reason: "Claude Code couldn't get the newest version number from npm in time" });
  const native = 'Current version: 2.1.309\nChecking for updates to latest version...\nError: Failed to install native update\nchecksum mismatch\nTry running "claude doctor" for diagnostics';
  assert.deepStrictEqual(updateFailure(native), { npmLookup: false, reason: 'Error: Failed to install native update' });
  assert.deepStrictEqual(updateFailure('something else went wrong\n'), { npmLookup: false, reason: 'something else went wrong' });
  assert.deepStrictEqual(updateFailure(''), { npmLookup: false, reason: 'no reason given' });
});

test("a file's stamp changes when the file does, and is null when it's missing", () => {
  const file = path.join(box.root, 'stamp-me.exe');
  fs.writeFileSync(file, 'one');
  const first = binaryStamp(file);
  fs.writeFileSync(file, 'two, longer');
  assert.notStrictEqual(binaryStamp(file), first);
  assert.strictEqual(binaryStamp(path.join(box.root, 'missing.exe')), null);
});

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
  // The latest first, by name; then the specific versions, by model ID.
  assert.deepStrictEqual(sonnet.items.map((i) => i.label), ['Sonnet 5.5', 'Sonnet 5.5 · 1M context', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]']);
  assert.deepStrictEqual(sonnet.items.map((i) => i.pinned), [false, false, true, true]);
  assert.match(sonnet.items[2].hint, /^Sonnet 5\.5; stays on this version/);
  assert.deepStrictEqual(values(family(menu, 'Opus')), ['opus', 'opus[1m]', 'opusplan', 'claude-opus-5-5', 'claude-opus-5-5[1m]'], 'opusplan follows the latest too');
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
  assert.deepStrictEqual(values(family(menu, 'Opus')), ['opus', 'opus[1m]', 'opusplan', 'claude-opus-5-5', 'claude-opus-5-5[1m]']);
  assert.deepStrictEqual(values(family(menu, 'Sonnet')), ['sonnet', 'sonnet[1m]', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]']);
});

// A chat's initialize on a Claude plan (2.1.284, from Claude Deck's models.json): versioned display
// names, and earlier versions still offered, listed by model ID.
const WITH_OLDER = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' },
  { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'For your toughest challenges' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
  { value: 'claude-sonnet-5', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Efficient for routine tasks' },
  { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', description: 'Best for everyday, complex tasks' },
  { value: 'claude-fable-5', resolvedModel: 'claude-fable-5', displayName: 'Fable 5', description: 'Most capable for your hardest and longest-running tasks' },
  { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Best for everyday, complex tasks' },
  { value: 'claude-opus-4-7', resolvedModel: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Best for everyday, complex tasks' },
  { value: 'claude-opus-4-6', resolvedModel: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Best for everyday, complex tasks' },
  { value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Efficient for routine tasks' },
];

test('earlier versions are specific versions too, named by model ID after the newest', () => {
  const menu = models.menu(WITH_OLDER, MODEL_ALIASES);
  assert.deepStrictEqual(menu.families.map((f) => f.version), ['Opus 5.5', 'Sonnet 5.5', 'Fable 5.1', 'Haiku 4.5']);
  const opus = family(menu, 'Opus');
  assert.deepStrictEqual(opus.items.map((i) => i.label), ['Opus 5.5', 'Opus 5.5 · 1M context', 'Opus 5.5 for planning',
    'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6']);
  assert.deepStrictEqual(opus.items.filter((i) => !i.pinned).map((i) => i.value), ['opus', 'opus[1m]', 'opusplan']);
  assert.strictEqual(opus.items.find((i) => i.value === 'claude-opus-4-8').hint, 'Opus 4.8: Best for everyday, complex tasks');
  assert.deepStrictEqual(values(family(menu, 'Sonnet')), ['sonnet', 'sonnet[1m]', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', 'claude-sonnet-5', 'claude-sonnet-4-6']);
  assert.deepStrictEqual(values(family(menu, 'Fable')), ['fable', 'fable[1m]', 'claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-fable-5']);
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

test('finds a Claude Code installed with winget or npm even when it is not on this PATH', (t) => {
  const saved = ['PATH', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'].map((k) => [k, process.env[k]]);
  t.after(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  // A server started before Claude Code was installed: its PATH doesn't have Claude Code's folder.
  process.env.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  process.env.USERPROFILE = path.join(box.root, 'home');
  process.env.LOCALAPPDATA = path.join(box.root, 'local');
  process.env.APPDATA = path.join(box.root, 'roaming');
  assert.strictEqual(locateClaude(null), null);
  // Empty placeholder files: located, never run.
  const npmExe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(npmExe), { recursive: true });
  fs.writeFileSync(npmExe, '');
  assert.deepStrictEqual(locateClaude(null), { path: npmExe, source: 'npm global install' });
  const wingetExe = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'claude.exe');
  fs.mkdirSync(path.dirname(wingetExe), { recursive: true });
  fs.writeFileSync(wingetExe, '');
  assert.deepStrictEqual(locateClaude(null), { path: wingetExe, source: 'winget' });
});
