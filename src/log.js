'use strict';
// Claude Deck's log, for working out afterwards what went wrong. The server runs without a window,
// so what it prints went nowhere; once install() has run, everything it prints is also written to
// <data folder>\logs\claude-deck.log, one entry per line with the local time and the server's pid
// (a restart briefly has two servers writing). Past MAX_BYTES the file moves to claude-deck.1.log,
// the older ones to .2 and .3, and the oldest goes: the log never takes more than about 4 MB.

const fs = require('fs');
const path = require('path');
const util = require('util');
const paths = require('./paths');

const MAX_BYTES = 1024 * 1024;
const KEEP = 3; // older files kept beside the current one

function logFile() {
  return path.join(paths.logsDir(), 'claude-deck.log');
}

// The dashboard's address carries this install's token (?t=...); a log is something people share.
const redact = (text) => text.replace(/([?&]t=)[0-9a-f]{16,}/gi, '$1<token>');

// 2026-10-27 11:42:03.120 -04:00: local time, as the person reading the log remembers it.
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const zone = `${off < 0 ? '-' : '+'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)} ${zone}`;
}

// Each file moves up one, replacing the next; the oldest is replaced, so gone.
function rotate(file) {
  const older = (i) => file.replace(/\.log$/, `.${i}.log`);
  for (let i = KEEP - 1; i >= 1; i--) {
    try { fs.renameSync(older(i), older(i + 1)); } catch { /* not there yet */ }
  }
  fs.renameSync(file, older(1));
}

// One entry; lines after the first are indented, so an entry's end is easy to see. Never throws:
// a log that can't be written mustn't stop anything else.
function write(level, args, file = logFile()) {
  const text = redact(util.format(...args)).replace(/\r?\n/g, '\n    ');
  const entry = `${stamp()} ${level.padEnd(5)} [${process.pid}] ${text}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* first entry */ }
    if (size && size + Buffer.byteLength(entry) > MAX_BYTES) {
      // Held open elsewhere: the entry still goes in, and the next one tries again.
      try { rotate(file); } catch { /* see above */ }
    }
    fs.appendFileSync(file, entry);
  } catch {
    // disk full, folder locked: carry on without
  }
}

// From here on, console.log, console.warn and console.error also go to the log, and so does an
// exception nothing caught (just before Node ends the process with it, as it would anyway).
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  for (const [name, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const print = console[name].bind(console);
    console[name] = (...args) => {
      print(...args);
      write(level, args);
    };
  }
  process.on('uncaughtExceptionMonitor', (err, origin) => write('FATAL', [`${origin}:`, err]));
}

module.exports = { install, write, logFile, redact, stamp, MAX_BYTES, KEEP };
