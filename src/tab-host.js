'use strict';
// Runs inside a Windows Terminal tab: starts Claude Code on this console and reports its pid
// and session ID to Claude Deck through <dataDir>/tabs/<id>.json.
//
// Usage: node tab-host.js <path-to-spec.json>

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJson, writeJsonAtomic } = require('./util');
const { isScript } = require('./claude-locate');

const specPath = process.argv[2];
const spec = readJson(specPath, null);
if (!spec || !spec.id) {
  console.error(`Claude Deck: could not read launch spec ${specPath}`);
  process.exit(2);
}

const tabs = path.dirname(specPath);
const statusPath = path.join(tabs, `${spec.id}.json`);
const closeMarker = path.join(tabs, `${spec.id}.close`);
const resumeMarker = path.join(tabs, `${spec.id}.resume`);

const status = {
  id: spec.id,
  hostPid: process.pid,
  claudePid: null,
  state: 'starting',
  sessionId: spec.expectedSessionId || null,
  runs: 0,
  exitCode: null,
  updatedAt: Date.now(),
};

function writeStatus(patch) {
  Object.assign(status, patch, { updatedAt: Date.now() });
  try {
    writeJsonAtomic(statusPath, status);
  } catch {
    // the dashboard also detects a dead host by pid, so a missed write is recoverable
  }
}

function removeMarkers() {
  for (const f of [closeMarker, resumeMarker]) {
    try { fs.unlinkSync(f); } catch { /* not present */ }
  }
}

// Ctrl+C / Ctrl+Break reach every process on the console. Claude handles them; the host must not die.
process.on('SIGINT', () => {});
process.on('SIGBREAK', () => {});
// Closing the tab sends SIGHUP; record it before Windows ends the process.
process.on('SIGHUP', () => {
  writeStatus({ state: 'closed' });
  process.exit(0);
});

// Claude records its session ID in <claudeDir>/sessions/<pid>.json. It can change mid-run
// (for example after /clear), so keep the latest one for resuming.
function learnSessionId(pid) {
  const rec = readJson(path.join(spec.claudeDir, 'sessions', `${pid}.json`), null);
  if (rec && typeof rec.sessionId === 'string' && rec.sessionId !== status.sessionId) writeStatus({ sessionId: rec.sessionId });
}

function run(args) {
  const cmd = isScript(spec.command) ? process.execPath : spec.command;
  const argv = isScript(spec.command) ? [spec.command, ...args] : args;
  let child;
  try {
    child = spawn(cmd, argv, {
      cwd: spec.cwd,
      stdio: 'inherit',
      env: { ...process.env, ...(spec.env || {}), CLAUDE_DECK_TAB: spec.id },
    });
  } catch (err) {
    process.stdout.write(`\nClaude Deck could not start Claude Code: ${err.message}\n`);
    afterExit(null);
    return;
  }
  let exited = false;
  let poll = null;
  child.on('error', (err) => {
    clearInterval(poll);
    if (exited) return;
    exited = true;
    process.stdout.write(`\nClaude Deck could not start Claude Code: ${err.message}\n`);
    afterExit(null);
  });
  writeStatus({ state: 'running', claudePid: child.pid || null, runs: status.runs + 1, exitCode: null });
  poll = setInterval(() => learnSessionId(child.pid), 2000);
  child.on('exit', (code) => {
    clearInterval(poll);
    if (exited) return;
    exited = true;
    learnSessionId(child.pid);
    afterExit(code);
  });
}

function resetTerminal() {
  // Leave the alternate screen and turn off mouse tracking / bracketed paste in case Claude didn't.
  process.stdout.write('\x1b[?1049l\x1b[?25h\x1b[0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l');
}

function afterExit(code) {
  if (fs.existsSync(closeMarker)) return finish();
  resetTerminal();
  writeStatus({ state: 'exited', exitCode: code, claudePid: null });
  const canResume = Boolean(status.sessionId);
  const how = code === null ? '' : ` (exit code ${code})`;
  process.stdout.write(`\n\x1b[2mClaude Code ended${how}.\x1b[0m\n`);
  process.stdout.write(canResume
    ? 'Press \x1b[1mR\x1b[0m to resume this conversation here, or \x1b[1mX\x1b[0m to close the tab.\n'
    : 'Press \x1b[1mX\x1b[0m to close the tab.\n');
  waitForChoice(canResume);
}

// choice.exe reads one key from the console. Node's own console reader is avoided here because
// it can hold a pending read that swallows the first key meant for the next Claude run.
function waitForChoice(canResume) {
  const keys = canResume ? 'RX' : 'X';
  const chooser = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'choice.exe'), ['/C', keys, '/N'], { stdio: 'inherit' });
  let decided = false;
  const decide = (what) => {
    if (decided) return;
    decided = true;
    clearInterval(markerPoll);
    try { chooser.kill(); } catch { /* already exited */ }
    if (what === 'resume') {
      removeMarkers();
      const refused = billingRefusal();
      if (refused) {
        process.stdout.write(`\n${refused}\n`);
        afterExit(null);
        return;
      }
      process.stdout.write('\nResuming…\n');
      run([...spec.baseArgs, '--resume', status.sessionId]);
    } else {
      finish();
    }
  };
  // The dashboard can also resume or close this tab by dropping a marker file.
  const markerPoll = setInterval(() => {
    if (fs.existsSync(closeMarker)) decide('close');
    else if (canResume && fs.existsSync(resumeMarker)) decide('resume');
  }, 400);
  chooser.on('exit', (code) => {
    if (code === null) return; // killed by decide()
    decide(canResume && code === 1 ? 'resume' : 'close');
  });
  chooser.on('error', () => decide('close'));
}

// Resuming here starts Claude Code again, so it gets the same billing check as any other start
// (settings may have changed since the tab opened). This process has Windows Terminal's
// environment, not the server's, so it's pointed at Claude Deck's data folder (where the tabs
// folder is) for the Allow API billing preference.
function billingRefusal() {
  process.env.CLAUDE_DECK_DATA = path.dirname(tabs);
  try {
    require('./billing').requirePlanBilling(spec.cwd, { args: spec.extraArgs || [], claudeDir: spec.claudeDir });
    return null;
  } catch (err) {
    return err.message;
  }
}

function finish() {
  removeMarkers();
  writeStatus({ state: 'closed', claudePid: null });
  process.exit(0);
}

writeStatus({});
run(spec.args);
