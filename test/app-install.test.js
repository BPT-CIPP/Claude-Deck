'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { webAppId } = require('../src/app-install');

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
