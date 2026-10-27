'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { webAppId, taskPriority } = require('../src/app-install');

// A task with no <Priority> runs at Task Scheduler's default, 7: below-normal CPU, low I/O and low
// memory priority, inherited by every chat and MCP server the server starts.
test("the sign-in task's priority is read from its XML, 7 when it has none", () => {
  // As schtasks /Query /XML prints a task registered by an earlier Claude Deck (trimmed).
  const before = '<?xml version="1.0" encoding="UTF-16"?>\r\r\n<Task><Settings>\r\r\n    <StartWhenAvailable>true</StartWhenAvailable>\r\r\n  </Settings></Task>';
  assert.strictEqual(taskPriority(before), 7);
  assert.strictEqual(taskPriority(before.replace('<StartWhenAvailable>', '<Priority>4</Priority><StartWhenAvailable>')), 4);
  assert.strictEqual(taskPriority(''), 7);
});

test('Start-ClaudeDeck.ps1 registers the sign-in task at normal priority', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'Start-ClaudeDeck.ps1'), 'utf8');
  assert.match(script, /New-ScheduledTaskSettingsSet [^\r\n]*-Priority 4\b/);
});

test('web app ids look like Chromium ids: 32 letters a-p, stable per URL', () => {
  const id = webAppId('http://127.0.0.1:47821/');
  assert.match(id, /^[a-p]{32}$/);
  assert.strictEqual(webAppId('http://127.0.0.1:47821/'), id);
  assert.notStrictEqual(webAppId('http://127.0.0.1:47822/'), id);
});

test('generated icons are valid PNG/ICO files', () => {
  const dir = path.join(__dirname, '..', 'public', 'icons');
  for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
    const b = fs.readFileSync(path.join(dir, f));
    assert.deepStrictEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], f);
    const size = Number(f.match(/(\d+)\.png$/)[1]);
    assert.strictEqual(b.readUInt32BE(16), size, `${f} width`);
  }
  const ico = fs.readFileSync(path.join(dir, 'claude-deck.ico'));
  assert.strictEqual(ico.readUInt16LE(2), 1, 'icon type');
  assert.ok(ico.readUInt16LE(4) >= 4, 'several sizes');
});

test('manifest has what Edge needs to install the app', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  assert.strictEqual(m.id, '/');
  assert.strictEqual(m.start_url, '/');
  assert.strictEqual(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && !i.purpose));
});
