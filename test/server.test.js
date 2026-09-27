'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { sandbox } = require('./helpers');

const box = sandbox();
const prefs = require('../src/prefs');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
// Keep the servers hermetic: the fake answers `--version` without touching the real Claude.
prefs.save({ claudePath: path.join(__dirname, 'fixtures', 'fake-claude.js') });
const env = { ...process.env, CLAUDE_CONFIG_DIR: box.claudeDir, CLAUDE_DECK_DATA: box.dataDir };

let first;
test.after(() => {
  if (first && first.exitCode === null) first.kill();
  box.cleanup();
});

test('a second server exits with code 3 when one is already running', async () => {
  first = spawn(process.execPath, [SERVER, '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('first server did not start')), 15000);
    first.stdout.on('data', (d) => { if (String(d).includes('Claude Deck running at')) { clearTimeout(timer); resolve(); } });
    first.on('exit', (code) => reject(new Error(`first server exited early (${code})`)));
  });
  const second = spawnSync(process.execPath, [SERVER, '--port', '0'], { env, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(second.status, 3, second.stderr);
  assert.match(second.stdout, /already running/);
  assert.strictEqual(first.exitCode, null, 'the first server keeps running');
});

// Raw requests, so the path goes out exactly as written (fetch would normalize it).
function raw(port, urlPath, { method = 'GET', headers = {} } = {}) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', (err) => resolve(`error: ${err.code}`));
    req.end();
  });
}

test('malformed, unauthorized and misaddressed requests get an error, and the server keeps running', async () => {
  const fs = require('fs');
  const { port } = JSON.parse(fs.readFileSync(path.join(box.dataDir, 'runtime.json'), 'utf8'));
  const token = JSON.parse(fs.readFileSync(path.join(box.dataDir, 'secret.json'), 'utf8')).token;
  const auth = { 'x-deck-token': token };
  // Each of these once ended the server (an unhandled exception in the request handler).
  assert.strictEqual(await raw(port, '/%'), 400, 'a lone % in a page path');
  assert.strictEqual(await raw(port, '/%00'), 400, 'NUL in a page path');
  assert.strictEqual(await raw(port, `/api/events?t=${'%C3%A9'.repeat(48)}`), 401, 'a token of the right length in characters, not bytes');
  assert.strictEqual(await raw(port, '/api/chats/%/send', { method: 'POST', headers: auth }), 400, 'a lone % in an API path');
  // And the usual refusals.
  assert.strictEqual(await raw(port, '/api/ping'), 401, 'no token');
  assert.strictEqual(await raw(port, '/api/ping', { headers: { 'x-deck-token': 'x'.repeat(token.length) } }), 401, 'wrong token');
  assert.strictEqual(await raw(port, '/api/ping', { headers: { ...auth, host: `evil.example:${port}` } }), 421, 'another host name');
  assert.strictEqual(await raw(port, '/..%2f..%2fpackage.json'), 403, 'outside the page folder');
  assert.strictEqual(await raw(port, '/api/ping', { headers: auth }), 200, 'still serving');
  assert.strictEqual(first.exitCode, null, 'still running');
});

test('a Claude Code path set to a .cmd shim does not stop the server from starting', async () => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-deck-test-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo 1.0.0\r\n');
  fs.writeFileSync(path.join(data, 'prefs.json'), JSON.stringify({ claudePath: path.join(dir, 'claude.cmd') }));
  const child = spawn(process.execPath, [SERVER, '--port', '0'], { env: { ...env, CLAUDE_DECK_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
      child.stdout.on('data', (d) => { if (String(d).includes('Claude Deck running at')) { clearTimeout(timer); resolve(); } });
      child.on('exit', (code) => reject(new Error(`server exited (${code})`)));
    });
    // Checking the version happens just after start; give it time to fail if it's going to.
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(child.exitCode, null, 'still running');
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart hands over to a new server on the same port, exiting as "another copy is serving"', async () => {
  const fs = require('fs');
  const runtime = () => JSON.parse(fs.readFileSync(path.join(box.dataDir, 'runtime.json'), 'utf8'));
  const token = JSON.parse(fs.readFileSync(path.join(box.dataDir, 'secret.json'), 'utf8')).token;
  const { port, pid } = runtime();
  const call = (method, url) => fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'x-deck-token': token } }).then((r) => r.json());
  const exited = new Promise((resolve) => first.on('exit', resolve));
  const res = await call('POST', '/api/restart');
  assert.strictEqual(res.pid, pid);
  // 3 keeps the sign-in task's supervisor watching instead of staying stopped (Start-ClaudeDeck.ps1).
  assert.strictEqual(await exited, 3);
  let next = null;
  for (let i = 0; i < 60 && !next; i++) {
    await new Promise((r) => setTimeout(r, 250));
    next = await call('GET', '/api/ping').catch(() => null);
  }
  assert.ok(next, 'the new server answers on the same port');
  assert.notStrictEqual(next.pid, pid);
  assert.strictEqual(runtime().pid, next.pid);
  await call('POST', '/api/shutdown');
  for (let i = 0; i < 40; i++) {
    try { process.kill(next.pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 250));
  }
  process.kill(next.pid);
  assert.fail('the new server did not stop when asked');
});
