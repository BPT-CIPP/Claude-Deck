'use strict';
// Read and write Claude Code settings and memory files, with a backup before every write.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const { readText, writeFileAtomic, UserError } = require('./util');

const MAX_BACKUPS = 30;

const SCOPES = {
  user: { kind: 'json', label: 'User settings', needsFolder: false, file: () => path.join(paths.claudeDir(), 'settings.json') },
  project: { kind: 'json', label: 'Project settings (shared)', needsFolder: true, file: (f) => path.join(f, '.claude', 'settings.json') },
  local: { kind: 'json', label: 'Project settings (local, not committed)', needsFolder: true, file: (f) => path.join(f, '.claude', 'settings.local.json') },
  'memory-user': { kind: 'text', label: 'User memory (CLAUDE.md)', needsFolder: false, file: () => path.join(paths.claudeDir(), 'CLAUDE.md') },
  'memory-project': { kind: 'text', label: 'Project memory (CLAUDE.md)', needsFolder: true, file: (f) => path.join(f, 'CLAUDE.md') },
};

function resolveTarget(scope, folder) {
  const def = SCOPES[scope];
  if (!def) throw new UserError(`Unknown settings scope: ${scope}`);
  let dir = null;
  if (def.needsFolder) {
    if (!folder || !path.isAbsolute(folder)) throw new UserError('Choose a project folder first.');
    let st;
    try {
      st = fs.statSync(folder);
    } catch {
      throw new UserError(`Folder not found: ${folder}`);
    }
    if (!st.isDirectory()) throw new UserError(`Not a folder: ${folder}`);
    dir = path.resolve(folder);
  }
  return { scope, kind: def.kind, label: def.label, path: def.file(dir), folder: dir };
}

// The file's modification time is taken before and after reading it, and the read is repeated if
// they differ: text read while something else was writing must never be paired with the newer
// time, or saving it later would pass the "changed on disk" check and undo that write.
function read(scope, folder) {
  const t = resolveTarget(scope, folder);
  for (let attempt = 0; ; attempt++) {
    let text = '';
    let exists = false;
    let mtimeMs = null;
    let before = null;
    try {
      before = fs.statSync(t.path);
      text = readText(t.path);
      exists = true;
      mtimeMs = before.mtimeMs;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    let after = null;
    try { after = fs.statSync(t.path); } catch { /* gone */ }
    const steady = before ? Boolean(after) && after.mtimeMs === before.mtimeMs && after.size === before.size : !after;
    if (steady || attempt >= 4) return { ...t, exists, text, mtimeMs: steady ? mtimeMs : -1 };
  }
}

// Keeps the file's own byte-order mark and line endings: the editor works in plain \n text.
function inFileFormat(file, text) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return text; }
  let out = raw.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;
  if (raw.startsWith('﻿') && !out.startsWith('﻿')) out = `﻿${out}`;
  return out;
}

function backupDir(target) {
  const hash = crypto.createHash('sha1').update(target.path.toLowerCase()).digest('hex').slice(0, 10);
  return path.join(paths.dataDir(), 'backups', `${target.scope}-${hash}`);
}

function stampName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backup(target) {
  if (!fs.existsSync(target.path)) return null;
  const dir = backupDir(target);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${stampName()}${path.extname(target.path)}`);
  fs.copyFileSync(target.path, dest);
  fs.writeFileSync(path.join(dir, 'source.txt'), target.path);
  const olds = listBackupFiles(dir);
  for (const old of olds.slice(MAX_BACKUPS)) fs.unlinkSync(path.join(dir, old.name));
  return dest;
}

function listBackupFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n !== 'source.txt');
  } catch {
    return [];
  }
  // Names are ISO timestamps, so they sort chronologically. (copyFileSync keeps the source's
  // mtime on Windows, so file times would give the wrong order.)
  return names
    .sort()
    .reverse()
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      const iso = name.replace(/\.[^.]+$/, '').replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z');
      return { name, size: st.size, savedAt: Date.parse(iso) || null };
    });
}

function validate(target, text) {
  if (typeof text !== 'string') throw new UserError('File content must be text.');
  if (target.kind !== 'json') return;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UserError(`Not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UserError('Settings must be a JSON object.');
}

// baseMtimeMs is the modification time the editor loaded (null: the file didn't exist). If Claude
// Code (or anything else) created, changed or removed the file since, refuse unless force is set,
// so edits are never silently lost.
function refuseIfChanged(scope, folder, baseMtimeMs, force) {
  const current = read(scope, folder);
  if (!force && (baseMtimeMs ?? null) !== current.mtimeMs) {
    throw new UserError('This file changed on disk since you opened it. Reload to see the new version, or save again to overwrite it.', 409);
  }
}

function write(scope, folder, text, baseMtimeMs, force) {
  const target = resolveTarget(scope, folder);
  validate(target, text);
  refuseIfChanged(scope, folder, baseMtimeMs, force);
  const backupPath = backup(target);
  writeFileAtomic(target.path, inFileFormat(target.path, text));
  return { ...read(scope, folder), backupPath };
}

function listBackups(scope, folder) {
  const target = resolveTarget(scope, folder);
  return { path: target.path, backups: listBackupFiles(backupDir(target)) };
}

// Backups are named by the time they were made (see backup()); nothing else in the folder is one.
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(\.[\w]+)?$/;

// Like write: refused if the file changed since the editor loaded it (baseMtimeMs).
function restore(scope, folder, name, baseMtimeMs, force) {
  const target = resolveTarget(scope, folder);
  if (typeof name !== 'string' || !BACKUP_NAME.test(name)) throw new UserError('Invalid backup name.');
  const src = path.join(backupDir(target), name);
  if (!fs.existsSync(src)) throw new UserError('That backup no longer exists.', 404);
  const text = readText(src);
  validate(target, text);
  refuseIfChanged(scope, folder, baseMtimeMs, force);
  const backupPath = backup(target);
  writeFileAtomic(target.path, fs.readFileSync(src)); // the backup's own bytes, BOM and line endings included
  return { ...read(scope, folder), backupPath };
}

module.exports = { SCOPES, resolveTarget, read, write, listBackups, restore };
