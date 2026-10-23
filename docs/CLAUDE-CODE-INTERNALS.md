# Claude Code internals

Claude Deck is built on parts of Claude Code that aren't documented: the files it writes, the JSON
protocol of its streaming mode, and a few undocumented messages. Everything here was worked out by
reading those files and by probing the real `claude.exe` against the local mock API (so no model
calls were made). Claude Code can change any of it in an update.

Tags: ✅ verified (how is noted) · ⚠️ inferred or unconfirmed.

## The rule: not optional

1. **Before** relying on anything Claude Code writes or sends, read the section here. It will save
   you rediscovering a quirk, or getting burned by one.
2. **Whenever you discover, verify or disprove** a file layout, message shape, field or behavior,
   **record it here in the same change set**, with the Claude Code version (`claude --version`)
   you checked against. A change that relies on new Claude Code internals without updating this
   file is incomplete.
3. Probe with the real `claude.exe` against `test/fixtures/mock-anthropic-api.js` (see
   [TESTING.md](TESTING.md)), never against the real API.

Last full check: **Claude Code 2.1.281**.

---

## Finding Claude Code

✅ `src/claude-locate.js` checks, in order: the path set in *Claude Deck Preferences*, `where.exe claude`,
the native installer's `%USERPROFILE%\.local\bin\claude.exe`, then winget's
`%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe` and npm's global folder, for a Claude Code
installed after the server started (its PATH predates the install). ⚠️ The winget path is inferred
from how winget links portable packages; it wasn't checked against an `Anthropic.ClaudeCode`
install. An npm global install puts a
`claude.cmd` shim on PATH that wraps
`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` (older versions ship
`cli.js` instead). Launch the real `claude.exe`, not the shim, so its process id is Claude's own.

✅ `claude --version` prints and exits locally; it makes no model request.

### Signed in or not (2.1.296)

✅ `claude auth status` prints JSON (`{ "loggedIn": false, "authMethod": "none", ... }`; signed in:
`"loggedIn": true, "authMethod": "claude.ai"`) and **exits 0 when signed in, 1 when not**. `--text`
prints `Not logged in. Run claude auth login to authenticate.` instead. `claude auth login`
(`--claudeai`, the default: the Claude plan; `--console` would be API billing) signs in through the
browser. `Start-ClaudeDeck.ps1 -Install` uses both, and checks `claude --help` lists `auth` first:
a version without it would take `auth status` as a prompt.

✅ A chat on a signed-out Claude Code: after `system/init` (`apiKeySource: "none"`) comes a synthetic
`assistant` message (`model: "<synthetic>"`, `error: "authentication_failed"`, text
`Not logged in · Please run /login`), then a `result` with `is_error: true` and the same text, and the
process exits 1. No request is made. `/login` doesn't work in stream-json (it answers "/login isn't
available in this environment."); the user has to sign in from a terminal.

✅ A sign-in that expired mid-chat (seen in a real chat, 2026-10-15): the reply and the error result
read `Failed to authenticate: OAuth session expired and could not be refreshed`, and the process
keeps running. ⚠️ That this message also carries `error: "authentication_failed"` is inferred from
the signed-out case, so `src/chat.js` matches the text too (`AUTH_ERROR`) and adds sign-in
instructions (`claude auth login`) either way, and answers a typed `/login` with them instead of
sending it.

## Updating

Read from Claude Code 2.1.308's own code (the JavaScript bundled in `claude.exe`), 2026-10-23:

- ✅ **Only the terminal interface updates Claude Code.** The three places that run the
  automatic update check (the npm updater, the native installer's, and the package-manager one)
  are all components of the interactive terminal interface. Streaming mode (`--input-format
  stream-json`, what chats use) never draws that interface, so **chats never update Claude Code**.
  Checked by running too: a stream-json session left open for 2 minutes didn't touch the update
  lock. An Inlaid CLI session did take it (`.update.lock` held its pid).
- ✅ The check runs about 10 s after the interface starts, then at most every 5 minutes. It takes
  `~/.claude/.update.lock` (the holder's pid; a lock older than 5 minutes is stale) and records the
  outcome in `~/.claude/.last-update-result.json`: `{ timestamp, path: "npm-global" | "npm-local" |
  "native", outcome, status, version_from, version_to, error_code }`.
- ✅ Anthropic can cap the version it updates to remotely (`tengu_max_version_config`), and it
  respects `minimumVersion` / `requiredMaximumVersion` in managed settings. So a version can be on
  npm before Claude Code will install it (2.1.309 was on npm's `latest` while 2.1.308 sessions
  didn't take it).
- ✅ **On Windows, an npm install can't replace `claude.exe` while any process is running it**
  (EBUSY/EPERM on `claude.exe`): Claude Code reports `update_apply_exe_locked` and, in the
  interface, stops trying for the session after two such failures. Every open chat runs
  `claude.exe`, so with chats open an npm-installed Claude Code can't update. (The native
  installer puts each version in its own folder, so it isn't affected.) ⚠️ The exact text
  `claude update` prints in that case wasn't seen; `src/server.js` matches EBUSY, EPERM and
  "locked".
- ✅ `claude update` (or `upgrade`) checks and installs in one go; there's no check-only option.
- ✅ npm's `https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags` lists the
  release channels: `{ latest, stable, next }`. `autoUpdatesChannel` in settings picks `latest`
  (the default) or `stable`. Claude Deck reads this to say a newer version is out; Claude Code
  still decides whether to install it.

## CLI flags Claude Deck uses

✅ From `claude --help`: `--session-id`, `--resume <id>`, `--continue`, `--fork-session`, `--model`,
`--effort`, `--permission-mode`, `--add-dir`, `--worktree`, plus, for chats,
`--output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio`.
Going back to an earlier message also uses `--resume-session-at <entry uuid>` (see "Rewinding the
conversation").

✅ Model aliases, from the alias table inside `claude.exe`: `opus`, `sonnet`, `haiku`, `fable`,
`best`, `opus[1m]`, `sonnet[1m]`, `fable[1m]`, `opusplan`. Any full model ID also works.

## Live status: `~/.claude/sessions/<pid>.json`

✅ Every running Claude Code process writes one: `pid`, `sessionId`, `cwd`, `kind`, `status`
(`busy` | `idle` | `waiting`), `waitingFor` (why it's waiting), `statusUpdatedAt`, `name` and
`nameSource`. It's removed when the process exits.

✅ Checked with 2.1.281: it also has `startedAt` (ms) and `procStart`, the process's creation time
as a Windows FILETIME (100 ns steps since 1601; `procStart / 10000 - 11644473600000` matched the
process's start time in ms exactly). A Claude that's killed rather than ending cleanly leaves its
file behind, and Windows reuses pids, so before ending an outside session `src/live.js`
(`isSameProcess`) checks that the pid's creation time still matches `procStart`. Stream-json processes (in-app chats) write one
too, so `src/live.js` claims chats by pid; otherwise every chat would also show up as an
outside session.

## Transcripts: `~/.claude/projects/<project>/<sessionId>.jsonl`

✅ One JSON record per line. `<project>` is the session folder with every character outside
`[a-zA-Z0-9]` replaced by `-`. Record types beyond `user` / `assistant`: `ai-title`,
`custom-title`, `last-prompt`, `cost-state`, `tag`, `pr-link`, `queue-operation`, `attachment`,
`file-history-snapshot`, `file-history-delta`, `mode`, `permission-mode`. `isSidechain: true` marks
subagent records, and `isMeta: true` marks records that aren't real prompts.

✅ Checked in real transcripts (2.1.281, tag names counted only): Claude Code's own `user` records
start with one of these tags, which `promptText` (`src/history.js`) skips: `<command-name>`,
`<command-message>` (slash commands), `<local-command-caveat>`, `<local-command-stdout>`,
`<task-notification>` (background tasks), `<bash-input>`, `<bash-stdout>` (`!` commands).
⚠️ Also skipped by name, not yet seen in a transcript: `<command-args>`, `<local-command-stderr>`,
`<bash-stderr>`, `<system-reminder>`, `<user-prompt-submit-hook>`. Any other prompt starting with
`<` is the person's own text. Pasted text arrives wrapped in `<pasted_content ...>` tags, which
are stripped for display.

✅ One API message can be split over several `assistant` records that share `message.id`, one per
content block (thinking, text, tool_use).

✅ Each `assistant` record carries `message.usage` (`input_tokens`, `output_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`). Records split from one message repeat it,
so it's counted once per `message.id`. Local command output (for example `/context`) is an
`assistant` record with model `<synthetic>` and zero usage. The latest record's input + cache +
output is how full the context was after that reply. `src/history.js` keeps these per
conversation, and per hour for the weekly usage view. Checked with 2.1.281.

✅ `cost-state` `{totalCostUSD, modelUsage: {<model>: {inputTokens, outputTokens,
cacheReadInputTokens, cacheCreationInputTokens, costUSD}}, totalAPIDuration, totalLinesAdded, …}`
is the conversation's running totals. With 2.1.281 it was written when the conversation was
cleared and when the process exited, not after each turn, so it lags while a session runs. A
resumed conversation carries on from it.

✅ Beside each transcript, a folder of the same name holds `tool-results/` (large tool outputs)
and `subagents/` (see below).

✅ Observed with 2.1.281: some of the model's longer mid-task text is recorded only as a short
`thinking` block summary, with no `text` block, and is sent that way in stream-json output too.
Claude Deck doesn't show thinking, so that text never appears in a chat. Short notes and final
answers arrive as normal `text` blocks.

### Files kept per conversation

✅ Deleting a conversation (`src/trash.js`) moves all of these that exist: the transcript, the
same-named folder beside it, `~/.claude/file-history/<sessionId>/` and
`~/.claude/session-env/<sessionId>/`.

## Stream-json protocol (in-app chats)

Newline-delimited JSON over stdin and stdout. Sources: the Python Agent SDK, plus probes.

✅ **Sent:** `{type:'user', uuid, message:{role:'user', content}, parent_tool_use_id:null,
session_id}`. `content` can include `{type:'image', source:{type:'base64', media_type, data}}`
blocks, and image-only messages work. Control requests are
`{type:'control_request', request_id, request:{subtype, ...}}` with subtypes `initialize`
(returns `commands`, the slash commands), `interrupt`, `set_model`, `set_permission_mode`,
`apply_flag_settings` (effort, below), `stop_task` `{task_id}`, `rewind_files` (see File
checkpoints) and `get_context_usage` (below).

✅ **Received:** `system` (`init`, `status`, `task_*`), `assistant`, `user` (tool results),
`result`, `control_request`, `control_cancel_request`, `control_response`, `command_lifecycle`.

✅ **Permission prompts** arrive as `control_request` `can_use_tool`, with `tool_name`, `input`,
`permission_suggestions`, and `requires_user_interaction: true` for AskUserQuestion. Answer with
`control_response` `{behavior:'allow', updatedInput}` (plus `answers` for questions, and
`updatedPermissions` for an "always" choice) or `{behavior:'deny', message}`.

✅ **Turns.** No `system/init` arrives before the first message; the `initialize` response means the
process is ready. After that, a `system/init` starts every turn, including queued messages Claude
picks up after an interrupt (it may merge several into one turn), so busy state keys off it.
`result` ends a turn, and an interrupted turn ends with `terminal_reason: aborted_streaming`.

✅ **Cost and tokens in `result`.** Checked with 2.1.281 against the mock:
- `total_cost_usd` and `modelUsage` (`{<model>: {inputTokens, outputTokens,
  cacheReadInputTokens, cacheCreationInputTokens, costUSD, contextWindow, maxOutputTokens}}`) are
  running totals for the *conversation*, subagents included.
- They start again at zero after `/clear`. A resumed conversation carries on from its saved
  `cost-state`. A fork (`--fork-session`) gets a new session id but carries on the original's
  totals.
- `usage` is this turn's alone, summed over its API calls, and leaves out subagents: a turn whose
  foreground subagent made 2 calls reported only the main thread's 2 in `usage`, while
  `modelUsage` grew by all 4.
- Claude Deck works out each turn's tokens from the change in the running totals, and shows the
  current conversation's running tokens (`_count` in `src/chat.js`). The turn's subagent tokens are
  that change minus its own `usage`. A local command's result (`/compact`) has zero `usage` though
  its call counts in the totals, so all of it is counted as the main conversation's. Checked against
  the mock: a turn with a foreground subagent showed 60 tokens, 30 of them the subagent's two calls.

✅ **`/clear`** sent as a user message: `conversation_reset` `{new_conversation_id, trigger:
'clear', user_message_uuid}` arrives, then a `system/init` with a **new `session_id`**, then a
`result` with `local_command: 'clear'`, `num_turns: 0` and `total_cost_usd: 0`. The new transcript
file is named after the new `session_id`. `new_conversation_id` is a different uuid from it. The
old transcript gets a `cost-state` record.

✅ **Models, with their versions.** The `initialize` response also carries `models`: `[{value,
resolvedModel, displayName, description, supportsEffort?, supportedEffortLevels?,
supportsAdaptiveThinking?, supportsFastMode?, supportsAutoMode?}]`. With 2.1.284 on a Claude plan:
`default` → `claude-opus-5-5` ("Default (recommended)"), `opus` → `claude-opus-5-5`,
`claude-fable-5-1[1m]` → `claude-fable-5-1` (Fable is listed by its full 1M ID, not an alias),
`sonnet` → `claude-sonnet-5-5`, `haiku` → `claude-haiku-4-5-20251001`. `description` starts with
the versioned name ("Sonnet 5.5 · Efficient for routine tasks"), which is where Claude Deck's menus
get it. An alias follows the newest model as Claude Code is updated, so the list is re-read for each
Claude Code version (`src/models.js`).

⚠️ **The list's shape varies.** Seen with the same 2.1.284: signed in with an API key, the 1M
variants are separate entries (`opus[1m]` "Opus (1M context)", `sonnet[1m]` "Sonnet 5.5 (1M
context)") and descriptions carry prices. A chat's initialize on a Claude plan had versioned display
names ("Opus 5.5", with the version no longer in `description`) and also listed earlier versions by
full ID, newest first after the current one: `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`,
`claude-opus-4-8`, `-4-7`, `-4-6`, `claude-sonnet-4-6`. What decides which shape (sign-in, a server
flag, the account) isn't known, so Claude Deck groups by the family in the alias or ID
(`familyOf`) and reads the version from the name or the description. Initialize alone makes no model request; with
`--strict-mcp-config` and no `--mcp-config`, no MCP servers start. About 2 s.

✅ **Updates.** `claude update` prints `Current version: …`, `Checking for updates to latest
version...`, then `Claude Code is up to date (…)` (exit 0) when there's nothing newer; checked with
2.1.284 (an npm global install, then npm's `latest` too). Background updates are on unless
`DISABLE_AUTOUPDATER` (background only) or `DISABLE_UPDATES` (every update path) is set, in the
environment or in settings' `env`; `autoUpdatesChannel` is `latest` (default) or `stable`
(SchemaStore's settings schema). ⚠️ What `claude update` prints when it does install a version, or
fails, hasn't been seen yet.

✅ **Slash commands only run at the start of a message.** Checked with 2.1.284 against the mock,
with a user command `greet` (`commands/greet.md` in a sandbox `CLAUDE_CONFIG_DIR`): `/greet alice`
reached the API as the command's expanded body, but `please /greet bob now` and `hello there
/clear` reached it as the literal text, with no `local_command` in the `result` and no
`conversation_reset`. A command later in a message is left to the model: the Skill tool's
description says "Users may also ask for one by name (`/<name>`, or "slash command"); that's a
request to invoke it", and that built-in commands (`/help`, `/clear`) aren't skills. So a mid-message
`/<skill>` works through the model the same way in stream-json as in the terminal, and Claude Deck
only needs its command list to open anywhere in the reply box. The `initialize` response's
`commands` entries are `{name, description, argumentHint}`, plus `builtin: true` for everything
Claude Code ships (local commands such as `clear` and bundled skills such as `dataviz` alike) and
`aliases` on some; nothing tells a local command from a skill.

✅ **`/compact`** sent as a user message works in stream-json. You get `system/status` `{status:
'compacting'}`, then `{status: null, compact_result: 'success'}`, then `system/init`, then
`system/compact_boundary` `{compact_metadata: {trigger: 'manual'|'auto', pre_tokens, post_tokens,
…}}`, a synthetic user message holding the summary, and a `result` with `local_command:
'compact'`. That result's `usage` is zero, but its running totals include the summarizing call.
The transcript gets `system` `compact_boundary` `{compactMetadata: {trigger, preTokens,
postTokens, …}}`. The summarizing call itself isn't written as an `assistant` record.

✅ **`get_context_usage`** `{detail: 'summary'|'full'}` answers how full the context window is:
`{totalTokens, maxTokens, rawMaxTokens, percentage, autoCompactThreshold, isAutoCompactEnabled,
model, categories: [{name, tokens}], apiUsage, …}`. The field description inside `claude.exe` says
`full` (the default) counts each category with the token-counting API, while `summary` answers
from the last response's usage plus local estimates. Claude Deck asks for `summary` after each
turn: with the mock logging every request, it made none. Before the first reply, `apiUsage` is
`null` and the total is the local estimate of the system prompt, tools and skills.

✅ **Sleep mid-turn.** If the PC sleeps while Claude works, the turn carries on after waking. The
transcript shows `system` entries with subtype `api_error` ("Connection error." / "Can't reach the
API server") while Claude retries, then the turn resumes and ends normally. `duration_ms` in the
`result` is clock time, sleep included, so Claude Deck subtracts the sleep it detects
(`_checkSleep` in `src/chat.js`). Seen in a 2.1.281 transcript: a 7-minute gap, then retries, then
a 140-minute gap between retries, then the turn finished.

✅ **Queued messages.** `command_lifecycle` `{command_uuid, state}` reports `queued`, `started` and
then one of `completed`, `cancelled`, `discarded` or `refused`, keyed by the `uuid` we sent, which is
how a message sent while Claude works is shown as queued until it's picked up. Messages queued
behind a running reply stay queued until it finishes, then usually run together as one turn.

✅ **Taking a queued message back.** `control_request` `cancel_async_message` `{message_uuid}` drops
it from the queue: the response is `{cancelled: true}`, or `{cancelled: false}` if Claude already
started it. The `cancelled` lifecycle arrives *before* the response. Advertised with 2.1.281's
capabilities in `system/init` (`interrupt_receipt_v1`, `interrupt_cancel_queued_v1`): `interrupt`
also accepts `cancel_queued: true` (cancels everything queued; the response lists `cancelled`), and
its response reports `still_queued` (uuids that survive a plain interrupt). The field descriptions
inside `claude.exe` document these; verified by probe against the mock.

✅ **Send now.** The terminal's Ctrl+X Ctrl+S (and Ctrl+Enter; `chat:sendNow` in its keybinding
table, beside `ctrl+x enter` = `chat:queueSubmit`) is `control_request` `interrupt` with
`send_now: true` and, optionally, `message_uuid` (the waiting message's uuid; without it every
waiting message counts). From the field description inside `claude.exe` 2.1.301: it isn't a Stop
(cancels nothing queued, ends no background task); with a message waiting behind a running turn the
CLI chooses how that turn makes way, and the response's `send_now` says which; with nothing waiting
it does nothing (`nothing_to_send`); a CLI without `interrupt_send_now_v1` handles it as a plain
interrupt. Probed with 2.1.301 against the mock, a message queued behind a 6 s text turn and then
behind a running Bash call: both times the response was `{still_queued: [<uuid>], send_now:
'stopped'}`, the running turn ended as an interrupt does (`[Request interrupted by user]` or `… for
tool use`, `result` `error_during_execution` with `aborted_streaming` / `aborted_tools`, lifecycle
`cancelled` for its message), and the waiting message's `started` and `init` followed within 10 ms.
`src/chat.js` `sendNow` sends the message, then this request with its uuid.

✅ **Changing effort mid-session.** There's no `set_effort`. `control_request` `apply_flag_settings`
`{settings:{effortLevel}}` changes it for the running session, from the next API request on:
`output_config.effort` in the request follows it (`low`, `high`, `xhigh`, `max` checked), and
`effortLevel: null` goes back to the model's default (`medium` for Opus). Like `--effort`, it only
lasts for this process; nothing is written to settings files. Verified with 2.1.281 against the
mock, which logs each request's `output_config` (a direct probe, and through Claude Deck's picker).

✅ **Text as it's written.** `--include-partial-messages` adds `stream_event` messages
(`content_block_delta` / `text_delta`, ~60 ms apart, thinking deltas too). Claude Deck deliberately
doesn't use it: replies are shown once each message is complete, because text arriving a chunk at
a time read as choppy.

## The terminal interface under a pseudo-console (terminals in the window)

How `claude.exe` behaves as the client of `conhost.exe --headless` (src/terminals.js,
src/pty-host.ps1), checked against 2.1.303:

- ✅ It draws its full interface: it sees a real console (`isTTY`), so nothing differs from Windows
  Terminal. On start it asks for win32-input-mode (`CSI ?9001 h`) and focus events (`?1004`),
  bracketed paste (`?2004`), mouse reporting (`?1000`/`?1002`/`?1003`/`?1006`), queries the kitty
  keyboard protocol (`CSI ? u`) and, once past its dialogs, switches to the alternate screen
  (`?1049 h`). xterm.js answers none of the Windows-only ones, and conhost then takes plain VT
  input (arrows as `CSI B`, Enter as CR, Ctrl+C as 0x03), which is what works.
- ✅ Resizing is the ConPTY signal pipe (`--signal`, three little-endian words: 8, columns, rows);
  conhost answers with `CSI 8 ; rows ; cols t` and draws the whole screen again, so the page can
  replay kept output at the old size and then resize.
- ✅ Ctrl+C once shows "Press Ctrl-C again to exit"; twice within a moment exits (exit code 0,
  which conhost passes on as its own). End session sends both, and ends the process tree by force
  after 3 s if that didn't do it.
- ✅ `CLAUDE_CODE_CHILD_SESSION` in the environment (Claude Code sets it for processes it starts)
  makes the terminal interface say "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
  marker": no transcript, and no `sessions/<pid>.json`, so nothing for Claude Deck to read. The
  terminal's environment drops it, as it drops `CLAUDECODE`. (Stream-json chats keep their
  transcript regardless.)
- ✅ The first-run questions can be answered in `.claude.json` beforehand (2.1.308; what
  `test/compat` does): `hasCompletedOnboarding: true` skips the text-style screen;
  `projects["C:/path/with/forward/slashes"].hasTrustDialogAccepted: true` skips the trust
  question for that folder; `customApiKeyResponses: { approved: [<the key's last 20
  characters>], rejected: [] }` skips "Detected a custom API key". Answered by keys instead, the
  trust question needs a moment after it appears: a ↓ sent before Claude Code reads input is lost,
  and Enter then picks its default, "No, exit" (exit code 0).
- ✅ A fresh `CLAUDE_CONFIG_DIR` (the sandbox) starts with the first-run dialogs: text style
  (Enter), "Quick safety check … trust this folder?" (↓ Enter), and with an API key in the
  environment "Detected a custom API key … use it?" (↑ Enter). It records the answers in its
  `.claude.json`, so a `--keep` sandbox doesn't ask again. A `--session-id` passed on the command
  line is honored once the dialogs are past.
- ⚠️ Claude's pid: conhost starts the client itself, so Claude is conhost's child
  (`Win32_Process.ParentProcessId`), and that pid is the one in `sessions/<pid>.json` (claude.exe
  is a single native binary, no wrapper). Found by the host with CIM within about 3 s; the live
  view also matches a record by the expected session id, for a host where CIM can't run.

## Plugins

Claude Deck manages plugins only through Claude Code's CLI (`src/plugins.js`), never by editing
these files. All checked with 2.1.281, offline, against a local test marketplace in a sandbox
`CLAUDE_CONFIG_DIR` (a `directory` marketplace with two plugins, one adding a slash command).

✅ **Files.** `~/.claude/plugins/installed_plugins.json` (`version: 2`, `plugins: {<id>: [{scope,
installPath, version, installedAt, lastUpdated, gitCommitSha}]}`), `known_marketplaces.json`
(`{<name>: {source, installLocation, lastUpdated}}`), `marketplaces/<name>/` and
`cache/<marketplace>/<plugin>/<version>/`, with each plugin's own `.claude-plugin/plugin.json`
(`name`, `version`, `description`). A plugin id is `<plugin>@<marketplace>`. Turning one on or off
is `enabledPlugins: {<id>: true|false}` in a settings file; adding a marketplace from the CLI
writes `extraKnownMarketplaces` in user settings.

✅ **`claude plugin list --available --json`** prints `{installed: [{id, version, scope, enabled,
installPath, installedAt, lastUpdated}], available: [{pluginId, name, description,
marketplaceName, source, installCount?}]}`. Installed plugins aren't repeated in `available`, and
`installed` has no description (read it from `plugin.json`). About 1 s locally and 2 s with the
official marketplace's 313 plugins; the output is ~185 KB.

✅ **`claude plugin install|enable|disable <id> --json`** prints one line: `{command, outcome:
"ok"|"failed", plugin, pluginId, scope, message, failureCode?}`. On failure the exit code is 1 and
the JSON is still on stdout. Install defaults to user scope; enable and disable find the scope
themselves.

⚠️ **Installs a person must confirm.** A marketplace can install a plugin by running a command it
declares (`command_source`, or a `headersHelper` for the download). With `--json` Claude Code refuses
with `failureCode` `command_source_refused` or `entry_helper_unconfirmed` and a `shownCommand`
(`{kind, pluginId, command, archiveUrl?, catalogRevision, sha256}`). Installing again with
`--accept-command <sha256>` accepts exactly that command, for that catalog, and nothing else.
Inferred from the command's help text and the code inside `claude.exe`; not tried against a real
marketplace that declares a command.

✅ **Categories.** A marketplace's own catalog, `<installLocation>/.claude-plugin/marketplace.json`,
gives plugins a `category` (`plugins[].category`, a lowercase word such as `development`,
`database` or `productivity`). `plugin list` doesn't pass it on, so Claude Deck reads it from
there, read only. In the official marketplace (2026-09-26), 300 of 314 plugins have one, across
13 categories; a few also have `tags` or `keywords`.

✅ **Marketplaces.** `claude plugin marketplace list --json` prints `[{name, source, repo | url |
path, installLocation}]`. `add <source>` (a GitHub owner/repo, a git URL or a folder), `remove
<name>` and `update [name]` have no `--json`: the exit code says whether it worked. The
output is progress text ("Cloning repository…", several lines for a fresh GitHub add), then the
outcome after a `√` (worked) or `×` (failed).

✅ **Applying a change to a running session.** `control_request` `reload_plugins` (what
`/reload-plugins` sends) answers `{commands, agents, plugins: [{name, path, source: <id>, version}],
mcpServers, error_count}`. A running session picks up settings changes on its own schedule: a reload
300 ms after `plugin disable` still listed the plugin, and one after 1 s didn't. Claude Deck
reloads until `plugins` shows the change. With `hold_on_cache_impact: true`, Claude doesn't apply a
reload that would change its tool list while the conversation's prompt cache depends on it; the
response carries `held: true` and `cache_impact`, and a second reload without the flag applies it.
Verified through Claude Deck: installing a test plugin whose `.mcp.json` starts a one-tool MCP
server was held after the chat's first turn, and applied when forced. A plugin that adds only a
slash command was never held, before or after a turn.

## MCP servers

All checked with 2.1.284 against the mock, with a throwaway `CLAUDE_CONFIG_DIR` and `--mcp-config`
naming two stdio servers run by `node.exe`: a one-tool server, and one whose script doesn't exist.

✅ **`system/init`** carries `mcp_servers: [{name, status, source}]`, each turn. `initialize`'s
response has no MCP field.

✅ **`control_request` `mcp_status`** answers `{mcpServers: [{name, status, serverInfo?: {name,
version}, error?, config, scope, source, tools?: [{name, annotations}]}]}`. `status` is `connected`,
`pending`, `failed`, `needs-auth` or `disabled` (the field description inside `claude.exe` lists
these, plus an internal `error_code` on some failures). Servers connect in the background: right
after `initialize` both were `pending`; 3 s later one was `connected` (with `serverInfo` and
`tools`) and the other `failed` with `error: "Connection closed"`. `config` is the server's whole
definition (`{type: 'stdio', command, args}` here; it can hold `env` or `headers` with keys), so
Claude Deck never passes it to the page. Answered locally, with no API request.

✅ **`mcp_toggle` `{serverName, enabled}`** turns a server off (`status: 'disabled'`, no `tools` or
`serverInfo`) or back on (it reconnects), answering an empty success. It's remembered: Claude Code
writes the name into `projects[<folder>].disabledMcpServers` in its `.claude.json`, and a new
process in the same folder started with that server `disabled`; turning it on took it out again,
as `/mcp` does. Other sessions already running in that folder keep their state. An unknown name is
an error response: `Server not found: <name>`.

✅ **`mcp_reconnect` `{serverName}`** answers an empty success once the server is connected, or an
error response with the reason (`Connection closed` for the server that can't start).

⚠️ **Signing in** (`needs-auth`): `mcp_authenticate`; see "Terminal features in stream-json". Claude
Deck opens the address it answers with and watches `mcp_status` until the server connects.

## Pasted text

⚠️ How Claude Code's prompt takes a long paste, read from the code inside `claude.exe` 2.1.284 (it's
terminal behavior, so there's no stream-json message to probe). Line endings become `\n` and tabs
four spaces. A paste longer than 800 characters, or with more line breaks than `min(rows - 10, 2)`
(2 in any usual terminal), goes in as `[Pasted text #<n> +<line breaks> lines]`, or
`[Pasted text #<n>]` with none, and the text is kept beside the prompt and put back in its place on
submit. `<n>` is one more than the highest number in the prompt. Pasting the same text again while
its placeholder is there expands it in place, and "paste again to expand" shows for 8 s after a
paste of 100,000 characters or fewer. The 800 is the likeliest of several minified constants named
the same; the rest are as written. Claude Deck's reply box does the same (`public/pasted-text.js`)
and sends the full text: nothing about it reaches Claude Code. Where each paste sits in the message is kept with Claude Deck's own copy of it, so the conversation and **↑** can show the placeholders again; Claude Code's transcript has only the full text, so a conversation reloaded from it shows the text in full.

## Terminal features in stream-json

The `/`-command list aside, Claude Code's terminal has keys and modes that stream-json doesn't run
for a client. Claude Deck rebuilds each from the request or message below. Unless marked, all were
probed with 2.1.284 against the mock in a throwaway `CLAUDE_CONFIG_DIR`, with prompts that run no
shell command, and then driven through Claude Deck's own page in `npm run sandbox`.

✅ **Thinking** arrives as its own `assistant` message, `content: [{type: 'thinking', thinking,
signature}]`, before the reply's text (with or without `--include-partial-messages`).

✅ **Tool results.** The `user` message carrying a `tool_result` also has `tool_use_result`, the
tool's own output. An `Edit`: `{filePath, oldString, newString, originalFile, structuredPatch:
[{oldStart, oldLines, newStart, newLines, lines: ['-old', '+new', ' context']}], userModified,
replaceAll}`, the diff Claude Code draws. A `Write`: `{type: 'create'|'update', filePath, content,
structuredPatch}` (⚠️ the `create` shape is from the code, not probed). A `Read`: `{type: 'text',
file: {filePath, content, numLines, startLine, totalLines}}`.

✅ **To-do list.** The tools are off in stream-json: `TodoWrite` and `TaskCreate` came back
"No such tool available: … is disabled for this session", even with `CLAUDE_CODE_ENABLE_TASKS=1`,
and neither is in `system/init`'s `tools`. Across 30 days of one PC's transcripts (72 from Claude
Deck, 23 from the terminal), neither was ever called, so the switch isn't only stream-json's. ⚠️
From the code: `TodoWrite` `{todos: [{content, status: pending|in_progress|completed,
activeForm}]}`; `TaskCreate` `{subject, description, activeForm?}` answers "Task #<id> created
successfully"; `TaskUpdate` `{taskId, status?: …|deleted, subject?, activeForm?}`. Claude Code
builds its list from those calls, and so does Claude Deck, so the list shows whenever the tools are
on.

✅ **Plan approval.** `ExitPlanMode` asks with `can_use_tool` `{tool_name: 'ExitPlanMode', input:
{plan}, requires_user_interaction: true}` and no `permission_suggestions`. Allowing with
`updatedPermissions: [{type: 'setMode', mode: 'acceptEdits'|'default', destination: 'session'}]`
leaves plan mode for that mode (the next `system/init` reports it); allowing without it stays in
plan mode. The result names the plan file Claude Code saved: `<config>/plans/<slug>.md`.

✅ **`file_suggestions` `{query}`** (the `@` list) answers `{suggestions: [{path}], cwd}`, paths
relative to `cwd`, folders ending in a separator. In a git repository the first query came back
empty while the index built, and the next (3 s later) in 3 ms with ranked results: `chat` →
`src/chat.js`, `test/chat.test.js`, …; `pub/app` → `public/app.css`, `public/app.js`. In a folder
that isn't a repository an empty query lists the top level, and fuzzy queries returned nothing in
the probe but matched in the sandbox's project folder (`@` → `edit-me.txt`).

✅ **`side_question` `{question}`** (`/btw`) answers `{response, synthetic: false}`, with a
`system/control_request_progress` `{status: 'started'}` first. It makes one API request and adds
nothing to the conversation or transcript.

✅ **`background_tasks`** `{tool_use_id?}` (Ctrl+B) answers `{}`. The waiting task gets
`task_updated` `{patch: {is_backgrounded: true}}`, its tool call returns "Async agent launched
successfully" so the turn carries on, and `system/background_tasks_changed` `{tasks: [{task_id,
task_type, description}]}` lists what's in the background, again (empty) when it finishes.

✅ **Messages that start no turn.** A `user` message with `shouldQuery: false` is appended to the
transcript without an API request; the next message that does query sends it along (that request's
last user turn had 3 text blocks). Each still gets `command_lifecycle` queued/started/completed and
a `result`, with no `assistant` message. This is how the terminal's `!` shell mode feeds Claude:
`<bash-input>cmd</bash-input>` and `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`
(the tags, from the code inside `claude.exe`). Claude Deck runs the command itself, in Windows
PowerShell (`src/shell-mode.js`), and sends both in one such message.

✅ **Message ids.** The `uuid` on a `user` message Claude Deck sends becomes that entry's `uuid` in
the transcript, so a message in the chat can be found there.

⚠️ **Prompt suggestions.** Schema only: `prompt_suggestion` `{suggestion, uuid, session_id}`,
"emitted after each turn when promptSuggestions is enabled" (an `initialize` option). None arrived
in probes, with the option and with `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1`: the code turns them
off for non-interactive sessions behind a server-side flag the mock can't set. Claude Deck asks for
them and shows any that arrive; the person's own `promptSuggestionEnabled` setting still decides.

✅ **Fast mode.** `initialize` and every `result` report `fast_mode_state` (`off`, `cooldown`,
`on`) and `fast_mode_disabled_reason` (`sdk_opt_in_required` before opting in). `apply_flag_settings`
`{settings: {fastMode: true}}` turns it on (the next result says `on`). It's billed as extra usage
on top of the plan (one of the reasons it can be refused is `extra_usage_disabled`), so Claude Deck
allows it only with *Allow API billing*.

⚠️ **`mcp_authenticate` `{serverName, redirectUri?}`.** From the code: `{authUrl,
requiresUserAction: true, callbackExpected: true, redirectScheme, state, callbackPort?}` for a server
using OAuth, where Claude Code listens for the browser's return itself, and `{authUrl,
requiresUserAction: true, callbackExpected: false}` for a claude.ai connector, connected on
claude.ai. Probed: a stdio server answers the error `Server type "stdio" does not support OAuth
authentication`; an unknown name, `Server not found: <name>`.

## The /config options (2.1.301)

✅ `/config` sent as a chat message in stream-json is a local command (no model request): Claude Code
answers with one `assistant` text message and a `result` (`is_error: false`, the same text in
`result`). With nothing after it, the text is the list of options:

```
Usage: /config key=value [key=value ...]
  autoCompact=true|false
  language=<value>
  switchModelsOnFlag=Switch automatically|Ask each time
  ...
```

32 options in 2.1.301 (`<value>` is free text). `/config key=value` sets one ("Set Theme to dark"),
or explains why not ("Verbose output takes true or false, not \"\".", "x isn't a /config setting.",
"Couldn't save Thinking mode: Thinking can't be turned off for Opus 5.5"). Several pairs go on one
line, but a value with spaces only works unquoted as the last pair, so `src/claude-config.js` sends
one per command. `/config key` alone, and the interactive panel, aren't available: current values
come from the files. Claude Code writes them a moment after it says "Set" (Claude Deck waits up to
3 seconds before reading them back).

✅ Like every other user message, a `/config` message gets `command_lifecycle` `queued`, `started`
and `completed` for the `uuid` it was sent with. Probed with 2.1.301 against the mock API (a
`shouldQuery: false` shell message, then `/config` straight after): `queued`/`started` for the
shell message, `queued` for `/config`, `init`, the shell message's empty `result`, `completed` for
the shell message, then `started` for `/config`, `init`, its `assistant` text, its `result`
(`local_command: 'config'`) and `completed`. So a reply can't be matched to a command by order of
arrival alone: `src/chat.js` takes the `assistant` text and `result` after a local command's
`started` as that command's, and nothing before it. The current value shown for each option is
read from the one file `/config` writes it to (its scope above): a project's shared
`.claude/settings.json` is left out, since a value there would hide the one just saved and never
match it.

✅ Where each option is saved, from setting every one in a throwaway config folder: most go to the
user's `settings.json` (`theme`, `editorMode`, `autoCompactEnabled`, `model`,
`permissions.defaultMode`, `language`, `awaySummaryEnabled`, `timeFormat`, `preferredNotifChannel`,
`fileCheckpointingEnabled`, `showTurnDuration`, `terminalProgressBarEnabled`, `autoScrollEnabled`,
`verbose`, `enableWorkflows`, `workflowKeywordTriggerEnabled`, `useAutoModeDuringPlan`,
`worktree.baseRef`, and `switchModelsOnFlag` as a boolean, `true` for "Switch automatically"); three
to the project's `.claude/settings.local.json` (`spinnerTipsEnabled`, `prefersReducedMotion`,
`outputStyle`); the rest to `.claude.json` (`respectGitignore`, `copyFullResponse`,
`prStatusFooterEnabled`, `autoConnectIde`, `copyOnSelect`, `defaultToAgentsView`,
`externalEditorContext`, `leftArrowOpensAgents`, `workflowSizeGuideline`). The full table, with
labels, is `KNOWN` in `src/claude-config.js`. ⚠️ `thinking` → `alwaysThinkingEnabled` is inferred
(Claude Code refused to change it on Opus 5.5). `.claude.json` sits inside `CLAUDE_CONFIG_DIR` when
that's set, otherwise beside `~/.claude` (`paths.globalConfigFile()`).

✅ The control channel can't do this instead: `update_settings` (needs `source: "userSettings"` and a
`settings` object) accepts only `effortLevel` and refuses every other key ("update_settings keys not
allowed: ..."); `get_settings` returns `{ effective, sources, applied }` for the settings files only.
There's no `claude config` command.

## Rewinding the conversation

✅ Claude Code's Esc Esc has no stream-json request. `--resume <id> --resume-session-at <uuid>
--fork-session` starts a new session holding the transcript up to and including the entry with
that `uuid`, and leaves the original file untouched. To go back to before a message, use its
entry's `parentUuid` (the entry before it); `null` means it was the first, so start a new
conversation. Probed: the fork's prompts were the ones before the chosen message plus the new one.

## Prompt history

✅ `~/.claude/history.jsonl` is what the terminal's ↑ and Ctrl+R read: one line per prompt, oldest
first, `{display, pastedContents, timestamp, project, sessionId}`. A long paste shows in `display`
as its placeholder. Its `pastedContents[id]` is `{id, type: 'text', content}` or, for bigger ones,
`{id, type, contentHash}`, whose text is `~/.claude/paste-cache/<contentHash>.txt` until Claude Code
prunes it (20 of 26 recent pastes on one PC were hash-only, and most of those files were gone).
Read only (`src/prompt-history.js`).

## Subagents and background tasks

✅ `system` messages: `task_started` (`task_id`, `tool_use_id`, `description`, `subagent_type`,
`prompt`, `is_backgrounded`, `task_type`), `task_progress` (whose `description` is the *current
step*, not the task's), `task_updated` (`patch.status`, `patch.end_time`) and `task_notification`
(`status`, `summary`, `usage`).

✅ `task_type` is `local_agent` for subagents and `local_bash` for shell commands that run more than
a couple of seconds. Only `local_agent` tasks are listed. Later messages about a task omit
`task_type`, so they're matched by `task_id`.

✅ `task_started` arrives immediately, whether the subagent runs in the foreground
(`is_backgrounded: false`, Claude waits for it) or the background. A foreground subagent's own
messages never reach stdout; a background one's do, tagged with `parent_tool_use_id`. Background
subagents keep running after the turn's `result`.

✅ Every subagent's transcript is written live to
`projects/<project>/<sessionId>/subagents/agent-<task_id>.jsonl` (plus `agent-<task_id>.meta.json`).
That's where Claude Deck gets its steps, model and token usage (`src/subagents.js`). Count usage
once per `message.id`, latest record winning. `usage.total_tokens` in `task_progress` /
`task_notification` is a different measure, used only when there's no transcript.

## File checkpoints and rewind

✅ Stream-json processes keep file checkpoints only with the environment variable
`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1` (`src/chat.js` sets it unless
`CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` is set).

✅ In the transcript, `file-history-snapshot` `{messageId, snapshot.trackedFileBackups}` is each
tracked file's state when the prompt with that `uuid` was sent: `{path: {backupFileName | null,
version, realParentDir}}`, where `null` means the file didn't exist. `file-history-delta`
`{snapshotMessageId, trackingPath, backup}` marks a file first tracked during that turn. Backups are
`~/.claude/file-history/<sessionId>/<name>@vN`. Paths inside the session folder are stored
relative, so resolve them with `realParentDir`. Only the edit tools (Write, Edit, MultiEdit,
NotebookEdit) are tracked, not shell commands.

✅ `rewind_files` `{user_message_id, dry_run?}`: a dry run returns `{canRewind, filesChanged,
insertions, deletions}`, the real run `{canRewind: true, skippedLinks}`. Without checkpointing it
returns `{canRewind: false, error}`.

## What makes Claude Code bill per use

The billing guard (`src/billing.js`) refuses to start sessions that would bill an Anthropic API or
cloud account instead of the Claude plan.

✅ Present in `claude.exe` 2.1.281 (found by searching the binary for the names):
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the `apiKeyHelper` setting.
- The provider switches `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_ANTHROPIC_AWS`,
  `_ANTHROPIC_GOOGLE_CLOUD`, `_MANTLE` and `_GATEWAY`.
- The managed settings folder on Windows, `C:\Program Files\ClaudeCode` (`managed-settings.json`).

✅ Documented (code.claude.com/docs/en/managed-settings and /settings, read 2026-09-27), so the
guard reads them too:
- Managed settings can also come from a `managed-settings.d\` folder next to
  `managed-settings.json` (every `*.json` in it merged in), and from the registry: a JSON `REG_SZ`
  or `REG_EXPAND_SZ` value named `Settings` under `HKLM\SOFTWARE\Policies\ClaudeCode` or
  `HKCU\SOFTWARE\Policies\ClaudeCode`. The guard checks all of them rather than working out which
  one Claude Code would pick.
- `claude --settings <file or JSON>` loads another settings layer for that session (ranked just
  below managed settings), so its `env` and `apiKeyHelper` count. A `--settings` value the guard
  can't read is treated as a finding.

⚠️ Inferred, not checked with a live account:
- Any of the variables above, set in the environment or in a settings file's `env` block (managed,
  user, or the project's `.claude/settings*.json`), makes Claude Code bill that account rather than
  the Claude sign-in. That's what Anthropic documents.
- `CLAUDE_CODE_USE_POWERSHELL_TOOL` and `CLAUDE_CODE_USE_COWORK_PLUGINS` look like feature switches
  going by their names, so they aren't checked.
- `CLAUDE_CODE_OAUTH_TOKEN` is a Claude plan sign-in, so it isn't flagged.

## Plan usage

✅ `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <accessToken>` and
`anthropic-beta: oauth-2025-04-20`, as `claude.exe`'s `/usage` does. The token is `claudeAiOauth`
in `~/.claude/.credentials.json`, and Claude Deck only ever reads it: Claude Code owns and refreshes
it. The response's `limits[]` has `kind`, `group`, `percent`, `severity`, `resets_at` and
`scope.model.display_name`; older-style `five_hour` / `seven_day` objects are also present. People
who use an API key rather than a Claude plan sign-in have no such token; the meter then says plan
limits need a Claude account sign-in.

## Installed Edge app

⚠️ `src/app-install.js` assumes Chromium's web-app id: SHA-256 of the manifest `id` URL, with the
first 32 hex digits mapped to the letters a-p, and the app folder at
`Edge\User Data\<profile>\Web Applications\Manifest Resources\<id>`. Not confirmed against a real
install. If the launcher keeps opening a plain Edge window after installing, check this first.
