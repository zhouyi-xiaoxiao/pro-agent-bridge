# Extended Pro + Claude Code Bridge

This fork extends CodexPro from a direct ChatGPT-to-workspace MCP bridge into a reviewable planning and execution loop:

1. ChatGPT Pro writes durable project memory and an implementation-ready plan.
2. A local terminal process runs the plan with Claude Code, Codex, OpenCode, Pi, or a custom executor.
3. ChatGPT Pro polls `.ai-bridge` artifacts to review status, logs, and diffs.

The bridge does not unlock models, proxy model access, scrape ChatGPT, or bypass product limits. It exposes local workspace tools to a compatible ChatGPT Developer Mode session that you already control.

## New MCP Tools

| Tool | Purpose |
| --- | --- |
| `read_project_context` | Reads `.ai-bridge/project-context.md`, detailed plans, checklists, current handoff, agent status, diff, execution log, and recent saved chat memory. |
| `search_project_memory` | Searches saved `.ai-bridge` memory and planning artifacts before a new plan is written. |
| `save_chat_summary` | Appends an explicit ChatGPT-provided conversation summary, decisions, todos, links, and tags to `.ai-bridge/chat-memory.jsonl`; can promote the summary to `.ai-bridge/project-context.md`. |
| `save_chat_session` | Saves one explicit structured chat transcript or raw transcript into `.ai-bridge/chat-sessions/`. |
| `list_saved_chat_sessions` | Lists saved project-local chat sessions from `.ai-bridge/chat-session-index.jsonl`. |
| `read_saved_chat_session` | Reads one saved chat session by `session_id` with bounded message and byte limits. |
| `write_detailed_solution` | Writes `.ai-bridge/solution-plan.md`, `.ai-bridge/implementation-checklist.md`, and `.ai-bridge/review-criteria.md`; can also write `.ai-bridge/current-plan.md`. |
| `handoff_to_claude_code` | Writes `.ai-bridge/current-plan.md` for Claude Code execution and returns a plan hash plus watcher command. |
| `handoff_poll` | Read-only polling of `.ai-bridge/handoff-run-state.json`, agent status, implementation diff, and execution log. |

## Claude Code Execution

The MCP server never launches Claude Code remotely. Execution happens in a terminal you start:

```bash
codexpro watch-handoff --agent claude-code --yes
```

When ChatGPT Pro calls `handoff_to_claude_code`, the watcher detects the new `.ai-bridge/current-plan.md` hash and runs:

```bash
codexpro-claude-handoff --plan-file .ai-bridge/current-plan.md
```

That helper calls the local Claude Code CLI with `claude -p <handoff prompt>`. It asks Claude Code to inspect the workspace, make scoped edits, run focused verification, and update `.ai-bridge/agent-status.md`.

Useful optional environment variables:

```bash
CLAUDE_HANDOFF_ARGS="--model claude-sonnet-4-5"
CLAUDE_HANDOFF_BIN="/path/to/claude"
```

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
node scripts/smoke.mjs
node scripts/execute-handoff-smoke.mjs
```
