'use strict';
// Chat sessions that run inside Claude Deck: Claude Code in its streaming JSON mode (the same
// protocol the Agent SDK and the VS Code extension use), so the dashboard can send prompts,
// answer permission prompts and questions, switch model or permission mode, and stop a turn.
//
// Newline-delimited JSON over stdin/stdout. What we send:
//   {type:'user', message:{role:'user', content}, parent_tool_use_id:null, session_id}
//   {type:'control_request', request_id, request:{subtype:'initialize'|'interrupt'|'set_model'|'set_permission_mode', ...}}
//   {type:'control_response', response:{subtype:'success', request_id, response:{behavior:'allow'|'deny', ...}}}
// What Claude sends: system (init), assistant, user (tool results), result (end of turn),
//   control_request (can_use_tool), control_cancel_request, control_response.
// Verified against claude.exe 2.1.281 with a local mock API, so no model calls were made.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const paths = require('./paths');
const prefsStore = require('./prefs');
const { isScript } = require('./claude-locate');
const { normalizeOptions, buildClaudeArgs, displayCommand, requireClaude, requireFolder, preflight, PERMISSION_MODES, EFFORTS } = require('./launcher');
const { readTranscript, UUID_RE } = require('./history');
const { runPowerShell } = require('./shell-mode');
const claudeConfig = require('./claude-config');
const { SubagentLog } = require('./subagents');
const { requirePlanBilling } = require('./billing');
const { readJson, writeJsonAtomic, parseArgString, clip, forEachLine, UserError } = require('./util');

// No --include-partial-messages: replies are shown once Claude has finished each message, not
// as they're written (text arriving a chunk at a time read as choppy); the spinner covers the wait.
const STREAM_ARGS = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'];
const MAX_ITEMS = 1500;
// Prompts kept for ↑ in the reply box after /clear empties a chat.
const MAX_PROMPTS = 200;
// How often running subagents' transcripts are read for live steps and token usage.
const AGENT_POLL_MS = 1500;
// Sleep detection: nothing runs while Windows sleeps, so on waking the time since the last check
// (every SLEEP_TICK_MS) is far longer than usual. A gap over SLEEP_GAP_MS counts as asleep.
const SLEEP_TICK_MS = 1000;
const SLEEP_GAP_MS = 15000;
// How long a plugin reload keeps trying for Claude to notice the settings change, and how often.
const PLUGIN_RELOAD_WAIT_MS = 8000;
const PLUGIN_RELOAD_RETRY_MS = 750;
const MCP_PENDING_READS = 10;
const MCP_PENDING_RETRY_MS = 3000;
const MCP_RECONNECT_WAIT_MS = 60000; // Claude Code waits up to 30 s for a server (MCP_TIMEOUT)

// What the page gets of an mcp_status entry (docs/CLAUDE-CODE-INTERNALS.md, "MCP servers"). Its
// config (command, arguments, environment, headers) can hold secrets, so it stays here.
function mcpServer(s) {
  const o = s && typeof s === 'object' ? s : {};
  const info = o.serverInfo && typeof o.serverInfo === 'object' ? o.serverInfo : {};
  return {
    name: String(o.name || ''),
    status: typeof o.status === 'string' ? o.status : 'failed',
    error: typeof o.error === 'string' ? clip(o.error, 300) : null,
    scope: typeof o.scope === 'string' ? o.scope : null,
    source: typeof o.source === 'string' ? o.source : null,
    version: typeof info.version === 'string' ? info.version : null,
    tools: Array.isArray(o.tools) ? o.tools.slice(0, 500).map((t) => String((t && t.name) || '')).filter(Boolean) : null,
  };
}

// An edit's change, for the conversation's diff view, from the result Claude Code reports with the
// tool call (tool_use_result: structuredPatch hunks of `diff -u` lines, or a new file's content).
// docs/CLAUDE-CODE-INTERNALS.md, "Tool results".
const MAX_DIFF_LINES = 400;
function editDiff(name, r) {
  if (!['Edit', 'MultiEdit', 'Write'].includes(name) || !r || typeof r !== 'object') return null;
  let hunks = Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
  if (!hunks.length && r.type === 'create' && typeof r.content === 'string') {
    const lines = r.content.replace(/\n$/, '').split('\n');
    hunks = [{ oldStart: 0, newStart: 1, lines: lines.map((l) => `+${l}`) }];
  }
  let budget = MAX_DIFF_LINES;
  let truncated = false;
  const out = [];
  for (const h of hunks) {
    if (!h || !Array.isArray(h.lines)) continue;
    if (budget <= 0) { truncated = true; break; }
    const lines = h.lines.slice(0, budget).map((l) => clip(String(l), 500));
    if (lines.length < h.lines.length) truncated = true;
    budget -= lines.length;
    out.push({ oldStart: Number(h.oldStart) || 0, newStart: Number(h.newStart) || 0, lines });
  }
  if (!out.length) return null;
  return { file: typeof r.filePath === 'string' ? r.filePath : null, hunks: out, truncated, created: r.type === 'create' };
}

// Claude's to-do list, as Claude Code keeps it from its TodoWrite calls, or from TaskCreate (whose
// result names the new task, "Task #3 created successfully") and TaskUpdate calls.
const TODO_STATUSES = ['pending', 'in_progress', 'completed'];
const todoItem = (content, status, activeForm) => ({
  content: clip(String(content || ''), 300),
  status: TODO_STATUSES.includes(status) ? status : 'pending',
  activeForm: clip(String(activeForm || content || ''), 300),
});
function todoCall(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'TodoWrite' && Array.isArray(i.todos)) return { kind: 'write', todos: i.todos.slice(0, 100) };
  if (name === 'TaskCreate' && i.subject) return { kind: 'create', subject: i.subject, activeForm: i.activeForm };
  if (name === 'TaskUpdate' && (i.taskId || i.task_id)) return { kind: 'update', taskId: String(i.taskId || i.task_id), status: i.status, subject: i.subject, activeForm: i.activeForm || i.active_form };
  return null;
}

// Approving a plan (ExitPlanMode) also sets how Claude carries on, as Claude Code's own choices do.
const PLAN_MODES = ['acceptEdits', 'default'];

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const zeroTotals = () => ({ costUSD: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// Claude's running totals for the conversation, from a result: total_cost_usd and modelUsage
// (every model, subagents included). Both start again at zero after /clear, and a resumed
// conversation carries on from its saved cost-state.
function runningTotals(m) {
  const t = zeroTotals();
  t.costUSD = m.total_cost_usd;
  for (const u of Object.values(m.modelUsage || {})) {
    t.input += Number(u && u.inputTokens) || 0;
    t.output += Number(u && u.outputTokens) || 0;
    t.cacheRead += Number(u && u.cacheReadInputTokens) || 0;
    t.cacheWrite += Number(u && u.cacheCreationInputTokens) || 0;
  }
  return t;
}

// Slash commands, as initialize and reload_plugins report them.
function commandList(commands) {
  return Array.isArray(commands)
    ? commands.map((c) => ({ name: String(c.name || ''), description: clip(String(c.description || ''), 160), argumentHint: String(c.argumentHint || '') })).filter((c) => c.name)
    : [];
}

function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.file_path || input.pattern || input.path || input.url
    || input.description || input.query || input.prompt || input.skill || '';
  return clip(String(v).replace(/\s+/g, ' ').trim(), 200);
}

function clipJson(value, max = 4000) {
  let text;
  try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  return clip(text, max);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n');
  return '';
}

const DESTINATIONS = { session: 'for this session', localSettings: 'in this project (just you)', projectSettings: 'in this project', userSettings: 'everywhere' };

// Plain-language label for a permission suggestion Claude offers with a prompt.
function describeSuggestion(s) {
  if (!s || typeof s !== 'object') return 'Always allow';
  const where = DESTINATIONS[s.destination] || '';
  if (s.type === 'setMode') {
    if (s.mode === 'acceptEdits') return 'Allow all edits for this session';
    if (s.mode === 'bypassPermissions') return 'Allow everything for this session';
    return `Switch to ${s.mode} mode`;
  }
  if (s.type === 'addRules' && Array.isArray(s.rules) && s.rules.length) {
    const rules = s.rules.map((r) => `${r.toolName}${r.ruleContent ? `(${r.ruleContent})` : ''}`).join(', ');
    return `Always allow ${rules} ${where}`.trim();
  }
  if (s.type === 'addDirectories' && Array.isArray(s.directories)) return `Allow access to ${s.directories.join(', ')} ${where}`.trim();
  return `Always allow (${s.type})`;
}

function sanitizeQuestions(input) {
  const qs = input && Array.isArray(input.questions) ? input.questions : [];
  return qs.map((q) => ({
    question: String(q.question || ''),
    header: String(q.header || ''),
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).map((o) => ({ label: String(o.label || ''), description: String(o.description || '') })),
  }));
}

// Image types and size the Messages API accepts (5 MB per image).
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 20;
const BASE64 = /^[A-Za-z0-9+/]+=*$/;
const THUMB = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
// A dropped file, base64-encoded, has to fit in one request (the server takes up to 60 MB).
const MAX_FILE_BYTES = 40 * 1024 * 1024;

// Claude Code can't sign in: not signed in ("Not logged in · Please run /login") or a sign-in that
// expired ("Failed to authenticate: OAuth session expired ..."). Its own fix, /login, only works in
// its terminal, so the chat says how to sign in from PowerShell instead. Only Claude Code's own
// phrases: an MCP server's OAuth failure, say, isn't a Claude Code sign-in problem.
const AUTH_ERROR = /not logged in|failed to authenticate|oauth (session|token) (expired|invalid)|please run \/login/i;
const SIGN_IN_COMMAND = 'claude auth login';
const signInHelp = () => ({
  kind: 'signin',
  text: "Claude Code isn't signed in, or its sign-in has expired. Open PowerShell, run the command below and finish signing in in your browser. Then send your message again; if it still fails, end this chat and resume it.",
  command: SIGN_IN_COMMAND,
});

// A dropped file's name, safe to create on Windows: no folders, reserved characters or device names.
function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(-120);
  return base && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base) ? base : 'file';
}

// Where long pastes sit in a message ([start, end] pairs, in order), so the chat can show them as
// Claude Code does, "[Pasted text #1 +123 lines]" (public/pasted-text.js). Anything that doesn't
// fit the text is dropped, and the message shows in full.
const MAX_PASTES = 100;
function pastedRanges(list, text) {
  if (!Array.isArray(list) || list.length > MAX_PASTES) return [];
  let last = 0;
  for (const r of list) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) || r[0] < last || r[1] <= r[0] || r[1] > text.length) return [];
    last = r[1];
  }
  return list.map(([start, end]) => [start, end]);
}

// The message with each long paste as its placeholder, numbered from 1.
function withPlaceholders(text, pasted) {
  let out = '';
  let at = 0;
  pasted.forEach(([start, end], i) => {
    const breaks = (text.slice(start, end).match(/\n/g) || []).length;
    out += `${text.slice(at, start)}[Pasted text #${i + 1}${breaks ? ` +${breaks} lines` : ''}]`;
    at = end;
  });
  return out + text.slice(at);
}

// A message to send: a string, or { text, images: [{ mediaType, data, thumb }], pasted: [[start, end]] }.
function normalizeMessage(input) {
  const raw = typeof input === 'string' ? { text: input } : input && typeof input === 'object' ? input : {};
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 100000) : '';
  const pasted = pastedRanges(raw.pasted, text);
  const list = Array.isArray(raw.images) ? raw.images : [];
  if (list.length > MAX_IMAGES) throw new UserError(`Send at most ${MAX_IMAGES} images at a time.`);
  const images = list.map((img, i) => {
    const mediaType = img && img.mediaType;
    if (!IMAGE_TYPES.includes(mediaType)) throw new UserError(`Image ${i + 1} isn't a PNG, JPEG, GIF or WebP.`);
    const data = typeof img.data === 'string' ? img.data : '';
    if (!data || !BASE64.test(data)) throw new UserError(`Image ${i + 1} couldn't be read.`);
    if (data.length * 0.75 > MAX_IMAGE_BYTES) throw new UserError(`Image ${i + 1} is larger than 5 MB.`);
    // The thumbnail is only for showing the message in the dashboard.
    const thumb = typeof img.thumb === 'string' && img.thumb.length <= 200000 && THUMB.test(img.thumb) ? img.thumb : null;
    return { mediaType, data, thumb };
  });
  return { text, images, pasted };
}

class ChatManager extends EventEmitter {
  constructor({ history, file } = {}) {
    super();
    this.history = history;
    this.file = file || path.join(paths.dataDir(), 'chats.json');
    this.chats = new Map();
    const saved = readJson(this.file, []);
    for (const s of Array.isArray(saved) ? saved : []) {
      if (!s || !s.id) continue;
      // Processes don't survive a server restart; the conversation does, so these come back as ended.
      this.chats.set(s.id, this._blank({ ...s, state: 'exited', note: 'Claude Deck restarted. Resume to continue this conversation.' }));
    }
    this.saveTimer = null;
    this.agentTimer = null;
    this.lastAwake = Date.now();
    this.sleepTimer = setInterval(() => this._checkSleep(), SLEEP_TICK_MS);
    this.sleepTimer.unref();
    this._purgeAttachments();
  }

  // Dropped files are kept for the chat they were dropped on (saveFile), and go with it: when it's
  // removed from the list, and at start-up for chats that are no longer listed.
  _attachmentsDir(id) {
    return path.join(paths.dataDir(), 'attachments', id);
  }

  _purgeAttachments() {
    const dir = path.join(paths.dataDir(), 'attachments');
    fs.promises.readdir(dir)
      .then((names) => Promise.all(names.filter((n) => !this.chats.has(n)).map((n) => fs.promises.rm(path.join(dir, n), { recursive: true, force: true }))))
      .catch(() => { /* no attachments yet, or one in use: next start */ });
  }

  // Time the PC spent asleep isn't time Claude spent working: it's taken out of a working chat's
  // timer (statusSince moves forward) and out of the turn's "Done in". Chats waiting on you or
  // idle keep counting, since they really were waiting that long. Also runs before each message
  // from Claude, which can arrive on waking before the next tick.
  _checkSleep(now = Date.now()) {
    const slept = now - this.lastAwake;
    this.lastAwake = now;
    if (slept < SLEEP_GAP_MS) return;
    for (const chat of this.chats.values()) {
      if (!chat.proc || !chat.busy) continue;
      chat.turnSleptMs += slept;
      if (this._status(chat).status === 'busy') {
        chat.statusSince = Math.min(now, chat.statusSince + slept);
        this._changed(chat);
      }
    }
  }

  _blank(fields) {
    return {
      id: fields.id,
      name: fields.name || '',
      color: fields.color || 'slate',
      cwd: fields.cwd,
      options: fields.options || {},
      sessionId: fields.sessionId || null,
      createdAt: fields.createdAt || Date.now(),
      lastPrompt: fields.lastPrompt || null,
      lastReply: fields.lastReply || null,
      model: fields.model || null,
      permissionMode: fields.permissionMode || null,
      costUSD: fields.costUSD ?? null, // the current conversation's, as Claude reports it
      // Claude's running totals for the current conversation as last seen ({ sessionId, costUSD,
      // input, output, cacheRead, cacheWrite }): its tokens, and what each turn added.
      seen: fields.seen || null,
      context: null, // { tokens, max, percent } from get_context_usage
      state: fields.state || 'starting',
      note: fields.note || null,
      // The session this one was forked from (a fork, or a rewind): its running totals carry on.
      forkedFrom: fields.forkedFrom || null,
      authFailed: false, // Claude Code's last reply said it couldn't sign in
      loadingPast: false, // detail() is reading the transcript for a chat restored after a restart
      proc: null,
      pid: null,
      busy: false,
      queued: 0,
      pending: new Map(),
      requests: new Map(),
      items: [],
      past: null,
      earlierPrompts: [], // your prompts from before a /clear that emptied the chat, oldest first
      seq: 0,
      nextItem: 1,
      commands: [],
      mcp: null, // [{ name, status }]: the MCP servers, from init and mcp_status
      todos: null, // Claude's to-do list: [{ content, status, activeForm }]
      taskItems: new Map(), // TaskCreate's numbered tasks: id -> todo item
      todoCalls: new Map(), // tool_use id -> a to-do call waiting for its result
      suggestion: null, // Claude Code's suggested next prompt (prompt_suggestion)
      fast: null, // { state: 'off'|'cooldown'|'on', reason } fast mode, as Claude Code reports it
      foreground: new Map(), // task_id -> running tasks Claude waits for (Ctrl+B backgrounds them)
      bgTasks: [], // [{ taskId, type, description }] running in the background (background_tasks_changed)
      silent: new Set(), // uuids of messages that don't start a turn (shell mode's output)
      silentTurns: 0, // results still to come for those
      // Local commands Claude Deck ran for itself (/config), by the uuid they were sent with:
      // { uuid, text, resolve, reject, settled }. Their replies are read, not shown.
      localCommands: new Map(),
      localActive: null, // the one whose turn is running, from its command_lifecycle "started"
      tasks: new Map(), // subagents: task_id -> task
      agentLogs: new Map(), // task_id -> SubagentLog (its transcript, read as it grows)
      queuedImages: new Map(), // commandUuid -> full images of a message still waiting, so it can be taken back
      stderr: '',
      exitCode: null,
      ending: false,
      statusKey: null,
      statusSince: Date.now(),
      turnSleptMs: 0, // time asleep during the current turn, left out of its "Done in"
      command: fields.command || '',
    };
  }

  // ---- lifecycle -----------------------------------------------------------------------------
  create(rawOptions) {
    const { o, claude } = preflight(rawOptions);
    const id = crypto.randomUUID();
    const sessionId = o.mode === 'new' ? crypto.randomUUID() : o.mode === 'resume' && !o.fork ? o.resumeId : null;
    const chat = this._blank({ id, name: o.name, color: o.color, cwd: o.cwd, options: { ...o, prompt: '', mode: 'new', resumeId: '', fork: false, worktree: false }, sessionId });
    // A fork gets a new session id but carries on the original's running totals.
    if (o.mode === 'resume' && o.fork) chat.forkedFrom = o.resumeId;
    this.chats.set(id, chat);
    const { args } = buildClaudeArgs({ ...o, prompt: '' }, sessionId);
    try {
      this._spawn(chat, claude.path, args);
    } catch (err) {
      // Nothing started, so there's no chat to list (spawn throws for a .cmd, for example).
      this.chats.delete(id);
      throw new UserError(`Claude Code could not start: ${err.message}`, 500);
    }
    if (o.mode !== 'new' && sessionId) this._loadPast(chat, sessionId);
    if (o.prompt) this.send(id, o.prompt);
    this._save();
    return this.summary(chat);
  }

  resume(id) {
    const chat = this._get(id);
    if (chat.proc) return this.summary(chat);
    if (!chat.sessionId) throw new UserError('This chat never started a conversation, so there is nothing to resume.');
    const claude = requireClaude(prefsStore.load());
    requireFolder(chat.cwd);
    requirePlanBilling(chat.cwd, { args: parseArgString(chat.options && chat.options.extraArgs) });
    const { args } = buildClaudeArgs(normalizeOptions({ ...chat.options, cwd: chat.cwd, mode: 'resume', resumeId: chat.sessionId, fork: false }), null);
    chat.note = null;
    chat.exitCode = null;
    if (!chat.items.length) this._loadPast(chat, chat.sessionId);
    else this._push(chat, { kind: 'note', text: 'Resumed.' });
    this._spawn(chat, claude.path, args);
    this._save();
    return this.summary(chat);
  }

  // Close stdin so Claude exits cleanly; kill it if it hasn't after a few seconds.
  // Resolves once the process is gone. The conversation stays in History. The chat is removed
  // from the session list, unless keep: then it stays listed as ended, ready to resume or remove.
  end(id, { keep = false } = {}) {
    const chat = this._get(id);
    chat.ending = !keep;
    if (!chat.proc) {
      if (!keep) this._remove(chat);
      return Promise.resolve();
    }
    const proc = chat.proc;
    return new Promise((resolve) => {
      proc.once('exit', () => resolve());
      try { proc.stdin.end(); } catch { /* already closed */ }
      setTimeout(() => { if (chat.proc === proc) { try { proc.kill(); } catch { /* gone */ } } }, 3000);
    });
  }

  // Used on shutdown: chats stay listed (as ended) so they can be resumed after a restart.
  async endAll() {
    await Promise.all([...this.chats.values()].filter((c) => c.proc).map((c) => {
      const proc = c.proc;
      return new Promise((resolve) => {
        proc.once('exit', resolve);
        try { proc.stdin.end(); } catch { /* closed */ }
        setTimeout(() => { try { proc.kill(); } catch { /* gone */ } resolve(); }, 3000);
      });
    }));
    this._saveNow();
  }

  _spawn(chat, command, args) {
    const full = [...args, ...STREAM_ARGS];
    const cmd = isScript(command) ? process.execPath : command;
    const argv = isScript(command) ? [command, ...full] : full;
    const env = { ...process.env };
    // Like the Agent SDK: don't let Claude think it's nested inside another Claude Code session.
    delete env.CLAUDECODE;
    // File checkpoints (what /rewind and the change timeline use) are off in stream-json mode
    // unless asked for. Respect a user who turned checkpointing off.
    if (!env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING) env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1';
    const proc = spawn(cmd, argv, { cwd: chat.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    Object.assign(chat, { proc, pid: proc.pid || null, state: 'starting', busy: false, queued: 0, stderr: '', ending: false, command: displayCommand(args) });
    proc.stdin.on('error', () => {}); // EPIPE when Claude exits first
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      // Only the new data can hold the next newline; a long line isn't searched again each chunk.
      let from = buf.length;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n', from)) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        from = 0;
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        // Output can still arrive after 'exit'. A reply is kept, but a question or a subagent
        // starting can't be answered or run by a process that's gone, and would hang around.
        if (chat.proc !== proc && (m.type === 'control_request' || (m.type === 'system' && m.subtype === 'task_started'))) continue;
        try { this._onMessage(chat, m); } catch (err) { this.emit('error', err); }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { chat.stderr = (chat.stderr + d).slice(-4000); });
    proc.on('error', (err) => this._onExit(chat, proc, null, err.message));
    proc.on('exit', (code) => this._onExit(chat, proc, code, null));
    this._changed(chat);
    // promptSuggestions: Claude Code's suggested next prompt after each turn, when the person's own
    // setting (promptSuggestionEnabled) allows, as in the terminal.
    this._request(chat, { subtype: 'initialize', hooks: null, promptSuggestions: true }, 120000).then((res) => {
      // Claude sends system/init only once a message arrives, so a freshly resumed chat that is
      // waiting for you would otherwise look stuck at "Starting". The handshake means it's ready.
      if (chat.proc === proc && chat.state === 'starting') {
        chat.state = 'running';
        this._changed(chat);
      }
      chat.commands = commandList(res.commands);
      this.emit('item', { id: chat.id, meta: true });
      // The models this Claude Code offers, with their versions, for the model menus (src/models.js).
      if (Array.isArray(res.models)) this.emit('models', res.models);
      if (res.fast_mode_state) chat.fast = { state: String(res.fast_mode_state), reason: res.fast_mode_disabled_reason ? String(res.fast_mode_disabled_reason) : null };
      this._readContext(chat);
      this._readMcp(chat);
    }).catch(() => {});
  }

  // The MCP servers' status, for the header's button. Servers connect in the background after
  // start-up, so while any is still pending it's read again a few times.
  _readMcp(chat, tries = MCP_PENDING_READS) {
    if (!chat.proc) return;
    this._request(chat, { subtype: 'mcp_status' }, 10000).then((r) => {
      this._setMcp(chat, (r.mcpServers || []).map(mcpServer));
      if (tries > 1 && chat.mcp.some((s) => s.status === 'pending')) setTimeout(() => this._readMcp(chat, tries - 1), MCP_PENDING_RETRY_MS);
    }).catch(() => {});
  }

  _setMcp(chat, servers) {
    const next = servers.map((s) => ({ name: s.name, status: s.status }));
    if (JSON.stringify(next) === JSON.stringify(chat.mcp)) return;
    chat.mcp = next;
    this._changed(chat);
  }

  // How full the context window is. "summary" answers from the last reply's usage and local
  // estimates; the default ("full") would count each category with the token-counting API.
  // Verified with 2.1.281: no request reaches the API. An older Claude Code without it: no meter.
  _readContext(chat) {
    if (!chat.proc) return;
    this._request(chat, { subtype: 'get_context_usage', detail: 'summary' }, 10000).then((r) => {
      if (!r || !Number.isFinite(r.totalTokens) || !Number.isFinite(r.maxTokens)) return;
      chat.context = { tokens: r.totalTokens, max: r.maxTokens, percent: Number.isFinite(r.percentage) ? r.percentage : null };
      this._changed(chat);
    }).catch(() => {});
  }

  // What this turn added to Claude's running totals (for the reply's token count). Claude's totals
  // start again at zero after /clear (a new session id). For a session this chat hasn't seen, the
  // starting point is its saved cost-state: a resumed conversation carries on from it, and a brand
  // new one has none. A fork's first session carries on from the original's.
  _count(chat, m) {
    if (typeof m.total_cost_usd !== 'number') return null;
    const now = runningTotals(m);
    const sessionId = m.session_id || chat.sessionId;
    let base = chat.seen && chat.seen.sessionId === sessionId ? chat.seen : null;
    if (!base) {
      const saved = (sid) => { const meta = this.history && sid ? this.history.get(sid) : null; return meta && meta.costState; };
      base = saved(sessionId) || (!chat.seen && chat.forkedFrom ? saved(chat.forkedFrom) : null) || zeroTotals();
    }
    const turn = {};
    for (const k of TOKEN_KEYS) {
      // Totals only grow within a conversation; if one went down, Claude started counting again.
      turn[k] = now[k] >= (base[k] || 0) ? now[k] - (base[k] || 0) : now[k];
    }
    chat.seen = { sessionId, ...now };
    return turn;
  }

  // The current conversation's tokens so far, subagents included, as of Claude's latest result.
  _currentTokens(chat) {
    const s = chat.seen;
    if (!s || s.sessionId !== chat.sessionId) return null;
    return { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite };
  }

  // Asks Claude to summarize the conversation so far to free up context, like /compact.
  compact(id) {
    const chat = this._get(id);
    if (!chat.proc) throw new UserError('This chat has ended. Resume it to compact it.');
    if (chat.busy) throw new UserError('Claude is working in this chat. Wait for it to finish, then compact.', 409);
    return this.send(id, '/compact');
  }

  _onExit(chat, proc, code, errMessage) {
    if (chat.proc !== proc) return;
    chat.proc = null;
    chat.pid = null;
    chat.busy = false;
    chat.turnSleptMs = 0;
    for (const w of chat.requests.values()) w.reject(new Error('Claude Code exited.'));
    chat.requests.clear();
    for (const lc of chat.localCommands.values()) lc.reject(new UserError('Claude Code exited before it answered.'));
    chat.localCommands.clear();
    chat.localActive = null;
    for (const p of chat.pending.values()) this._resolveItem(chat, p.requestId, 'cancelled', 'Claude ended before this was answered.');
    chat.pending.clear();
    chat.foreground.clear();
    chat.bgTasks = [];
    chat.suggestion = null;
    chat.silent.clear();
    chat.silentTurns = 0;
    // Subagents run inside Claude's process, so they end with it.
    for (const t of chat.tasks.values()) {
      if (t.status === 'running') { t.status = 'stopped'; t.endedAt = Date.now(); }
    }
    // Messages still waiting in line were never read.
    chat.queuedImages.clear();
    for (const it of chat.items) {
      if (it.kind === 'user' && it.queued) {
        it.queued = false;
        it.undelivered = true;
        this._touch(chat, it);
      }
    }
    if (chat.ending) {
      this._remove(chat);
      return;
    }
    chat.state = 'exited';
    chat.exitCode = code;
    if (errMessage) this._push(chat, { kind: 'error', text: `Claude Code could not start: ${errMessage}` });
    else if (code) this._push(chat, { kind: 'error', text: `Claude Code stopped (exit code ${code}).${chat.stderr.trim() ? `\n${clip(chat.stderr.trim(), 1500)}` : ''}` });
    else this._push(chat, { kind: 'note', text: 'Claude Code ended.' });
    this._changed(chat);
    this._save();
  }

  _remove(chat) {
    this.chats.delete(chat.id);
    this._save();
    this.emit('change', chat);
    fs.promises.rm(this._attachmentsDir(chat.id), { recursive: true, force: true }).catch(() => { /* a file still open; next start */ });
  }

  // ---- protocol ------------------------------------------------------------------------------
  _write(chat, obj) {
    if (!chat.proc) throw new UserError('This chat has ended. Resume it to continue.');
    chat.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  _request(chat, request, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const requestId = `req_${crypto.randomBytes(6).toString('hex')}`;
      const timer = setTimeout(() => {
        chat.requests.delete(requestId);
        reject(new Error(`Claude did not answer the ${request.subtype} request.`));
      }, timeoutMs);
      chat.requests.set(requestId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this._write(chat, { type: 'control_request', request_id: requestId, request });
      } catch (err) {
        clearTimeout(timer);
        chat.requests.delete(requestId);
        reject(err);
      }
    });
  }

  _onMessage(chat, m) {
    this._checkSleep();
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          chat.state = 'running';
          // Claude sends init as each turn starts, including queued messages it picks up after an
          // interrupt (the interrupted turn's result may already have marked the chat idle).
          chat.busy = true;
          if (m.session_id) chat.sessionId = m.session_id;
          if (m.model) chat.model = m.model;
          if (m.permissionMode) chat.permissionMode = m.permissionMode;
          if (Array.isArray(m.mcp_servers)) chat.mcp = m.mcp_servers.map(mcpServer).map((s) => ({ name: s.name, status: s.status }));
          this._changed(chat);
        } else if (/^task_(started|progress|updated|notification)$/.test(m.subtype || '')) {
          this._onForeground(chat, m);
          this._onTask(chat, m);
        } else if (m.subtype === 'background_tasks_changed') {
          // What's running in the background now (shell commands and subagents), for Stop.
          chat.bgTasks = (Array.isArray(m.tasks) ? m.tasks : []).filter((t) => t && t.task_id).slice(0, 50)
            .map((t) => ({ taskId: String(t.task_id), type: String(t.task_type || ''), description: clip(String(t.description || ''), 200) }));
          this._changed(chat);
        } else if (m.subtype === 'status' && m.status === 'compacting') {
          this._push(chat, { kind: 'note', text: 'Compacting the conversation…' });
        } else if (m.subtype === 'compact_boundary') {
          const meta = m.compact_metadata || {};
          const sizes = Number.isFinite(meta.pre_tokens) && Number.isFinite(meta.post_tokens) ? ` (${meta.pre_tokens.toLocaleString('en-US')} → ${meta.post_tokens.toLocaleString('en-US')} tokens)` : '';
          this._push(chat, { kind: 'note', text: `${meta.trigger === 'auto' ? 'Claude compacted the conversation to make room' : 'Conversation compacted'}${sizes}. Claude now works from a summary of the earlier turns.` });
          this._readContext(chat);
        }
        break;
      case 'conversation_reset':
        // /clear: Claude starts a new conversation (a new session id arrives with the next init).
        // The current cost and tokens start again at zero.
        chat.context = null;
        chat.todos = null;
        chat.taskItems.clear();
        chat.suggestion = null;
        if (prefsStore.load().clearChatOnClear) this._clearItems(chat);
        this._push(chat, { kind: 'note', text: 'Context cleared. Claude starts a new conversation from here.' });
        this._changed(chat);
        break;
      case 'assistant': {
        if (m.parent_tool_use_id) {
          this._onTaskMessage(chat, m);
          break;
        }
        if (!m.message) break;
        // The reply to a local command Claude Deck ran for itself (/config): read, not shown.
        if (chat.localActive) {
          for (const b of m.message.content || []) if (b.type === 'text' && typeof b.text === 'string') chat.localActive.text.push(b.text);
          break;
        }
        // Claude Code couldn't sign in (not signed in, or the sign-in expired): see the result below.
        if (m.error === 'authentication_failed') chat.authFailed = true;
        for (const b of m.message.content || []) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            this._push(chat, { kind: 'assistant', text: clip(b.text, 30000) });
            chat.lastReply = clip(b.text.trim().replace(/\s+/g, ' '), 300);
          } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
            // Shown collapsed, as Claude Code shows it until Ctrl+O.
            this._push(chat, { kind: 'thinking', text: clip(b.thinking, 20000) });
          } else if (b.type === 'tool_use') {
            this._push(chat, { kind: 'tool', toolUseId: b.id, name: String(b.name || 'tool'), detail: toolDetail(b.input), input: clipJson(b.input) });
            const todo = todoCall(b.name, b.input);
            if (todo) chat.todoCalls.set(b.id, todo);
          }
        }
        this._changed(chat);
        break;
      }
      case 'user': {
        if (m.parent_tool_use_id) {
          this._onTaskMessage(chat, m);
          break;
        }
        if (!m.message || !Array.isArray(m.message.content)) break;
        // tool_use_result is the tool's own output (an edit's patch, say); it comes with one result.
        const results = m.message.content.filter((b) => b.type === 'tool_result');
        for (const b of m.message.content) {
          if (b.type === 'tool_result') {
            const it = chat.items.findLast((x) => x.kind === 'tool' && x.toolUseId === b.tool_use_id);
            if (it) {
              it.result = clip(resultText(b.content), 2000);
              it.isError = b.is_error === true;
              const diff = results.length === 1 && !it.isError ? editDiff(it.name, m.tool_use_result) : null;
              if (diff) it.diff = diff;
              this._touch(chat, it);
            }
            const todo = chat.todoCalls.get(b.tool_use_id);
            if (todo) {
              chat.todoCalls.delete(b.tool_use_id);
              if (b.is_error !== true) this._applyTodo(chat, todo, resultText(b.content));
            }
          } else if (b.type === 'text' && /^\[Request interrupted/.test(b.text || '')) {
            this._push(chat, { kind: 'note', text: 'Stopped.' });
          }
        }
        break;
      }
      case 'result': {
        chat.queued = Number.isInteger(m.queued_turn_count) ? m.queued_turn_count : 0;
        chat.busy = chat.queued > 0;
        if (typeof m.total_cost_usd === 'number') chat.costUSD = m.total_cost_usd;
        if (m.fast_mode_state) chat.fast = { state: String(m.fast_mode_state), reason: m.fast_mode_disabled_reason ? String(m.fast_mode_disabled_reason) : null };
        if (chat.localActive) {
          const lc = chat.localActive;
          chat.localActive = null;
          chat.localCommands.delete(lc.uuid);
          // One that timed out meanwhile has already been answered; its reply is still swallowed.
          lc.resolve(lc.text.length ? lc.text.join('\n') : String(m.result || ''));
          this._changed(chat);
          break;
        }
        // A shell mode message (no turn) still gets a result; it isn't a reply, so nothing is shown.
        if (chat.silentTurns > 0) {
          chat.silentTurns--;
          this._changed(chat);
          break;
        }
        const turn = this._count(chat, m);
        const aborted = m.terminal_reason === 'aborted_streaming' || m.subtype === 'error_during_execution';
        if (m.is_error && !aborted) {
          const detail = m.result || (Array.isArray(m.errors) ? m.errors.join('\n') : '') || m.subtype;
          this._push(chat, { kind: 'error', text: `Claude hit an error: ${clip(String(detail), 2000)}` });
          // A sign-in problem: Claude Code says to run /login, which doesn't work in a chat.
          if (chat.authFailed || AUTH_ERROR.test(String(detail))) this._push(chat, signInHelp());
        }
        chat.authFailed = false;
        // Claude's duration_ms is clock time, sleep included.
        const durationMs = m.duration_ms ? Math.max(0, m.duration_ms - chat.turnSleptMs) : null;
        chat.turnSleptMs = 0;
        // Tokens this turn used, subagents included (from modelUsage), and how many of them were
        // subagents': the result's own usage counts only the main conversation's calls, so they're
        // the rest. A local command (/compact) reports no usage of its own, so it's all main.
        const tokens = turn ? { input: turn.input, output: turn.output, cacheRead: turn.cacheRead, cacheWrite: turn.cacheWrite } : null;
        let subagentTokens = null;
        if (tokens && m.local_command) subagentTokens = 0;
        else if (tokens && m.usage) {
          const main = m.usage;
          subagentTokens = Math.max(0, tokens.input - (Number(main.input_tokens) || 0)) + Math.max(0, tokens.output - (Number(main.output_tokens) || 0))
            + Math.max(0, tokens.cacheRead - (Number(main.cache_read_input_tokens) || 0)) + Math.max(0, tokens.cacheWrite - (Number(main.cache_creation_input_tokens) || 0));
        }
        this._push(chat, { kind: 'result', durationMs, isError: m.is_error === true, aborted, tokens, subagentTokens });
        this._changed(chat);
        this._save();
        this._readContext(chat);
        break;
      }
      case 'control_request':
        this._onControlRequest(chat, m);
        break;
      case 'command_lifecycle':
        // "started" means Claude has picked the message up, so it's no longer waiting in line.
        // Either way, once it's out of the queue its images needn't be kept for taking it back.
        if (m.state !== 'queued') chat.queuedImages.delete(m.command_uuid);
        // A local command's turn: from "started" until its result, the reply and result are its own
        // (a shell message's result, or a user message's reply, can arrive in between otherwise).
        if (chat.localCommands.has(m.command_uuid)) {
          const lc = chat.localCommands.get(m.command_uuid);
          if (m.state === 'started') chat.localActive = lc;
          else if (m.state !== 'queued' && m.state !== 'completed') {
            // Dropped before it ran (cancelled, discarded, refused).
            chat.localCommands.delete(m.command_uuid);
            if (chat.localActive === lc) chat.localActive = null;
            lc.reject(new UserError(`Claude Code didn't run it (${m.state}).`));
          }
          break;
        }
        if (chat.silent.has(m.command_uuid)) {
          if (m.state === 'started') chat.silentTurns++;
          else if (m.state !== 'queued') chat.silent.delete(m.command_uuid);
          break;
        }
        if (m.state === 'started') {
          const it = chat.items.findLast((x) => x.kind === 'user' && x.commandUuid === m.command_uuid);
          if (it && it.queued) {
            it.queued = false;
            this._touch(chat, it);
          }
        }
        break;
      case 'prompt_suggestion':
        // Claude Code's guess at your next prompt, shown in the empty reply box (Tab takes it). It
        // comes a moment after the turn's result; if a message was sent in that moment, Claude is
        // already on it and the guess is for a prompt that's gone, so it isn't shown.
        if (chat.busy) break;
        chat.suggestion = clip(String(m.suggestion || '').trim(), 500) || null;
        this._changed(chat);
        break;
      case 'control_cancel_request':
        if (chat.pending.has(m.request_id)) {
          chat.pending.delete(m.request_id);
          this._resolveItem(chat, m.request_id, 'cancelled', 'Claude withdrew this request.');
          this._changed(chat);
        }
        break;
      case 'control_response': {
        const r = m.response || {};
        const waiter = chat.requests.get(r.request_id);
        if (waiter) {
          chat.requests.delete(r.request_id);
          if (r.subtype === 'error') waiter.reject(new Error(r.error || 'Request failed.'));
          else waiter.resolve(r.response || {});
        }
        break;
      }
      default:
        break;
    }
  }

  _onControlRequest(chat, m) {
    const r = m.request || {};
    if (r.subtype !== 'can_use_tool') {
      // We register no hooks or SDK MCP servers, so nothing else should arrive; answer so Claude doesn't wait.
      try {
        this._write(chat, { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `Claude Deck does not handle ${r.subtype}.` } });
      } catch { /* exited */ }
      return;
    }
    const question = r.tool_name === 'AskUserQuestion';
    // Claude's plan, at the end of plan mode: shown in full, to approve or send back.
    const plan = r.tool_name === 'ExitPlanMode';
    const p = {
      requestId: m.request_id,
      toolName: String(r.tool_name || 'tool'),
      input: r.input || {},
      suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
      question,
      plan,
    };
    chat.pending.set(p.requestId, p);
    this._push(chat, {
      kind: question ? 'question' : plan ? 'plan' : 'permission',
      plan: plan ? clip(String((p.input && p.input.plan) || ''), 30000) : undefined,
      requestId: p.requestId,
      toolName: p.toolName,
      displayName: String(r.display_name || r.tool_name || 'tool'),
      detail: toolDetail(p.input),
      input: clipJson(p.input),
      title: r.title ? String(r.title) : '',
      description: r.description ? String(r.description) : '',
      reason: r.decision_reason ? String(r.decision_reason) : '',
      blockedPath: r.blocked_path ? String(r.blocked_path) : '',
      suggestions: p.suggestions.map(describeSuggestion),
      questions: question ? sanitizeQuestions(p.input) : undefined,
      status: 'pending',
    });
    this._changed(chat);
  }

  // decision: { action: 'allow'|'always'|'deny', suggestion?, message?, answers?, mode? }. For a
  // plan, allow takes mode: 'acceptEdits' (Claude edits without asking) or 'default' (it asks), and
  // deny keeps Claude planning, with message as what to change.
  respond(id, requestId, decision) {
    const chat = this._get(id);
    const p = chat.pending.get(requestId);
    if (!p) throw new UserError('That request was already answered.', 409);
    const d = decision && typeof decision === 'object' ? decision : {};
    let response;
    let label;
    if (d.action === 'deny') {
      const note = typeof d.message === 'string' && d.message.trim() ? d.message.trim().slice(0, 4000) : '';
      const message = note || (p.question ? 'The user dismissed the question.' : p.plan ? 'The user wants to keep planning. Stay in plan mode.' : 'The user denied this in Claude Deck.');
      response = { behavior: 'deny', message };
      label = p.question ? 'Dismissed' : `${p.plan ? 'Kept planning' : 'Denied'}${note ? `: ${clip(note, 200)}` : ''}`;
    } else if (p.plan) {
      // Verified with 2.1.284: the setMode permission update leaves plan mode for that mode.
      const mode = PLAN_MODES.includes(d.mode) ? d.mode : 'default';
      response = { behavior: 'allow', updatedInput: p.input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] };
      chat.permissionMode = mode;
      chat.options.permissionMode = mode === 'default' ? '' : mode;
      label = mode === 'acceptEdits' ? 'Approved: Claude makes its edits without asking' : 'Approved: Claude asks before each edit';
    } else if (p.question) {
      const answers = {};
      const src = d.answers && typeof d.answers === 'object' ? d.answers : {};
      for (const q of sanitizeQuestions(p.input)) {
        const a = src[q.question];
        if (typeof a === 'string' && a.trim()) answers[q.question] = a.trim().slice(0, 4000);
      }
      if (!Object.keys(answers).length) throw new UserError('Choose or type an answer first.');
      response = { behavior: 'allow', updatedInput: { ...p.input, answers } };
      label = `Answered: ${Object.values(answers).join('; ')}`;
    } else {
      response = { behavior: 'allow', updatedInput: p.input };
      label = 'Allowed';
      if (d.action === 'always') {
        const i = Number.isInteger(d.suggestion) ? d.suggestion : 0;
        const s = p.suggestions[i];
        if (!s) throw new UserError('That option is no longer available.');
        response.updatedPermissions = [s];
        label = describeSuggestion(s);
      }
    }
    this._write(chat, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    chat.pending.delete(requestId);
    this._resolveItem(chat, requestId, d.action === 'deny' ? 'denied' : 'allowed', label);
    this._changed(chat);
    return { ok: true };
  }

  // input: a string, or { text, images: [{ mediaType, data (base64), thumb (small data: URL) }] }.
  // While Claude is working the message is queued; Claude reads it when the current step ends.
  send(id, input) {
    const chat = this._get(id);
    const { text, images, pasted } = normalizeMessage(input);
    if (!text.trim() && !images.length) throw new UserError('Type a message or attach an image first.');
    // /login only works in Claude Code's terminal ("isn't available in this environment" here), so
    // it isn't sent: the chat says how to sign in instead.
    if (!images.length && /^\/login\s*$/i.test(text.trim())) {
      this._push(chat, { kind: 'user', text: text.trim(), images: [], imageCount: 0, queued: false });
      this._push(chat, signInHelp());
      this._changed(chat);
      return { queued: chat.queued > 0 };
    }
    const content = images.length
      ? [...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })), ...(text.trim() ? [{ type: 'text', text }] : [])]
      : text;
    // Claude reports each message's progress as command_lifecycle events keyed by this uuid
    // (queued -> started -> completed), which is how the "Queued" label knows when it was read.
    const uuid = crypto.randomUUID();
    this._write(chat, { type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null, session_id: chat.sessionId || 'default' });
    const wasBusy = chat.busy;
    if (chat.busy) chat.queued++;
    chat.busy = true;
    chat.suggestion = null;
    const imageNote = images.length ? `[${images.length} image${images.length === 1 ? '' : 's'}]` : '';
    chat.lastPrompt = clip(`${imageNote} ${withPlaceholders(text, pasted).trim().replace(/\s+/g, ' ')}`.trim(), 300);
    this._push(chat, { kind: 'user', text, ...(pasted.length ? { pasted } : {}), images: images.map((img) => img.thumb).filter(Boolean), imageCount: images.length, commandUuid: uuid, queued: wasBusy });
    // Only while it waits in line: if it's taken back to edit, its images go back with it.
    if (wasBusy && images.length) chat.queuedImages.set(uuid, images.map((img) => ({ mediaType: img.mediaType, data: img.data, thumb: img.thumb })));
    this._changed(chat);
    return { queued: chat.queued > 0, uuid };
  }

  // Claude Code's Send now (Ctrl+X Ctrl+S, or Ctrl+Enter, in its terminal): while Claude works,
  // the message goes in and Claude is asked to take it next, instead of waiting for the turn to
  // end. Claude Code decides how the running turn makes way (2.1.301 stops it, as an interrupt
  // does, and starts the message right after; anything queued ahead of it still runs first).
  // With nothing typed, the messages already waiting are sent now. Idle: a plain send.
  // Verified with 2.1.301 (docs/CLAUDE-CODE-INTERNALS.md, "Send now").
  async sendNow(id, input) {
    const chat = this._get(id);
    const { text, images } = normalizeMessage(input);
    const typed = Boolean(text.trim() || images.length);
    if (!chat.proc) throw new UserError('This chat has ended. Resume it to continue.');
    if (!chat.busy && !chat.queued) {
      if (!typed) throw new UserError('Type a message first.');
      return this.send(id, input);
    }
    let uuid = null;
    if (typed) ({ uuid } = this.send(id, input));
    else if (!chat.items.some((it) => it.kind === 'user' && it.queued)) throw new UserError('Nothing is waiting to be sent.');
    const res = await this._request(chat, { subtype: 'interrupt', send_now: true, ...(uuid ? { message_uuid: uuid } : {}) });
    return { queued: true, sendNow: typeof res.send_now === 'string' ? res.send_now : null };
  }

  // A file dropped on the reply box that isn't an image: { name, data (base64) }. The page can't
  // see where a dropped file is on disk, so a copy is kept in Claude Deck's data folder and its path
  // goes in the prompt, as dropping a file into Claude Code's terminal types its path. Claude then
  // reads it with its own tools. Returns { path }.
  saveFile(id, input) {
    const chat = this._get(id);
    const raw = input && typeof input === 'object' ? input : {};
    const data = typeof raw.data === 'string' ? raw.data : '';
    if (data && !BASE64.test(data)) throw new UserError("That file couldn't be read.");
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_FILE_BYTES) throw new UserError('That file is larger than 40 MB. Put it in the project folder and name it in your message instead.');
    const dir = path.join(paths.dataDir(), 'attachments', chat.id, crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safeFileName(raw.name));
    fs.writeFileSync(file, bytes);
    return { path: file };
  }

  // Takes the messages still waiting in Claude's queue back out, oldest first, so they can be
  // edited and sent again (↑ in the reply box). Claude drops each one it hasn't started yet
  // (cancel_async_message); one it has already picked up stays in the conversation.
  async unqueue(id) {
    const chat = this._get(id);
    const waiting = chat.items.filter((it) => it.kind === 'user' && it.queued);
    const messages = [];
    for (const it of waiting) {
      // Taken before asking: Claude reports the "cancelled" lifecycle (which drops them) before
      // it answers the request.
      const images = chat.queuedImages.get(it.commandUuid) || [];
      let res = null;
      try {
        res = await this._request(chat, { subtype: 'cancel_async_message', message_uuid: it.commandUuid });
      } catch { /* this Claude Code can't take it back; leave it queued */ }
      if (!res || res.cancelled !== true) continue;
      messages.push({ text: it.text, images, pasted: it.pasted || [] });
      chat.queuedImages.delete(it.commandUuid);
      it.queued = false;
      it.withdrawn = true;
      chat.queued = Math.max(0, chat.queued - 1);
      this._touch(chat, it);
    }
    if (messages.length) this._changed(chat);
    return { messages };
  }

  // Stop what Claude is doing, then send this message right away.
  async sendInterrupting(id, input) {
    const chat = this._get(id);
    normalizeMessage(input); // validate before interrupting anything
    if (chat.busy) {
      await this._request(chat, { subtype: 'interrupt' });
      chat.busy = false;
      chat.queued = 0;
    }
    return this.send(id, input);
  }

  async interrupt(id) {
    const chat = this._get(id);
    await this._request(chat, { subtype: 'interrupt' });
    return { ok: true };
  }

  // A subagent, or a shell command running in the background.
  async stopTask(id, taskId) {
    const chat = this._get(id);
    const task = chat.tasks.get(taskId);
    const background = chat.bgTasks.some((t) => t.taskId === taskId);
    if (!task && !background) throw new UserError('That task is no longer listed.', 404);
    if (task && task.status !== 'running' && !background) return { ok: true };
    await this._request(chat, { subtype: 'stop_task', task_id: taskId });
    return { ok: true };
  }

  // Ctrl+B in Claude Code: what Claude is waiting on (a shell command, a subagent) carries on in the
  // background, and Claude carries on with the turn. Verified with 2.1.284.
  async background(id) {
    const chat = this._get(id);
    if (!chat.proc) throw new UserError('This chat has ended.');
    await this._request(chat, { subtype: 'background_tasks' });
    return { ok: true };
  }

  // The running tasks Claude waits for, so the page can offer to background them.
  _onForeground(chat, m) {
    const id = m.task_id;
    if (!id) return;
    const before = chat.foreground.size;
    if (m.subtype === 'task_started' && m.is_backgrounded === false) {
      chat.foreground.set(id, { taskId: id, type: String(m.task_type || ''), description: clip(String(m.description || ''), 200) });
    }
    const ended = (m.patch && m.patch.status && m.patch.status !== 'running') || m.subtype === 'task_notification';
    if (ended || (m.patch && m.patch.is_backgrounded === true)) chat.foreground.delete(id);
    if (chat.foreground.size !== before) this._changed(chat);
  }

  _applyTodo(chat, call, resultText) {
    if (call.kind === 'write') {
      chat.todos = call.todos.map((t) => todoItem(t && t.content, t && t.status, t && t.activeForm));
    } else if (call.kind === 'create') {
      const m = /^Task #(\S+) created successfully/.exec(resultText);
      if (!m) return;
      chat.taskItems.set(m[1], todoItem(call.subject, 'pending', call.activeForm));
      chat.todos = [...chat.taskItems.values()];
    } else if (call.kind === 'update') {
      const t = chat.taskItems.get(call.taskId);
      if (!t) return;
      if (call.status === 'deleted') chat.taskItems.delete(call.taskId);
      else {
        if (TODO_STATUSES.includes(call.status)) t.status = call.status;
        if (call.subject) t.content = clip(String(call.subject), 300);
        if (call.activeForm) t.activeForm = clip(String(call.activeForm), 300);
      }
      chat.todos = [...chat.taskItems.values()];
    }
    this._changed(chat);
  }

  // The transcript entry just before one of your messages (its parentUuid): null when it's the
  // conversation's first, undefined when it isn't in the current conversation's transcript.
  // Read a line at a time: a transcript can be larger than one string can hold.
  _entryBefore(chat, messageId) {
    const file = chat.sessionId && this.history ? this.history.fileFor(chat.sessionId) : null;
    if (!file) return undefined;
    let found;
    try {
      forEachLine(file, (line) => {
        if (found !== undefined || !line.includes(messageId)) return;
        try {
          const e = JSON.parse(line);
          if (e.uuid === messageId) found = e.parentUuid || null;
        } catch { /* a partly written last line */ }
      });
    } catch {
      return undefined;
    }
    return found;
  }

  // Esc Esc in Claude Code: go back to before one of your messages, to change it. There's no request
  // for it in stream-json, so Claude starts again from the transcript up to the entry before that
  // message (--resume-session-at) as a new session (--fork-session), which leaves the conversation as
  // it was in History. files: also put files back how they were before it (rewind_files). Verified
  // with 2.1.284 (docs/CLAUDE-CODE-INTERNALS.md, "Rewinding"). Returns the message, to edit.
  async rewind(id, messageId, { files = false } = {}) {
    const chat = this._get(id);
    if (typeof messageId !== 'string' || !UUID_RE.test(messageId)) throw new UserError('Choose one of your messages.');
    const at = chat.items.findIndex((x) => x.kind === 'user' && x.commandUuid === messageId);
    if (at < 0) throw new UserError('That message is no longer in this chat.', 404);
    if (!chat.proc) throw new UserError('This chat has ended. Resume it first.');
    if (chat.busy) throw new UserError('Claude is working in this chat. Interrupt it first, then go back.', 409);
    if (this.history) await this.history.refresh();
    const before = this._entryBefore(chat, messageId);
    if (before === undefined) throw new UserError("That message isn't in this conversation's saved transcript (a message from before /clear isn't), so Claude Code can't go back to it.", 409);
    const claude = requireClaude(prefsStore.load());
    requireFolder(chat.cwd);
    requirePlanBilling(chat.cwd, { args: parseArgString(chat.options && chat.options.extraArgs) });
    if (files) await this.rewindFiles(id, messageId, false);
    const message = chat.items[at];
    await this.end(id, { keep: true });
    // The new conversation carries on the old one's running totals, as a fork does.
    const fromSession = chat.sessionId;
    let args;
    if (before) {
      ({ args } = buildClaudeArgs(normalizeOptions({ ...chat.options, cwd: chat.cwd, mode: 'resume', resumeId: fromSession, fork: true }), null));
      args.push('--resume-session-at', before);
      chat.forkedFrom = fromSession;
    } else {
      // Back to before the first message: a new conversation.
      chat.sessionId = crypto.randomUUID();
      ({ args } = buildClaudeArgs(normalizeOptions({ ...chat.options, cwd: chat.cwd, mode: 'new' }), chat.sessionId));
    }
    chat.items = chat.items.slice(0, at);
    chat.todos = null;
    chat.taskItems.clear();
    chat.suggestion = null;
    chat.note = null;
    chat.exitCode = null;
    this.emit('item', { id: chat.id, reset: true });
    this._push(chat, { kind: 'note', text: `Went back to before your message${files ? ', and put the files back as they were then' : ''}. The conversation as it was is still in History.` });
    this._spawn(chat, claude.path, args);
    this._save();
    return { text: message.text, pasted: message.pasted || [] };
  }

  // "!command" in the reply box, as in Claude Code's terminal: runs it now (src/shell-mode.js) and
  // adds the command and its output to the conversation the way the terminal does, as <bash-input>
  // and <bash-stdout>/<bash-stderr> text in a message that starts no turn (shouldQuery: false).
  // Claude reads it with your next message. Verified with 2.1.284.
  async runShell(id, command) {
    const chat = this._get(id);
    const cmd = typeof command === 'string' ? command.trim().slice(0, 10000) : '';
    if (!cmd) throw new UserError('Type a command after the !.');
    if (!chat.proc) throw new UserError('This chat has ended. Resume it to run commands in it.');
    requireFolder(chat.cwd);
    const item = { kind: 'shell', command: cmd, running: true };
    this._push(chat, item);
    let r;
    try {
      r = await runPowerShell(cmd, chat.cwd);
    } catch (err) {
      Object.assign(item, { running: false, stderr: `PowerShell could not start: ${err.message}`, exitCode: null });
      this._touch(chat, item);
      throw new UserError(`PowerShell could not start: ${err.message}`, 500);
    }
    const stderr = r.timedOut ? `${r.stderr ? `${r.stderr}\n` : ''}Stopped after 2 minutes.` : r.stderr;
    Object.assign(item, { running: false, stdout: r.stdout, stderr, exitCode: r.exitCode });
    this._touch(chat, item);
    if (chat.proc) {
      const uuid = crypto.randomUUID();
      chat.silent.add(uuid);
      this._write(chat, {
        type: 'user',
        uuid,
        shouldQuery: false,
        message: { role: 'user', content: [{ type: 'text', text: `<bash-input>${cmd}</bash-input>` }, { type: 'text', text: `<bash-stdout>${r.stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>` }] },
        parent_tool_use_id: null,
        session_id: chat.sessionId || 'default',
      });
    }
    return { exitCode: r.exitCode };
  }

  // Runs one of Claude Code's local commands (no model request) in the chat's own Claude Code and
  // returns its reply as text, without adding anything to the conversation. Its reply is told
  // apart from everything else by the command_lifecycle events for the uuid it was sent with
  // (see _onMessage), so a message or shell command sent meanwhile can't be taken for it. Only
  // while Claude is idle, so it's answered right away. Verified with 2.1.301.
  _localCommand(chat, text, timeoutMs = 20000) {
    if (!chat.proc) return Promise.reject(new UserError('This chat has ended. Resume it first.'));
    if (chat.busy || chat.queued > 0) return Promise.reject(new UserError('Claude is working. Try again when it has finished.'));
    if ([...chat.localCommands.values()].some((lc) => !lc.settled)) return Promise.reject(new UserError('Still waiting for Claude Code to answer the last change.'));
    return new Promise((resolve, reject) => {
      const uuid = crypto.randomUUID();
      const lc = { uuid, text: [], settled: false, timer: null };
      const settle = (fn, v) => { if (lc.settled) return; lc.settled = true; clearTimeout(lc.timer); fn(v); };
      lc.resolve = (v) => settle(resolve, v);
      lc.reject = (e) => settle(reject, e);
      // After the timeout the command stays listed: Claude Code may still run it, and its reply
      // must still be read rather than shown as Claude's.
      lc.timer = setTimeout(() => lc.reject(new UserError("Claude Code didn't answer. Try again in a moment.")), timeoutMs);
      chat.localCommands.set(uuid, lc);
      try {
        this._write(chat, { type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: chat.sessionId || 'default' });
      } catch (err) {
        chat.localCommands.delete(uuid);
        lc.reject(err);
      }
    });
  }

  // The chat's Config window: Claude Code's /config options (its own list) with current values.
  async configOptions(id) {
    const chat = this._get(id);
    const options = claudeConfig.options(await this._localCommand(chat, '/config'), chat.cwd);
    if (!options.length) throw new UserError("Claude Code didn't list its /config options. Its version may not support changing them here.");
    return { options };
  }

  // { key: value } -> Claude Code's own "/config key=value", one option at a time. Returns its reply
  // lines: "Set Theme to dark" when it took, anything else when it didn't.
  async setConfig(id, changes) {
    const chat = this._get(id);
    const entries = changes && typeof changes === 'object' ? Object.entries(changes) : [];
    if (!entries.length) throw new UserError('Nothing to change.');
    // Every change is checked before any is sent, so a bad one can't leave the others half done.
    const commands = entries.map(([key, value]) => {
      try { return { key, value: String(value).trim(), command: claudeConfig.setCommand(key, value) }; } catch (err) { throw new UserError(err.message); }
    });
    const lines = [];
    const taken = [];
    for (const { key, value, command } of commands) {
      let reply;
      try {
        reply = await this._localCommand(chat, command);
      } catch (err) {
        // The changes before this one were made; their confirmations stay, with what stopped it.
        lines.push(`Couldn't set ${key}: ${err.message}`);
        break;
      }
      const out = reply.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (out.length && out.every((l) => /^Set /.test(l))) taken.push([key, value]);
      lines.push(...out);
    }
    // Claude Code says "Set ..." a moment before its files show the change (2.1.301), so wait for
    // them (up to 3 seconds): the window reads the files again straight after this.
    for (let waited = 0; taken.length && waited < 3000; waited += 150) {
      const now = claudeConfig.currentValues(taken.map(([k]) => k), chat.cwd);
      // An option whose file isn't known here can't be waited for.
      if (taken.every(([k, v]) => now[k].where === null || String(now[k].value).toLowerCase() === v.toLowerCase())) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return { lines };
  }

  // @ in the reply box: files matching what's typed, ranked as Claude Code's own @ list ranks them.
  async fileSuggestions(id, query) {
    const chat = this._get(id);
    if (!chat.proc) return { suggestions: [] };
    const r = await this._request(chat, { subtype: 'file_suggestions', query: String(query || '').slice(0, 200) }, 10000);
    const list = Array.isArray(r.suggestions) ? r.suggestions : [];
    return { suggestions: list.slice(0, 50).map((s) => String((s && s.path) || '')).filter(Boolean) };
  }

  // /btw: a quick question about the conversation, answered aside; neither it nor the answer goes
  // into the conversation. Verified with 2.1.284: { response }.
  async sideQuestion(id, question) {
    const chat = this._get(id);
    const q = typeof question === 'string' ? question.trim().slice(0, 4000) : '';
    if (!q) throw new UserError('Type a question after /btw.');
    if (!chat.proc) throw new UserError('This chat has ended. Resume it to ask about it.');
    const r = await this._request(chat, { subtype: 'side_question', question: q }, 180000);
    return { question: q, answer: clip(String((r && r.response) || ''), 20000) };
  }

  // Signing in to an MCP server that needs it, as /mcp does: Claude Code answers with the address
  // to open, and finishes the sign-in itself when the browser comes back to it. The response shape
  // is from the code inside claude.exe 2.1.284; only its errors were seen in a probe.
  async authenticateMcp(id, name) {
    const chat = this._get(id);
    if (!chat.proc) throw new UserError('This chat has ended. Resume it to change its MCP servers.');
    if (typeof name !== 'string' || !name) throw new UserError('Which MCP server?');
    const r = await this._request(chat, { subtype: 'mcp_authenticate', serverName: name }, 60000);
    const authUrl = typeof r.authUrl === 'string' && /^https:\/\//i.test(r.authUrl) ? r.authUrl : null;
    return { authUrl, requiresUserAction: r.requiresUserAction !== false, callbackExpected: r.callbackExpected === true };
  }

  // Fast mode bills Claude's replies to extra usage, beyond what the plan includes (Claude Code
  // reports "extra_usage_disabled" when that's off), so it's only allowed with Allow API billing.
  async setFastMode(id, on) {
    const chat = this._get(id);
    if (!chat.proc) throw new UserError('This chat has ended.');
    if (on && !prefsStore.load().allowApiBilling) throw new UserError("Fast mode is billed as extra usage, on top of your plan. To use it, turn on Allow API billing in Claude Deck Preferences.", 403);
    await this._request(chat, { subtype: 'apply_flag_settings', settings: { fastMode: on === true } });
    chat.fast = { ...(chat.fast || {}), state: on ? 'on' : 'off' };
    this._push(chat, { kind: 'note', text: `Fast mode is ${on ? 'on' : 'off'}.` });
    this._changed(chat);
    return { ok: true };
  }

  // Restore files to how they were before the prompt with this uuid, through Claude's own
  // checkpoints so its file history stays consistent. dryRun reports what would change:
  // { canRewind, filesChanged, insertions, deletions } (or { canRewind:false, error }).
  async rewindFiles(id, messageId, dryRun) {
    const chat = this._get(id);
    if (!chat.proc) throw new UserError('This chat has ended.');
    if (chat.busy) throw new UserError('Claude is working in this chat. Wait for it to finish or interrupt it, then restore.', 409);
    const res = await this._request(chat, { subtype: 'rewind_files', user_message_id: messageId, ...(dryRun ? { dry_run: true } : {}) });
    if (!res || res.canRewind === false) throw new UserError(`Claude could not restore these files: ${(res && res.error) || 'no checkpoint for that turn.'} End the chat and try again to restore from the saved checkpoints.`, 409);
    if (!dryRun) this._push(chat, { kind: 'note', text: 'Files restored to how they were before an earlier turn. The conversation itself is unchanged.' });
    return res;
  }

  // The running chat that owns a conversation, if any.
  findBySession(sessionId) {
    return [...this.chats.values()].find((c) => c.proc && c.sessionId === sessionId) || null;
  }

  // ---- subagents -----------------------------------------------------------------------------
  // Claude reports subagents with system messages (task_started / task_progress / task_updated /
  // task_notification). Their own tool calls arrive as assistant/user messages whose
  // parent_tool_use_id is the Agent tool call that started them.
  _onTask(chat, m) {
    const id = m.task_id;
    if (!id) return;
    let t = chat.tasks.get(id);
    if (!t) {
      // Long-running shell commands are reported with the same messages (task_type local_bash);
      // only subagents (local_agent) are listed. Later messages about a task omit task_type.
      const isAgent = m.task_type ? m.task_type === 'local_agent' : Boolean(m.subagent_type);
      if (!isAgent) return;
      t = { taskId: id, toolUseId: m.tool_use_id || null, description: '', subagentType: '', prompt: '', status: 'running', startedAt: Date.now(), endedAt: null, activity: '', toolUses: 0, tokens: 0, lastTool: '', summary: '', background: false, model: null, reportedTokens: null, fromTranscript: false, log: [] };
      chat.tasks.set(id, t);
      this._watchAgents();
    }
    if (m.tool_use_id) t.toolUseId = m.tool_use_id;
    // task_progress also has a "description", but it describes the current step ("Running ..."),
    // so the task's own description comes only from task_started.
    if (m.description && (m.subtype === 'task_started' || !t.description)) t.description = clip(String(m.description), 200);
    if (m.subagent_type) t.subagentType = String(m.subagent_type);
    if (m.prompt) t.prompt = clip(String(m.prompt), 2000);
    if (typeof m.is_backgrounded === 'boolean') t.background = m.is_backgrounded;
    if (m.subtype === 'task_started') {
      t.status = 'running';
      t.activity = 'Starting';
    } else if (m.subtype === 'task_progress') {
      t.activity = clip(String(m.description || ''), 200);
      if (m.last_tool_name) t.lastTool = String(m.last_tool_name);
    }
    if (m.usage) {
      if (Number.isFinite(m.usage.tool_uses)) t.toolUses = m.usage.tool_uses;
      // Claude's own figure, a different measure from the transcript's per-call usage that `tokens`
      // shows (see _syncAgent). Kept for the detail view.
      if (Number.isFinite(m.usage.total_tokens)) t.reportedTokens = m.usage.total_tokens;
    }
    const status = (m.patch && m.patch.status) || (m.subtype === 'task_notification' ? m.status : null);
    if (status) {
      t.status = String(status);
      if (t.status !== 'running') t.endedAt = (m.patch && m.patch.end_time) || t.endedAt || Date.now();
    }
    if (m.summary) t.summary = clip(String(m.summary), 2000);
    // Read its transcript now too, so the last steps land when it finishes.
    this._syncAgent(chat, t);
    // No transcript (an older Claude Code): fall back to Claude's own figure once it's done.
    if (t.status !== 'running' && !t.fromTranscript && t.reportedTokens) t.tokens = t.reportedTokens;
    this._emitTasks(chat);
  }

  // ---- subagent transcripts ------------------------------------------------------------------
  // A foreground subagent's own messages never reach stdout, so its steps and token usage are read
  // from the transcript Claude Code writes for it (src/subagents.js) while any subagent runs.
  _watchAgents() {
    if (this.agentTimer) return;
    this.agentTimer = setInterval(() => {
      let active = 0;
      for (const chat of this.chats.values()) {
        let changed = false;
        for (const t of chat.tasks.values()) {
          // A subagent's last records can land just after Claude reports it finished.
          if (t.status !== 'running' && !(t.endedAt && Date.now() - t.endedAt < AGENT_POLL_MS * 4)) continue;
          active++;
          if (this._syncAgent(chat, t)) changed = true;
        }
        if (changed) this._emitTasks(chat);
      }
      if (!active) {
        clearInterval(this.agentTimer);
        this.agentTimer = null;
      }
    }, AGENT_POLL_MS);
    this.agentTimer.unref();
  }

  // Reads what the subagent's transcript gained. Returns true if the task's summary fields changed.
  _syncAgent(chat, t) {
    if (!chat.sessionId) return false;
    let log = chat.agentLogs.get(t.taskId);
    if (!log) {
      log = new SubagentLog(chat.sessionId, t.taskId);
      chat.agentLogs.set(t.taskId, log);
    }
    try {
      if (!log.update(this.history ? this.history.fileFor(chat.sessionId) : null)) return false;
    } catch {
      return false;
    }
    const before = `${t.tokens}|${t.toolUses}|${t.activity}|${t.model}`;
    const usage = log.usage();
    if (usage.calls) {
      t.tokens = usage.total;
      t.fromTranscript = true;
    }
    t.toolUses = Math.max(t.toolUses, log.toolUses);
    if (log.model) t.model = log.model;
    if (t.status === 'running' && log.activity()) t.activity = log.activity();
    return `${t.tokens}|${t.toolUses}|${t.activity}|${t.model}` !== before;
  }

  // Everything known about one subagent: its steps (from its transcript, or else from the messages
  // Claude streamed for it) and token usage.
  taskDetail(id, taskId) {
    const chat = this._get(id);
    const t = chat.tasks.get(taskId);
    if (!t) throw new UserError('That subagent is no longer listed.', 404);
    if (this._syncAgent(chat, t)) this._emitTasks(chat);
    const log = chat.agentLogs.get(taskId);
    const fromFile = Boolean(log && log.file && log.steps.length);
    const steps = fromFile
      ? log.steps.map((s) => ({ ...s }))
      : t.log.map((e) => (e.kind === 'tool' ? { kind: 'tool', name: e.name, detail: e.detail, ts: e.ts, result: e.result === undefined ? null : e.result, isError: e.isError === true } : { kind: 'text', text: e.text, ts: e.ts }));
    return { ...t, log: undefined, steps, usage: log && log.file ? log.usage() : null, lastTs: log ? log.lastTs : null };
  }

  _onTaskMessage(chat, m) {
    const t = [...chat.tasks.values()].find((x) => x.toolUseId === m.parent_tool_use_id);
    if (!t || !m.message || !Array.isArray(m.message.content)) return;
    for (const b of m.message.content) {
      if (b.type === 'tool_use') t.log.push({ kind: 'tool', id: b.id, name: String(b.name || 'tool'), detail: toolDetail(b.input), ts: Date.now() });
      else if (b.type === 'tool_result') {
        const entry = t.log.findLast((e) => e.kind === 'tool' && e.id === b.tool_use_id);
        if (entry) { entry.result = clip(resultText(b.content), 300); entry.isError = b.is_error === true; }
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && m.type === 'assistant') {
        t.log.push({ kind: 'text', text: clip(b.text.trim(), 1000), ts: Date.now() });
      }
    }
    if (t.log.length > 60) t.log.splice(0, t.log.length - 60);
    this._emitTasks(chat);
  }

  _taskList(chat) {
    return [...chat.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  _emitTasks(chat) {
    // Copies, so listeners get the state as of this update rather than objects that keep changing.
    this.emit('tasks', { id: chat.id, tasks: this._taskList(chat).map((t) => ({ ...t, log: t.log.map((e) => ({ ...e })) })) });
    this._changed(chat);
  }

  async setModel(id, model) {
    const chat = this._get(id);
    const value = typeof model === 'string' && model.trim() ? model.trim().slice(0, 120) : null;
    await this._request(chat, { subtype: 'set_model', model: value });
    // Back to the default: which model that is comes with the next turn's init.
    chat.model = value;
    chat.options.model = value || '';
    this._push(chat, { kind: 'note', text: `Model changed to ${value || 'the default'}.` });
    this._changed(chat);
    this._save();
    this._readContext(chat); // the new model's context window can be a different size
    return { ok: true };
  }

  // Changes a running chat's effort for its next requests; '' goes back to the model's default.
  // apply_flag_settings is session-scoped, like --effort (docs/CLAUDE-CODE-INTERNALS.md).
  async setEffort(id, effort) {
    const chat = this._get(id);
    if (effort !== '' && !EFFORTS.includes(effort)) throw new UserError('Unknown effort level.');
    await this._request(chat, { subtype: 'apply_flag_settings', settings: { effortLevel: effort || null } });
    chat.options.effort = effort;
    this._push(chat, { kind: 'note', text: `Effort changed to ${effort || 'the default'}.` });
    this._changed(chat);
    this._save();
    return { ok: true };
  }

  // Applies a plugin change to a running chat, like /reload-plugins. The change is already in
  // Claude Code's settings, but a running Claude re-reads them on its own schedule (about a second
  // later), so this reloads until the plugin shows up (or is gone). Unless forced, Claude holds back
  // a reload that would change its tools mid-conversation, which would lose its prompt cache; the
  // page asks first. See docs/CLAUDE-CODE-INTERNALS.md, "Plugins".
  async reloadPlugins(id, { pluginId, enabled, force } = {}) {
    const chat = this._get(id);
    if (!chat.proc) return { applied: false, reason: 'ended' };
    const until = Date.now() + PLUGIN_RELOAD_WAIT_MS;
    for (;;) {
      const res = (await this._request(chat, { subtype: 'reload_plugins', ...(force ? {} : { hold_on_cache_impact: true }) }, 30000)) || {};
      if (res.held) return { applied: false, held: true };
      const loaded = Array.isArray(res.plugins) && res.plugins.some((p) => p && p.source === pluginId);
      if (!pluginId || loaded === Boolean(enabled)) {
        chat.commands = commandList(res.commands);
        this.emit('item', { id: chat.id, meta: true });
        if (pluginId) this._push(chat, { kind: 'note', text: `${pluginId.split('@')[0]} ${enabled ? 'is on' : 'is off'} in this chat now.` });
        this._changed(chat);
        return { applied: true };
      }
      if (Date.now() > until) return { applied: false, reason: 'timeout' };
      await new Promise((r) => setTimeout(r, PLUGIN_RELOAD_RETRY_MS));
    }
  }

  // The chat's MCP servers, as /mcp lists them: status, tools, and why one failed.
  async mcpStatus(id) {
    const chat = this._get(id);
    if (!chat.proc) throw new UserError('This chat has ended. Resume it to see its MCP servers.');
    const r = await this._request(chat, { subtype: 'mcp_status' }, 10000);
    const servers = (r.mcpServers || []).map(mcpServer);
    this._setMcp(chat, servers);
    return { servers };
  }

  // Turns an MCP server on or off, as /mcp does. Claude Code remembers it for this folder
  // (disabledMcpServers in its .claude.json), so new sessions here start with it the same way.
  async setMcpEnabled(id, name, enabled) {
    const chat = this._get(id);
    if (!chat.proc) throw new UserError('This chat has ended. Resume it to change its MCP servers.');
    if (typeof name !== 'string' || !name) throw new UserError('Which MCP server?');
    await this._request(chat, { subtype: 'mcp_toggle', serverName: name, enabled });
    this._push(chat, { kind: 'note', text: `MCP server ${name} is ${enabled ? 'on' : 'off'}.` });
    return this.mcpStatus(id);
  }

  async reconnectMcp(id, name) {
    const chat = this._get(id);
    if (!chat.proc) throw new UserError('This chat has ended. Resume it to change its MCP servers.');
    if (typeof name !== 'string' || !name) throw new UserError('Which MCP server?');
    try {
      await this._request(chat, { subtype: 'mcp_reconnect', serverName: name }, MCP_RECONNECT_WAIT_MS);
    } catch (err) {
      // Claude answers with why it couldn't connect ("Connection closed"); the list shows it too.
      await this.mcpStatus(id).catch(() => {});
      throw new UserError(err.message, 502);
    }
    return this.mcpStatus(id);
  }

  async setPermissionMode(id, mode) {
    const chat = this._get(id);
    if (!PERMISSION_MODES.includes(mode) && mode !== 'default') throw new UserError('Unknown permission mode.');
    await this._request(chat, { subtype: 'set_permission_mode', mode });
    chat.permissionMode = mode;
    chat.options.permissionMode = mode === 'default' ? '' : mode;
    this._push(chat, { kind: 'note', text: `Permission mode changed to ${mode}.` });
    this._changed(chat);
    this._save();
    return { ok: true };
  }

  update(id, patch) {
    const chat = this._get(id);
    if (typeof patch.name === 'string') chat.name = patch.name.trim().slice(0, 120);
    if (typeof patch.color === 'string') chat.color = patch.color;
    this._changed(chat);
    this._save();
    return this.summary(chat);
  }

  // ---- items ---------------------------------------------------------------------------------
  _push(chat, item) {
    item.n = chat.nextItem++;
    item.ts = Date.now();
    chat.items.push(item);
    if (chat.items.length > MAX_ITEMS) chat.items.splice(0, chat.items.length - MAX_ITEMS);
    chat.seq++;
    this.emit('item', { id: chat.id, seq: chat.seq, item });
  }

  _touch(chat, item) {
    chat.seq++;
    this.emit('item', { id: chat.id, seq: chat.seq, item });
  }

  // /clear with Clear the chat on /clear on (Claude Deck Preferences): the messages go, as Claude
  // Code clears its screen. Messages still waiting in line stay, since Claude reads them in the new
  // conversation, and your prompts are kept for ↑ in the reply box, as Claude Code keeps its history.
  _clearItems(chat) {
    const prompts = [...(chat.past || []), ...chat.items]
      .filter((x) => x.kind === 'user' && !x.queued && !x.withdrawn && typeof x.text === 'string' && x.text.trim())
      .map((x) => x.text);
    chat.earlierPrompts = [...chat.earlierPrompts, ...prompts].slice(-MAX_PROMPTS);
    chat.items = chat.items.filter((x) => x.kind === 'user' && x.queued);
    chat.past = [];
    this.emit('item', { id: chat.id, reset: true });
  }

  _resolveItem(chat, requestId, status, label) {
    const it = chat.items.findLast((x) => x.requestId === requestId);
    if (!it) return;
    it.status = status;
    it.outcome = label;
    this._touch(chat, it);
  }

  // Earlier turns of a resumed conversation, read from its transcript.
  async _loadPast(chat, sessionId) {
    try {
      if (!this.history) return;
      await this.history.refresh();
      const file = this.history.fileFor(sessionId);
      if (!file) return;
      chat.past = await readTranscript(file, 200);
      this.emit('item', { id: chat.id, reset: true });
    } catch {
      // history preview is a nicety; the chat works without it
    }
  }

  _changed(chat) {
    const key = this._status(chat).status;
    if (key !== chat.statusKey) {
      chat.statusKey = key;
      chat.statusSince = Date.now();
    }
    this.emit('change', chat);
  }

  _save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this._saveNow(), 300);
  }

  _saveNow() {
    clearTimeout(this.saveTimer);
    const rows = [...this.chats.values()].map((c) => ({
      id: c.id, name: c.name, color: c.color, cwd: c.cwd, options: c.options, sessionId: c.sessionId, createdAt: c.createdAt,
      lastPrompt: c.lastPrompt, lastReply: c.lastReply, model: c.model, permissionMode: c.permissionMode, costUSD: c.costUSD, command: c.command,
      seen: c.seen,
    }));
    try { writeJsonAtomic(this.file, rows); } catch { /* retried on the next change */ }
  }

  // ---- views ---------------------------------------------------------------------------------
  _get(id) {
    const chat = this.chats.get(id);
    if (!chat) throw new UserError('That chat is no longer open.', 404);
    return chat;
  }

  _status(chat) {
    if (!chat.proc) return { state: 'exited', status: null, waitingFor: null };
    const first = chat.pending.values().next().value;
    if (first) return { state: 'running', status: 'waiting', waitingFor: first.question ? 'a question' : `permission to use ${first.toolName}` };
    if (chat.state === 'starting' && !chat.busy) return { state: 'starting', status: 'starting', waitingFor: null };
    return { state: 'running', status: chat.busy ? 'busy' : 'idle', waitingFor: null };
  }

  summary(chat) {
    const s = this._status(chat);
    const first = chat.pending.values().next().value;
    const firstItem = first ? chat.items.findLast((x) => x.requestId === first.requestId) : null;
    return {
      id: chat.id,
      kind: 'chat',
      name: chat.name,
      color: chat.color,
      cwd: chat.cwd,
      sessionId: chat.sessionId,
      pid: chat.pid,
      state: s.state,
      status: s.status,
      waitingFor: s.waitingFor,
      statusSince: chat.statusSince,
      launchedAt: chat.createdAt,
      lastPrompt: chat.lastPrompt,
      lastReply: chat.lastReply,
      chatModel: chat.model,
      requestedModel: chat.options.model || '',
      requestedEffort: chat.options.effort || '',
      permissionMode: chat.permissionMode,
      chatCost: chat.costUSD,
      tokens: this._currentTokens(chat),
      context: chat.proc ? chat.context : null,
      mcp: chat.proc ? chat.mcp : null,
      todos: chat.todos,
      suggestion: chat.proc ? chat.suggestion : null,
      fast: chat.proc ? chat.fast : null,
      foregroundTasks: chat.foreground.size,
      bgTasks: chat.bgTasks,
      exitCode: chat.exitCode,
      note: chat.note,
      command: chat.command,
      pendingCount: chat.pending.size,
      runningTasks: [...chat.tasks.values()].filter((t) => t.status === 'running').length,
      taskCount: chat.tasks.size,
      pending: firstItem ? { requestId: firstItem.requestId, kind: firstItem.kind, displayName: firstItem.displayName, detail: firstItem.detail, suggestions: firstItem.suggestions } : null,
    };
  }

  detail(id) {
    const chat = this._get(id);
    // A chat restored after Claude Deck restarts has no messages in memory: show its conversation
    // from the transcript, as History does (the page reloads it when that arrives).
    if (!chat.items.length && !chat.past && chat.sessionId && !chat.loadingPast) {
      chat.loadingPast = true;
      this._loadPast(chat, chat.sessionId).finally(() => {
        chat.loadingPast = false;
        if (!chat.past) chat.past = []; // no transcript to show; don't keep looking
      });
    }
    return { ...this.summary(chat), items: chat.items, past: chat.past || [], earlierPrompts: chat.earlierPrompts, seq: chat.seq, commands: chat.commands, tasks: this._taskList(chat) };
  }

  list() {
    return [...this.chats.values()].map((c) => this.summary(c));
  }

  // Launch options (model, effort, folders...) to reuse when moving this conversation elsewhere.
  optionsOf(id) {
    return { ...this._get(id).options };
  }

  pids() {
    return new Set([...this.chats.values()].map((c) => c.pid).filter(Boolean));
  }

  runningCount() {
    return [...this.chats.values()].filter((c) => c.proc).length;
  }
}

module.exports = { ChatManager, describeSuggestion, safeFileName, STREAM_ARGS };
