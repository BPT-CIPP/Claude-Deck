'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { sandbox } = require('./helpers');

const box = sandbox();
const prefs = require('../src/prefs');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
// Keep the servers hermetic: the fake answers `--version` without touching the real Claude.
prefs.save({ claudePath: path.join(__dirname, 'fixtures', 'fake-claude.js') });
const env = { ...process.env, CLAUDE_CONFIG_DIR: box.claudeDir, CLAUDE_DECK_DATA: box.dataDir };

let first;
test.after(() => {
  if (first && first.exitCode === null) first.kill();
  box.cleanup();
});

test('a second server exits with code 3 when one is already running', async () => {
  first = spawn(process.execPath, [SERVER, '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('first server did not start')), 15000);
    first.stdout.on('data', (d) => { if (String(d).includes('Claude Deck running at')) { clearTimeout(timer); resolve(); } });
    first.on('exit', (code) => reject(new Error(`first server exited early (${code})`)));
  });
  const second = spawnSync(process.execPath, [SERVER, '--port', '0'], { env, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(second.status, 3, second.stderr);
  assert.match(second.stdout, /already running/);
  assert.strictEqual(first.exitCode, null, 'the first server keeps running');
});
