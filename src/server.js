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
const promptHistory = require('./prompt-history');
const { HistoryIndex, readTranscript, UUID_RE } = require('./history');
const historyFolders = require('./history-folders');
const { Registry } = require('./registry');
const { Launcher, normalizeOptions, buildClaudeArgs, displayCommand, preflight, requireClaude, EFFORTS, PERMISSION_MODES, COLORS, MODEL_ALIASES } = require('./launcher');
const { Live, isSameProcess } = require('./live');
const { ChatManager } = require('./chat');
const { TerminalManager } = require('./terminals');
const { Timeline } = require('./timeline');
const trash = require('./trash');
const update = require('./update');
const billing = require('./billing');
const { locateClaude, claudeVersion, autoUpdateStatus, runUpdate, binaryStamp, compareVersions, latestRelease } = require('./claude-locate');
const models = require('./models');
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
// How often Claude Code's file is looked at for an update, and npm asked for a newer release.
const CLAUDE_CHANGE_MS = 60 * 1000;
const CLAUDE_LATEST_MS = 6 * 3600 * 1000;
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
function loadToken({ fresh = false } = {}) {
  const file = path.join(paths.dataDir(), 'secret.json');
  const stored = fresh ? null : readJson(file, null);
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

// Compared as bytes: a string of the right length can still be a different number of bytes.
function sameToken(a, b) {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Part of a request's path, decoded. Malformed escapes (a lone %) and NUL are a bad request.
function decodePart(text) {
  let out;
  try { out = decodeURIComponent(text); } catch { throw new UserError('Bad request.'); }
  if (out.includes('\0')) throw new UserError('Bad request.');
  return out;
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
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(new UserError('Request body is not valid JSON.'));
      }
      // Every handler reads fields off it; null, a string or a list would be an exception instead.
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new UserError('Request body must be a JSON object.'));
      resolve(body);
    });
    req.on('error', reject);
  });
}

// Folders from past sessions, most recent first. Temp folders (scratch runs, scheduled jobs) are
// left out because nobody starts a session there on purpose.
// Checked asynchronously and all at once: a folder on a disconnected network drive can take the
// network timeout to answer, and must not hold up the rest of the server meanwhile.
async function recentFolders(history) {
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
  const all = [...byCwd.values()];
  const exists = await Promise.all(all.map((f) => fs.promises.access(f.path).then(() => true, () => false)));
  return all
    .filter((f, i) => exists[i])
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, 40);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(paths.tabsDir(), { recursive: true });
  let token = loadToken();

  // A restart's replacement: the old server is still ending its chats. Once it's gone, carry on
  // as a normal start (on the same port, so open windows reconnect).
  if (opts.replace) {
    const until = Date.now() + RESTART_WAIT_MS;
    while (isPidAlive(opts.replace) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  }

  function leaveToRunningCopy(runningPort) {
    if (opts.open) openDashboard(runningPort, token);
    console.log(`Claude Deck is already running: ${dashboardUrl(runningPort, token)}`);
    // Distinct exit code so the startup task's loop waits for that copy instead of treating
    // this as a crash or a deliberate stop.
    process.exitCode = EXIT_ANOTHER_COPY;
  }

  const running = readJson(runtimeFile(), null);
  if (running && running.pid !== process.pid && isPidAlive(running.pid) && (await ping(running.port, token))) {
    leaveToRunningCopy(running.port);
    return;
  }

  const registry = new Registry();
  const history = new HistoryIndex();
  const launcher = new Launcher({ registry });
  const chats = new ChatManager({ history });
  const terminals = new TerminalManager();
  const live = new Live({ registry, history, chats, terminals });
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
  // The newest Claude Code on its release channel, once checked (checkLatestClaude):
  // { version, channel, checkedAt }.
  let claudeLatest = null;

  function withLatest(info) {
    info.latest = claudeLatest;
    info.updateAvailable = Boolean(claudeLatest && info.version && compareVersions(claudeLatest.version, info.version) > 0);
    return info;
  }

  async function detectClaude() {
    const found = locateClaude(prefsStore.load().claudePath);
    claudeInfo = found ? { ...found, version: await claudeVersion(found.path), stamp: binaryStamp(found.path) } : { path: null, source: null, version: null, stamp: null };
    // A version that couldn't be read (claude.exe half-written mid-update) is read again next time.
    if (!claudeInfo.version) claudeInfo.stamp = null;
    claudeInfo.autoUpdate = autoUpdateStatus();
    return withLatest(claudeInfo);
  }
  // Claude Code installed after the server started: while it's missing, look again when the page
  // loads or a session starts, and tell open pages once it turns up. Once found, notice when it's
  // updated (noticeClaudeChange).
  async function recheckClaude() {
    if (claudeInfo && claudeInfo.path) return noticeClaudeChange();
    const info = await detectClaude();
    if (info.path) {
      broadcast('claude', info);
      refreshModels();
    }
    return info;
  }
  const recheckClaudeSoon = () => { recheckClaude().catch((err) => console.error('checking Claude Code failed:', err)); };
  // Claude Code was updated (by itself from an interactive session, by claude update, or by hand):
  // its file changed, so read the version again, tell open pages, and get that version's models.
  // Checked when the page loads and every minute; a stat, so cheap.
  async function noticeClaudeChange() {
    if (!claudeInfo || !claudeInfo.path) return claudeInfo;
    const stamp = binaryStamp(claudeInfo.path);
    // Missing for a moment while an update swaps the file: look again next time.
    if (!stamp || stamp === claudeInfo.stamp) return claudeInfo;
    const before = claudeInfo.version;
    const info = await detectClaude();
    broadcast('claude', info);
    if (info.version && info.version !== before) refreshModels();
    return info;
  }

  // Claude Code updates itself only from its terminal interface (docs/CLAUDE-CODE-INTERNALS.md,
  // "Updating"), never in the streaming mode chats use, so on a PC that only uses chats it would
  // stay on one version. Claude Deck looks up the newest release itself, from npm's public list
  // of release channels, at start and every 6 hours, so the page can offer the update. Not when
  // Claude Code's updates are turned off, nor with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set
  // (Claude Code's own switch for this kind of request; the sandbox and the tests set it).
  async function checkLatestClaude() {
    if (!claudeInfo || !claudeInfo.path || !claudeInfo.autoUpdate.enabled || process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) return;
    let release = null;
    try { release = await latestRelease(claudeInfo.autoUpdate.channel); } catch { return; /* offline: next time */ }
    if (!release) return;
    claudeLatest = { ...release, checkedAt: Date.now() };
    broadcast('claude', withLatest(claudeInfo));
  }

  // The model menus, with versions from Claude Code's own list (src/models.js).
  const modelMenu = () => models.menu(models.load().models, MODEL_ALIASES);
  function rememberModels(list) {
    if (models.remember(list, claudeInfo && claudeInfo.version)) broadcast('models', modelMenu());
  }
  // A list from this Claude Code version, asking Claude Code for one if there isn't. force: ask
  // even so (after an update).
  let modelProbe = null;
  function refreshModels({ force = false } = {}) {
    if (modelProbe) return modelProbe;
    if (!claudeInfo || !claudeInfo.path) return Promise.resolve();
    const saved = models.load();
    if (!force && saved.models.length && saved.claudeVersion === claudeInfo.version) return Promise.resolve();
    // The probe is a Claude Code process of our own: not an outside session while it runs.
    let probePid = null;
    modelProbe = models.probe(claudeInfo.path, { onStart: (pid) => { probePid = pid; live.ignore(pid); } }).then((list) => { if (list) rememberModels(list); })
      .catch((err) => console.error('reading Claude Code models failed:', err))
      .finally(() => { modelProbe = null; if (probePid) live.release(probePid); });
    return modelProbe;
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
    // No new connections; requests on open ones are turned away (see the request handler).
    server.close();
    live.stop();
    usage.stop();
    // Chats and terminals in the window are child processes; end them cleanly so their transcripts
    // are complete and resumable.
    await Promise.all([chats.endAll(), terminals.endAll()]);
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
    // Once is enough: a second Restart (or an update's) mustn't start a second replacement.
    if (shuttingDown) return;
    const args = [path.join(__dirname, 'server.js'), '--replace', String(process.pid), '--port', String(port), ...(opts.resident ? ['--resident'] : [])];
    const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => console.error('starting the replacement server failed:', err));
    child.unref();
    shutdown(EXIT_ANOTHER_COPY);
  }

  // Stop a while after the last dashboard window closes, but never while a chat or a terminal in
  // the window is running (they live inside this process), and never when started resident (start
  // with Windows).
  function scheduleIdleExit() {
    clearTimeout(idleTimer);
    if (clients.size || opts.resident) return;
    idleTimer = setTimeout(() => {
      if (clients.size || !prefsStore.load().stopWhenClosed) return;
      if (chats.runningCount() + terminals.runningCount() > 0) scheduleIdleExit();
      else shutdown();
    }, IDLE_EXIT_MS);
  }

  live.on('state', (state) => broadcast('state', state));
  live.on('notify', (n) => broadcast('notify', n));
  live.on('error', (err) => console.error('live update failed:', err));
  chats.on('item', (e) => broadcast('chat', e));
  chats.on('tasks', (e) => broadcast('chat-tasks', e));
  chats.on('models', rememberModels);
  usage.on('usage', (u) => broadcast('usage', u));
  chats.on('error', (err) => console.error('chat message failed:', err));

  // An outside session, confirmed to still be the Claude process that wrote its session file, so
  // ending it can't end some other program that Windows has since given the same pid.
  async function findExternal(pidText) {
    const pid = Number(pidText);
    const x = live.state.external.find((e) => e.pid === pid);
    if (!x || !isPidAlive(pid) || !(await isSameProcess(pid, x.procStart))) throw new UserError('That session is no longer running.', 404);
    return x;
  }

  // Wait until a Claude process has exited so two processes never write one transcript. By now
  // the session it ran in has been told to close, so a Claude that won't stop can't be tried
  // again from its card: the way on is History, once it has gone.
  async function waitForExit(pid, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (pid && isPidAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    if (pid && isPidAlive(pid)) throw new UserError("Claude hasn't stopped yet, so the conversation wasn't continued here. Once it has, open History and choose Resume here.", 409);
  }

  // Who has this conversation open: one of our chats, a terminal (in the window, a Windows Terminal
  // tab, or outside Claude Deck), or nobody.
  function timelineOwner(sessionId) {
    const chat = chats.findBySession(sessionId);
    if (chat) return { kind: 'chat', chat };
    const inTerminal = live.state.sessions.some((s) => s.kind !== 'chat' && s.state === 'running' && s.sessionId === sessionId)
      || live.state.external.some((x) => x.sessionId === sessionId && isPidAlive(x.pid));
    return { kind: inTerminal ? 'terminal' : null };
  }

  // "Here in Claude Deck" is a chat or a terminal in the window, as Claude Deck Preferences say.
  function startHere(options) {
    return prefsStore.load().runHereAs === 'terminal' ? terminals.create(options) : chats.create(options);
  }

  function liveSessionIds() {
    const ids = new Set();
    for (const s of live.state.sessions) if (s.sessionId && s.state === 'running') ids.add(s.sessionId);
    for (const s of live.state.external) if (s.sessionId) ids.add(s.sessionId);
    return [...ids];
  }

  // History as the page lists it: every conversation, with the folder it's filed under
  // (src/history-folders.js), the names folders are shown under, and which are open right now.
  const historyView = () => ({ sessions: historyFolders.annotate(history.list()), folderNames: historyFolders.names(), live: liveSessionIds() });

  const routes = {
    'GET /api/ping': () => ({ ok: true, pid: process.pid, version: VERSION }),

    'GET /api/bootstrap': async () => ({
      version: VERSION,
      prefs: prefsStore.load(),
      claude: await recheckClaude(),
      enums: { efforts: EFFORTS, permissionModes: PERMISSION_MODES, colors: COLORS, models: MODEL_ALIASES },
      models: modelMenu(),
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
      recheckClaudeSoon();
      return entry;
    },

    'POST /api/chats': async (req) => {
      const c = chats.create(await readBody(req));
      live.poke(0);
      recheckClaudeSoon();
      return c;
    },
    'GET /api/chats/:id': (req, p) => chats.detail(p.id),
    // { text, images?, interrupt?, sendNow? }: interrupt stops Claude's current turn and sends
    // right away; sendNow is Claude Code's own Send now (Claude takes the message next);
    // otherwise a message sent while Claude works is queued.
    'POST /api/chats/:id/send': async (req, p) => {
      const b = await readBody(req);
      const message = { text: b.text, images: b.images, pasted: b.pasted };
      if (b.sendNow === true) return chats.sendNow(p.id, message);
      return b.interrupt === true ? chats.sendInterrupting(p.id, message) : chats.send(p.id, message);
    },
    'GET /api/chats/:id/tasks/:taskId': (req, p) => chats.taskDetail(p.id, p.taskId),
    'POST /api/chats/:id/tasks/:taskId/stop': (req, p) => chats.stopTask(p.id, p.taskId),
    // { name, data (base64) }: a dropped file that isn't an image, kept so Claude can read it: { path }.
    'POST /api/chats/:id/files': async (req, p) => chats.saveFile(p.id, await readBody(req)),
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
    // The chat's MCP servers, through its own Claude Code (like /mcp): { name, enabled } turns one
    // on or off, { name } reconnects one.
    'GET /api/chats/:id/mcp': (req, p) => chats.mcpStatus(p.id),
    'POST /api/chats/:id/mcp/enabled': async (req, p) => {
      const b = await readBody(req);
      return chats.setMcpEnabled(p.id, b.name, b.enabled === true);
    },
    'POST /api/chats/:id/mcp/reconnect': async (req, p) => chats.reconnectMcp(p.id, (await readBody(req)).name),
    // { name } -> { authUrl, callbackExpected }: the page opens authUrl to sign in.
    'POST /api/chats/:id/mcp/authenticate': async (req, p) => chats.authenticateMcp(p.id, (await readBody(req)).name),
    // Claude Code's terminal features in the reply box: @ files, !command, /btw, Ctrl+B, Esc Esc.
    'GET /api/chats/:id/files': (req, p, url) => chats.fileSuggestions(p.id, url.searchParams.get('q') || ''),
    'POST /api/chats/:id/shell': async (req, p) => chats.runShell(p.id, (await readBody(req)).command),
    'POST /api/chats/:id/side': async (req, p) => chats.sideQuestion(p.id, (await readBody(req)).question),
    'POST /api/chats/:id/background': (req, p) => chats.background(p.id),
    'POST /api/chats/:id/rewind': async (req, p) => {
      const b = await readBody(req);
      return chats.rewind(p.id, b.messageId, { files: b.files === true });
    },
    'POST /api/chats/:id/fast': async (req, p) => chats.setFastMode(p.id, (await readBody(req)).on === true),
    // Claude Code's /config options, through the chat's own Claude Code (src/claude-config.js):
    // GET lists them with current values; POST { changes: { key: value } } applies them.
    'GET /api/chats/:id/config': (req, p) => chats.configOptions(p.id),
    'POST /api/chats/:id/config': async (req, p) => chats.setConfig(p.id, (await readBody(req)).changes),
    // Ctrl+R: your earlier prompts, from Claude Code's own prompt history (src/prompt-history.js).
    'GET /api/prompt-history': (req, p, url) => promptHistory.search(url.searchParams.get('q') || '', url.searchParams.get('cwd') || ''),
    // { keep? }: keep leaves the chat in the session list as ended (Ctrl+W's first press).
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
      const next = { ...chats.optionsOf(p.id), mode: 'resume', resumeId: c.sessionId, cwd: c.cwd, name: c.name, color: c.color };
      // Checked before the chat ends, so a refusal leaves it running.
      preflight(next);
      await chats.end(p.id);
      let entry;
      try {
        entry = launcher.launch(next);
      } catch (err) {
        throw new UserError(`${err.message} The chat has ended; resume the conversation from History.`, err instanceof UserError ? err.status : 500);
      }
      live.poke(0);
      return entry;
    },
    // Bring a Windows Terminal session into Claude Deck: close its tab, then resume here.
    'POST /api/sessions/:id/to-chat': async (req, p) => {
      const s = live.state.sessions.find((x) => x.id === p.id && x.kind === 'terminal');
      if (!s || !s.sessionId) throw new UserError('That session has no conversation to continue yet.', 404);
      const entry = registry.get(p.id);
      const next = { ...(entry ? entry.options : {}), mode: 'resume', resumeId: s.sessionId, cwd: s.cwd, name: s.name, color: s.color };
      preflight(next);
      const pid = s.claudePid;
      launcher.close(p.id);
      await waitForExit(pid, 8000);
      const c = startHere(next);
      live.poke(0);
      return c;
    },

    // Terminals in the window (src/terminals.js): Claude Code's own interface, drawn by the page.
    'POST /api/terminals': async (req) => {
      const t = terminals.create(await readBody(req));
      live.poke(0);
      recheckClaudeSoon();
      return t;
    },
    'GET /api/terminals/:id': (req, p) => terminals.detail(p.id),
    // { data, binary? }: keystrokes or pasted text; binary for bytes that aren't text (mouse reports).
    'POST /api/terminals/:id/input': async (req, p) => {
      const b = await readBody(req);
      return terminals.write(p.id, b.data, { binary: b.binary === true });
    },
    'POST /api/terminals/:id/resize': async (req, p) => {
      const b = await readBody(req);
      return terminals.resize(p.id, b.cols, b.rows);
    },
    // Ends Claude; the terminal stays listed as ended. { remove: true } takes it off the list (an
    // ended one's Remove).
    'POST /api/terminals/:id/end': async (req, p) => {
      await terminals.end(p.id, { remove: (await readBody(req)).remove === true });
      return { ok: true };
    },
    'POST /api/terminals/:id/resume': (req, p) => terminals.resume(p.id),
    'PATCH /api/terminals/:id': async (req, p) => {
      const b = await readBody(req);
      return terminals.update(p.id, { name: b.name, color: COLORS.includes(b.color) ? b.color : undefined });
    },
    // Continue a terminal's conversation in a Windows Terminal tab, or as a chat, instead.
    'POST /api/terminals/:id/to-terminal': async (req, p) => {
      const t = terminals.detail(p.id);
      if (!t.sessionId) throw new UserError('This terminal has no conversation to continue yet.');
      const next = { ...terminals.optionsOf(p.id), mode: 'resume', resumeId: t.sessionId, cwd: t.cwd, name: t.name, color: t.color };
      preflight(next);
      await terminals.end(p.id, { remove: true });
      let entry;
      try {
        entry = launcher.launch(next);
      } catch (err) {
        throw new UserError(`${err.message} The terminal has ended; resume the conversation from History.`, err instanceof UserError ? err.status : 500);
      }
      live.poke(0);
      return entry;
    },
    'POST /api/terminals/:id/to-chat': async (req, p) => {
      const t = terminals.detail(p.id);
      if (!t.sessionId) throw new UserError('This terminal has no conversation to continue yet.');
      const next = { ...terminals.optionsOf(p.id), mode: 'resume', resumeId: t.sessionId, cwd: t.cwd, name: t.name, color: t.color };
      preflight(next);
      await terminals.end(p.id, { remove: true });
      const c = chats.create(next);
      live.poke(0);
      return c;
    },
    'POST /api/external/:pid/end': async (req, p) => {
      const x = await findExternal(p.pid);
      process.kill(x.pid);
      live.poke(300);
      return { ok: true };
    },
    'POST /api/external/:pid/to-chat': async (req, p) => {
      const x = await findExternal(p.pid);
      if (!x.sessionId || !x.cwd) throw new UserError('That session has no conversation to continue yet.');
      const next = { mode: 'resume', resumeId: x.sessionId, cwd: x.cwd, name: x.name || '' };
      preflight(next);
      process.kill(x.pid);
      await waitForExit(x.pid, 8000);
      const c = startHere(next);
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
    'POST /api/sessions/:id/dismiss': (req, p) => { launcher.dismiss(p.id); live.tick(); return { ok: true }; },
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
      return historyView();
    },
    // Files a conversation under another folder in History's folder view ({ folder }), or back in
    // the one it was started in ({ folder: null }). Claude Deck's own note: Claude Code's files
    // aren't touched, and the conversation resumes from its real folder as before.
    'PUT /api/history/:sessionId/folder': async (req, p) => {
      if (!UUID_RE.test(p.sessionId)) throw new UserError('Invalid session ID.');
      await history.refreshIfOlderThan(1000);
      if (!history.get(p.sessionId)) throw new UserError('That conversation was not found in history.', 404);
      const b = await readBody(req);
      historyFolders.set(p.sessionId, b.folder === null || b.folder === undefined ? null : b.folder);
      return historyView();
    },
    // { folder, name }: the name a folder is shown under in History ('' goes back to its path).
    // Only History's label: the folder on disk isn't renamed.
    'PUT /api/history/folder-name': async (req) => {
      const b = await readBody(req);
      historyFolders.rename(b.folder, b.name);
      return historyView();
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
      return { ...result, ...historyView() };
    },
    'POST /api/history/restore': async (req) => {
      const result = trash.restore((await readBody(req)).trashId);
      await history.refresh();
      return { ...result, ...historyView() };
    },
    'POST /api/history/rebuild': async () => {
      await history.rebuild();
      return historyView();
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
      if (owner.kind === 'terminal') throw new UserError('This conversation is open in a terminal. Use /rewind there, or end that session and try again.', 409);
      if (owner.kind !== 'chat') return timeline.restore(p.sessionId, b.messageId);
      // A running chat: restore through Claude so its own file history stays in step.
      const dry = await chats.rewindFiles(owner.chat.id, b.messageId, true);
      const touched = [...new Set([...plan.map((a) => a.path), ...(Array.isArray(dry.filesChanged) ? dry.filesChanged.filter((f) => typeof f === 'string' && path.isAbsolute(f)) : [])])];
      if (!touched.length) return { restored: 0, undoId: null, files: [] };
      const undoId = timeline.saveUndo(p.sessionId, b.messageId, touched);
      await chats.rewindFiles(owner.chat.id, b.messageId, false);
      timeline.markRestored(undoId);
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
      const result = body.target === 'terminal' ? launcher.launch(options) : startHere(options);
      live.poke(0);
      recheckClaudeSoon();
      return result;
    },

    'GET /api/folders': async () => ({ favorites: prefsStore.load().favorites, recent: await recentFolders(history) }),
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
      return settingsFiles.restore(b.scope, b.folder, b.name, b.baseMtimeMs, b.force === true);
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
    'POST /api/claude/detect': async () => {
      const info = await detectClaude();
      refreshModels();
      return info;
    },
    'GET /api/models': () => modelMenu(),
    // Claude Code's own `claude update`, only when the user asks. Running chats keep the version
    // they started with until they're resumed. { ok, output, before, claude, locked }: locked when
    // Windows wouldn't let an npm install replace claude.exe, because sessions are using it.
    'POST /api/claude/update': async () => {
      const before = (claudeInfo || (await detectClaude())).version;
      const claude = requireClaude(prefsStore.load());
      const res = await runUpdate(claude.path);
      const info = await detectClaude();
      if (info.version !== before) await refreshModels({ force: true });
      broadcast('claude', info);
      const locked = !res.ok && /\bEBUSY\b|resource busy or locked|executable is locked|\bEPERM\b/i.test(res.output);
      return { ok: res.ok, output: res.output, before, claude: info, locked };
    },
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
    // { tool: 'git' | 'gh' }: installs a program updating needs (err.prerequisite from /api/update),
    // with winget, after the person chose Install. -> { label, path }.
    'POST /api/update/install': async (req) => update.installTool((await readBody(req)).tool),
  };

  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    return { method, re, names, handler };
  });

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodePart(pathname.slice(1));
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
        // Scripts come only from this server. Styles too, plus inline ones: the dashboard itself
        // sets styles through the CSSOM (Deck.h's style object), but the terminal in the window
        // (xterm.js, public/vendor/xterm) adds <style> elements of its own for its colors and
        // cell sizes, which a policy without 'unsafe-inline' refuses. The page never uses
        // innerHTML, so no text from a transcript or a chat can become a style. The offline page
        // is one self-contained file with its own <style>.
        headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
        headers['X-Frame-Options'] = 'DENY';
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  // Every request goes through here, so nothing a request contains can end the server: a bad
  // request gets an error response, never an unhandled exception.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof UserError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: err.message || String(err) });
      else res.destroy();
    });
  });

  async function handle(req, res) {
    // Reject requests addressed to any other host name (DNS rebinding).
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(421);
      return res.end();
    }
    if (shuttingDown) return sendJson(res, 503, { error: 'Claude Deck is shutting down.' });
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { throw new UserError('Bad request.'); }
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

    // A terminal's screen, as an event stream (src/terminals.js attach): the token comes as a
    // query parameter here too, for the same reason.
    const screen = req.method === 'GET' && /^\/api\/terminals\/([^/]+)\/stream$/.exec(url.pathname);
    if (screen) {
      if (!sameToken(url.searchParams.get('t'), token)) return sendJson(res, 401, { error: 'Not authorized.' });
      const id = decodePart(screen[1]);
      if (!terminals.get(id)) return sendJson(res, 404, { error: 'That terminal is no longer listed.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      const detach = terminals.attach(id, res);
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 20000);
      req.on('close', () => {
        clearInterval(heartbeat);
        detach();
      });
      return undefined;
    }

    if (!sameToken(req.headers['x-deck-token'], token)) return sendJson(res, 401, { error: 'Not authorized.' });

    for (const r of compiled) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodePart(m[i + 1])]));
      try {
        const result = await r.handler(req, params, url);
        return sendJson(res, 200, result === undefined ? { ok: true } : result);
      } catch (err) {
        const status = err instanceof UserError ? err.status : 500;
        if (status === 500) console.error(err);
        // command: a command for the person to run themselves; prerequisite: a program to offer to
        // install (both from src/update.js).
        return sendJson(res, status, { error: err.message || String(err), ...(status !== 500 && err.command ? { command: err.command } : {}), ...(status !== 500 && err.prerequisite ? { prerequisite: err.prerequisite } : {}) });
      }
    }
    return sendJson(res, 404, { error: 'Unknown endpoint.' });
  }

  const listen = (p) => new Promise((resolve, reject) => {
    const onError = (err) => (err.code === 'EADDRINUSE' && p !== 0 ? resolve(false) : reject(err));
    server.once('error', onError);
    server.listen(p, '127.0.0.1', () => { server.off('error', onError); resolve(true); });
  });
  if (!(await listen(port))) {
    // Taken. Another Claude Deck started at the same moment (sign-in and the shortcut, say)
    // answers with this install's token once it's up; then this copy leaves it to that one.
    for (let i = 0; i < 10; i++) {
      if (await ping(port, token)) {
        leaveToRunningCopy(port);
        process.exit(EXIT_ANOTHER_COPY); // chat and history timers have started; don't wait on them
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    // Something else has it; fall back to any free port. Whatever holds the usual port shares its
    // web origin, where the dashboard keeps the token, so a new token makes that one useless.
    token = loadToken({ fresh: true });
    await listen(0);
  }
  port = server.address().port;

  writeJsonAtomic(runtimeFile(), { pid: process.pid, port, startedAt: Date.now() });
  // The billing guard's first registry read runs reg.exe and waits for it; done here, before
  // anything is being served, later reads answer from the cache and refresh in the background.
  billing.readRegistryEnv();
  await history.refresh();
  try { trash.purgeOld(); } catch (err) { console.error('emptying old trash failed:', err); }
  // Trashed conversations keep their folder note until the trash is emptied of them; after that
  // it's forgotten with them.
  try { historyFolders.prune([...history.list().map((m) => m.sessionId), ...trash.trashedSessionIds()]); } catch (err) { console.error('tidying history folders failed:', err); }
  live.start();
  usage.start();
  detectClaude().then(() => { refreshModels(); checkLatestClaude(); }).catch((err) => console.error('checking Claude Code failed:', err));
  setInterval(recheckClaudeSoon, CLAUDE_CHANGE_MS).unref();
  setInterval(() => { checkLatestClaude().catch((err) => console.error('checking for a newer Claude Code failed:', err)); }, CLAUDE_LATEST_MS).unref();
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
