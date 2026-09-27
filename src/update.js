'use strict';
// Updating Claude Deck from GitHub, for a copy installed with `git clone`.
//
// Only a copy on main, with no local changes and no commits of its own, is updated: it fetches
// origin/main and fast-forwards to it. Anything else (another branch, edits, a copy made without
// git) is left alone, with a message saying why, so a contributor's working copy is never touched.
//
// Git signs in through the GitHub CLI (`gh auth git-credential`) as the only credential helper for
// these calls, so a private repository works for anyone signed in with `gh auth login`, and no
// other helper can open a sign-in window from the background server (it would open behind the
// dashboard).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { readJson, clip, UserError } = require('./util');

const ROOT = path.join(__dirname, '..');
const BRANCH = 'main';
// The empty value clears any credential helpers configured elsewhere; then gh is the only one.
const GH_AUTH = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

// A refusal that comes with the PowerShell command to update the copy by hand. The command is also
// sent on its own (err.command), so the page can offer to copy it.
function refuse(message, root, steps) {
  const command = `cd '${root.replace(/'/g, "''")}'; ${steps}`;
  const err = new UserError(`${message} To update it yourself, run this in PowerShell: ${command}`);
  err.command = command;
  return err;
}

function git(root, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(new UserError('Git is not installed, so Claude Deck cannot update itself. Install Git for Windows, then try again.'));
      if (err) return reject(new Error((String(stderr).trim() || err.message).split('\n').filter(Boolean).pop()));
      resolve(String(stdout).trim());
    });
  });
}

// Checks GitHub for a newer Claude Deck. With apply, also moves this copy to it.
// Returns { updated, available, from, to }: from is this copy's version, to GitHub's.
async function checkForUpdates({ apply = false, root = ROOT, auth = GH_AUTH } = {}) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    throw new UserError("This copy of Claude Deck wasn't installed with git clone, so it can't update itself. Download the latest version from GitHub instead.");
  }
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== BRANCH) {
    throw refuse(`This copy is on the ${branch} branch, not ${BRANCH}, so it isn't updated from here.`, root, `git switch ${BRANCH}; git pull --ff-only`);
  }
  if (await git(root, ['status', '--porcelain', '--untracked-files=no'])) {
    // Set aside, update, then put back.
    throw refuse("This copy has changes of its own, so it isn't updated from here.", root, 'git stash; git pull --ff-only; git stash pop');
  }
  const from = readJson(path.join(root, 'package.json'), {}).version || null;
  try {
    await git(root, [...auth, 'fetch', '--quiet', 'origin', BRANCH]);
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`Couldn't get the latest version from GitHub (${clip(err.message, 300)}). Check that the GitHub CLI is installed and signed in: run gh auth status.`);
  }
  const [head, latest] = await Promise.all([git(root, ['rev-parse', 'HEAD']), git(root, ['rev-parse', 'FETCH_HEAD'])]);
  let to = from;
  try { to = JSON.parse(await git(root, ['show', 'FETCH_HEAD:package.json'])).version || from; } catch { /* keep this copy's */ }
  if (head === latest) return { updated: false, available: false, from, to };
  // Commits here that GitHub doesn't have: leave them be.
  if (!(await isAncestor(root, head, latest))) {
    // Puts this copy's own commits on top of GitHub's.
    throw refuse(`This copy has commits that aren't on GitHub's ${BRANCH}, so it isn't updated from here.`, root, `git pull --rebase origin ${BRANCH}`);
  }
  if (!apply) return { updated: false, available: true, from, to };
  await git(root, ['merge', '--ff-only', '--quiet', 'FETCH_HEAD']);
  return { updated: true, available: true, from, to: readJson(path.join(root, 'package.json'), {}).version || to };
}

async function isAncestor(root, a, b) {
  try {
    await git(root, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { checkForUpdates, GH_AUTH };
