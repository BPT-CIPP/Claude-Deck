'use strict';
// Sessions launched by Claude Deck, persisted so the dashboard can be closed and reopened
// without losing track of tabs that are still running.

const path = require('path');
const paths = require('./paths');
const { readJson, writeJsonAtomic } = require('./util');

class Registry {
  constructor(file) {
    this.file = file || path.join(paths.dataDir(), 'registry.json');
    const stored = readJson(this.file, []);
    this.entries = new Map((Array.isArray(stored) ? stored : []).filter((e) => e && e.id).map((e) => [e.id, e]));
  }

  all() {
    return [...this.entries.values()].sort((a, b) => a.launchedAt - b.launchedAt);
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  add(entry) {
    this.entries.set(entry.id, entry);
    this.save();
    return entry;
  }

  update(id, patch) {
    const e = this.entries.get(id);
    if (!e) return null;
    Object.assign(e, patch);
    this.save();
    return e;
  }

  remove(id) {
    if (this.entries.delete(id)) this.save();
  }

  save() {
    writeJsonAtomic(this.file, this.all());
  }
}

module.exports = { Registry };
