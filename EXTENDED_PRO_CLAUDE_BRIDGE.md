# Pro Agent Bridge: Extended Pro + Claude Code

Pro Agent Bridge extends the CodexPro-compatible CLI from a direct ChatGPT-to-workspace MCP bridge into a reviewable planning and execution loop:

1. ChatGPT Pro writes durable project memory and an implementation-ready plan.
2. A local terminal process runs the plan with Claude Code, Codex, OpenCode, Pi, or a custom executor.
3. ChatGPT Pro polls `.ai-bridge` artifacts to review status, logs, and diffs.

The bridge does not unlock models, proxy model access, scrape ChatGPT, or bypass product limits. It exposes local workspace tools to a compatible ChatGPT Developer Mode session that you already control.

## New MCP Tools

| Tool | Purpose |
| --- | --- |
| `read_project_context` | Reads `.ai-bridge/project-context.md`, detailed plans, checklists, current handoff, agent status, diff, execution log, and recent saved chat memory. |
| `search_project_memory` | Searches saved `.ai-bridge` memory and planning artifacts before a new plan is written. |
| `save_chat_summary` | Appends an explicit ChatGPT-provided conversation summary, decisions, todos, links, and tags to `.ai-bridge/chat-memory.jsonl`; can promote the summary to `.ai-bridge/project-context.md`; rejects secret-looking content unless `allow_sensitive=true`. |
| `save_chat_session` | Saves one explicit structured chat transcript or raw transcript into `.ai-bridge/chat-sessions/`; rejects secret-looking content unless `allow_sensitive=true`. |
| `list_saved_chat_sessions` | Lists saved project-local chat sessions from `.ai-bridge/chat-session-index.jsonl`. |
| `read_saved_chat_session` | Streams one saved chat session by `session_id` with bounded message and byte limits, so large saved sessions can still be read safely. |
| `write_detailed_solution` | Writes `.ai-bridge/solution-plan.md`, `.ai-bridge/implementation-checklist.md`, and `.ai-bridge/review-criteria.md`; can also write `.ai-bridge/current-plan.md`. |
| `handoff_to_claude_code` | Writes `.ai-bridge/current-plan.md` for Claude Code execution and returns a plan hash plus watcher command. |
| `handoff_poll` | Read-only polling of `.ai-bridge/handoff-run-state.json`, agent status, implementation diff, and execution log. |

## Claude Code Execution

The MCP server never launches Claude Code remotely. Execution happens in a terminal you start:

```bash
codexpro watch-handoff --agent claude-code --yes
```

If your Claude Code default model is unavailable or you want a specific model, pass it explicitly:

```bash
codexpro watch-handoff --agent claude-code --model sonnet --yes
```

When ChatGPT Pro calls `handoff_to_claude_code`, the watcher detects the new `.ai-bridge/current-plan.md` hash and runs:

```bash
codexpro-claude-handoff --plan-file .ai-bridge/current-plan.md [--model sonnet]
```

That helper calls the local Claude Code CLI with `claude -p <handoff prompt>`. It asks Claude Code to inspect the workspace, make scoped edits, run focused verification, and update `.ai-bridge/agent-status.md`.

`codexpro-claude-handoff` keeps handoff plans under a conservative argv-size limit. For unusually large plans, use a custom `codexpro watch-handoff --agent custom --command ...` that streams or reads the plan file directly.

On macOS, if no proxy environment variables are already set, `codexpro-claude-handoff` reads the current system proxy with `scutil --proxy` and passes that proxy only to the child `claude` process. This keeps Claude Code handoff usable on machines where Chrome works through the system proxy but terminal commands would otherwise hit Anthropic or Cloudflare `403 Request not allowed`.

Useful optional environment variables:

```bash
# Advanced passthrough for Claude Code flags not exposed by CodexPro:
CLAUDE_HANDOFF_ARGS="--model claude-sonnet-4-5"
CLAUDE_HANDOFF_BIN="/path/to/claude"
HTTPS_PROXY="http://127.0.0.1:6382"
```

`CLAUDE_BIN` is also accepted for compatibility with older local setups. Explicit `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` values take precedence over macOS system-proxy detection.

## ChatGPT Pro Workflow

After connecting CodexPro in ChatGPT Developer Mode:

```text
1. open_current_workspace
2. read_project_context
3. search_project_memory with the task keywords
4. write_detailed_solution with objective, evidence, approach, steps, validation, risks, rollback
5. handoff_to_claude_code with the executor-facing plan
6. handoff_poll with the returned plan_hash
7. review show_changes / implementation-diff.patch / agent-status.md
```

This is the intended "Pro thinks deeply, local agent executes, Pro reviews" loop.

`watch-handoff` consumes only successful plan hashes. If Claude Code or another executor exits non-zero for a plan, rerunning the watcher with the same unchanged plan retries it instead of silently skipping it.

## Extended Pro Model Boundary

If the ChatGPT web model surface can call Developer Mode MCP tools, it can use these tools directly. If a specific model or mode cannot call MCP tools, use `export_pro_context` or `read_project_context`, paste the generated context into that model, then bring its detailed plan back through `write_detailed_solution` or `handoff_to_claude_code`.

CodexPro cannot force a ChatGPT model picker to expose MCP tools, and it does not provide model access by itself.

## ChatGPT Web Conversation History

This fork does not automatically read all ChatGPT web conversations. That is intentional:

- ChatGPT's web chat history is not exposed as a general MCP data source by CodexPro.
- Reading private account history by browser scraping would be fragile and may violate product boundaries.
- The safe path is explicit memory: ask ChatGPT Pro to summarize the current conversation and call `save_chat_summary`.
- For a single current or exported chat, call `save_chat_session` with structured `messages` or a raw `transcript`, then retrieve it later with `read_saved_chat_session`.
- For old chats, export or manually summarize the relevant parts, then save them into `.ai-bridge/chat-memory.jsonl`, `.ai-bridge/chat-sessions/`, or `.ai-bridge/project-context.md`.

This still helps a lot: future ChatGPT Pro, Codex, and Claude Code runs can read durable project decisions without relying on one hidden web transcript.

### Scroll-Capture A Visible ChatGPT Session

When the target conversation is open in Chrome, Codex or Claude Code can run a local capture command that scrolls the page upward to trigger older-message loading, then scans downward to collect messages in order:

```bash
codexpro capture-chatgpt-session --root /path/to/repo --find-chatgpt
```

This writes a project-local saved session that `read_saved_chat_session` can read later. Duplicate identical turns are preserved. The default backend uses Chrome AppleScript automation and may require enabling:

```text
Chrome -> View -> Developer -> Allow JavaScript from Apple Events
```

For a dedicated automation Chrome launched with DevTools enabled, use:

```bash
codexpro capture-chatgpt-session \
  --root /path/to/repo \
  --cdp-url http://127.0.0.1:9222 \
  --cdp-url-contains chatgpt.com/c/
```

The scroll capture is best-effort because ChatGPT's web DOM and lazy-loading behavior can change. It is still explicit, local, and auditable: no hidden account-history API is used, transcript data is written only into the workspace, and `--max-session-bytes` bounds accidental oversized writes.

By default, capture refuses to write secret-looking values into `.ai-bridge`. Use `--allow-sensitive` only when you intentionally want to keep a full private transcript locally.

## Claude Code Local Health

CodexPro can wire plans to Claude Code only after the local Claude Code CLI can make model calls. Verify:

```bash
claude --version
claude auth status
claude mcp list
claude -p --model sonnet --no-session-persistence --tools '' -- 'Reply exactly CODEXPRO_CLAUDE_SMOKE_OK.'
```

If the final command returns `403 Request not allowed`, Claude Code is installed and may even be logged in, but Anthropic's first-party API path is refusing the model request. Refresh auth with `claude auth login` or `claude setup-token`, or fix the account/network policy. On macOS systems with a working browser proxy, retry the smoke with the same proxy exported, for example `HTTPS_PROXY=http://127.0.0.1:6382 HTTP_PROXY=http://127.0.0.1:6382 ALL_PROXY=socks5h://127.0.0.1:6382 claude -p ...`, then rerun the smoke before relying on `--agent claude-code`.

## Files Created in `.ai-bridge`

```text
project-context.md
chat-memory.jsonl
chat-session-index.jsonl
chat-sessions/
solution-plan.md
implementation-checklist.md
review-criteria.md
current-plan.md
handoff-run-state.json
agent-status.md
implementation-diff.patch
execution-log.jsonl
```

## Verification

The implementation is covered by:

```bash
npm run build
npm run smoke
npm run smoke:chatgpt-capture
```

For a full capability matrix and data-flow notes, see `TECHNICAL_ARCHITECTURE.md`.
