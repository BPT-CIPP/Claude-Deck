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

test("a Claude process of Claude Deck's own that isn't a session (the model probe) is not an outside session", () => {
  const registry = new Registry();
  for (const e of registry.all()) registry.remove(e.id);
  writeRecord({ status: 'idle' });
  const live = new Live({ registry, history: new HistoryIndex() });
  live.ignore(claudePid);
  live._compute();
  assert.strictEqual(live.state.external.length, 0, 'ignored while it runs');
  live.release(claudePid);
  live._compute();
  assert.strictEqual(live.state.external.length, 1, 'any other process with that pid later shows as usual');
  clearTimeout(live.pokeTimer);
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

test("an ended session's time is when its conversation was last active, as History has it, even after a restart", () => {
  const registry = new Registry();
  for (const e of registry.all()) registry.remove(e.id);
  const lastActive = Date.now() - 3 * 3600 * 1000;
  const metas = { [SID]: { sessionId: SID, updatedAt: lastActive, title: 'Old work' } };
  const history = { get: (sid) => metas[sid] || null, stamp: () => null, tokensFor: () => null };
  // As chats look straight after the server starts: ended, with the clock just started.
  const now = Date.now();
  const chats = { on: () => {}, list: () => [
    { id: 'ended', kind: 'chat', state: 'exited', status: null, sessionId: SID, statusSince: now },
    { id: 'never-started', kind: 'chat', state: 'exited', status: null, sessionId: null, statusSince: now },
    { id: 'running', kind: 'chat', state: 'running', status: 'idle', sessionId: SID, statusSince: now },
  ] };
  registry.add({ id: 'tab-ended', title: 't', cwd: 'C:\\work', windowName: 'w', launchedAt: now, expectedSessionId: SID });
  writeTab('tab-ended', { state: 'exited', claudePid: null, exitCode: 0, updatedAt: now });
  const live = new Live({ registry, history, chats });
  live._compute();
  const since = (id) => live.state.sessions.find((s) => s.id === id).statusSince;
  assert.strictEqual(since('ended'), lastActive);
  assert.strictEqual(since('tab-ended'), lastActive);
  // No transcript to go by: Claude Deck's own clock. Still running: how long in this status.
  assert.strictEqual(since('never-started'), now);
  assert.strictEqual(since('running'), now);
  registry.remove('tab-ended');
});

test('a terminal in the window gets its status from the record of the pid its host found, or by session id, and notifies', () => {
  const registry = new Registry();
  for (const e of registry.all()) registry.remove(e.id);
  const { EventEmitter } = require('events');
  const terminals = new EventEmitter();
  const learned = [];
  const term = { id: 'term1', kind: 'embedded', name: 'Here', color: 'cyan', cwd: 'C:\\work', state: 'running', exitCode: null, launchedAt: Date.now(), statusSince: Date.now(), sessionId: SID, claudePid: null, command: 'claude', cols: 120, rows: 30, note: null, launchError: null };
  terminals.list = () => [term];
  terminals.learn = (id, what) => learned.push([id, what]);
  writeRecord({ status: 'busy' });
  const live = new Live({ registry, history: new HistoryIndex(), terminals });
  const notes = [];
  live.on('notify', (n) => notes.push(n));
  // No pid from the host yet: the record is found by the conversation's id, and the pid learned.
  live._compute();
  let s = live.state.sessions.find((x) => x.id === 'term1');
  assert.deepStrictEqual([s.kind, s.state, s.status, s.claudePid], ['embedded', 'running', 'busy', claudePid]);
  assert.deepStrictEqual(learned, [['term1', { claudePid, sessionId: SID }]]);
  assert.strictEqual(live.state.external.length, 0, 'the claimed record is not an outside session');
  // With the pid known, the record is read by it; a change of status notifies, as for a tab.
  term.claudePid = claudePid;
  writeRecord({ status: 'waiting', waitingFor: 'permission prompt' });
  live._compute();
  s = live.state.sessions.find((x) => x.id === 'term1');
  assert.strictEqual(s.waitingFor, 'permission prompt');
  assert.deepStrictEqual(notes.map((n) => [n.kind, n.label]), [['waiting', 'Here']]);
  // Ended: no status, and the record (if any) is somebody else's.
  term.state = 'exited';
  term.exitCode = 0;
  live._compute();
  s = live.state.sessions.find((x) => x.id === 'term1');
  assert.deepStrictEqual([s.state, s.status], ['exited', null]);
  assert.deepStrictEqual(notes.map((n) => n.kind), ['waiting', 'exited']);
  clearTimeout(live.pokeTimer);
});

test('prefs reject unknown keys, wrong types and bad enum values', () => {
  assert.throws(() => prefs.save({ nope: 1 }), /Unknown preference/);
  assert.throws(() => prefs.save({ notifySound: 'yes' }), /wrong type/);
  assert.throws(() => prefs.save({ windowMode: 'tabs' }), /must be one of/);
  assert.throws(() => prefs.save({ runHereAs: 'tab' }), /must be one of/);
  assert.strictEqual(prefs.save({ runHereAs: 'terminal' }).runHereAs, 'terminal');
  prefs.save({ runHereAs: 'chat' });
  assert.strictEqual(prefs.save({ windowName: '  ' }).windowName, 'ClaudeDeck');
});
