'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// public/pasted-text.js is a browser script; run it with a stand-in window.
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'pasted-text.js'), 'utf8'), { window });
const p = window.Deck.pastedText;

test('a paste collapses over 800 characters or over 2 line breaks, as in Claude Code', () => {
  assert.strictEqual(p.collapses('a'.repeat(800)), false);
  assert.strictEqual(p.collapses('a'.repeat(801)), true);
  assert.strictEqual(p.collapses('one\ntwo\nthree'), false);
  assert.strictEqual(p.collapses('one\ntwo\nthree\nfour'), true);
});

test('the placeholder counts line breaks, and leaves the count out when there are none', () => {
  const lines = Array.from({ length: 124 }, (_, i) => `line ${i + 1}`).join('\n');
  assert.strictEqual(p.placeholder(1, lines), '[Pasted text #1 +123 lines]');
  assert.strictEqual(p.placeholder(2, 'x'.repeat(900)), '[Pasted text #2]');
});

test('Windows line endings and tabs are taken as Claude Code takes them', () => {
  assert.strictEqual(p.normalize('a\r\nb\rc\td'), 'a\nb\nc    d');
});

// Plain copies: objects made in the vm's context don't deepStrictEqual ones made here.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('sending puts each kept paste back in its place, and says where; anything else stays as typed', () => {
  const pastes = { 1: 'first\nblock', 2: 'cost: $& and $1' };
  const msg = 'See [Pasted text #1 +1 lines] and [Pasted text #2], not [Pasted text #3 +4 lines].';
  const sent = plain(p.expand(msg, pastes));
  assert.strictEqual(sent.text, 'See first\nblock and cost: $& and $1, not [Pasted text #3 +4 lines].');
  assert.deepStrictEqual(sent.ranges, [[4, 15], [20, 35]]);
  assert.strictEqual(sent.text.slice(20, 35), 'cost: $& and $1');
  assert.deepStrictEqual(plain(p.expand('nothing pasted', pastes)), { text: 'nothing pasted', ranges: [] });
});

test('a sent message shows its pastes as placeholders again, and goes back in the box the same way', () => {
  const text = 'See a\nb\nc\nd and x';
  const ranges = [[4, 11], [16, 17]];
  assert.deepStrictEqual(plain(p.pieces(text, ranges)), [
    { text: 'See ' },
    { id: 1, text: 'a\nb\nc\nd', label: '[Pasted text #1 +3 lines]' },
    { text: ' and ' },
    { id: 2, text: 'x', label: '[Pasted text #2]' },
  ]);
  assert.deepStrictEqual(plain(p.collapse(text, ranges)), { value: 'See [Pasted text #1 +3 lines] and [Pasted text #2]', texts: { 1: 'a\nb\nc\nd', 2: 'x' } });
  // And sending that again sends the same message.
  const back = p.collapse(text, ranges);
  assert.strictEqual(p.expand(back.value, back.texts).text, text);
  // Nothing pasted: the text as it is.
  assert.deepStrictEqual(plain(p.pieces('plain', undefined)), [{ text: 'plain' }]);
});

test('numbers go up within a message and start again at #1 in the next', () => {
  assert.strictEqual(p.nextId(''), 1);
  assert.strictEqual(p.nextId('a [Pasted text #1 +3 lines] b [Pasted text #4]'), 5);
  assert.deepStrictEqual([...p.idsIn('[Pasted text #2] [Pasted text #7 +1 lines]')], [2, 7]);
});

test('a placeholder is found by its number, for pasting again to expand it', () => {
  const msg = 'x [Pasted text #1 +3 lines] y [Pasted text #2]';
  assert.deepStrictEqual({ ...p.find(msg, 2) }, { start: 30, end: 46 });
  assert.strictEqual(msg.slice(2, p.find(msg, 1).end), '[Pasted text #1 +3 lines]');
  assert.strictEqual(p.find(msg, 3), null);
});
