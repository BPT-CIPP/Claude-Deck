'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sandbox } = require('./helpers');

const box = sandbox();
const { normalizeOptions, buildClaudeArgs, displayCommand, wtEscape } = require('../src/launcher');
const { parseArgString } = require('../src/util');

test.after(() => box.cleanup());

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('new session: flags, then --session-id, prompt after --', () => {
  const o = normalizeOptions({ cwd: 'C:\\x', model: 'opus', effort: 'high', permissionMode: 'plan', name: 'Demo', addDirs: ['C:\\a', 'C:\\b'], prompt: '-starts with a dash' });
  const { args, baseArgs } = buildClaudeArgs(o, SID);
  assert.deepStrictEqual(args, [
    '--model', 'opus', '--effort', 'high', '--permission-mode', 'plan', '--name', 'Demo',
    '--add-dir', 'C:\\a', 'C:\\b',
    '--session-id', SID,
    '--', '-starts with a dash',
  ]);
  assert.deepStrictEqual(baseArgs, args.slice(0, 11), 'resume reuses the flags but not the session or prompt');
});

test('--add-dir is always followed by an option, never a bare value', () => {
  for (const mode of ['new', 'resume', 'continue']) {
    const o = normalizeOptions({ mode, cwd: 'C:\\x', addDirs: ['C:\\a'], resumeId: SID });
    const { args } = buildClaudeArgs(o, SID);
    const i = args.indexOf('--add-dir');
    assert.ok(args[i + 2].startsWith('--'), `${mode}: ${args.join(' ')}`);
  }
});

test('resume, fork and continue', () => {
  assert.deepStrictEqual(buildClaudeArgs(normalizeOptions({ mode: 'resume', resumeId: SID }), null).args, ['--resume', SID]);
  assert.deepStrictEqual(buildClaudeArgs(normalizeOptions({ mode: 'resume', resumeId: SID, fork: true }), null).args, ['--resume', SID, '--fork-session']);
  assert.deepStrictEqual(buildClaudeArgs(normalizeOptions({ mode: 'continue' }), null).args, ['--continue']);
});

test('worktree only applies to new sessions', () => {
  assert.deepStrictEqual(buildClaudeArgs(normalizeOptions({ worktree: 'feat-x' }), SID).args, ['--session-id', SID, '--worktree', 'feat-x']);
  assert.deepStrictEqual(buildClaudeArgs(normalizeOptions({ worktree: true }), SID).args, ['--session-id', SID, '--worktree']);
  assert.deepStrictEqual(buildClaudeArgs(normalizeOptions({ mode: 'resume', resumeId: SID, worktree: 'x' }), null).args, ['--resume', SID]);
});

test('normalizeOptions rejects bad input and drops unknown enum values', () => {
  assert.throws(() => normalizeOptions({ mode: 'resume', resumeId: 'nope' }), /valid session ID/);
  assert.throws(() => normalizeOptions({ model: 'two words' }), /spaces/);
  const o = normalizeOptions({ effort: 'extreme', permissionMode: 'yolo', color: 'plaid' });
  assert.strictEqual(o.effort, '');
  assert.strictEqual(o.permissionMode, '');
  assert.strictEqual(o.color, 'slate');
});

test('extra arguments are split like a command line', () => {
  assert.deepStrictEqual(parseArgString('--verbose --append-system-prompt "Be brief" x'), ['--verbose', '--append-system-prompt', 'Be brief', 'x']);
  assert.deepStrictEqual(parseArgString('say \\"hi\\"'), ['say', '"hi"']);
  assert.deepStrictEqual(parseArgString('""'), ['']);
  assert.throws(() => parseArgString('"open'), /unclosed/);
});

test('display command quotes what needs quoting', () => {
  assert.strictEqual(displayCommand(['--name', 'My session', '--', 'a;b']), 'claude --name "My session" -- "a;b"');
});

test('wt escaping keeps semicolons literal', () => {
  assert.strictEqual(wtEscape('C:\\a;b'), 'C:\\a\\;b');
  assert.strictEqual(wtEscape('plain'), 'plain');
});
