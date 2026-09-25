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

function candidates(preferred) {
  const list = [];
  if (preferred) list.push({ path: preferred, source: 'preferences' });
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
  for (const c of candidates(preferred)) {
    try {
      if (fs.statSync(c.path).isFile()) return c;
    } catch {
      // try the next one
    }
  }
  return null;
}

function isScript(file) {
  return /\.[cm]?js$/i.test(file);
}

// `claude --version` prints and exits locally; it makes no model request.
function claudeVersion(claudePath) {
  return new Promise((resolve) => {
    const cmd = isScript(claudePath) ? process.execPath : claudePath;
    const args = isScript(claudePath) ? [claudePath, '--version'] : ['--version'];
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

module.exports = { locateClaude, claudeVersion, isScript };
