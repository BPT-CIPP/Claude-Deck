'use strict';
// Shell mode: "!command" in a chat's reply box runs the command right away, without Claude, as `!`
// does in Claude Code's terminal. It runs in Windows PowerShell 5.1 (powershell.exe, which every
// Windows PC has) in the chat's folder. The terminal's own shell on Windows is Git Bash, whose
// helper programs Defender's attack surface reduction rules can block; see docs/TESTING.md.
//
// The command goes in as -EncodedCommand (UTF-16LE base64), so no quoting can break it. PowerShell
// then reports errors on stderr as CLIXML, which decodeClixml turns back into plain text.

const { spawn } = require('child_process');
const { clip } = require('./util');

const TIMEOUT_MS = 2 * 60 * 1000; // as Claude Code's own shell commands default to
const MAX_OUTPUT = 30000;

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

// "#< CLIXML <Objs><S S="Error">text_x000D__x000A_</S>…" → the text PowerShell would have printed.
function decodeClixml(text) {
  const s = String(text || '');
  if (!s.startsWith('#< CLIXML')) return s;
  const parts = [];
  for (const m of s.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)) {
    parts.push(m[1]
      .replace(/_x([0-9A-Fa-f]{4})_/g, (x, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&(lt|gt|amp|quot|apos);/g, (x, name) => XML_ENTITIES[name]));
  }
  return parts.join('');
}

// Runs one command. Resolves { stdout, stderr, exitCode, timedOut }; never rejects for the
// command's own failure (that's in exitCode and stderr).
function runPowerShell(command, cwd, { timeoutMs = TIMEOUT_MS } = {}) {
  const script = `$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${command}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    // Kept a little past the limit, so clipping can say there was more.
    proc.stdout.on('data', (d) => { if (stdout.length <= MAX_OUTPUT) stdout += d; });
    proc.stderr.on('data', (d) => { if (stderr.length <= MAX_OUTPUT * 4) stderr += d; });
    const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: clip(stdout.replace(/\r\n/g, '\n').replace(/\n+$/, ''), MAX_OUTPUT),
        stderr: clip(decodeClixml(stderr).replace(/\r\n/g, '\n').replace(/\n+$/, ''), MAX_OUTPUT),
        exitCode: timedOut ? null : code,
        timedOut,
      });
    });
  });
}

module.exports = { runPowerShell, decodeClixml, TIMEOUT_MS };
