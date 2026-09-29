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
const { readTranscript } = require('./history');
const { SubagentLog } = require('./subagents');
const { requirePlanBilling } = require('./billing');
const { readJson, writeJsonAtomic, parseArgString, clip, UserError } = require('./util');

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

// A dropped file's name, safe to create on Windows: no folders, reserved characters or device names.
function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(-120);
  return base && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base) ? base : 'file';
}

// A message to send: a string, or { text, images: [{ mediaType, data, thumb }] }.
function normalizeMessage(input) {
  const raw = typeof input === 'string' ? { text: input } : input && typeof input === 'object' ? input : {};
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 100000) : '';
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
  return { text, images };
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
    this._request(chat, { subtype: 'initialize', hooks: null }, 120000).then((res) => {
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
      this._readContext(chat);
    }).catch(() => {});
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
    for (const p of chat.pending.values()) this._resolveItem(chat, p.requestId, 'cancelled', 'Claude ended before this was answered.');
    chat.pending.clear();
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
          this._changed(chat);
        } else if (/^task_(started|progress|updated|notification)$/.test(m.subtype || '')) {
          this._onTask(chat, m);
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
        for (const b of m.message.content || []) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            this._push(chat, { kind: 'assistant', text: clip(b.text, 30000) });
            chat.lastReply = clip(b.text.trim().replace(/\s+/g, ' '), 300);
          } else if (b.type === 'tool_use') {
            this._push(chat, { kind: 'tool', toolUseId: b.id, name: String(b.name || 'tool'), detail: toolDetail(b.input), input: clipJson(b.input) });
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
        for (const b of m.message.content) {
          if (b.type === 'tool_result') {
            const it = chat.items.findLast((x) => x.kind === 'tool' && x.toolUseId === b.tool_use_id);
            if (it) {
              it.result = clip(resultText(b.content), 2000);
              it.isError = b.is_error === true;
              this._touch(chat, it);
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
        const turn = this._count(chat, m);
        const aborted = m.terminal_reason === 'aborted_streaming' || m.subtype === 'error_during_execution';
        if (m.is_error && !aborted) {
          const detail = m.result || (Array.isArray(m.errors) ? m.errors.join('\n') : '') || m.subtype;
          this._push(chat, { kind: 'error', text: `Claude hit an error: ${clip(String(detail), 2000)}` });
        }
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
        if (m.state === 'started') {
          const it = chat.items.findLast((x) => x.kind === 'user' && x.commandUuid === m.command_uuid);
          if (it && it.queued) {
            it.queued = false;
            this._touch(chat, it);
          }
        }
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
    const p = {
      requestId: m.request_id,
      toolName: String(r.tool_name || 'tool'),
      input: r.input || {},
      suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
      question,
    };
    chat.pending.set(p.requestId, p);
    this._push(chat, {
      kind: question ? 'question' : 'permission',
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

  // decision: { action: 'allow'|'always'|'deny', suggestion?, message?, answers? }
  respond(id, requestId, decision) {
    const chat = this._get(id);
    const p = chat.pending.get(requestId);
    if (!p) throw new UserError('That request was already answered.', 409);
    const d = decision && typeof decision === 'object' ? decision : {};
    let response;
    let label;
    if (d.action === 'deny') {
      const message = typeof d.message === 'string' && d.message.trim() ? d.message.trim().slice(0, 4000) : (p.question ? 'The user dismissed the question.' : 'The user denied this in Claude Deck.');
      response = { behavior: 'deny', message };
      label = p.question ? 'Dismissed' : `Denied${d.message && d.message.trim() ? `: ${clip(d.message.trim(), 200)}` : ''}`;
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
    const { text, images } = normalizeMessage(input);
    if (!text.trim() && !images.length) throw new UserError('Type a message or attach an image first.');
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
    const imageNote = images.length ? `[${images.length} image${images.length === 1 ? '' : 's'}]` : '';
    chat.lastPrompt = clip(`${imageNote} ${text.trim().replace(/\s+/g, ' ')}`.trim(), 300);
    this._push(chat, { kind: 'user', text, images: images.map((img) => img.thumb).filter(Boolean), imageCount: images.length, commandUuid: uuid, queued: wasBusy });
    // Only while it waits in line: if it's taken back to edit, its images go back with it.
    if (wasBusy && images.length) chat.queuedImages.set(uuid, images.map((img) => ({ mediaType: img.mediaType, data: img.data, thumb: img.thumb })));
    this._changed(chat);
    return { queued: chat.queued > 0 };
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
      messages.push({ text: it.text, images });
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

  async stopTask(id, taskId) {
    const chat = this._get(id);
    const task = chat.tasks.get(taskId);
    if (!task) throw new UserError('That subagent is no longer listed.', 404);
    if (task.status !== 'running') return { ok: true };
    await this._request(chat, { subtype: 'stop_task', task_id: taskId });
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
    chat.model = value || chat.model;
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
