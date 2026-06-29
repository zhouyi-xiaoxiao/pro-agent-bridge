# Pro Agent Bridge Review Packet

Please review Pro Agent Bridge as if you are the ChatGPT Pro planning/review model connected through MCP.

## Objective

Evolve the CodexPro-compatible CLI into Pro Agent Bridge so ChatGPT Pro can do more than produce a loose action plan:

- save durable project and conversation memory in `.ai-bridge`;
- write detailed implementation plans, checklists, and review criteria;
- hand off concrete execution to Claude Code through a local watcher;
- poll execution status, logs, and diffs for review;
- save and read explicit single-session chat transcripts;
- optionally capture the currently visible ChatGPT web session by local Chrome scroll automation;
- preserve the product boundary that Pro Agent Bridge is an MCP and local-agent bridge, not a model proxy or quota bypass.

## Implementation Summary

Changed files:

- `src/server.ts`
  - Added MCP tools: `read_project_context`, `search_project_memory`, `save_chat_summary`, `save_chat_session`, `list_saved_chat_sessions`, `read_saved_chat_session`, `write_detailed_solution`, `handoff_to_claude_code`, `handoff_poll`.
  - Added plan hashing, bounded artifact reading, JSONL parsing, project-memory formatting, saved-session formatting, detailed-plan rendering, and handoff state reading helpers.
  - Added Claude Code command hints.

- `src/fsOps.ts`
  - Expanded default `.ai-bridge` scaffold with `project-context.md`, `chat-memory.jsonl`, `solution-plan.md`, `implementation-checklist.md`, `review-criteria.md`, and `handoff-run-state.json`.

- `scripts/codexpro.mjs`
  - Added `--agent claude-code` for `execute-handoff` and `watch-handoff`.
  - Added `.ai-bridge/handoff-run-state.json` writes before and after local executor runs.

- `scripts/claude-handoff.mjs`
  - New helper that reads a handoff plan and invokes the local Claude Code CLI through `claude -p`.

- `scripts/chatgpt-scroll-capture.mjs`
  - New local helper that scrolls the visible ChatGPT conversation upward/downward and saves explicit session JSONL.
  - Supports Chrome Apple Events and a CDP backend for deterministic smoke tests.

- `scripts/chatgpt-capture-smoke.mjs`
  - Launches a temporary Chrome profile with a fixture page and verifies scroll capture writes top/middle/bottom messages.

- `scripts/smoke.mjs`
  - Added MCP smoke coverage for project memory, detailed solution writing, Claude Code handoff, and polling.

- `scripts/execute-handoff-smoke.mjs`
  - Added verification that local execution writes a completed `handoff-run-state.json`.

- `package.json` / `package-lock.json`
  - Added `codexpro-claude-handoff` and `codexpro-capture-chatgpt` bins.
  - Added `smoke:chatgpt-capture`.

- `EXTENDED_PRO_CLAUDE_BRIDGE.md`
  - Added usage and boundary documentation.

- `TECHNICAL_ARCHITECTURE.md`
  - Added capability count, data model, session-history behavior, Extended Pro workflow, security boundaries, and verification matrix.

## Review Questions

1. Are the new MCP tools sufficiently scoped and safe for ChatGPT Developer Mode?
2. Is the Claude Code integration correctly separated from remote MCP execution?
3. Does the design support the desired loop: ChatGPT Pro plans, Claude Code executes locally, ChatGPT Pro reviews?
4. Are the `.ai-bridge` artifacts clear enough for cross-agent continuity?
5. Are saved single-session reads and scroll capture bounded enough for important repositories?
6. What edge cases should be tightened before this fork is used on important repositories?

## Verification Already Run

```bash
npm run build
npm run smoke
npm run smoke:chatgpt-capture
```

All passed locally before publication of the current fork snapshot.

## Known Boundary

This fork does not automatically read all ChatGPT web conversation history. It supports explicit memory capture through `save_chat_summary`, explicit single-session transcripts through `save_chat_session`, and best-effort visible-page capture through `codexpro capture-chatgpt-session`. That is safer and more reliable than claiming access to hidden private web history.
