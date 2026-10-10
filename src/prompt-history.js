'use strict';
// Your earlier prompts, for Ctrl+R in a chat's reply box, from the history Claude Code keeps for
// its own Ctrl+R and ↑: ~/.claude/history.jsonl, one { display, pastedContents, timestamp, project,
// sessionId } per prompt, oldest first (docs/CLAUDE-CODE-INTERNALS.md, "Prompt history"). Read only.
//
// A long paste shows in `display` as its placeholder, "[Pasted text #1 +12 lines]". Its text is in
// pastedContents[id].content, or (for bigger ones) in paste-cache/<contentHash>.txt, which Claude
// Code prunes; a paste whose text is gone comes back as null.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const READ_BYTES = 4 * 1024 * 1024; // the newest part of the file is plenty
const MAX_RESULTS = 30;

function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - READ_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // A read that starts mid-file starts mid-line; that first line is dropped.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function pasteText(p, cacheDir) {
  if (!p || typeof p !== 'object' || p.type !== 'text') return null;
  if (typeof p.content === 'string') return p.content;
  if (typeof p.contentHash === 'string' && /^[0-9a-f]{8,64}$/i.test(p.contentHash)) {
    try { return fs.readFileSync(path.join(cacheDir, `${p.contentHash}.txt`), 'utf8'); } catch { return null; }
  }
  return null;
}

const sameFolder = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Newest first, this folder's prompts before the rest, each prompt once.
// Returns [{ text, pastes: { id: text|null }, folder, ts }].
function search(query, cwd, { dir = paths.claudeDir() } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const lines = readTail(path.join(dir, 'history.jsonl')).split('\n');
  const cacheDir = path.join(dir, 'paste-cache');
  const here = [];
  const elsewhere = [];
  const seen = new Set();
  for (let i = lines.length - 1; i >= 0 && here.length + elsewhere.length < MAX_RESULTS * 4; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (!e || typeof e.display !== 'string' || !e.display.trim()) continue;
    const text = e.display;
    if (seen.has(text) || (q && !text.toLowerCase().includes(q))) continue;
    seen.add(text);
    (sameFolder(e.project, cwd) ? here : elsewhere).push(e);
  }
  return [...here, ...elsewhere].slice(0, MAX_RESULTS).map((e) => {
    const pastes = {};
    if (e.pastedContents && typeof e.pastedContents === 'object') {
      for (const [id, p] of Object.entries(e.pastedContents)) {
        if (/^\d+$/.test(id) && p && p.type === 'text') pastes[id] = pasteText(p, cacheDir);
      }
    }
    return { text: e.display, pastes, folder: typeof e.project === 'string' ? e.project : null, ts: Number(e.timestamp) || null };
  });
}

module.exports = { search, MAX_RESULTS };
