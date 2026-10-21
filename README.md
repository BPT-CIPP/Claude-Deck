# Claude Deck

One window for all your Claude Code sessions on Windows. Start sessions in any folder, see what
every session is doing at a glance, reply to them, approve what they want to do, watch their
subagents, review and undo the files they changed, and pick up old conversations from history. It
also edits your Claude Code settings.

- **No extra cost.** Claude Deck never calls the Claude API. Everything it shows comes from files
  Claude Code already writes, and your sessions run your own `claude` with your sign-in, so they use
  your plan exactly as any Claude Code session does.
- **Nothing extra to install.** No npm packages, no new executables. It runs on Node.js, Windows
  Terminal, Microsoft Edge, Git and your existing Claude Code, so it works on managed PCs that block
  unfamiliar executables.
- **Private to your PC.** It listens on `127.0.0.1` only, behind a per-install token.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Pin it to the taskbar](#pin-it-to-the-taskbar)
- [Update](#update)
- [Uninstall](#uninstall)
- [Using Claude Deck](#using-claude-deck)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Cost, privacy and your files](#cost-privacy-and-your-files)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)
- [Contributing](#contributing)
- [License](#license)

## Requirements

| Needed | Why | Get it |
|---|---|---|
| **Windows 10 or 11** | Claude Deck is Windows-only | |
| **Node.js 22 or newer**, on PATH | runs the Claude Deck server | [nodejs.org](https://nodejs.org) (LTS), or `winget install OpenJS.NodeJS.LTS` |
| **Claude Code**, signed in | the sessions themselves | [Claude Code docs](https://code.claude.com/docs). Check that `claude` works in a terminal first. |
| **Windows Terminal** | sessions you run in a terminal tab (in-app chats work without it) | built into Windows 11; otherwise `winget install Microsoft.WindowsTerminal` |
| **Microsoft Edge** | the app window and taskbar pin (otherwise it opens in your default browser) | built into Windows |
| **Git** | to download and update Claude Deck | `winget install Git.Git` |
| **GitHub CLI**, signed in | only for **Check for updates** (Git signs in to GitHub through it) | `winget install GitHub.cli`, then `gh auth login` |

No administrator rights are needed on a standard Windows setup. Tested with Claude Code 2.1.284 and
Node.js 24 on Windows 11. Newer Claude Code versions usually work; see
[Troubleshooting](#troubleshooting) if something stops updating.

## Install

1. **Download it.** In PowerShell, from the folder you want it in (anywhere you like, for example
   your user folder):
   ```powershell
   git clone https://github.com/BPT-CIPP/Claude-Deck.git
   cd Claude-Deck
   ```
2. **Run the installer**, as the Windows user who will use Claude Deck:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Start-ClaudeDeck.ps1 -Install
   ```
   It checks for Node.js 22+, Windows Terminal, Claude Code and Edge. It offers to install a missing
   Node.js or Windows Terminal with `winget`, and a missing Claude Code with its official installer;
   a missing Edge gets a warning. If Claude Code isn't signed in, it starts Claude Code's sign-in
   (`claude auth login`) so you can finish it in your browser. Then it:
   - creates **Start Claude Deck** shortcuts on the desktop and in the Start menu;
   - registers a **Claude Deck** scheduled task that starts the server when you sign in, as you;
   - starts the server and opens the dashboard, with a short guided tour the first time.
3. **Install it as an app and pin it** (next section), so it gets its own taskbar icon.

The shortcuts and the sign-in task point at the folder you installed from. If you move the folder,
run the installer again from the new location.

**About the sign-in task.** A scheduled task, not a Windows service, because the server has to run
as you in your desktop session to use your Claude sign-in and open terminal tabs and Edge windows.
It restarts the server if it crashes (giving up after 5 crashes in 10 minutes), and leaves it
stopped if you stop it on purpose. It runs with no window: PowerShell under Windows' own console
host (`conhost.exe --headless`), since a hidden PowerShell window still shows as a Windows Terminal
tab when Terminal is your default terminal app. Some managed PCs restrict scheduled tasks, and some
security tools flag a new hidden PowerShell task at sign-in; tell your IT team before rolling Claude
Deck out. You can skip the task entirely and just use the shortcut ([Troubleshooting](#troubleshooting)).

## Pin it to the taskbar

Opened as a plain Edge window, a taskbar pin turns into Edge. Installed as an app, Claude Deck gets
its own name, icon and taskbar button:

1. Open **Claude Deck Preferences → Taskbar app → Install Claude Deck**. If that button isn't
   offered, choose **Open in Edge to install**, then in that Edge tab select the install icon at the
   right end of the address bar (or **…** → **Apps** → **Install Claude Deck**).
2. Right-click the Claude Deck taskbar icon → **Pin to taskbar**.
3. Keep **Start with Windows** on (same section; the installer turns it on), so the server is running
   whenever you click the pin. If it isn't, the app shows *Claude Deck isn't running* with how to
   start it.

After that, the shortcuts and `Start-ClaudeDeck.ps1` open the installed app too.

## Update

Claude Deck checks for a newer version each time its window opens. If GitHub has one, it asks
**Update found: would you like to update Claude Deck now?**, and if you say yes, gets it and
restarts on it. If the check can't run (no access to the repository, no GitHub CLI, offline, or a
copy that isn't updated from here), it says nothing and Claude Deck carries on. To check right away,
and to see why a check fails, choose **Claude Deck Preferences → Dashboard → Check for updates**.
If GitHub has a newer version, Claude Deck asks, gets it and restarts on it. It needs the GitHub CLI signed in (`gh auth login`), and it only
updates a copy on `main` with no changes of its own; otherwise it leaves the copy alone and gives
the command to update it by hand (with **Copy command**). To update by hand anyway:

```powershell
cd <your Claude-Deck folder>
git pull
```

Then choose **Claude Deck Preferences → Dashboard → Restart server**: the server stops, starts again
and the window reloads, with no need to reopen anything. (**Stop server now** stops it until you
start it again with the **Start Claude Deck** shortcut or `Start-ClaudeDeck.ps1`, or next sign in.
The taskbar pin opens the app window but can't start the server.) Open chats end
when the server stops; they come back as *Ended*, and **Resume** (or Enter) continues them. If an update only changed the page itself, reloading the window (Ctrl+R) is enough.

**Checking a copy.** Each [release](https://github.com/BPT-CIPP/Claude-Deck/releases) has a
`claude-deck-vX.Y.Z-manifest.json` listing every file with its size and SHA-256. To confirm a
folder holds exactly that release (**Claude Deck Preferences → Dashboard → Version** shows which one you're running),
download the manifest and run, from the folder:

```powershell
node tools\release-manifest.js verify <path to the manifest>
```

It names any file that's missing or different. Files that aren't part of Claude Deck (logs, your
`CLAUDE.local.md`) are ignored. A clone of `main` can be ahead of the latest release; to check one
release exactly, `git checkout vX.Y.Z` first.

### Updating Claude Code

Claude Code updates itself in the background, and Claude Deck uses whichever version is installed.
**Claude Deck Preferences → Claude Code** shows the version, whether it updates itself (it doesn't
if `DISABLE_AUTOUPDATER` or `DISABLE_UPDATES` is set) and **Update Claude Code now**, which runs
Claude Code's own `claude update` to check right away. Open chats keep the version they started
with; resume them to use the new one. New models (a new Sonnet, say) appear in the model menus once
Claude Code has updated.

## Uninstall

From your Claude-Deck folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-ClaudeDeck.ps1 -Uninstall
```

This stops the server and removes the sign-in task and the shortcuts. It keeps your Claude Deck data
(`%LOCALAPPDATA%\ClaudeDeck`; delete that folder to remove it too) and never touches Claude Code's
own files. If you installed the app from Edge, remove it from `edge://apps`. Then delete the
Claude-Deck folder.

## Using Claude Deck

New to Claude Code? The first time Claude Deck opens, a two-minute guided tour lights up each part
of the page and explains it. Take it again any time from **Claude Deck Preferences → Dashboard →
Take the tour**, or **Ctrl+K → Take the guided tour**.

Each session runs one of two ways, your choice when you start it:

- **Chat in Claude Deck** (the default). Claude runs inside Claude Deck. You read and reply in the
  dashboard, answer permission prompts and questions, stop a turn, or switch model or permission
  mode, then pick another session from the list.
- **Windows Terminal tab.** The full terminal interface, one tab per session in a shared window.
  The dashboard tracks it, and **Open terminal** brings its tab forward.

Either kind can switch to the other (**Continue in terminal** / **Continue here**) and keep the same
conversation. Claude sessions you started elsewhere show up too, and **Continue here** takes them
over.

| Area | What you get |
| --- | --- |
| **Sessions** | The session list on the left, grouped by what each needs: *Needs you* (a permission prompt or question), *Working*, *Idle*, *Ended*. The selected session is in full on the right; an ended chat shows its conversation so far, even after Claude Deck restarts. The trash button on a row ends the session, or removes it once it has ended. |
| **Chat** | Each reply appears whole once Claude has finished it, with its Markdown laid out as Claude Code's terminal shows it (headings, lists, tables, quotes, rules, code blocks, bold, italics and links), while a spinner (with Claude Code's playful verbs and the elapsed time) shows it's working. Tool calls expand to show their input and result. **Enter** sends and **Shift+Enter** adds a line. A long paste (over 800 characters, or more than two line breaks) shows as *[Pasted text #1 +123 lines]*, as in Claude Code, and the full text is sent; paste it again straight after to expand it in the box. Your message in the conversation shows the placeholder too (click it to show the text), and **Claude** marks where Claude's side starts. While Claude works, **Enter** queues your message (marked *Queued* until Claude picks it up) and **Interrupt** stops Claude and sends it now. As in Claude Code's terminal, **↑** in an empty reply box takes queued messages back out of the queue to edit (images included), or otherwise brings back your previous messages, for example the one you just interrupted; **↓** steps forward again. Above the title: the status, how many subagents are running, the folder (copy it, or open it in Explorer) and the session ID. **▾** beside the title opens the session menu: **Rename**, **Tag color**, **Changes**, **Continue in terminal**, **Subagents** and **Config…**, which shows Claude Code's `/config` options (theme, editor mode, auto-compact and the rest) with their current values and changes them through the chat's own Claude Code. One row below changes the model, effort, permission mode, plugins and MCP servers (taking effect from Claude's next step), and shows *Context* (how full Claude's context window is, with **Compact** to summarize the conversation so far), *Current cost* and *Current total tokens* (both for the current conversation, which `/clear` starts afresh), with **End session** at the end. Each finished reply shows how long it took and the tokens it used, including how many were its subagents'. |
| **Slash commands** | Type **/** anywhere in the reply box, as in Claude Code, to list the session's commands and skills; **Enter**, **Tab** or a click fills one in (a command typed out in full is sent). A command at the start of a message runs as a command; one later in the message asks Claude to run it. `/clear` starts a new conversation and, as Claude Code clears its screen, also clears the chat's messages (queued messages stay, and **↑** still recalls your earlier ones). Turn that off under **Claude Deck Preferences → Appearance → /clear**. |
| **Models** | The model menu (in a chat's header, New session and Claude Code Settings) has a flyout for each model, named with its version as your Claude Code reports it: *Opus 5.5 ▸*, *Sonnet 5.5 ▸*, *Fable 5.1 ▸*, *Haiku 4.5 ▸*. Each lists first the choices that follow the newest version: the latest (for example `sonnet`, which moves to the next Sonnet when Claude Code does), the latest with a 1M-token context, and for Opus, Opus while planning. Under *Specific versions* come the versions by model ID, newest first (`claude-opus-5-5`, `claude-opus-4-8`, …), which stay on that version; hover one for its name. **Other model ID…** takes any other. New models appear once Claude Code has updated ([Updating Claude Code](#updating-claude-code)). |
| **Plugins** | **Plugins** in a chat's header lists Claude Code's plugins. *Installed* has a checkbox to turn each one on or off; *Marketplace* lists what your marketplaces offer, grouped by the categories the marketplace gives them (Database, Development, Productivity and so on), with search and **Install**. Changes apply to all your Claude Code sessions, as `/plugin` does, and the chat you're in picks them up right away. If a change would reset Claude's prompt cache mid-conversation (a plugin that adds tools), you're asked first. A plugin that installs by running a command shows you the command before anything runs. |
| **Terminal keys** | The reply box works like Claude Code's prompt. **@** lists files in the chat's folder. **!command** runs a command at once in PowerShell, in the chat's folder, and Claude sees it and its output with your next message. **/btw question** asks Claude something aside, answered above the reply box and kept out of the conversation. **Shift+Tab** steps through ask before edits, accept edits and plan mode; at the end of plan mode Claude's plan is shown in full to approve (with or without asking before each edit) or send back. **Ctrl+B** sends what Claude is waiting on to the background (listed above the reply box, with Stop). **Esc Esc** goes back to before one of your messages, optionally putting files back too, and returns that message to the reply box; the conversation as it was stays in History. **Ctrl+R** searches your earlier prompts from Claude Code's own prompt history. Claude Code's suggested next prompt, when it offers one, shows in the empty box (**Tab** takes it). In the conversation, edits show their diff and thinking shows as a collapsed line; Claude's to-do list shows above the reply box when Claude Code has its to-do tools on. **Fast mode** in the header is billed as extra usage on top of your plan, so it needs **Allow API billing**. |
| **MCP servers** | **MCP servers** in a chat's header says how many of the chat's MCP servers are connected, and lists them as `/mcp` does: each one's status (*Connected*, with how many tools and the server's version; *Connecting…*; *Failed*, with why; *Needs sign-in*; *Off*) and where it's set up (user, project, claude.ai, a plugin). The checkbox turns a server on or off; like `/mcp`, Claude Code remembers that for the folder, so new sessions there start the same way. **Reconnect** tries a failed server again, and **Sign in** opens the sign-in page of a server that needs it; the list updates once it connects. |
| **Images and files** | Paste images with **Ctrl+V** or **Alt+V** (as in Claude Code), drop image files on the reply box, or use **Image**. Large images are scaled down to fit the API's limits. Drop any other file (a PDF, say, up to 40 MB) on the reply box and its path goes in your message at the cursor, as dropping a file into Claude Code's terminal does. Claude reads it from a copy kept in Claude Deck's data folder, under `attachments\`; the first time, Claude may ask permission to read outside the project folder. A file dropped anywhere else in the window is ignored. |
| **Permission prompts** | *Allow once*, Claude's own suggestion (for example *Always allow Bash(npm test:\*) in this project*), or *Deny*, optionally telling Claude what to do instead. |
| **Questions** | When Claude asks a multiple-choice question, pick one or more options or type your own answer. |
| **Subagents** | When Claude starts a subagent, a panel opens above the conversation listing the subagents it started, from the moment each starts: type, model, time, current step, tool calls and tokens. Click one for everything it did, live: its instructions, every step with results, and token usage (input, output, cache). **Stop** ends a running one. **✕** closes the panel until another subagent starts; **Subagents** in the session menu opens it again. |
| **Changes** | **Changes** in the session menu shows the files Claude changed in each turn, with line counts and diffs. **Restore to before this turn** puts those files back (it lists what it will do first), and **Undo** reverses the restore. The conversation itself isn't changed. |
| **New session** | Where to run it (chat or terminal), folder (browse, pinned, recent), name, color, new or continue-latest, model, effort, permission mode, git worktree, extra folders, extra arguments and a first prompt. Shows the exact `claude` command. Save setups as presets. |
| **History** | Every past conversation, searchable and filterable by folder. Preview it, then **Resume here**, **Resume in terminal** or **Fork a copy**. The trash button deletes a conversation you don't need (with **Undo**; open conversations can't be deleted). |
| **Plan usage** | On the bar across the top: your current session and weekly limits, the same numbers as `/usage` in Claude Code. Click for every limit and reset time. **Most tokens this week**, at the bottom of that dropdown, lists the conversations that used the most (subagents included) since your plan's weekly limit reset, or in the last 7 days; **Show all** lists every one. |
| **Notifications** | A desktop notification (and optional chime) when a session needs you or finishes. The taskbar icon's mascot sweats while anything is working and gets an amber dot when a session needs you. |
| **Claude Code Settings** | Edits your user, project and project-local `settings.json`, and your user and project `CLAUDE.md`, with a form for every setting, plus raw JSON. Every save backs up the previous file first, and a save is refused if Claude Code changed the file since you opened it. **Plugin marketplaces** lists where Claude Code finds plugins, and adds, updates or removes them. |
| **Search everything** | **Ctrl+K**: jump to a session, resume a conversation or run a command. |
| **Themes and fonts** | **Claude Deck Preferences → Appearance**: Match Windows, Dark and Light, plus twelve more (Claude, Midnight, Graphite, Nord, Dracula, Forest, Ocean, Solarized Dark, High Contrast, Sepia, Solarized Light, Rose). **Text font** (messages, lists and controls) and **Label font** (the capitals on plates and labels) pick from fonts that come with Windows; one this PC doesn't have is shown but can't be picked. |

## Keyboard shortcuts

Press **?** in Claude Deck for this list.

| Keys | Does |
|---|---|
| **Ctrl+Shift+N** | Start a new chat right away in your default folder (Claude Deck Preferences → New sessions), with Claude Code's own settings for model, effort and permissions. Works from anywhere in Sessions, even while typing a reply |
| **F2** | Rename the selected session, even while typing a reply |
| **↑ ↓ ← →** | Move between sessions |
| **Enter** | Open the selected session; resume it if it's an ended chat |
| **Esc** in an empty reply box | To the session list |
| **↑** / **↓** in an empty reply box | Take queued messages back to edit; otherwise step through your earlier messages |
| **Ctrl+Tab** / **Ctrl+Shift+Tab** | Next / previous session, even while typing a reply |
| **Ctrl+W** | End the selected chat (with Undo). On an ended chat, remove it. Asks first if Claude is mid-task. |
| **Ctrl+K** | Search sessions, history and commands |
| **/** | Filter |
| **Alt+1** … **Alt+4** | Sessions, History, Claude Code Settings, Claude Deck Preferences |
| **Ctrl+B** | Narrow the session list to its lamps, or widen it again |
| **Ctrl+S** | Save Claude Code Settings |

Ctrl+Tab and Ctrl+W work in the installed Claude Deck app window. In a plain Edge tab, Edge keeps
them for its own tabs.

## Cost, privacy and your files

- **No API calls, no extra cost.** Claude Deck reads what Claude Code writes and relays what you
  type to your own `claude`. The one network request it makes on its own is the plan-usage check
  (account metadata from `api.anthropic.com`, the same request Claude Code's `/usage` makes; no
  model runs). It reads your Claude sign-in token for that, never changes it, and sends it nowhere
  else. The update check fetches from GitHub with `git`, signed in through the GitHub CLI, when the
  window opens and when you click **Check for updates**, and only for a copy cloned from GitHub on
  `main`. It changes nothing unless you choose to update.
- **Reading Claude Code's model list.** When there's no list yet for the installed Claude Code
  version, Claude Deck starts Claude Code once in the background, reads the models it offers from
  its startup handshake, and closes it. No prompt is sent, so no model runs, no MCP servers are
  started, and Claude Code's non-essential network traffic is turned off for that run. **Update Claude Code now** runs Claude Code's own `claude update`, only when you click it.
- **Your Claude plan only.** Claude Deck won't start a session if Claude Code is set up to bill an
  Anthropic API account or a cloud provider instead of your plan: an `ANTHROPIC_API_KEY` or similar,
  an `apiKeyHelper`, or a Bedrock or Vertex switch. It looks in Claude Deck's own environment and
  Windows' stored user and machine environment (what terminal tabs get), and in Claude Code's
  settings: managed (`managed-settings.json`, its `managed-settings.d` folder and the `ClaudeCode`
  registry policy), your user settings, the project's `.claude\settings.json` and
  `.claude\settings.local.json`, and a `--settings` file or JSON in a session's extra arguments. It
  shows a warning saying what it found. The only way past it is **Claude Deck Preferences → Billing →
  Allow API billing**, which is off by default and warns again before it turns on.
- **Local only.** The server listens on `127.0.0.1:47821` (or another free port) and requires a
  per-install token, so other web pages and other PCs can't use it.
- **Claude Deck's data** is in `%LOCALAPPDATA%\ClaudeDeck`: preferences, open chats, settings
  backups, undo copies, its trash, Claude Code's model list, and copies of files you dropped on a
  chat (`attachments\`).
- **Claude Code's files** (`%USERPROFILE%\.claude`) are changed only when you save in the settings
  editor (after a backup) or delete a conversation from History (moved to Claude Deck's trash, kept
  for 30 days). **Restore to before this turn** changes your project files, after saving their
  current versions for Undo.
- **Plugins** are installed, turned on or off, and their marketplaces added, updated or removed
  by Claude Code itself (`claude plugin ...`), only when you ask. Installing or updating downloads
  from the marketplace's source, usually GitHub. Claude Deck doesn't touch the plugin files.
- **`!` commands** run on this PC, in Windows PowerShell in the chat's folder, only when you type one.
  **Ctrl+R** reads Claude Code's prompt history (`history.jsonl` and its paste cache) without
  changing it.
- **MCP servers** are turned on or off, or reconnected, by the chat's own Claude Code, only when you
  ask. Their settings (commands, addresses, keys) stay with Claude Code and never reach the page.

## Troubleshooting

**"Running scripts is disabled on this system."** Use the full installer command above; it runs the
script with `-ExecutionPolicy Bypass` for that one run, without changing your PC's policy. If you
downloaded a ZIP instead of cloning, unblock the files first: `Get-ChildItem -Recurse | Unblock-File`.

**"Node.js was not found on PATH."** Run the installer (`-Install`) and answer **Yes** when it offers
to install Node.js. If that isn't offered (no `winget` on the PC) or fails, install Node.js 22 or
newer yourself, then open a *new* PowerShell window (an existing one won't see the updated PATH) and
run the installer again.

**"Claude Code was not found."** Check that `claude --version` works in a terminal. If Claude Code is
installed somewhere unusual, set its location under **Claude Deck Preferences → Claude Code → Program**.

**The sign-in task couldn't be created, or your security tool flags it.** Claude Deck works without
it: start it with the **Start Claude Deck** shortcut, and leave **Start with Windows** off. To create
only the shortcuts: `powershell -ExecutionPolicy Bypass -File .\Start-ClaudeDeck.ps1 -InstallShortcut`.

**A PowerShell or Windows Terminal window keeps printing "Claude Deck is already running".** That's
the sign-in task's supervisor, from before 1.9.0, when it could show a window. Closing it is safe.
Turn **Start with Windows** off and on again (**Claude Deck Preferences → Taskbar app**), or run
`powershell -ExecutionPolicy Bypass -File .\Start-ClaudeDeck.ps1 -InstallStartup`, to update the
task so it runs with no window.

**A new model isn't in the model menu.** The menu lists what your Claude Code offers. Update Claude
Code (**Claude Deck Preferences → Claude Code → Update Claude Code now**), then open the menu again.

**The window says "Claude Deck isn't running".** Start it with the **Start Claude Deck** shortcut,
then choose **Try again**. To see the server's own messages, run
`powershell -ExecutionPolicy Bypass -File .\Start-ClaudeDeck.ps1 -Foreground` (Ctrl+C stops it).

**The installed app can't connect, but the shortcut works.** The installed app expects port 47821.
If another program took that port, Claude Deck moves to a different one. Close the other program (or
find it with `Get-NetTCPConnection -LocalPort 47821`), then stop and restart Claude Deck.

**The taskbar pin opens a plain Edge window.** Install the app first ([Pin it to the
taskbar](#pin-it-to-the-taskbar)), then pin the Claude Deck icon that appears.

**Ctrl+Tab or Ctrl+W doesn't work.** They only reach Claude Deck in the installed app window.

**No desktop notifications.** Turn them on under **Claude Deck Preferences → Notifications** and allow them when
Edge asks. Keep the Claude Deck window open (minimized is fine).

**Plan usage is empty.** It needs Claude Code signed in with a Claude plan. API-key setups have no
plan limits to show. If it says the sign-in expired, it renews the next time a Claude session runs.

**Terminal sessions don't open.** Windows Terminal is missing (`wt.exe`). Install it, or use chats.

**Terminal sessions stay at "Starting" after a Claude Code update.** Claude Deck reads status files
Claude Code doesn't document, and an update may have changed them. Chats aren't affected. Report it
([Contributing](#contributing)).

## Known limits

- **Chats don't have the terminal's full-screen pickers** (for example `/config` or `/resume`). Use
  **Continue in terminal** for those.
- **Some of Claude's longer mid-task notes don't appear in chats.** Claude Code saves them only as
  short "thinking" summaries, which Claude Deck doesn't show. Final answers always appear.
- **Tab order.** In the shared terminal window, **Open terminal** picks the tab by launch order.
  Dragging tabs around can land it on the wrong one; **Claude Deck Preferences → Windows Terminal** can open a
  separate window per session instead.
- **Outside sessions** (started in your own terminals) can't be brought to the front. **Continue
  here** stops them there and continues the conversation as a chat.
- **After a restart**, images in earlier messages show as "1 image attached", the Subagents list
  starts fresh, and **Changes** is empty for turns from before Claude Deck started tracking them.
- **Dropped files stay with their chat.** The copies under `%LOCALAPPDATA%\ClaudeDeck\attachments`
  are kept while the chat is listed (so it can be resumed), and removed when it's removed from the
  list.

## Contributing

Changes go through feature branches and pull requests; see
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). How it works: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Testing, including a throwaway sandbox that uses the real Claude Code with no API cost:
[docs/TESTING.md](docs/TESTING.md). Instructions for AI coding agents are in [CLAUDE.md](CLAUDE.md).

## License

[MIT](LICENSE) © Bastionpoint Technology.

Includes a snapshot of [SchemaStore's Claude Code settings schema](https://json.schemastore.org/claude-code-settings.json)
(Apache-2.0) for the settings editor, a trash icon from [Heroicons](https://heroicons.com) (MIT), and
spinner verbs from [claude-code-spinner-verbs](https://github.com/wynandw87/claude-code-spinner-verbs),
which declares no license.
