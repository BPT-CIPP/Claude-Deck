'use strict';
// Where things live. Functions (not constants) so tests can point them elsewhere via env vars.

const os = require('os');
const path = require('path');

// Claude Code's own config directory. CLAUDE_CONFIG_DIR is honored the same way Claude Code honors it.
function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Claude Code's own state file (sign-in, per-project state, the /config global options): beside
// ~/.claude, or inside CLAUDE_CONFIG_DIR when that's set (seen with 2.1.301). Read only.
function globalConfigFile() {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function projectsDir() {
  return path.join(claudeDir(), 'projects');
}

// Claude Code writes one <pid>.json here per running process, with live status.
function sessionsDir() {
  return path.join(claudeDir(), 'sessions');
}

// Claude Deck's own state: prefs, launch registry, history cache, settings backups.
function dataDir() {
  if (process.env.CLAUDE_DECK_DATA) return process.env.CLAUDE_DECK_DATA;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'ClaudeDeck');
}

function tabsDir() {
  return path.join(dataDir(), 'tabs');
}

module.exports = { claudeDir, globalConfigFile, projectsDir, sessionsDir, dataDir, tabsDir };
