#!/usr/bin/env node
'use strict';
// Stop hook: the repo's own checks (npm run verify), run as a gate before a Claude Code session
// can end, rather than as an instruction in CLAUDE.md that a session may or may not follow. CI
// runs the same checks on every pull request, but by then the session that broke something is
// gone and the fix becomes a follow-up commit.
//
// Gated on the working tree: if nothing the checks can judge has changed, it exits at once, so
// answering a question costs nothing. Exit codes are the hook protocol's: 0 = let the turn end,
// 2 = block it and hand the failure back to the session.

const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

let changed = '';
try {
  // Uncommitted work, plus anything committed on this branch but not yet on origin/main.
  changed = execFileSync('git', ['status', '--porcelain'], opts);
  try {
    changed += execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], opts);
  } catch { /* no origin/main locally; the working tree alone still gates */ }
} catch {
  process.exit(0); // not a git checkout
}

const touched = changed
  .split('\n')
  .map((l) => l.replace(/^[ MADRCU?!]{1,2}\s+/, '').trim())
  .filter((p) => /\.(js|json|html|css|ps1)$/i.test(p));
if (!touched.length) process.exit(0);

const steps = [
  ['Syntax', [path.join(root, 'tools', 'check-syntax.js')]],
  ['Tests', ['--test', 'test/*.test.js']],
];
const failures = [];
for (const [label, args] of steps) {
  try {
    execFileSync(process.execPath, args, { ...opts, timeout: 170000 });
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trimEnd();
    // node --test prints every result; keep the failures and the summary.
    const trimmed = label === 'Tests' ? out.split('\n').filter((l) => /^(✖|ℹ (tests|pass|fail))|Error|expected|actual/.test(l.trim())).join('\n') : out;
    failures.push(`── ${label} ──\n${trimmed || out}`);
  }
}

if (failures.length) {
  console.error(`The repo's checks fail on the current working tree. Fix them before ending the turn (run \`npm run verify\` to reproduce):\n\n${failures.join('\n\n')}`);
  process.exit(2);
}
process.exit(0);
