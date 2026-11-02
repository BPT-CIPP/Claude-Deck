# Claude Code's slash commands, and what a chat does with each

Every slash command Claude Code 2.1.312 has, what it does in a Claude Deck chat, and what Claude
Deck does about the ones Claude Code runs only in its terminal interface. Checked 2026-11-02.
Claude Code adds and removes commands often: when it changes, check again the same way (below)
and update this file and `DECK_COMMANDS` / `TERMINAL_ONLY` in `public/app.js` together.

## How the list was made

- ✅ **Definitions, from the JavaScript bundled in `claude.exe`.** A command is an object with
  `type: "local" | "local-jsx" | "prompt"`, a `name`, `aliases`, a `description` and
  `isEnabled` / `isHidden`. `local-jsx` commands draw Claude Code's terminal interface (dialogs,
  pickers). Many commands come twice: a `local-jsx` one for the terminal and a `local` one with
  `supportsNonInteractive` that is enabled only in non-interactive (print and SDK) mode, which is
  the one a chat gets. Bundled skills (`/doctor`, `/code-review`, `/security-review`...) are made by
  a helper and don't appear as such objects.
- ✅ **What a chat is offered: the `initialize` response's `commands`.** A chat's Claude Code
  listed 54 built-in commands (`builtin: true`) plus the user's own skills, plugin commands and
  commands (50 on the PC checked). That list is what the reply box's / menu shows.
- ✅ **What each does in a chat: sent as a message** to a real `claude.exe` in stream-json mode,
  signed out and with an empty `CLAUDE_CONFIG_DIR`, so nothing could reach the model or the
  user's files. Most answered with their result as Claude's message (`result.local_command` set).
  ⚠️ Six answered "isn't available in this environment" (`/advisor`, `/import`, `/usage-credits`,
  `/extra-usage`, `/design-consent`, `/design-revoke`); whether that's because the probe wasn't
  signed in wasn't checked. **`/focus` answered "/focus isn't available here yet"**: Claude Code
  has an SDK version of it, but not working yet.
- Four are turned off in this build everywhere (`isEnabled: () => false`): `/loops`,
  `/pause-memory`, `/version`, `/wellbeing`.

## What Claude Deck does

- **Offered in a chat: sent to Claude Code as typed**, which runs it there. A command only runs at
  the start of a message (docs/CLAUDE-CODE-INTERNALS.md, "Slash commands only run at the start of
  a message").
- **Terminal only, with a Claude Deck equivalent: run by the reply box** (`DECK_COMMANDS` in
  `public/app.js`), never sent. Some use Claude Deck's own controls (end the chat, History, the
  tasks panel, the plugins menu, Go back to an earlier message, plan mode, a fork), some show the
  answer to one of the read-only control requests Claude Code handles for SDK hosts (below), in
  the panel above the reply box where `/btw` answers go. `/focus` is Claude Deck's own focus view:
  each turn shows your prompt, one line summing up Claude's steps ("3 steps: Read, Edit ×2") and
  Claude's last reply; the steps and in-between replies are hidden, not removed (`markFocus`).
  It's one setting for every chat, like Claude Code's `viewMode`.
- **Terminal only, nothing to do it with here: offered in the Inlaid CLI.** The reply box says so
  and offers *Continue in the Inlaid CLI*, which ends the chat and resumes the same conversation in
  Claude Code's own interface in the window (`POST /api/chats/:id/to-embedded`). Your own skill or
  command with the same name goes to Claude Code instead.
- **`/add-dir`** can't be done through the protocol: the `add_directory` control request is for
  cloud containers (it takes a `mount_path` and needs `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`).
  Claude Deck adds the folder to the chat's options and starts its Claude Code again on the same
  conversation with `--add-dir` (between turns only).

### The control requests behind them

Sent as `{type: 'control_request', request_id, request: {subtype}}`; all answer at once with no
model request (✅ 2.1.312, against the user's own setup with no message sent). `src/chat.js` `query`
allows only these, by Claude Deck's name for each.

| Command | `subtype` | Answer |
|---|---|---|
| `/status` | `get_status` | `{sections: [{title, rows: [{label, value}]}]}`: version, session, cwd, sign-in, model, setting sources... |
| `/hooks` | `get_hooks_listing` | `{events: [{name, summary, supportsMatcher, hookCount}], hooks: [{event, matcher, source, sourceLabel, type, displayText, commandText, timeout, editable}], eventCatalog, policy: {disabledByPolicy, managedOnly, pluginOnly, allDisabled, policyHookCount}}` |
| `/permissions` | `list_permission_rules` | `{state: {rules: [{behavior: 'allow'\|'ask'\|'deny', source, rule, description, editability}], workspaceDirectories, originalCwd, managedOnly}}` |
| `/memory` | `get_memory_dialog` | `{files: [{kind, path, label, description, exists}], folders, memories, auto_memory: {enabled, toggleable, status}, auto_dream}` |
| `/skills` | `get_skills_dialog` | `{skills: [{name, display_name, description, source, tokens, state, advertised, handles}]}` |
| `/diff` | `get_workspace_diff` | `{diff: {stats: {filesCount, linesAdded, linesRemoved}, perFileStats: [{path, added, removed, isBinary, isUntracked, status}], hunks: [{path, hunks: [{oldStart, oldLines, newStart, newLines, lines}]}], skippedLarge, restricted, source: {kind: 'working-tree'}}}`; a new file git doesn't track yet wasn't counted |
| `/export` | `export_conversation` | `{text, default_filename}`: the conversation as Claude Code's terminal draws it |
| `/plan` (in plan mode) | `get_plan` | `{exists: false}` or `{exists: true, content, path}` |

Others in the same handler, not used: `get_binary_version` `{version, buildTime}` and
`get_session_cost` `{text}` (what `/usage` prints) (✅ both answered), `generate_session_title`
(✅ refused without a `description`), `background_tasks` (Claude Deck's Ctrl+B already), and, not
tried: `fork_conversation`
(⚠️ the code's bridge handler answers `requires_remote_control_server`), `set_cwd` (`/cd`),
`rename_session`, `submit_feedback`, `claude_authenticate` and the `claude_oauth_*` sign-in
steps, `remote_control`, `ultrareview_launch`.

## Every command

| Command | Aliases | Claude Code's description | In a chat (stream-json) | Claude Deck |
|---|---|---|---|---|
| `/add-dir` |  | Add a new working directory | Not offered: terminal only | Claude Deck: adds the folder and starts the chat's Claude Code again on the same conversation with `--add-dir` |
| `/advisor` |  | Let Claude consult a stronger model at key moments | Offered; answered "isn't available in this environment" when not signed in ⚠️ | Sent to Claude Code |
| `/agents` |  | (removed) Ask Claude to create/manage subagents, or edit .claude/agents/ | Offered; Claude Code runs it | Sent to Claude Code |
| `/artifacts` |  | Browse your published and shared artifacts | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/auto-mode-setup` |  | Teach auto mode about your environment, plus optional rule tweaks | Offered; Claude Code runs it | Sent to Claude Code |
| `/autocompact` |  | Set how full the context gets before auto-summarizing | Offered; Claude Code runs it | Sent to Claude Code |
| `/autofix-pr` |  | Monitor and autofix any issues with the current PR | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/background` | /bg | Send this session to the background and free the terminal | Not offered: terminal only | Claude Deck: says chats already run in the background (Ctrl+B backgrounds a command or subagent) |
| `/batch` |  | Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR. | Offered; Claude Code runs it | Sent to Claude Code |
| `/branch` |  | Create a branch of the current conversation at this point | Not offered: terminal only | Claude Deck: forks the conversation into a new chat (`--fork-session`), named if you give a name |
| `/btw` |  | Ask a quick side question without interrupting the main conversation | Not offered: terminal only | Claude Deck: asks aside with the `side_question` control request |
| `/bug` | /share | Report a bug or share your conversation | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/cd` |  | Move this session to a new working directory | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/chrome` |  | Open Claude in Chrome settings | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/claude-api` |  | Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration. TRIGGER — read BEFORE… | Offered; Claude Code runs it | Sent to Claude Code |
| `/clear` | /reset, /new | Start a new session with empty context; previous session stays on disk (resumable with /resume) | Offered; Claude Code runs it | Sent to Claude Code |
| `/cloud-plugins` |  | Choose whether cloud sessions use the plugins enabled on this machine | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/code-review` | /review | Review the current diff, or a PR number/branch/path target, for correctness bugs (plus reuse/simplification/efficiency cleanups where the model's recipe covers them) at the… | Offered; Claude Code runs it | Sent to Claude Code |
| `/color` |  | Set the prompt bar color for this session | Offered; Claude Code runs it | Sent to Claude Code |
| `/compact` |  | Free up context by summarizing the conversation so far | Offered; Claude Code runs it | Sent to Claude Code |
| `/config` | /settings | Open settings | Offered; Claude Code runs it | Sent to Claude Code |
| `/context` |  | Visualize current context usage as a colored grid | Offered; Claude Code runs it | Sent to Claude Code |
| `/copy` |  | Copy Claude's last response to clipboard (or /copy N for the Nth-latest) | Not offered: terminal only | Claude Deck: copies Claude's latest (or Nth-latest) reply |
| `/daemon` |  | Manage background services and routines | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/dataviz` |  | Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualization, in ANY output medium — an HTML or React artifact, inline SVG, plotting… | Offered; Claude Code runs it | Sent to Claude Code |
| `/debug` |  | Enable debug logging for this session and help diagnose issues | Offered; Claude Code runs it | Sent to Claude Code |
| `/deep-research` |  | Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report. (dynamic workflow) | Offered; Claude Code runs it | Sent to Claude Code |
| `/design` |  | Grant or revoke Claude agent access to your Design projects | Offered; Claude Code runs it | Sent to Claude Code |
| `/design-consent` |  | Grant Claude agent access to your Design projects | Offered; answered "isn't available in this environment" when not signed in ⚠️ | Sent to Claude Code |
| `/design-login` |  | Authorize design-system access for /design-sync with your claude.ai account | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/design-revoke` |  | Revoke Claude agent access to your Design projects | Offered; answered "isn't available in this environment" when not signed in ⚠️ | Sent to Claude Code |
| `/design-sync` |  | Push a React design system to claude.ai/design. This runs a converter that bundles the real component code (from Storybook or a bare package) and uploads it. Use when the user… | Offered; Claude Code runs it | Sent to Claude Code |
| `/desktop` | /app | Continue the current session in Claude Desktop | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/diff` |  | Toggle the diff panel showing uncommitted changes (fullscreen interface; otherwise shown inline) | Not offered: terminal only | Claude Deck: shows `get_workspace_diff` |
| `/doctor` | /checkup | Health-check the user's Claude Code setup and fix issues: diagnose installation health — what the `claude doctor` terminal diagnostics cover — from local data (duplicate or… | Offered; Claude Code runs it | Sent to Claude Code |
| `/effort` |  | Set effort level for model usage | Offered; Claude Code runs it | Sent to Claude Code |
| `/exit` | /quit | Exit the CLI (in a background session: "Detach from this background session") | Not offered: terminal only | Claude Deck: ends the chat |
| `/export` |  | Export the current conversation to a file or clipboard | Not offered: terminal only | Claude Deck: saves `export_conversation`'s text as a download |
| `/extra-usage` |  | Renamed to /usage-credits | Offered; answered "isn't available in this environment" when not signed in ⚠️ | Sent to Claude Code |
| `/fast` |  | Toggle fast mode (Opus 5.5) | Offered; Claude Code runs it | Sent to Claude Code |
| `/feedback` |  | Send feedback to Anthropic or report a bug | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/fewer-permission-prompts` |  | Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project .claude/settings.json to reduce permission prompts. | Offered; Claude Code runs it | Sent to Claude Code |
| `/focus` |  | Toggle focus view: just your prompt, summary, and response | Offered, but answers "isn't available here yet" | Claude Deck: its own focus view (prompt, summary of steps, reply) |
| `/fork` |  | Spawn a background agent that inherits the full conversation | Not offered: terminal only | Claude Deck: forks into a new chat that carries on with your prompt |
| `/goal` |  | Set a goal Claude checks before stopping | Offered; Claude Code runs it | Sent to Claude Code |
| `/heapdump` |  | Dump the JS heap to the Desktop; on Linux with no Desktop folder, the home directory | Offered; Claude Code runs it | Sent to Claude Code |
| `/help` |  | Show help and available commands | Not offered: terminal only | Claude Deck: lists the commands that work here |
| `/hooks` |  | View hook configurations for tool events | Not offered: terminal only | Claude Deck: shows `get_hooks_listing` |
| `/ide` |  | Manage IDE integrations and show status | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/import` |  | Import config from another AI coding agent | Offered; answered "isn't available in this environment" when not signed in ⚠️ | Sent to Claude Code |
| `/init` |  | Initialize a new CLAUDE.md file with codebase documentation | Offered; Claude Code runs it | Sent to Claude Code |
| `/insights` |  | Generate a report analyzing your Claude Code sessions | Offered; Claude Code runs it | Sent to Claude Code |
| `/install` |  | Install Claude Code native build | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/install-github-app` |  | Set up Claude GitHub Actions for a repository | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/install-slack-app` |  | Install the Claude Slack app | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/keybindings` |  | Open your keyboard shortcuts file | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/list-agents` | /peers | List subagents, teammates, and other Claude sessions you can message | Offered; Claude Code runs it | Sent to Claude Code |
| `/login` |  | Sign in with your Anthropic account (signed in: "Switch Anthropic accounts") | Not offered: terminal only | Claude Deck: says how to sign in from PowerShell (`claude auth login`) |
| `/logout` |  | Sign out from your Anthropic account | Not offered: terminal only | Claude Deck: says how to sign out (`claude auth logout`); doesn't do it |
| `/loop` | /proactive | Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace. | Offered; Claude Code runs it | Sent to Claude Code |
| `/loops` |  | List, create, and delete loops | Turned off in this build | - |
| `/mcp` |  | Manage MCP servers | Offered; Claude Code runs it | Sent to Claude Code |
| `/memory` |  | Edit CLAUDE.md files and memory settings | Not offered: terminal only | Claude Deck: shows `get_memory_dialog` |
| `/mobile` | /ios, /android | Show QR code to download the Claude mobile app | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/model` |  | Set the AI model for Claude Code | Offered; Claude Code runs it | Sent to Claude Code |
| `/output-style` |  | List output styles or switch to one | Offered; Claude Code runs it | Sent to Claude Code |
| `/passes` |  | Share a free week of Claude Code with friends and earn usage credits | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/pause-memory` | /memory-pause, /toggle-memory | Pause automemory for this session | Turned off in this build | - |
| `/permissions` | /allowed-tools | Manage allow and deny tool permission rules | Not offered: terminal only | Claude Deck: shows `list_permission_rules` |
| `/plan` |  | Enable plan mode or view the current session plan | Not offered: terminal only | Claude Deck: switches to plan mode, or shows `get_plan` when already planning |
| `/plugin` | /plugins, /marketplace | Manage Claude Code plugins | Not offered: terminal only | Claude Deck: opens the chat's plugins menu |
| `/plugin-authoring` |  | Make a mod: a change to Claude's own interface or behaviour, such as a panel or pane that stays beside the chat and updates, a band, status line, toast, slash command, or hook… | Offered; Claude Code runs it | Sent to Claude Code |
| `/powerup` |  | Discover Claude Code features through quick interactive lessons | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/privacy-settings` |  | View and update your privacy settings | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/pro-trial-expired` |  | Options shown when the Pro plan Claude Code trial has ended | Not offered: terminal only | Not handled: Claude Code shows it itself when a trial ends |
| `/radio` |  | Listen to Claude FM lo-fi radio | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/rate-limit-options` |  | Manage usage limits and upgrade options | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/recap` |  | Generate a one-line session recap now | Offered; Claude Code runs it | Sent to Claude Code |
| `/release-notes` |  | View release notes | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/reload-plugins` |  | Activate pending plugin changes in the current session | Offered; Claude Code runs it | Sent to Claude Code |
| `/reload-skills` |  | Pick up skills added or changed on disk during this session | Offered; Claude Code runs it | Sent to Claude Code |
| `/remote-control` | /rc | Control this session from your phone or claude.ai/code (connected: "Disconnect Remote Control") | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/remote-env` |  | Choose the default environment for cloud agents | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/rename` | /name | Rename the current conversation | Offered; Claude Code runs it | Sent to Claude Code |
| `/restart` | /update | Restart on the newer (or older) installed version and keep the conversation | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/resume` | /continue | Resume a previous conversation | Not offered: terminal only | Claude Deck: opens History |
| `/rewind` | /checkpoint, /undo | Restore the code and/or conversation to a previous point | Not offered: terminal only | Claude Deck: opens Go back to an earlier message |
| `/run` |  | Launch and drive this project's app to see a change working. Use when asked to run, start, or screenshot the app, or to confirm a change works in the real app (not just tests).… | Offered; Claude Code runs it | Sent to Claude Code |
| `/run-skill-generator` |  | Author or improve the run-<unit> skill - a per-project skill that tells agents how to build, launch, and drive this project's app. Use when the user asks to set up the project,… | Offered; Claude Code runs it | Sent to Claude Code |
| `/sandbox` |  | Shows the sandbox state ("sandbox enabled", "sandbox disabled") and opens its settings | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/schedule` | /routines | Create, update, list, or run scheduled cloud agents (routines) that execute on a cron schedule. | Offered; Claude Code runs it | Sent to Claude Code |
| `/scroll-speed` |  | Adjust mouse wheel scroll speed | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/security-review` |  | Complete a security review of the pending changes on the current branch | Offered; Claude Code runs it | Sent to Claude Code |
| `/session` | /remote | Show cloud session URL and QR code | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/setup-bedrock` |  | Reconfigure Amazon Bedrock authentication, region, or model pins | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/setup-vertex` |  | Reconfigure Google Vertex AI authentication, project, region, or model pins | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/simplify` |  | Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that. | Offered; Claude Code runs it | Sent to Claude Code |
| `/skill-doctor` |  | Show which loaded skills are unused and costing context | Offered; Claude Code runs it | Sent to Claude Code |
| `/skills` |  | List available skills | Not offered: terminal only | Claude Deck: shows `get_skills_dialog` |
| `/status` |  | Show Claude Code status including version, model, account, API connectivity, and tool statuses | Not offered: terminal only | Claude Deck: shows `get_status` |
| `/statusline` |  | Set up Claude Code's status line UI | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/stickers` |  | Order Claude Code stickers | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/stop` |  | Stop this background session; transcript and worktree are kept | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/subtask` |  | Send a subagent off with your full context; its result comes back here | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/tasks` | /bashes | View and manage everything running in the background | Not offered: terminal only | Claude Deck: opens the chat's tasks panel |
| `/team-onboarding` |  | Help teammates ramp on Claude Code with a guide from your usage | Offered; Claude Code runs it | Sent to Claude Code |
| `/teleport` | /tp | Send this session to the cloud, or resume one from claude.ai | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/terminal-setup` |  | Install Shift+Enter key binding for newlines (wording depends on the terminal) | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/theme` |  | Change the theme | Not offered: terminal only | Claude Deck: opens Preferences (Claude Deck's themes) |
| `/tui` |  | Set the terminal UI renderer (default \| fullscreen) | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/ultraplan` |  | Draft an editable plan in a cloud session | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/ultrareview` |  | Start a cloud agent that finds and verifies bugs in your branch (priced; runs in a cloud session) | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/update-config` |  | Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from now on when X", "each time X", "whenever X", "before/after X") require hooks… | Offered; Claude Code runs it | Sent to Claude Code |
| `/upgrade` |  | Upgrade to Max for higher rate limits and more Opus | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/usage` | /cost, /stats | Show session cost, plan usage, and activity stats | Offered; Claude Code runs it | Sent to Claude Code |
| `/usage-credits` |  | Configure usage credits or request them from your admin when you hit a limit | Offered; answered "isn't available in this environment" when not signed in ⚠️ | Sent to Claude Code |
| `/verify` |  | Verify that a code change actually does what it's supposed to by exercising it end-to-end and observing behavior — drive the affected flow, not just tests or typecheck. Run… | Offered; Claude Code runs it | Sent to Claude Code |
| `/version` |  | Show this session's version (autoupdate may have a newer one) | Turned off in this build | - |
| `/voice` |  | Toggle voice mode | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/web-setup` |  | Set up cloud sessions with your GitHub account | Not offered: terminal only | Offers to continue in the Inlaid CLI |
| `/wellbeing` | /breaks, /break-reminder, /downtime | Configure optional break reminders and quiet-hours nudges | Turned off in this build | - |
| `/workflow-authoring` |  | Reference for writing a Workflow tool script (script API and gotchas, resume, quality patterns, worked examples). Load before authoring a script for a workflow the user already… | Offered; Claude Code runs it | Sent to Claude Code |
| `/workflow-launch-exec` |  | Execute a server-launched workflow handoff (workflow_launch event sessions only) | Offered; Claude Code runs it | Sent to Claude Code |
| `/workflows` |  | Browse running and completed workflows | Not offered: terminal only | Offers to continue in the Inlaid CLI |

Your own skills, plugin commands and `.claude/commands` aren't listed: they're offered in a chat
and run there as in the terminal (a skill later in a message is for Claude to run).

## Checking again after a Claude Code update

1. Scan `claude.exe` (as bytes, latin1) for objects with `type:"local-jsx"`, `"local"` or
   `"prompt"` and a `name`; read each one's `aliases`, `description`, `isEnabled`, `isHidden` and
   `supportsNonInteractive`.
2. Start `claude.exe --strict-mcp-config --output-format stream-json --verbose --input-format
   stream-json`, send `initialize`, and list `commands` with `builtin: true`.
3. With `CLAUDE_CONFIG_DIR` pointing at an empty folder (signed out: nothing can reach the model),
   send each built-in local command as a user message and read what comes back.
4. Commands new to the terminal-only side go in `TERMINAL_ONLY` (or `DECK_COMMANDS` if Claude Deck
   can do them); commands now offered in a chat come out of both, so they reach Claude Code.

---

*Part of the [CLAUDE.md](../CLAUDE.md) instruction set; read with
[CLAUDE-CODE-INTERNALS.md](CLAUDE-CODE-INTERNALS.md).*
