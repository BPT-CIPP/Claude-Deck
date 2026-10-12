'use strict';
// Find the Claude Code executable. The npm shim (claude.cmd) wraps a native claude.exe, and
// launching that directly lets the tab host know Claude's real pid.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const paths = require('./paths');

function npmPackageTargets(shimDir) {
  const pkg = path.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code');
  return [path.join(pkg, 'bin', 'claude.exe'), path.join(pkg, 'cli.js')];
}

// A shim (claude.cmd, claude.bat) can't be started without a shell; the program it wraps can.
const isShim = (file) => /\.(cmd|bat)$/i.test(file);

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function candidates(preferred) {
  const list = [];
  if (preferred && isShim(preferred)) {
    for (const target of npmPackageTargets(path.dirname(preferred))) list.push({ path: target, source: 'preferences' });
  } else if (preferred) {
    list.push({ path: preferred, source: 'preferences' });
  }
  // The path set in Preferences is used without looking anything up.
  if (list.some((c) => isFile(c.path))) return list;
  let found = [];
  try {
    found = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    // not on PATH
  }
  for (const hit of found) {
    if (path.extname(hit).toLowerCase() === '.exe') {
      list.push({ path: hit, source: 'PATH' });
    } else {
      for (const target of npmPackageTargets(path.dirname(hit))) list.push({ path: target, source: 'npm global install' });
    }
  }
  list.push({ path: path.join(os.homedir(), '.local', 'bin', 'claude.exe'), source: 'native installer' });
  // The other usual install places, for a Claude Code installed after this server started: its
  // PATH is the one it started with, so where.exe can't see a newly added folder.
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  list.push({ path: path.join(local, 'Microsoft', 'WinGet', 'Links', 'claude.exe'), source: 'winget' });
  for (const target of npmPackageTargets(path.join(roaming, 'npm'))) list.push({ path: target, source: 'npm global install' });
  return list;
}

function locateClaude(preferred) {
  return candidates(preferred).find((c) => isFile(c.path) && !isShim(c.path)) || null;
}

function isScript(file) {
  return /\.[cm]?js$/i.test(file);
}

// `claude --version` prints and exits locally; it makes no model request.
function claudeVersion(claudePath) {
  return new Promise((resolve) => {
    const cmd = isScript(claudePath) ? process.execPath : claudePath;
    const args = isScript(claudePath) ? [claudePath, '--version'] : ['--version'];
    try {
      execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        resolve(err ? null : String(stdout).trim());
      });
    } catch {
      // Some files can't be started at all (Node refuses a .cmd without a shell).
      resolve(null);
    }
  });
}

// Whether Claude Code updates itself: it does unless DISABLE_AUTOUPDATER or DISABLE_UPDATES is set,
// in the environment or in the env of the user's settings.json. autoUpdatesChannel picks "latest"
// (the default) or "stable". Read only.
function autoUpdateStatus({ env = process.env, settingsFile = path.join(paths.claudeDir(), 'settings.json') } = {}) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; } catch { /* none, or unreadable */ }
  const settingsEnv = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const on = (v) => v !== undefined && v !== null && !['', '0', 'false'].includes(String(v).trim().toLowerCase());
  const blockedBy = ['DISABLE_UPDATES', 'DISABLE_AUTOUPDATER'].find((k) => on(env[k]) || on(settingsEnv[k])) || null;
  return { enabled: !blockedBy, blockedBy, channel: settings.autoUpdatesChannel === 'stable' ? 'stable' : 'latest' };
}

// `claude update`: Claude Code checks for a newer version and installs it (its own command, run
// only when the user asks). Resolves { ok, output }.
function runUpdate(claudePath) {
  return new Promise((resolve) => {
    const cmd = isScript(claudePath) ? process.execPath : claudePath;
    const args = isScript(claudePath) ? [claudePath, 'update'] : ['update'];
    const env = { ...process.env };
    delete env.CLAUDECODE;
    try {
      execFile(cmd, args, { env, windowsHide: true, timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, output: `${String(stdout || '')}${String(stderr || '')}`.trim() || (err ? err.message : '') });
      });
    } catch (err) {
      resolve({ ok: false, output: err.message });
    }
  });
}

module.exports = { locateClaude, claudeVersion, isScript, autoUpdateStatus, runUpdate };
