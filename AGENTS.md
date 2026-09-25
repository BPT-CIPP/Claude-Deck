# AGENTS.md

This repository's agent instructions live in **[CLAUDE.md](CLAUDE.md)**. Read that first.

This file exists so that agent tools which look for `AGENTS.md` by convention find a pointer
rather than nothing. It's deliberately a pointer, not a second copy: two instruction files for one
repo drift apart.

## The short version, if you read nothing else

- **No build step, no npm dependencies, no new executables.** Plain Node.js and plain browser
  scripts, because managed Windows PCs block executables that aren't prevalent.
- **Verify before you finish:** `npm run verify`. A Claude Code Stop hook runs it for you when code
  changed, and CI runs it on every pull request.
- **No Claude API calls, ever,** from the app or its tests. Test with `npm run sandbox` (the real
  `claude.exe` against a local mock API), never against a running Claude Deck.
- **`docs/CLAUDE-CODE-INTERNALS.md` is the record of Claude Code's undocumented behavior.** Read the
  relevant section before relying on it, and add to it in the same change when you learn something.
- **Feature branches and pull requests only.** Never commit to `main`.
