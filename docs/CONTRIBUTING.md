# Setup and git workflow

First-time setup for a contributor, and the feature-branch and pull-request cycle. `main` is shared;
never commit to it directly.

## First-time setup

1. **Install the prerequisites** listed in the [README](../README.md#requirements) (Node.js 22+,
   Git, Claude Code, Windows Terminal).
2. **Clone the repo** somewhere outside a synced folder if you can (OneDrive and similar can lock
   files inside `.git`):
   ```powershell
   git clone https://github.com/BPT-CIPP/Claude-Deck.git
   cd Claude-Deck
   ```
3. **Configure git for the team workflow**, once per clone:
   ```powershell
   git config pull.rebase true
   git config rebase.autoStash true
   ```
4. **Check that everything passes** before you change anything: `npm run verify`.
5. **Run it.** To use your clone as your everyday Claude Deck, run
   `powershell -ExecutionPolicy Bypass -File .\Start-ClaudeDeck.ps1 -Install` (see the README).
   To try changes, use a sandbox instead ([TESTING.md](TESTING.md)).
6. *(Optional)* Add a `CLAUDE.local.md` in the repo root for anything specific to you or your
   machine (GitHub account, auth, local notes). It's gitignored, and Claude Code reads it after
   `CLAUDE.md`.

## Standard change cycle

1. Start from the latest `main`:
   ```powershell
   git checkout main
   git pull --rebase origin main
   ```
2. Branch per logical unit of work:
   ```powershell
   git checkout -b feature/<short-description>   # or fix/<...>, docs/<...>
   ```
3. Work in small, focused commits whose messages say *what and why* (see
   [Commit messages](#commit-messages)).
4. **Verify**: `npm run verify`, plus a sandbox check for anything that changes behavior
   ([TESTING.md](TESTING.md)). If you learned something new about Claude Code's internals, record it
   in [CLAUDE-CODE-INTERNALS.md](CLAUDE-CODE-INTERNALS.md) in the same change.
5. Bump the version in `package.json` and add its section to `CHANGELOG.md`
   ([Versioning and releases](#versioning-and-releases)), re-sync onto the newest `main`, then
   publish:
   ```powershell
   git pull --rebase origin main
   git push -u origin feature/<short-description>
   ```
6. Open a pull request on GitHub. Say what changed, why, and how you checked it (what ran, what you
   only read, what you assumed). Another contributor reviews when feasible; merge once the checks are
   green.
7. Delete the branch after merge.

## Rules

- **Never commit to `main`, never force-push `main`,** and never push a stale snapshot. A rejected
  (non-fast-forward) push means you're behind: `git pull --rebase` and retry, don't force.
- **Rebase, not merge,** when syncing (`pull.rebase=true`, set in first-time setup).
- **Conflicts:** resolve the marked files, `git add` them, then `git rebase --continue`; bail out
  with `git rebase --abort`. If it's code you don't fully understand, stop and ask its author rather
  than guessing.
- **One logical change per pull request.** Unrelated fixes you notice go in their own branch.
- **Don't commit local or personal files.** `CLAUDE.local.md`, `.claude/settings.local.json`, logs
  and editor folders are gitignored; keep it that way. The shared `.claude/settings.json` and
  `.claude/hooks/` *are* committed on purpose: they're how the checks are enforced.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): a `type: subject` line, no scope,
imperative mood. Say *what and why*, in the body when it helps.

- **Types:** `feat:` (new feature), `fix:` (bug fix), `docs:`, `refactor:`, `style:`, `perf:`,
  `test:`, `chore:`.
- **Breaking changes:** add `!` after the type (`feat!: ...`) and a `BREAKING CHANGE: ...` footer
  saying what breaks and how to migrate (for example, a renamed preference and how existing values
  carry over).

```
feat: add Ctrl+Tab to cycle through sessions
fix: keep subagent token counts from dropping mid-run
docs: explain the sandbox in TESTING.md
feat!: move preferences to a new file format

BREAKING CHANGE: prefs.json is converted on first start; older versions can't read the new file.
```

## Versioning and releases

`package.json` `version` is the single source of truth: [semver](https://semver.org/), bumped in
the same change set.

| Commit type | Version bump |
|---|---|
| `fix:` | PATCH |
| `feat:` | MINOR |
| `feat!:` / `BREAKING CHANGE:` | MAJOR |
| `docs:`, `refactor:`, `chore:`, `style:`, `test:`, `perf:` | usually PATCH, or none |

**Work out the bump from `origin/main` when you push, not from when you branched.** `main` moves
while you work, and resolving that conflict the wrong way lowers the version.

**Every version bump gets a `CHANGELOG.md` section** in the same change set: a
`## [X.Y.Z] - YYYY-MM-DD` heading, entries under `### Added` / `### Changed` / `### Fixed` /
`### Removed` written for the people using Claude Deck, and an `[X.Y.Z]: <compare link>` line at the
bottom. `npm run verify` (and so CI) fails without it. A change that doesn't bump the version
(docs-only, for example) doesn't need a section.

**Releases are automatic.** When a merge brings a new version to `main`,
`.github/workflows/release.yml` tags the merge commit `vX.Y.Z` and publishes a GitHub release whose
notes are that version's changelog section (`node tools/changelog.js notes X.Y.Z` prints them).
Don't create tags or releases by hand. Preferences in Claude Deck shows the version the server is
running, with a link to the releases.

## Getting a change to everyone

There's nothing to build or package. After a pull request merges, teammates update their clone and
restart the server:

```powershell
git checkout main
git pull --rebase origin main
```

Then in Claude Deck, **Preferences → Stop server now**, and start it again with the **Start Claude
Deck** shortcut (the stopped server stays stopped until you do, or until you next sign in). Changes
only to files in `public\` need just a reload of the window (Ctrl+R). Stopping the server ends open
chats, which come back as *Ended* with *Resume*.

---

*Part of the [CLAUDE.md](../CLAUDE.md) instruction set. CLAUDE.md is the always-loaded index; this
file is read when a task calls for it.*
