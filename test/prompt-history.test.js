'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const { search } = require('../src/prompt-history');
const { decodeClixml } = require('../src/shell-mode');

test.after(() => box.cleanup());

// Claude Code's own prompt history, oldest first, as 2.1.284 writes it.
const dir = path.join(box.root, 'claude-home');
fs.mkdirSync(path.join(dir, 'paste-cache'), { recursive: true });
const here = path.join(box.root, 'project');
const entry = (display, project, ts, pastedContents = {}) => JSON.stringify({ display, pastedContents, timestamp: ts, project, sessionId: 'cccccccc-dddd-4eee-8fff-000000000000' });
fs.writeFileSync(path.join(dir, 'paste-cache', '0123456789abcdef.txt'), 'cached\npaste\ntext\nhere');
fs.writeFileSync(path.join(dir, 'history.jsonl'), [
  entry('fix the build', 'C:\\elsewhere', 1),
  entry('fix the tests', here, 2),
  entry('look at [Pasted text #1 +3 lines] please', here, 3, { 1: { id: 1, type: 'text', contentHash: '0123456789abcdef' } }),
  entry('and [Pasted text #1 +1 lines] too', here, 4, { 1: { id: 1, type: 'text', content: 'inline\npaste' } }),
  entry('gone [Pasted text #1 +9 lines]', here, 5, { 1: { id: 1, type: 'text', contentHash: 'ffffffffffffffff' } }),
  'not json',
  entry('fix the tests', here, 6),
].join('\n'));

test("Ctrl+R finds earlier prompts, this folder's first, newest first, each once", () => {
  const r = search('fix', here, { dir });
  assert.deepStrictEqual(r.map((e) => e.text), ['fix the tests', 'fix the build']);
  assert.strictEqual(r[0].ts, 6);
  assert.deepStrictEqual(search('', here, { dir }).map((e) => e.text), ['fix the tests', 'gone [Pasted text #1 +9 lines]', 'and [Pasted text #1 +1 lines] too', 'look at [Pasted text #1 +3 lines] please', 'fix the build']);
});

test("a prompt's pastes come back from history, or from the paste cache, or as missing", () => {
  const byText = Object.fromEntries(search('', here, { dir }).map((e) => [e.text, e.pastes]));
  assert.deepStrictEqual(byText['and [Pasted text #1 +1 lines] too'], { 1: 'inline\npaste' });
  assert.deepStrictEqual(byText['look at [Pasted text #1 +3 lines] please'], { 1: 'cached\npaste\ntext\nhere' });
  assert.deepStrictEqual(byText['gone [Pasted text #1 +9 lines]'], { 1: null });
});

test('no history yet is no results, not an error', () => {
  assert.deepStrictEqual(search('x', here, { dir: path.join(box.root, 'nothing-here') }), []);
});

test("PowerShell's CLIXML errors read as the plain text it would print", () => {
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Get-Item : Cannot find path &apos;C:\\nope&apos; because it does not exist._x000D__x000A_</S><S S="Error">+ Get-Item C:\\nope &lt;here&gt;_x000D__x000A_</S></Objs>';
  assert.strictEqual(decodeClixml(clixml), "Get-Item : Cannot find path 'C:\\nope' because it does not exist.\r\n+ Get-Item C:\\nope <here>\r\n");
  assert.strictEqual(decodeClixml('plain error'), 'plain error');
});
