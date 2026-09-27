'use strict';
// Builds Claude Code command lines and opens them as Windows Terminal tabs.
//
// Each tab runs tab-host.js, which starts Claude and reports Claude's pid. The full launch
// (command, args, env) goes through a spec file, so nothing depends on how wt.exe re-quotes
// its command line or splits on ';'.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const paths = require('./paths');
const prefsStore = require('./prefs');
const { locateClaude } = require('./claude-locate');
const { UUID_RE } = require('./history');
const { writeJsonAtomic, parseArgString, isPidAlive, readJson, UserError } = require('./util');
const { requirePlanBilling } = require('./billing');

// Values accepted by the installed CLI (from `claude --help`, v2.1.280).
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const MODES = ['new', 'resume', 'continue'];
const COLORS = ['slate', 'cyan', 'amber', 'sage', 'rose', 'violet', 'sand'];
// Model aliases the CLI accepts (from the claude.exe 2.1.281 alias table). Full model IDs work too.
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable', 'best', 'opus[1m]', 'sonnet[1m]', 'fable[1m]', 'opusplan'];

function cleanString(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Normalize and validate launcher options coming from the dashboard.
function normalizeOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.includes(o.mode) ? o.mode : 'new';
  const out = {
    mode,
    cwd: cleanString(o.cwd, 1000),
    name: cleanString(o.name, 120),
    model: cleanString(o.model, 120),
    effort: EFFORTS.includes(o.effort) ? o.effort : '',
    permissionMode: PERMISSION_MODES.includes(o.permissionMode) ? o.permissionMode : '',
    addDirs: Array.isArray(o.addDirs) ? o.addDirs.map((d) => cleanString(d, 1000)).filter(Boolean) : [],
    worktree: o.worktree === true || (typeof o.worktree === 'string' && o.worktree.trim() !== '') ? (typeof o.worktree === 'string' ? cleanString(o.worktree, 100) : true) : false,
    prompt: typeof o.prompt === 'string' ? o.prompt.slice(0, 20000).trim() : '',
    extraArgs: cleanString(o.extraArgs, 2000),
    resumeId: cleanString(o.resumeId, 64),
    fork: o.fork === true,
    color: COLORS.includes(o.color) ? o.color : 'slate',
  };
  if (/\s/.test(out.model)) throw new UserError('Model names cannot contain spaces.');
  if (mode === 'resume' && !UUID_RE.test(out.resumeId)) throw new UserError('Resume needs a valid session ID.');
  if (mode !== 'new') out.worktree = false;
  return out;
}

// Returns the full argument list plus the subset reused when a finished session is resumed.
function buildClaudeArgs(o, sessionId) {
  const base = [];
  if (o.model) base.push('--model', o.model);
  if (o.effort) base.push('--effort', o.effort);
  if (o.permissionMode) base.push('--permission-mode', o.permissionMode);
  if (o.name) base.push('--name', o.name);
  if (o.extraArgs) base.push(...parseArgString(o.extraArgs));
  // --add-dir is variadic, so it must be followed by another option (never a bare prompt).
  if (o.addDirs.length) base.push('--add-dir', ...o.addDirs);

  const args = [...base];
  if (o.mode === 'resume') {
    args.push('--resume', o.resumeId);
    if (o.fork) args.push('--fork-session');
  } else if (o.mode === 'continue') {
    args.push('--continue');
  } else {
    args.push('--session-id', sessionId);
    if (o.worktree) {
      args.push('--worktree');
      if (typeof o.worktree === 'string') args.push(o.worktree);
    }
  }
  if (o.prompt) args.push('--', o.prompt);
  return { args, baseArgs: base };
}

// How the command looks if typed by hand; shown in the launcher as a preview.
function displayCommand(args) {
  return ['claude', ...args].map((a) => (a === '' || /[\s"&|<>^;]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

// wt.exe treats a bare ';' as a subcommand separator; '\;' passes a literal semicolon.
function wtEscape(arg) {
  return String(arg).replace(/;/g, '\\;');
}

function requireClaude(prefs) {
  const claude = locateClaude(prefs.claudePath);
  if (!claude) throw new UserError('Claude Code was not found. Set its path under Claude Deck Preferences.');
  return claude;
}

function requireFolder(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) throw new UserError('Choose a full folder path to start in.');
  let st;
  try {
    st = fs.statSync(cwd);
  } catch {
    throw new UserError(`Folder not found: ${cwd}`);
  }
  if (!st.isDirectory()) throw new UserError(`Not a folder: ${cwd}`);
}

function tabTitle(o) {
  return o.name || path.basename(o.cwd) || o.cwd;
}

class Launcher {
  constructor({ registry, hostScript }) {
    this.registry = registry;
    this.hostScript = hostScript || path.join(__dirname, 'tab-host.js');
  }

  launch(rawOptions) {
    const o = normalizeOptions(rawOptions);
    const prefs = prefsStore.load();
    const claude = requireClaude(prefs);
    requireFolder(o.cwd);
    requirePlanBilling(o.cwd);

    const id = crypto.randomUUID();
    const sessionId = o.mode === 'new' ? crypto.randomUUID() : null;
    const { args, baseArgs } = buildClaudeArgs(o, sessionId);
    const env = {};
    // Tabs get Windows Terminal's environment, not ours, so pass through what matters.
    if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

    const expectedSessionId = sessionId || (o.mode === 'resume' && !o.fork ? o.resumeId : null);
    const spec = {
      id,
      command: claude.path,
      args,
      baseArgs,
      cwd: o.cwd,
      env,
      claudeDir: paths.claudeDir(),
      expectedSessionId,
      createdAt: Date.now(),
    };
    const specPath = path.join(paths.tabsDir(), `${id}.spec.json`);
    writeJsonAtomic(specPath, spec);

    const windowName = prefs.windowMode === 'perSession' ? `ClaudeDeck-${id.slice(0, 8)}` : prefs.windowName;
    const wtArgs = ['-w', windowName, 'new-tab'];
    if (prefs.wtProfile) wtArgs.push('-p', prefs.wtProfile);
    wtArgs.push('--title', tabTitle(o), '-d', o.cwd, process.execPath, this.hostScript, specPath);

    const entry = {
      id,
      name: o.name,
      title: tabTitle(o),
      cwd: o.cwd,
      color: o.color,
      windowName,
      launchedAt: Date.now(),
      expectedSessionId,
      mode: o.mode,
      command: displayCommand(args),
      options: { ...o, prompt: '', mode: 'new', resumeId: '', fork: false },
    };
    this.registry.add(entry);
    this._wt(wtArgs, (err) => {
      this.registry.update(id, { launchError: `Windows Terminal could not be started: ${err.message}` });
    });
    return entry;
  }

  // Bring a session's tab to the front. Tabs in the shared window are indexed in launch order.
  focus(id) {
    const entry = this.registry.get(id);
    if (!entry) throw new UserError('That session is no longer tracked.', 404);
    const siblings = this.registry.all().filter((e) => e.windowName === entry.windowName && !e.launchError && !e.failed);
    const index = Math.max(0, siblings.findIndex((e) => e.id === id));
    this._wt(['-w', entry.windowName, 'focus-tab', '-t', String(index)]);
    return { index };
  }

  // End Claude in that tab and close the tab.
  close(id) {
    const entry = this.registry.get(id);
    if (!entry) throw new UserError('That session is no longer tracked.', 404);
    const tabs = paths.tabsDir();
    fs.writeFileSync(path.join(tabs, `${id}.close`), String(Date.now()));
    const status = readJson(path.join(tabs, `${id}.json`), null);
    if (status && isPidAlive(status.claudePid)) {
      try { process.kill(status.claudePid); } catch { /* already exiting */ }
    }
    if (!status || !isPidAlive(status.hostPid)) this.registry.remove(id);
    return { ok: true };
  }

  // Resume in the same tab if its host is waiting after Claude exited; otherwise open a new tab.
  resume(id) {
    const entry = this.registry.get(id);
    if (!entry) throw new UserError('That session is no longer tracked.', 404);
    requirePlanBilling(entry.cwd);
    const status = readJson(path.join(paths.tabsDir(), `${id}.json`), null);
    if (status && status.state === 'exited' && isPidAlive(status.hostPid) && status.sessionId) {
      fs.writeFileSync(path.join(paths.tabsDir(), `${id}.resume`), String(Date.now()));
      return { inPlace: true, entry };
    }
    const sessionId = (status && status.sessionId) || entry.expectedSessionId;
    if (!sessionId) throw new UserError('This session never started a conversation, so there is nothing to resume.');
    const next = this.launch({ ...entry.options, mode: 'resume', resumeId: sessionId, name: entry.name, color: entry.color });
    this.registry.remove(id);
    return { inPlace: false, entry: next };
  }

  _wt(args, onError) {
    const child = spawn('wt.exe', args.map(wtEscape), { detached: true, stdio: 'ignore' });
    child.on('error', (err) => { if (onError) onError(err); });
    child.unref();
  }
}

module.exports = {
  Launcher,
  normalizeOptions,
  buildClaudeArgs,
  displayCommand,
  wtEscape,
  requireClaude,
  requireFolder,
  EFFORTS,
  PERMISSION_MODES,
  COLORS,
  MODEL_ALIASES,
};
