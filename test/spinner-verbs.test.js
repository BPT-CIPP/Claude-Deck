'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// public/spinner-verbs.js is a browser script; run it with a stand-in window.
function load() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'spinner-verbs.js'), 'utf8'), { window });
  return window.Deck;
}

test('spinner verbs: Claude Code defaults plus the chosen categories, de-duplicated', () => {
  const { SPINNER_LISTS: lists, SPINNER_VERBS: verbs } = load();
  assert.deepStrictEqual(Object.keys(lists), ['Built-in defaults', 'Absurd / Nonsense', 'AI', 'AI Phrases', 'Back to the Future', 'Chemistry', 'Dev Life', 'Futurama', 'Gaming', 'Gen-Z', 'Gen-Z Phrases', 'Git Commit Messages']);
  // Counts as listed in the source repo's README.
  assert.deepStrictEqual(Object.values(lists).map((l) => l.length), [185, 20, 56, 99, 10, 9, 92, 43, 13, 48, 50, 60]);
  assert.strictEqual(new Set(verbs).size, verbs.length);
  assert.strictEqual(verbs.length, new Set(Object.values(lists).flat()).size);
  assert.ok(verbs.every((v) => typeof v === 'string' && v.trim() === v && v.length > 0));
  for (const v of ['Flibbertigibbeting', 'Hypnotoading', 'Charging 1.21 gigawatts', "Re-reading the prompt like it's a contract"]) assert.ok(verbs.includes(v), v);
});
