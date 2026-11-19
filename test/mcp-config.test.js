'use strict';
// src/mcp-config.js: MCP servers as configured, read from Claude Code's files, and added or removed
// through Claude Code's own commands (a stub stands in for claude.exe here).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const mcp = require('../src/mcp-config');

test.after(() => box.cleanup());

const project = path.join(box.root, 'mcp-project');
fs.mkdirSync(project, { recursive: true });

test('lists every scope from where Claude Code keeps it, values of env and headers left out', () => {
  // As Claude Code 2.1.325 writes them: user and local in .claude.json (a project keyed by its
  // folder with forward slashes), project in the folder's .mcp.json.
  fs.writeFileSync(path.join(box.claudeDir, '.claude.json'), JSON.stringify({
    mcpServers: { github: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: 'secret-token' } } },
    projects: { [project.replace(/\\/g, '/').toUpperCase()]: { mcpServers: { mine: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer secret' } } } } },
  }));
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { type: 'sse', url: 'https://example.com/sse' } } }));

  const none = mcp.list('');
  assert.deepStrictEqual(none.user.map((s) => s.name), ['github']);
  assert.deepStrictEqual([none.local, none.project, none.folder], [[], [], null], 'without a folder, only every-project servers');

  const all = mcp.list(project);
  assert.deepStrictEqual(all.user[0], { name: 'github', scope: 'user', type: 'stdio', command: 'npx', args: ['-y', 'server-github'], url: null, env: ['GITHUB_TOKEN'], headers: [] });
  assert.deepStrictEqual(all.local.map((s) => [s.name, s.type, s.url, s.headers]), [['mine', 'http', 'https://example.com/mcp', ['Authorization']]], 'the project key matched whatever its case and slashes');
  assert.deepStrictEqual(all.project.map((s) => [s.name, s.type]), [['shared', 'sse']]);
  assert.ok(!JSON.stringify(all).includes('secret'), 'no env or header value is sent to the page');
  assert.throws(() => mcp.list(path.join(project, 'nope')), /Folder not found/);
});

test("the Add form becomes the JSON Claude Code's add-json takes", () => {
  assert.deepStrictEqual(mcp.serverJson({ type: 'stdio', command: ' npx ', args: '-y\n server-github \n\n', env: 'A=1\nB_TWO=x=y' }),
    { type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { A: '1', B_TWO: 'x=y' } });
  assert.deepStrictEqual(mcp.serverJson({ type: 'http', url: 'https://example.com/mcp', headers: 'Authorization: Bearer abc\nX-Key:1' }),
    { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc', 'X-Key': '1' } });
  assert.deepStrictEqual(mcp.serverJson({ type: 'sse', url: 'http://localhost:3000/sse' }), { type: 'sse', url: 'http://localhost:3000/sse' });
  assert.throws(() => mcp.serverJson({ type: 'stdio', command: '' }), /command/);
  assert.throws(() => mcp.serverJson({ type: 'stdio', command: 'x', env: 'not a pair' }), /NAME=value/);
  assert.throws(() => mcp.serverJson({ type: 'http', url: 'ftp://example.com' }), /URL/);
  assert.throws(() => mcp.serverJson({ type: 'http', url: 'https://x', headers: 'Bad Header: v' }), /Name: value/);
  assert.throws(() => mcp.serverJson({ type: 'websocket' }), /how the server runs/);
});

test("adding and removing run Claude Code's own commands, in the project folder for a project's servers", async () => {
  const calls = [];
  const run = async (args, cwd) => { calls.push({ args, cwd }); return { code: 0, stdout: `Done ${args[1]}\n`, stderr: '' }; };
  const m = new mcp.McpConfig({ run });
  await m.add({ name: 'github', scope: 'user', type: 'stdio', command: 'npx', args: '-y\nserver-github' });
  await m.add({ name: 'shared', scope: 'project', folder: project, type: 'http', url: 'https://example.com/mcp' });
  await m.remove({ name: 'mine', scope: 'local', folder: project });
  assert.deepStrictEqual(calls, [
    { args: ['mcp', 'add-json', '--scope', 'user', 'github', JSON.stringify({ type: 'stdio', command: 'npx', args: ['-y', 'server-github'] })], cwd: undefined },
    { args: ['mcp', 'add-json', '--scope', 'project', 'shared', JSON.stringify({ type: 'http', url: 'https://example.com/mcp' })], cwd: project },
    { args: ['mcp', 'remove', '--scope', 'local', 'mine'], cwd: project },
  ]);
});

test("refused before Claude Code is asked: a bad name, scope or folder; Claude Code's own refusal is passed on", async () => {
  const calls = [];
  const m = new mcp.McpConfig({ run: async (args) => { calls.push(args); return { code: 1, stdout: '', stderr: 'MCP server github already exists in user config\n' }; } });
  await assert.rejects(m.add({ name: '-x', scope: 'user', type: 'stdio', command: 'a' }), /letters, numbers/);
  await assert.rejects(m.add({ name: 'has space', scope: 'user', type: 'stdio', command: 'a' }), /letters, numbers/);
  await assert.rejects(m.add({ name: 'ok', scope: 'everywhere', type: 'stdio', command: 'a' }), /Choose where/);
  await assert.rejects(m.add({ name: 'ok', scope: 'project', type: 'stdio', command: 'a' }), /project folder first/);
  await assert.rejects(m.remove({ name: 'ok', scope: 'local', folder: 'relative\\dir' }), /full folder path/);
  assert.deepStrictEqual(calls, [], 'Claude Code was never run for those');
  await assert.rejects(m.add({ name: 'github', scope: 'user', type: 'stdio', command: 'npx' }), /Couldn't add github: MCP server github already exists in user config/);
});
