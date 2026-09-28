# Changelog

What changed in each version of Claude Deck. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/): MAJOR for breaking changes, MINOR for new features,
PATCH for fixes. Each version's section becomes the notes of its GitHub release (see
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#versioning-and-releases)).

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
