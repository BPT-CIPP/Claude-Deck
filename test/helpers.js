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
