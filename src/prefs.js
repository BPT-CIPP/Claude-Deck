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
  fontText: 'default',         // one of FONTS: messages, lists and controls
  fontLabels: 'default',       // one of FONTS: the engraved capitals on plates and labels
  showToolIcons: false,        // an emoji beside each tool call in a chat
  clearChatOnClear: true,      // /clear also empties the chat's messages, as Claude Code clears its screen
  showExternal: true,          // show Claude sessions running outside Claude Deck
  stopWhenClosed: true,        // stop the local server a while after the dashboard window closes
  allowApiBilling: false,      // start sessions that would bill an API or cloud account (src/billing.js)
});

// Each theme is a :root[data-theme] block in public/app.css; labels are in public/app.js.
const THEMES = ['system', 'dark', 'light', 'claude', 'midnight', 'graphite', 'nord', 'dracula', 'forest', 'ocean',
  'solarized-dark', 'high-contrast', 'sepia', 'solarized-light', 'rose'];

// Fonts that ship with Windows, so nothing is downloaded; each id's font stack is FONT_CHOICES in
// public/app.js. 'default' is each role's own (Segoe UI Variable for text, Bahnschrift for labels).
const FONTS = ['default', 'segoe', 'aptos', 'calibri', 'verdana', 'tahoma', 'trebuchet', 'georgia', 'bahnschrift', 'cascadia', 'consolas'];

const ENUMS = {
  windowMode: ['single', 'perSession'],
  theme: THEMES,
  fontText: FONTS,
  fontLabels: FONTS,
};

function file() {
  return path.join(paths.dataDir(), 'prefs.json');
}

// The shape of each list's entries: the page reads them as such (a pinned folder is a path it
// lower-cases; a preset is applied by its options), so anything else is left out.
const ENTRY_OK = {
  favorites: (f) => typeof f === 'string' && f.trim() !== '',
  presets: (p) => Boolean(p) && typeof p === 'object' && typeof p.name === 'string' && p.name.trim() !== '' && Boolean(p.options) && typeof p.options === 'object' && !Array.isArray(p.options),
};

function load() {
  const stored = readJson(file(), {});
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in stored) || !sameType(DEFAULTS[key], stored[key])) continue;
    out[key] = ENTRY_OK[key] ? stored[key].filter(ENTRY_OK[key]) : stored[key];
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
    if (ENTRY_OK[key] && !value.every(ENTRY_OK[key])) throw new UserError(key === 'favorites' ? 'Pinned folders must be paths.' : 'Each preset needs a name and its options.');
    next[key] = value;
  }
  if (!next.windowName.trim()) next.windowName = DEFAULTS.windowName;
  writeJsonAtomic(file(), next);
  return next;
}

module.exports = { DEFAULTS, THEMES, FONTS, load, save };
