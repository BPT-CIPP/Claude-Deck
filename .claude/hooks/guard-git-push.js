#!/usr/bin/env node
'use strict';
// PreToolUse hook (Bash and PowerShell): refuses a git push to main and any force-push, however
// it's written. The deny rules in .claude/settings.json match command prefixes, so they can't
// catch `git push origin HEAD:main`, `git -C . push`, a bare `git push` while on main, or a `+`
// refspec; this reads the command instead. It also holds in bypass-permissions mode, where the
// deny rules are the only other guard. Exit codes are the hook protocol's: 0 = allow, 2 = block
// and tell the session why.

const { execFileSync } = require('child_process');
const path = require('path');

const MAIN = 'main';

// Splits a command line into simple commands (on && || ; | and newlines), each into words, with
// quotes removed. Good enough for reading git's arguments; it isn't a full shell parser.
function commands(line) {
  const out = [];
  let words = [];
  let word = '';
  let has = false;
  let quote = null;
  const endWord = () => { if (has) words.push(word); word = ''; has = false; };
  const endCommand = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '&' || c === '|' || c === ';' || c === '\n' || c === '\r') { endCommand(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c;
    has = true;
  }
  endCommand();
  return out;
}

// git's own options before the subcommand; these take a value as the next word.
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const PUSH_VALUE_OPTS = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option']);

// Why this git push must not run, or null. currentBranch(dir) names the branch checked out in dir
// (the working folder when dir is null).
function blockReason(line, currentBranch) {
  for (const words of commands(line)) {
    let i = words.findIndex((w) => /(^|[\\/])git(\.exe)?$/i.test(w));
    if (i === -1) continue;
    let dir = null;
    for (i++; i < words.length && words[i].startsWith('-'); i++) {
      if (GIT_VALUE_OPTS.has(words[i])) {
        if (words[i] === '-C') dir = words[i + 1];
        i++;
      }
    }
    if (words[i] !== 'push') continue;
    const positional = [];
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j];
      if (w === '--') { positional.push(...words.slice(j + 1)); break; }
      if (/^--force(-with-lease|-if-includes)?(=|$)/.test(w) || (/^-[^-]/.test(w) && w.slice(1).includes('f'))) {
        return 'Force-pushing is not allowed in this repository. Push a new commit instead (see docs/CONTRIBUTING.md).';
      }
      if (w === '--all' || w === '--mirror' || w === '--branches') return `\`git push ${w}\` would push ${MAIN}, which is only changed through pull requests.`;
      if (PUSH_VALUE_OPTS.has(w)) { j++; continue; }
      if (w.startsWith('-')) continue;
      positional.push(w);
    }
    const refspecs = positional.slice(1);
    if (refspecs.some((r) => r.startsWith('+'))) return 'A `+` refspec force-pushes, which is not allowed in this repository.';
    let branch;
    const onMain = () => {
      if (branch === undefined) branch = currentBranch(dir);
      return branch === MAIN;
    };
    if (!refspecs.length) {
      if (onMain()) return `This pushes ${MAIN}: you're on it. Commit on a feature branch and open a pull request instead (see docs/CONTRIBUTING.md).`;
      continue;
    }
    for (const r of refspecs) {
      const dst = (r.includes(':') ? r.slice(r.indexOf(':') + 1) : r).replace(/^refs\/heads\//, '');
      if (dst === MAIN || ((dst === 'HEAD' || dst === '@') && onMain())) {
        return `This pushes to ${MAIN}, which is only changed through pull requests. Push a feature branch and open one instead (see docs/CONTRIBUTING.md).`;
      }
    }
  }
  return null;
}

function currentBranchIn(base) {
  return (dir) => {
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir ? path.resolve(base, dir) : base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
}

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    let data = {};
    try { data = JSON.parse(input); } catch { process.exit(0); }
    const command = data && data.tool_input && typeof data.tool_input.command === 'string' ? data.tool_input.command : '';
    if (!/\bpush\b/.test(command)) process.exit(0);
    const reason = blockReason(command, currentBranchIn(data.cwd || process.cwd()));
    if (!reason) process.exit(0);
    console.error(reason);
    process.exit(2);
  });
}

module.exports = { blockReason, commands };
