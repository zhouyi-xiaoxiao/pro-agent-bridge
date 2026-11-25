# Pro Agent Bridge

一个本地 MCP 服务器（MCP 即 Model Context Protocol，ChatGPT 调用外部工具的标准协议）：让 ChatGPT Pro 在你电脑上的某一个仓库里工作（读文件、搜索、精确编辑、运行安全的检查命令），再把写好的计划交给 Claude Code。Claude Code 在你自己启动的终端里执行，ChatGPT 再把结果读回来审阅。

它延续自 rebel0789 以 MIT 许可开源的 [CodexPro](https://github.com/rebel0789/codexpro)。地基、`codexpro` 这个命令名和本手册的大部分内容都来自上游。本仓库在此之上新增的部分由周易潇潇（[zhouyixiaoxiao.com](https://zhouyixiaoxiao.com/)）于 2026 年 6 月 27–29 日完成：

- **交给 Claude Code 执行**：`handoff_to_claude_code` 写出计划，本地运行的监视进程（`codexpro watch-handoff --agent claude-code`）负责执行，`handoff_poll` 让 ChatGPT 读取状态、日志和 diff。
- **长时间规划用的项目记忆**：`read_project_context`、`search_project_memory`、`save_chat_summary`、`write_detailed_solution`，把计划和决定存在仓库内的 `.ai-bridge/` 里。
- **会话保存**：`save_chat_session`、`list_saved_chat_sessions`、`read_saved_chat_session`，以及可选的 Chrome 抓取助手（`codexpro capture-chatgpt-session`）。
- **加固的交接流程**：轮询和监视执行修补了竞态问题；执行失败的计划不会被消耗，可以重试。

设计说明见 [EXTENDED_PRO_CLAUDE_BRIDGE.md](EXTENDED_PRO_CLAUDE_BRIDGE.md) 和 [TECHNICAL_ARCHITECTURE.md](TECHNICAL_ARCHITECTURE.md)。

**现状**：代码于 2026 年 6 月 26 日从 CodexPro 主分支分出（版本 0.28.5），最后一次修改是 2026 年 6 月 29 日；2026 年 11 月的后续提交只更新文档。截至 2026 年 11 月仍在作者的日常使用中。上游此后继续更新，npm 上的 `codexpro`（0.30.x）不包含上面这些新增功能。

[English](README.md) · [中文 FAQ](FAQ_ZH.md) · [Claude 使用指南](docs/CLAUDE_APP_USAGE_ZH.md) · [安全说明](SECURITY.md) · [稳定 URL 指南](docs/DOMAIN_SETUP.md)

## 安装

需要 Node.js 20 或更高版本，以及能使用 Apps / Developer Mode 的 ChatGPT Plus 或 Pro 账号。

`npm install -g codexpro` 装的是上游 CodexPro，不是本仓库。要用这个版本，请从源码构建，再从该目录全局安装：

```bash
git clone https://github.com/zhouyi-xiaoxiao/pro-agent-bridge.git
cd pro-agent-bridge
npm install
npm run build
npm install -g .
```

这样 `codexpro`、`codexpro-claude-handoff` 和 `codexpro-capture-chatgpt` 就会出现在 `PATH` 里（还有两个服务入口 `codexpro-mcp`、`codexpro-mcp-http`），并替换已安装的上游 `codexpro`。全局命令链接到这个目录，所以安装后不要移动或删除它。

进入你想让 ChatGPT 工作的仓库，然后运行 setup：

```bash
cd /path/to/your/repo
codexpro setup
```

`codexpro` CLI 会自动复制 ChatGPT Server URL。到 ChatGPT 打开 `Settings -> Apps -> Advanced settings -> Create app`，粘贴这个 URL，并选择 `Authentication: No Authentication / None`。

以后同一个仓库日常启动只需要：

```bash
codexpro start
```

Pro Agent Bridge 把 ChatGPT Developer Mode 变成本地仓库的 MCP 代码与 handoff 工作台。ChatGPT 可以读取文件、搜索代码、查看 git 状态、写入或精确编辑文件、把计划交给 Claude Code，并运行安全范围内的验证命令。

Pro Agent Bridge 不是速率限制绕过工具。它不会绕过、提升、合并、转售或修改 ChatGPT、Codex、Claude Code、OpenAI、Anthropic 或第三方模型的限制。它只是通过官方 Developer Mode / MCP App 路径，把你自己的 ChatGPT 会话连接到你自己的本地仓库和本地执行器。

MCP 服务不会自行获取 ChatGPT 对话。它只读取你明确保存到仓库 `.ai-bridge/chat-sessions/` 的会话；可选的 `capture-chatgpt-session` 助手只有在你主动运行时，才把你自己 Chrome 窗口里打开的那段对话保存到本机的这个目录，不会发送到别处。

如果 Codex 或 Claude Code 的某个工作流暂时不可用，而你的 ChatGPT 页面仍然可用，Pro Agent Bridge 可以让你继续在同一个本地仓库上工作。反过来也一样：ChatGPT 负责高上下文规划，Codex、Claude Code、OpenCode、Pi 或其他本地执行器负责终端里的实际执行。

下文大部分沿用上游 CodexPro 的手册。文中说到 CodexPro 的地方，同样适用于 Pro Agent Bridge。

## 适合谁

Pro Agent Bridge 适合已经使用 ChatGPT Plus 或 Pro 做开发的人：

- 想让 ChatGPT Web 直接读取本地代码，而不是反复复制文件片段。
- 想把 `AGENTS.md`、`.ai-bridge`、git diff、源码文件这些 Codex 风格上下文给 ChatGPT。
- 想在 ChatGPT 里完成规划、审查、改小文件、跑安全验证。
- 想在某些模型不能调用工具时，导出一个持久上下文包给它做规划。
- 想把 ChatGPT 的计划交给 Codex、OpenCode、Pi 或自定义本地代理执行。

当前测试显示，ChatGPT Free / Go 账号不暴露 CodexPro 需要的 Apps / Developer Mode 创建流程。推荐使用 ChatGPT Plus 或 Pro。

## 它能做什么

```text
ChatGPT Web 可以看到：
  AGENTS.md
  .ai-bridge 计划、状态和执行记录
  git status
  show_changes 审查摘要和可选 diff
  文件树、搜索结果、指定源码文件

ChatGPT Web 可以操作：
  read    读取文件
  search  搜索代码
  write   在工作区内写文件
  edit    精确替换文本
  bash    运行安全验证命令
  show_changes 查看当前改动摘要

本地执行器仍然有价值：
  Codex / OpenCode / Pi 执行计划
  终端重任务留在本地
  ChatGPT 回看执行结果和 diff
```

默认 `CODEXPRO_TOOL_MODE=standard`，只暴露常用编码循环、`codexpro_self_test`、`show_changes`、上下文导出和 handoff。演示时可以用 `--tool-mode minimal`，需要完整兼容工具时用 `--tool-mode full`。

默认工具数量较少是故意的：ChatGPT 面对少量高信号工具时更稳定。workspace open 仍会发现已安装的 user/plugin skills，并可用 `load_skill` 按名称、source 和显示出的 path 加载需要的 `SKILL.md`；如果仍有重名匹配，CodexPro 会报歧义错误，不会随便选一个，也不会把几十个 skill 变成单独 action。

CodexPro 默认给 ChatGPT 暴露纯 MCP 工具描述，不附带 widget/card metadata。需要紧凑 v9 卡片时用 `CODEXPRO_TOOL_CARDS=1` 启动；server config、自测、workspace 摘要、读写 diff、bash 验证、git/tree/search/context 和 handoff/export 都有结构化视图。git、skills、tree、terminal 输出、context 和 raw diff 会折叠或截断，避免在聊天里刷出大段原始数据。`CODEXPRO_WIDGET_DOMAIN` 用于设置 ChatGPT widget iframe 的专用 HTTPS origin，正式提交 app 前应换成你控制的独立域名。

## 其他启动方式

上游提供的免安装方式运行的是上游 CodexPro，不含上面说的 Claude Code 交接、项目记忆和会话保存工具：

```bash
npx codexpro@latest start --root /absolute/path/to/your/repo
```

不想全局安装本仓库时，先按「安装」一节构建，再直接调用启动脚本：

```bash
node /path/to/pro-agent-bridge/scripts/codexpro.mjs start --root /absolute/path/to/your/repo
```

日常使用仍更推荐全局安装，这样命令就是固定的 `codexpro setup` 和 `codexpro start`。

## ChatGPT 中的 App 设置

先在 ChatGPT 打开 Developer Mode：

```text
ChatGPT Settings
-> Apps
-> Advanced settings
-> Developer mode: on
-> Enforce CSP in developer mode: on
-> Create app
```

保留 CSP 开启。CodexPro 的卡片和小组件就是按 CSP 开启的路径设计的，不需要远程脚本、外部字体、iframe 或第三方图片。

在 Create App 页面填写：

```text
Name: CodexPro
Description: Local workspace bridge for ChatGPT coding
Connection: Server URL
Server URL: 粘贴 CodexPro 自动复制的 URL
Authentication: No Authentication / None
```

复制的 Server URL 已经包含私有 `codexpro_token`。不要单独粘贴 token，除非你的 ChatGPT UI 明确支持自定义 header。

保持终端里的 CodexPro 进程运行。你停止它之后，ChatGPT 就无法继续连接本地仓库。Cloudflare quick tunnel 的 URL 也会失效。

## 三种主要模式

### 1. Normal coding

默认模式。ChatGPT 可以在工作区内读取、搜索、写入、精确编辑文件，并运行安全验证命令。

```bash
codexpro start
```

适合小改动、文档更新、定位 bug、查看 diff、跑 lint/test/build。

如果你正在另一个 Codex 会话里工作，不希望 ChatGPT 触发任何 shell 命令，用：

```bash
codexpro start --no-bash
```

如果想保留 bash，但要求 ChatGPT 明确命中你启动的这个 CodexPro 终端会话标签，用：

```bash
codexpro start --bash-session main --require-bash-session
```

开启后，`bash` 工具调用必须带上 `session_id: "main"` 才会执行。

### 2. Handoff

规划模式。ChatGPT 不直接写源码，只写入：

```text
.ai-bridge/current-plan.md
```

然后你在本地终端决定是否执行：

```bash
codexpro execute-handoff --agent opencode --model provider/model --dry-run
codexpro execute-handoff --agent opencode --model provider/model
```

也可以启动监听器，让本地终端在计划变更后执行：

```bash
codexpro start --mode handoff
codexpro start --mode handoff --no-bash
codexpro watch-handoff --agent opencode --model provider/model --yes
```

执行结果会写回：

```text
.ai-bridge/agent-status.md
.ai-bridge/implementation-diff.patch
.ai-bridge/execution-log.jsonl
```

然后让 ChatGPT 通过 `read_handoff` 或 `codex_context` 审查结果。

### 3. Pro context fallback

有些 ChatGPT 模型或产品界面不能直接调用 Developer Mode Apps、连接器或 MCP 工具。即使同一个 Plus/Pro 账号可以创建 CodexPro app，某个具体模型界面仍然可能没有工具调用能力。

这时不要强行让它调用工具。先导出一个持久上下文包：

```bash
codexpro pro-bundle --root /absolute/path/to/your/repo --copy
```

它会写入：

```text
.ai-bridge/pro-context.md
```

把这个上下文粘贴给不能调用工具的模型，让它产出窄范围实现计划。然后保存计划并应用：

```bash
codexpro pro-apply --root /absolute/path/to/your/repo --file plan.md
```

这会写入 `.ai-bridge/current-plan.md`，再交给 Codex、OpenCode、Pi 或自定义本地代理执行。

如果你的 ChatGPT 账号在 Web 产品里提供更强的模型，并且该模型界面可以调用 Developer Mode Apps，CodexPro 可以让它通过 MCP 使用本地仓库工具。CodexPro 不提供、不代理、不转售、也不解锁模型。

## 稳定 URL 怎么选

ChatGPT App 需要一个可访问的 Server URL。你有三个常用选择：

```text
Cloudflare quick tunnel   最快演示路径。每次重启 URL 都变。
ngrok free dev domain     推荐给大多数用户。免费账号给一个稳定 dev domain。
Cloudflare named tunnel   适合已有自定义域名的用户。
```

### Cloudflare quick tunnel

最适合录 demo 或临时试用：

```bash
codexpro start
```

缺点很明确：quick tunnel 的 URL 每次重启都会变。如果你把 quick URL 放进 ChatGPT App，下一次启动时需要重新编辑 ChatGPT App 的 Server URL。

### ngrok free dev domain

推荐给大多数用户。创建一个免费 ngrok 账号，在 ngrok Dashboard 的 Universal Gateway -> Domains 找到你的 dev domain，比如：

```text
your-name.ngrok-free.dev
```

一次性认证 ngrok：

```bash
ngrok config add-authtoken YOUR_NGROK_TOKEN
```

保存到 CodexPro：

```bash
codexpro settings set --tunnel ngrok --hostname your-name.ngrok-free.dev
```

以后启动：

```bash
codexpro start
```

ChatGPT 里的 Server URL 可以保持不变。

### Cloudflare named tunnel

如果你有自己的域名，可以用 Cloudflare named tunnel：

```bash
cloudflared tunnel login
cloudflared tunnel create codexpro
cloudflared tunnel route dns codexpro codexpro.example.com
```

之后日常启动：

```bash
codexpro stable --hostname codexpro.example.com --tunnel-name codexpro
```

更多域名细节见 [docs/DOMAIN_SETUP.md](docs/DOMAIN_SETUP.md)。

## Codex 风格上下文

CodexPro 不读取 Codex 的隐藏运行时记忆。它给 ChatGPT 的是显式工作区上下文：

```text
open_current_workspace  当前 root、安全模式、AGENTS 状态、git 状态
codex_context           AGENTS 链、.ai-bridge 文件、可选 git status/diff
read_handoff            只读 .ai-bridge 文件
workspace_snapshot      更大的项目快照和 handoff 上下文
```

`codex_context` 会读取从仓库根目录到目标路径上的指令文件：

```text
AGENTS.override.md
AGENTS.md
agents.md
.agents.md
```

并加入：

```text
.ai-bridge/current-plan.md
.ai-bridge/agent-status.md
.ai-bridge/implementation-diff.patch
.ai-bridge/codex-status.md
.ai-bridge/decisions.md
.ai-bridge/open-questions.md
.ai-bridge/execution-log.jsonl
git status
可选 git diff
```

推荐流程：

```text
先调用 server_config 和 codexpro_self_test
如果 self-test 失败，先停下来报告失败项
先调用 open_current_workspace，include_tree=false
再调用 codex_context，target_path 指向要改的文件，include_diff=false
然后只读取当前任务需要的文件
```

这样 ChatGPT 会更接近 Codex 的指令模型，同时不会依赖隐藏状态或大范围重复扫描。

## 安全边界

CodexPro 是本地开发桥，不是操作系统级沙箱。

默认安全行为：

- 公网 tunnel 默认需要私有 CodexPro token。
- 写入限制在配置的工作区 root 内。
- 常见敏感路径会被拒绝：`.env`、私钥、`.git`、`node_modules`、生成目录、缓存目录。
- symlink 逃逸会被阻止。
- safe bash 只允许常见检查、搜索、git、lint、test、typecheck、build 等命令。
- `codexpro start --no-bash` 会完全关闭 ChatGPT 可调用的 bash 工具。
- `execute-handoff` 和 `watch-handoff` 是本地 CLI 命令，不是远程 MCP 工具。

只有在你信任当前仓库和命令时，才考虑更宽的权限，例如 full bash、自定义执行器、额外 allow root。

### Codex 会话边界

CodexPro 不能绑定、读取或复用某一个 Codex App 会话 id。MCP 里的 session id 只是 ChatGPT 和 CodexPro HTTP 服务器之间的传输会话，不代表 Codex 里的某个聊天或终端会话。

`bash` 工具属于你启动的 CodexPro 本地服务器进程，并在配置的 workspace root 下运行。想并行处理另一个任务时，请为另一个仓库、端口或 tunnel profile 启动单独的 CodexPro；不要把它理解成“远程控制当前 Codex 会话”。

如果要减少误触发，可以给这个本地 CodexPro 进程设置 bash session guard：

```bash
codexpro start --bash-session main --require-bash-session
```

这不是 Codex App 聊天会话 id，而是 CodexPro 本地 bash 工具的显式匹配标签。

bash 结果默认使用紧凑 transcript，避免 ChatGPT 对话里突然铺开大段 stdout/stderr。完整 stdout/stderr 仍在结构化工具数据里，CodexPro 卡片里的输出预览默认折叠。需要旧行为时可以显式打开：

```bash
codexpro start --bash-transcript full
```

CodexPro 也可以在 full tools 下显式开启只读的本地 Codex 会话列表：

```bash
codexpro start --tool-mode full --codex-sessions metadata
codexpro start --tool-mode full --codex-sessions read
```

`metadata` 会增加 `codex_sessions` 工具，从 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 读取本地 JSONL 历史，列出 session id、标题、cwd、来源文件和 `codex resume <session-id>` 命令。`read` 还会增加 `read_codex_session`，用于有限长度的 transcript 读取。它类似本地 session manager 扫描 Codex 历史文件，但仍然不会附加到正在运行的 Codex App 聊天，也不会在那个会话里执行命令或绕过产品限制。

如果 Codex 历史不在默认位置，可以用 `--codex-dir <dir>`。

如果只想让 ChatGPT 规划、由你本地决定是否执行：

```bash
codexpro start --mode handoff --no-bash
```

## 常用命令

```bash
codexpro setup
codexpro start
codexpro doctor
codexpro settings
codexpro settings list
codexpro settings set --tunnel ngrok --hostname your-name.ngrok-free.dev
codexpro settings delete --yes
codexpro pro-bundle --copy
codexpro execute-handoff --agent opencode --model provider/model --dry-run
codexpro watch-handoff --agent opencode --model provider/model --yes
```

终端控制键：

```text
Enter  打开 ChatGPT connector 设置
c      再次复制 Server URL
o      打开本地 admin dashboard
h      显示帮助
q      停止 CodexPro
```

本地 admin dashboard 是带 token 保护的 setup/settings 页面。它会显示当前 workspace、local MCP endpoint、安全模式、安装/启动命令、ChatGPT 连接步骤、saved profile 设置和 allowed roots。

页面也提供 GitHub、npm、docs 链接，以及 global install、guided setup、daily start、source checkout setup 和高级重启命令的复制按钮。它能修改下一次启动使用的 saved profile：tunnel provider、public hostname、port、mode、bash mode、transcript、Codex session 模式、write mode、tool mode、widget origin 和 tunnel config 路径。修改后需要重新运行 `codexpro start` 才会生效。

浏览器 admin 页面只负责 setup/settings/status 和 MCP endpoint；不能切换 ChatGPT 账号，不能直接保存原始 Cloudflare tunnel token，也不能把 CodexPro 作为后台服务开关。Cloudflare dashboard-managed tunnel 请把 token 放在本地文件里，再填写 Cloudflare token file。

## FAQ

中文常见问题见 [FAQ_ZH.md](FAQ_ZH.md)。

核心结论：

- 需要 ChatGPT Plus 或 Pro，并且账号要能访问 Apps / Developer Mode。
- Free / Go 在当前测试中不支持这个 App 创建流程。
- CodexPro 不绕过任何速率限制。
- 某些 Pro / planning 模型界面不能直接连接 MCP 工具，使用 `pro-bundle` 作为上下文回退。
- quick tunnel 每次重启 URL 会变。
- 想每天同一个 URL，用 ngrok free dev domain 或 Cloudflare named tunnel。

## 开源与贡献

项目地址：[github.com/zhouyi-xiaoxiao/pro-agent-bridge](https://github.com/zhouyi-xiaoxiao/pro-agent-bridge)

欢迎提 issue、补文档、补平台兼容性、补测试。提交 PR 前请至少运行：

```bash
npm run build
npm run smoke
npm audit --omit=dev
```

如果 CodexPro 对你有用，请到上游仓库 [rebel0789/codexpro](https://github.com/rebel0789/codexpro) 点星。
