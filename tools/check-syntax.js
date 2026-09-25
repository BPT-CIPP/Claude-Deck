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

const ps1 = path.join(root, 'Start-ClaudeDeck.ps1');
let psNote = 'Start-ClaudeDeck.ps1 skipped (Windows PowerShell is only on Windows)';
if (process.platform === 'win32') {
  const script = `$errs = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${ps1.replace(/'/g, "''")}', [ref]$null, [ref]$errs); foreach ($e in $errs) { 'line ' + $e.Extent.StartLineNumber + ': ' + $e.Message }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (r.error) failures.push(`Start-ClaudeDeck.ps1: could not run Windows PowerShell (${r.error.message})`);
  else if (r.stdout.trim()) failures.push(`Start-ClaudeDeck.ps1 (Windows PowerShell 5.1)\n${r.stdout.trim()}`);
  psNote = 'Start-ClaudeDeck.ps1 parsed with Windows PowerShell';
}

if (failures.length) {
  console.error(`Syntax errors:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(`Syntax OK: ${files.length} JavaScript files; ${psNote}.`);
