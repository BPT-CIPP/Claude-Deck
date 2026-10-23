'use strict';
// Parses every JavaScript file in the repo, and Start-ClaudeDeck.ps1 with Windows PowerShell 5.1's
// own parser (the version it must run under). A syntax error in a page script means that part of
// the dashboard silently never loads, which no test would notice.
//
//   node tools/check-syntax.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const skip = new Set(['node_modules', '.git', 'vendor']);

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

const failures = [];
const files = ['src', 'public', 'test', 'tools', '.claude'].filter((d) => fs.existsSync(path.join(root, d))).flatMap((d) => jsFiles(path.join(root, d)));
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) failures.push(`${path.relative(root, f)}\n${r.stderr.trim()}`);
}

// The PowerShell scripts, both run by Windows PowerShell 5.1: the launcher, and the pseudo-console
// host behind terminals in the window.
const scripts = ['Start-ClaudeDeck.ps1', path.join('src', 'pty-host.ps1')];
for (const rel of scripts) {
  const ps1 = path.join(root, rel);
  // Plain ASCII only: Windows PowerShell 5.1 reads a file without a byte-order mark as the system
  // code page, so any other character turns into something else, even in a comment.
  const bytes = fs.readFileSync(ps1);
  const bad = bytes.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d));
  if (bad !== -1) {
    const before = bytes.subarray(0, bad).toString('latin1').split('\n');
    failures.push(`${rel}: line ${before.length}, column ${before[before.length - 1].length + 1} has a character that isn't plain ASCII (byte 0x${bytes[bad].toString(16)}). Windows PowerShell 5.1 would misread it.`);
  }
  if (process.platform !== 'win32') continue;
  const script = `$errs = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${ps1.replace(/'/g, "''")}', [ref]$null, [ref]$errs); foreach ($e in $errs) { 'line ' + $e.Extent.StartLineNumber + ': ' + $e.Message }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (r.error) failures.push(`${rel}: could not run Windows PowerShell (${r.error.message})`);
  // The parser itself not running (Constrained Language Mode on a managed PC can't use it) prints
  // nothing on stdout; that's a check that didn't run, not a pass.
  else if (r.status !== 0 || r.stderr.trim()) failures.push(`${rel}: Windows PowerShell couldn't run its parser, so the script wasn't checked (exit code ${r.status}).\n${r.stderr.trim()}`);
  else if (r.stdout.trim()) failures.push(`${rel} (Windows PowerShell 5.1)\n${r.stdout.trim()}`);
}
const psNote = process.platform === 'win32' ? `${scripts.length} PowerShell scripts parsed with Windows PowerShell` : 'PowerShell scripts skipped (Windows PowerShell is only on Windows)';

if (failures.length) {
  console.error(`Syntax errors:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(`Syntax OK: ${files.length} JavaScript files; ${psNote}.`);
