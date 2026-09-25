'use strict';
// A throwaway Claude Deck to test changes against, never the live one: its own data folder, its
// own Claude config folder and its own port, with Claude talking to a local mock of the API, so
// nothing is billed and nothing reaches Anthropic. Stops everything on Ctrl+C.
//
//   node tools/sandbox.js            real claude.exe against test/fixtures/mock-anthropic-api.js
//   node tools/sandbox.js --fake     test/fixtures/fake-claude.js instead of claude.exe
//   node tools/sandbox.js --keep     reuse the previous sandbox's data instead of starting fresh
//   node tools/sandbox.js --port 47880 --mock-port 47990
//
// The mock's scripted prompts ("please run", "please write", "please delegate", ...) are listed at
// the top of test/fixtures/mock-anthropic-api.js. See docs/TESTING.md.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { locateClaude } = require('../src/claude-locate');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = Number(value('--port', 47874));
const MOCK_PORT = Number(value('--mock-port', 47994));
const root = path.join(__dirname, '..');
const box = path.join(os.tmpdir(), 'claude-deck-sandbox');
const dirs = { data: path.join(box, 'data'), claude: path.join(box, 'claude'), project: path.join(box, 'project') };

if (!flag('--keep')) fs.rmSync(box, { recursive: true, force: true });
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

let claudePath;
if (flag('--fake')) {
  claudePath = path.join(root, 'test', 'fixtures', 'fake-claude.js');
} else {
  const found = locateClaude(null);
  if (!found) {
    console.error('Claude Code was not found. Install it, or run with --fake to use the stand-in.');
    process.exit(1);
  }
  claudePath = found.path;
}
fs.writeFileSync(path.join(dirs.data, 'prefs.json'), JSON.stringify({ stopWhenClosed: false, claudePath, defaultFolder: dirs.project }));

const env = {
  ...process.env,
  CLAUDE_DECK_DATA: dirs.data,
  CLAUDE_CONFIG_DIR: dirs.claude,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  ANTHROPIC_API_KEY: 'sk-ant-mock-not-a-real-key',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};
delete env.CLAUDECODE; // when run from inside a Claude Code session

const children = [];
const start = (file, childArgs) => {
  const child = spawn(process.execPath, [file, ...childArgs], { env, stdio: 'ignore', windowsHide: true });
  children.push(child);
  return child;
};
start(path.join(root, 'test', 'fixtures', 'mock-anthropic-api.js'), [String(MOCK_PORT), dirs.project]);
const server = start(path.join(root, 'src', 'server.js'), ['--port', String(PORT)]);

function get(urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: urlPath, headers: { 'x-deck-token': token } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

async function stop() {
  try {
    const token = JSON.parse(fs.readFileSync(path.join(dirs.data, 'secret.json'), 'utf8')).token;
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/shutdown', method: 'POST', headers: { 'x-deck-token': token } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve);
      req.end();
    });
    await new Promise((r) => setTimeout(r, 1500)); // lets the server end its chats cleanly
  } catch { /* never started */ }
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const token = JSON.parse(fs.readFileSync(path.join(dirs.data, 'secret.json'), 'utf8')).token;
      if ((await get('/api/ping', token)) === 200) {
        console.log(`Sandbox Claude Deck is running (${flag('--fake') ? 'fake Claude' : `real Claude Code against the mock API on port ${MOCK_PORT}`}).`);
        console.log(`  Open:    http://127.0.0.1:${PORT}/?t=${token}`);
        console.log(`  Folder:  ${dirs.project}  (start chats here)`);
        console.log(`  Data:    ${box}`);
        console.log('Press Ctrl+C to stop it.');
        return;
      }
    } catch { /* not up yet */ }
    if (server.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`The sandbox server did not start. Is port ${PORT} already in use? Try --port.`);
  await stop();
})();
