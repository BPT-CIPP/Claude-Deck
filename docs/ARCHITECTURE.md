# Architecture

How Claude Deck fits together, where each piece lives, and why the design constraints in
[CLAUDE.md](../CLAUDE.md) exist. For the undocumented Claude Code behavior it relies on, see
[CLAUDE-CODE-INTERNALS.md](CLAUDE-CODE-INTERNALS.md).

## The pieces

```
Edge app window ──HTTP + server-sent events (per-install token)──► node src/server.js (127.0.0.1 only)
                                                                     │        │         │
            chats: claude.exe in stream-json mode (stdin/stdout JSON) │        │         │ Windows Terminal tabs:
                                                                     │        │         │ wt.exe new-tab …
      terminals in the window: powershell src/pty-host.ps1 ──────────┘        │         ▼
        └─► conhost.exe --headless ─► claude.exe (keys in, screen out,        │   node src/tab-host.js ─► claude.exe
            drawn by xterm.js in the page)                                    │
                                                                              │
                    reads ~/.claude/sessions/<pid>.json   live status of every Claude process
                    reads ~/.claude/projects/*/*.jsonl    titles, prompts, transcripts, cost, checkpoints
```

- **The server** (`src/server.js`) is one Node process per user: an HTTP API, a server-sent-events
  stream that pushes state to the page, and the static files in `public/`. It listens on
  `127.0.0.1:47821`, or any free port if that one is taken, and writes its pid and port to
  `runtime.json` so a second copy can find it and exit with code 3.
- **Chats** (`src/chat.js`) are `claude.exe` child processes of the server, driven over stdin and
  stdout with Claude Code's streaming JSON protocol, the one the Agent SDK uses. That's why chats end
  when the server stops, and why the server stays up while any chat is open.
- **Terminals in the window** (`src/terminals.js`) run `claude.exe` with its full terminal interface
  inside the dashboard: Windows' own `conhost.exe --headless` is the pseudo-console (the same thing
  Windows Terminal uses underneath), started by a small Windows PowerShell script
  (`src/pty-host.ps1`) that inherits the server's pipes to it, holds the pipe conhost takes window
  resizes on, and reports conhost's and Claude's pids back over a named pipe. Keystrokes go down
  the pipe, the screen comes back as VT sequences, and the page draws it with xterm.js
  (`public/vendor/xterm`). The last 512 KB of output is kept, so a page that connects again sees the
  screen as it is. *Run here as* in Preferences makes these what "here in Claude Deck" starts. Like
  chats, they're children of the server and end when it stops, and like chats they stay listed as
  ended (`terminals.json`), to resume or remove.
- **Terminal sessions** (`src/launcher.js`) open a Windows Terminal tab running `src/tab-host.js`,
  which starts `claude.exe` with the full terminal interface. The launch spec (command, args, env)
  goes to the tab through a JSON file, so paths with spaces, quotes or `;` arrive exactly as
  entered. The tab host reports Claude's pid and session id back through `tabs/`.
- **Live status** (`src/live.js`) joins chats, the terminal registry, tab status and Claude Code's
  own `sessions/<pid>.json` records into one state, and raises notify events (needs you, finished).
  Claude processes that Claude Deck didn't start show up as outside sessions.
- **History** (`src/history.js`) indexes every transcript incrementally (only what's new since the
  last pass) and caches the index in `history-cache.json`.
- **The page** (`public/`) is plain scripts on `window.Deck` with no framework and no build:
  `lib.js` (helpers), `app.js` (session list and detail, chat, history, palette, preferences),
  `settings-ui.js` (the Claude Code Settings editor), `markdown.js` (reads the Markdown in replies),
  `pasted-text.js` (long pastes in the reply box), `tour.js` (the first-launch guided tour),
  `spinner-verbs.js` and `tick-worker.js`.

## Code layout

```
Start-ClaudeDeck.ps1    launcher; -Install / -Uninstall; the sign-in task and its -Service supervisor loop
src/server.js           HTTP API + events + static files; single instance via runtime.json
src/chat.js             in-app chats: stream-json, permission/question answers, images, queue vs
                        interrupt-and-send, subagent (task_*) tracking, model, effort and permission
                        mode, plugin reloads, sleep left out of working time; the terminal's own
                        features (MCP servers, @ files, /btw, Ctrl+B, Esc Esc rewind, plan approval,
                        thinking, edit diffs, the to-do list, fast mode)
src/terminals.js        terminals in the window: Claude Code's own interface over conhost --headless (keys in,
                        screen out, resize, replay for a page that connects again), ended with Ctrl+C twice
src/pty-host.ps1        Windows PowerShell 5.1: starts conhost --headless with the signal pipe for resizes, finds
                        Claude's pid, relays resize and kill from the server over a named pipe
src/shell-mode.js       a chat's !command, in Windows PowerShell
src/prompt-history.js   Ctrl+R: Claude Code's own prompt history (history.jsonl, paste cache), read only
src/live.js             joins chats + terminal registry + tab status + sessions/<pid>.json; notify events
src/history.js          incremental transcript indexer (titles, cost, token usage by hour, context
                        size; subagent transcripts on request) + transcript reader
src/history-folders.js  History's folder view: which folder each conversation is filed under (its cwd, or where it was dragged),
                        and the names folders are shown under
src/launcher.js         claude argument building, model aliases, wt.exe new-tab / focus-tab, close / resume
src/tab-host.js         runs inside each Windows Terminal tab; starts claude, reports pid and session id
src/settings-files.js   Claude settings and CLAUDE.md: read, write (backup first), restore
src/plugins.js          plugins and marketplaces, through Claude Code's own `claude plugin ... --json`
src/folders.js          directory listing and new-folder for the in-app folder picker
src/timeline.js         change timeline: files per turn from Claude's file checkpoints, diffs, restore, undo
src/trash.js            deleting a conversation: moves its files to the trash, Undo, 30-day purge
src/subagents.js        reads a subagent's own transcript as it grows: steps, model, token usage
src/usage.js            plan usage limits (the one automatic outbound request; the sign-in token is read-only)
src/billing.js          billing guard: refuses sessions that would bill an API or cloud account
src/update.js           Check for updates: git fetch (sign-in, if GitHub asks, through `gh auth git-credential`),
                        fast-forward a clean main; installs a missing Git or GitHub CLI with winget when asked
src/app-install.js      finds the installed Edge app; sign-in task status and toggle
src/models.js           the model menus: Claude Code's own model list (versions), kept per Claude Code version
src/claude-locate.js    finds claude.exe; its version, auto-update status and `claude update`
src/claude-config.js    a chat's Config window: Claude Code's /config options (its own list), current values (read only)
src/prefs.js, registry.js, paths.js, util.js
public/                 index.html, app.css, lib.js, markdown.js, pasted-text.js, app.js, settings-ui.js,
                        tour.js, spinner-verbs.js, tick-worker.js, manifest.webmanifest, sw.js, offline.html, icons/, vendor/
public/vendor/xterm/    xterm.js 6.0.0 and its fit addon (MIT), the terminal in the window; refresh from npm's
                        @xterm/xterm and @xterm/addon-fit tarballs (lib/xterm.js, css/xterm.css, lib/addon-fit.js)
tools/check-syntax.js   parses every .js file, and Start-ClaudeDeck.ps1 with Windows PowerShell 5.1
tools/sandbox.js        a throwaway Claude Deck against a mock API, for testing (see TESTING.md)
tools/make-icons.js     generates public/icons/*.png and claude-deck.ico (pure Node)
tools/changelog.js      checks CHANGELOG.md has the package.json version; prints a version's notes
tools/release-manifest.js  every file in a release with its SHA-256; checks a copy against it
test/*.test.js          node:test suite; test/helpers.js sandboxes CLAUDE_CONFIG_DIR and CLAUDE_DECK_DATA
test/fixtures/          fake-claude.js (terminal, stream-json and plugin modes), mock-anthropic-api.js
```

## Why it's built this way

- **No npm dependencies, no new executables.** Managed Windows PCs commonly run Microsoft Defender's
  attack surface reduction rule that blocks executables that aren't prevalent, and a user can't make
  exceptions. Electron and node-pty were tried and blocked. Everything runs on `node.exe`, `wt.exe`,
  Edge, `claude.exe` and Windows built-ins (`explorer.exe`, `powershell.exe` (also to check a
  process's start time before ending an outside session, and to run a chat's `!` commands, rather
  than Git Bash, whose helpers that rule blocks), `schtasks.exe`, `where.exe`, `reg.exe`
  (the billing guard reads Windows' stored environment and the Claude Code policy key),
  `taskkill.exe` (to end a `!` command that ran out of time along with everything it started),
  `choice.exe` for the tab host's resume prompt, and `conhost.exe --headless`, which the sign-in task
  runs its PowerShell supervisor under: `-WindowStyle Hidden` doesn't hide a console that Windows
  Terminal hosts, as it does when Terminal is the default terminal app). `-Install` runs `winget.exe`
  (part of Windows' App Installer) only to install a missing Node.js or Windows Terminal, and Claude
  Code's own installer for a missing Claude Code, each after the user says yes. *Check for updates* also runs `git`; the
  repository is public, so that's all it needs. If GitHub asks for a sign-in anyway (a private
  fork), git signs in through the GitHub CLI (`gh auth git-credential`, by its full path, as the
  only credential helper). A missing Git, or a missing GitHub CLI when GitHub asked for a sign-in,
  is offered for install in the page, and `winget.exe` installs it (`Git.Git`, `GitHub.cli`) only
  after the user chooses Install. A server started before the install still has its old PATH, so
  `src/update.js` also looks where winget puts them. In-app
  chats are possible because Claude's streaming JSON mode needs only pipes, not a terminal.
  Terminals in the window need a pseudo-console, and Node has none built in: `node-pty` was the
  blocked executable. Windows' own `conhost.exe --headless -- <command>` is one, though: it reads
  keystrokes from its stdin and writes the screen to its stdout as VT sequences, both plain pipes,
  and a client started that way sees a real console. The one thing a pipe can't carry is the
  handle conhost takes window resizes on (`--signal`), so `src/pty-host.ps1` creates that pipe with
  .NET's own `AnonymousPipeServerStream` (inheritable), starts conhost with it, and relays resizes
  from the server over a named pipe; nothing is compiled or installed. In the page, the screen is
  drawn by xterm.js, vendored as plain files (`public/vendor/xterm`); it adds `<style>` elements
  for its colors and cell sizes, which is why the page's content security policy allows inline
  styles (scripts stay the server's own, and the page never uses `innerHTML`).
- **No Claude API calls.** Everything shown is read from files Claude Code writes, and what the user
  types is relayed to their own `claude` process, so Claude Deck adds no cost. The plan usage meter
  is one outbound request it makes on its own: account metadata, no model runs. The other is the
  update check: when the window opens (silent on any failure, `checkForUpdatesAtLaunch` in
  `public/app.js`) and when *Check for updates* is clicked, it fetches from GitHub for a clean
  `main` clone only, and updates only after the user says yes.
- **A scheduled task, not a Windows service.** The server has to run as the signed-in user in their
  desktop session, to use their Claude sign-in and open Windows Terminal tabs and Edge windows. A
  service runs elsewhere, as another account, and would need a wrapper executable. The task runs
  `Start-ClaudeDeck.ps1 -Service`, which supervises the server by its exit code: 0 = stopped on
  purpose (stay stopped), 3 = another copy is running (wait and take over), anything else = crash
  (restart after 10 seconds, give up after 5 crashes in 10 minutes). *Restart server* starts a
  replacement (`--replace <pid>`, same port) that waits for the old server to exit, and the old one
  exits with 3, so the supervisor keeps watching the replacement and takes over if it fails.
- **No native dialogs.** Windows won't let the hidden background server bring a window to the front,
  so a native dialog would open behind the dashboard. The folder picker is built in-app
  (`src/folders.js` and `pickFolder()` in `app.js`); build any new picker the same way.
- **An installable web app.** Opened as a plain Edge window, a taskbar pin turns into Edge. Installed
  from its manifest, Claude Deck gets its own name, icon and taskbar button. The service worker only
  serves an offline page for when the server is stopped.

## Security

- The server listens on `127.0.0.1` only, and refuses requests whose `Host` isn't `127.0.0.1` or
  `localhost` on its port (DNS rebinding).
- Every API call needs a per-install token (`secret.json`) in an `x-deck-token` header; the event
  stream takes it as a query parameter, since `EventSource` can't send headers. Other web pages can't
  read the token, so they can't drive the server.
- The page never uses `innerHTML`. Transcript and chat text is untrusted, and all DOM is built with
  `Deck.h()`.

## Where things are stored

Claude Deck's own data is in `%LOCALAPPDATA%\ClaudeDeck\` (or `CLAUDE_DECK_DATA`): `prefs.json`,
`registry.json` (terminal sessions it launched), `chats.json` (open chats), `tabs\` (tab host status),
`terminals.json` (terminals in the window, listed again as ended after a restart), `terminals\`
(their launch specs, each removed when its run ends),
`history-cache.json`, `history-folders.json` (conversations moved to another folder in History's
folder view), `history-folder-names.json` (names given to folders there; the folders on disk aren't
renamed), `models.json` (Claude Code's model list and the version it came from),
`backups\` (the last 30 versions of each settings file), `rewinds\` (files as
they were before each of the last 20 restores, for Undo), `trash\` (deleted conversations, removed for
good after 30 days), `attachments\<chat id>\` (copies of files dropped on a chat's reply box, which
Claude reads by path; removed with the chat, or at start-up once the chat is no longer listed),
`secret.json` (the API token) and `runtime.json` (the
running server's pid and port).

Claude Code's files live in `%USERPROFILE%\.claude\` (or `CLAUDE_CONFIG_DIR`). Claude Deck writes
there only through the settings editor (`src/settings-files.js`: backup first, refused if the file
changed since it was opened) and when deleting a conversation from History (`src/trash.js`: moved to
the trash, never deleted outright). "Always allow" answers to permission prompts are saved by Claude
Code itself.
