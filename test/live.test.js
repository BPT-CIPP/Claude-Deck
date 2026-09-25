'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const { Live } = require('../src/live');
const { Registry } = require('../src/registry');
const { HistoryIndex } = require('../src/history');
const prefs = require('../src/prefs');

test.after(() => box.cleanup());

const SID = 'cccccccc-dddd-4eee-8fff-000000000000';
// This test process stands in for Claude: its pid is guaranteed to be alive.
const claudePid = process.pid;

function writeRecord(patch) {
  fs.writeFileSync(path.join(box.claudeDir, 'sessions', `${claudePid}.json`), JSON.stringify({
    pid: claudePid, sessionId: SID, cwd: 'C:\\work', kind: 'interactive', status: 'busy', statusUpdatedAt: Date.now(), ...patch,
  }));
}

function writeTab(id, patch) {
  fs.writeFileSync(path.join(box.dataDir, 'tabs', `${id}.json`), JSON.stringify({ id, hostPid: process.pid, claudePid, state: 'running', sessionId: SID, ...patch }));
}

test('joins registry, tab host and Claude status; emits transitions', () => {
  const registry = new Registry();
  registry.add({ id: 'tab1', name: 'Demo', title: 'Demo', cwd: 'C:\\work', color: 'cyan', windowName: 'ClaudeDeck', launchedAt: Date.now(), expectedSessionId: SID });
  writeTab('tab1');
  writeRecord({ status: 'busy' });
  const live = new Live({ registry, history: new HistoryIndex() });
  const notes = [];
  live.on('notify', (n) => notes.push(n));

  live._compute();
  let s = live.state.sessions[0];
  assert.strictEqual(s.state, 'running');
  assert.strictEqual(s.status, 'busy');
  assert.strictEqual(s.sessionId, SID);
  assert.strictEqual(live.state.external.length, 0, 'claimed record is not listed as external');

  writeRecord({ status: 'waiting', waitingFor: 'permission prompt' });
  live._compute();
  s = live.state.sessions[0];
  assert.strictEqual(s.waitingFor, 'permission prompt');
  assert.deepStrictEqual(notes.map((n) => n.kind), ['waiting']);

  writeRecord({ status: 'busy' });
  live._compute();
  writeRecord({ status: 'idle' });
  live._compute();
  assert.deepStrictEqual(notes.map((n) => n.kind), ['waiting', 'finished']);

  writeTab('tab1', { state: 'exited', claudePid: null, exitCode: 0 });
  live._compute();
  assert.strictEqual(live.state.sessions[0].state, 'exited');
  assert.deepStrictEqual(notes.map((n) => n.kind), ['waiting', 'finished', 'exited']);
  assert.strictEqual(live.state.external.length, 1, 'once unclaimed, the running record shows as external');
});

test('drops closed tabs and marks tabs that never reported as failed', () => {
  const registry = new Registry();
  registry.add({ id: 'gone', title: 'x', cwd: 'C:\\', windowName: 'w', launchedAt: Date.now() });
  writeTab('gone', { hostPid: 999999999 });
  registry.add({ id: 'never', title: 'y', cwd: 'C:\\', windowName: 'w', launchedAt: Date.now() - 60 * 1000 });
  const live = new Live({ registry, history: new HistoryIndex() });
  live._compute();
  assert.ok(!registry.get('gone'), 'dead host removed from the registry');
  assert.ok(!fs.existsSync(path.join(box.dataDir, 'tabs', 'gone.json')), 'its tab files are cleaned up');
  const never = live.state.sessions.find((s) => s.id === 'never');
  assert.strictEqual(never.state, 'failed');
});

test('external sessions can be hidden', () => {
  const registry = new Registry();
  for (const e of registry.all()) registry.remove(e.id);
  prefs.save({ showExternal: false });
  const live = new Live({ registry, history: new HistoryIndex() });
  live._compute();
  assert.strictEqual(live.state.external.length, 0);
  prefs.save({ showExternal: true });
});

test('prefs reject unknown keys, wrong types and bad enum values', () => {
  assert.throws(() => prefs.save({ nope: 1 }), /Unknown preference/);
  assert.throws(() => prefs.save({ notifySound: 'yes' }), /wrong type/);
  assert.throws(() => prefs.save({ windowMode: 'tabs' }), /must be one of/);
  assert.strictEqual(prefs.save({ windowName: '  ' }).windowName, 'ClaudeDeck');
});
