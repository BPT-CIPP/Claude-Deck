'use strict';
// Plan usage limits (the numbers Claude Code's /usage shows): the 5-hour session window and weekly
// limits, as a percentage with reset times.
//
// Claude Code gets these from GET https://api.anthropic.com/api/oauth/usage with the signed-in
// account's OAuth token (verified against claude.exe 2.1.281). It's an account-metadata call:
// no model runs and no tokens are spent. The token is read from <claudeDir>/.credentials.json and
// never refreshed or written here; Claude Code refreshes it while any session runs.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const paths = require('./paths');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const POLL_MS = 5 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000;

function readCredentials() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(paths.claudeDir(), '.credentials.json'), 'utf8'));
    const o = raw && raw.claudeAiOauth;
    if (!o || typeof o.accessToken !== 'string') return null;
    return { accessToken: o.accessToken, expiresAt: Number(o.expiresAt) || null, subscriptionType: o.subscriptionType || null };
  } catch {
    return null;
  }
}

function label(l) {
  const model = l.scope && l.scope.model && l.scope.model.display_name;
  if (l.group === 'session' || l.kind === 'session') return { name: 'Session', long: 'Current 5-hour session' };
  if (l.group === 'weekly' || /^weekly/.test(l.kind || '')) {
    return model ? { name: `Week (${model})`, long: `This week, ${model}` } : { name: 'Week', long: 'This week, all models' };
  }
  return { name: String(l.kind || 'Limit'), long: String(l.kind || 'Limit') };
}

// The response's "limits" list is what /usage renders. Older responses only had five_hour /
// seven_day objects, so fall back to those.
function normalizeUsage(json) {
  const out = [];
  if (json && Array.isArray(json.limits) && json.limits.length) {
    for (const l of json.limits) {
      if (!l || typeof l.percent !== 'number') continue;
      const { name, long } = label(l);
      out.push({ kind: String(l.kind || ''), name, long, percent: Math.round(l.percent), severity: String(l.severity || 'normal'), resetsAt: l.resets_at ? Date.parse(l.resets_at) || null : null, active: l.is_active === true });
    }
  } else if (json) {
    for (const [key, name, long] of [['five_hour', 'Session', 'Current 5-hour session'], ['seven_day', 'Week', 'This week, all models']]) {
      const w = json[key];
      if (w && typeof w.utilization === 'number') out.push({ kind: key, name, long, percent: Math.round(w.utilization), severity: w.utilization >= 100 ? 'critical' : 'normal', resetsAt: w.resets_at ? Date.parse(w.resets_at) || null : null, active: false });
    }
  }
  return out;
}

function fetchUsage(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.get(USAGE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`the usage service answered ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('the usage service sent something unexpected')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('the usage service did not answer in time')));
    req.on('error', reject);
  });
}

// Holds the latest reading and refreshes it on a timer. `fetcher` and `credentials` can be
// swapped out in tests so they never reach Anthropic.
class UsageMonitor extends EventEmitter {
  constructor({ fetcher = fetchUsage, credentials = readCredentials, now = Date.now } = {}) {
    super();
    this.fetcher = fetcher;
    this.credentials = credentials;
    this.now = now;
    this.state = { status: 'loading', limits: [], fetchedAt: null, message: null };
    this.inflight = null;
    this.lastAttempt = 0;
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  refresh(force) {
    if (this.inflight) return this.inflight;
    if (!force && this.now() - this.lastAttempt < MIN_GAP_MS) return Promise.resolve(this.state);
    this.lastAttempt = this.now();
    this.inflight = this._refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async _refresh() {
    const creds = this.credentials();
    if (!creds) {
      return this._set({ status: 'unavailable', limits: [], fetchedAt: null, message: 'Plan limits need a Claude account sign-in. API-key setups have no plan limits to show.' });
    }
    if (creds.expiresAt && creds.expiresAt < this.now()) {
      // Keep the last reading; Claude Code refreshes the token the next time a session runs.
      return this._set({ ...this.state, status: this.state.limits.length ? 'stale' : 'unavailable', message: 'Your Claude sign-in token has expired. It renews the next time a Claude session runs.' });
    }
    try {
      const limits = normalizeUsage(await this.fetcher(creds.accessToken));
      return this._set({ status: limits.length ? 'ok' : 'unavailable', limits, fetchedAt: this.now(), message: limits.length ? null : 'Your plan reports no usage limits.' });
    } catch (err) {
      return this._set({ ...this.state, status: this.state.limits.length ? 'stale' : 'unavailable', message: `Couldn't check plan usage: ${err.message}.` });
    }
  }

  _set(state) {
    this.state = state;
    this.emit('usage', state);
    return state;
  }
}

module.exports = { UsageMonitor, normalizeUsage, readCredentials, USAGE_URL };
