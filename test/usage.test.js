'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { UsageMonitor, normalizeUsage } = require('../src/usage');

// Shape returned by /api/oauth/usage (claude.exe 2.1.281), trimmed.
const SAMPLE = {
  five_hour: { utilization: 29.0, resets_at: '2026-09-24T17:50:00-04:00' },
  seven_day: { utilization: 53.0, resets_at: '2026-09-26T07:00:00-04:00' },
  limits: [
    { kind: 'session', group: 'session', percent: 29, severity: 'normal', resets_at: '2026-09-24T17:50:00-04:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 53, severity: 'normal', resets_at: '2026-09-26T07:00:00-04:00', scope: null, is_active: true },
    { kind: 'weekly_model', group: 'weekly', percent: 91, severity: 'warning', resets_at: '2026-09-26T07:00:00-04:00', scope: { model: { display_name: 'Opus' } }, is_active: false },
  ],
};

test('normalizes the limits list', () => {
  const l = normalizeUsage(SAMPLE);
  assert.deepStrictEqual(l.map((x) => [x.name, x.percent, x.severity]), [['Session', 29, 'normal'], ['Week', 53, 'normal'], ['Week (Opus)', 91, 'warning']]);
  assert.strictEqual(l[0].resetsAt, Date.parse('2026-09-24T17:50:00-04:00'));
  assert.strictEqual(l[1].active, true);
});

test('falls back to five_hour / seven_day when there is no limits list', () => {
  const l = normalizeUsage({ five_hour: SAMPLE.five_hour, seven_day: { utilization: 100, resets_at: null } });
  assert.deepStrictEqual(l.map((x) => [x.name, x.percent, x.severity]), [['Session', 29, 'normal'], ['Week', 100, 'critical']]);
});

test('reads with the token, keeps the last reading when a later check fails', async () => {
  let t = 1000;
  let fail = false;
  const tokens = [];
  const m = new UsageMonitor({
    now: () => t,
    credentials: () => ({ accessToken: 'tok', expiresAt: 10_000_000 }),
    fetcher: async (tok) => { tokens.push(tok); if (fail) throw new Error('offline'); return SAMPLE; },
  });
  let s = await m.refresh(true);
  assert.strictEqual(s.status, 'ok');
  assert.strictEqual(s.limits.length, 3);
  assert.deepStrictEqual(tokens, ['tok']);

  t += 1000;
  s = await m.refresh();
  assert.strictEqual(tokens.length, 1, 'checks are spaced at least a minute apart unless forced');

  fail = true;
  s = await m.refresh(true);
  assert.strictEqual(s.status, 'stale');
  assert.strictEqual(s.limits.length, 3, 'last reading kept');
  assert.match(s.message, /offline/);
});

test('an expired token is not sent; no sign-in means unavailable', async () => {
  let called = false;
  const expired = new UsageMonitor({ now: () => 5000, credentials: () => ({ accessToken: 'old', expiresAt: 4000 }), fetcher: async () => { called = true; return SAMPLE; } });
  const s = await expired.refresh(true);
  assert.strictEqual(called, false);
  assert.strictEqual(s.status, 'unavailable');
  assert.match(s.message, /expired/);

  const none = new UsageMonitor({ credentials: () => null, fetcher: async () => { throw new Error('should not be called'); } });
  assert.strictEqual((await none.refresh(true)).status, 'unavailable');
});
