'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const prefs = require('../src/prefs');
const { PluginManager } = require('../src/plugins');
const { ChatManager } = require('../src/chat');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const cwd = path.join(box.root, 'project');
fs.mkdirSync(cwd);
prefs.save({ claudePath: FAKE });

const pm = new PluginManager();
const mgr = new ChatManager();

async function waitFor(fn, what, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test.after(async () => {
  await mgr.endAll();
  box.cleanup();
});

test('lists installed plugins and what the marketplaces offer, and caches the list', async () => {
  const list = await pm.list(cwd);
  assert.deepStrictEqual(list.installed, []);
  assert.deepStrictEqual(list.available.map((p) => [p.id, p.name, p.marketplace]), [
    ['hello@fake-market', 'hello', 'fake-market'],
    ['scripted@fake-market', 'scripted', 'fake-market'],
    ['tools@fake-market', 'tools', 'fake-market'],
  ]);
  assert.strictEqual(list.available[0].description, 'Adds a /hello command.');
  assert.strictEqual(await pm.list(cwd), list, 'the second call is served from the cache');
});

test("each plugin carries the category its marketplace gives it, or none", async () => {
  const list = await pm.list(cwd, { refresh: true });
  assert.deepStrictEqual(list.available.map((p) => [p.id, p.category]), [
    ['hello@fake-market', 'productivity'],
    ['scripted@fake-market', null],
    ['tools@fake-market', 'development'],
  ]);
});

test('installing moves a plugin to installed, with its description from its own plugin.json', async () => {
  assert.deepStrictEqual(await pm.install('hello@fake-market', { cwd }), { ok: true, scope: 'user' });
  const list = await pm.list(cwd);
  assert.deepStrictEqual(list.installed.map((p) => [p.id, p.enabled, p.scope, p.description, p.category]), [['hello@fake-market', true, 'user', 'Adds a /hello command.', 'productivity']]);
  assert.ok(!list.available.some((p) => p.id === 'hello@fake-market'));
});

test('a plugin installed by a declared command waits for a person to accept that exact command', async () => {
  const first = await pm.install('scripted@fake-market', { cwd });
  assert.deepStrictEqual(first, { ok: false, needsConfirmation: true, command: 'npx fake-plugin-installer', sha256: 'f00dfeed', archiveUrl: null });
  assert.strictEqual((await pm.install('scripted@fake-market', { cwd, acceptCommand: 'deadbeef' })).needsConfirmation, true, 'another checksum accepts nothing');
  assert.strictEqual((await pm.install('scripted@fake-market', { cwd, acceptCommand: 'f00dfeed' })).ok, true);
});

test('turning plugins off and on, and the errors a person sees', async () => {
  await pm.setEnabled('scripted@fake-market', false, cwd);
  assert.strictEqual((await pm.list(cwd)).installed.find((p) => p.id === 'scripted@fake-market').enabled, false);
  await pm.setEnabled('scripted@fake-market', true, cwd);
  assert.strictEqual((await pm.list(cwd)).installed.find((p) => p.id === 'scripted@fake-market').enabled, true);
  await assert.rejects(pm.setEnabled('tools@fake-market', true, cwd), /Couldn't turn on tools@fake-market: Plugin "tools@fake-market" is not installed/);
  await assert.rejects(pm.install('missing@fake-market', { cwd }), /Couldn't install missing@fake-market: Plugin "missing" not found/);
  // Passed to Claude Code as an argument, this would read as a flag (disable --all).
  await assert.rejects(pm.setEnabled('--all', false, cwd), /isn't a valid plugin/);
  await assert.rejects(pm.install('', { cwd }), /Enter a plugin/);
});

test('marketplaces can be listed, added, updated and removed', async () => {
  assert.deepStrictEqual(await pm.marketplaces(), [{ name: 'fake-market', source: 'github', location: 'example/fake-market' }]);
  assert.deepStrictEqual(await pm.addMarketplace('example/more-plugins'), { ok: true, message: 'Successfully added marketplace: more-plugins (declared in user settings)' });
  assert.deepStrictEqual((await pm.marketplaces()).map((m) => m.name), ['fake-market', 'more-plugins']);
  await assert.rejects(pm.addMarketplace('C:\\does-not-exist'), /Couldn't add the marketplace: Path does not exist: C:\\does-not-exist/);
  assert.strictEqual((await pm.updateMarketplaces()).message, 'Successfully updated 2 marketplaces');
  await pm.removeMarketplace('more-plugins');
  assert.deepStrictEqual((await pm.marketplaces()).map((m) => m.name), ['fake-market']);
  await assert.rejects(pm.removeMarketplace('more-plugins'), /Couldn't remove the marketplace: Marketplace 'more-plugins' not found/);
});

test('a change reaches a running chat once Claude has re-read its settings', async () => {
  const c = mgr.create({ cwd, prompt: '' });
  await waitFor(() => mgr.detail(c.id).commands.some((x) => x.name === 'hello:hello'), 'the plugin command at start');
  await pm.setEnabled('hello@fake-market', false, cwd);
  const started = Date.now();
  // The first reload comes too soon for Claude to have noticed; it keeps trying until it has.
  assert.deepStrictEqual(await mgr.reloadPlugins(c.id, { pluginId: 'hello@fake-market', enabled: false }), { applied: true });
  assert.ok(Date.now() - started >= 400, 'it waited for the settings change to be seen');
  assert.ok(!mgr.detail(c.id).commands.some((x) => x.name === 'hello:hello'), 'the plugin command is gone');
  assert.strictEqual([...mgr.detail(c.id).items].reverse().find((i) => i.kind === 'note').text, 'hello is off in this chat now.');
  await mgr.end(c.id);
});

test('mid-conversation, a reload that changes the tools waits for a yes, then applies', async () => {
  const c = mgr.create({ cwd, prompt: 'hi' });
  await waitFor(() => mgr.detail(c.id).items.some((i) => i.kind === 'result'), 'the first reply');
  await pm.install('tools@fake-market', { cwd });
  await new Promise((r) => setTimeout(r, 450)); // past the settings re-read
  assert.deepStrictEqual(await mgr.reloadPlugins(c.id, { pluginId: 'tools@fake-market', enabled: true }), { applied: false, held: true });
  assert.deepStrictEqual(await mgr.reloadPlugins(c.id, { pluginId: 'tools@fake-market', enabled: true, force: true }), { applied: true });
  await mgr.end(c.id, { keep: true });
  assert.deepStrictEqual(await mgr.reloadPlugins(c.id, { pluginId: 'tools@fake-market', enabled: true }), { applied: false, reason: 'ended' });
});
