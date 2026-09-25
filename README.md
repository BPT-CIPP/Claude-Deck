# Claude Deck

One window for all your Claude Code sessions on Windows. Start sessions in any folder, see what
every session is doing at a glance, reply to them, approve what they want to do, watch their
subagents, review and undo the files they changed, and pick up old conversations from history. It
also edits your Claude Code settings.

- **No extra cost.** Claude Deck never calls the Claude API. Everything it shows comes from files
  Claude Code already writes, and your sessions run your own `claude` with your sign-in, so they use
  your plan exactly as any Claude Code session does.
- **Nothing extra to install.** No npm packages, no new executables. It runs on Node.js, Windows
  Terminal, Microsoft Edge and your existing Claude Code, so it works on managed PCs that block
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

No administrator rights are needed on a standard Windows setup. Tested with Claude Code 2.1.281 and
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
   It checks for Node.js 22+ and warns if Windows Terminal, Claude Code or Edge is missing, then:
   - creates **Start Claude Deck** shortcuts on the desktop and in the Start menu;
   - registers a **Claude Deck** scheduled task that starts the server when you sign in, as you;
   - starts the server and opens the dashboard.
3. **Install it as an app and pin it** (next section), so it gets its own taskbar icon.

The shortcuts and the sign-in task point at the folder you installed from. If you move the folder,
run the installer again from the new location.

**About the sign-in task.** A scheduled task, not a Windows service, because the server has to run
as you in your desktop session to use your Claude sign-in and open terminal tabs and Edge windows.
It restarts the server if it crashes (giving up after 5 crashes in 10 minutes), and leaves it
stopped if you stop it on purpose. Some managed PCs restrict scheduled tasks, and some security
tools flag a new hidden PowerShell task at sign-in; tell your IT team before rolling Claude Deck out.
You can skip the task entirely and just use the shortcut ([Troubleshooting](#troubleshooting)).

## Pin it to the taskbar

Opened as a plain Edge window, a taskbar pin turns into Edge. Installed as an app, Claude Deck gets
its own name, icon and taskbar button:

1. In Claude Deck, open **Preferences → Taskbar app → Install Claude Deck**. If that button isn't
   offered, choose **Open in Edge to install**, then in that Edge tab select the install icon at the
   right end of the address bar (or **…** → **Apps** → **Install Claude Deck**).
2. Right-click the Claude Deck taskbar icon → **Pin to taskbar**.
3. Keep **Start with Windows** on (same section; the installer turns it on), so the server is running
   whenever you click the pin. If it isn't, the app shows *Claude Deck isn't running* with how to
   start it.

After that, the shortcuts and `Start-ClaudeDeck.ps1` open the installed app too.

## Update

```powershell
cd <your Claude-Deck folder>
git pull
```

Then in Claude Deck choose **Preferences → Stop server now**, and start it again with the **Start
Claude Deck** shortcut or the taskbar pin. A stopped server stays stopped until you start it or next
sign in. Open chats end when the server stops; they come back as *Ended*, and **Resume** (or Enter)
continues them. If an update only changed the page itself, reloading the window (Ctrl+R) is enough.

## Uninstall

```powershell
.\Start-ClaudeDeck.ps1 -Uninstall
```

This stops the server and removes the sign-in task and the shortcuts. It keeps your Claude Deck data
(`%LOCALAPPDATA%\ClaudeDeck`; delete that folder to remove it too) and never touches Claude Code's
own files. If you installed the app from Edge, remove it from `edge://apps`. Then delete the
Claude-Deck folder.

## Using Claude Deck

Each session runs one of two ways, your choice when you start it:

- **Chat in Claude Deck** (the default). Claude runs inside Claude Deck. You read and reply in the
  dashboard, answer permission prompts and questions, stop a turn, or switch model or permission
  mode, then go back to the board.
- **Windows Terminal tab.** The full terminal interface, one tab per session in a shared window.
  The dashboard tracks it, and **Open terminal** brings its tab forward.

Either kind can switch to the other (**Continue in terminal** / **Continue here**) and keep the same
conversation. Claude sessions you started elsewhere show up too, and **Continue here** takes them
over.

| Area | What you get |
| --- | --- |
| **Board** | Every session as a card, grouped by what it needs: *Needs you* (a permission prompt or question), *Working*, *Idle*, *Ended*. Each card shows the title, Claude's last reply or your last prompt, folder, branch and how long it has been in that state. Answer permission prompts right on the card (**Allow** / **Deny**); **End** stops a session. |
| **Focus view** | The session list on the left, one session in full on the right. **F** switches between board and focus. |
| **Chat** | Each reply appears whole once Claude has finished it, while a spinner (with Claude Code's playful verbs and the elapsed time) shows it's working. Tool calls expand to show their input and result. **Enter** sends, **Shift+Enter** adds a line, **/** lists the session's slash commands. While Claude works, **Enter** queues your message (marked *Queued* until Claude picks it up) and **Interrupt** stops Claude and sends it now. Change model or permission mode from the header. |
| **Images** | Paste with **Ctrl+V** or **Alt+V** (as in Claude Code), drop image files on the reply box, or use **Image**. Large images are scaled down to fit the API's limits. |
| **Permission prompts** | *Allow once*, Claude's own suggestion (for example *Always allow Bash(npm test:\*) in this project*), or *Deny*, optionally telling Claude what to do instead. |
| **Questions** | When Claude asks a multiple-choice question, pick one or more options or type your own answer. |
| **Subagents** | **Subagents** in a chat's header lists the subagents Claude started, from the moment each starts: type, model, time, current step, tool calls and tokens. Click one for everything it did, live: its instructions, every step with results, and token usage (input, output, cache). **Stop** ends a running one. |
| **Changes** | **Changes** shows the files Claude changed in each turn, with line counts and diffs. **Restore to before this turn** puts those files back (it lists what it will do first), and **Undo** reverses the restore. The conversation itself isn't changed. |
| **New session** | Where to run it (chat or terminal), folder (browse, pinned, recent), name, color, new or continue-latest, model, effort, permission mode, git worktree, extra folders, extra arguments and a first prompt. Shows the exact `claude` command. Save setups as presets. |
| **History** | Every past conversation, searchable and filterable by folder. Preview it, then **Resume here**, **Resume in terminal** or **Fork a copy**. The trash button deletes a conversation you don't need (with **Undo**; open conversations can't be deleted). |
| **Plan usage** | Next to *Sessions*: your current session and weekly limits, the same numbers as `/usage` in Claude Code. Click for every limit and reset time. |
| **Notifications** | A desktop notification (and optional chime) when a session needs you or finishes. The taskbar icon's mascot sweats while anything is working and gets an amber dot when a session needs you. |
| **Claude settings** | Edits your user, project and project-local `settings.json`, and your user and project `CLAUDE.md`, with a form for every setting, plus raw JSON. Every save backs up the previous file first, and a save is refused if Claude Code changed the file since you opened it. |
| **Search everything** | **Ctrl+K**: jump to a session, resume a conversation or run a command. |
| **Themes** | **Preferences → Appearance**: Match Windows, Dark and Light, plus twelve more (Claude, Midnight, Graphite, Nord, Dracula, Forest, Ocean, Solarized Dark, High Contrast, Sepia, Solarized Light, Rose). |

## Keyboard shortcuts

Press **?** in Claude Deck for this list.

| Keys | Does |
|---|---|
| **N** | New session |
| **F** | Switch between Board and Focus |
| **↑ ↓ ← →** | Move between sessions |
| **Enter** | Open the selected session; resume it if it's an ended chat |
| **Esc** | Back to the board |
| **Ctrl+Tab** / **Ctrl+Shift+Tab** | Next / previous session, even while typing a reply |
| **Ctrl+W** | End the selected chat (with Undo). On an ended chat, remove it. Asks first if Claude is mid-task. |
| **Ctrl+K** | Search sessions, history and commands |
| **/** | Filter |
| **Alt+1** … **Alt+4** | Sessions, History, Claude settings, Preferences |
| **Ctrl+B** | Collapse or expand the sidebar |
| **Ctrl+S** | Save Claude settings |

Ctrl+Tab and Ctrl+W work in the installed Claude Deck app window. In a plain Edge tab, Edge keeps
them for its own tabs.

## Cost, privacy and your files

- **No API calls, no extra cost.** Claude Deck reads what Claude Code writes and relays what you
  type to your own `claude`. The one network request it makes is the plan-usage check (account
  metadata from `api.anthropic.com`, the same request Claude Code's `/usage` makes; no model runs).
  It reads your Claude sign-in token for that, never changes it, and sends it nowhere else.
- **Local only.** The server listens on `127.0.0.1:47821` (or another free port) and requires a
  per-install token, so other web pages and other PCs can't use it.
- **Claude Deck's data** is in `%LOCALAPPDATA%\ClaudeDeck`: preferences, open chats, settings
  backups, undo copies and its trash.
- **Claude Code's files** (`%USERPROFILE%\.claude`) are changed only when you save in the settings
  editor (after a backup) or delete a conversation from History (moved to Claude Deck's trash, kept
  for 30 days). **Restore to before this turn** changes your project files, after saving their
  current versions for Undo.

## Troubleshooting

**"Running scripts is disabled on this system."** Use the full installer command above; it runs the
script with `-ExecutionPolicy Bypass` for that one run, without changing your PC's policy. If you
downloaded a ZIP instead of cloning, unblock the files first: `Get-ChildItem -Recurse | Unblock-File`.

**"Node.js was not found on PATH."** Install Node.js 22 or newer, then open a *new* PowerShell window
(an existing one won't see the updated PATH) and run the installer again.

**"Claude Code was not found."** Check that `claude --version` works in a terminal. If Claude Code is
installed somewhere unusual, set its location under **Preferences → Claude Code → Program**.

**The sign-in task couldn't be created, or your security tool flags it.** Claude Deck works without
it: start it with the **Start Claude Deck** shortcut, and leave **Start with Windows** off. To create
only the shortcuts: `powershell -ExecutionPolicy Bypass -File .\Start-ClaudeDeck.ps1 -InstallShortcut`.

**The window says "Claude Deck isn't running".** Start it with the **Start Claude Deck** shortcut,
then choose **Try again**. To see the server's own messages, run
`powershell -ExecutionPolicy Bypass -File .\Start-ClaudeDeck.ps1 -Foreground` (Ctrl+C stops it).

**The installed app can't connect, but the shortcut works.** The installed app expects port 47821.
If another program took that port, Claude Deck moves to a different one. Close the other program (or
find it with `Get-NetTCPConnection -LocalPort 47821`), then stop and restart Claude Deck.

**The taskbar pin opens a plain Edge window.** Install the app first ([Pin it to the
taskbar](#pin-it-to-the-taskbar)), then pin the Claude Deck icon that appears.

**Ctrl+Tab or Ctrl+W doesn't work.** They only reach Claude Deck in the installed app window.

**No desktop notifications.** Turn them on under **Preferences → Notifications** and allow them when
Edge asks. Keep the Claude Deck window open (minimized is fine).

**Plan usage is empty.** It needs Claude Code signed in with a Claude plan. API-key setups have no
plan limits to show. If it says the sign-in expired, it renews the next time a Claude session runs.

**Terminal sessions don't open.** Windows Terminal is missing (`wt.exe`). Install it, or use chats.

**Terminal cards stay at "Starting" after a Claude Code update.** Claude Deck reads status files
Claude Code doesn't document, and an update may have changed them. Chats aren't affected. Report it
([Contributing](#contributing)).

## Known limits

- **Chats don't have the terminal's full-screen pickers** (for example `/config` or `/resume`). Use
  **Continue in terminal** for those.
- **Some of Claude's longer mid-task notes don't appear in chats.** Claude Code saves them only as
  short "thinking" summaries, which Claude Deck doesn't show. Final answers always appear.
- **Tab order.** In the shared terminal window, **Open terminal** picks the tab by launch order.
  Dragging tabs around can land it on the wrong one; **Preferences → Windows Terminal** can open a
  separate window per session instead.
- **Outside sessions** (started in your own terminals) can't be brought to the front. **Continue
  here** stops them there and continues the conversation as a chat.
- **After a restart**, images in earlier messages show as "1 image attached", the Subagents list
  starts fresh, and **Changes** is empty for turns from before Claude Deck started tracking them.

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
