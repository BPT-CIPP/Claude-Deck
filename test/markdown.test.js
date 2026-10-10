'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// public/markdown.js is a browser script; run it with a stand-in window.
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'markdown.js'), 'utf8'), { window });
const { parse, inline } = window.Deck.markdown;
// Plain copies: objects made in the vm's context don't deepStrictEqual ones made here.
const md = (text) => JSON.parse(JSON.stringify(parse(text)));
const span = (text) => JSON.parse(JSON.stringify(inline(text)));
const t = (text) => ({ type: 'text', text });

test('headings and tables, as in the reply that showed them as raw text', () => {
  const blocks = md([
    '## What works on your Windows PC',
    '| Works now | Needs setup | Not available on Windows |',
    '|---|:---:|--:|',
    '| JavaScript / Electron apps | Compiled programs (`.exe` / `.dll`) need Ghidra | Hopper |',
    '| HAR files |',
  ].join('\n'));
  assert.deepStrictEqual(blocks[0], { type: 'heading', level: 2, inline: [t('What works on your Windows PC')] });
  assert.strictEqual(blocks[1].type, 'table');
  assert.deepStrictEqual(blocks[1].align, [null, 'center', 'right']);
  assert.deepStrictEqual(blocks[1].head, [[t('Works now')], [t('Needs setup')], [t('Not available on Windows')]]);
  assert.deepStrictEqual(blocks[1].rows[0][1], [t('Compiled programs ('), { type: 'code', text: '.exe' }, t(' / '), { type: 'code', text: '.dll' }, t(') need Ghidra')]);
  // A short row is filled out to the table's width.
  assert.deepStrictEqual(blocks[1].rows[1], [[t('HAR files')], [], []]);
});

test('a pipe inside code or escaped stays in its cell; a header and separator must match', () => {
  const [table] = md('| Command | Meaning |\n|---|---|\n| `a | b` | pipe \\| here |');
  assert.deepStrictEqual(table.rows[0], [[{ type: 'code', text: 'a | b' }], [t('pipe | here')]]);
  // Two header cells over three separator cells isn't a table.
  assert.strictEqual(md('| a | b |\n|---|---|---|')[0].type, 'paragraph');
});

test('lists: bullets, numbers, nesting, and code inside an item', () => {
  const [list] = md('- one\n- two\n  - two a\n  - two b\n- three');
  assert.strictEqual(list.type, 'list');
  assert.strictEqual(list.ordered, false);
  assert.strictEqual(list.items.length, 3);
  assert.deepStrictEqual(list.items[0], [{ type: 'paragraph', inline: [t('one')] }]);
  assert.strictEqual(list.items[1][1].type, 'list');
  assert.strictEqual(list.items[1][1].items.length, 2);

  const [steps] = md('3. first\n4. second\n\n   ```ps1\n   Get-Item .\n   ```\n5. third');
  assert.strictEqual(steps.ordered, true);
  assert.strictEqual(steps.start, 3);
  assert.strictEqual(steps.items.length, 3);
  assert.deepStrictEqual(steps.items[1][1], { type: 'code', lang: 'ps1', code: 'Get-Item .', open: false });

  // A text line straight after a list item carries on its paragraph.
  assert.deepStrictEqual(md('- starts here\nand carries on')[0].items[0], [{ type: 'paragraph', inline: [t('starts here\nand carries on')] }]);
});

test('a bulleted list can follow a paragraph line directly; a stray number cannot start one', () => {
  const blocks = md('Steps:\n- one\n- two');
  assert.deepStrictEqual(blocks.map((b) => b.type), ['paragraph', 'list']);
  assert.deepStrictEqual(md('It shipped in\n2026. Then more.').map((b) => b.type), ['paragraph']);
});

test('quotes, rules and fenced code', () => {
  const blocks = md('> **Note:** careful\n> second line\n\n---\n\n```js\nconst a = 1;\n```\n\n~~~\nplain\n~~~');
  assert.deepStrictEqual(blocks.map((b) => b.type), ['quote', 'rule', 'code', 'code']);
  assert.deepStrictEqual(blocks[0].blocks, [{ type: 'paragraph', inline: [{ type: 'strong', children: [t('Note:')] }, t(' careful\nsecond line')] }]);
  assert.deepStrictEqual(blocks[2], { type: 'code', lang: 'js', code: 'const a = 1;', open: false });
  assert.deepStrictEqual(blocks[3], { type: 'code', lang: '', code: 'plain', open: false });
  // Rules drawn with stars or spaced-out dashes aren't list items.
  for (const r of ['***', '* * *', '- - -', '___']) assert.deepStrictEqual(md(r), [{ type: 'rule' }], r);
});

test('code: Markdown inside it is left alone, a reply cut off inside it is marked open, Windows line endings', () => {
  assert.deepStrictEqual(md('```\n# not a heading\n| a | b |\n```'), [{ type: 'code', lang: '', code: '# not a heading\n| a | b |', open: false }]);
  assert.deepStrictEqual(md('Here:\n```python\nprint(1)'), [{ type: 'paragraph', inline: [t('Here:')] }, { type: 'code', lang: 'python', code: 'print(1)', open: true }]);
  assert.deepStrictEqual(md('```c++\r\nint x;\r\n```'), [{ type: 'code', lang: 'c++', code: 'int x;', open: false }]);
  assert.deepStrictEqual(md('Text\n\n    indented code\n\n    more\n\nAfter'), [
    { type: 'paragraph', inline: [t('Text')] },
    { type: 'code', lang: '', code: 'indented code\n\nmore', open: false },
    { type: 'paragraph', inline: [t('After')] },
  ]);
});

test('inline: code, bold, italics, strikethrough, escapes', () => {
  assert.deepStrictEqual(span('a `b` **c** *d* _e_ ~~f~~ \\*g\\*'), [
    t('a '), { type: 'code', text: 'b' }, t(' '), { type: 'strong', children: [t('c')] }, t(' '),
    { type: 'em', children: [t('d')] }, t(' '), { type: 'em', children: [t('e')] }, t(' '),
    { type: 'del', children: [t('f')] }, t(' *g*'),
  ]);
  assert.deepStrictEqual(span('**bold with `code` inside**'), [{ type: 'strong', children: [t('bold with '), { type: 'code', text: 'code' }, t(' inside')] }]);
  // Not emphasis: snake_case names, arithmetic, and Markdown inside code.
  assert.deepStrictEqual(span('my_var_name and 2 * 3 * 4'), [t('my_var_name and 2 * 3 * 4')]);
  assert.deepStrictEqual(span('`**not bold**`'), [{ type: 'code', text: '**not bold**' }]);
  assert.deepStrictEqual(span('`` a`b ``'), [{ type: 'code', text: 'a`b' }]);
});

test('links: web addresses are links; anything else keeps its text only', () => {
  assert.deepStrictEqual(span('See [the docs](https://example.com/a_(b)) now'), [t('See '), { type: 'link', href: 'https://example.com/a_(b)', url: 'https://example.com/a_(b)', children: [t('the docs')] }, t(' now')]);
  assert.deepStrictEqual(span('(at https://example.com/x.)'), [t('(at '), { type: 'link', href: 'https://example.com/x', url: 'https://example.com/x', children: [t('https://example.com/x')] }, t('.)')]);
  assert.deepStrictEqual(span('[app.js](public/app.js)'), [{ type: 'link', href: null, url: 'public/app.js', children: [t('app.js')] }]);
  assert.deepStrictEqual(span('[x](javascript:alert(1))'), [{ type: 'link', href: null, url: 'javascript:alert(1)', children: [t('x')] }]);
});

test('heading levels, a hash with no space, and paragraphs that keep their line breaks', () => {
  const blocks = md('# One\n###### Six ##\n#hashtag\nline two\n\nnext paragraph');
  assert.deepStrictEqual(blocks[0], { type: 'heading', level: 1, inline: [t('One')] });
  assert.deepStrictEqual(blocks[1], { type: 'heading', level: 6, inline: [t('Six')] });
  assert.deepStrictEqual(blocks[2], { type: 'paragraph', inline: [t('#hashtag\nline two')] });
  assert.deepStrictEqual(blocks[3], { type: 'paragraph', inline: [t('next paragraph')] });
});

test('deep nesting and long input stay quick', () => {
  const started = Date.now();
  md('>'.repeat(200) + ' deep');
  md(`${'- '.repeat(200)}deep`);
  inline('*'.repeat(5000));
  inline(`${'**a '.repeat(2000)}`);
  inline(`${'`'.repeat(3000)}x`);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});
