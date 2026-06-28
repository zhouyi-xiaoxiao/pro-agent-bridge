# Second-Round Extended Pro Audit Notes

Date: 2026-06-28

This file records the second Extended Pro review pass and the implementation changes made afterward.

## Review Findings Addressed

| Finding | Resolution |
| --- | --- |
| Large saved sessions could save successfully but fail later because `read_saved_chat_session` bounded the whole file through ordinary text-file reads. | `read_saved_chat_session` now streams JSONL rows, returns bounded messages, and reports full-file SHA-256 plus file size. |
| `.ai-bridge` JSONL/session writes did not consistently harden file permissions or block secret-looking values. | `.ai-bridge` directories and bridge files are created or repaired with private permissions where chmod is supported. Chat summary/session writes reject secret-looking values unless `allow_sensitive=true`; the ChatGPT capture CLI also defaults to secret blocking with `--allow-sensitive` as an explicit override. |
| ChatGPT scroll capture used `role + content` as its dedupe key and could drop duplicate identical turns. | Capture now prefers DOM message ids and otherwise tracks occurrence indexes, preserving repeated identical messages. |
| `watch-handoff` recorded failed plan hashes as consumed. | Watch state now separates attempted, succeeded, and failed plan hashes. A failed unchanged plan retries by default. |
| CDP capture was unnecessarily gated by macOS Apple Events logic and could hang on WebSocket close/error. | CDP mode bypasses the Apple Events platform check, selects ChatGPT targets more deliberately, rejects pending calls on close/error, and times out CDP evaluations. |
| `codexpro-claude-handoff` allowed very large plans to be passed through argv. | The Claude helper now applies a conservative plan-size cap and tells users to use a custom streaming command for unusually large plans. |

## Verification

Run:

```bash
npm run build
npm run smoke
npm run smoke:chatgpt-capture
git diff --check
```

The smoke suite covers:

- project memory and saved-session tools;
- large saved-session streaming/truncation;
- private `.ai-bridge` permissions;
- secret guard rejection;
- local execute/watch/loop handoff;
- failed watch-handoff retry;
- CDP ChatGPT capture;
- duplicate identical message preservation.

## Claude Code Local Status

CodexPro can verify Claude Code installation and MCP wiring, but it cannot grant Claude model access. A healthy local setup should pass:

```bash
claude --version
claude auth status
claude mcp list
claude -p --model sonnet --no-session-persistence --tools '' -- 'Reply exactly CODEXPRO_CLAUDE_SMOKE_OK.'
```

If the final command returns `403 Request not allowed`, the local CLI is installed and authenticated enough to report status, but Anthropic's first-party API path is rejecting model calls. Refresh Claude Code auth with `claude auth login` or `claude setup-token`, or fix the account/network policy, then rerun the smoke before relying on `--agent claude-code`.
