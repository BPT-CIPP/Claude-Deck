# Changelog

What changed in each version of Claude Deck. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/): MAJOR for breaking changes, MINOR for new features,
PATCH for fixes. Each version's section becomes the notes of its GitHub release (see
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#versioning-and-releases)).

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

[1.6.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/BPT-CIPP/Claude-Deck/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/BPT-CIPP/Claude-Deck/releases/tag/v1.0.0
