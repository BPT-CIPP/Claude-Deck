'use strict';
// The billing guard: Claude Deck won't start Claude Code sessions that would be charged to an
// Anthropic API account (or a cloud provider) instead of the person's Claude plan, unless they
// turn on "Allow API billing" in Claude Deck Preferences.
//
// Claude Code bills per use when it's given an API key or bearer token (ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, or an apiKeyHelper command), or is switched to a cloud provider
// (CLAUDE_CODE_USE_BEDROCK and the like). These can come from the environment, or from the `env`
// block and apiKeyHelper of its settings: managed (the file, its managed-settings.d folder and the
// registry policy), user, the project's own, and a --settings argument. Names checked against
// claude.exe 2.1.281 (see docs/CLAUDE-CODE-INTERNALS.md). Only names are reported, never values.

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
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
const MANAGED_SETTINGS = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
const REGISTRY_ENV = {
  'your Windows user environment': 'HKCU\\Environment',
  "this PC's environment": 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
};
// Managed settings delivered as policy: a JSON `Settings` value (code.claude.com/docs/en/managed-settings).
const REGISTRY_POLICY = {
  "this PC's Claude Code policy": 'HKLM\\SOFTWARE\\Policies\\ClaudeCode',
  'your Claude Code policy': 'HKCU\\SOFTWARE\\Policies\\ClaudeCode',
};
const REGISTRY_CACHE_MS = 30000;

const isSet = (v) => typeof v === 'string' ? v.trim() !== '' && v.trim() !== '0' && v.trim().toLowerCase() !== 'false' : v !== undefined && v !== null && v !== false;
// Tests only: leave this PC's registry and managed settings out, so they can't trip the guard.
const skipSystem = () => process.env.CLAUDE_DECK_SKIP_SYSTEM_SETTINGS === '1';

// Values under a registry key, by name, from reg.exe's output. A missing key is empty.
const REG_OPTS = { encoding: 'utf8', windowsHide: true, timeout: 5000 };
function parseRegOutput(out) {
  const values = {};
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+REG_\w+\s*(.*)$/);
    if (m) values[m[1].toUpperCase()] = m[2];
  }
  return values;
}

function regValues(key) {
  try { return parseRegOutput(execFileSync('reg.exe', ['query', key], { ...REG_OPTS, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
}

function regValuesAsync(key) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', key], REG_OPTS, (err, stdout) => resolve(err ? null : parseRegOutput(stdout)));
  });
}

function assemble(env, policy) {
  const value = { env: {}, policy: {} };
  for (const [where, names] of Object.entries(env)) if (names) value.env[where] = names;
  for (const [where, values] of Object.entries(policy)) if (values && values.SETTINGS) value.policy[where] = values.SETTINGS;
  return value;
}

// Windows Terminal tabs get Windows' stored environment rather than Claude Deck's, so that's read
// too, along with the policy keys. reg.exe runs four times and the server would wait for it on
// every session start, so only the first read waits (the server does it at start-up); after that
// a reading older than REGISTRY_CACHE_MS is answered from the cache while reg.exe runs again in
// the background. A change in the registry shows up on the read after the next refresh.
let registryCache = null;
let registryRefresh = null;
function readRegistry() {
  if (process.platform !== 'win32' || skipSystem()) return { env: {}, policy: {} };
  if (!registryCache) {
    const env = Object.fromEntries(Object.entries(REGISTRY_ENV).map(([where, key]) => [where, regValues(key)]));
    const policy = Object.fromEntries(Object.entries(REGISTRY_POLICY).map(([where, key]) => [where, regValues(key)]));
    registryCache = { at: Date.now(), value: assemble(env, policy) };
  } else if (Date.now() - registryCache.at >= REGISTRY_CACHE_MS && !registryRefresh) {
    const read = (keys) => Promise.all(Object.entries(keys).map(([where, key]) => regValuesAsync(key).then((v) => [where, v]))).then(Object.fromEntries);
    registryRefresh = Promise.all([read(REGISTRY_ENV), read(REGISTRY_POLICY)])
      .then(([env, policy]) => { registryCache = { at: Date.now(), value: assemble(env, policy) }; })
      .catch(() => {})
      .finally(() => { registryRefresh = null; });
  }
  return registryCache.value;
}
const readRegistryEnv = () => readRegistry().env;
const readRegistryPolicy = () => readRegistry().policy;

function findingsIn(s, where) {
  if (!s || typeof s !== 'object') return [];
  const out = [];
  const env = s.env && typeof s.env === 'object' ? s.env : {};
  for (const name of BILLING_VARS) if (isSet(env[name])) out.push(`${name} in ${where}`);
  if (typeof s.apiKeyHelper === 'string' && s.apiKeyHelper.trim()) out.push(`apiKeyHelper in ${where}`);
  return out;
}

function settingsFindings(file) {
  return findingsIn(readJson(file, null), file);
}

// The managed-settings.d folder next to managed-settings.json: every .json file in it is merged in.
function dropInFindings(managed) {
  const dir = path.join(path.dirname(managed), 'managed-settings.d');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.toLowerCase().endsWith('.json')).sort().flatMap((n) => settingsFindings(path.join(dir, n)));
}

function policyFindings(policy) {
  const out = [];
  for (const [where, text] of Object.entries(policy)) {
    let s = null;
    try { s = JSON.parse(text); } catch { /* Claude Code refuses to start on it anyway */ }
    out.push(...findingsIn(s, where));
  }
  return out;
}

// --settings <file or JSON> loads more settings for that one session. One that can't be read
// can't be checked, so it counts against the session rather than for it.
function settingsArgFindings(args, cwd) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    let value;
    if (args[i] === '--settings') value = args[i + 1];
    else if (args[i].startsWith('--settings=')) value = args[i].slice('--settings='.length);
    else continue;
    const text = typeof value === 'string' ? value.trim() : '';
    let s = null;
    let where = 'the --settings argument';
    if (text.startsWith('{')) {
      try { s = JSON.parse(text); } catch { /* reported below */ }
    } else if (text) {
      where = path.resolve(cwd || '.', text);
      s = readJson(where, null);
    }
    if (!s || typeof s !== 'object') out.push(`settings Claude Deck couldn't read to check in ${where === 'the --settings argument' ? where : `--settings ${where}`}`);
    else out.push(...findingsIn(s, where));
  }
  return out;
}

// Everything that would make a session started in `cwd` (with these extra Claude arguments) bill
// an API account. Without cwd, only what applies everywhere (for the warning banner).
function findApiBilling({ cwd = null, args = [], env = process.env, registry = readRegistryEnv, policy = readRegistryPolicy, claudeDir = paths.claudeDir(), managed = skipSystem() ? null : MANAGED_SETTINGS } = {}) {
  const out = [];
  for (const name of BILLING_VARS) if (isSet(env[name])) out.push(`${name} in Claude Deck's environment`);
  for (const [where, names] of Object.entries(registry())) {
    for (const name of BILLING_VARS) if (isSet(names[name])) out.push(`${name} in ${where}`);
  }
  out.push(...policyFindings(policy()));
  if (managed) out.push(...settingsFindings(managed), ...dropInFindings(managed));
  out.push(...settingsFindings(path.join(claudeDir, 'settings.json')));
  if (cwd) for (const name of ['settings.json', 'settings.local.json']) out.push(...settingsFindings(path.join(cwd, '.claude', name)));
  out.push(...settingsArgFindings(args, cwd));
  return out;
}

// Called before starting any Claude Code session. Refuses unless API billing is allowed.
// args: the Claude arguments the session gets beyond Claude Deck's own (the extra arguments).
function requirePlanBilling(cwd, { args = [], claudeDir } = {}) {
  if (prefsStore.load().allowApiBilling) return;
  const found = findApiBilling({ cwd, args, ...(claudeDir ? { claudeDir } : {}) });
  if (!found.length) return;
  throw new UserError(`Claude Deck didn't start this session, because Claude Code would bill an Anthropic API or cloud account instead of your Claude plan. Found: ${found.join('; ')}. Remove ${found.length === 1 ? 'it' : 'them'} to use your plan, or, only if you're authorized to incur those charges, turn on Allow API billing in Claude Deck Preferences.`, 403);
}

module.exports = { findApiBilling, requirePlanBilling, readRegistryEnv, readRegistryPolicy, BILLING_VARS };
