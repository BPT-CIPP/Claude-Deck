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
// Never starting with a dot, so an id can't be . or .. (the trash folder or the data folder).
const ID_RE = /^[\w-][\w.-]{0,119}$/;

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

// Across drives a move is a copy, then removing the original. If the removal fails partway, the
// copy is complete but the original isn't: the error says so (copied), and the copy is kept.
function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    try {
      fs.cpSync(from, to, { recursive: true });
    } catch (copyErr) {
      fs.rmSync(to, { recursive: true, force: true }); // an incomplete copy; the original is untouched
      throw copyErr;
    }
    try {
      fs.rmSync(from, { recursive: true, force: true });
    } catch (rmErr) {
      rmErr.copied = true;
      throw rmErr;
    }
  }
}

// Puts an item back. One whose original was only partly removed (see move) is copied over what's left.
function putBack(it, dir) {
  const src = path.join(dir, it.name);
  if (!it.partial) return move(src, it.from);
  fs.cpSync(src, it.from, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
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
  const record = { sessionId, at: Date.now(), title: meta.title || null, cwd: meta.cwd || null };
  try {
    items.forEach((from, i) => {
      try {
        move(from, path.join(dir, String(i)));
      } catch (err) {
        // Its complete copy is in the trash, so it's one of the moved items (see move).
        if (err.copied) done.push({ from, name: String(i), partial: true });
        throw err;
      }
      done.push({ from, name: String(i) });
    });
  } catch (err) {
    // Put back whatever already moved, so a conversation is never half deleted. Anything that
    // can't be put back stays in the trash with its manifest, never deleted: Undo still works.
    const left = done.reverse().filter((d) => {
      try { putBack(d, dir); return false; } catch { return true; }
    });
    if (left.length) {
      writeJsonAtomic(path.join(dir, 'manifest.json'), { ...record, items: left });
      throw new UserError(`Claude Deck couldn't finish deleting this conversation (${err.message}) or put all of it back. Nothing is lost: what was moved is kept in ${dir}, whose manifest.json lists where each item came from.`, 409);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (inUse(err)) throw new UserError('Windows says a file of this conversation is in use. Close anything using it and try again.', 409);
    throw err;
  }
  writeJsonAtomic(path.join(dir, 'manifest.json'), { ...record, items: done });
  return { trashId, moved: done.length };
}

// Puts a deleted conversation back where it was.
function restore(trashId) {
  if (typeof trashId !== 'string' || !ID_RE.test(trashId)) throw new UserError('Invalid trash ID.');
  const dir = path.join(trashDir(), trashId);
  const manifest = readJson(path.join(dir, 'manifest.json'), null);
  if (!manifest || !Array.isArray(manifest.items)) throw new UserError('That conversation is no longer in the trash.', 404);
  const clash = manifest.items.find((it) => !it.partial && fs.existsSync(it.from));
  if (clash) throw new UserError(`Something already exists at ${clash.from}, so the conversation was not put back.`, 409);
  // The manifest is updated after each item, so if one fails, trying again carries on from there.
  const items = [...manifest.items];
  while (items.length) {
    try {
      putBack(items[0], dir);
    } catch (err) {
      const why = inUse(err) ? 'Windows says a file of it is in use' : err.message;
      throw new UserError(`Only part of the conversation was put back (${why}). Close anything using it, then try Undo again.`, 409);
    }
    items.shift();
    writeJsonAtomic(path.join(dir, 'manifest.json'), { ...manifest, items });
  }
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

// The conversations in the trash, by session id (an Undo brings them back to History).
function trashedSessionIds() {
  let names;
  try { names = fs.readdirSync(trashDir()); } catch { return []; }
  return names.map((name) => { const m = readJson(path.join(trashDir(), name, 'manifest.json'), null); return m && m.sessionId; }).filter((id) => UUID_RE.test(id || ''));
}

module.exports = { trashSession, restore, purgeOld, trashedSessionIds, sessionItems, TRASH_DAYS };
