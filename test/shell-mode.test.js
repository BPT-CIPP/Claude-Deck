'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers');
const { isPidAlive } = require('../src/util');

const box = sandbox();
const { runPowerShell } = require('../src/shell-mode');

test.after(() => box.cleanup());

const win = process.platform === 'win32';

test('a command runs in PowerShell in the given folder, with its output and exit code', { skip: !win }, async () => {
  const r = await runPowerShell('Write-Output (Get-Location).Path; Write-Error oops; exit 3', box.root);
  // PowerShell prints the folder's long name; a temp folder can be given as a short (8.3) one,
  // as on GitHub's runners (RUNNER~1 for runneradmin), so compare real paths.
  assert.strictEqual(r.stdout.toLowerCase(), fs.realpathSync.native(box.root).toLowerCase());
  assert.match(r.stderr, /oops/);
  assert.strictEqual(r.exitCode, 3);
  assert.strictEqual(r.timedOut, false);
});

test('a command that runs out of time is stopped with everything it started', { skip: !win }, async () => {
  // The command starts a second PowerShell (standing in for a dev server or a ping -t) and notes
  // its pid, then waits. Ending only the first would leave the second running.
  const pidFile = path.join(box.root, 'child.pid');
  const command = `$p = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep 120' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '${pidFile.replace(/'/g, "''")}' -Value $p.Id; Start-Sleep 120`;
  const r = await runPowerShell(command, box.root, { timeoutMs: 2500 });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.exitCode, null);
  const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(childPid > 0, 'the child reported its pid');
  for (let i = 0; i < 40 && isPidAlive(childPid); i++) await new Promise((res) => setTimeout(res, 100));
  assert.strictEqual(isPidAlive(childPid), false, 'the process the command started was ended too');
});
