# Changelog

What changed in each version of Claude Deck. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/): MAJOR for breaking changes, MINOR for new features,
PATCH for fixes. Each version's section becomes the notes of its GitHub release (see
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#versioning-and-releases)).

## [1.18.0] - 2026-10-22

### Added
- **Sessions can run as terminals inside the window.** Claude Code's own terminal interface, with
  every command, dialog and key exactly as in its terminal (`/config`, `/mcp`, `/login`, plan
  mode, Shift+Tab, Ctrl+B, Esc Esc, image paste with Ctrl+V), drawn in the dashboard in place of
  the chat. **Claude Deck Preferences → New sessions → Run here as** chooses what *Here in Claude
  Deck* means: a chat (as before, the default) or a terminal; it applies to New session,
  Ctrl+Shift+N, *Resume here* and *Continue here*. The session list, lamps, notifications,
  History and Changes work for both. **End session** leaves the terminal listed under *Ended*
  with its last screen, ready to **Resume** (or **Remove**), and the list survives a server
  restart as chats do (the conversation then shows from its transcript). As in any Claude Code
  terminal, the conversation reaches History once a prompt has been sent; a session that only
  ran `/config` or `/mcp` has no transcript. A terminal's session menu has **Continue in Windows
  Terminal** and **Continue as a chat**; Ctrl+W ends it (with Undo), as for a chat. In the
  terminal, **Ctrl+Shift+C** copies the selection and **Ctrl+Shift+V** pastes; Ctrl+Tab,
  Ctrl+Shift+N, F2 and Alt+1–4 stay Claude Deck's, every other key is Claude Code's.
- Under the hood: the pseudo-console is Windows' own `conhost.exe --headless` (what Windows
  Terminal uses), held by a small Windows PowerShell script (`src/pty-host.ps1`, .NET built-ins
  only); the page draws it with xterm.js (`public/vendor/xterm`, MIT). No new executable, nothing
  compiled, nothing installed: the managed-PC rules in CLAUDE.md still hold. Like chats, these
  terminals end when the server stops.

### Changed
- The dashboard's content security policy now allows inline styles (`style-src 'unsafe-inline'`),
  which xterm.js needs for its colors and cell sizes. Scripts are still only the server's own,
  and the page still never uses `innerHTML`.
- In the session list, a Windows Terminal tab now reads *Windows Terminal* (a terminal in the
  window reads *Terminal*).

## [1.17.0] - 2026-10-21

### Added
- **Name History's folders.** The pencil at the end of a folder's line in History (or **F2** on
  it) gives it a name there, such as *Client work* in place of a long path. Enter saves, Esc
  cancels, and an empty name shows the path again; the toast has **Undo**. Only History's name for
  it changes: the folder on disk keeps its own name, so its conversations still resume there and
  Claude Code's files aren't touched. The folder filter, moved conversations' "from …" and search
  use the name too.
- **History's list can be resized**, as the session list can: drag the line between the list and
  the preview (or focus it and use ← and →), and double-click it to go back to the usual width.
  The width is remembered.

## [1.16.0] - 2026-10-21

### Added
- **Send now, as in Claude Code.** While Claude works, **Ctrl+Enter** (or **Ctrl+X** then
  **Ctrl+S**, Claude Code's own keys) sends your message and has Claude take it next instead of
  after the turn: Claude Code stops what it's doing to make way, and anything queued ahead of it
  still goes first. With nothing typed, the messages already queued go now. A **Send now** button
  beside the reply box does the same while Claude works; Enter still queues, and **Ctrl+X** then
  **Enter** queues too. When Claude is idle, all of these simply send.

## [1.15.0] - 2026-10-21

### Added
- **History is filed by folder.** Conversations are grouped one folder per working directory, as
  Claude Code keeps them (every conversation started in `…\Documents\Claude` is under that
  folder), most recently active first. A folder opens in place to show its conversations, with
  the other folders still in view. Drag a conversation onto another folder to move it there:
  Claude Deck remembers that in its own data, Claude Code's files aren't touched, and the
  conversation still resumes from the folder it was started in. A moved conversation says where it
  came from, with a button to put it back, and the move can be undone from its toast. **Folders**
  / **List** at the top of History switches to the old single list by day; the choice, and which
  folders are open, are remembered.

## [1.14.0] - 2026-10-21

### Added
- **Config, in a chat's ▾ menu.** Opens Claude Code's `/config` options (theme, editor mode,
  auto-compact, model, default permission mode, notifications, output style and the rest, 32 in
  Claude Code 2.1.301) with their current values, and changes them. The list comes from the chat's
  own Claude Code, so new options appear as Claude Code adds them, and each change is made by
  Claude Code itself (`/config key=value`), which checks it and saves it where it belongs. Nothing
  is added to the conversation. Each option says whether it applies to all sessions or just this
  folder.

### Changed
- **The ▾ menu button beside a session's name is easier to see**: it has an outline and a lighter
  background.
- **Enter takes the highlighted command or file** when the `/` or `@` list is open in the reply
  box, as in Claude Code, instead of sending the half-typed word. A command typed out in full is
  still sent.
- **Dropped files are cleaned up.** The copy Claude Deck keeps of a file dropped on a chat
  (`attachments\`) goes when the chat is removed from the list, and copies left by chats that are
  no longer listed go when the server starts.
- **Faster to start a session.** The billing guard's registry check waits for `reg.exe` only once,
  when the server starts; after that it answers from what it last read and refreshes in the
  background, so starting, resuming or rewinding a session no longer pauses every other chat.
- **The Changes list is quicker to refresh** on a long conversation: earlier turns' file lists are
  kept while the transcript is unchanged, and only the latest turn is compared with the disk again.

### Fixed
- **Config: a change's reply can no longer be mistaken for something else's.** A `/config` reply is
  now matched to the command Claude Deck sent (by the uuid Claude Code reports progress on), so a
  `!` command's result or a message sent at the same moment doesn't answer it, and its real reply
  no longer lands in the conversation. A reply that arrives after the window gave up waiting is
  read, not shown as Claude's.
- **Config shows the value `/config` saved.** A setting in a project's shared `.claude/settings.json`
  no longer hides the one Claude Code writes for all sessions, which made a change look as if it
  hadn't taken and made every save wait the full three seconds.
- **Config: changes are checked before any is made**, so a bad one can't leave the others half
  done; when a later change fails, the earlier ones' confirmations are still shown, with what
  stopped it. A value can't carry a second `name=` into the command, and clearing a free-text
  option's box (which `/config` can't do) keeps its value instead of failing on Save.
- **"Claude Code isn't signed in" only for Claude Code's own sign-in.** An MCP server's OAuth
  failure no longer brings up the `claude auth login` instructions.
- **Continue here says what to do when Claude won't stop.** If Claude in a terminal or outside
  session hasn't exited after its tab was told to close, the message now says to resume the
  conversation from History once it has, instead of "try again", which could no longer work.
- **Preferences no longer loses what you're typing** when the window regains focus: the billing
  check that runs then updates only its own status line instead of rebuilding the view.
- **No "Outside" session flashes up** while Claude Deck asks Claude Code for its model list (at
  start after a Claude Code update, and after *Update Claude Code now*).
- **A `!` command that runs out of time is stopped with everything it started**, not just the
  PowerShell that ran it.
- **Choosing Default in a chat's model menu** no longer keeps showing the previous model's name;
  the default's name comes with Claude's next reply.
- **Going back to an earlier message** reads the transcript a line at a time, so a very large one
  can't fail with "isn't in this conversation's saved transcript".
- **Dismissing a session that never started, or resuming one in a new tab,** no longer leaves its
  launch files behind in the data folder.
- **A request whose body isn't a JSON object** gets a "bad request" answer instead of a server
  error in the log, and a pinned folder or preset of the wrong shape is refused rather than
  breaking the New session window later.

## [1.13.0] - 2026-10-13

### Added
- **Claude Deck checks for updates when it opens.** For a copy cloned from GitHub (on `main`, with
  access to the repository through the GitHub CLI), it asks **Update found: would you like to
  update Claude Deck now?** when a newer version is out, then updates and restarts if you say yes.
  If the check or the update can't run (no access, no GitHub CLI, offline, a copy that isn't
  updated from here), it says nothing and Claude Deck carries on. A declined version isn't offered
  again until the window is next opened. **Check for updates** in Preferences still explains any
  problem.
- **How to sign in again when Claude Code's sign-in expires.** When a chat fails because Claude Code
  isn't signed in or its sign-in expired ("OAuth session expired"), the chat now says to open
  PowerShell and run `claude auth login`, with a **Copy command** button. Typing `/login` in a chat,
  which only works in Claude Code's terminal, shows the same instructions instead of "isn't
  available in this environment".

### Fixed
- **The model menu in New session works again.** It opened, but clicks and hovers went through it
  to the window underneath (showing that window's tooltips), so no model could be chosen. Browsers
  block everything outside an open dialog, and the menu sat outside it; it now opens inside it.
- **New session opens in the default folder you choose.** Choosing a folder with **Browse…** under
  Preferences → New sessions → Default folder now saves it right away (it used to wait for
  **Save**), and saving a default makes it where the next New session opens, even when it
  remembered a folder from an earlier session.

## [1.12.0] - 2026-10-10

### Added
- **The installer offers to install missing prerequisites.** `Start-ClaudeDeck.ps1 -Install` used to
  stop with an error when Node.js was missing. Now it asks before installing Node.js (LTS) or
  Windows Terminal with `winget`, or Claude Code with Claude Code's official installer, then picks
  them up without a new PowerShell window. Each question defaults to no. Answer no, or run it where
  there's no `winget`, and it says where to get each one, as before.
- **The installer signs Claude Code in.** If Claude Code isn't signed in to your Claude plan, the
  installer starts its sign-in (`claude auth login`), so the first chat doesn't stop at "Not logged
  in".
- **A guided tour for first-time users.** The first time Claude Deck opens, a two-minute tour lights
  up each part of the page (New session, the session list and its lamps, the conversation and its
  controls, plan usage, search, History, Settings and Preferences) and explains it for someone who
  has never used Claude Code. Skip it with Esc; take it again from Preferences → Dashboard or Ctrl+K.
- **The conversation fills the window.** It spans the whole chat pane instead of a fixed 560px
  column, at the same text size. Below 900px wide, the session list narrows to its lamps instead
  of stacking above the chat, so the conversation and the reply bar stay on screen; the
  narrow/widen button and Ctrl+B still widen it there, without changing your choice for wider
  windows.

### Fixed
- **A Claude Code installed after Claude Deck started is found.** Preferences no longer says "not
  found", and the model menus fill in, once Claude Code turns up: Claude Deck looks again when the
  page loads or a session starts, and checks winget's and npm's install folders, which the server's
  PATH from before the install can't see.

## [1.11.0] - 2026-10-09

### Added
- **MCP servers** in a chat's header, beside Plugins: how many of the chat's MCP servers are
  connected, and a list like `/mcp`'s with each one's status (connected with its tools and version,
  connecting, failed and why, needs sign-in, off) and where it's set up. Turn a server off or on
  (Claude Code remembers it for the folder, as `/mcp` does), or reconnect one that failed. A
  server's settings, which can hold keys, never reach the page.
- **Long pastes collapse**, as in Claude Code: text over 800 characters or with more than two line
  breaks goes in the reply box as `[Pasted text #1 +123 lines]`, and the full text is sent in its
  place. Paste the same text again straight after to expand it in the box. In the conversation your
  message shows the placeholder too; click it to show the text. **↑** and taking back a queued
  message bring the placeholders back, as in Claude Code.
- A **Claude** label marks where Claude's side starts after each of your messages (over its reply,
  first tool or the working spinner), matching the **You** label on yours.
- **More of Claude Code's terminal, in chats:**
  - **Edits show their diff** under the tool line, with line numbers, as the terminal draws them.
  - **Thinking** shows as a collapsed line you can open.
  - **Plans:** at the end of plan mode, Claude's plan is shown in full with *Yes, and make the edits
    without asking*, *Yes, and ask before each edit*, or *Keep planning* with what to change.
  - **Shift+Tab** in the reply box steps through ask before edits, accept edits and plan mode.
  - **@** lists files in the chat's folder as you type, from Claude Code's own file index.
  - **!command** runs a command right away in PowerShell, in the chat's folder; Claude sees it and its
    output with your next message, as the terminal's shell mode does.
  - **/btw question** asks Claude something aside: the answer shows above the reply box and stays
    out of the conversation.
  - **Ctrl+B** sends what Claude is waiting on (a long command or a subagent) to the background so
    it carries on; what's running in the background is listed above the reply box, with Stop.
  - **Esc Esc** (or *Go back to an earlier message…* in the session menu) takes the conversation
    back to before one of your messages, optionally putting files back too, and puts that message
    back in the reply box. The conversation as it was stays in History.
  - **Ctrl+R** searches your earlier prompts, this folder's first, from Claude Code's own prompt
    history (pastes included, where Claude Code still keeps them).
  - Claude Code's **suggested next prompt**, when it offers one, shows in the empty reply box;
    **Tab** takes it.
  - **MCP servers** that need it can be signed in to from the MCP servers dropdown.
  - **Fast mode** can be turned on in a chat's header. It's billed as extra usage on top of your
    plan, so it needs *Allow API billing*.
  - **Claude's to-do list** shows above the reply box while it works. Claude Code currently turns
    its to-do tools off outside the terminal (and, on the PC this was built on, in the terminal too),
    so this shows once Claude Code turns them on.

### Fixed
- Every ended session in the Sessions list read "just now" after the server restarted, because its
  time was taken from when Claude Deck loaded it. An ended session's time is now when its
  conversation was last active, from Claude Code's transcript, the same time History shows.
- Replies showed Markdown as plain text apart from code, inline code and bold, so headings, tables,
  lists and quotes looked nothing like they do in Claude Code's terminal. Replies (and subagents'
  results) now lay out headings, bulleted and numbered lists (nested, with code inside), tables
  (with column alignment), quotes, rules, italics, strikethrough and links. Web links open in a new
  window; a link to a file shows its text, with the path on hover.

## [1.10.0] - 2026-09-29

### Changed
- **A new look: the signal box.** Every screen is redesigned around one idea: each session is a
  line with a lamp, and the line you pick runs straight into a calm reading area.
  - The navigation moved from a left rail to a shelf across the top, which also holds plan usage,
    Search, the connection lamp and **New session**. The session list keeps the whole left side.
  - Status lamps sit in dark bezels: amber needs you (and flashes once a second), lit white is
    working, green is idle, unlit is ended. Group headers and view names are engraved plates.
  - The chat header is two quiet lines and one row of instruments (model, effort, permissions,
    plugins, context, cost, tokens); **End session** moved up beside the title. Replies read at a
    comfortable line length, and tool calls are ruled lines instead of boxes.
  - The context meter shows what the latest turn added, and its needle moves there smoothly.
  - Double-click a session's name (or press **F2**) to rename it where it sits.
  - **Ctrl+B** now narrows the session list to its lamps, for more reading room.
  - Icons are drawn instead of text symbols. All 15 themes keep working in the new layout.
  - **Most tokens this week** moved into the plan-usage dropdown, as its own button at the bottom.
  - In a narrower window the top bar gives up words, not space: first the Search and Live labels,
    then "Claude Code" and "Claude Deck" before Settings and Preferences (and the usage bars), then
    the name and the New session label. The view names never run into the buttons on the right.
- **Text font** and **Label font** in Claude Deck Preferences → Appearance: pick the font for
  messages, lists and controls, and for the capitals on plates and labels, from fonts that come with
  Windows (nothing is downloaded). A font this PC doesn't have is listed but can't be picked.
- The README is up to date with 1.9: updating Claude Code, the slash command and model rows,
  dropped files, and the sign-in task fix.

## [1.9.1] - 2026-09-29

### Fixed
- The model menu's flyouts named the current version "Opus 5.5 only" but earlier versions by model
  ID (`claude-opus-4-8`), in one mixed list. Each flyout now lists what follows the newest version
  first (Opus 5.5, Opus 5.5 · 1M context, Opus 5.5 for planning), then, under *Specific versions*,
  every version by its model ID, newest first: `claude-opus-5-5`, `claude-opus-5-5[1m]`,
  `claude-opus-5`, `claude-opus-4-8` and so on. Hover one for its name.
- In the New session window the model menu opened behind the window, so it couldn't be used. It
  now opens in front, above the button when there's no room below, and a long flyout stays on
  screen.

## [1.9.0] - 2026-09-29

### Added
- **Clear the chat on /clear** (Claude Deck Preferences → Appearance, on by default): `/clear` also
  clears the chat's messages, as Claude Code clears its screen. Messages still queued stay, and
  **↑** still brings back your earlier messages.
- Dropping a file that isn't an image (a PDF, say) on the reply box puts its path in your message,
  as dropping a file into Claude Code's terminal does. Claude reads it from a copy kept in Claude
  Deck's data folder.

- The model menus (chat header, New session, Claude Code Settings) have a flyout for each model,
  named with its version as your Claude Code reports it (*Opus 5.5 ▸*, *Sonnet 5.5 ▸*, *Fable 5.1 ▸*,
  *Haiku 4.5 ▸*), listing its variants: the latest, with a 1M-token context, and pinned to that
  version. The list comes from Claude Code itself and is read again whenever Claude Code updates,
  so a new model shows up without a Claude Deck update.
- **Update Claude Code now** in Claude Deck Preferences → Claude Code runs `claude update`, and the
  section says whether Claude Code updates itself (and when it's been told not to).

### Changed
- The slash command list opens wherever you type `/` in the reply box, not only at the start, as in
  Claude Code. Picking a command replaces just that word. A command at the start of a message runs
  as before; one later in it asks Claude to run it.

### Fixed
- Dropping a PDF or another file that isn't an image on the reply box opened it in Edge in place of
  Claude Deck. A file dropped anywhere else in the window now does nothing.
- The sign-in task's supervisor showed as an open PowerShell window (a Windows Terminal tab where
  Terminal is the default terminal app), printing "Claude Deck is already running" every 30
  seconds after a restart. It now runs with no window. Turn *Start with Windows* off and on again,
  or run `.\Start-ClaudeDeck.ps1 -InstallStartup`, to update an existing task.
- **↑** stopped at a recalled message that was a slash command (such as `/clear`), because the
  command list opened and took the next **↑**. The list stays closed while you step through.

## [1.8.1] - 2026-09-28

### Fixed
- The release workflow took a missing tag for an existing one, so the merges for 1.7.1 and 1.8.0
  failed with "already exists on another commit" and published no release. It now checks the tag
  in a way that tells the two apart, and fails only on a real conflict or a GitHub API error.

## [1.8.0] - 2026-09-28

### Changed
- *Most tokens this week* moved from the top of the session list to the Sessions header, at the
  right beside the filter. It stays highlighted while its list is showing.

## [1.7.1] - 2026-09-27

### Fixed
- The server could be stopped by a malformed web address, such as one a web page opens (a lone `%`,
  a NUL, or an unusual token), ending every open chat. Such requests now just get an error.
- Setting Claude Code's path to `claude.cmd` (what `where claude` shows for an npm install) stopped
  the server from starting at all. Claude Deck now uses the program that file starts.
- Deleting a conversation from History could lose some of its files if Windows had one of them
  locked partway through. Now everything is either moved to the trash or put back, and what can't
  be put back stays in the trash. An Undo that stops partway can be tried again.
- Restoring files to before a turn now puts back the files already restored if one can't be
  written, refuses to overwrite a file it can't read, and Undo no longer overwrites work done on a
  file after the restore.
- The billing guard now also checks a `--settings` file in a session's extra arguments, managed
  settings from the `managed-settings.d` folder and the Claude Code registry policy, and resuming in
  a terminal tab with **R**.
- Moving a session between a chat and a terminal (or **Continue here**) no longer ends it when the
  new one can't start, for example because the billing guard refuses.
- **End** on an outside session no longer ends another program if Windows has reused that session's
  process ID.
- Two Claude Deck servers could end up running at once (sign-in and the shortcut at the same moment,
  or Restart pressed twice). The second one now leaves it to the first.
- Conversations whose prompts start with `<` (HTML, or a `<Component>` name) were missing from
  History and the change timeline. Pasted text shows without its wrapper.
- Saving a settings or CLAUDE.md file kept neither its byte-order mark nor its Windows line endings,
  and replaced a symbolic link with a plain file. It keeps all three now. A file that appears or
  changes while the editor is open is no longer overwritten without asking, and switching folders
  while one is loading can't save one folder's settings into the other.
- Arrow keys in a session's ▾ menu also switched sessions, and Enter on a subagent opened and at once
  closed it.
- Pressing Enter twice quickly sent a message twice, and text typed while a message was being sent
  was wiped. Ctrl+Enter in the New session window could start two sessions.
- The session header no longer resets a model ID being typed, or an open dropdown, every minute, and
  keyboard focus in the session list is kept across updates.
- A chat that failed to load stayed blank; it now says so, with **Try again**. The subagent panels no
  longer rebuild every second (losing clicks on **Stop** and collapsing what you'd opened), and
  reloading plugins no longer reloads the whole chat.
- After the server restarts on a new version, an open window reloads itself instead of running the
  old page.
- Any web page could lock the installed app out by opening its address with a made-up token. A token
  in the address is kept only once the server accepts it.
- Code blocks with a language like `c++`, or Windows line endings, showed as plain text.
- The folder picker and recent folders no longer freeze Claude Deck while a disconnected network
  drive times out. Long conversations load and refresh faster.
- Wording left from the Board ("card").

### Changed
- Releases are published only after the checks pass on the merge, and a version that's already
  tagged fails loudly instead of being skipped. The repo's Claude Code hooks refuse every push to
  `main` and every force-push, however it's written.

## [1.7.0] - 2026-09-26

### Added
- A context meter in a chat's header: how full Claude's context
  window is (for example 120k / 1M, 12%). In-app chats have a **Compact** button beside it,
  which summarizes the conversation so far to free up room, like `/compact`. Terminal and outside
  sessions show the context size from their transcript.
- *Current total tokens* in a chat's header: the tokens the current conversation has used,
  subagents included. Hover for input, output and cache.
- Each finished reply shows the tokens it used next to *Done in*, subagents included, and how many
  were the subagents', for example "Done in 12s · 45.2k tokens, 12.1k from subagents".
- *Most tokens this week*, pinned at the top of the session list, lists the 10 conversations that used the most tokens since
  your plan's weekly limit reset (or in the last 7 days), subagents included. **Show all** lists
  every one, with a filter. Click one to open it, or to find it in History.
- Notes in the chat when the context is cleared and when the conversation is compacted.
- **Restart server** in Claude Deck Preferences, next to *Stop server now*: the server stops, starts
  again on the same address and the window reloads, so changes to Claude Deck take effect without
  reopening anything. If Claude Deck runs from the sign-in task, the task keeps watching the new
  server.
- **Check for updates** in Claude Deck Preferences, to the left of *Restart server*: if GitHub has
  a newer Claude Deck, it asks, gets it and restarts on it. It signs in through the GitHub CLI
  (`gh auth login`), and only updates a copy on `main` with no changes or commits of its own;
  otherwise it leaves the copy alone and gives the PowerShell command to update it by hand, with a
  button to copy it.
- A billing guard: Claude Deck won't start a chat or terminal session when Claude Code is set up to
  bill an Anthropic API account or a cloud provider instead of your Claude plan (an API key or
  token, an `apiKeyHelper`, or a Bedrock, Vertex or similar switch, in the environment or Claude
  Code's settings). A red banner says what it found. The only way past it is *Allow API billing*
  in Claude Deck Preferences → Billing, off by default, which warns again before it turns on.
- **F2** renames the selected session, even while typing a reply, so it works right after Ctrl+Tab.
- The running version (for example v1.7.0) next to *Live* at the bottom of the sidebar.

### Changed
- A redesigned, much shorter session header, so the conversation gets more room:
  - Above the title: the status, a badge when subagents are running, and the full folder path and
    session ID with their copy and open buttons.
  - **▾** beside the title opens a menu with **Rename**, **Tag color** (a fly-out of colors),
    **Changes**, **Continue in terminal** and **Subagents**. The separate *Open folder* button is
    gone; the folder's ↗ opens it.
  - One row of controls under the title: model, effort, permissions, plugins, context (with
    **Compact**), *Current cost* and *Current total tokens*, with **End session** on the right.
  - The header's *Stop* button is gone: the reply box's **Interrupt** does the same (with nothing
    typed, it just stops Claude).
- *Est. cost* is now *Current cost*, since it's the current conversation's cost: it starts again
  after `/clear`, which starts a new conversation.
- The Board is gone: Sessions is the session list and the selected session, always (so the Board
  / Focus switch and **F** are gone too). Each row in the list has a trash button that ends the
  session, or removes it once it has ended. **Esc** in an empty reply box goes to the session list.
- **Ctrl+Shift+N** starts a new chat right away, without the New session window: in your default
  folder (Claude Deck Preferences → New sessions), with Claude Code's own settings for model,
  effort and permissions. It works from anywhere in Sessions, even while typing a reply, and
  replaces the **N** shortcut.
- The icons beside tool calls in a chat are off by default. Turn them on in Claude Deck
  Preferences → Appearance → *Tool calls*.
- The subagents panel opens by itself when Claude starts a subagent. **✕** closes it until another
  starts, and **Subagents** in the session menu opens it again.

### Fixed
- A chat that ended when Claude Deck restarted showed an empty conversation until you resumed it.
  It now shows the conversation so far, as History does.

## [1.6.1] - 2026-09-26

### Fixed
- Hovering over a plugin in the Plugins menu (or tabbing to it) shows a card with its name,
  marketplace, category, install count and its full description. Before, the tooltip showed only
  the plugin's ID, and descriptions over 300 characters (41 in the official marketplace) were cut
  off.

## [1.6.0] - 2026-09-26

### Added
- The Plugins menu's *Marketplace* list is grouped by the category each marketplace gives its
  plugins (Database, Development, Productivity and so on). Groups start closed and show how many
  plugins they hold; a search opens every group with a match and also matches category names.
  Plugins without a category are under *Uncategorized*.

### Fixed
- Adding, updating or removing a marketplace now shows just the result, not Claude Code's
  progress text (which could hide the result when it was long).

## [1.5.0] - 2026-09-26

### Added
- A Plugins menu in a chat's header, to the right of Permissions.
  - *Installed* lists Claude Code's plugins, with a checkbox to turn each one on or off.
  - *Marketplace* lists what your marketplaces offer, with search and **Install**. An installed
    plugin moves up to *Installed*.
  - Changes apply to all your Claude Code sessions, and the chat you're in picks them up right
    away. If that would reset Claude's prompt cache mid-conversation (a plugin that adds tools),
    you're asked first.
  - A plugin that installs by running a command shows you the command before anything runs.
- **Plugin marketplaces** in Claude Code Settings lists where Claude Code finds plugins, and adds,
  updates or removes them.

### Changed
- "Claude settings" is now **Claude Code Settings**, and "Preferences" is now **Claude Deck
  Preferences**, so each says whose settings it holds.

## [1.4.0] - 2026-09-26

### Added
- Each release now includes a manifest (`claude-deck-vX.Y.Z-manifest.json`) listing every file with
  its size and SHA-256. `node tools\release-manifest.js verify <manifest>` checks that a folder
  holds exactly that release and names any file that's missing or different. Earlier releases
  have one too.

## [1.3.1] - 2026-09-26

### Fixed
- Time the PC spends asleep no longer counts as Claude working. The working timer and a turn's
  "Done in" leave it out. Chats that are waiting on you keep counting, since they really were
  waiting that long.

## [1.3.0] - 2026-09-26

### Added
- An effort selector in a chat's header. It changes the effort Claude uses from its next step
  on, and Default goes back to the model's own default.

### Changed
- The chat header now has two rows. The first shows the folder, session ID, prompt count and
  estimated cost, and the second holds the model, effort and permission mode.
- Long folder paths are cut from the start rather than the end, so the folder's own name stays
  visible.

### Fixed
- The model picker in the header no longer draws a box inside its box.

## [1.2.0] - 2026-09-26

### Added
- Releases: each version merged to `main` is tagged `vX.Y.Z` and published as a GitHub release
  with its notes from this file.
- This changelog.
- Preferences shows which version of Claude Deck is running, with a link to the release notes.
- `npm run verify` checks that this changelog has a section for the version in `package.json`.

## [1.1.0] - 2026-09-25

### Added
- In a chat's reply box, ↑ takes queued messages back out of Claude's queue to edit, images
  included; with nothing queued it recalls your earlier messages (↓ steps forward again).

### Fixed
- The test stand-in for Claude Code could ignore an interrupt sent together with its message,
  which made the interrupt tests fail intermittently.

## [1.0.0] - 2026-09-25

### Added
- First release: in-app chats and Windows Terminal sessions on one board, focus view, history
  with resume, fork and delete, a change timeline with restore and undo, live subagent details,
  plan usage, a Claude Code settings editor, themes, keyboard shortcuts, and the team workflow
  (verify gate, Stop hook, GitHub Actions checks, sandbox).

[1.18.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.17.0...v1.18.0
[1.17.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.15.0...v1.16.0
[1.15.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.8.1...v1.9.0
[1.8.1]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.6.1...v1.7.0
[1.6.1]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/BPT-CIPP/Claude-Deck/releases/tag/v1.0.0
