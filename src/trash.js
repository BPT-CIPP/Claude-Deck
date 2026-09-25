'use strict';
// Deleting a conversation from History. Everything Claude Code keeps for it is moved into Claude
// Deck's trash, so Undo can put it back:
//
//   projects/<project>/<id>.jsonl   the transcript (what History and claude --resume list)
//   projects/<project>/<id>/        tool results and subagent transcripts
//   file-history/<id>/              file checkpoints (the change timeline, /rewind)
//   session-env/<id>/               per-session environment
//
// Trash: <dataDir>/trash/<stamp>-<id>/<n> plus manifest.json recording where each item came from.
// Items older than TRASH_DAYS are removed for good when the server starts. Checked against
// claude.exe 2.1.281's layout. This is the one place Claude Deck removes Claude Code's files, and
// only when the user deletes a conversation that isn't open anywhere.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const { readJson, writeJsonAtomic, UserError } = require('./util');

const TRASH_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[\w.-]{1,120}$/;

const trashDir = () => path.join(paths.dataDir(), 'trash');

// The items that exist for this conversation, given its transcript's path.
function sessionItems(sessionId, transcript) {
  if (!UUID_RE.test(sessionId || '')) throw new UserError('Invalid session ID.');
  const projects = path.resolve(paths.projectsDir());
  const file = path.resolve(transcript);
  // Only ever a transcript directly inside a project folder, named after the session.
  if (path.dirname(path.dirname(file)).toLowerCase() !== projects.toLowerCase() || path.basename(file).toLowerCase() !== `${sessionId}.jsonl`.toLowerCase()) {
    throw new UserError('That transcript is not where Claude Code keeps conversations.');
  }
  const candidates = [
    file,
    path.join(path.dirname(file), sessionId),
    path.join(paths.claudeDir(), 'file-history', sessionId),
    path.join(paths.claudeDir(), 'session-env', sessionId),
  ];
  return candidates.filter((p) => fs.existsSync(p));
}

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function inUse(err) {
  return err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
}

// Moves the conversation to the trash. Returns { trashId, moved }.
function trashSession(sessionId, transcript, meta = {}) {
  const items = sessionItems(sessionId, transcript);
  if (!items.length) throw new UserError('That conversation has no files left to delete.', 404);
  const trashId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}-${sessionId}`;
  const dir = path.join(trashDir(), trashId);
  fs.mkdirSync(dir, { recursive: true });
  const done = [];
  try {
    items.forEach((from, i) => {
      move(from, path.join(dir, String(i)));
      done.push({ from, name: String(i) });
    });
  } catch (err) {
    // Put back whatever already moved, so a conversation is never half deleted.
    for (const d of done.reverse()) {
      try { move(path.join(dir, d.name), d.from); } catch { /* reported below */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (inUse(err)) throw new UserError('Windows says a file of this conversation is in use. Close anything using it and try again.', 409);
    throw err;
  }
  writeJsonAtomic(path.join(dir, 'manifest.json'), { sessionId, at: Date.now(), title: meta.title || null, cwd: meta.cwd || null, items: done });
  return { trashId, moved: done.length };
}

// Puts a deleted conversation back where it was.
function restore(trashId) {
  if (typeof trashId !== 'string' || !ID_RE.test(trashId)) throw new UserError('Invalid trash ID.');
  const dir = path.join(trashDir(), trashId);
  const manifest = readJson(path.join(dir, 'manifest.json'), null);
  if (!manifest || !Array.isArray(manifest.items)) throw new UserError('That conversation is no longer in the trash.', 404);
  const clash = manifest.items.find((it) => fs.existsSync(it.from));
  if (clash) throw new UserError(`Something already exists at ${clash.from}, so the conversation was not put back.`, 409);
  for (const it of manifest.items) move(path.join(dir, it.name), it.from);
  fs.rmSync(dir, { recursive: true, force: true });
  return { sessionId: manifest.sessionId, restored: manifest.items.length };
}

// Removes trashed conversations older than TRASH_DAYS. Returns how many were removed.
function purgeOld(now = Date.now()) {
  let removed = 0;
  let names;
  try { names = fs.readdirSync(trashDir()); } catch { return 0; }
  for (const name of names) {
    const dir = path.join(trashDir(), name);
    const manifest = readJson(path.join(dir, 'manifest.json'), null);
    let at = manifest && manifest.at;
    if (!at) { try { at = fs.statSync(dir).mtimeMs; } catch { continue; } }
    if (now - at > TRASH_DAYS * 86400000) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

module.exports = { trashSession, restore, purgeOld, sessionItems, TRASH_DAYS };
