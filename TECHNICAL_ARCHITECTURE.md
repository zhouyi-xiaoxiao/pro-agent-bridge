# Pro Agent Bridge Technical Architecture

Pro Agent Bridge is a local workspace and handoff bridge for a user-controlled ChatGPT Pro / Pro Extended session. It keeps the `codexpro` CLI entrypoint for compatibility, but the scope now includes Codex, Claude Code, OpenCode, Pi, and custom local executors. It does not provide model access, proxy ChatGPT, bypass quotas, or read hidden account history. The design goal is simple:

1. ChatGPT Pro / Pro Extended produces detailed plans, reviews, and project memory.
2. Pro Agent Bridge exposes bounded local repo tools and `.ai-bridge` artifacts through MCP.
3. A user-started local CLI watcher can hand implementation to Claude Code, Codex, OpenCode, Pi, or a custom command.
4. ChatGPT Pro reviews local status, logs, diffs, and saved sessions.

## Capability Count

The current extended feature set adds 15 practical capabilities on top of the upstream local workspace bridge:

| # | Capability | Surface |
| --- | --- | --- |
| 1 | Read durable project context | MCP `read_project_context` |
| 2 | Search saved project memory | MCP `search_project_memory` |
| 3 | Save a conversation summary | MCP `save_chat_summary` |
| 4 | Save a full explicit chat session | MCP `save_chat_session` |
| 5 | List saved sessions | MCP `list_saved_chat_sessions` |
| 6 | Read one saved session by id | MCP `read_saved_chat_session` |
| 7 | Write a detailed implementation plan | MCP `write_detailed_solution` |
| 8 | Write checklist and review criteria | MCP `write_detailed_solution` |
| 9 | Hand off a plan to Claude Code | MCP `handoff_to_claude_code` |
| 10 | Poll local handoff status and diff | MCP `handoff_poll` |
| 11 | Execute Claude Code locally from a plan | `codexpro-claude-handoff` |
| 12 | Watch for local handoff plans | `codexpro watch-handoff --agent claude-code` |
| 13 | Capture visible ChatGPT web session by upward/downward scroll | `codexpro capture-chatgpt-session` |
| 14 | Capture via Chrome DevTools Protocol for tests or dedicated automation Chrome | `--cdp-url` |
| 15 | Smoke test scroll capture against a deterministic fixture | `npm run smoke:chatgpt-capture` |

## Data Model

All bridge state is project-local under `.ai-bridge/`, which is ignored by this repository's `.gitignore`.

| File or directory | Purpose |
| --- | --- |
| `project-context.md` | Durable project summary promoted from ChatGPT Pro. |
| `chat-memory.jsonl` | Append-only conversation summaries, decisions, todos, links, tags. |
| `chat-session-index.jsonl` | Append-only index of saved session JSONL files. |
| `chat-sessions/` | Explicit full-session transcripts. Each file contains `session_meta` rows and `message` rows. |
| `solution-plan.md` | Detailed implementation plan. |
| `implementation-checklist.md` | Reviewable checklist derived from the plan. |
| `review-criteria.md` | Pass/fail criteria for Pro/Codex/Claude review. |
| `current-plan.md` | Handoff plan consumed by local executors. |
| `agent-status.md` | Local executor status, touched files, checks, blockers. |
| `implementation-diff.patch` | Review diff captured after execution. |
| `handoff-run-state.json` | Machine-readable execution state. |
| `execution-log.jsonl` | Append-only execution and handoff events. |

## Session History

CodexPro supports reliable reading of a single saved session, not bulk private ChatGPT account history.

- `save_chat_session` persists structured `messages` or a raw `transcript`.
- `save_chat_summary` and `save_chat_session` reject secret-looking content by default. Use `allow_sensitive=true` only when you intentionally want to store private local bridge data.
- `append=true` appends new messages and writes a fresh `session_meta` row so later reads see current metadata.
- `read_saved_chat_session` requires `session_id`, searches the saved index, verifies the path stays inside `.ai-bridge/chat-sessions/`, and streams JSONL so large saved sessions can still return bounded messages/bytes without first loading the whole file through the ordinary read limit.
- `codexpro capture-chatgpt-session` can create those saved sessions from the currently visible ChatGPT page by scrolling the page.

The scroll capture helper is best effort because the ChatGPT web DOM and lazy loading can change. It is still useful for the user's desired workflow: open one session, let Codex/Claude Code scroll upward to load older turns, scan downward, then save a project-local transcript that MCP can read later.

## Second-Round Audit Hardening

The second Extended Pro review led to these hardening changes:

- Large saved-session reads are streaming JSONL reads with full-file SHA-256 reporting.
- `.ai-bridge/` directories are created or repaired with private directory permissions, and JSONL/session files are created or repaired with private file permissions where the filesystem supports chmod.
- Session and summary persistence block secret-looking values by default; the ChatGPT web capture CLI has the same default block plus an explicit `--allow-sensitive` override.
- ChatGPT web capture preserves duplicate identical turns by using DOM message ids when available and occurrence indexes otherwise.
- CDP capture is no longer blocked by the macOS Apple Events platform check, chooses ChatGPT targets more deliberately, and rejects pending browser calls on close/error/timeout.
- `watch-handoff` only treats successful plan hashes as consumed, so a failed same-plan execution is retried by default.
- `codexpro-claude-handoff` caps plan size before invoking `claude -p` to avoid OS argument-length failures.

## Extended Pro Workflow

Use the visible ChatGPT model picker to select `Pro 扩展` / Extended Pro before asking for the review or plan. CodexPro cannot force the model picker itself.

Recommended loop:

```text
1. Start CodexPro with codexpro start --root /repo --mode handoff.
2. In ChatGPT Pro Extended, call open_current_workspace.
3. Call read_project_context and search_project_memory.
4. Call write_detailed_solution.
5. Call handoff_to_claude_code.
6. Locally run codexpro watch-handoff --agent claude-code --yes.
7. Poll handoff_poll and review implementation-diff.patch.
8. Run final tests locally.
```

If the chosen ChatGPT model cannot call MCP tools, use `export_pro_context` / `codexpro pro-bundle`, paste that context into the model, and bring the detailed plan back to CodexPro.

## Capture Command

```bash
codexpro capture-chatgpt-session --root /path/to/repo --find-chatgpt
```

Useful options:

```text
--session-id <id>          stable saved session id
--provider <name>          provider label, default chatgpt-web-scroll
--max-scrolls <n>          upward/downward scroll limit
--settle-ms <ms>           wait for lazy loading
--max-session-bytes <n>    safety bound for JSONL transcript writes
--allow-sensitive          intentionally allow secret-looking transcript values
--dry-run                  capture counts without writing
--cdp-url <url>            use a DevTools-enabled Chrome page
```

The helper writes transcripts with private file permissions when possible. It does not send transcript data anywhere remote.

## Security Boundaries

- MCP write/edit is controlled by `CODEXPRO_WRITE_MODE`.
- Bash is controlled by `CODEXPRO_BASH_MODE` and the existing safe-command policy.
- The MCP server never starts Claude Code. Local execution is a separate CLI/watch process.
- The capture helper reads only the currently open Chrome tab or a specifically selected CDP page.
- `.ai-bridge/` can contain private transcripts and should stay out of git.
- `.ai-bridge/` writes are private-by-default best effort, but filesystem ACLs and backups are still outside CodexPro's control.
- Public tunnel use must keep bearer-token auth enabled.

## Claude Code Local Verification

The bridge can verify local Claude Code installation and wiring, but it cannot grant Claude model access. Use:

```bash
command -v claude
claude --version
claude auth status
claude mcp list
claude -p --model sonnet --no-session-persistence --tools '' -- 'Reply exactly CODEXPRO_CLAUDE_SMOKE_OK.'
```

Expected healthy state:

- `claude --version` prints a Claude Code version.
- `claude auth status` reports `loggedIn: true` for the intended account or provider.
- `claude mcp list` shows the configured local MCP servers as connected.
- The `claude -p` smoke prints the fixed marker. If it returns `403 Request not allowed`, the CLI is installed but the Anthropic account/network/API authorization is refusing model calls; refresh Claude Code auth with `claude auth login` or `claude setup-token`, then rerun the smoke.

## Verification Matrix

Run before relying on the fork:

```bash
npm run build
npm run smoke
npm run smoke:chatgpt-capture
npm pack --dry-run
git diff --check
codexpro doctor --root /path/to/repo
```

Manual Extended Pro verification:

1. Open ChatGPT web.
2. Start a new chat.
3. Select `Pro 扩展` from the model/intelligence picker.
4. Confirm the composer label reads `Pro 扩展`.
5. Submit a short repo-review prompt and verify the new conversation URL changes to `/c/<id>`.
