'use strict';
// The models Claude Code offers, with their versions ("Sonnet 5.5"), for the model menus.
//
// Claude Code reports them in its initialize response (`models`, see docs/CLAUDE-CODE-INTERNALS.md),
// and it knows about a new model as soon as it's updated. The list is kept in models.json with the
// Claude Code version it came from. Every chat's initialize refreshes it, and when there's none for
// the installed version yet, Claude Code is started once just to ask (no prompt is sent, so no
// model request is made).

const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const { isScript } = require('./claude-locate');
const { requirePlanBilling } = require('./billing');
const { readJson, writeJsonAtomic, clip } = require('./util');

const PROBE_TIMEOUT_MS = 60000;
// Families whose alias also has a 1M-token context variant (the claude.exe 2.1.281 alias table).
const LONG_CONTEXT = ['opus', 'sonnet', 'fable'];

function file() {
  return path.join(paths.dataDir(), 'models.json');
}

// Only what the menus show, from initialize's `models` entries.
function sanitize(models) {
  return (Array.isArray(models) ? models : [])
    .filter((m) => m && typeof m.value === 'string' && m.value)
    .map((m) => ({
      value: clip(m.value, 120),
      resolvedModel: typeof m.resolvedModel === 'string' ? clip(m.resolvedModel, 120) : '',
      displayName: clip(String(m.displayName || m.value), 60),
      description: clip(String(m.description || ''), 200),
    }));
}

function load() {
  const saved = readJson(file(), null);
  return saved && Array.isArray(saved.models) ? { claudeVersion: saved.claudeVersion || null, models: sanitize(saved.models) } : { claudeVersion: null, models: [] };
}

// Keeps the list a Claude Code process reported. Returns true if it changed.
function remember(models, claudeVersion) {
  const list = sanitize(models);
  if (!list.length) return false;
  const before = load();
  if (before.claudeVersion === (claudeVersion || null) && JSON.stringify(before.models) === JSON.stringify(list)) return false;
  writeJsonAtomic(file(), { claudeVersion: claudeVersion || null, models: list, savedAt: Date.now() });
  return true;
}

// The family a model belongs to ("sonnet"), from its alias or its model ID: the display names
// differ between sign-ins ("Sonnet", or "Sonnet 5.5 (1M context)" with an API key).
function familyOf(m) {
  const alias = /^([a-z]+)(\[1m\])?$/.exec(m.value);
  if (alias) return alias[1];
  const id = /^claude-([a-z]+)-/.exec(m.resolvedModel || m.value);
  return id ? id[1] : null;
}

// "Sonnet 5.5", where the model's name or description says it; else the family's name.
function versionName(m, name) {
  const re = new RegExp(`\\b${name} (\\d+(?:\\.\\d+)*)\\b`, 'i');
  const hit = re.exec(m.displayName) || re.exec(m.description);
  return hit ? `${name} ${hit[1]}` : name;
}

// The model menu: a flyout per model family, each listing its variants: first the ones that
// follow the newest version (the alias, its 1M variant, opusplan), then the specific versions
// (pinned: true), named by model ID, newest first as Claude Code lists them.
//   { families: [{ name, version, items: [{ value, label, hint, pinned }] }], extras: [{ value, label, hint }] }
// aliases: the aliases the CLI accepts. Without a list from Claude Code, the families come from
// the aliases alone, without versions.
function menu(models, aliases) {
  const families = [];
  const used = new Set();
  const add = (fam, value, label, hint, pinned = false) => {
    if (!value || used.has(value)) return;
    used.add(value);
    fam.items.push({ value, label, hint, pinned });
  };
  // Group first: a family can be listed more than once (its 1M variant separately, say).
  const groups = new Map();
  for (const m of sanitize(models)) {
    const key = m.value === 'default' ? null : familyOf(m);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const [alias, list] of groups) {
    const name = alias.charAt(0).toUpperCase() + alias.slice(1);
    // The newest one: what the alias points at, else the first listed. Older versions follow it.
    const lead = list.find((m) => m.value.replace(/\[1m\]$/, '') === alias) || list[0];
    const version = [lead, ...list].map((m) => versionName(m, name)).find((v) => v !== name) || name;
    const fam = { name, version, items: [] };
    families.push(fam);
    const pinned = /^claude-/.test(lead.resolvedModel || lead.value) ? (lead.resolvedModel || lead.value).replace(/\[1m\]$/, '') : '';
    const long = LONG_CONTEXT.includes(alias);
    if (aliases.includes(alias)) add(fam, alias, version, `Always the latest ${name}: moves to the next version when Claude Code does (${alias})`);
    if (long && aliases.includes(`${alias}[1m]`)) add(fam, `${alias}[1m]`, `${version} · 1M context`, `The latest ${name} with a 1M-token context window (${alias}[1m])`);
    if (alias === 'opus' && aliases.includes('opusplan')) add(fam, 'opusplan', `${version} for planning`, 'Opus in plan mode, Sonnet otherwise (opusplan)');
    const stays = `stays on this version when a newer ${name} comes out`;
    if (pinned) add(fam, pinned, pinned, `${version}; ${stays}`, true);
    if (pinned && long) add(fam, `${pinned}[1m]`, `${pinned}[1m]`, `${version} with a 1M-token context window; ${stays}`, true);
    for (const m of list) {
      const own = versionName(m, name);
      add(fam, m.value, m.value, [own !== name ? own : '', m.description].filter(Boolean).join(': '), /^claude-/.test(m.value));
    }
  }
  // Aliases Claude Code didn't list a model for (or no list yet): their own family, no version.
  for (const a of aliases) {
    if (used.has(a)) continue;
    const base = a.replace(/\[1m\]$/, '');
    if (base === 'best' || base === 'opusplan') continue;
    const name = base.charAt(0).toUpperCase() + base.slice(1);
    let fam = families.find((f) => f.name.toLowerCase() === base);
    if (!fam) {
      fam = { name, version: '', items: [] };
      families.push(fam);
    }
    add(fam, a, a.endsWith('[1m]') ? `${fam.version || name} · 1M context` : (fam.version || name), a);
  }
  const extras = [];
  if (!used.has('opusplan') && aliases.includes('opusplan')) extras.push({ value: 'opusplan', label: 'Opus plan mode', hint: 'Opus in plan mode, Sonnet otherwise (opusplan)' });
  if (aliases.includes('best')) extras.push({ value: 'best', label: 'Best available', hint: "Claude Code's best alias" });
  return { families, extras };
}

// Starts Claude Code just to read its model list: the initialize handshake, then it's closed.
// No prompt is sent, and MCP servers aren't started (--strict-mcp-config with none given).
// Resolves once that Claude Code has exited, so nothing is left running in the data folder.
function probe(claudePath) {
  return new Promise((resolve) => {
    let found = null;
    let ending = false;
    let proc;
    const finish = (models) => {
      if (models) found = models;
      if (ending) return;
      ending = true;
      clearTimeout(timer);
      try { proc.stdin.end(); } catch { /* gone */ }
      setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 3000).unref();
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    try {
      requirePlanBilling(paths.dataDir());
      const args = ['--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
      const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
      delete env.CLAUDECODE;
      proc = spawn(isScript(claudePath) ? process.execPath : claudePath, isScript(claudePath) ? [claudePath, ...args] : args, { cwd: paths.dataDir(), env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('exit', () => { clearTimeout(timer); resolve(found); });
    proc.stdin.on('error', () => {});
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'control_response' && m.response && m.response.request_id === 'models') finish(m.response.response ? m.response.response.models || null : null);
      }
    });
    proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize', hooks: null } })}\n`);
  });
}

module.exports = { load, remember, menu, probe, sanitize, versionName, familyOf };
