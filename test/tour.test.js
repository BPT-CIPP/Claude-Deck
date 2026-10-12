'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// public/tour.js is a browser script; run it with a stand-in window.
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'tour.js'), 'utf8'), { window });
const { STEPS } = window.Deck.tour;
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('every tour step has a title and something to say', () => {
  assert.ok(STEPS.length > 3);
  for (const s of STEPS) {
    assert.ok(typeof s.title === 'string' && s.title, `a step without a title: ${JSON.stringify(s)}`);
    assert.ok(Array.isArray(s.body) && s.body.length && s.body.every((p) => typeof p === 'string' && p), `"${s.title}" has no text`);
  }
});

test('the parts the tour points at still exist', () => {
  // A renamed id or class would leave a step pointing at nothing (and its card in the middle).
  for (const s of STEPS.filter((x) => x.target)) {
    for (const id of s.target.match(/#[\w-]+/g) || []) assert.ok(page.includes(`id="${id.slice(1)}"`), `"${s.title}" points at ${id}, which index.html no longer has`);
    for (const cls of s.target.match(/\.[\w-]+/g) || []) {
      const name = cls.slice(1);
      assert.ok(new RegExp(`class="([^"]* )?${name}[ "]`).test(page) || new RegExp(`class: '([^']* )?${name}[ ']`).test(script), `"${s.title}" points at ${cls}, which the page no longer draws`);
    }
    for (const [, attr, value] of s.target.matchAll(/\[([\w-]+)="([^"]+)"\]/g)) assert.ok(page.includes(`${attr}="${value}"`), `"${s.title}" points at [${attr}="${value}"], which index.html no longer has`);
  }
});

test('the first and last steps stand on their own, in the middle of the window', () => {
  assert.strictEqual(STEPS[0].target, undefined);
  assert.strictEqual(STEPS[STEPS.length - 1].target, undefined);
});
