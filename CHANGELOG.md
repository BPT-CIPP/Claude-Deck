# Changelog

What changed in each version of Claude Deck. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/): MAJOR for breaking changes, MINOR for new features,
PATCH for fixes. Each version's section becomes the notes of its GitHub release (see
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#versioning-and-releases)).

## [1.7.0] - 2026-09-26

### Added
- A context meter in a chat's header, to the right of *Est. cost*: how full Claude's context
  window is (for example 120k / 1M, 12%). In-app chats have a **Compact** button beside it,
  which summarizes the conversation so far to free up room, like `/compact`. Terminal and outside
  sessions show the context size from their transcript.
- *Total tokens* in a chat's header: every token the session has used, subagents included. Hover
  for input, output and cache.
- Each finished reply shows the tokens it used next to *Done in*, for example
  "Done in 12s · 45.2k tokens".
- *Most tokens this week* on the Board lists the 10 conversations that used the most tokens since
  your plan's weekly limit reset (or in the last 7 days), subagents included. **Show all** lists
  every one, with a filter. Click one to open it, or to find it in History.
- Notes in the chat when the context is cleared and when the conversation is compacted.
- **Restart server** in Claude Deck Preferences, next to *Stop server now*: the server stops, starts
  again on the same address and the window reloads, so changes to Claude Deck take effect without
  reopening anything. If Claude Deck runs from the sign-in task, the task keeps watching the new
  server.
- The running version (for example v1.7.0) next to *Live* at the bottom of the sidebar.

### Changed
- A redesigned, much shorter session header, so the conversation gets more room:
  - Above the title: the status, a badge when subagents are running, and the full folder path and
    session ID with their copy and open buttons.
  - **▾** beside the title opens a menu with **Rename**, **Tag color** (a fly-out of colors),
    **Changes**, **Continue in terminal** and **Subagents**. The separate *Open folder* button is
    gone; the folder's ↗ opens it.
  - One row of controls under the title: model, effort, permissions, plugins, context (with
    **Compact**), *Est. total cost*, *Current cost* and *Total tokens*, with **End session** on the
    right.
  - The header's *Stop* button is gone: the reply box's **Interrupt** does the same (with nothing
    typed, it just stops Claude).
- The icons beside tool calls in a chat are off by default. Turn them on in Claude Deck
  Preferences → Appearance → *Tool calls*.
- The subagents panel opens by itself when Claude starts a subagent. **✕** closes it until another
  starts, and **Subagents** in the session menu opens it again.

### Fixed
- *Est. cost* no longer goes back to $0 when the context is cleared. It now covers everything the
  session has used in Claude Deck, across `/clear` and resumes. The new *Current cost* shows the
  current conversation's cost, which is what *Est. cost* showed before.

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
