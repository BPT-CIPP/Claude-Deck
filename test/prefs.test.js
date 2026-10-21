'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const prefs = require('../src/prefs');

test.after(() => box.cleanup());

test('every theme is styled in app.css and offered in Preferences', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(prefs.THEMES.length >= 13, 'at least 10 themes beyond system, dark and light');
  for (const id of prefs.THEMES) {
    if (id !== 'system' && id !== 'dark') assert.ok(css.includes(`:root[data-theme="${id}"] {`), `app.css has a block for ${id}`);
    assert.ok(js.includes(`['${id}', '`), `Preferences lists ${id}`);
  }
});

test('tool-call icons are off unless turned on', () => {
  assert.strictEqual(prefs.load().showToolIcons, false);
  assert.strictEqual(prefs.save({ showToolIcons: true }).showToolIcons, true);
  assert.throws(() => prefs.save({ showToolIcons: 'yes' }), /wrong type/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  assert.ok(css.includes(':root:not([data-tool-icons="on"]) details.msg-tool .ticon { display: none; }'), 'hidden unless the page turns them on');
});

test('every font is offered in Preferences, and only known fonts are accepted', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  for (const id of prefs.FONTS) assert.ok(js.includes(`${/^[a-z]+$/.test(id) ? id : `'${id}'`}: {`), `FONT_CHOICES has ${id}`);
  assert.strictEqual(prefs.load().fontText, 'default');
  assert.strictEqual(prefs.load().fontLabels, 'default');
  assert.strictEqual(prefs.save({ fontText: 'aptos', fontLabels: 'segoe' }).fontText, 'aptos');
  assert.strictEqual(prefs.load().fontLabels, 'segoe');
  assert.throws(() => prefs.save({ fontText: 'Comic Sans MS' }), /must be one of/);
});

test('pinned folders are paths and presets have a name and options; anything else is refused or left out', () => {
  assert.throws(() => prefs.save({ favorites: ['C:\\ok', 42] }), /must be paths/);
  assert.throws(() => prefs.save({ presets: [{ name: 'x' }] }), /name and its options/);
  assert.throws(() => prefs.save({ presets: [{ name: '', options: {} }] }), /name and its options/);
  assert.deepStrictEqual(prefs.save({ favorites: ['C:\\ok'], presets: [{ name: 'Mine', options: { model: 'opus' } }] }).presets, [{ name: 'Mine', options: { model: 'opus' } }]);
  // A prefs.json edited by hand: the page can't use a pinned folder that isn't a path.
  const file = path.join(box.dataDir, 'prefs.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...stored, favorites: ['C:\\ok', null, ''], presets: [{ name: 'Mine', options: { model: 'opus' } }, 'nope'] }));
  assert.deepStrictEqual(prefs.load().favorites, ['C:\\ok']);
  assert.strictEqual(prefs.load().presets.length, 1);
});

test('theme preference accepts known themes only', () => {
  assert.strictEqual(prefs.save({ theme: 'nord' }).theme, 'nord');
  assert.throws(() => prefs.save({ theme: 'neon' }), /must be one of/);
  assert.strictEqual(prefs.load().theme, 'nord');
});
