# Testing

Nothing here calls the Claude API or costs anything: the tests use a stand-in for Claude Code, and
end-to-end checks run the real `claude.exe` against a local mock of the API.

## The gate: `npm run verify`

```powershell
npm run verify    # everything below; the gate for every change
npm run syntax    # parse every .js file, and Start-ClaudeDeck.ps1 with Windows PowerShell 5.1
npm run changelog # package.json's version is semver and CHANGELOG.md has a section for it
npm test          # the node:test suite (test/*.test.js)
```

The same checks run in three places, so they can't disagree about what "green" means:

- **You**, before committing.
- **Claude Code's Stop hook** (`.claude/hooks/verify-on-stop.js`, registered in
  `.claude/settings.json`). It runs before a session can end, but only when a `.js`, `.json`,
  `.html`, `.css` or `.ps1` file has changed, and not again for a tree that already passed. If it
  blocked the last stop and nothing has changed since, it lets the session end rather than block
  forever.
- **GitHub Actions** (`.github/workflows/checks.yml`) on every pull request and every push to
  `main`, on Windows with Node 22.

Needs Node.js 22 or newer: `node --test` accepts file patterns like `test/*.test.js` only from
Node 21 on, and Node 20 is past its end of life.

## The unit tests

`test/*.test.js`, using `node:test`. Any new `test/<area>.test.js` is picked up automatically; there's
no list to add it to. Call `sandbox()` from `test/helpers.js` at the top of a test file: it points
`CLAUDE_CONFIG_DIR` and `CLAUDE_DECK_DATA` at throwaway folders, so a test never touches the real
`~/.claude` or Claude Deck's own data. It also sets `CLAUDE_DECK_SKIP_SYSTEM_SETTINGS=1`, so the
billing guard ignores this PC's registry and managed settings (an API key set there would otherwise
refuse every test chat); billing tests pass those sources in themselves.

`test/tools.test.js` covers the repo's own guards, such as the push guard hook
(`.claude/hooks/guard-git-push.js`).

`test/fixtures/fake-claude.js` stands in for `claude.exe`. In terminal mode it writes the status
file and transcript lines Claude Code would, on a fixed schedule (busy, needs you, busy, idle). With
`--input-format stream-json` it speaks the chat protocol. The prompts it reacts to are listed at the
top of the file: "write" asks permission, "ask" asks a question, "slow" takes 3 seconds, "delegate"
starts subagents, "run slow" runs a shell command reported as a task.

## A sandbox Claude Deck: `npm run sandbox`

**Never test server changes on your own running Claude Deck.** Chats are child processes of the
server, so restarting it ends every open chat, possibly including the Claude Code session making the
change. Use a sandbox instead:

```powershell
npm run sandbox                      # real claude.exe, talking to the mock API
node tools/sandbox.js --fake         # the stand-in Claude instead
node tools/sandbox.js --keep         # keep the previous sandbox's chats and data
node tools/sandbox.js --port 47880   # if the default sandbox port (47874) is busy
node tools/sandbox.js --mock-port 47990   # if the mock API's default port (47994) is busy
```

It starts `test/fixtures/mock-anthropic-api.js` and a separate Claude Deck server (with *Allow API
billing* on, since it gives Claude a fake key for the mock; see `src/billing.js`, and with any
cloud-provider switch or other credential in your environment removed so nothing can reach a real
account) with its own data
folder, Claude config folder and port (all under `%TEMP%\claude-deck-sandbox`), prints the address
to open, and stops everything on Ctrl+C. Your real Claude Deck, sign-in and conversations are
untouched.

In the sandbox, start chats in the printed project folder and drive them with the mock's scripted
prompts (listed at the top of `test/fixtures/mock-anthropic-api.js`), for example:

| Prompt | What the mock API does |
|---|---|
| `please run …` | a Bash tool call |
| `please run slow` | a Bash tool call that takes 3 seconds |
| `please write …` | a Write tool call (permission prompt unless auto-accepting edits) |
| `please ask …` | a multiple-choice question |
| `please slow …` | a reply after 6 seconds (try Interrupt) |
| `please delegate`, `… slow`, `… foreground` | subagents |
| `please stream` / `please stream thinking` | a reply streamed in small pieces |
| `please delegate wait` | a subagent Claude waits for that only waits (try Ctrl+B) |
| `please plan` | an `ExitPlanMode` plan to approve (switch to plan mode first: Shift+Tab twice) |
| `please edit` | a Read, then an Edit of `edit-me.txt` (asks first; shows the diff) |
| `please todo` / `please tasks` | `TodoWrite` / `TaskCreate` calls (Claude Code turns these tools off in stream-json, so they come back as errors) |
| `please use tool <Name>` | a call to any tool name (unknown ones come back as errors) |

**Prompts that run a shell command run it for real.** `please run …`, and the subagents' Bash
calls, make the real `claude.exe` start a shell. On Windows that's Git Bash, and `bash.exe`
starts Git's `locale.exe`. On a managed PC with Defender's attack surface reduction rule for
uncommon executables, that is blocked and reported to your security team. Where that rule is on,
test with the prompts that only reply (`please stream`, `please slow`, `please write`,
`please ask`, `please plan`, `please edit`, `please delegate wait`). A `!command` typed in the reply
box runs in Windows PowerShell, not Git Bash, so it's safe there.

**Keyboard shortcuts** like Ctrl+Tab and Ctrl+W only reach the page in an app window; in a normal
browser tab the browser keeps them. To test them, open the sandbox address with
`msedge --app=<address>`.

**Terminal sessions** open real Windows Terminal windows. If you're an agent, say so before running
one.

## Probing Claude Code directly

To check how Claude Code behaves (a new message, field or file) without any cost, run it against the
mock with a throwaway config folder:

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:TEMP\claude-probe"
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:47990'
$env:ANTHROPIC_API_KEY = 'sk-ant-mock-not-a-real-key'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
node test\fixtures\mock-anthropic-api.js 47990    # in another window
claude --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio
```

Then write stream-json messages to its stdin (see
[CLAUDE-CODE-INTERNALS.md](CLAUDE-CODE-INTERNALS.md)), and record what you learn there, with the
Claude Code version.

## What the tests can't tell you

- **The mock is simpler than the real API.** It sends most replies in one piece, never thinks for
  long, and has no rate limits. A behavior that depends on timing or on how the real API streams can
  look fine in every test. Say so when a check only ran against the mock.
- **How it looks and feels.** Rendering, smoothness and layout need eyes on the running page: use
  the sandbox, and for anything visual check a light theme and a dark theme.
- **Your real Edge window.** Taskbar icons, installed-app behavior and which keys Edge hands to the
  page can only be confirmed in the installed Claude Deck window.
