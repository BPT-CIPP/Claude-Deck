'use strict';
// Live view of one subagent, from the transcript Claude Code writes for it as it works:
//
//   <claudeDir>/projects/<project>/<sessionId>/subagents/agent-<taskId>.jsonl   (+ agent-<id>.meta.json)
//
// The records look like the main transcript's (isSidechain: true). Assistant records carry the model
// and token usage. One API message can be split over several records that share message.id, so
// usage is kept per message id (latest record wins) and summed. This matters because a foreground
// subagent's own messages don't reach the stream-json output at all, so this file is the only
// place its steps show up while it runs. Verified against claude.exe 2.1.281.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { toolDetail } = require('./history');
const { clip } = require('./util');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_STEPS = 400;
const MAX_READ = 8 * 1024 * 1024; // per update, so a huge file is caught up over a few updates

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n');
  return '';
}

// The subagent's transcript, next to the session's own transcript when that's known.
function findFile(sessionId, taskId, sessionFile) {
  if (!ID_RE.test(sessionId || '') || !ID_RE.test(taskId || '')) return null;
  const name = `agent-${taskId}.jsonl`;
  if (sessionFile) {
    const f = path.join(sessionFile.replace(/\.jsonl$/i, ''), 'subagents', name);
    if (fs.existsSync(f)) return f;
  }
  let dirs;
  try { dirs = fs.readdirSync(paths.projectsDir()); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(paths.projectsDir(), d, sessionId, 'subagents', name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

class SubagentLog {
  constructor(sessionId, taskId) {
    this.sessionId = sessionId;
    this.taskId = taskId;
    this._reset();
    this.file = null;
  }

  _reset() {
    this.offset = 0;
    this.usageById = new Map();
    this.steps = [];
    this.toolById = new Map();
    this.toolUses = 0;
    this.model = null;
    this.lastTs = null;
  }

  // Reads whatever was added to the file since the last call. Returns true if anything changed.
  update(sessionFile) {
    if (!this.file) this.file = findFile(this.sessionId, this.taskId, sessionFile);
    if (!this.file) return false;
    let size;
    try { size = fs.statSync(this.file).size; } catch { return false; }
    if (size < this.offset) this._reset(); // rewritten
    if (size === this.offset) return false;
    const len = Math.min(size - this.offset, MAX_READ);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try { fs.readSync(fd, buf, 0, len, this.offset); } finally { fs.closeSync(fd); }
    // Only whole lines: a record still being written is read next time.
    let end = buf.lastIndexOf(0x0a);
    if (end === -1) {
      if (len < MAX_READ) return false;
      end = len - 1; // one enormous line: skip it
    }
    this.offset += end + 1;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      this._record(r);
    }
    return true;
  }

  _record(r) {
    const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) || null : null;
    if (ts) this.lastTs = ts;
    const m = r.message;
    const content = m && Array.isArray(m.content) ? m.content : [];
    if (r.type === 'assistant' && m) {
      if (typeof m.model === 'string' && m.model && !m.model.startsWith('<')) this.model = m.model;
      if (m.usage) this.usageById.set(m.id || r.uuid, m.usage);
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          this._push({ kind: 'text', text: clip(b.text.trim(), 4000), ts });
        } else if (b.type === 'tool_use') {
          this.toolUses++;
          const step = { kind: 'tool', id: b.id || null, name: String(b.name || 'tool'), detail: toolDetail(b.input), ts, result: null, isError: false, doneTs: null };
          this._push(step);
          if (b.id) this.toolById.set(b.id, step);
        }
      }
    } else if (r.type === 'user') {
      for (const b of content) {
        if (!b || b.type !== 'tool_result') continue;
        const step = this.toolById.get(b.tool_use_id);
        if (!step) continue;
        step.result = clip(resultText(b.content).trim(), 600);
        step.isError = b.is_error === true;
        step.doneTs = ts;
        this.toolById.delete(b.tool_use_id);
      }
    }
  }

  _push(step) {
    this.steps.push(step);
    if (this.steps.length > MAX_STEPS) this.steps.splice(0, this.steps.length - MAX_STEPS);
  }

  usage() {
    const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const x of this.usageById.values()) {
      u.input += Number(x.input_tokens) || 0;
      u.output += Number(x.output_tokens) || 0;
      u.cacheRead += Number(x.cache_read_input_tokens) || 0;
      u.cacheWrite += Number(x.cache_creation_input_tokens) || 0;
    }
    u.total = u.input + u.output + u.cacheRead + u.cacheWrite;
    u.calls = this.usageById.size;
    return u;
  }

  // One line for "what is it doing now".
  activity() {
    const s = this.steps[this.steps.length - 1];
    if (!s) return '';
    if (s.kind === 'tool') return clip(`${s.result === null ? 'Running' : 'Ran'} ${s.name}${s.detail ? `: ${s.detail}` : ''}`, 200);
    return clip(s.text.split('\n')[0], 200);
  }
}

module.exports = { SubagentLog, findFile };
