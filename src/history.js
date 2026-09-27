'use strict';
// Index Claude Code transcripts (~/.claude/projects/<project>/<sessionId>.jsonl).
// Everything here is read from local files; nothing calls the Claude API.
//
// Transcripts only grow while a session runs, so each file keeps a byte offset and a folded
// summary. Later scans read just the appended bytes.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { readJson, writeJsonAtomic, clip } = require('./util');

const CACHE_VERSION = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBAGENT_RE = /^agent-[A-Za-z0-9_-]{1,64}\.jsonl$/;
const HOUR_MS = 3600000;
// Hourly token counts are kept this long: enough for any weekly window.
const KEEP_HOURS = 24 * 45;

const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function usageTokens(u) {
  return {
    input: Number(u && u.input_tokens) || 0,
    output: Number(u && u.output_tokens) || 0,
    cacheRead: Number(u && u.cache_read_input_tokens) || 0,
    cacheWrite: Number(u && u.cache_creation_input_tokens) || 0,
  };
}

const tokenTotal = (t) => (t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0);

// Token usage from assistant records: totals, plus an hourly count for the weekly usage view. One
// API message is written as several records sharing message.id, each with the same usage, so the
// latest record for an id replaces the one before it instead of adding to it.
function foldUsage(meta, o) {
  const m = o.message;
  if (!m || !m.usage || (typeof m.model === 'string' && m.model.startsWith('<'))) return;
  const t = usageTokens(m.usage);
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  const hour = Number.isNaN(ts) ? null : String(Math.floor(ts / HOUR_MS));
  const prev = m.id && m.id === meta._usageId ? meta._usage : null;
  for (const k of Object.keys(t)) meta.tokens[k] += t[k] - (prev ? prev.t[k] : 0);
  if (prev && prev.hour !== null) meta.tokenHours[prev.hour] = (meta.tokenHours[prev.hour] || 0) - tokenTotal(prev.t);
  if (hour !== null) meta.tokenHours[hour] = (meta.tokenHours[hour] || 0) + tokenTotal(t);
  meta._usageId = m.id || null;
  meta._usage = { t, hour };
}

function pruneHours(meta) {
  const oldest = Math.floor(Date.now() / HOUR_MS) - KEEP_HOURS;
  for (const h of Object.keys(meta.tokenHours)) if (Number(h) < oldest || !meta.tokenHours[h]) delete meta.tokenHours[h];
}

function newUsageMeta(sessionId) {
  return { sessionId, tokens: zeroTokens(), tokenHours: {}, _usageId: null, _usage: null };
}

function newMeta(file) {
  return {
    sessionId: path.basename(file, '.jsonl'),
    file,
    cwd: null,
    gitBranch: null,
    firstPrompt: null,
    lastPrompt: null,
    aiTitle: null,
    customTitle: null,
    tag: null,
    startedAt: null,
    updatedAt: null,
    userTurns: 0,
    assistantTurns: 0,
    costUSD: null,
    // The conversation's running totals as Claude Code last saved them (cost-state), which a
    // resumed Claude carries on from: { costUSD, input, output, cacheRead, cacheWrite }.
    costState: null,
    // Main conversation only; subagents' usage is in their own transcripts (see refreshSubagents).
    tokens: zeroTokens(),
    tokenHours: {}, // hour number (ms / 3600000) -> tokens used in that hour
    // Tokens in the context window as of the latest reply (or the size after the latest compact).
    contextTokens: null,
    model: null,
    version: null,
    prUrl: null,
    _lastAssistantId: null,
    _usageId: null,
    _usage: null,
  };
}

// The text of a real user prompt, or null for tool results, slash-command wrappers,
// caveats, system reminders and interruption markers.
function promptText(message) {
  if (!message) return null;
  const c = message.content;
  let text = null;
  let images = 0;
  if (typeof c === 'string') {
    text = c;
  } else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return null;
    text = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    images = c.filter((b) => b && b.type === 'image').length;
  }
  text = (text || '').trim();
  // A prompt that is only images still counts; describe it so lists have something to show.
  if (!text && images) return `[${images} image${images === 1 ? '' : 's'}]`;
  if (!text || text.startsWith('<') || text.startsWith('[Request interrupted')) return null;
  return text;
}

function imageCount(message) {
  const c = message && message.content;
  return Array.isArray(c) ? c.filter((b) => b && b.type === 'image').length : 0;
}

function foldRecord(meta, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.timestamp === 'string') {
    const t = Date.parse(o.timestamp);
    if (!Number.isNaN(t)) {
      if (meta.startedAt === null || t < meta.startedAt) meta.startedAt = t;
      if (meta.updatedAt === null || t > meta.updatedAt) meta.updatedAt = t;
    }
  }
  if (!meta.cwd && typeof o.cwd === 'string' && o.cwd) meta.cwd = o.cwd;
  if (typeof o.gitBranch === 'string' && o.gitBranch) meta.gitBranch = o.gitBranch;
  if (typeof o.version === 'string' && o.version) meta.version = o.version;

  switch (o.type) {
    case 'user': {
      if (o.isMeta || o.isSidechain) break;
      const text = promptText(o.message);
      if (text) {
        meta.userTurns++;
        if (!meta.firstPrompt) meta.firstPrompt = clip(text, 400);
        meta.lastPrompt = clip(text, 400);
      }
      break;
    }
    case 'assistant': {
      if (o.isSidechain || !o.message) break;
      // One API message is written as several lines (one per content block) sharing an id.
      const id = o.message.id;
      if (id && id !== meta._lastAssistantId) {
        meta.assistantTurns++;
        meta._lastAssistantId = id;
      }
      if (typeof o.message.model === 'string' && !o.message.model.startsWith('<')) meta.model = o.message.model;
      foldUsage(meta, o);
      if (o.message.usage && !(typeof o.message.model === 'string' && o.message.model.startsWith('<'))) meta.contextTokens = tokenTotal(usageTokens(o.message.usage));
      break;
    }
    case 'system':
      if (o.subtype === 'compact_boundary' && o.compactMetadata && Number.isFinite(o.compactMetadata.postTokens)) meta.contextTokens = o.compactMetadata.postTokens;
      break;
    case 'ai-title':
      if (o.aiTitle) meta.aiTitle = clip(String(o.aiTitle), 200);
      break;
    case 'custom-title':
      if (o.customTitle) meta.customTitle = clip(String(o.customTitle), 200);
      break;
    case 'tag':
      meta.tag = o.tag ? clip(String(o.tag), 80) : null;
      break;
    case 'last-prompt':
      if (o.lastPrompt) meta.lastPrompt = clip(String(o.lastPrompt), 400);
      break;
    case 'cost-state':
      if (typeof o.totalCostUSD === 'number') {
        meta.costUSD = o.totalCostUSD;
        const t = zeroTokens();
        for (const u of Object.values(o.modelUsage || {})) {
          t.input += Number(u && u.inputTokens) || 0;
          t.output += Number(u && u.outputTokens) || 0;
          t.cacheRead += Number(u && u.cacheReadInputTokens) || 0;
          t.cacheWrite += Number(u && u.cacheCreationInputTokens) || 0;
        }
        meta.costState = { costUSD: o.totalCostUSD, ...t };
      }
      break;
    case 'pr-link':
      if (o.prUrl) meta.prUrl = String(o.prUrl);
      break;
    default:
      break;
  }
}

function parseLine(line) {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// Read complete lines in [start, end). Returns the offset just past the last complete line,
// so a line that is still being written is picked up on the next scan.
async function readLinesFrom(file, start, end, onLine) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let pos = start;
    let consumed = start;
    let carry = Buffer.alloc(0);
    while (pos < end) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const fresh = Buffer.from(buf.subarray(0, bytesRead));
      const chunk = carry.length ? Buffer.concat([carry, fresh]) : fresh;
      let from = 0;
      let idx;
      while ((idx = chunk.indexOf(0x0a, from)) !== -1) {
        onLine(chunk.toString('utf8', from, idx));
        consumed += idx - from + 1;
        from = idx + 1;
      }
      carry = chunk.subarray(from);
    }
    return consumed;
  } finally {
    await fh.close();
  }
}

async function endsAtLineBoundary(file, offset) {
  if (offset === 0) return true;
  const fh = await fs.promises.open(file, 'r');
  try {
    const b = Buffer.alloc(1);
    const { bytesRead } = await fh.read(b, 0, 1, offset - 1);
    return bytesRead === 1 && b[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

// Scan a transcript, continuing from a cached entry when the file has only grown. A subagent's
// transcript (fresh and fold given) only has its token usage read.
async function scanFile(file, size, cached, fresh = () => newMeta(file), fold = foldRecord) {
  let meta;
  let offset;
  if (cached && cached.meta && cached.offset <= size && (await endsAtLineBoundary(file, cached.offset))) {
    meta = { ...cached.meta, tokens: { ...cached.meta.tokens }, tokenHours: { ...cached.meta.tokenHours } };
    offset = cached.offset;
  } else {
    meta = fresh();
    offset = 0;
  }
  if (offset < size) {
    offset = await readLinesFrom(file, offset, size, (line) => fold(meta, parseLine(line)));
    pruneHours(meta);
  }
  return { meta, offset };
}

function foldSubagentRecord(meta, o) {
  if (o && o.type === 'assistant') foldUsage(meta, o);
}

function listTranscriptFiles(projectsDir) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // Subagent transcripts live in subfolders; only top-level files are resumable sessions.
      if (e.isFile() && e.name.endsWith('.jsonl') && UUID_RE.test(e.name.slice(0, -6))) out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function publicMeta(meta) {
  const { _lastAssistantId, _usageId, _usage, tokenHours, ...rest } = meta;
  rest.title = meta.customTitle || meta.aiTitle || (meta.firstPrompt ? clip(meta.firstPrompt.split('\n')[0], 120) : null);
  return rest;
}

class HistoryIndex {
  constructor({ cacheFile } = {}) {
    this.cacheFile = cacheFile || path.join(paths.dataDir(), 'history-cache.json');
    const cached = readJson(this.cacheFile, null);
    const valid = cached && cached.version === CACHE_VERSION;
    this.files = valid && cached.files ? cached.files : {};
    // Subagent transcripts (<session>/subagents/agent-*.jsonl), read only for their token usage and
    // only for the sessions asked about (refreshSubagents), since there can be thousands.
    this.subFiles = valid && cached.subFiles ? cached.subFiles : {};
    this.bySession = new Map();
    for (const [file, entry] of Object.entries(this.files)) this.bySession.set(entry.meta.sessionId, file);
    this.inflight = null;
    this.lastRefresh = 0;
    this.saveTimer = null;
  }

  refresh() {
    if (!this.inflight) {
      this.inflight = this._refresh().finally(() => {
        this.inflight = null;
        this.lastRefresh = Date.now();
      });
    }
    return this.inflight;
  }

  refreshIfOlderThan(ms) {
    if (this.inflight) return this.inflight;
    if (Date.now() - this.lastRefresh < ms) return Promise.resolve(false);
    return this.refresh();
  }

  async _refresh() {
    const files = listTranscriptFiles(paths.projectsDir());
    const seen = new Set(files);
    let changed = false;
    for (const file of files) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const cached = this.files[file];
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) continue;
      try {
        const { meta, offset } = await scanFile(file, st.size, cached);
        this.files[file] = { size: st.size, mtimeMs: st.mtimeMs, offset, meta };
        this.bySession.set(meta.sessionId, file);
        changed = true;
      } catch {
        // unreadable right now (locked or deleted mid-scan); try again next refresh
      }
    }
    for (const file of Object.keys(this.files)) {
      if (!seen.has(file)) {
        this.bySession.delete(this.files[file].meta.sessionId);
        delete this.files[file];
        changed = true;
      }
    }
    for (const [file, entry] of Object.entries(this.subFiles)) {
      if (!this.bySession.has(entry.meta.sessionId)) {
        delete this.subFiles[file];
        changed = true;
      }
    }
    if (changed) this._scheduleSave();
    return changed;
  }

  // Reads what the subagent transcripts of these sessions gained since the last call.
  async refreshSubagents(sessionIds) {
    let changed = false;
    for (const sessionId of new Set(sessionIds)) {
      const main = this.bySession.get(sessionId);
      if (!main) continue;
      const dir = path.join(main.replace(/\.jsonl$/i, ''), 'subagents');
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!SUBAGENT_RE.test(name)) continue;
        const file = path.join(dir, name);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        const cached = this.subFiles[file];
        if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) continue;
        try {
          const { meta, offset } = await scanFile(file, st.size, cached, () => newUsageMeta(sessionId), foldSubagentRecord);
          this.subFiles[file] = { size: st.size, mtimeMs: st.mtimeMs, offset, meta };
          changed = true;
        } catch {
          // being written or deleted right now; next time
        }
      }
    }
    if (changed) this._scheduleSave();
    return changed;
  }

  _subagentEntries(sessionId) {
    return Object.values(this.subFiles).filter((e) => e.meta.sessionId === sessionId);
  }

  // Everything a conversation used, subagents included (as far as refreshSubagents has read them).
  tokensFor(sessionId) {
    const file = this.bySession.get(sessionId);
    const entry = file && this.files[file];
    if (!entry) return null;
    const t = { ...entry.meta.tokens };
    for (const e of this._subagentEntries(sessionId)) for (const k of Object.keys(t)) t[k] += e.meta.tokens[k] || 0;
    return t;
  }

  // Tokens each conversation used since `since` (ms), subagents included, most first.
  usageSince(since) {
    const from = Math.floor(since / HOUR_MS);
    const sum = (hours) => Object.entries(hours).reduce((n, [h, v]) => (Number(h) >= from ? n + v : n), 0);
    const bySession = new Map();
    for (const e of Object.values(this.files)) {
      const n = sum(e.meta.tokenHours);
      if (n) bySession.set(e.meta.sessionId, n);
    }
    for (const e of Object.values(this.subFiles)) {
      const n = sum(e.meta.tokenHours);
      if (n) bySession.set(e.meta.sessionId, (bySession.get(e.meta.sessionId) || 0) + n);
    }
    return [...bySession.entries()]
      .map(([sessionId, tokens]) => ({ sessionId, tokens, meta: this.get(sessionId) }))
      .filter((r) => r.meta)
      .sort((a, b) => b.tokens - a.tokens);
  }

  async rebuild() {
    this.files = {};
    this.subFiles = {};
    this.bySession.clear();
    await this.refresh();
  }

  _scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 2000);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    try {
      writeJsonAtomic(this.cacheFile, { version: CACHE_VERSION, files: this.files, subFiles: this.subFiles });
    } catch {
      // cache is an optimization; a failed write only costs a rescan
    }
  }

  // Sessions with at least one real prompt, newest first.
  list() {
    return Object.values(this.files)
      .map((e) => e.meta)
      .filter((m) => m.userTurns > 0)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(publicMeta);
  }

  get(sessionId) {
    const file = this.bySession.get(sessionId);
    const entry = file && this.files[file];
    return entry ? publicMeta(entry.meta) : null;
  }

  stamp(sessionId) {
    const file = this.bySession.get(sessionId);
    const entry = file && this.files[file];
    return entry ? `${entry.size}:${entry.mtimeMs}` : null;
  }

  fileFor(sessionId) {
    return this.bySession.get(sessionId) || null;
  }
}

function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.file_path || input.pattern || input.path || input.url
    || input.description || input.query || input.prompt || input.skill || '';
  return clip(String(v).replace(/\s+/g, ' ').trim(), 160);
}

const transcriptCache = new Map(); // file -> { stamp, items }

// Readable conversation: prompts, assistant text, and one-line tool calls. Thinking is omitted.
async function readTranscript(file, limit = 200) {
  const st = await fs.promises.stat(file);
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = transcriptCache.get(file);
  if (hit && hit.stamp === stamp) return hit.items.slice(-limit);

  const items = [];
  const keep = Math.max(limit, 400);
  await readLinesFrom(file, 0, st.size, (line) => {
    const o = parseLine(line);
    if (!o || o.isSidechain) return;
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) || null : null;
    if (o.type === 'user' && !o.isMeta) {
      const text = promptText(o.message);
      if (text) items.push({ kind: 'user', text: clip(text, 6000), images: imageCount(o.message), ts });
    } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          items.push({ kind: 'assistant', text: clip(b.text.trim(), 8000), ts });
        } else if (b.type === 'tool_use') {
          items.push({ kind: 'tool', name: String(b.name || 'tool'), detail: toolDetail(b.input), ts });
        }
      }
    }
    if (items.length > keep * 2) items.splice(0, items.length - keep);
  });
  transcriptCache.set(file, { stamp, items });
  if (transcriptCache.size > 20) transcriptCache.delete(transcriptCache.keys().next().value);
  return items.slice(-limit);
}

module.exports = {
  HistoryIndex,
  readTranscript,
  scanFile,
  foldRecord,
  promptText,
  newMeta,
  listTranscriptFiles,
  toolDetail,
  UUID_RE,
};
