'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');

const box = sandbox();
const claudeConfig = require('../src/claude-config');

test.after(() => box.cleanup());

// The start of what Claude Code 2.1.301 prints for "/config" with nothing after it.
const USAGE = [
  'Usage: /config key=value [key=value ...]',
  '  autoCompact=true|false',
  '  editor=normal|vim',
  '  gitignore=true|false',
  '  language=<value>',
  '  permissionMode=default|plan|acceptEdits|auto|dontAsk',
  '  switchModelsOnFlag=Switch automatically|Ask each time',
  '  tips=true|false',
  '  someNewOption=a|b',
].join('\n');

test("reads Claude Code's own list of /config options, free-text ones included", () => {
  const list = claudeConfig.parseUsage(USAGE);
  assert.deepStrictEqual(list.map((o) => o.key), ['autoCompact', 'editor', 'gitignore', 'language', 'permissionMode', 'switchModelsOnFlag', 'tips', 'someNewOption']);
  assert.deepStrictEqual(list.find((o) => o.key === 'switchModelsOnFlag').values, ['Switch automatically', 'Ask each time']);
  assert.strictEqual(list.find((o) => o.key === 'language').values, null);
  assert.deepStrictEqual(claudeConfig.parseUsage("nonsense isn't a /config setting."), []);
});

test("shows each option's value from the one file /config saves it in", () => {
  const cwd = path.join(box.root, 'project');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(box.claudeDir, 'settings.json'), JSON.stringify({ editorMode: 'vim', autoCompactEnabled: false, permissions: { defaultMode: 'plan' }, switchModelsOnFlag: false, spinnerTipsEnabled: true }));
  // Show tips is saved per project, in the local file; the user's file doesn't count for it.
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ spinnerTipsEnabled: false, editorMode: 'normal' }));
  // /config never writes the project's shared file, so a value there must not hide the saved one.
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ editorMode: 'normal', autoCompactEnabled: true }));
  fs.writeFileSync(path.join(box.claudeDir, '.claude.json'), JSON.stringify({ respectGitignore: false }));
  const byKey = Object.fromEntries(claudeConfig.options(USAGE, cwd).map((o) => [o.key, o]));
  assert.strictEqual(byKey.editor.value, 'vim', "the user file's value, not a project file's");
  assert.strictEqual(byKey.editor.label, 'Editor mode');
  assert.strictEqual(byKey.autoCompact.value, 'false');
  assert.strictEqual(byKey.permissionMode.value, 'plan');
  assert.strictEqual(byKey.switchModelsOnFlag.value, 'Ask each time');
  assert.strictEqual(byKey.tips.value, 'false');
  assert.strictEqual(byKey.tips.where, 'local');
  assert.strictEqual(byKey.gitignore.value, 'false');
  assert.strictEqual(byKey.gitignore.where, 'global');
  assert.strictEqual(byKey.language.value, null, 'not set anywhere');
  // An option this copy of Claude Deck doesn't know yet is still offered, under its own name.
  assert.deepStrictEqual([byKey.someNewOption.label, byKey.someNewOption.value, byKey.someNewOption.where], ['someNewOption', null, null]);
  // The same values, for reading a change back.
  assert.deepStrictEqual(claudeConfig.currentValues(['editor', 'language', 'someNewOption'], cwd), {
    editor: { value: 'vim', where: 'user' }, language: { value: null, where: 'user' }, someNewOption: { value: null, where: null },
  });
});

test("a change is one /config command, and nothing can be slipped into it", () => {
  assert.strictEqual(claudeConfig.setCommand('switchModelsOnFlag', 'Ask each time'), '/config switchModelsOnFlag=Ask each time');
  assert.throws(() => claudeConfig.setCommand('theme dark', 'x'), /Not a \/config option/);
  assert.throws(() => claudeConfig.setCommand('theme', 'dark\n/clear'), /Choose a value/);
  assert.throws(() => claudeConfig.setCommand('theme', '  '), /Choose a value/);
  // Claude Code reads several key=value pairs on one line, so a value can't carry a second one.
  assert.throws(() => claudeConfig.setCommand('language', 'en theme=dark'), /second option/);
  assert.strictEqual(claudeConfig.setCommand('worktreeBaseRef', 'origin/main'), '/config worktreeBaseRef=origin/main', 'no space before it: just a value');
});
