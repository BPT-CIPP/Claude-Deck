'use strict';
// Terminal sessions inside Claude Deck: Claude Code with its full terminal interface, shown in a
// terminal in the dashboard window (xterm.js in the page). The pseudo-console is Windows' own
// conhost.exe --headless, held by src/pty-host.ps1; see docs/ARCHITECTURE.md for why.
//
//   node (this) ──stdin / stdout──► powershell pty-host.ps1 ──inherited──► conhost --headless ──► claude
//               ──control pipe───► resizes and kill go down; conhost's and Claude's pids come back
//
// Keystrokes go down the host's stdin and the screen comes back up its stdout as VT sequences,
// relayed as they are. The last 512 KB of output is kept so a page that connects (again) can draw
// the screen as it is. Like chats, these are children of the server and end when it stops; the
// list of them (terminals.json) survives, so an ended one stays listed, ready to resume or remove.

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const paths = require('./paths');
const prefsStore = require('./prefs');
const { preflight, buildClaudeArgs, displayCommand, requireClaude, requireFolder, normalizeOptions } = require('./launcher');
const { requirePlanBilling } = require('./billing');
const { isScript } = require('./claude-locate');
const { killTree, decodeClixml } = require('./shell-mode');
const { readJson, writeJsonAtomic, parseArgString, UserError } = require('./util');

const HOST_SCRIPT = path.join(__dirname, 'pty-host.ps1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// Until the page says how big its terminal is; conhost repaints everything when told.
const DEFAULT_SIZE = { cols: 120, rows: 30 };
const MIN_SIZE = { cols: 20, rows: 5 };
const MAX_SIZE = { cols: 500, rows: 300 };
const SCROLLBACK_BYTES = 512 * 1024;
const END_GRACE_MS = 3000; // after Ctrl+C twice, before the process tree is ended by force
const END_LIMIT_MS = 10000; // end() gives up waiting after this
const CTRL_C = '\x03';

// An argument as CreateProcess's rules read it back (what claude.exe's own parser expects): quoted
// when it has spaces or quotes, backslashes doubled only before a quote, quotes as \".
function quoteArg(value) {
  const s = String(value);
  if (s !== '' && !/[\s"]/.test(s)) return s;
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      slashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    out += '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

// The client's command line as conhost starts it. A script (the test stand-in) runs under node.
function commandLine(command, args) {
  const parts = isScript(command) ? [process.execPath, command, ...args] : [command, ...args];
  return parts.map(quoteArg).join(' ');
}

function specFile(id) {
  return path.join(paths.terminalsDir(), `${id}.spec.json`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

class TerminalManager extends EventEmitter {
  constructor({ file } = {}) {
    super();
    this.file = file || path.join(paths.dataDir(), 'terminals.json');
    this.terms = new Map();
    const saved = readJson(this.file, []);
    for (const s of Array.isArray(saved) ? saved : []) {
      if (!s || !s.id) continue;
      // Processes don't survive a server restart; the conversation does, so these come back as ended.
      this.terms.set(s.id, this._blank({ ...s, state: 'exited', note: 'Claude Deck restarted. Resume to continue this conversation.' }));
    }
    this.saveTimer = null;
  }

  _blank(fields) {
    return {
      id: fields.id,
      kind: 'embedded',
      name: fields.name || '',
      color: fields.color || 'slate',
      cwd: fields.cwd,
      options: fields.options,
      sessionId: fields.sessionId || null, // expected at first; the latest from Claude's own status file once it runs
      host: null, // the pty-host.ps1 process
      hostPid: null,
      conhostPid: null,
      claudePid: null,
      control: null, // the host's end of the control pipe, once it has connected
      controlServer: null,
      queued: [], // control lines sent before the host connected
      state: fields.state || 'starting',
      exitCode: null,
      launchedAt: fields.launchedAt || Date.now(),
      statusSince: Date.now(),
      cols: DEFAULT_SIZE.cols,
      rows: DEFAULT_SIZE.rows,
      scrollback: [], // Buffers, the latest output up to SCROLLBACK_BYTES
      scrollbackBytes: 0,
      clients: new Set(), // event-stream responses showing this terminal
      command: fields.command || '',
      stderr: '',
      note: fields.note || null,
      launchError: null,
      ending: false, // removed from the list once its process is gone
    };
  }

  // ---- lifecycle -----------------------------------------------------------------------------
  create(rawOptions) {
    const { o, claude } = preflight(rawOptions);
    const id = crypto.randomUUID();
    const sessionId = o.mode === 'new' ? crypto.randomUUID() : o.mode === 'resume' && !o.fork ? o.resumeId : null;
    const term = this._blank({ id, name: o.name, color: o.color, cwd: o.cwd, options: { ...o, prompt: '', mode: 'new', resumeId: '', fork: false, worktree: false }, sessionId });
    this.terms.set(id, term);
    // The first prompt goes on the command line, as it does for a Windows Terminal tab.
    const { args } = buildClaudeArgs(o, sessionId);
    try {
      this._start(term, claude.path, args);
    } catch (err) {
      this.terms.delete(id);
      throw new UserError(`Claude Code could not start: ${err.message}`, 500);
    }
    this._changed(term);
    this._save();
    return this.summary(term);
  }

  resume(id) {
    const term = this._get(id);
    if (term.host) return this.summary(term);
    if (!term.sessionId) throw new UserError('This session never started a conversation, so there is nothing to resume.');
    const claude = requireClaude(prefsStore.load());
    requireFolder(term.cwd);
    requirePlanBilling(term.cwd, { args: parseArgString(term.options && term.options.extraArgs) });
    const { args } = buildClaudeArgs(normalizeOptions({ ...term.options, cwd: term.cwd, mode: 'resume', resumeId: term.sessionId, fork: false }), null);
    Object.assign(term, { exitCode: null, note: null, launchError: null, scrollback: [], scrollbackBytes: 0, conhostPid: null, claudePid: null });
    this._start(term, claude.path, args);
    this._changed(term);
    this._save();
    return this.summary(term);
  }

  _start(term, command, args) {
    // The host connects to this pipe as soon as it starts; the name is new each run. (.NET takes
    // the bare name; Node the full path.)
    const control = `claude-deck-term-${term.id}-${Date.now().toString(36)}`;
    writeJsonAtomic(specFile(term.id), { command: commandLine(command, args), cwd: term.cwd, width: term.cols, height: term.rows, control });
    const server = net.createServer((sock) => this._onControl(term, sock));
    server.on('error', (err) => { term.stderr = (term.stderr + `control pipe: ${err.message}\n`).slice(-4000); });
    server.listen(`\\\\.\\pipe\\${control}`);
    const env = { ...process.env };
    // As for chats: don't let Claude think it's nested inside another Claude Code session. The
    // child-session marker too: with it, the terminal interface keeps no transcript and writes no
    // status file (docs/CLAUDE-CODE-INTERNALS.md), and this is a session of the person's own.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_CHILD_SESSION;
    const host = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT, '-Spec', specFile(term.id)],
      { cwd: term.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    Object.assign(term, { host, hostPid: host.pid || null, controlServer: server, control: null, queued: [], state: 'running', statusSince: Date.now(), ending: false, stderr: '', command: displayCommand(args) });
    host.stdin.on('error', () => {}); // EPIPE when the host exits first
    host.stdout.on('data', (chunk) => this._output(term, chunk));
    host.stderr.setEncoding('utf8');
    host.stderr.on('data', (d) => { term.stderr = (term.stderr + d).slice(-4000); });
    host.on('error', (err) => this._onExit(term, host, null, err.message));
    host.on('exit', (code) => this._onExit(term, host, code, null));
  }

  _onControl(term, sock) {
    term.control = sock;
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        this._onHostMessage(term, line);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { if (term.control === sock) term.control = null; });
    for (const line of term.queued.splice(0)) sock.write(`${line}\n`);
  }

  // What the host reports (see pty-host.ps1). "exit" is followed by the host ending: _onExit.
  _onHostMessage(term, line) {
    const space = line.indexOf(' ');
    const what = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (what === 'conhost') term.conhostPid = Number(value) || null;
    else if (what === 'claude') {
      term.claudePid = Number(value) || null;
      this._changed(term);
    } else if (what === 'error') {
      term.note = value;
      this._changed(term);
    }
  }

  _send(term, line) {
    if (term.control) term.control.write(`${line}\n`);
    else term.queued.push(line);
  }

  _output(term, chunk) {
    term.scrollback.push(chunk);
    term.scrollbackBytes += chunk.length;
    while (term.scrollbackBytes > SCROLLBACK_BYTES && term.scrollback.length > 1) term.scrollbackBytes -= term.scrollback.shift().length;
    const msg = `event: data\ndata: ${chunk.toString('base64')}\n\n`;
    for (const res of term.clients) res.write(msg);
  }

  _onExit(term, host, code, error) {
    if (term.host !== host) return;
    term.host = null;
    term.hostPid = null;
    if (term.controlServer) {
      term.controlServer.close();
      term.controlServer = null;
    }
    term.control = null;
    try { fs.unlinkSync(specFile(term.id)); } catch { /* already gone */ }
    const started = Boolean(term.conhostPid);
    term.state = started ? 'exited' : 'failed';
    term.exitCode = code;
    term.claudePid = null;
    term.statusSince = Date.now();
    if (!started) {
      // PowerShell's first line says what went wrong; the rest is where.
      const said = decodeClixml(term.stderr).trim().split(/\r?\n/)[0];
      term.launchError = error || (said ? `The terminal could not start: ${said.slice(0, 500)}` : 'The terminal ended before Claude Code started.');
    } else if (error) {
      term.note = error;
    }
    const msg = `event: exit\ndata: ${JSON.stringify({ exitCode: code })}\n\n`;
    for (const res of term.clients) res.write(msg);
    if (term.ending) this._remove(term);
    else {
      this._changed(term);
      this._save();
    }
  }

  // Ctrl+C twice, as in the terminal, so Claude ends cleanly and its transcript is complete; then
  // the whole process tree by force if it hasn't gone after a few seconds. Resolves once the host
  // is gone. The terminal stays listed as ended, ready to resume (the conversation is in History
  // too, once it had a prompt); remove takes it off the list instead, as Remove on an ended one or
  // a conversation moved elsewhere does.
  end(id, { remove = false } = {}) {
    const term = this._get(id);
    term.ending = remove;
    if (!term.host) {
      if (remove) this._remove(term);
      return Promise.resolve();
    }
    return this._stop(term);
  }

  _stop(term) {
    const host = term.host;
    return new Promise((resolve) => {
      host.once('exit', () => resolve());
      const press = () => { try { host.stdin.write(CTRL_C); } catch { /* gone */ } };
      press();
      setTimeout(press, 300);
      setTimeout(() => { if (term.host === host) killTree(host); }, END_GRACE_MS);
      setTimeout(resolve, END_LIMIT_MS);
    });
  }

  // Used on shutdown. These live in this process, so they end with it either way; this way Claude
  // gets to finish its transcript. They stay listed (as ended) so they can be resumed after a restart.
  async endAll() {
    await Promise.all([...this.terms.values()].filter((t) => t.host).map((t) => this._stop(t)));
    this._saveNow();
  }

  _remove(term) {
    this.terms.delete(term.id);
    this._save();
    this.emit('change', term);
  }

  _save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this._saveNow(), 300);
  }

  _saveNow() {
    clearTimeout(this.saveTimer);
    const rows = [...this.terms.values()].map((t) => ({ id: t.id, name: t.name, color: t.color, cwd: t.cwd, options: t.options, sessionId: t.sessionId, launchedAt: t.launchedAt, command: t.command }));
    try { writeJsonAtomic(this.file, rows); } catch { /* retried on the next change */ }
  }

  // ---- the page's side -----------------------------------------------------------------------
  // A page's event stream for this terminal: the size conhost draws at, everything drawn so far
  // (so the page shows the screen as it is), "live" once that's all sent, then each new piece as
  // it comes. Returns a function that stops the stream. The page acts on some output only when
  // it's live: a clipboard write from earlier (OSC 52) mustn't be done again on every reconnect.
  attach(id, res) {
    const term = this._get(id);
    res.write(`event: size\ndata: ${JSON.stringify({ cols: term.cols, rows: term.rows })}\n\n`);
    res.write('event: reset\ndata: {}\n\n');
    if (term.scrollback.length) res.write(`event: data\ndata: ${Buffer.concat(term.scrollback).toString('base64')}\n\n`);
    res.write('event: live\ndata: {}\n\n');
    if (!term.host) res.write(`event: exit\ndata: ${JSON.stringify({ exitCode: term.exitCode })}\n\n`);
    term.clients.add(res);
    return () => term.clients.delete(res);
  }

  // Keystrokes (or pasted text) for Claude. binary: bytes as a latin1 string, for what isn't text
  // (mouse reports).
  write(id, data, { binary = false } = {}) {
    const term = this._get(id);
    if (typeof data !== 'string') throw new UserError('Nothing to type.');
    if (!term.host) throw new UserError('This terminal has ended. Resume it first.', 409);
    term.host.stdin.write(Buffer.from(data, binary ? 'latin1' : 'utf8'));
    return { ok: true };
  }

  resize(id, cols, rows) {
    const term = this._get(id);
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new UserError('Columns and rows must be whole numbers.');
    const size = { cols: clamp(cols, MIN_SIZE.cols, MAX_SIZE.cols), rows: clamp(rows, MIN_SIZE.rows, MAX_SIZE.rows) };
    if (size.cols === term.cols && size.rows === term.rows) return size;
    term.cols = size.cols;
    term.rows = size.rows;
    if (term.host) this._send(term, `resize ${size.cols} ${size.rows}`);
    return size;
  }

  // ---- bookkeeping ---------------------------------------------------------------------------
  // What Claude's own status file says (src/live.js reads it): Claude's pid when the host couldn't
  // tell, and the conversation's current id, which changes after /clear. Kept quietly: live is
  // the one looking.
  learn(id, { claudePid, sessionId }) {
    const term = this.terms.get(id);
    if (!term) return;
    if (claudePid && term.claudePid !== claudePid) term.claudePid = claudePid;
    if (sessionId && term.sessionId !== sessionId) term.sessionId = sessionId;
  }

  update(id, { name, color }) {
    const term = this._get(id);
    if (typeof name === 'string') term.name = name.trim().slice(0, 120);
    if (typeof color === 'string') term.color = color;
    this._changed(term);
    this._save();
    return this.summary(term);
  }

  summary(term) {
    return {
      id: term.id,
      kind: 'embedded',
      name: term.name,
      color: term.color,
      cwd: term.cwd,
      state: term.state,
      exitCode: term.exitCode,
      launchedAt: term.launchedAt,
      statusSince: term.statusSince,
      sessionId: term.sessionId,
      claudePid: term.claudePid,
      command: term.command,
      cols: term.cols,
      rows: term.rows,
      screen: term.scrollbackBytes > 0, // something drawn to show; after a restart there's only the transcript
      note: term.note,
      launchError: term.launchError,
    };
  }

  detail(id) {
    return this.summary(this._get(id));
  }

  list() {
    return [...this.terms.values()].map((t) => this.summary(t));
  }

  get(id) {
    return this.terms.has(id) ? this.summary(this.terms.get(id)) : null;
  }

  // Launch options (model, effort, folders...) to reuse when moving this conversation elsewhere.
  optionsOf(id) {
    return { ...this._get(id).options };
  }

  findBySession(sessionId) {
    for (const t of this.terms.values()) if (t.host && t.sessionId === sessionId) return this.summary(t);
    return null;
  }

  runningCount() {
    return [...this.terms.values()].filter((t) => t.host).length;
  }

  _get(id) {
    const term = this.terms.get(id);
    if (!term) throw new UserError('That terminal is no longer listed.', 404);
    return term;
  }

  _changed(term) {
    this.emit('change', term);
  }
}

module.exports = { TerminalManager, quoteArg, commandLine, DEFAULT_SIZE };
