'use strict';
// Live view of every Claude session on this machine.
//
// Sources, all local files:
//   <claudeDir>/sessions/<pid>.json  written by Claude Code: status busy | idle | waiting (+ waitingFor)
//   <dataDir>/tabs/<id>.json         written by tab-host.js: which Claude pid runs in which tab
//   src/terminals.js                 terminals in the window: which Claude pid runs in which
//   transcripts                      titles, last prompt, branch (via HistoryIndex)

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const paths = require('./paths');
const prefsStore = require('./prefs');
const { removeTabFiles } = require('./launcher');
const { readJson, isPidAlive } = require('./util');

const START_TIMEOUT_MS = 45000;

function readSessionRecords() {
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(paths.sessionsDir());
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const rec = readJson(path.join(paths.sessionsDir(), name), null);
    if (!rec || !Number.isInteger(rec.pid) || !isPidAlive(rec.pid)) continue;
    out.set(rec.pid, rec);
  }
  return out;
}

function describe(meta) {
  if (!meta) return { title: null, lastPrompt: null, gitBranch: null, model: null, costUSD: null, userTurns: 0, context: null };
  return {
    title: meta.title,
    lastPrompt: meta.lastPrompt,
    gitBranch: meta.gitBranch,
    model: meta.model,
    costUSD: meta.costUSD,
    userTurns: meta.userTurns,
    // From the transcript, which doesn't say how big the context window is.
    context: Number.isFinite(meta.contextTokens) ? { tokens: meta.contextTokens, max: null, percent: null } : null,
  };
}


class Live extends EventEmitter {
  // An ended session's time is when its conversation was last active, from Claude Code's
  // transcript, as History shows it. Claude Deck's own clock starts again whenever the server does,
  // so an ended chat restored at start-up would otherwise read "just now". No transcript: the clock.
  static endedSince(state, meta, since) {
    return state === 'exited' && meta && meta.updatedAt ? meta.updatedAt : since;
  }

  constructor({ registry, history, chats, terminals }) {
    super();
    this.registry = registry;
    this.history = history;
    this.chats = chats || null;
    this.terminals = terminals || null;
    this.state = { sessions: [], external: [], updatedAt: 0 };
    this.prevStatus = new Map(); // deck id -> { status, state }
    // Claude processes of Claude Deck's own that aren't sessions (the model probe), by pid: they
    // write a session record too, and would show as outside sessions otherwise.
    this.ignored = new Set();
    this.lastJson = '';
    this.ticking = false;
    this.again = false;
    this.watchers = [];
    // Chat and terminal changes are pushed, not polled, so the session list reacts at once.
    if (this.chats) this.chats.on('change', () => this.poke(30));
    if (this.terminals) this.terminals.on('change', () => this.poke(30));
  }

  poke(delay = 150) {
    clearTimeout(this.pokeTimer);
    this.pokeTimer = setTimeout(() => this.tick(), delay);
  }

  ignore(pid) {
    this.ignored.add(pid);
    this.poke(0);
  }

  release(pid) {
    this.ignored.delete(pid);
    this.poke(0);
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 1500);
    for (const dir of [paths.sessionsDir(), paths.tabsDir()]) this._watch(dir);
  }

  _watch(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const w = fs.watch(dir, () => this.poke());
      // A watched folder that's deleted or renamed ends its watcher with an error; without this
      // handler that error would stop the server. Polling covers the gap until it's watched again.
      w.on('error', () => {
        w.close();
        this.watchers = this.watchers.filter((x) => x !== w);
        if (this.timer) setTimeout(() => { if (this.timer) this._watch(dir); }, 5000);
      });
      this.watchers.push(w);
    } catch {
      // polling still covers it
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watchers) w.close();
  }

  async tick() {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      await this.history.refreshIfOlderThan(2500);
      // Subagents' token usage, for the terminal and outside sessions shown (chats get theirs from Claude).
      const shown = [...this.state.sessions.filter((s) => s.kind !== 'chat'), ...this.state.external];
      await this.history.refreshSubagents(shown.map((s) => s.sessionId).filter(Boolean));
      this._compute();
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.ticking = false;
      if (this.again) {
        this.again = false;
        setImmediate(() => this.tick());
      }
    }
  }

  _compute() {
    const records = readSessionRecords();
    const claimed = new Set();
    const sessions = [];
    const now = Date.now();

    for (const entry of this.registry.all()) {
      const tab = readJson(path.join(paths.tabsDir(), `${entry.id}.json`), null);
      let state;
      if (entry.launchError) state = 'failed';
      else if (!tab) state = now - entry.launchedAt > START_TIMEOUT_MS ? 'failed' : 'starting';
      else if (tab.state === 'closed' || !isPidAlive(tab.hostPid)) state = 'closed';
      else state = tab.state === 'exited' ? 'exited' : tab.state === 'running' ? 'running' : 'starting';

      if (state === 'closed') {
        this.registry.remove(entry.id);
        removeTabFiles(entry.id);
        this._transition(entry, { state: 'closed', status: null });
        continue;
      }
      if (state === 'failed' && !entry.failed) this.registry.update(entry.id, { failed: true });

      const rec = tab && tab.claudePid ? records.get(tab.claudePid) : null;
      if (rec) claimed.add(rec.pid);
      const sessionId = (rec && rec.sessionId) || (tab && tab.sessionId) || entry.expectedSessionId || null;
      const meta = sessionId ? this.history.get(sessionId) : null;
      const status = state === 'running' ? (rec ? rec.status || 'idle' : 'starting') : null;
      const view = {
        id: entry.id,
        kind: 'terminal',
        name: entry.name,
        tabTitle: entry.title,
        cwd: entry.cwd,
        color: entry.color,
        windowName: entry.windowName,
        launchedAt: entry.launchedAt,
        command: entry.command,
        state,
        status,
        waitingFor: rec && rec.status === 'waiting' ? rec.waitingFor || 'input needed' : null,
        statusSince: Live.endedSince(state, meta, rec ? rec.statusUpdatedAt || rec.updatedAt || null : tab ? tab.updatedAt : entry.launchedAt),
        sessionId,
        claudePid: tab ? tab.claudePid : null,
        exitCode: tab ? tab.exitCode : null,
        launchError: entry.launchError || (state === 'failed' ? 'The tab never reported in. Check that Windows Terminal opened, then dismiss this card.' : null),
        transcriptStamp: sessionId ? this.history.stamp(sessionId) : null,
        ...describe(meta),
        // The current conversation's tokens, from its transcripts (subagents included).
        tokens: sessionId ? this.history.tokensFor(sessionId) : null,
      };
      sessions.push(view);
      this._transition(entry, view);
    }

    // Terminals in the window. Claude's status comes from its own record, found by the pid the
    // host reported, or failing that by the conversation's id (a record is claimed only once).
    if (this.terminals) {
      for (const t of this.terminals.list()) {
        let rec = t.claudePid ? records.get(t.claudePid) || null : null;
        if (!rec && t.sessionId && t.state === 'running') rec = [...records.values()].find((r) => r.sessionId === t.sessionId && !claimed.has(r.pid)) || null;
        if (rec) {
          claimed.add(rec.pid);
          this.terminals.learn(t.id, { claudePid: rec.pid, sessionId: rec.sessionId });
        }
        const sessionId = (rec && rec.sessionId) || t.sessionId || null;
        const meta = sessionId ? this.history.get(sessionId) : null;
        const status = t.state === 'running' ? (rec ? rec.status || 'idle' : 'starting') : null;
        const view = {
          ...t,
          status,
          waitingFor: rec && rec.status === 'waiting' ? rec.waitingFor || 'input needed' : null,
          statusSince: Live.endedSince(t.state, meta, rec ? rec.statusUpdatedAt || rec.updatedAt || t.statusSince : t.statusSince),
          sessionId,
          claudePid: rec ? rec.pid : t.claudePid,
          transcriptStamp: sessionId ? this.history.stamp(sessionId) : null,
          ...describe(meta),
          tokens: sessionId ? this.history.tokensFor(sessionId) : null,
        };
        sessions.push(view);
        this._transition(t, view);
      }
    }

    if (this.chats) {
      for (const c of this.chats.list()) {
        if (c.pid) claimed.add(c.pid);
        const meta = c.sessionId ? this.history.get(c.sessionId) : null;
        const d = describe(meta);
        const view = {
          ...c,
          title: d.title,
          gitBranch: d.gitBranch,
          lastPrompt: c.lastPrompt || d.lastPrompt,
          model: c.chatModel || d.model,
          costUSD: c.chatCost ?? d.costUSD,
          userTurns: d.userTurns,
          statusSince: Live.endedSince(c.state, meta, c.statusSince),
          transcriptStamp: c.sessionId ? this.history.stamp(c.sessionId) : null,
        };
        sessions.push(view);
        this._transition(c, view);
      }
    }
    // Chats and terminals that were ended disappear from the list; forget their last status too.
    const listed = new Set(sessions.map((s) => s.id));
    for (const id of this.prevStatus.keys()) {
      if (!listed.has(id)) this.prevStatus.delete(id);
    }

    const external = [];
    if (prefsStore.load().showExternal) {
      for (const rec of records.values()) {
        if (claimed.has(rec.pid) || this.ignored.has(rec.pid)) continue;
        const meta = rec.sessionId ? this.history.get(rec.sessionId) : null;
        external.push({
          pid: rec.pid,
          sessionId: rec.sessionId || null,
          cwd: rec.cwd || (meta && meta.cwd) || null,
          name: rec.nameSource === 'derived' ? null : rec.name || null,
          processKind: rec.kind || 'interactive',
          status: rec.status || 'idle',
          waitingFor: rec.status === 'waiting' ? rec.waitingFor || 'input needed' : null,
          statusSince: rec.statusUpdatedAt || rec.updatedAt || null,
          startedAt: rec.startedAt || null,
          procStart: rec.procStart || null,
          transcriptStamp: rec.sessionId ? this.history.stamp(rec.sessionId) : null,
          ...describe(meta),
          tokens: rec.sessionId ? this.history.tokensFor(rec.sessionId) : null,
        });
      }
      external.sort((a, b) => (b.statusSince || 0) - (a.statusSince || 0));
    }

    const next = { sessions, external };
    const json = JSON.stringify(next);
    if (json !== this.lastJson) {
      this.lastJson = json;
      this.state = { ...next, updatedAt: now };
      this.emit('state', this.state);
    }
  }

  // Emit a notification-worthy event when a deck session changes status.
  _transition(entry, view) {
    const prev = this.prevStatus.get(entry.id);
    if (view.state === 'closed') {
      this.prevStatus.delete(entry.id);
    } else {
      this.prevStatus.set(entry.id, { status: view.status, state: view.state, waitingFor: view.waitingFor });
    }
    if (!prev) return;
    const label = entry.name || view.title || path.basename(entry.cwd);
    if (view.status === 'waiting' && (prev.status !== 'waiting' || prev.waitingFor !== view.waitingFor)) {
      this.emit('notify', { id: entry.id, kind: 'waiting', label, detail: view.waitingFor });
    } else if (prev.status === 'busy' && view.status === 'idle') {
      this.emit('notify', { id: entry.id, kind: 'finished', label, detail: view.title || null });
    } else if (prev.state === 'running' && view.state === 'exited') {
      this.emit('notify', { id: entry.id, kind: 'exited', label, detail: null });
    }
  }
}

// Whether pid is still the process that wrote a session file. Claude Code records its process's
// creation time there (procStart, a Windows FILETIME); a file left behind by a killed Claude can
// name a pid Windows has since given to another program, which has a different creation time.
// Asked with PowerShell (a Windows built-in). Without procStart (older Claude Code), it can't tell.
function isSameProcess(pid, procStart) {
  if (!procStart || process.platform !== 'win32') return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToFileTimeUtc()`], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(false);
      try {
        // FILETIME counts 100 ns steps; allow a second either way for rounding.
        resolve(Math.abs(Number(BigInt(String(stdout).trim()) - BigInt(procStart))) <= 1e7);
      } catch {
        resolve(false);
      }
    });
  });
}

module.exports = { Live, readSessionRecords, isSameProcess };
