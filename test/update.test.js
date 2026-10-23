'use strict';
// Check for updates, against throwaway git repositories: a bare one standing in for GitHub and a
// clone standing in for an installed Claude Deck. No network; no GitHub CLI (auth is left out), and
// winget is never run for real.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sandbox } = require('./helpers');

const box = sandbox();
const { checkForUpdates } = require('../src/update');

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const origin = path.join(box.root, 'origin.git');
const author = path.join(box.root, 'author');
const install = path.join(box.root, 'install');
const check = (opts = {}) => checkForUpdates({ root: install, auth: [], ...opts });
const release = (version) => {
  fs.writeFileSync(path.join(author, 'package.json'), JSON.stringify({ name: 'claude-deck', version }));
  git(author, 'commit', '-qam', `release ${version}`);
  git(author, 'push', '-q', 'origin', 'main');
};

test.before(() => {
  git(box.root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(box.root, 'init', '-q', '-b', 'main', author);
  fs.writeFileSync(path.join(author, 'package.json'), JSON.stringify({ name: 'claude-deck', version: '1.0.0' }));
  fs.writeFileSync(path.join(author, 'README.md'), 'Claude Deck\n');
  git(author, 'add', '.');
  git(author, 'commit', '-qm', 'first');
  git(author, 'remote', 'add', 'origin', origin);
  git(author, 'push', '-q', 'origin', 'main');
  git(box.root, 'clone', '-q', origin, install);
  // The suggested commands run plain git (stash and rebase need a name to record).
  git(install, 'config', 'user.name', 'Test');
  git(install, 'config', 'user.email', 'test@example.com');
});

// Runs a suggested command the way the person would: in Windows PowerShell.
const runCommand = (command) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${command}`],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const refusal = async (promise) => {
  try { await promise; } catch (err) { return err; }
  return assert.fail('expected Check for updates to refuse');
};
test.after(() => box.cleanup());

const version = () => JSON.parse(fs.readFileSync(path.join(install, 'package.json'), 'utf8')).version;

test('up to date: nothing to do', async () => {
  assert.deepStrictEqual(await check(), { updated: false, available: false, from: '1.0.0', to: '1.0.0' });
});

test('a newer version is reported first, and only applied when asked', async () => {
  release('1.1.0');
  assert.deepStrictEqual(await check(), { updated: false, available: true, from: '1.0.0', to: '1.1.0' });
  assert.strictEqual(version(), '1.0.0', 'checking changes nothing');
  assert.deepStrictEqual(await check({ apply: true }), { updated: true, available: true, from: '1.0.0', to: '1.1.0' });
  assert.strictEqual(version(), '1.1.0');
  assert.strictEqual((await check()).available, false);
});

const cd = `cd '${install.replace(/'/g, "''")}'; `;

test("a copy with local changes isn't touched, and the command given keeps them while updating", async () => {
  release('1.2.0');
  fs.writeFileSync(path.join(install, 'README.md'), 'Claude Deck, edited here\n');
  const err = await refusal(check({ apply: true }));
  assert.match(err.message, /changes of its own/);
  assert.strictEqual(err.command, `${cd}git stash; git pull --ff-only; git stash pop`);
  assert.ok(err.message.endsWith(`run this in PowerShell: ${err.command}`));
  assert.strictEqual(version(), '1.1.0', 'not updated');
  runCommand(err.command);
  assert.strictEqual(version(), '1.2.0', 'updated by the command');
  // Line endings can come back as CRLF, depending on the PC's git settings (core.autocrlf).
  assert.strictEqual(fs.readFileSync(path.join(install, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'Claude Deck, edited here\n', 'the edit is back');
  git(install, 'checkout', '--', 'README.md');
});

test("a copy on another branch isn't touched, and the command given switches to main and updates", async () => {
  git(install, 'checkout', '-q', '-b', 'feature/mine');
  release('1.3.0');
  const err = await refusal(check({ apply: true }));
  assert.match(err.message, /on the feature\/mine branch, not main/);
  assert.strictEqual(err.command, `${cd}git switch main; git pull --ff-only`);
  runCommand(err.command);
  assert.strictEqual(git(install, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.strictEqual(version(), '1.3.0');
});

test("a copy with commits GitHub doesn't have isn't touched, and the command given keeps them on top", async () => {
  fs.writeFileSync(path.join(install, 'local.txt'), 'mine');
  git(install, 'add', 'local.txt');
  git(install, 'commit', '-qm', 'local work');
  release('1.4.0');
  const err = await refusal(check({ apply: true }));
  assert.match(err.message, /commits that aren't on GitHub/);
  assert.strictEqual(err.command, `${cd}git pull --rebase origin main`);
  runCommand(err.command);
  assert.strictEqual(version(), '1.4.0');
  assert.ok(fs.existsSync(path.join(install, 'local.txt')), 'the local commit is kept');
  git(install, 'reset', '-q', '--hard', 'origin/main');
  assert.strictEqual((await check()).available, false, 'up to date once the local commit is gone');
});

test("a copy that wasn't cloned with git says so", async () => {
  const plain = path.join(box.root, 'plain');
  fs.mkdirSync(plain);
  await assert.rejects(checkForUpdates({ root: plain, auth: [] }), /wasn't installed with git clone/);
});

test('GitHub not reachable: says to check the connection, with nothing to install', async () => {
  git(install, 'remote', 'set-url', 'origin', path.join(box.root, 'missing.git'));
  const err = await refusal(check());
  assert.match(err.message, /Couldn't get the latest version from GitHub .*internet connection/);
  assert.strictEqual(err.prerequisite, undefined);
  git(install, 'remote', 'set-url', 'origin', origin);
});

test('no Git on this PC: says so, as a prerequisite the page offers to install', async () => {
  const err = await refusal(check({ find: () => null }));
  assert.strictEqual(err.prerequisite, 'git');
  assert.match(err.message, /Git isn't installed/);
});

test('signs in through the GitHub CLI only when it is there, and by its full path', () => {
  const { authArgs } = require('../src/update');
  assert.deepStrictEqual(authArgs(null), ['-c', 'credential.helper='], 'no GitHub CLI: no credential helper at all');
  assert.deepStrictEqual(authArgs('C:\\Program Files\\GitHub CLI\\gh.exe'), ['-c', 'credential.helper=', '-c', "credential.helper=!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential"]);
});

test('GitHub asking for a sign-in: the GitHub CLI to install, or to sign in with', () => {
  const { fetchFailure } = require('../src/update');
  // What git 2.x says for a repository that isn't public, with prompts off and no helper (seen 2026-10-23).
  const asked = Object.assign(new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), { stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n" });
  const noGh = fetchFailure(asked, null);
  assert.strictEqual(noGh.prerequisite, 'gh');
  assert.match(noGh.message, /GitHub CLI, which isn't installed/);
  const withGh = fetchFailure(asked, 'C:\\gh.exe');
  assert.strictEqual(withGh.prerequisite, undefined);
  assert.strictEqual(withGh.command, 'gh auth login');
  const offline = fetchFailure(new Error('fatal: unable to access: Could not resolve host: github.com'), null);
  assert.strictEqual(offline.prerequisite, undefined);
  assert.match(offline.message, /internet connection/);
});

test('installing a prerequisite: only Git or the GitHub CLI, nothing to do when it is there, and a clear message when winget fails', async () => {
  const { installTool } = require('../src/update');
  assert.throws(() => installTool('node'), /only installs Git or the GitHub CLI/);
  assert.deepStrictEqual(await installTool('gh', { find: () => 'C:\\gh.exe', winget: 'no-such-winget.exe' }), { label: 'the GitHub CLI', path: 'C:\\gh.exe' });
  await assert.rejects(installTool('git', { find: () => null, winget: 'no-such-winget.exe' }), /winget isn't available on this PC/);
  // Something that runs and exits without installing it (node, given winget's arguments).
  await assert.rejects(installTool('git', { find: () => null, winget: process.execPath }), /winget didn't install Git.*git-scm\.com/);
  // Found once winget is done: installed.
  let calls = 0;
  const found = await installTool('git', { find: () => (calls++ ? 'C:\\Program Files\\Git\\cmd\\git.exe' : null), winget: process.execPath });
  assert.strictEqual(found.path, 'C:\\Program Files\\Git\\cmd\\git.exe');
});
