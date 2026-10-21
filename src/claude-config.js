'use strict';
// Claude Code's /config options, for a chat's Config window.
//
// The list comes from Claude Code itself: "/config" with nothing after it prints every option it
// accepts and their values ("Usage: /config key=value ...", then "  theme=auto|dark|...", one per
// line; "<value>" for free text). Changes go back the same way, "/config key=value", so Claude Code
// writes its own files and checks the value. Claude Deck only reads the files, to show each
// option's current value. See docs/CLAUDE-CODE-INTERNALS.md, "The /config options".

const path = require('path');
const paths = require('./paths');
const { readJson } = require('./util');

// Where each option is stored, and Claude Code's label for it, as seen with 2.1.301 by setting
// every option in a throwaway config folder. scope: user = ~/.claude/settings.json, local = the
// project's .claude/settings.local.json, global = ~/.claude.json. key: a dotted path. Options Claude
// Code adds later still appear (from its own list), just without a current value until added here.
const KNOWN = {
  autoCompact: { label: 'Auto-compact', scope: 'user', key: 'autoCompactEnabled' },
  autoConnectIde: { label: 'Auto-connect to IDE (external terminal)', scope: 'global', key: 'autoConnectIde' },
  autoScroll: { label: 'Auto-scroll', scope: 'user', key: 'autoScrollEnabled' },
  checkpoints: { label: 'Rewind code (checkpoints)', scope: 'user', key: 'fileCheckpointingEnabled' },
  copyFullResponse: { label: 'Skip the /copy picker', scope: 'global', key: 'copyFullResponse' },
  copyOnSelect: { label: 'Copy on select', scope: 'global', key: 'copyOnSelect' },
  defaultToAgentsView: { label: 'Open agents view by default', scope: 'global', key: 'defaultToAgentsView' },
  editor: { label: 'Editor mode', scope: 'user', key: 'editorMode' },
  externalEditorContext: { label: 'Show last response in external editor', scope: 'global', key: 'externalEditorContext' },
  gitignore: { label: 'Respect .gitignore in file picker', scope: 'global', key: 'respectGitignore' },
  language: { label: 'Language', scope: 'user', key: 'language' },
  leftArrowOpensAgents: { label: '← opens agents', scope: 'global', key: 'leftArrowOpensAgents' },
  model: { label: 'Model', scope: 'user', key: 'model' },
  notifChannel: { label: 'Local notifications', scope: 'user', key: 'preferredNotifChannel' },
  outputStyle: { label: 'Output style', scope: 'local', key: 'outputStyle' },
  permissionMode: { label: 'Default permission mode', scope: 'user', key: 'permissions.defaultMode' },
  prStatus: { label: 'Show PR status footer', scope: 'global', key: 'prStatusFooterEnabled' },
  progressBar: { label: 'Terminal progress bar', scope: 'user', key: 'terminalProgressBarEnabled' },
  recap: { label: 'Session recap', scope: 'user', key: 'awaySummaryEnabled' },
  reduceMotion: { label: 'Reduce motion', scope: 'local', key: 'prefersReducedMotion' },
  // Stored as a boolean: true is "Switch automatically".
  switchModelsOnFlag: { label: 'Switch models when a message is flagged', scope: 'user', key: 'switchModelsOnFlag', fromStored: (v) => (v === true ? 'Switch automatically' : v === false ? 'Ask each time' : v) },
  theme: { label: 'Theme', scope: 'user', key: 'theme' },
  // ⚠️ Inferred: Claude Code refused to turn thinking off for Opus 5.5, so where it writes this wasn't seen.
  thinking: { label: 'Thinking mode', scope: 'user', key: 'alwaysThinkingEnabled' },
  timeFormat: { label: 'Time format', scope: 'user', key: 'timeFormat' },
  tips: { label: 'Show tips', scope: 'local', key: 'spinnerTipsEnabled' },
  turnDuration: { label: 'Show turn duration', scope: 'user', key: 'showTurnDuration' },
  useAutoModeDuringPlan: { label: 'Use auto mode during plan', scope: 'user', key: 'useAutoModeDuringPlan' },
  verbose: { label: 'Verbose output', scope: 'user', key: 'verbose' },
  workflowKeywordTriggerEnabled: { label: 'Ultracode keyword trigger', scope: 'user', key: 'workflowKeywordTriggerEnabled' },
  workflowSizeGuideline: { label: 'Dynamic workflow size', scope: 'global', key: 'workflowSizeGuideline' },
  workflows: { label: 'Dynamic workflows', scope: 'user', key: 'enableWorkflows' },
  worktreeBaseRef: { label: 'Worktree base ref', scope: 'user', key: 'worktree.baseRef' },
};

// "/config" with no arguments -> [{ key, values }] (values: null for free text), in Claude Code's
// order. Lines that aren't "key=..." are skipped, so an unexpected reply gives an empty list.
function parseUsage(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s+([A-Za-z][\w]*)=(.*)$/.exec(line);
    if (!m) continue;
    const spec = m[2].trim();
    out.push({ key: m[1], values: spec === '<value>' || !spec ? null : spec.split('|').map((v) => v.trim()).filter(Boolean) });
  }
  return out;
}

function dig(obj, dotted) {
  let v = obj;
  for (const part of dotted.split('.')) {
    if (!v || typeof v !== 'object') return undefined;
    v = v[part];
  }
  return v;
}

// The file each scope is saved in, read once per call. A project's shared .claude/settings.json
// isn't read: /config never writes there, so a value in it would only hide the one just saved.
function readFiles(cwd) {
  return {
    user: readJson(path.join(paths.claudeDir(), 'settings.json'), {}) || {},
    local: cwd ? readJson(path.join(cwd, '.claude', 'settings.local.json'), {}) || {} : {},
    global: readJson(paths.globalConfigFile(), {}) || {},
  };
}

// An option's current value as text (null when not set), from the file /config writes it to, and
// which that is; { value: null, where: null } for an option this copy of Claude Deck doesn't know.
function valueOf(key, files) {
  const def = KNOWN[key];
  if (!def) return { value: null, where: null };
  let value = dig(files[def.scope], def.key);
  if (def.fromStored) value = def.fromStored(value);
  return { value: value === undefined || value === null ? null : String(value), where: def.scope };
}

// The Config window's rows: Claude Code's options with labels, where each is saved, and its current
// value as text (null when not set).
function options(usageText, cwd) {
  const files = readFiles(cwd);
  return parseUsage(usageText).map(({ key, values }) => {
    const def = KNOWN[key];
    return { key, label: def ? def.label : key, values, ...valueOf(key, files) };
  });
}

// The current values of these options: { key: { value, where } }, for reading a change back.
function currentValues(keys, cwd) {
  const files = readFiles(cwd);
  return Object.fromEntries(keys.map((key) => [key, valueOf(key, files)]));
}

// A change as Claude Code's command: "/config key=value". One option per command, since a value can
// hold spaces ("Ask each time") and only the last pair on a line may. Refuses anything that would
// change what the command means: a line break, or a second "key=" that Claude Code would read as
// another option.
function setCommand(key, value) {
  if (!/^[A-Za-z]\w*$/.test(String(key))) throw new Error(`Not a /config option: ${key}`);
  const v = String(value).trim();
  if (!v || /[\r\n]/.test(v)) throw new Error(`Choose a value for ${key}.`);
  if (/\s\S+=/.test(v)) throw new Error(`The value for ${key} can't hold another "name=": Claude Code would read it as a second option.`);
  return `/config ${key}=${v}`;
}

module.exports = { KNOWN, parseUsage, options, currentValues, setCommand };
