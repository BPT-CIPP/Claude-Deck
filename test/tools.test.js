'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { blockReason } = require('../.claude/hooks/guard-git-push');

const on = (branch) => () => branch;

test('the push guard blocks every way of pushing to main or force-pushing', () => {
  const blocked = [
    ['git push origin main', 'feature/x'],
    ['git push -u origin main', 'feature/x'],
    ['git push origin HEAD:main', 'feature/x'],
    ['git push origin feature/x:refs/heads/main', 'feature/x'],
    ['git push origin :main', 'feature/x'],
    ['git push', 'main'],
    ['git push origin', 'main'],
    ['git push origin HEAD', 'main'],
    ['git push --force', 'feature/x'],
    ['git push -f origin feature/x', 'feature/x'],
    ['git push -uf origin feature/x', 'feature/x'],
    ['git push --force-with-lease origin feature/x', 'feature/x'],
    ['git push origin feature/x --force', 'feature/x'],
    ['git push origin +feature/x', 'feature/x'],
    ['git push --all origin', 'feature/x'],
    ['git -C . push origin main', 'feature/x'],
    ['git -c core.x=y push origin main', 'feature/x'],
    ['npm run verify && git push origin main', 'feature/x'],
    ['cd repo; git push "origin" "main"', 'feature/x'],
    ['C:\\Program Files\\Git\\cmd\\git.exe push origin main', 'feature/x'],
  ];
  for (const [cmd, branch] of blocked) assert.ok(blockReason(cmd, on(branch)), `blocked: ${cmd} (on ${branch})`);
});

test('the push guard lets feature-branch pushes and other commands through', () => {
  const allowed = [
    ['git push -u origin feature/x', 'feature/x'],
    ['git push', 'feature/x'],
    ['git push origin HEAD', 'feature/x'],
    ['git push origin main:feature/x', 'feature/x'],
    ['git status && git log --oneline -3', 'main'],
    ['echo "git push origin main"', 'feature/x'],
    ['git pull --rebase origin main', 'main'],
  ];
  for (const [cmd, branch] of allowed) assert.strictEqual(blockReason(cmd, on(branch)), null, `allowed: ${cmd} (on ${branch})`);
});

test('the push guard runs as a hook: exit code 2 with the reason blocks the call', () => {
  const hook = path.join(__dirname, '..', '.claude', 'hooks', 'guard-git-push.js');
  const run = (command) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: process.cwd() }), encoding: 'utf8' });
  const r = run('git push origin HEAD:main');
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /pull requests/);
  assert.strictEqual(run('git log --oneline -1').status, 0);
});
