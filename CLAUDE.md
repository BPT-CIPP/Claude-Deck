# CLAUDE.md

Guidance for Claude Code working in this repository.

> **Personal overrides:** if `CLAUDE.local.md` is present in the repo root, read it first. It holds
> one contributor's machine-specific setup (GitHub account, auth, local workflow notes), is
> gitignored, and takes precedence for that contributor.

## Project overview

Claude Deck is a Windows dashboard for Claude Code sessions: in-app chats (Claude Code driven over
its streaming JSON protocol) plus tracked Windows Terminal sessions, history, a change timeline,
and a Claude Code settings editor. **No build step, no npm dependencies**: plain Node.js on the
server (`src/`) and plain browser scripts in the page (`public/`). `package.json` names the checks
and the `start` / `serve` commands; those start the real server (on the usual port and data
folder), so never use them to test a change.

## Where everything is

This file is loaded into every session, so it holds only what a task needs before you know what the
task is. Read the one that matches the work:

| Doing | Read |
|---|---|
| Anything relying on files Claude Code writes, or on its stream-json messages | **[docs/CLAUDE-CODE-INTERNALS.md](docs/CLAUDE-CODE-INTERNALS.md)**, the reverse-engineering record. Not optional; see below. |
| Understanding how the pieces fit, where code lives, why it's built this way | **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** |
| Running the checks, the sandbox, or a live probe of Claude Code | **[docs/TESTING.md](docs/TESTING.md)** |
| Cloning, branching, committing, versioning, opening a pull request | **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** |
| Installing, using or troubleshooting Claude Deck | **[README.md](README.md)** |

## Commands

```
npm run verify     # the gate: syntax + changelog + tests. A Stop hook runs it when .js/.json/.html/.css/.ps1 changed.
npm run syntax     # parse every .js file, and Start-ClaudeDeck.ps1 with Windows PowerShell 5.1
npm run changelog  # package.json's version is semver and CHANGELOG.md has a section for it
npm test           # the node:test suite, test/*.test.js
npm run sandbox    # a throwaway Claude Deck: real claude.exe against the mock API (tools/sandbox.js)
node tools/release-manifest.js build [ref] | verify <manifest> [folder]   # the file list each release carries
node tools/make-icons.js   # regenerate public/icons after changing the mascot grid
```

## Non-negotiables

- **Never commit to `main`.** Feature branch and pull request, always. A PreToolUse hook
  (`.claude/hooks/guard-git-push.js`) refuses any push to `main` and any force-push, however it's
  written, backed by deny rules in `.claude/settings.json`. Commits on `main` aren't blocked; don't
  make them.
- **No npm dependencies and no new executables.** Managed PCs commonly run Defender's attack surface
  reduction rule that blocks executables that aren't prevalent (Electron and node-pty were tried and
  blocked). Everything runs on `node.exe`, `wt.exe`, Edge, `claude.exe`, `git` (with the GitHub CLI,
  for *Check for updates*) and Windows built-ins (`powershell.exe`, `reg.exe`, `where.exe`,
  `schtasks.exe`, `explorer.exe`, `choice.exe`; see docs/ARCHITECTURE.md). Don't work around it, for
  example with runtime-compiled C# or P/Invoke.
- **Claude Deck makes no Claude API calls.** It reads files Claude Code writes and relays what the
  user types. Tests and checks never hit the real API: use `test/fixtures/fake-claude.js`, or the
  real `claude.exe` against `test/fixtures/mock-anthropic-api.js` (`npm run sandbox`).
- **The plan-usage call is the only outbound request Claude Deck makes on its own.** `src/usage.js`
  reads the sign-in token from `.credentials.json` and never refreshes or rewrites it (Claude Code
  owns it), and sends it only to that endpoint. Tests stub the fetcher. *Check for updates*
  (`src/update.js`) runs `git fetch` from GitHub, signed in through `gh auth git-credential`, only
  when the user clicks it, and only fast-forwards a clean copy on `main`; tests use local
  repositories. (Installing a plugin or updating a marketplace downloads, but that's Claude Code's
  own `claude plugin` command, run only when the user asks.)
- **Sessions use the Claude plan, never per-use billing.** `src/billing.js` refuses to start a chat or
  terminal session when Claude Code would bill an Anthropic API or cloud account (an API key, a key
  helper, or a cloud-provider switch, from the environment or Claude Code's settings). The only way
  past it is *Allow API billing* in Claude Deck Preferences, off by default. Every new way of
  starting Claude Code must call `requirePlanBilling`.
- **Never write to Claude Code's files** except through `src/settings-files.js` (backup first,
  refused if the file changed since it was read) and `src/trash.js` (deleting a conversation the user
  chose: moved to the trash, never deleted outright, refused while the conversation is open).
  Plugins and marketplaces change only through Claude Code's own CLI (`src/plugins.js`).
- **Never test against the live server.** A chat's `claude.exe` is a child of the server, so
  restarting it ends those chats, possibly including the session doing the work. Use
  `npm run sandbox`, and leave restarting the real one to the user.
- **`Start-ClaudeDeck.ps1` stays Windows PowerShell 5.1 compatible and plain ASCII** (5.1 misreads
  UTF-8 without a BOM). `npm run syntax` parses it with 5.1.
- **Nothing machine-specific in the repo.** No usernames, absolute paths, tokens or one PC's
  quirks. Resolve locations at run time (`src/paths.js`, `src/claude-locate.js`); personal notes go
  in `CLAUDE.local.md`.
- **No native dialogs from the server** (they open behind the dashboard), and **never `innerHTML`**
  in the page (transcript and chat text is untrusted; build DOM with `Deck.h()`).

## The Claude Code internals rule: not optional

Claude Code's files and protocol are undocumented and change between versions.
[docs/CLAUDE-CODE-INTERNALS.md](docs/CLAUDE-CODE-INTERNALS.md) is the record, tagged ✅ verified /
⚠️ inferred.

1. **Before** relying on anything Claude Code writes or sends, **read the relevant section.**
2. **Whenever you discover, verify or disprove** a file layout, message, field or behavior, **record
   it there in the same change set**, with the Claude Code version you checked against. A change
   built on new Claude Code internals without updating the record is incomplete.

## Conventions

- CommonJS, `'use strict'`, 2-space indent, single quotes. Match the surrounding code.
- Page scripts hang off `window.Deck`; DOM is built with `Deck.h()`.
- User-facing copy: sentence case, plain verbs; errors say what happened and what to do.
- Status colors mean status only: amber needs you, cyan working, green idle, gray ended. Other colors
  (diffs, the mascot) have their own tokens.
- Themes: an id in `THEMES` (`src/prefs.js`), a block in `public/app.css`, a label in `THEME_GROUPS`
  (`public/app.js`); `test/prefs.test.js` checks they match.
- The mascot is a 14x10 grid in `tools/make-icons.js` and the same grid as an SVG in
  `public/index.html`; change both.
- `public/vendor/claude-code-settings.schema.json` is a snapshot of SchemaStore's Claude Code
  settings schema (Apache-2.0); refresh it by downloading
  `https://json.schemastore.org/claude-code-settings.json` over the file.

## Lessons this repo paid for

Short, because a long list gets ignored. They apply to changes of any kind:

- **Measure before you fix.** "The chat is choppy" had two plausible causes. A read-only probe of the
  live event stream found the real one in minutes, after a first fix aimed at the wrong one.
- **A mock that answers in one piece can't show a streaming or timing problem.** Every test passed
  while real replies behaved differently. Say when a check only ran against the mock.
- **Similar-looking events aren't the same thing.** Long shell commands arrive as the same task
  messages as subagents and were listed as subagents until someone read `task_type`.
- **Reusing an action reuses all of it.** Ctrl+W first reused *End*, which also removes the chat, and
  its Undo could never have worked. Exercising the shortcut caught it; reading the code hadn't.
- **A check you've never seen fail proves nothing.** Before trusting a new check, make it fail on
  purpose; the syntax check was trusted only after it caught a planted broken file.

## Versioning and commits

`package.json` `version` is the single source of truth: semver, bumped in the same change set
(`fix:` PATCH, `feat:` MINOR, `feat!:` / `BREAKING CHANGE:` MAJOR). Work out the bump from
`origin/main` at push time. Every bump adds its `CHANGELOG.md` section (`npm run verify` checks);
merging a new version to `main` tags and releases it automatically, so never tag by hand. Commits
follow [Conventional Commits](https://www.conventionalcommits.org/): `type: subject`, no scope,
imperative, saying what and why. Details:
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).
