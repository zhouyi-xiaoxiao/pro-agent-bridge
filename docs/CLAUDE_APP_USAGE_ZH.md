# Claude App / Claude Code 使用指南

这份说明用于把 Claude App、Claude Code CLI 和 Pro Agent Bridge 分清楚用。核心判断很简单：

- `pro_agent_bridge_local` 是本地 MCP 服务，负责读写仓库、读取已保存会话、读取 Codex session、生成 handoff、跑安全命令。
- `Claude in Chrome` 是 Anthropic 的浏览器扩展通道，负责让 Claude 看到和控制 Chrome 标签页。
- 两者相互独立。`pro_agent_bridge_local` 可用不代表 `Claude in Chrome` 已经配对；`list_connected_browsers` 返回 `[]` 时，通常是浏览器扩展还没有完成连接。

## 先确认 MCP 是否可用

在 Claude App 或 Claude Code 里可以直接给 Claude 这段话：

```text
请先调用 MCP 工具 `pro_agent_bridge_local.codexpro_self_test`，参数：
write_probe=false
include_inventory=true

然后告诉我 status、registered_tools、失败数和警告原因。不要只给计划；必须先实际调用工具。
```

如果它报告 `status=ok` 或只有非阻断 `warn`，就说明本地 MCP 可以用。常见非阻断警告包括：当前目录不是 git repo、按要求跳过写入探针、某些只读环境没有执行写入测试。

命令行也可以确认：

```bash
claude mcp list
```

应该能看到：

```text
pro_agent_bridge_local: node /path/to/pro-agent-bridge/dist/stdio.js - Connected
```

## 让 Claude 更容易用这套 MCP 的提示词

日常给 Claude App / Claude Code 的推荐开场：

```text
你现在可以使用本地 MCP `pro_agent_bridge_local`。

请按这个顺序工作：
1. 先调用 `codexpro_self_test(write_probe=false, include_inventory=true)` 确认连接。
2. 再调用 `server_config` 和 `open_current_workspace` 或 `workspace_snapshot`，确认当前工作区。
3. 需要了解代码时，优先用 `tree`、`search`、`read`，不要让我手动复制文件。
4. 需要读取历史时，先用 `list_saved_chat_sessions` / `read_saved_chat_session`；需要 Codex 历史时，用 `codex_sessions` / `read_codex_session`。
5. 需要形成方案时，用 `write_detailed_solution` 保存详细方案，而不只是口头回答。
6. 需要交给 Codex 或 Claude Code 执行时，用 `handoff_to_codex` 或 `handoff_to_claude_code`，并给我 handoff id。
7. 修改文件前先说明会改哪些文件；修改后用 `git_diff` 或 `show_changes` 汇报。

请实际调用工具完成任务，不要只说“我可以”。
```

## 读取单个 session 历史

可以做到，但要看 session 来源：

- Pro Agent Bridge 保存的会话：`list_saved_chat_sessions` -> `read_saved_chat_session`
- Codex 本地 session：`codex_sessions` -> `read_codex_session`
- ChatGPT 网页端当前对话：需要 `Claude in Chrome` 或 Codex/Chrome 控制通道能看到网页；如果没有浏览器通道，只能读取已经导出或保存到本地的会话。

给 Claude 的提示词：

```text
请读取一个历史 session。先列出可用来源：
- 调用 `list_saved_chat_sessions`
- 调用 `codex_sessions`

然后让我选择 session id。选定后调用对应的 `read_saved_chat_session` 或 `read_codex_session`，整理成：
1. 背景
2. 用户目标
3. 关键决策
4. 已完成动作
5. 未解决问题
6. 下一步建议
```

## 使用 Claude in Chrome

如果任务需要 Claude 直接读取或控制 Chrome / ChatGPT 网页端，先让它检查浏览器连接：

```text
请先调用 `Claude in Chrome` 的 `list_connected_browsers`。
如果返回 `[]`，请明确说“浏览器扩展尚未连接”，不要把它误判成 `pro_agent_bridge_local` MCP 故障。
如果看到浏览器，请继续选择当前 Chrome，并打开我已经登录的 ChatGPT 标签页。
```

`list_connected_browsers` 返回 `[]` 时，需要在 Chrome 里人工完成一次扩展连接：

1. 打开 Chrome 中的 Claude 扩展。
2. 登录 Claude。
3. 打开扩展侧边栏或连接提示。
4. 点击 `Connect` / `Allow` / `Authorize` 之类的连接按钮。
5. 再让 Claude 重新调用 `list_connected_browsers`。

这是 Anthropic 浏览器扩展自己的配对步骤，不是 Pro Agent Bridge 能从 MCP 里强制完成的步骤。

## ChatGPT Pro / Extended Pro 怎么配合

Pro Agent Bridge 不能强制 ChatGPT 网页端切换模型，也不能绕过模型或账号限制。正确方式是：

1. 在 ChatGPT 网页端手动选择你要用的 Pro / Extended Pro 模型。
2. 让该 ChatGPT 会话调用 Pro Agent Bridge app / MCP。
3. 让 ChatGPT 用 `read_project_context`、`search_project_memory`、`export_pro_context`、`write_detailed_solution` 形成尽量详细的方案。
4. 再把方案通过 `handoff_to_codex` 或 `handoff_to_claude_code` 交给本地 agent 执行。

推荐给 ChatGPT Pro 的提示词：

```text
请使用 Pro Agent Bridge 工具，不要只给行动方案。

你的任务：
1. 先读取项目上下文和 git 状态。
2. 搜索相关代码和历史记忆。
3. 写出一个可执行的详细方案，包含文件级改动、测试、风险、回滚方式。
4. 如果改动范围安全，请直接通过工具执行小改动；如果需要本地 agent，请生成 handoff。
5. 输出时区分：已经完成、需要本地执行、需要我授权。

请尽量具体，避免只给抽象建议。
```

## 当前最常见的误判

不要把下面两件事混为一谈：

- `pro_agent_bridge_local` 连接成功：Claude 可以读本地仓库、session、handoff 和运行安全命令。
- `Claude in Chrome` 连接成功：Claude 可以看到 Chrome 浏览器标签页。

如果 `claude mcp list` 显示 `pro_agent_bridge_local` connected，但 `list_connected_browsers` 返回 `[]`，结论是：

```text
本地 MCP 已经可用；浏览器扩展尚未完成配对或没有已连接浏览器。
```
