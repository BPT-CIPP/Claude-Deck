'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const log = require('../src/log');

test.after(() => box.cleanup());

test('the log goes in the data folder, one timestamped entry per line, the token left out', () => {
  const file = log.logFile();
  assert.strictEqual(file, path.join(box.dataDir, 'logs', 'claude-deck.log'));
  log.write('INFO', ['Claude Deck running at %s', 'http://127.0.0.1:47821/?t=0123456789abcdef0123456789abcdef0123456789abcdef']);
  log.write('ERROR', ['claude update failed\nline two']);
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /0123456789abcdef/, 'the token is never written');
  assert.match(text, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [+-]\d\d:\d\d INFO  \[\d+\] Claude Deck running at http:\/\/127\.0\.0\.1:47821\/\?t=<token>$/m);
  assert.match(text, /ERROR \[\d+\] claude update failed\n {4}line two\n$/, "an entry's later lines are indented");
});

test('past its size the log moves to .1, the older ones up, and only a few are kept', () => {
  const file = path.join(box.root, 'rotate', 'claude-deck.log');
  const big = 'x'.repeat(Math.floor(log.MAX_BYTES / 3)); // two entries fit in a file, not three
  for (let i = 1; i <= 2 * (log.KEEP + 2); i++) log.write('INFO', [`entry ${i} ${big}`], file);
  const names = fs.readdirSync(path.dirname(file)).sort();
  assert.deepStrictEqual(names, ['claude-deck.1.log', 'claude-deck.2.log', 'claude-deck.3.log', 'claude-deck.log']);
  for (const name of names) assert.ok(fs.statSync(path.join(path.dirname(file), name)).size <= log.MAX_BYTES, `${name} stays under the limit`);
  // Ten entries, two a file: 9-10 in the current file, 7-8 in .1, 5-6 in .2, 3-4 in .3; 1-2 gone.
  const entries = (name) => fs.readFileSync(path.join(path.dirname(file), name), 'utf8').match(/entry \d+/g);
  assert.deepStrictEqual(names.map(entries), [['entry 7', 'entry 8'], ['entry 5', 'entry 6'], ['entry 3', 'entry 4'], ['entry 9', 'entry 10']]);
});

test('once installed, what the server prints is logged too', () => {
  log.install();
  const printed = [];
  const stderrWrite = process.stderr.write;
  process.stderr.write = (chunk) => { printed.push(String(chunk)); return true; };
  try {
    console.error('chat message failed:', new Error('boom'));
  } finally {
    process.stderr.write = stderrWrite;
  }
  assert.match(printed.join(''), /boom/, 'still printed');
  assert.match(fs.readFileSync(log.logFile(), 'utf8'), /ERROR \[\d+\] chat message failed: Error: boom\n {8}at /, 'and logged, with the stack (indented under the entry)');
});
