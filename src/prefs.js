'use strict';
// Claude Deck's own preferences (not Claude Code's settings).

const os = require('os');
const path = require('path');
const paths = require('./paths');
const { readJson, writeJsonAtomic, UserError } = require('./util');

const DEFAULTS = Object.freeze({
  claudePath: '',              // empty = detect automatically
  windowMode: 'single',        // 'single': one Windows Terminal window, a tab per session; 'perSession': a window each
  windowName: 'ClaudeDeck',
  wtProfile: '',               // Windows Terminal profile name for new tabs; empty = WT default profile
  defaultFolder: os.homedir(),
  favorites: [],               // pinned folders shown first in the launcher
  presets: [],                 // [{ name, options }] saved launcher configurations
  notifyOnWaiting: true,
  notifyOnFinished: true,
  notifySound: false,
  theme: 'system',             // one of THEMES
  showToolIcons: false,        // an emoji beside each tool call in a chat
  clearChatOnClear: true,      // /clear also empties the chat's messages, as Claude Code clears its screen
  showExternal: true,          // show Claude sessions running outside Claude Deck
  stopWhenClosed: true,        // stop the local server a while after the dashboard window closes
  allowApiBilling: false,      // start sessions that would bill an API or cloud account (src/billing.js)
});

// Each theme is a :root[data-theme] block in public/app.css; labels are in public/app.js.
const THEMES = ['system', 'dark', 'light', 'claude', 'midnight', 'graphite', 'nord', 'dracula', 'forest', 'ocean',
  'solarized-dark', 'high-contrast', 'sepia', 'solarized-light', 'rose'];

const ENUMS = {
  windowMode: ['single', 'perSession'],
  theme: THEMES,
};

function file() {
  return path.join(paths.dataDir(), 'prefs.json');
}

function load() {
  const stored = readJson(file(), {});
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (key in stored && sameType(DEFAULTS[key], stored[key])) out[key] = stored[key];
  }
  return out;
}

function sameType(def, value) {
  if (Array.isArray(def)) return Array.isArray(value);
  return typeof def === typeof value;
}

function save(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new UserError('Preferences must be an object.');
  const next = load();
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new UserError(`Unknown preference: ${key}`);
    if (!sameType(DEFAULTS[key], value)) throw new UserError(`Preference ${key} has the wrong type.`);
    if (ENUMS[key] && !ENUMS[key].includes(value)) throw new UserError(`Preference ${key} must be one of: ${ENUMS[key].join(', ')}`);
    next[key] = value;
  }
  if (!next.windowName.trim()) next.windowName = DEFAULTS.windowName;
  writeJsonAtomic(file(), next);
  return next;
}

module.exports = { DEFAULTS, THEMES, load, save };
