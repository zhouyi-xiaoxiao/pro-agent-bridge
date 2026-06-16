# CodexPro Launch Copy

Use this copy for X, Reddit, Hacker News, and GitHub release posts.

Keep the boundary clear: CodexPro does not bypass OpenAI rate limits or unlock models a user does not already have. It gives ChatGPT Developer Mode a local MCP bridge so users can get more coding value from the ChatGPT subscription they already pay for. If a user has a stronger model available in ChatGPT web, including any GPT-5.5-class model exposed to their account, CodexPro lets that session work against local repo context through MCP.

## X Post Option 1

```text
I open-sourced CodexPro.

It turns ChatGPT web into a local coding agent:

- reads your repo
- loads Codex-style context from AGENTS.md + .ai-bridge
- edits files
- searches code
- checks git status/diff
- runs safe verification commands

Start it in any repo:

npx codexpro@latest start

Paste the copied URL into ChatGPT Developer Mode and code from ChatGPT.

GitHub: https://github.com/rebel0789/codexpro
npm: https://www.npmjs.com/package/codexpro
```

## X Post Option 2

```text
Codex is great, but sometimes you want another coding surface.

CodexPro gives ChatGPT Developer Mode local agent powers through MCP.

Your ChatGPT web session can see Codex-style context:

- AGENTS.md
- .ai-bridge/current-plan.md
- Codex status notes
- git status / git diff
- selected source files

Then it can write, edit, search, and verify against the repo.

npx codexpro@latest start

If your ChatGPT account has access to a stronger web model, CodexPro lets that model use the same local coding tools.
```

## X Thread

```text
1/ I built CodexPro: a local MCP bridge that lets ChatGPT web work inside your repo.

The goal is simple:

get more coding value from the ChatGPT subscription you already pay for.

2/ Run this inside any project:

npx codexpro@latest start

CodexPro starts a local MCP server, opens a tunnel, copies the ChatGPT Server URL, and keeps the process alive.

3/ Paste the copied URL into ChatGPT Developer Mode -> Create App.

After that, ChatGPT can call tools against your local repo:

- read
- write
- edit
- search
- bash safe commands
- git status
- git diff

4/ It also gives ChatGPT Codex-style context.

ChatGPT can read:

- AGENTS.md
- .ai-bridge/current-plan.md
- .ai-bridge/codex-status.md
- decisions / open questions
- selected source files

5/ Default mode is normal coding:

ChatGPT edits files directly and verifies the work.

Handoff mode is planning-only:

ChatGPT writes .ai-bridge/current-plan.md and Codex executes locally.

Pro planning mode exports a durable context bundle when MCP tools are unavailable.

6/ Stable URLs are supported:

- Cloudflare quick tunnel for demos
- reserved ngrok domain for simple daily use
- Cloudflare named tunnel for custom domains

Once saved, daily startup is just:

codexpro start

7/ Important boundary:

CodexPro does not bypass OpenAI limits or unlock models you do not have.

It gives ChatGPT Developer Mode local coding-agent tools, so you can use the ChatGPT surface you already have more effectively.

8/ Repo:
https://github.com/rebel0789/codexpro

npm:
https://www.npmjs.com/package/codexpro
```

## Reddit Post

```text
Title: I built CodexPro: use ChatGPT Developer Mode as a local coding agent for your repo

I wanted a cleaner way to use ChatGPT web as an actual coding agent against a local repo, not just as a chat window that gives suggestions.

So I built CodexPro.

It is a local MCP bridge. You run it inside a project:

npx codexpro@latest start

It starts a local MCP server, opens a tunnel, copies the ChatGPT Server URL, and then ChatGPT Developer Mode can connect to your repo.

What ChatGPT gets:

- read files with line numbers
- write files
- exact-edit files
- search with ripgrep
- inspect git status and git diff
- run allowlisted verification commands
- load Codex-style context from AGENTS.md and .ai-bridge

Modes:

- Normal coding mode: ChatGPT edits and verifies directly
- Handoff mode: ChatGPT writes .ai-bridge/current-plan.md for Codex or another local agent to execute
- Pro planning mode: export a durable context bundle for sessions/models that cannot call MCP tools

Tunnel options:

- Cloudflare quick tunnel for instant demos
- ngrok reserved domain for a stable free URL
- Cloudflare named tunnel for custom domains
- local-only mode for clients that can reach localhost

The reason I built it:

If you already pay for ChatGPT, you should be able to get more coding value from it. CodexPro lets ChatGPT web work with real repo context instead of only writing instructions for you to copy manually. If your ChatGPT account exposes a stronger web model, CodexPro gives that session local repo tools too.

Important: this does not bypass OpenAI limits or unlock models you do not already have. It gives ChatGPT Developer Mode local coding-agent tools through MCP.

GitHub:
https://github.com/rebel0789/codexpro

npm:
https://www.npmjs.com/package/codexpro
```

## Short Tagline Options

```text
Let ChatGPT web code inside your repo.

Use ChatGPT as another coding surface for your repo.

Get more coding value from the ChatGPT subscription you already pay for.

ChatGPT web, meet your local repo.

Codex-style context, ChatGPT web workflow.
```
