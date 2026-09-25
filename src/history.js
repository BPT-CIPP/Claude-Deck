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

const CACHE_VERSION = 2;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    model: null,
    version: null,
    prUrl: null,
    _lastAssistantId: null,
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
      break;
    }
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
      if (typeof o.totalCostUSD === 'number') meta.costUSD = o.totalCostUSD;
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

// Scan a transcript, continuing from a cached entry when the file has only grown.
async function scanFile(file, size, cached) {
  let meta;
  let offset;
  if (cached && cached.meta && cached.offset <= size && (await endsAtLineBoundary(file, cached.offset))) {
    meta = { ...cached.meta };
    offset = cached.offset;
  } else {
    meta = newMeta(file);
    offset = 0;
  }
  if (offset < size) {
    offset = await readLinesFrom(file, offset, size, (line) => foldRecord(meta, parseLine(line)));
  }
  return { meta, offset };
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
  const { _lastAssistantId, ...rest } = meta;
  rest.title = meta.customTitle || meta.aiTitle || (meta.firstPrompt ? clip(meta.firstPrompt.split('\n')[0], 120) : null);
  return rest;
}

class HistoryIndex {
  constructor({ cacheFile } = {}) {
    this.cacheFile = cacheFile || path.join(paths.dataDir(), 'history-cache.json');
    const cached = readJson(this.cacheFile, null);
    this.files = cached && cached.version === CACHE_VERSION && cached.files ? cached.files : {};
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
    if (changed) this._scheduleSave();
    return changed;
  }

  async rebuild() {
    this.files = {};
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
      writeJsonAtomic(this.cacheFile, { version: CACHE_VERSION, files: this.files });
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
