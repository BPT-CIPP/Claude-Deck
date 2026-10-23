'use strict';
// Updating Claude Deck from GitHub, for a copy installed with `git clone`.
//
// Only a copy on main, with no local changes and no commits of its own, is updated: it fetches
// origin/main and fast-forwards to it. Anything else (another branch, edits, a copy made without
// git) is left alone, with a message saying why, so a contributor's working copy is never touched.
//
// The repository is public, so fetching it needs Git and nothing else. If GitHub asks for a
// sign-in anyway (a private fork, or the repository made private again), that goes through the
// GitHub CLI (`gh auth git-credential`) when it's installed, as the only credential helper for
// these calls: no other helper can open a sign-in window from the background server (it would
// open behind the dashboard). A program the update needs and this PC doesn't have is reported as
// err.prerequisite, which the page offers to install (installTool, with winget).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { readJson, clip, UserError } = require('./util');

const ROOT = path.join(__dirname, '..');
const BRANCH = 'main';

// The programs updating can need. Where winget installs them is looked at too: a server started
// before one was installed still has the PATH it started with.
const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files';
const LOCAL_APPS = path.join(process.env.LOCALAPPDATA || '', 'Programs');
const TOOLS = {
  git: { exe: 'git.exe', label: 'Git', winget: 'Git.Git', url: 'https://git-scm.com/download/win', places: [path.join(PROGRAM_FILES, 'Git', 'cmd'), path.join(LOCAL_APPS, 'Git', 'cmd')] },
  gh: { exe: 'gh.exe', label: 'the GitHub CLI', winget: 'GitHub.cli', url: 'https://cli.github.com', places: [path.join(PROGRAM_FILES, 'GitHub CLI'), path.join(LOCAL_APPS, 'GitHub CLI')] },
};

// What git says when GitHub wants a sign-in it didn't get (GIT_TERMINAL_PROMPT=0 keeps it from
// asking), or when the account it got can't see the repository.
const SIGN_IN_RE = /could not read Username|terminal prompts disabled|Authentication failed|Repository not found|returned error: 40[13]/i;

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// The full path of git.exe or gh.exe on this PC, or null.
function locate(name) {
  const tool = TOOLS[name];
  const dirs = [...(process.env.PATH || '').split(path.delimiter).map((d) => d.replace(/^"|"$/g, '')).filter(Boolean), ...tool.places];
  for (const dir of dirs) {
    const p = path.join(dir, tool.exe);
    if (isFile(p)) return p;
  }
  return null;
}

// A program the update needs that this PC doesn't have; the page offers to install it.
function missing(name, message) {
  const err = new UserError(message);
  err.prerequisite = name;
  return err;
}

// Git signs in through the GitHub CLI and nothing else; with no GitHub CLI, through nothing. The
// empty value clears any credential helpers configured elsewhere.
function authArgs(ghPath) {
  return ghPath ? ['-c', 'credential.helper=', '-c', `credential.helper=!'${ghPath}' auth git-credential`] : ['-c', 'credential.helper='];
}

// A refusal that comes with the PowerShell command to update the copy by hand. The command is also
// sent on its own (err.command), so the page can offer to copy it.
function refuse(message, root, steps) {
  const command = `cd '${root.replace(/'/g, "''")}'; ${steps}`;
  const err = new UserError(`${message} To update it yourself, run this in PowerShell: ${command}`);
  err.command = command;
  return err;
}

// Why fetching from GitHub failed, as the error to show: a sign-in GitHub asked for (the GitHub
// CLI to install, or to sign in with), or GitHub out of reach.
function fetchFailure(err, ghPath) {
  const said = `${err.stderr || ''}\n${err.message}`;
  if (SIGN_IN_RE.test(said)) {
    if (!ghPath) {
      return missing('gh', "GitHub asked for a sign-in before it would hand over Claude Deck (the repository isn't public to you), and Claude Deck signs in through the GitHub CLI, which isn't installed. Install it, sign in with gh auth login, then check again.");
    }
    const e = new UserError("GitHub asked for a sign-in before it would hand over Claude Deck (the repository isn't public to you), and the GitHub CLI isn't signed in to an account that can see it. Sign in by running gh auth login in PowerShell, then check again.");
    e.command = 'gh auth login';
    return e;
  }
  return new UserError(`Couldn't get the latest version from GitHub (${clip(err.message, 300)}). Check the internet connection, then try again.`);
}

function makeGit(gitPath) {
  return (root, args, timeout = 60000) => new Promise((resolve, reject) => {
    execFile(gitPath, args, { cwd: root, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(missing('git', "Git isn't installed, and Claude Deck needs it to update itself. Install it, then check again."));
      if (err) return reject(Object.assign(new Error((String(stderr).trim() || err.message).split('\n').filter(Boolean).pop()), { stderr: String(stderr) }));
      resolve(String(stdout).trim());
    });
  });
}

// Checks GitHub for a newer Claude Deck. With apply, also moves this copy to it.
// Returns { updated, available, from, to }: from is this copy's version, to GitHub's.
// find: locate's stand-in, for tests. auth: the sign-in arguments, instead of the GitHub CLI's.
async function checkForUpdates({ apply = false, root = ROOT, auth = null, find = locate } = {}) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    throw new UserError("This copy of Claude Deck wasn't installed with git clone, so it can't update itself. Download the latest version from GitHub instead.");
  }
  const gitPath = find('git');
  if (!gitPath) throw missing('git', "Git isn't installed, and Claude Deck needs it to update itself. Install it, then check again.");
  const git = makeGit(gitPath);
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== BRANCH) {
    throw refuse(`This copy is on the ${branch} branch, not ${BRANCH}, so it isn't updated from here.`, root, `git switch ${BRANCH}; git pull --ff-only`);
  }
  if (await git(root, ['status', '--porcelain', '--untracked-files=no'])) {
    // Set aside, update, then put back.
    throw refuse("This copy has changes of its own, so it isn't updated from here.", root, 'git stash; git pull --ff-only; git stash pop');
  }
  const from = readJson(path.join(root, 'package.json'), {}).version || null;
  const ghPath = auth ? null : find('gh');
  try {
    await git(root, [...(auth || authArgs(ghPath)), 'fetch', '--quiet', 'origin', BRANCH]);
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw fetchFailure(err, ghPath);
  }
  const [head, latest] = await Promise.all([git(root, ['rev-parse', 'HEAD']), git(root, ['rev-parse', 'FETCH_HEAD'])]);
  let to = from;
  try { to = JSON.parse(await git(root, ['show', 'FETCH_HEAD:package.json'])).version || from; } catch { /* keep this copy's */ }
  if (head === latest) return { updated: false, available: false, from, to };
  // Commits here that GitHub doesn't have: leave them be.
  if (!(await isAncestor(git, root, head, latest))) {
    // Puts this copy's own commits on top of GitHub's.
    throw refuse(`This copy has commits that aren't on GitHub's ${BRANCH}, so it isn't updated from here.`, root, `git pull --rebase origin ${BRANCH}`);
  }
  if (!apply) return { updated: false, available: true, from, to };
  try {
    await git(root, ['merge', '--ff-only', '--quiet', 'FETCH_HEAD']);
  } catch (err) {
    // Usually a file that isn't part of this copy (untracked) sits where the update puts one of its
    // own; git lists them indented. Nothing was changed.
    const inTheWay = String(err.stderr || '').split(/\r?\n/).filter((l) => /^\s+\S/.test(l)).map((l) => l.trim());
    const why = inTheWay.length ? `these files are in the way: ${clip(inTheWay.join(', '), 300)}` : clip(err.message, 300);
    throw refuse(`Git couldn't update this copy (${why}), so nothing was changed. Move ${inTheWay.length ? 'them' : 'what it names'} somewhere else and try again.`, root, 'git pull --ff-only');
  }
  return { updated: true, available: true, from, to: readJson(path.join(root, 'package.json'), {}).version || to };
}

async function isAncestor(git, root, a, b) {
  try {
    await git(root, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

// Installs Git or the GitHub CLI with winget (part of Windows' App Installer), only when the person
// chose Install in the page. Both install for every user, so Windows may ask for permission.
// Resolves once it's there: { label, path }.
let installing = null;
function installTool(name, { winget = 'winget.exe', find = locate } = {}) {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) throw new UserError('Claude Deck only installs Git or the GitHub CLI from here.');
  if (find(name)) return Promise.resolve({ label: tool.label, path: find(name) });
  if (installing) throw new UserError('Already installing; wait for it to finish.', 409);
  const args = ['install', '--id', tool.winget, '--exact', '--source', 'winget', '--silent', '--disable-interactivity', '--accept-source-agreements', '--accept-package-agreements'];
  installing = new Promise((resolve, reject) => {
    execFile(winget, args, { windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && err.code === 'ENOENT') return reject(new UserError(`winget isn't available on this PC, so ${tool.label} can't be installed from here. Get it from ${tool.url}, then check again.`));
      const found = find(name);
      if (found) return resolve({ label: tool.label, path: found });
      // winget's last lines say what happened (its progress bars are carriage-return redraws).
      const said = String(stdout || '').split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^[-\\|/█▒\s]+$/.test(l)).slice(-2).join(' ');
      // Otherwise its exit code, an HRESULT (0x8A15... are winget's own).
      const code = err && Number.isInteger(err.code) ? `exit code 0x${(err.code >>> 0).toString(16)}` : '';
      reject(new UserError(`winget didn't install ${tool.label}${said || code ? ` (${clip(said || code, 300)})` : ''}. Get it from ${tool.url}, then check again.`));
    });
  }).finally(() => { installing = null; });
  return installing;
}

module.exports = { checkForUpdates, installTool, locate, authArgs, fetchFailure, TOOLS };
