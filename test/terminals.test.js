'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const prefs = require('../src/prefs');
const { TerminalManager, quoteArg, commandLine } = require('../src/terminals');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
prefs.save({ claudePath: FAKE });
const onWindows = process.platform === 'win32';

// A terminal left running (a failed assertion) would keep the test process alive.
let terms = null;
test.after(async () => {
  if (terms) await terms.endAll();
  box.cleanup();
});

// Stands in for the page's event stream: keeps what the terminal draws, and whether it ended.
function viewer() {
  const chunks = [];
  const v = { chunks, events: [], ended: false, text: () => Buffer.concat(chunks).toString('utf8') };
  v.res = {
    write(msg) {
      for (const m of msg.matchAll(/^event: (\w+)/gm)) v.events.push(m[1]);
      for (const m of msg.matchAll(/event: data\ndata: ([^\n]*)/g)) chunks.push(Buffer.from(m[1], 'base64'));
      if (msg.startsWith('event: exit')) v.ended = true;
    },
  };
  return v;
}

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('quotes arguments as CreateProcess reads them back', () => {
  assert.strictEqual(quoteArg('plain'), 'plain');
  assert.strictEqual(quoteArg('has space'), '"has space"');
  assert.strictEqual(quoteArg(''), '""');
  assert.strictEqual(quoteArg('say "hi"'), '"say \\"hi\\""');
  // Backslashes are only special before a quote: a trailing one is doubled, a middle one isn't.
  assert.strictEqual(quoteArg('C:\\my dir\\'), '"C:\\my dir\\\\"');
  assert.strictEqual(quoteArg('a\\"b'), '"a\\\\\\"b"');
  assert.ok(commandLine(FAKE, ['--session-id', 'x']).startsWith(`${quoteArg(process.execPath)} ${quoteArg(FAKE)} --session-id x`), 'a script runs under node');
});

test('a terminal in the window: Claude draws to it, keys reach it, it resizes, resumes and ends', { skip: !onWindows && 'needs Windows (conhost)' }, async () => {
  terms = new TerminalManager();
  const term = terms.create({ mode: 'new', cwd: box.root, color: 'cyan', name: 'In the window' });
  assert.strictEqual(term.kind, 'embedded');
  assert.strictEqual(term.state, 'running');
  const shown = viewer();
  const detach = terms.attach(term.id, shown.res);
  await until(() => shown.text().includes('press q to exit'), 30000, "the stand-in's prompt");
  // The pid the host found is the one writing Claude Code's own status file.
  await until(() => terms.get(term.id).claudePid, 30000, "Claude's pid from the host");
  assert.ok(fs.existsSync(path.join(box.claudeDir, 'sessions', `${terms.get(term.id).claudePid}.json`)), 'the status file is by that pid');
  // A resize reaches the console: the stand-in says what it was resized to.
  assert.deepStrictEqual(terms.resize(term.id, 100, 30), { cols: 100, rows: 30 });
  await until(() => shown.text().includes('size: 100x30'), 10000, 'the resize');
  assert.throws(() => terms.resize(term.id, 'wide', 30), /whole numbers/);
  // A keystroke: q ends the stand-in. The terminal stays listed, as ended.
  terms.write(term.id, 'q');
  await until(() => terms.get(term.id).state === 'exited', 10000, 'the exit');
  assert.strictEqual(terms.get(term.id).exitCode, 0);
  assert.ok(shown.ended, 'the viewer was told');
  assert.throws(() => terms.write(term.id, 'x'), /ended/);
  detach();
  // A page connecting afterwards gets what was drawn, and that it ended.
  const later = viewer();
  terms.attach(term.id, later.res)();
  assert.ok(later.text().includes('press q to exit'));
  assert.ok(later.ended);
  // "live" marks where the replay ends: the page copies Claude Code's OSC 52 clipboard writes only
  // after it, or reopening a terminal would copy its last selection again.
  assert.deepStrictEqual(later.events, ['size', 'reset', 'data', 'live', 'exit']);
  // Resume: the same conversation, a new run.
  terms.resume(term.id);
  assert.strictEqual(terms.get(term.id).state, 'running');
  const again = viewer();
  terms.attach(term.id, again.res);
  await until(() => again.text().includes('--resume'), 30000, 'the resumed run');
  // End: the stand-in ignores Ctrl+C (as Claude does a single one), so the tree is ended by force.
  // The terminal stays listed as ended, with its screen, and is in the list a new server loads.
  await terms.end(term.id);
  assert.deepStrictEqual([terms.get(term.id).state, terms.get(term.id).screen], ['exited', true], 'ended terminals stay listed');
  assert.ok(!fs.existsSync(path.join(box.dataDir, 'terminals', `${term.id}.spec.json`)), 'its launch spec is removed');
  terms._saveNow();
  const back = new TerminalManager().get(term.id);
  assert.deepStrictEqual([back.state, back.name, back.sessionId, back.screen, back.note], ['exited', 'In the window', term.sessionId, false, 'Claude Deck restarted. Resume to continue this conversation.']);
  // Remove takes it off the list, and out of the file.
  await terms.end(term.id, { remove: true });
  assert.strictEqual(terms.get(term.id), null);
  terms._saveNow();
  assert.strictEqual(new TerminalManager().get(term.id), null);
});
