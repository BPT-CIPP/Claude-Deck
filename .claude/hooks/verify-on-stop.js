#!/usr/bin/env node
'use strict';
// Stop hook: the repo's own checks (npm run verify), run as a gate before a Claude Code session
// can end, rather than as an instruction in CLAUDE.md that a session may or may not follow. CI
// runs the same checks on every pull request, but by then the session that broke something is
// gone and the fix becomes a follow-up commit.
//
// Gated on the working tree: if nothing the checks can judge has changed, or this exact tree has
// already passed, it exits at once, so answering a question costs nothing. If it blocked the last
// stop and nothing has changed since, it lets this one through: blocking again can't help. Exit
// codes are the hook protocol's: 0 = let the turn end, 2 = block it and hand the failure back.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 };
// Must finish inside the hook's timeout in .claude/settings.json (600 s), or Claude Code cancels
// it and the turn ends unchecked.
const BUDGET_MS = 540000;
const started = Date.now();
// Where the last result is remembered, per clone: { passed, blocked } tree keys.
const stateFile = path.join(os.tmpdir(), `claude-deck-verify-${crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 10)}.json`);

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* no input; carry on */ }

let changed = '';
let treeKey = '';
try {
  // Uncommitted work (files inside new folders listed one by one), plus anything committed on
  // this branch but not yet on origin/main.
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], opts);
  changed = status;
  try {
    changed += execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], opts);
  } catch { /* no origin/main locally; the working tree alone still gates */ }
  // What the checks would see: the commit, the uncommitted changes, and new files' contents.
  const h = crypto.createHash('sha1').update(execFileSync('git', ['rev-parse', 'HEAD'], opts)).update(status).update(execFileSync('git', ['diff', 'HEAD'], opts));
  for (const line of status.split('\n')) {
    if (!line.startsWith('?? ')) continue;
    try { h.update(fs.readFileSync(path.join(root, line.slice(3).trim()))); } catch { /* gone or a folder */ }
  }
  treeKey = h.digest('hex');
} catch {
  process.exit(0); // not a git checkout
}

const touched = changed
  .split('\n')
  .map((l) => l.replace(/^[ MADRCU?!]{1,2}\s+/, '').trim())
  .filter((p) => /\.(js|json|html|css|ps1)$/i.test(p));
if (!touched.length) process.exit(0);

let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
if (state.passed === treeKey) process.exit(0);
if (input.stop_hook_active === true && state.blocked === treeKey) {
  console.error('The checks still fail, and nothing changed since they last blocked the turn, so it ends anyway. Run `npm run verify` to see the failures.');
  process.exit(0);
}
const remember = (patch) => { try { fs.writeFileSync(stateFile, JSON.stringify({ ...state, ...patch })); } catch { /* only an optimization */ } };

const steps = [
  ['Syntax', [path.join(root, 'tools', 'check-syntax.js')]],
  ['Changelog', [path.join(root, 'tools', 'changelog.js'), 'check']],
  ['Tests', ['--test', 'test/*.test.js']],
];
const failures = [];
for (const [label, args] of steps) {
  const left = BUDGET_MS - (Date.now() - started);
  if (left <= 0) { failures.push(`── ${label} ──\nNot run: the checks took longer than the hook allows.`); break; }
  try {
    execFileSync(process.execPath, args, { ...opts, timeout: left });
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trimEnd();
    // node --test prints every result; keep the failures and the summary.
    const trimmed = label === 'Tests' ? out.split('\n').filter((l) => /^(✖|ℹ (tests|pass|fail))|Error|expected|actual/.test(l.trim())).join('\n') : out;
    failures.push(`── ${label} ──\n${trimmed || out || (e.signal ? `Stopped after running out of time (${e.signal}).` : e.message)}`);
  }
}

if (failures.length) {
  remember({ blocked: treeKey });
  console.error(`The repo's checks fail on the current working tree. Fix them before ending the turn (run \`npm run verify\` to reproduce):\n\n${failures.join('\n\n')}`);
  process.exit(2);
}
remember({ passed: treeKey, blocked: null });
process.exit(0);
