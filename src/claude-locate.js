'use strict';
// Find the Claude Code executable. The npm shim (claude.cmd) wraps a native claude.exe, and
// launching that directly lets the tab host know Claude's real pid.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

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

module.exports = { locateClaude, claudeVersion, isScript };
