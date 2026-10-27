'use strict';
// Installed-app support: find Claude Deck when it's installed as an Edge app (so it opens as its
// own taskbar app instead of an Edge window), and manage the start-with-Windows shortcut.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'Start-ClaudeDeck.ps1');

// Chromium's ID for an installed web app: SHA-256 of the manifest id (resolved to a full URL),
// first 16 bytes as hex, each hex digit mapped to a letter a-p.
function webAppId(manifestIdUrl) {
  const hex = crypto.createHash('sha256').update(manifestIdUrl).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function edgeUserData() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Microsoft', 'Edge', 'User Data');
}

// The Edge profile Claude Deck is installed in, or null. manifest id "/" resolves to the origin.
function findInstalledApp(port) {
  const appId = webAppId(`http://127.0.0.1:${port}/`);
  const root = edgeUserData();
  let profiles = [];
  try {
    profiles = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { appId, profile: null };
  }
  for (const profile of profiles) {
    if (fs.existsSync(path.join(root, profile, 'Web Applications', 'Manifest Resources', appId))) return { appId, profile };
  }
  return { appId, profile: null };
}

const TASK_NAME = 'Claude Deck';

// Older versions used a Startup-folder shortcut instead of the scheduled task.
function legacyStartupShortcut() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Claude Deck.lnk');
}

// True when the "Claude Deck" sign-in task (or the older startup shortcut) exists.
function startupEnabled() {
  return new Promise((resolve) => {
    execFile('schtasks.exe', ['/Query', '/TN', TASK_NAME], { windowsHide: true, timeout: 15000 }, (err) => {
      resolve(!err || fs.existsSync(legacyStartupShortcut()));
    });
  });
}

// The task's priority (0-10) from its XML; without a <Priority> it's Task Scheduler's default, 7.
// 7 and up run the server below normal CPU, I/O and memory priority, and everything it starts
// (chats, their MCP servers) inherits that. Start-ClaudeDeck.ps1 now registers it at 4; a task
// registered by an earlier version keeps 7 until it's registered again.
function taskPriority(xml) {
  const m = /<Priority>(\d+)<\/Priority>/.exec(String(xml || ''));
  return m ? Number(m[1]) : 7;
}

// The sign-in task's priority, or null when there's no task.
function startupPriority() {
  return new Promise((resolve) => {
    execFile('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/XML'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      resolve(err ? null : taskPriority(stdout));
    });
  });
}

// Registers or removes the sign-in task via the launcher script, so there is one implementation
// of the task details.
function setStartup(enabled) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, enabled ? '-InstallStartup' : '-RemoveStartup'], { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(startupEnabled());
    });
  });
}

module.exports = { webAppId, findInstalledApp, startupEnabled, startupPriority, taskPriority, setStartup, legacyStartupShortcut };
