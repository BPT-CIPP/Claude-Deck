'use strict';
// Claude Deck local server. Serves the dashboard on 127.0.0.1 and exposes a small JSON API.
//
//   node src/server.js           start (or report the already-running instance)
//   node src/server.js --open    start if needed, then open the dashboard window
//   node src/server.js --port N  preferred port (default 47821)
//
// No Claude API calls are made here. Everything shown comes from local files Claude Code writes.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const paths = require('./paths');
const prefsStore = require('./prefs');
const settingsFiles = require('./settings-files');
const folders = require('./folders');
const appInstall = require('./app-install');
const { UsageMonitor } = require('./usage');
const { PluginManager } = require('./plugins');
const { HistoryIndex, readTranscript, UUID_RE } = require('./history');
const { Registry } = require('./registry');
const { Launcher, normalizeOptions, buildClaudeArgs, displayCommand, EFFORTS, PERMISSION_MODES, COLORS, MODEL_ALIASES } = require('./launcher');
const { Live } = require('./live');
const { ChatManager } = require('./chat');
const { Timeline } = require('./timeline');
const trash = require('./trash');
const update = require('./update');
const billing = require('./billing');
const { locateClaude, claudeVersion } = require('./claude-locate');
const { readJson, writeJsonAtomic, isPidAlive, UserError } = require('./util');

// The version this server was started from; a pulled update shows once the server restarts.
const VERSION = require('../package.json').version;
const DEFAULT_PORT = 47821;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const IDLE_EXIT_MS = 90 * 1000;
const WEEK_MS = 7 * 24 * 3600 * 1000;
// How long a restart's replacement waits for the old server to end its chats and exit.
const RESTART_WAIT_MS = 30 * 1000;
// Exit codes Start-ClaudeDeck.ps1's supervisor acts on: 0 = stopped on purpose (stay stopped),
// 3 = another copy is serving (wait, and take over if it stops). A restart exits with 3.
const EXIT_STOPPED = 0;
const EXIT_ANOTHER_COPY = 3;
// Room for a message with several images (up to 5 MB each, base64-encoded).
const MAX_BODY = 60 * 1024 * 1024;
const EDGE_PATHS = [
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function runtimeFile() {
  return path.join(paths.dataDir(), 'runtime.json');
}

// One token per install, kept in the data folder. Web pages can't read it, so they can't call
// the API; keeping it stable means an open dashboard window survives a server restart.
function loadToken() {
  const file = path.join(paths.dataDir(), 'secret.json');
  const stored = readJson(file, null);
  if (stored && typeof stored.token === 'string' && stored.token.length >= 32) return stored.token;
  const token = crypto.randomBytes(24).toString('hex');
  writeJsonAtomic(file, { token });
  return token;
}

function parseArgs(argv) {
  const out = { open: false, resident: false, port: DEFAULT_PORT, replace: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open') out.open = true;
    else if (a === '--resident') out.resident = true;
    // Started by Restart: wait for this server (a pid) to exit, then take over.
    else if (a === '--replace') out.replace = Number(argv[++i]) || null;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) out.port = DEFAULT_PORT;
  return out;
}

function dashboardUrl(port, token) {
  return `http://127.0.0.1:${port}/?t=${token}`;
}

function launchDetached(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// Open the installed Claude Deck app if there is one (its own taskbar icon), otherwise an Edge
// app window, otherwise the default browser.
function openDashboard(port, token) {
  const edge = EDGE_PATHS.find((p) => fs.existsSync(p));
  const installed = appInstall.findInstalledApp(port);
  if (edge && installed.profile) launchDetached(edge, [`--profile-directory=${installed.profile}`, `--app-id=${installed.appId}`]);
  else if (edge) launchDetached(edge, [`--app=${dashboardUrl(port, token)}`]);
  else launchDetached('explorer.exe', [dashboardUrl(port, token)]);
}

// A normal Edge tab, where the address bar offers "Install Claude Deck".
function openInBrowserTab(port, token) {
  const edge = EDGE_PATHS.find((p) => fs.existsSync(p));
  launchDetached(edge || 'explorer.exe', [dashboardUrl(port, token)]);
}

function ping(port, token) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', headers: { 'x-deck-token': token }, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function sameToken(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new UserError('Request is too large.', 413));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new UserError('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

// Folders from past sessions, most recent first. Temp folders (scratch runs, scheduled jobs) are
// left out because nobody starts a session there on purpose.
function recentFolders(history) {
  const temp = os.tmpdir().toLowerCase() + path.sep;
  const byCwd = new Map();
  for (const m of history.list()) {
    if (!m.cwd || m.cwd.toLowerCase().startsWith(temp)) continue;
    const key = m.cwd.toLowerCase();
    const cur = byCwd.get(key) || { path: m.cwd, lastUsed: 0, sessions: 0 };
    cur.sessions++;
    cur.lastUsed = Math.max(cur.lastUsed, m.updatedAt || 0);
    byCwd.set(key, cur);
  }
  return [...byCwd.values()]
    .filter((f) => fs.existsSync(f.path))
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, 40);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(paths.tabsDir(), { recursive: true });
  const token = loadToken();

  // A restart's replacement: the old server is still ending its chats. Once it's gone, carry on
  // as a normal start (on the same port, so open windows reconnect).
  if (opts.replace) {
    const until = Date.now() + RESTART_WAIT_MS;
    while (isPidAlive(opts.replace) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  }

  const running = readJson(runtimeFile(), null);
  if (running && running.pid !== process.pid && isPidAlive(running.pid) && (await ping(running.port, token))) {
    if (opts.open) openDashboard(running.port, token);
    console.log(`Claude Deck is already running: ${dashboardUrl(running.port, token)}`);
    // Distinct exit code so the startup task's loop waits for that copy instead of treating
    // this as a crash or a deliberate stop.
    process.exitCode = EXIT_ANOTHER_COPY;
    return;
  }

  const registry = new Registry();
  const history = new HistoryIndex();
  const launcher = new Launcher({ registry });
  const chats = new ChatManager({ history });
  const live = new Live({ registry, history, chats });
  const timeline = new Timeline({ history });
  const usage = new UsageMonitor();
  const plugins = new PluginManager();
  // A plugin change is saved either way; applying it to the chat it was made from is a bonus.
  const reloadChatPlugins = (chatId, pluginId, enabled) => chats.reloadPlugins(chatId, { pluginId, enabled })
    .catch((err) => ({ applied: false, reason: err.message }));
  const clients = new Set();
  let port = opts.port;
  let idleTimer = null;
  let claudeInfo = null;

  async function detectClaude() {
    const found = locateClaude(prefsStore.load().claudePath);
    claudeInfo = found ? { ...found, version: await claudeVersion(found.path) } : { path: null, source: null, version: null };
    return claudeInfo;
  }

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  }

  let updating = false;
  let shuttingDown = false;
  async function shutdown(exitCode = EXIT_STOPPED) {
    if (shuttingDown) return;
    shuttingDown = true;
    live.stop();
    usage.stop();
    // Chats are child processes; end them cleanly so their transcripts are complete and resumable.
    await chats.endAll();
    history.saveNow();
    const rt = readJson(runtimeFile(), null);
    if (rt && rt.pid === process.pid) {
      try { fs.unlinkSync(runtimeFile()); } catch { /* already gone */ }
    }
    process.exit(exitCode);
  }

  // Restart: start a replacement that takes over once this server has gone, then stop. Exiting
  // with "another copy is serving" keeps the sign-in task's supervisor watching (it takes over if
  // the replacement doesn't come up) instead of staying stopped.
  function restart() {
    const args = [path.join(__dirname, 'server.js'), '--replace', String(process.pid), '--port', String(port), ...(opts.resident ? ['--resident'] : [])];
    const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => console.error('starting the replacement server failed:', err));
    child.unref();
    shutdown(EXIT_ANOTHER_COPY);
  }

  // Stop a while after the last dashboard window closes, but never while a chat is running
  // (chats live inside this process), and never when started resident (start with Windows).
  function scheduleIdleExit() {
    clearTimeout(idleTimer);
    if (clients.size || opts.resident) return;
    idleTimer = setTimeout(() => {
      if (clients.size || !prefsStore.load().stopWhenClosed) return;
      if (chats.runningCount() > 0) scheduleIdleExit();
      else shutdown();
    }, IDLE_EXIT_MS);
  }

  live.on('state', (state) => broadcast('state', state));
  live.on('notify', (n) => broadcast('notify', n));
  live.on('error', (err) => console.error('live update failed:', err));
  chats.on('item', (e) => broadcast('chat', e));
  chats.on('tasks', (e) => broadcast('chat-tasks', e));
  usage.on('usage', (u) => broadcast('usage', u));
  chats.on('error', (err) => console.error('chat message failed:', err));

  function findExternal(pidText) {
    const pid = Number(pidText);
    const x = live.state.external.find((e) => e.pid === pid);
    if (!x || !isPidAlive(pid)) throw new UserError('That session is no longer running.', 404);
    return x;
  }

  // Wait until a Claude process has exited so two processes never write one transcript.
  async function waitForExit(pid, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (pid && isPidAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    if (pid && isPidAlive(pid)) throw new UserError('Claude is still shutting down in the other window. Try again in a moment.', 409);
  }

  // Who has this conversation open: one of our chats, a terminal/external Claude, or nobody.
  function timelineOwner(sessionId) {
    const chat = chats.findBySession(sessionId);
    if (chat) return { kind: 'chat', chat };
    const inTerminal = live.state.sessions.some((s) => s.kind === 'terminal' && s.state === 'running' && s.sessionId === sessionId)
      || live.state.external.some((x) => x.sessionId === sessionId && isPidAlive(x.pid));
    return { kind: inTerminal ? 'terminal' : null };
  }

  function liveSessionIds() {
    const ids = new Set();
    for (const s of live.state.sessions) if (s.sessionId && s.state === 'running') ids.add(s.sessionId);
    for (const s of live.state.external) if (s.sessionId) ids.add(s.sessionId);
    return [...ids];
  }

  const routes = {
    'GET /api/ping': () => ({ ok: true, pid: process.pid }),

    'GET /api/bootstrap': async () => ({
      version: VERSION,
      prefs: prefsStore.load(),
      claude: claudeInfo || (await detectClaude()),
      enums: { efforts: EFFORTS, permissionModes: PERMISSION_MODES, colors: COLORS, models: MODEL_ALIASES },
      scopes: Object.fromEntries(Object.entries(settingsFiles.SCOPES).map(([k, v]) => [k, { label: v.label, kind: v.kind, needsFolder: v.needsFolder }])),
      claudeDir: paths.claudeDir(),
      dataDir: paths.dataDir(),
      state: live.state,
      usage: usage.state,
    }),

    'GET /api/state': () => live.state,
    // What would make Claude Code bill an API or cloud account instead of the Claude plan
    // (src/billing.js), for the warning banner. Names and places only, never values.
    'GET /api/billing': () => ({ findings: billing.findApiBilling(), allowed: prefsStore.load().allowApiBilling }),
    'POST /api/usage/refresh': () => usage.refresh(true),
    // Which conversations used the most tokens this week, from their transcripts (subagents
    // included). The week is the plan's weekly limit window when that's known, else the last 7 days.
    'GET /api/usage/sessions': async () => {
      await history.refreshIfOlderThan(2500);
      const now = Date.now();
      const weekly = usage.state.limits.find((l) => (l.kind === 'weekly_all' || l.kind === 'seven_day') && l.resetsAt && l.resetsAt > now);
      const since = weekly ? weekly.resetsAt - WEEK_MS : now - WEEK_MS;
      await history.refreshSubagents(history.list().filter((m) => (m.updatedAt || 0) >= since).map((m) => m.sessionId));
      const open = new Set(liveSessionIds());
      const sessions = history.usageSince(since).map(({ sessionId, tokens, meta }) => ({
        sessionId, tokens, title: meta.title, cwd: meta.cwd, updatedAt: meta.updatedAt, open: open.has(sessionId),
      }));
      return { since, basis: weekly ? 'plan' : 'rolling', sessions };
    },

    'POST /api/launch': async (req) => {
      const entry = launcher.launch(await readBody(req));
      live.tick();
      return entry;
    },

    'POST /api/chats': async (req) => {
      const c = chats.create(await readBody(req));
      live.poke(0);
      return c;
    },
    'GET /api/chats/:id': (req, p) => chats.detail(p.id),
    // { text, images?, interrupt? }: interrupt stops Claude's current turn and sends right away;
    // otherwise a message sent while Claude works is queued.
    'POST /api/chats/:id/send': async (req, p) => {
      const b = await readBody(req);
      const message = { text: b.text, images: b.images };
      return b.interrupt === true ? chats.sendInterrupting(p.id, message) : chats.send(p.id, message);
    },
    'GET /api/chats/:id/tasks/:taskId': (req, p) => chats.taskDetail(p.id, p.taskId),
    'POST /api/chats/:id/tasks/:taskId/stop': (req, p) => chats.stopTask(p.id, p.taskId),
    'POST /api/chats/:id/respond': async (req, p) => {
      const b = await readBody(req);
      return chats.respond(p.id, b.requestId, b);
    },
    'POST /api/chats/:id/interrupt': (req, p) => chats.interrupt(p.id),
    'POST /api/chats/:id/compact': (req, p) => chats.compact(p.id),
    // Takes queued messages back out of Claude's queue to edit: { messages: [{ text, images }] }.
    'POST /api/chats/:id/unqueue': (req, p) => chats.unqueue(p.id),
    'POST /api/chats/:id/model': async (req, p) => chats.setModel(p.id, (await readBody(req)).model),
    'POST /api/chats/:id/effort': async (req, p) => chats.setEffort(p.id, (await readBody(req)).effort),
    'POST /api/chats/:id/mode': async (req, p) => chats.setPermissionMode(p.id, (await readBody(req)).mode),
    // { keep? }: keep leaves the chat on the board as ended (Ctrl+W's first press).
    'POST /api/chats/:id/end': async (req, p) => {
      await chats.end(p.id, { keep: (await readBody(req)).keep === true });
      return { ok: true };
    },
    'POST /api/chats/:id/resume': (req, p) => chats.resume(p.id),
    'PATCH /api/chats/:id': async (req, p) => {
      const b = await readBody(req);
      return chats.update(p.id, { name: b.name, color: COLORS.includes(b.color) ? b.color : undefined });
    },
    // Continue a chat in a Windows Terminal tab instead (same conversation).
    'POST /api/chats/:id/to-terminal': async (req, p) => {
      const c = chats.detail(p.id);
      if (!c.sessionId) throw new UserError('This chat has no conversation to continue yet.');
      const options = chats.optionsOf(p.id);
      await chats.end(p.id);
      const entry = launcher.launch({ ...options, mode: 'resume', resumeId: c.sessionId, cwd: c.cwd, name: c.name, color: c.color });
      live.poke(0);
      return entry;
    },
    // Bring a Windows Terminal session into Claude Deck: close its tab, then resume here.
    'POST /api/sessions/:id/to-chat': async (req, p) => {
      const s = live.state.sessions.find((x) => x.id === p.id && x.kind === 'terminal');
      if (!s || !s.sessionId) throw new UserError('That session has no conversation to continue yet.', 404);
      const entry = registry.get(p.id);
      const pid = s.claudePid;
      launcher.close(p.id);
      await waitForExit(pid, 8000);
      const c = chats.create({ ...(entry ? entry.options : {}), mode: 'resume', resumeId: s.sessionId, cwd: s.cwd, name: s.name, color: s.color });
      live.poke(0);
      return c;
    },
    'POST /api/external/:pid/end': (req, p) => {
      const x = findExternal(p.pid);
      process.kill(x.pid);
      live.poke(300);
      return { ok: true };
    },
    'POST /api/external/:pid/to-chat': async (req, p) => {
      const x = findExternal(p.pid);
      if (!x.sessionId || !x.cwd) throw new UserError('That session has no conversation to continue yet.');
      process.kill(x.pid);
      await waitForExit(x.pid, 8000);
      const c = chats.create({ mode: 'resume', resumeId: x.sessionId, cwd: x.cwd, name: x.name || '' });
      live.poke(0);
      return c;
    },

    'POST /api/preview-command': async (req) => {
      const o = normalizeOptions(await readBody(req));
      return { command: displayCommand(buildClaudeArgs(o, '<new-session-id>').args) };
    },

    'POST /api/sessions/:id/focus': (req, p) => launcher.focus(p.id),
    'POST /api/sessions/:id/close': (req, p) => { const r = launcher.close(p.id); live.tick(); return r; },
    'POST /api/sessions/:id/resume': (req, p) => { const r = launcher.resume(p.id); live.tick(); return r; },
    'POST /api/sessions/:id/dismiss': (req, p) => { registry.remove(p.id); live.tick(); return { ok: true }; },
    'PATCH /api/sessions/:id': async (req, p) => {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 120);
      if (COLORS.includes(body.color)) patch.color = body.color;
      const entry = registry.update(p.id, patch);
      if (!entry) throw new UserError('That session is no longer tracked.', 404);
      live.tick();
      return entry;
    },

    'GET /api/history': async (req, p, url) => {
      if (url.searchParams.get('refresh') === '1') await history.refresh();
      return { sessions: history.list(), live: liveSessionIds() };
    },
    // Delete a conversation: its files go to Claude Deck's trash (src/trash.js); Undo restores them.
    'DELETE /api/history/:sessionId': async (req, p) => {
      if (!UUID_RE.test(p.sessionId)) throw new UserError('Invalid session ID.');
      await history.refreshIfOlderThan(0);
      const file = history.fileFor(p.sessionId);
      if (!file) throw new UserError('That conversation was not found in history.', 404);
      if (chats.findBySession(p.sessionId) || liveSessionIds().includes(p.sessionId)) {
        throw new UserError('This conversation is open right now. End or close it first, then delete it.', 409);
      }
      const meta = history.get(p.sessionId) || {};
      const result = trash.trashSession(p.sessionId, file, { title: meta.title, cwd: meta.cwd });
      await history.refresh();
      return { ...result, sessions: history.list(), live: liveSessionIds() };
    },
    'POST /api/history/restore': async (req) => {
      const result = trash.restore((await readBody(req)).trashId);
      await history.refresh();
      return { ...result, sessions: history.list(), live: liveSessionIds() };
    },
    'POST /api/history/rebuild': async () => {
      await history.rebuild();
      return { sessions: history.list(), live: liveSessionIds() };
    },
    'GET /api/transcript/:sessionId': async (req, p, url) => {
      if (!UUID_RE.test(p.sessionId)) throw new UserError('Invalid session ID.');
      await history.refreshIfOlderThan(1000);
      const file = history.fileFor(p.sessionId);
      if (!file) throw new UserError('No transcript found for that session yet.', 404);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      return { sessionId: p.sessionId, meta: history.get(p.sessionId), items: await readTranscript(file, limit) };
    },
    // Change timeline: files each turn changed, diffs, and restoring files to before a turn.
    'GET /api/timeline/:sessionId': async (req, p) => {
      if (!UUID_RE.test(p.sessionId)) throw new UserError('Invalid session ID.');
      await history.refreshIfOlderThan(1000);
      return { ...timeline.list(p.sessionId), owner: timelineOwner(p.sessionId).kind };
    },
    'GET /api/timeline/:sessionId/diff': async (req, p, url) => {
      if (!UUID_RE.test(p.sessionId)) throw new UserError('Invalid session ID.');
      await history.refreshIfOlderThan(1000);
      return timeline.diff(p.sessionId, url.searchParams.get('turn') || '', url.searchParams.get('file') || '');
    },
    // { messageId, preview? }: preview lists what would change without touching anything.
    'POST /api/timeline/:sessionId/restore': async (req, p) => {
      const b = await readBody(req);
      if (!UUID_RE.test(p.sessionId) || !UUID_RE.test(b.messageId || '')) throw new UserError('Invalid session or turn ID.');
      await history.refreshIfOlderThan(1000);
      const owner = timelineOwner(p.sessionId);
      const plan = timeline.plan(p.sessionId, b.messageId);
      if (b.preview === true) return { owner: owner.kind, files: plan.map((a) => ({ path: a.path, action: a.action })) };
      if (owner.kind === 'terminal') throw new UserError('This conversation is open in Windows Terminal. Use /rewind there, or close that session and try again.', 409);
      if (owner.kind !== 'chat') return timeline.restore(p.sessionId, b.messageId);
      // A running chat: restore through Claude so its own file history stays in step.
      const dry = await chats.rewindFiles(owner.chat.id, b.messageId, true);
      const touched = [...new Set([...plan.map((a) => a.path), ...(Array.isArray(dry.filesChanged) ? dry.filesChanged.filter((f) => typeof f === 'string' && path.isAbsolute(f)) : [])])];
      if (!touched.length) return { restored: 0, undoId: null, files: [] };
      const undoId = timeline.saveUndo(p.sessionId, b.messageId, touched);
      await chats.rewindFiles(owner.chat.id, b.messageId, false);
      timeline.cache.delete(p.sessionId);
      return { restored: touched.length, undoId, files: plan.map((a) => ({ path: a.path, action: a.action })) };
    },
    'POST /api/timeline/undo': async (req) => timeline.undo((await readBody(req)).undoId),

    'POST /api/history/resume': async (req) => {
      const body = await readBody(req);
      const meta = UUID_RE.test(body.sessionId || '') ? history.get(body.sessionId) : null;
      if (!meta) throw new UserError('That conversation was not found in history.', 404);
      if (!meta.cwd) throw new UserError('That conversation has no recorded folder, so it cannot be resumed from here.');
      const defaults = body.options && typeof body.options === 'object' ? body.options : {};
      const options = {
        ...defaults,
        mode: 'resume',
        resumeId: meta.sessionId,
        fork: body.fork === true,
        cwd: meta.cwd,
        name: typeof body.name === 'string' ? body.name : '',
      };
      const result = body.target === 'terminal' ? launcher.launch(options) : chats.create(options);
      live.poke(0);
      return result;
    },

    'GET /api/folders': () => ({ favorites: prefsStore.load().favorites, recent: recentFolders(history) }),
    'GET /api/dirs': (req, p, url) => folders.listDir(url.searchParams.get('path') || ''),
    'POST /api/mkdir': async (req) => {
      const body = await readBody(req);
      return folders.makeDir(body.parent, body.name);
    },
    'POST /api/open-folder': async (req) => {
      const body = await readBody(req);
      const target = typeof body.path === 'string' ? body.path : '';
      if (!path.isAbsolute(target) || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new UserError('Folder not found.', 404);
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      return { ok: true };
    },

    'GET /api/settings': (req, p, url) => settingsFiles.read(url.searchParams.get('scope'), url.searchParams.get('folder')),
    'PUT /api/settings': async (req) => {
      const b = await readBody(req);
      return settingsFiles.write(b.scope, b.folder, b.text, b.baseMtimeMs, b.force === true);
    },
    'GET /api/settings/backups': (req, p, url) => settingsFiles.listBackups(url.searchParams.get('scope'), url.searchParams.get('folder')),
    'POST /api/settings/restore': async (req) => {
      const b = await readBody(req);
      return settingsFiles.restore(b.scope, b.folder, b.name);
    },

    // Plugins, through Claude Code's CLI (src/plugins.js). cwd is the chat's folder, for plugins
    // installed in a project; chatId applies the change to that running chat too.
    'GET /api/plugins': (req, p, url) => plugins.list(url.searchParams.get('cwd') || undefined, { refresh: url.searchParams.get('refresh') === '1' }),
    'POST /api/plugins/enabled': async (req) => {
      const b = await readBody(req);
      await plugins.setEnabled(b.id, b.enabled === true, b.cwd);
      return { ok: true, reload: b.chatId ? await reloadChatPlugins(b.chatId, b.id, b.enabled === true) : null };
    },
    'POST /api/plugins/install': async (req) => {
      const b = await readBody(req);
      const r = await plugins.install(b.id, { acceptCommand: b.acceptCommand, cwd: b.cwd });
      if (r.ok && b.chatId) r.reload = await reloadChatPlugins(b.chatId, b.id, true);
      return r;
    },
    // { pluginId, enabled, force }: force applies a reload Claude held back (it resets the prompt cache).
    'POST /api/chats/:id/reload-plugins': async (req, p) => {
      const b = await readBody(req);
      return chats.reloadPlugins(p.id, { pluginId: b.pluginId, enabled: b.enabled === true, force: b.force === true });
    },
    'GET /api/plugins/marketplaces': () => plugins.marketplaces(),
    'POST /api/plugins/marketplaces': async (req) => plugins.addMarketplace((await readBody(req)).source),
    'POST /api/plugins/marketplaces/remove': async (req) => plugins.removeMarketplace((await readBody(req)).name),
    'POST /api/plugins/marketplaces/update': async (req) => plugins.updateMarketplaces((await readBody(req)).name),

    'GET /api/prefs': () => prefsStore.load(),
    'PUT /api/prefs': async (req) => {
      const next = prefsStore.save(await readBody(req));
      live.tick();
      return next;
    },
    'POST /api/claude/detect': () => detectClaude(),
    'GET /api/app': async () => {
      const installed = appInstall.findInstalledApp(port);
      return { installed: Boolean(installed.profile), profile: installed.profile, startup: await appInstall.startupEnabled(), resident: opts.resident };
    },
    'POST /api/app/open-in-browser': () => {
      openInBrowserTab(port, token);
      return { ok: true };
    },
    'POST /api/app/startup': async (req) => {
      const body = await readBody(req);
      return { startup: await appInstall.setStartup(body.enabled === true) };
    },
    'POST /api/shutdown': () => {
      setTimeout(() => shutdown(), 200);
      return { ok: true };
    },
    // Stops and starts again, for picking up changes to Claude Deck itself. { pid } is this
    // server's, so the page can tell when the new one answers.
    'POST /api/restart': () => {
      setTimeout(restart, 200);
      return { ok: true, pid: process.pid };
    },
    // { apply? }: checks GitHub for a newer Claude Deck (src/update.js); with apply, updates this
    // copy and then restarts on the new files. { pid } is this server's, as for restart.
    'POST /api/update': async (req) => {
      const apply = (await readBody(req)).apply === true;
      if (updating) throw new UserError('Already checking for updates.', 409);
      updating = true;
      try {
        const result = await update.checkForUpdates({ apply });
        if (result.updated) setTimeout(restart, 200);
        return { ...result, pid: process.pid };
      } finally {
        updating = false;
      }
    },
  };

  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    return { method, re, names, handler };
  });

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const headers = {
        'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      };
      if (file.endsWith('.html')) {
        headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
        headers['X-Frame-Options'] = 'DENY';
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    // Reject requests addressed to any other host name (DNS rebinding).
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(421);
      return res.end();
    }
    const url = new URL(req.url, `http://${host}`);
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') {
        res.writeHead(405);
        return res.end();
      }
      return serveStatic(res, url.pathname);
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      // EventSource cannot send headers, so this one endpoint takes the token as a query parameter.
      if (!sameToken(url.searchParams.get('t'), token)) return sendJson(res, 401, { error: 'Not authorized.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(live.state)}\n\n`);
      res.write(`event: usage\ndata: ${JSON.stringify(usage.state)}\n\n`);
      clients.add(res);
      clearTimeout(idleTimer);
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 20000);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
        scheduleIdleExit();
      });
      return undefined;
    }

    if (!sameToken(req.headers['x-deck-token'], token)) return sendJson(res, 401, { error: 'Not authorized.' });

    for (const r of compiled) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      try {
        const result = await r.handler(req, params, url);
        return sendJson(res, 200, result === undefined ? { ok: true } : result);
      } catch (err) {
        const status = err instanceof UserError ? err.status : 500;
        if (status === 500) console.error(err);
        // command: a command for the person to run themselves (see src/update.js).
        return sendJson(res, status, { error: err.message || String(err), ...(status !== 500 && err.command ? { command: err.command } : {}) });
      }
    }
    return sendJson(res, 404, { error: 'Unknown endpoint.' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code !== 'EADDRINUSE' || port === 0) return reject(err);
      // Preferred port is taken by something else; fall back to any free port.
      port = 0;
      server.listen(0, '127.0.0.1', resolve);
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  port = server.address().port;

  writeJsonAtomic(runtimeFile(), { pid: process.pid, port, startedAt: Date.now() });
  await history.refresh();
  try { trash.purgeOld(); } catch (err) { console.error('emptying old trash failed:', err); }
  live.start();
  usage.start();
  detectClaude();
  scheduleIdleExit();

  console.log(`Claude Deck running at ${dashboardUrl(port, token)}`);
  if (opts.open) openDashboard(port, token);

  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
