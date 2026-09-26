'use strict';
// Claude Code plugins and plugin marketplaces, through Claude Code's own CLI (`claude plugin ...`),
// so Claude Code does the installing, the settings writes and its own safety checks. Nothing here
// edits Claude Code's plugin files. Output shapes: docs/CLAUDE-CODE-INTERNALS.md, "Plugins".
//
// Changes use Claude Code's defaults: installs go to user scope, and enable/disable finds the scope
// the plugin was installed in. They apply to every Claude Code session, not just one chat.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const prefsStore = require('./prefs');
const { requireClaude } = require('./launcher');
const { isScript } = require('./claude-locate');
const { readJson, clip, UserError } = require('./util');

// The list is ~2s to produce and rarely changes; it's refetched after any change made here.
const LIST_TTL_MS = 60 * 1000;
// Installs and marketplace updates clone git repositories.
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
// Descriptions are shown in full in the menu's hover card; the official marketplace's longest is ~700.
const DESCRIPTION_MAX = 2000;
// Install refusals that mean "a person has to see this command first", not a failure.
const NEEDS_CONFIRMATION = new Set(['command_source_refused', 'entry_helper_unconfirmed']);

// Values go to Claude Code as arguments (no shell), but one starting with "-" would read as a flag.
function arg(value, what) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new UserError(`Enter a ${what}.`);
  if (v.startsWith('-') || /[\r\n]/.test(v)) throw new UserError(`That isn't a valid ${what}: ${clip(v, 80)}`);
  return v;
}

// The lists print one JSON document; the other commands print one result line, possibly after
// progress lines.
function lastJson(text) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch { /* not a single document */ }
  try { return JSON.parse(t.slice(t.lastIndexOf('\n') + 1)); } catch { return null; }
}

class PluginManager {
  constructor({ run } = {}) {
    // run(args, cwd) -> Promise<{ code, stdout, stderr }>; tests pass a stub.
    this.run = run || runClaude;
    this.cache = new Map(); // cwd -> { at, value }
    this.queue = Promise.resolve();
  }

  // One Claude Code command at a time: they read and write the same settings files.
  _serial(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  _exec(args, cwd) {
    return this._serial(() => this.run(args, cwd));
  }

  async list(cwd, { refresh } = {}) {
    const key = cwd || '';
    const hit = this.cache.get(key);
    if (hit && !refresh && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
    const r = await this._exec(['plugin', 'list', '--available', '--json'], cwd);
    const data = lastJson(r.stdout);
    if (!data || !Array.isArray(data.installed)) throw new UserError(`Couldn't list Claude Code's plugins: ${failure(r)}`, 502);
    const categories = await this._categories(cwd);
    const categoryOf = (name, marketplace) => categories.get(`${name}@${marketplace}`) || null;
    const value = {
      installed: data.installed.map((p) => {
        const meta = readJson(path.join(String(p.installPath || ''), '.claude-plugin', 'plugin.json'), {}) || {};
        const [name, marketplace] = String(p.id).split('@');
        return { id: p.id, name: meta.name || name, marketplace, description: clip(String(meta.description || ''), DESCRIPTION_MAX), category: categoryOf(name, marketplace), version: p.version || null, scope: p.scope || null, enabled: p.enabled === true };
      }).sort((a, b) => a.name.localeCompare(b.name)),
      available: (Array.isArray(data.available) ? data.available : []).map((p) => ({
        id: p.pluginId, name: p.name, marketplace: p.marketplaceName, description: clip(String(p.description || ''), DESCRIPTION_MAX), category: categoryOf(p.name, p.marketplaceName), installCount: p.installCount || null,
      })).filter((p) => p.id).sort((a, b) => a.name.localeCompare(b.name)),
    };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  // Each plugin's category, as its marketplace defines it: `plugins[].category` in the marketplace's
  // own .claude-plugin/marketplace.json (read only). `plugin list` doesn't pass it on. Plugins
  // without one, or a marketplace that can't be read, just have no category.
  async _categories(cwd) {
    const out = new Map();
    const r = await this._exec(['plugin', 'marketplace', 'list', '--json'], cwd);
    const list = lastJson(r.stdout);
    for (const m of Array.isArray(list) ? list : []) {
      if (!m || !m.name || !m.installLocation) continue;
      const catalog = readJson(path.join(String(m.installLocation), '.claude-plugin', 'marketplace.json'), null);
      for (const p of catalog && Array.isArray(catalog.plugins) ? catalog.plugins : []) {
        if (p && typeof p.name === 'string' && typeof p.category === 'string' && p.category.trim()) out.set(`${p.name}@${m.name}`, clip(p.category.trim(), 40));
      }
    }
    return out;
  }

  async setEnabled(id, enabled, cwd) {
    const r = await this._exec(['plugin', enabled ? 'enable' : 'disable', arg(id, 'plugin'), '--json'], cwd);
    this.cache.clear();
    const res = lastJson(r.stdout);
    if (!res || res.outcome !== 'ok') throw new UserError(`Couldn't ${enabled ? 'turn on' : 'turn off'} ${id}: ${res && res.message ? res.message : failure(r)}`);
    return { ok: true };
  }

  // Some marketplaces install a plugin by running a command they declare. Claude Code refuses
  // those until a person has seen the command: the refusal carries it, and installing again with
  // its sha256 (acceptCommand) accepts exactly that command and nothing else.
  async install(id, { acceptCommand, cwd } = {}) {
    const args = ['plugin', 'install', arg(id, 'plugin'), '--json'];
    if (acceptCommand) args.push('--accept-command', arg(acceptCommand, 'command checksum'));
    const r = await this._exec(args, cwd);
    this.cache.clear();
    const res = lastJson(r.stdout);
    if (res && res.outcome === 'ok') return { ok: true, scope: res.scope || null };
    if (res && NEEDS_CONFIRMATION.has(res.failureCode) && res.shownCommand && res.shownCommand.sha256) {
      const c = res.shownCommand;
      return { ok: false, needsConfirmation: true, command: typeof c.command === 'string' ? c.command : JSON.stringify(c.command), sha256: c.sha256, archiveUrl: c.archiveUrl || null };
    }
    throw new UserError(`Couldn't install ${id}: ${res && res.message ? res.message : failure(r)}`);
  }

  async marketplaces() {
    const r = await this._exec(['plugin', 'marketplace', 'list', '--json']);
    const list = lastJson(r.stdout);
    if (!Array.isArray(list)) throw new UserError(`Couldn't list plugin marketplaces: ${failure(r)}`, 502);
    return list.map((m) => ({ name: m.name, source: m.source, location: m.repo || m.url || m.path || null }));
  }

  // `marketplace add/remove/update` have no --json; the exit code says whether it worked.
  async addMarketplace(source) {
    return this._marketplaceCommand(['add', arg(source, 'marketplace (a GitHub owner/repo, a git URL, or a folder)')], "Couldn't add the marketplace");
  }

  async removeMarketplace(name) {
    return this._marketplaceCommand(['remove', arg(name, 'marketplace name')], "Couldn't remove the marketplace");
  }

  async updateMarketplaces(name) {
    return this._marketplaceCommand(name ? ['update', arg(name, 'marketplace name')] : ['update'], "Couldn't update the marketplaces");
  }

  async _marketplaceCommand(args, what) {
    const r = await this._exec(['plugin', 'marketplace', ...args]);
    this.cache.clear();
    if (r.code !== 0) throw new UserError(`${what}: ${failure(r)}`);
    return { ok: true, message: clip(outcome(r.stdout), 300) };
  }
}

// Claude Code prints progress ("Cloning repository…", "Refreshing marketplace cache…") and then the
// outcome after a √ (worked) or × (failed). Only the outcome is worth showing.
function outcome(text) {
  const t = String(text || '');
  const at = Math.max(t.lastIndexOf('√'), t.lastIndexOf('×'));
  return plain(at >= 0 ? t.slice(at + 1) : t);
}

function plain(text) {
  // Claude Code's progress output has spinners and color codes.
  return String(text || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[⠀-⣿√✔✘×]/g, '').replace(/\s+/g, ' ').trim();
}

function failure(r) {
  return clip(outcome(r.stderr) || outcome(r.stdout) || `Claude Code exited with code ${r.code}`, 400);
}

function runClaude(args, cwd) {
  const claude = requireClaude(prefsStore.load());
  const cmd = isScript(claude.path) ? process.execPath : claude.path;
  const argv = isScript(claude.path) ? [claude.path, ...args] : args;
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const dir = cwd && fs.existsSync(cwd) ? cwd : undefined;
  return new Promise((resolve) => {
    execFile(cmd, argv, { cwd: dir, env, windowsHide: true, timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && !stdout ? err.message : '')) });
    });
  });
}

module.exports = { PluginManager, lastJson };
