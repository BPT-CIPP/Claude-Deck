'use strict';
// Change timeline: the files each turn of a session changed, with diffs, and restoring files to
// how they were before a turn. Built on Claude Code's own file checkpoints (what /rewind uses):
//
//   transcript  file-history-snapshot  { messageId: <prompt uuid>, snapshot.trackedFileBackups:
//                                         { <path>: { backupFileName | null, version, realParentDir } } }
//               file-history-delta     { snapshotMessageId: <prompt uuid>, trackingPath, backup }
//   <claudeDir>/file-history/<sessionId>/<backupFileName>   file contents at that version
//
// A prompt's snapshot holds each tracked file as it was when that prompt was sent; a delta marks a
// file first touched during that prompt's turn (backup null = the file didn't exist yet). So a
// turn's changes are its snapshot vs. the next prompt's snapshot, or vs. the disk for the latest
// turn. Paths inside the session folder are stored relative; realParentDir resolves them.
// Verified against claude.exe 2.1.281. Only changes made with Claude's edit tools are tracked.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const { readJson, writeJsonAtomic, clip, forEachLine, UserError } = require('./util');
const { promptText } = require('./history');

const BACKUP_NAME = /^[A-Za-z0-9._@-]+$/;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_LCS_CELLS = 4_000_000;
const CONTEXT = 3;
const MAX_UNDO = 20;

// Tools whose file changes Claude Code checkpoints, and the input field naming the file.
const EDIT_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

function parseTranscript(file) {
  const prompts = new Map(); // uuid -> { text, ts }
  const snapshots = []; // in transcript order: { messageId, backups }
  const byId = new Map();
  const deltas = new Map(); // snapshotMessageId -> Map(key -> backup)
  const touched = new Map(); // prompt uuid -> Set(lower-case absolute paths edit tools wrote)
  let cwd = null;
  let current = null; // the prompt whose turn the following records belong to
  forEachLine(file, (line) => {
    if (!line.trim()) return;
    let r;
    try { r = JSON.parse(line); } catch { return; }
    if (!cwd && typeof r.cwd === 'string') cwd = r.cwd;
    if (r.type === 'user' && !r.isMeta && !r.isSidechain && r.uuid) {
      const text = promptText(r.message);
      if (text) {
        prompts.set(r.uuid, { text, ts: Date.parse(r.timestamp) || null });
        current = r.uuid;
      }
    } else if (r.type === 'assistant' && current && r.message && Array.isArray(r.message.content)) {
      // Includes subagent (sidechain) calls: they belong to the turn that started them.
      for (const b of r.message.content) {
        const field = b && b.type === 'tool_use' && EDIT_TOOLS[b.name];
        const p = field && b.input && b.input[field];
        if (typeof p !== 'string' || !p) continue;
        if (!touched.has(current)) touched.set(current, new Set());
        touched.get(current).add(path.resolve(r.cwd || cwd || '', p).toLowerCase());
      }
    } else if (r.type === 'file-history-snapshot' && r.snapshot) {
      const backups = r.snapshot.trackedFileBackups || {};
      // Later records for the same prompt update its snapshot.
      if (byId.has(r.messageId)) Object.assign(byId.get(r.messageId).backups, backups);
      else {
        const s = { messageId: r.messageId, backups: { ...backups } };
        byId.set(r.messageId, s);
        snapshots.push(s);
      }
    } else if (r.type === 'file-history-delta' && r.snapshotMessageId && r.trackingPath) {
      if (!deltas.has(r.snapshotMessageId)) deltas.set(r.snapshotMessageId, new Map());
      const m = deltas.get(r.snapshotMessageId);
      if (!m.has(r.trackingPath)) m.set(r.trackingPath, r.backup || { backupFileName: null });
    }
  });
  return { prompts, snapshots, deltas, touched, cwd };
}

function resolveKey(key, backup, cwd) {
  if (path.isAbsolute(key)) return key;
  if (backup && backup.realParentDir) return path.join(backup.realParentDir, path.basename(key));
  return path.join(cwd || '', key);
}

// null content = the file doesn't exist; undefined = unknown (backup missing)
function backupContent(sessionId, backup) {
  if (!backup || backup.backupFileName === null || backup.backupFileName === undefined) return null;
  if (!BACKUP_NAME.test(backup.backupFileName)) return undefined;
  try {
    return fs.readFileSync(path.join(paths.claudeDir(), 'file-history', sessionId, backup.backupFileName));
  } catch {
    return undefined;
  }
}

function diskContent(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    return err.code === 'ENOENT' ? null : undefined;
  }
}

// A file the restore would change but can't read (locked, a folder, no permission) is never
// overwritten blind, and can't be saved for Undo: the restore stops before touching anything.
function readable(file) {
  const now = diskContent(file);
  if (now === undefined) throw new UserError(`Claude Deck can't read ${file} (it may be open in another program, or not a file), so nothing was restored. Close it and try again.`, 409);
  return now;
}

const hashOf = (buf) => (buf === null ? null : crypto.createHash('sha256').update(buf).digest('hex'));

function sameContent(a, b) {
  if (a === null || b === null) return a === b;
  if (a === undefined || b === undefined) return false;
  return a.equals(b);
}

const isBinary = (buf) => Boolean(buf) && buf.subarray(0, 8000).includes(0);
// A final newline ends the last line; it doesn't start an empty one.
const toLines = (buf) => {
  if (!buf || !buf.length) return [];
  const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

// Line diff: trims the common start and end, then a longest-common-subsequence table for the
// middle. Very large middles fall back to "all removed, all added" (correct, just not minimal).
function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push(['=', a[i]]);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_LCS_CELLS || n > 65000 || m > 65000) {
    for (const l of midA) ops.push(['-', l]);
    for (const l of midB) ops.push(['+', l]);
  } else {
    const w = m + 1;
    const t = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = midA[i] === midB[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push(['=', midA[i]]); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { ops.push(['-', midA[i]]); i++; }
      else { ops.push(['+', midB[j]]); j++; }
    }
    for (; i < n; i++) ops.push(['-', midA[i]]);
    for (; j < m; j++) ops.push(['+', midB[j]]);
  }
  for (let i = endA; i < a.length; i++) ops.push(['=', a[i]]);
  return ops;
}

function countOps(ops) {
  let added = 0;
  let removed = 0;
  for (const [op] of ops) { if (op === '+') added++; else if (op === '-') removed++; }
  return { added, removed };
}

// Unified-diff hunks with line numbers, for display.
function toHunks(ops) {
  const rows = [];
  let oldNo = 1;
  let newNo = 1;
  for (const [op, s] of ops) {
    rows.push({ t: op === '=' ? ' ' : op, s, o: op === '+' ? null : oldNo, n: op === '-' ? null : newNo });
    if (op !== '+') oldNo++;
    if (op !== '-') newNo++;
  }
  // Changes closer together than two context blocks share a hunk.
  const hunks = [];
  let start = null;
  let end = null;
  const flush = () => hunks.push({ lines: rows.slice(Math.max(0, start - CONTEXT), Math.min(rows.length, end + CONTEXT + 1)) });
  rows.forEach((r, i) => {
    if (r.t === ' ') return;
    if (start === null) { start = i; end = i; } else if (i - end <= CONTEXT * 2 + 1) end = i; else { flush(); start = i; end = i; }
  });
  if (start !== null) flush();
  return hunks;
}

class Timeline {
  constructor({ history }) {
    this.history = history;
    this.cache = new Map(); // sessionId -> { stamp, data }
    this.counts = new Map(); // hash of a before/after pair -> { added, removed }, so diffs aren't redone
  }

  // Lines added and removed between two versions of a file. The line diff is the slow part of
  // listing a timeline, so its result is kept by content.
  _count(before, after) {
    const key = crypto.createHash('sha256').update(before || '').update('\0').update(after || '').digest('hex');
    let c = this.counts.get(key);
    if (!c) {
      c = countOps(diffLines(toLines(before), toLines(after)));
      this.counts.set(key, c);
      if (this.counts.size > 5000) this.counts.delete(this.counts.keys().next().value);
    }
    return c;
  }

  _file(sessionId) {
    const file = this.history.fileFor(sessionId);
    if (!file) throw new UserError('No transcript found for that session yet.', 404);
    return file;
  }

  _model(sessionId) {
    const file = this._file(sessionId);
    const st = fs.statSync(file);
    const stamp = `${st.size}:${st.mtimeMs}`;
    const hit = this.cache.get(sessionId);
    if (hit && hit.stamp === stamp) return hit.model;
    const parsed = parseTranscript(file);
    // Turns are the prompts that have a snapshot, in order.
    const turns = parsed.snapshots.filter((s) => parsed.prompts.has(s.messageId) || parsed.deltas.has(s.messageId));
    const model = { ...parsed, turns };
    this.cache.set(sessionId, { stamp, model });
    if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value);
    return model;
  }

  // The files one turn changed: [{ key, path, before, after, outside }] with content buffers.
  // Snapshots record file states, not who changed them, so a file only counts as Claude's change
  // when an edit tool wrote it during the turn. A difference with no such edit (a manual change, a
  // restore) is marked `outside`, and left out for the latest turn, which is compared with the disk.
  _turnFiles(sessionId, model, index) {
    const snap = model.turns[index];
    const next = model.turns[index + 1] || null;
    const firstTracked = model.deltas.get(snap.messageId) || new Map();
    const edited = model.touched.get(snap.messageId) || new Set();
    const keys = new Set([...Object.keys(snap.backups), ...firstTracked.keys()]);
    const files = [];
    for (const key of keys) {
      const beforeBackup = key in snap.backups ? snap.backups[key] : firstTracked.get(key);
      const abs = resolveKey(key, beforeBackup, model.cwd);
      const afterBackup = next && next.backups[key];
      if (afterBackup && beforeBackup && afterBackup.backupFileName === beforeBackup.backupFileName && key in snap.backups) continue;
      const before = backupContent(sessionId, beforeBackup);
      const after = afterBackup ? backupContent(sessionId, afterBackup) : next ? undefined : diskContent(abs);
      if (after === undefined && next) continue; // not re-snapshotted: unchanged in this turn
      if (sameContent(before, after)) continue;
      const outside = !edited.has(abs.toLowerCase()) && !firstTracked.has(key);
      if (outside && !next) continue;
      files.push({ key, path: abs, before, after, outside });
    }
    return files.sort((x, y) => x.path.localeCompare(y.path));
  }

  list(sessionId) {
    const model = this._model(sessionId);
    // A turn's row means reading every backup it touched; the model is kept while the transcript
    // is unchanged, so rows are kept with it. The latest turn is compared with the disk, which
    // can change without the transcript, so it's always worked out afresh.
    if (!model.rows) model.rows = new Map();
    const latest = model.turns.length - 1;
    const turns = model.turns.map((snap, i) => {
      if (i !== latest && model.rows.has(i)) return model.rows.get(i);
      const prompt = model.prompts.get(snap.messageId);
      const files = this._turnFiles(sessionId, model, i).map((f) => {
        const binary = isBinary(f.before) || isBinary(f.after);
        const large = !binary && (((f.before && f.before.length) || 0) + ((f.after && f.after.length) || 0) > MAX_DIFF_BYTES);
        const counts = binary || large || f.before === undefined || f.after === undefined ? { added: null, removed: null } : this._count(f.before, f.after);
        const change = f.before === null ? 'created' : f.after === null ? 'deleted' : 'edited';
        return { key: f.key, path: f.path, rel: model.cwd && f.path.toLowerCase().startsWith(model.cwd.toLowerCase() + path.sep) ? path.relative(model.cwd, f.path) : f.path, change, binary, large, outside: f.outside, unknown: f.before === undefined || f.after === undefined, ...counts };
      });
      const row = {
        messageId: snap.messageId,
        prompt: prompt ? clip(prompt.text, 400) : '(prompt not found)',
        ts: prompt ? prompt.ts : null,
        latest: i === latest,
        files,
        added: files.reduce((s, f) => s + (f.added || 0), 0),
        removed: files.reduce((s, f) => s + (f.removed || 0), 0),
      };
      if (i !== latest) model.rows.set(i, row);
      return row;
    });
    return { sessionId, cwd: model.cwd, turns: turns.reverse(), checkpoints: model.snapshots.length > 0 };
  }

  diff(sessionId, messageId, key) {
    const model = this._model(sessionId);
    const index = model.turns.findIndex((t) => t.messageId === messageId);
    if (index === -1) throw new UserError('That turn was not found.', 404);
    const f = this._turnFiles(sessionId, model, index).find((x) => x.key === key);
    if (!f) throw new UserError('That file did not change in this turn.', 404);
    if (f.before === undefined || f.after === undefined) return { path: f.path, unknown: true, hunks: [] };
    if (isBinary(f.before) || isBinary(f.after)) return { path: f.path, binary: true, hunks: [] };
    if (((f.before && f.before.length) || 0) + ((f.after && f.after.length) || 0) > MAX_DIFF_BYTES) return { path: f.path, large: true, hunks: [] };
    const ops = diffLines(toLines(f.before), toLines(f.after));
    return { path: f.path, ...countOps(ops), hunks: toHunks(ops) };
  }

  // What restoring to "before this turn" does: every file tracked from that turn on goes back to
  // its content when the turn's prompt was sent (files that didn't exist yet are deleted).
  plan(sessionId, messageId) {
    const model = this._model(sessionId);
    const index = model.turns.findIndex((t) => t.messageId === messageId);
    if (index === -1) throw new UserError('That turn was not found.', 404);
    const target = new Map(); // key -> backup describing the state before the turn
    for (const [key, b] of Object.entries(model.turns[index].backups)) target.set(key, b);
    for (let i = index; i < model.turns.length; i++) {
      const snap = model.turns[i];
      for (const [key, b] of model.deltas.get(snap.messageId) || []) if (!target.has(key)) target.set(key, b);
      for (const [key, b] of Object.entries(snap.backups)) if (!target.has(key)) target.set(key, b); // tracked later, state at first sight
    }
    const actions = [];
    for (const [key, backup] of target) {
      const abs = resolveKey(key, backup, model.cwd);
      const want = backupContent(sessionId, backup);
      if (want === undefined) continue; // backup missing: leave the file alone
      const now = readable(abs);
      if (sameContent(want, now)) continue;
      actions.push({ path: abs, action: want === null ? 'delete' : now === null ? 'recreate' : 'restore', content: want });
    }
    return actions.sort((x, y) => x.path.localeCompare(y.path));
  }

  // Save the current versions of these files so a restore can be undone.
  saveUndo(sessionId, messageId, filePaths) {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(paths.dataDir(), 'rewinds', id);
    fs.mkdirSync(dir, { recursive: true });
    const files = filePaths.map((p, i) => {
      const now = readable(p);
      if (now) fs.writeFileSync(path.join(dir, `${i}.bin`), now);
      return { path: p, existed: now !== null, blob: now ? `${i}.bin` : null };
    });
    writeJsonAtomic(path.join(dir, 'manifest.json'), { id, sessionId, messageId, at: Date.now(), files });
    // Keep the most recent restores only.
    const root = path.join(paths.dataDir(), 'rewinds');
    const all = fs.readdirSync(root).sort();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_UNDO))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
    return id;
  }

  // After a restore: what each file now holds, so Undo can tell whether it has changed since.
  markRestored(undoId) {
    const file = path.join(paths.dataDir(), 'rewinds', undoId, 'manifest.json');
    const manifest = readJson(file, null);
    if (!manifest) return;
    for (const f of manifest.files) {
      const now = diskContent(f.path);
      f.restored = now === undefined ? undefined : hashOf(now);
    }
    writeJsonAtomic(file, manifest);
  }

  // Restore from the checkpoints directly (used when no Claude process owns the session). If a
  // file can't be written, the ones already restored go back as they were, so nothing is left
  // half restored.
  restore(sessionId, messageId) {
    const actions = this.plan(sessionId, messageId);
    if (!actions.length) return { restored: 0, undoId: null, files: [] };
    const undoId = this.saveUndo(sessionId, messageId, actions.map((a) => a.path));
    const done = [];
    for (const a of actions) {
      try {
        if (a.content === null) fs.rmSync(a.path, { force: true });
        else {
          fs.mkdirSync(path.dirname(a.path), { recursive: true });
          fs.writeFileSync(a.path, a.content);
        }
      } catch (err) {
        this.cache.delete(sessionId);
        try {
          this._putBack(undoId, done);
        } catch {
          throw new UserError(`Couldn't restore ${a.path} (${err.message}), and couldn't put back the files already restored. Their earlier versions are in ${path.join(paths.dataDir(), 'rewinds', undoId)}.`, 409);
        }
        throw new UserError(`Couldn't restore ${a.path} (${err.message}), so nothing was restored. Close anything using it and try again.`, 409);
      }
      done.push(a.path);
    }
    this.markRestored(undoId);
    this.cache.delete(sessionId);
    return { restored: actions.length, undoId, files: actions.map((a) => ({ path: a.path, action: a.action })) };
  }

  // Writes back the saved versions of these files (all of them when `only` is omitted), then
  // forgets the saved copy.
  _putBack(undoId, only) {
    const dir = path.join(paths.dataDir(), 'rewinds', undoId);
    const manifest = readJson(path.join(dir, 'manifest.json'), null);
    if (!manifest) throw new UserError('That restore can no longer be undone.', 404);
    const files = only ? manifest.files.filter((f) => only.includes(f.path)) : manifest.files;
    for (const f of files) {
      if (f.existed) {
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        fs.writeFileSync(f.path, fs.readFileSync(path.join(dir, f.blob)));
      } else {
        fs.rmSync(f.path, { force: true });
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    this.cache.delete(manifest.sessionId);
    return manifest;
  }

  // Undo refuses if a restored file has changed since (Claude or someone kept working on it):
  // putting the old version back would throw that work away.
  undo(undoId) {
    if (typeof undoId !== 'string' || !/^[\w-]+$/.test(undoId)) throw new UserError('Invalid undo id.');
    const dir = path.join(paths.dataDir(), 'rewinds', undoId);
    const manifest = readJson(path.join(dir, 'manifest.json'), null);
    if (!manifest) throw new UserError('That restore can no longer be undone.', 404);
    const changed = manifest.files.filter((f) => 'restored' in f && hashOf(diskContent(f.path) ?? null) !== f.restored).map((f) => f.path);
    if (changed.length) {
      throw new UserError(`Undo wasn't done, because ${changed.length === 1 ? `${changed[0]} has` : `${changed.length} files have`} changed since the restore, and undoing would overwrite that. ${changed.length === 1 ? '' : `Changed: ${changed.join(', ')}.`}`.trim(), 409);
    }
    this._putBack(undoId);
    return { restored: manifest.files.length, sessionId: manifest.sessionId };
  }
}

module.exports = { Timeline, diffLines, toHunks, parseTranscript, resolveKey };
