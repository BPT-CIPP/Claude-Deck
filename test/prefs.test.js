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

test('theme preference accepts known themes only', () => {
  assert.strictEqual(prefs.save({ theme: 'nord' }).theme, 'nord');
  assert.throws(() => prefs.save({ theme: 'neon' }), /must be one of/);
  assert.strictEqual(prefs.load().theme, 'nord');
});
