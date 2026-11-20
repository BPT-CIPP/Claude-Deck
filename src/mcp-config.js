'use strict';
// Claude Code's MCP servers, as configured (not as running: a chat's MCP button shows that).
// Listing reads Claude Code's own files; adding and removing go through Claude Code's own
// commands (`claude mcp add-json`, `claude mcp remove`), so Claude Code writes its files and checks
// what it's given. Nothing here writes Claude Code's files. Layout: docs/CLAUDE-CODE-INTERNALS.md,
// "MCP servers, as configured".
//
//   user     ~/.claude.json  mcpServers                      every project
//   local    ~/.claude.json  projects["C:/path"].mcpServers  one project, just you
//   project  <folder>/.mcp.json  mcpServers                  one project, shared (it's in the repo)
//
// Servers that plugins bring, and claude.ai connectors, aren't configured here and aren't listed.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { runClaude } = require('./plugins');
const { readJson, clip, UserError } = require('./util');

const SCOPES = ['user', 'local', 'project'];
const TYPES = ['stdio', 'http', 'sse'];
// Claude Code's own rule ("Names can only contain letters, numbers, hyphens, and underscores"),
// starting with a letter or digit so a name can't read as a flag.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// A server as the page sees it: what it runs or where it connects, and only the names of its
// environment variables and headers (their values are often keys and tokens).
function describe(name, scope, s) {
  const c = s && typeof s === 'object' ? s : {};
  const type = typeof c.type === 'string' ? c.type : c.url ? 'http' : 'stdio';
  return {
    name,
    scope,
    type,
    command: typeof c.command === 'string' ? c.command : null,
    args: Array.isArray(c.args) ? c.args.filter((a) => typeof a === 'string') : [],
    url: typeof c.url === 'string' ? c.url : null,
    env: c.env && typeof c.env === 'object' ? Object.keys(c.env) : [],
    headers: c.headers && typeof c.headers === 'object' ? Object.keys(c.headers) : [],
  };
}

const entries = (obj, scope) => (obj && typeof obj === 'object' ? Object.entries(obj).map(([n, s]) => describe(n, scope, s)) : []);

// Claude Code keys a project by its folder with forward slashes ("C:/Users/x/app").
function projectEntry(projects, folder) {
  if (!projects || typeof projects !== 'object' || !folder) return null;
  const want = path.resolve(folder).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const key = Object.keys(projects).find((k) => k.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === want);
  return key ? projects[key] : null;
}

function folderOrNull(folder) {
  if (typeof folder !== 'string' || !folder.trim()) return null;
  const full = path.resolve(folder.trim());
  if (!path.isAbsolute(folder.trim())) throw new UserError('Enter a full folder path, like C:\\Projects\\app.');
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new UserError(`Folder not found: ${full}`, 404);
  return full;
}

// The configured servers: user ones always, and with a folder its local and project ones.
function list(folder) {
  const dir = folderOrNull(folder);
  const global = readJson(paths.globalConfigFile(), {}) || {};
  const out = { folder: dir, user: entries(global.mcpServers, 'user'), local: [], project: [] };
  if (dir) {
    const p = projectEntry(global.projects, dir);
    out.local = entries(p && p.mcpServers, 'local');
    const shared = readJson(path.join(dir, '.mcp.json'), {}) || {};
    out.project = entries(shared.mcpServers, 'project');
  }
  return out;
}

function lines(value) {
  return (Array.isArray(value) ? value : String(value || '').split(/\r?\n/)).map((s) => String(s).trim()).filter(Boolean);
}

// The JSON Claude Code's add-json takes, from the Add form's fields. Checks what it can here so the
// message is plain; Claude Code checks the rest.
function serverJson(b) {
  const type = TYPES.includes(b.type) ? b.type : null;
  if (!type) throw new UserError('Choose how the server runs: a command (stdio), HTTP or SSE.');
  if (type === 'stdio') {
    const command = typeof b.command === 'string' ? b.command.trim() : '';
    if (!command || /[\r\n]/.test(command)) throw new UserError('Enter the command that starts the server, for example npx or node.');
    const env = {};
    for (const line of lines(b.env)) {
      const at = line.indexOf('=');
      const key = at > 0 ? line.slice(0, at).trim() : '';
      if (!ENV_KEY_RE.test(key)) throw new UserError(`Environment variables are NAME=value, one per line: ${clip(line, 60)}`);
      env[key] = line.slice(at + 1);
    }
    return { type, command, args: lines(b.args), ...(Object.keys(env).length ? { env } : {}) };
  }
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) throw new UserError('Enter the server\'s URL, starting with https:// (or http:// for one on this PC).');
  const headers = {};
  for (const line of lines(b.headers)) {
    const at = line.indexOf(':');
    const key = at > 0 ? line.slice(0, at).trim() : '';
    if (!HEADER_RE.test(key)) throw new UserError(`Headers are Name: value, one per line: ${clip(line, 60)}`);
    headers[key] = line.slice(at + 1).trim();
  }
  return { type, url, ...(Object.keys(headers).length ? { headers } : {}) };
}

function check(name, scope, folder) {
  if (!NAME_RE.test(typeof name === 'string' ? name : '')) throw new UserError('A server name is letters, numbers, hyphens and underscores (starting with a letter or number).');
  if (!SCOPES.includes(scope)) throw new UserError('Choose where the server goes: every project (user), this project shared, or this project just for you.');
  const dir = folderOrNull(folder);
  if (scope !== 'user' && !dir) throw new UserError('Choose the project folder first.');
  return dir;
}

// Claude Code prints one line saying what it did, or why not.
const said = (r) => clip(String(r.stderr || r.stdout || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim().split(/\r?\n/)[0] || `Claude Code exited with code ${r.code}`, 300);

class McpConfig {
  constructor({ run } = {}) {
    // run(args, cwd) -> Promise<{ code, stdout, stderr }>; tests pass a stub.
    this.run = run || runClaude;
    this.queue = Promise.resolve();
  }

  // One Claude Code command at a time: they read and write the same files.
  _exec(args, cwd) {
    const next = this.queue.then(() => this.run(args, cwd), () => this.run(args, cwd));
    this.queue = next.catch(() => {});
    return next;
  }

  async add(b = {}) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const dir = check(name, b.scope, b.folder);
    const json = JSON.stringify(serverJson(b));
    const r = await this._exec(['mcp', 'add-json', '--scope', b.scope, name, json], dir || undefined);
    if (r.code !== 0) throw new UserError(`Couldn't add ${name}: ${said(r)}`);
    return { ok: true, message: said(r) };
  }

  async remove(b = {}) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const dir = check(name, b.scope, b.folder);
    const r = await this._exec(['mcp', 'remove', '--scope', b.scope, name], dir || undefined);
    if (r.code !== 0) throw new UserError(`Couldn't remove ${name}: ${said(r)}`);
    return { ok: true, message: said(r) };
  }
}

module.exports = { McpConfig, list, serverJson, describe, SCOPES, TYPES };
