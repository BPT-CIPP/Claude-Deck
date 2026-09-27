'use strict';
// Small shared helpers: JSON files, atomic writes, process liveness, argument parsing.

const fs = require('fs');
const path = require('path');

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return fallback;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Write to a temp file, then rename over the target so readers never see a half-written file.
// Rename is retried because Windows briefly locks files that another process has open. A symbolic
// link is written through (to the file it points at), so the link itself stays a link.
function writeFileAtomic(target, text) {
  let file = target;
  try { file = fs.realpathSync(target); } catch { /* doesn't exist yet */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        throw err;
      }
      sleepSync(40 * (attempt + 1));
    }
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Split a command-line fragment into arguments. Double quotes group words; \" is a literal quote.
function parseArgString(input) {
  const args = [];
  let current = '';
  let inQuotes = false;
  let hasToken = false;
  const s = String(input || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '"') {
      current += '"';
      hasToken = true;
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (hasToken) args.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (inQuotes) throw new UserError('Extra arguments have an unclosed double quote.');
  if (hasToken) args.push(current);
  return args;
}

function clip(text, max) {
  if (typeof text !== 'string') return text;
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

module.exports = {
  readText,
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
  isPidAlive,
  parseArgString,
  clip,
  UserError,
};
