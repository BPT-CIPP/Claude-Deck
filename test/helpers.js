'use strict';
// Point Claude Deck at throwaway folders so tests never touch the real ~/.claude or app data.

const fs = require('fs');
const os = require('os');
const path = require('path');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-deck-test-'));
  const claudeDir = path.join(root, 'claude');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'tabs'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CLAUDE_DECK_DATA = dataDir;
  // Tests never reach Anthropic; an API key on the developer's PC shouldn't trip the billing guard,
  // whether it's in this process's environment, Windows' stored one or managed settings.
  for (const name of require('../src/billing').BILLING_VARS) delete process.env[name];
  process.env.CLAUDE_DECK_SKIP_SYSTEM_SETTINGS = '1';
  // No looking up Claude Code's newest release on npm (src/server.js checkLatestClaude); servers
  // the tests start inherit this.
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return {
    root,
    claudeDir,
    dataDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const line = (o) => `${JSON.stringify(o)}\n`;

module.exports = { sandbox, line };
