'use strict';
// Where each conversation is filed in History's folder view. By default that's the folder it was
// started in (its cwd, which is also how Claude Code files it under projects/). A conversation
// dragged into another folder is remembered here, in Claude Deck's own data folder, so Claude
// Code's files are never touched and `claude --resume` still finds it where it always was.
//
//   <dataDir>/history-folders.json   { "<sessionId>": "<folder path>" }

const path = require('path');
const paths = require('./paths');
const { readJson, writeJsonAtomic, UserError } = require('./util');
const { UUID_RE } = require('./history');

const file = () => path.join(paths.dataDir(), 'history-folders.json');

function load() {
  const stored = readJson(file(), {});
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter(([id, folder]) => UUID_RE.test(id) && typeof folder === 'string' && folder.trim()));
}

// Files a conversation under `folder`; null puts it back in the folder it was started in.
function set(sessionId, folder) {
  if (!UUID_RE.test(sessionId || '')) throw new UserError('Invalid session ID.');
  const all = load();
  if (folder === null || folder === undefined || folder === '') {
    delete all[sessionId];
  } else {
    if (typeof folder !== 'string' || !path.isAbsolute(folder.trim())) throw new UserError('Choose a folder from the list.');
    all[sessionId] = folder.trim();
  }
  writeJsonAtomic(file(), all);
  return all;
}

// History's list with each conversation's folder: where it was moved to, else where it was
// started. movedFrom names the starting folder when the two differ.
function annotate(sessions, overrides = load()) {
  return sessions.map((m) => {
    const moved = overrides[m.sessionId] || null;
    const folder = moved || m.cwd || null;
    const movedFrom = moved && (!m.cwd || moved.toLowerCase() !== m.cwd.toLowerCase()) ? m.cwd || null : null;
    return { ...m, folder, movedFrom };
  });
}

// Forgets conversations that are no longer in History (deleted, or their transcript gone).
function prune(sessionIds) {
  const keep = new Set(sessionIds);
  const all = load();
  const next = Object.fromEntries(Object.entries(all).filter(([id]) => keep.has(id)));
  if (Object.keys(next).length !== Object.keys(all).length) writeJsonAtomic(file(), next);
  return next;
}

module.exports = { load, set, annotate, prune };
