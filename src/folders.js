'use strict';
// Folder browsing for the in-app folder picker. (A native Windows dialog launched from the
// background server opens behind the dashboard, because Windows won't give it focus.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { UserError } = require('./util');

const MAX_ENTRIES = 3000;
const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const SKIP = new Set(['$recycle.bin', 'system volume information', '$windows.~bt', '$windows.~ws', 'config.msi', 'recovery']);

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function drives() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (isDir(root)) out.push({ name: root, path: root });
  }
  return out;
}

// Shortcuts shown beside the list. OneDrive-redirected Documents/Desktop are included when present.
function places() {
  const home = os.homedir();
  const candidates = [
    ['Home', home],
    ['Desktop', path.join(home, 'Desktop')],
    ['Documents', path.join(home, 'Documents')],
  ];
  for (const env of ['OneDriveCommercial', 'OneDrive']) {
    const root = process.env[env];
    if (!root) continue;
    // "OneDrive - Contoso Ltd" -> "OneDrive", so the three shortcuts stay readable.
    const label = path.basename(root).split(' - ')[0];
    candidates.push([label, root]);
    candidates.push([`${label} Documents`, path.join(root, 'Documents')]);
    candidates.push([`${label} Desktop`, path.join(root, 'Desktop')]);
  }
  const seen = new Set();
  const out = [];
  for (const [name, p] of candidates) {
    const key = p.toLowerCase();
    if (seen.has(key) || !isDir(p)) continue;
    seen.add(key);
    out.push({ name, path: p });
  }
  return out;
}

// Subfolders of `dir`, sorted by name. An empty `dir` lists the drives.
function listDir(dir) {
  if (!dir) return { path: '', parent: null, entries: drives(), places: places() };
  if (!path.isAbsolute(dir)) throw new UserError('Enter a full folder path, like C:\\Projects.');
  const full = path.resolve(dir);
  if (!isDir(full)) throw new UserError(`Folder not found: ${full}`, 404);
  let dirents;
  try {
    dirents = fs.readdirSync(full, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') throw new UserError(`Windows won't let Claude Deck read ${full}.`, 403);
    throw err;
  }
  const entries = [];
  for (const d of dirents) {
    if (SKIP.has(d.name.toLowerCase())) continue;
    const p = path.join(full, d.name);
    // Junctions and symlinks (OneDrive uses them) count if they lead to a folder we can open.
    if (d.isDirectory() || (d.isSymbolicLink() && isDir(p))) entries.push({ name: d.name, path: p });
    if (entries.length >= MAX_ENTRIES) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const parent = path.dirname(full);
  return { path: full, parent: parent === full ? '' : parent, entries, truncated: entries.length >= MAX_ENTRIES };
}

function makeDir(parent, name) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean || clean === '.' || clean === '..') throw new UserError('Enter a folder name.');
  if (INVALID_NAME.test(clean) || RESERVED.test(clean) || /[. ]$/.test(clean)) {
    throw new UserError('Folder names cannot contain < > : " / \\ | ? * or end with a dot or space.');
  }
  if (!parent || !path.isAbsolute(parent) || !isDir(parent)) throw new UserError('Open the folder to create it in first.');
  const target = path.join(path.resolve(parent), clean);
  if (fs.existsSync(target)) throw new UserError(`${clean} already exists here.`, 409);
  fs.mkdirSync(target);
  return { path: target };
}

module.exports = { listDir, makeDir, places, drives };
