'use strict';
// Check for updates, against throwaway git repositories: a bare one standing in for GitHub and a
// clone standing in for an installed Claude Deck. No network; no GitHub CLI (auth is left out).

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

test('GitHub not reachable: says to check the GitHub CLI sign-in', async () => {
  git(install, 'remote', 'set-url', 'origin', path.join(box.root, 'missing.git'));
  await assert.rejects(check(), /gh auth status/);
});
