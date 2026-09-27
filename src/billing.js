'use strict';
// The billing guard: Claude Deck won't start Claude Code sessions that would be charged to an
// Anthropic API account (or a cloud provider) instead of the person's Claude plan, unless they
// turn on "Allow API billing" in Claude Deck Preferences.
//
// Claude Code bills per use when it's given an API key or bearer token (ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, or an apiKeyHelper command), or is switched to a cloud provider
// (CLAUDE_CODE_USE_BEDROCK and the like). These can come from the environment, or from the `env`
// block and apiKeyHelper of its settings files: managed, user, and the project's own. Names checked
// against claude.exe 2.1.281 (see docs/CLAUDE-CODE-INTERNALS.md). Only names are reported, never
// values.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const paths = require('./paths');
const prefsStore = require('./prefs');
const { readJson, UserError } = require('./util');

// Variables that make Claude Code bill something other than the Claude plan.
const BILLING_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
];
const MANAGED_SETTINGS = path.join('C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
const REGISTRY_ENV = {
  'your Windows user environment': 'HKCU\\Environment',
  "this PC's environment": 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
};
const REGISTRY_CACHE_MS = 30000;

const isSet = (v) => typeof v === 'string' ? v.trim() !== '' && v.trim() !== '0' && v.trim().toLowerCase() !== 'false' : v !== undefined && v !== null && v !== false;

// Windows Terminal tabs get Windows' stored environment rather than Claude Deck's, so that's read
// too, with reg.exe (a Windows built-in). Names only.
let registryCache = null;
function readRegistryEnv() {
  if (process.platform !== 'win32') return {};
  if (registryCache && Date.now() - registryCache.at < REGISTRY_CACHE_MS) return registryCache.value;
  const value = {};
  for (const [where, key] of Object.entries(REGISTRY_ENV)) {
    let out = '';
    try { out = execFileSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { continue; }
    const names = {};
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s+(\S+)\s+REG_\w+\s*(.*)$/);
      if (m) names[m[1].toUpperCase()] = m[2];
    }
    value[where] = names;
  }
  registryCache = { at: Date.now(), value };
  return value;
}

function settingsFindings(file) {
  const s = readJson(file, null);
  if (!s || typeof s !== 'object') return [];
  const out = [];
  const env = s.env && typeof s.env === 'object' ? s.env : {};
  for (const name of BILLING_VARS) if (isSet(env[name])) out.push(`${name} in ${file}`);
  if (typeof s.apiKeyHelper === 'string' && s.apiKeyHelper.trim()) out.push(`apiKeyHelper in ${file}`);
  return out;
}

// Everything that would make a session started in `cwd` bill an API account. Without cwd, only
// what applies everywhere (for the warning banner).
function findApiBilling({ cwd = null, env = process.env, registry = readRegistryEnv, claudeDir = paths.claudeDir(), managed = MANAGED_SETTINGS } = {}) {
  const out = [];
  for (const name of BILLING_VARS) if (isSet(env[name])) out.push(`${name} in Claude Deck's environment`);
  for (const [where, names] of Object.entries(registry())) {
    for (const name of BILLING_VARS) if (isSet(names[name])) out.push(`${name} in ${where}`);
  }
  for (const file of [managed, path.join(claudeDir, 'settings.json')]) out.push(...settingsFindings(file));
  if (cwd) for (const name of ['settings.json', 'settings.local.json']) out.push(...settingsFindings(path.join(cwd, '.claude', name)));
  return out;
}

// Called before starting any Claude Code session. Refuses unless API billing is allowed.
function requirePlanBilling(cwd) {
  if (prefsStore.load().allowApiBilling) return;
  const found = findApiBilling({ cwd });
  if (!found.length) return;
  throw new UserError(`Claude Deck didn't start this session, because Claude Code would bill an Anthropic API or cloud account instead of your Claude plan. Found: ${found.join('; ')}. Remove ${found.length === 1 ? 'it' : 'them'} to use your plan, or, only if you're authorized to incur those charges, turn on Allow API billing in Claude Deck Preferences.`, 403);
}

module.exports = { findApiBilling, requirePlanBilling, readRegistryEnv, BILLING_VARS };
