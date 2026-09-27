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

✅ `src/claude-locate.js` checks, in order: the path set in *Claude Deck Preferences*, `where.exe claude`, and
the native installer's `%USERPROFILE%\.local\bin\claude.exe`. An npm global install puts a
`claude.cmd` shim on PATH that wraps
`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` (older versions ship
`cli.js` instead). Launch the real `claude.exe`, not the shim, so its process id is Claude's own.

✅ `claude --version` prints and exits locally; it makes no model request.

## CLI flags Claude Deck uses

✅ From `claude --help`: `--session-id`, `--resume <id>`, `--continue`, `--fork-session`, `--model`,
`--effort`, `--permission-mode`, `--add-dir`, `--worktree`, plus, for chats,
`--output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio`.

✅ Model aliases, from the alias table inside `claude.exe`: `opus`, `sonnet`, `haiku`, `fable`,
`best`, `opus[1m]`, `sonnet[1m]`, `fable[1m]`, `opusplan`. Any full model ID also works.

## Live status: `~/.claude/sessions/<pid>.json`

✅ Every running Claude Code process writes one: `pid`, `sessionId`, `cwd`, `kind`, `status`
(`busy` | `idle` | `waiting`), `waitingFor` (why it's waiting), `statusUpdatedAt`, `name` and
`nameSource`. It's removed when the process exits. Stream-json processes (in-app chats) write one
too, so `src/live.js` claims chats by pid; otherwise every chat would also show up as an
outside session.

⚠️ A terminal session's totals (Est. cost, Total tokens) add up every `sessionId` its tab has
reported, on the assumption that `/clear` in the terminal interface changes `sessionId` here as
it does in stream-json. Not checked in a real terminal.

## Transcripts: `~/.claude/projects/<project>/<sessionId>.jsonl`

✅ One JSON record per line. `<project>` is the session folder with every character outside
`[a-zA-Z0-9]` replaced by `-`. Record types beyond `user` / `assistant`: `ai-title`,
`custom-title`, `last-prompt`, `cost-state`, `tag`, `pr-link`, `queue-operation`, `attachment`,
`file-history-snapshot`, `file-history-delta`, `mode`, `permission-mode`. `isSidechain: true` marks
subagent records, and `isMeta: true` marks records that aren't real prompts.

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
- Claude Deck works out each turn's cost and tokens from the change in the running totals, and
  keeps its own per-chat totals across `/clear` (`_count` in `src/chat.js`).

✅ **`/clear`** sent as a user message: `conversation_reset` `{new_conversation_id, trigger:
'clear', user_message_uuid}` arrives, then a `system/init` with a **new `session_id`**, then a
`result` with `local_command: 'clear'`, `num_turns: 0` and `total_cost_usd: 0`. The new transcript
file is named after the new `session_id`. `new_conversation_id` is a different uuid from it. The
old transcript gets a `cost-state` record.

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
