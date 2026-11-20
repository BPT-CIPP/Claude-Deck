'use strict';
// Moving a folder on disk to the Windows Recycle Bin, for History's Reorganize map (Delete with a
// folder picked). It goes through .NET's own Recycle Bin call
// (Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory with SendToRecycleBin) in Windows
// PowerShell, so it can be restored from the Recycle Bin like any folder deleted in Explorer.
//
// Refused before anything is touched: a drive, a link or junction (removing one through it could
// reach what it points to), any folder that is or holds Windows, Program Files, ProgramData, the
// user's own folder, Claude Code's folder or Claude Deck's (its data and its own files), a folder a
// session is open in, and a folder with a file in use (checked by renaming it and back, which
// Windows refuses while anything inside is open, so the Recycle Bin call never meets a locked file
// and never shows an error box of its own).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const paths = require('./paths');
const { UserError } = require('./util');

const APP_ROOT = path.resolve(__dirname, '..');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const RECYCLE = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:DECK_RECYCLE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')";

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const within = (inner, outer) => inner === outer || inner.startsWith(`${outer}\\`);

// Folders that must never go, nor any folder holding one of them.
function protectedFolders() {
  const env = process.env;
  return [env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, os.homedir(), paths.claudeDir(), paths.dataDir(), APP_ROOT]
    .filter(Boolean)
    .map(norm);
}

// Why this folder can't go to the Recycle Bin, or null when it can. openIn: the folders sessions
// are open in.
function refusal(target, openIn = []) {
  if (typeof target !== 'string' || !path.isAbsolute(target.trim())) return 'Choose a folder from the map.';
  const full = path.resolve(target.trim());
  if (/^[a-z]:$/i.test(norm(full)) || /^\\\\[^\\]+(\\[^\\]+)?$/.test(norm(full))) return `${full} is a whole drive.`;
  let st;
  try { st = fs.lstatSync(full); } catch { return `Folder not found: ${full}`; }
  if (st.isSymbolicLink()) return `${full} is a link to another folder. Remove it in File Explorer instead.`;
  if (!st.isDirectory()) return `${full} isn't a folder.`;
  const me = norm(full);
  const kept = protectedFolders().find((p) => within(p, me));
  if (kept) return kept === me ? `${full} is a folder Windows, Claude Code or Claude Deck needs.` : `${full} holds ${kept}, which Windows, Claude Code or Claude Deck needs.`;
  const busy = openIn.filter(Boolean).map(norm).find((cwd) => within(cwd, me));
  if (busy) return `A session is open in ${busy === me ? 'this folder' : busy}. End or close it first.`;
  return null;
}

// Renames the folder and straight back: Windows refuses while a file inside is open.
function inUse(full) {
  const aside = `${full}.deck-check-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.renameSync(full, aside);
  } catch (err) {
    return err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
  }
  fs.renameSync(aside, full);
  return false;
}

function runRecycle(full) {
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', RECYCLE], { windowsHide: true, timeout: 120000, env: { ...process.env, DECK_RECYCLE_PATH: full } }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split(/\r?\n/)[0] || 'PowerShell failed'));
      else resolve();
    });
  });
}

// Moves the folder (and everything in it) to the Recycle Bin. Returns { recycled: fullPath }.
// run: the Recycle Bin call, replaceable in tests.
async function recycleFolder(target, { openIn = [], run = runRecycle } = {}) {
  const why = refusal(target, openIn);
  if (why) throw new UserError(why, why.startsWith('Folder not found') ? 404 : 409);
  const full = path.resolve(target.trim());
  if (inUse(full)) throw new UserError(`Windows says something in ${full} is in use. Close it and try again.`, 409);
  try {
    await run(full);
  } catch (err) {
    throw new UserError(`Couldn't move ${full} to the Recycle Bin: ${err.message}`, 500);
  }
  if (fs.existsSync(full)) throw new UserError(`${full} is still there: Windows didn't move it to the Recycle Bin.`, 500);
  return { recycled: full };
}

module.exports = { recycleFolder, refusal };
