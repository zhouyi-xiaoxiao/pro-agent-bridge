import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { WorkspaceManager, PathGuard, CodexProError, type Workspace } from "./guard.js";
import { repoTree, readTextFile, writeTextFile, editTextFile, ensureAiBridge } from "./fsOps.js";
import { searchWorkspace } from "./searchOps.js";
import { runBash } from "./bashOps.js";
import { gitDiff, gitLog, gitStatus } from "./gitOps.js";
import { readAiBridgeContext, readCodexContext, workspaceSummary } from "./workspaceOps.js";
import { buildProContext, exportProContext } from "./proContext.js";
import { codexproInventory, loadSkill } from "./capabilitiesOps.js";
import { listCodexSessions, readCodexSession } from "./codexSessions.js";
import { TOOL_CARD_LEGACY_URIS, TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, toolCardWidgetHtml } from "./toolCardWidget.js";
import { redactSensitiveText, redactStructured } from "./redact.js";

function errorText(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(`${error.name}: ${error.message}`);
  return redactSensitiveText(String(error));
}

function textResult(text: string, structuredContent: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): any {
  return {
    content: [{ type: "text", text: redactSensitiveText(text) }],
    structuredContent: redactStructured(structuredContent),
    _meta: meta
  };
}

function countTextLines(value: string | undefined): number {
  if (!value) return 0;
  return value.split(/\r?\n/).filter((line) => line.length > 0).length;
}

function bashTextResult(config: CodexProConfig, result: Awaited<ReturnType<typeof runBash>>): string {
  if (config.bashTranscript === "full") {
    return `# Bash\n\n\`\`\`bash\n$ ${result.command}\n\`\`\`\n\nCWD: ${result.cwd}\nExit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}\nDuration: ${result.durationMs} ms\n\n## stdout\n\n\`\`\`text\n${result.stdout || ""}\n\`\`\`\n\n## stderr\n\n\`\`\`text\n${result.stderr || ""}\n\`\`\``;
  }

  const stdoutLines = countTextLines(result.stdout);
  const stderrLines = countTextLines(result.stderr);
  return [
    "# Bash",
    "",
    `\`${result.command}\``,
    "",
    `CWD: ${result.cwd}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    `Duration: ${result.durationMs} ms`,
    `Output: stdout ${stdoutLines} line${stdoutLines === 1 ? "" : "s"}, stderr ${stderrLines} line${stderrLines === 1 ? "" : "s"}.`,
    "",
    "Raw stdout/stderr are in the structured CodexPro card. Start with `--bash-transcript full` to print raw output in chat."
  ].join("\n");
}

function errorResult(error: unknown): any {
  return {
    isError: true,
    content: [{ type: "text", text: errorText(error) }],
    structuredContent: { error: errorText(error) }
  };
}

function tagToolResult(result: any, name: string, options: Record<string, unknown>): any {
  if (!result || typeof result !== "object") return result;
  const structured = result.structuredContent;
  const base =
    structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured
      : {};
  result.structuredContent = {
    codexpro_tool: name,
    codexpro_title: options.title ?? name,
    ...base
  };
  return result;
}

function toolCardMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: TOOL_CARD_URI },
    "openai/outputTemplate": TOOL_CARD_URI
  };
}

const OPTIONAL_TOOL_CARD_META = [
  "ui",
  "openai/outputTemplate",
  "openai/toolInvocation/invoking",
  "openai/toolInvocation/invoked"
] as const;

function descriptorOptionsForConfig(config: CodexProConfig, options: Record<string, unknown>): Record<string, unknown> {
  if (config.toolCards) return options;
  const meta = { ...((options._meta as Record<string, unknown> | undefined) ?? {}) };
  for (const key of OPTIONAL_TOOL_CARD_META) delete meta[key];
  return { ...options, _meta: meta };
}

function toolCallLoggingEnabled(): boolean {
  return process.env.CODEXPRO_LOG_TOOL_CALLS === "1" || process.env.CODEXPRO_LOG_REQUESTS === "1";
}

function logToolCall(name: string, status: "ok" | "error", started: number): void {
  if (!toolCallLoggingEnabled()) return;
  console.error(`[CodexProTool] ${name} ${status} ${Date.now() - started}ms`);
}

function registerToolCardResource(server: McpServer, config: CodexProConfig): void {
  const s = server as any;
  if (typeof s.registerResource !== "function") {
    throw new Error("Unsupported MCP SDK: CodexPro widgets require registerResource.");
  }

  const registerUri = (uri: string, name: string): void => {
    s.registerResource(
      name,
      uri,
      {
        title: "CodexPro Tool Card",
        description: "Compact visual renderer for CodexPro workspace orientation, source changes, and handoffs.",
        mimeType: TOOL_CARD_MIME_TYPE
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: TOOL_CARD_MIME_TYPE,
            text: toolCardWidgetHtml,
            _meta: {
              ui: {
                prefersBorder: true,
                domain: config.widgetDomain,
                csp: {
                  connectDomains: [],
                  resourceDomains: []
                }
              },
              "openai/widgetDescription": "Renders CodexPro workspace orientation, diagnostics, file diffs, change reviews, terminal checks, Pro context exports, and handoff plans as compact developer cards with bounded previews.",
              "openai/widgetPrefersBorder": true,
              "openai/widgetDomain": config.widgetDomain,
              "openai/widgetCSP": {
                connect_domains: [],
                resource_domains: []
              }
            }
          }
        ]
      })
    );
  };

  registerUri(TOOL_CARD_URI, "codexpro-tool-card");
  for (const legacyUri of TOOL_CARD_LEGACY_URIS) {
    registerUri(legacyUri, `codexpro-tool-card-${legacyUri.match(/v\d+/)?.[0] ?? "legacy"}`);
  }
}


function isContextPath(config: CodexProConfig, relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  const contextDir = config.contextDir.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === contextDir || normalized.startsWith(`${contextDir}/`);
}

function assertWriteToolAllowed(config: CodexProConfig, relPath: string): void {
  if (config.writeMode === "workspace") return;
  if (config.writeMode === "handoff" && isContextPath(config, relPath)) return;
  if (config.writeMode === "handoff") {
    throw new CodexProError(
      `Source writes are disabled because CODEXPRO_WRITE_MODE=handoff. ` +
        `Use handoff_to_agent or handoff_to_codex, or write/edit only inside ${config.contextDir}/.`
    );
  }
  throw new CodexProError("write/edit tools are disabled because CODEXPRO_WRITE_MODE=off. handoff_to_agent and handoff_to_codex are still available for planning.");
}

function registerToolCompat(
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: any) => Promise<any> | any
): void {
  const wrapped = async (args: any) => {
    const started = Date.now();
    try {
      const result = tagToolResult(await handler(args ?? {}), name, options);
      logToolCall(name, result?.isError ? "error" : "ok", started);
      return result;
    } catch (error) {
      const result = tagToolResult(errorResult(error), name, options);
      logToolCall(name, "error", started);
      return result;
    }
  };

  const securitySchemes = [{ type: "noauth" }];
  const fullOptions: Record<string, unknown> = {
    securitySchemes,
    ...options,
    _meta: {
      securitySchemes,
      ...(options._meta as Record<string, unknown> | undefined)
    }
  };

  const s = server as any;
  if (typeof s.registerTool === "function") {
    s.registerTool(name, fullOptions, wrapped);
    return;
  }

  if (typeof s.tool === "function") {
    s.tool(name, (fullOptions.description as string | undefined) ?? name, fullOptions.inputSchema ?? {}, wrapped);
    return;
  }

  throw new Error("Unsupported MCP SDK: McpServer has neither registerTool nor tool.");
}

const MINIMAL_TOOL_NAMES = [
  "server_config",
  "codexpro_self_test",
  "open_current_workspace",
  "open_workspace",
  "read",
  "write",
  "edit",
  "bash",
  "show_changes"
] as const;

const STANDARD_TOOL_NAMES = [
  ...MINIMAL_TOOL_NAMES,
  "tree",
  "search",
  "load_skill",
  "read_project_context",
  "search_project_memory",
  "save_chat_summary",
  "save_chat_session",
  "list_saved_chat_sessions",
  "read_saved_chat_session",
  "write_detailed_solution",
  "read_handoff",
  "export_pro_context",
  "handoff_to_agent",
  "handoff_to_claude_code",
  "handoff_poll"
] as const;

const FULL_TOOL_NAMES = [
  "server_config",
  "codexpro_self_test",
  "codexpro_inventory",
  "load_skill",
  "list_workspaces",
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "tree",
  "search",
  "read",
  "write",
  "edit",
  "bash",
  "git_status",
  "git_diff",
  "show_changes",
  "read_project_context",
  "search_project_memory",
  "save_chat_summary",
  "save_chat_session",
  "list_saved_chat_sessions",
  "read_saved_chat_session",
  "write_detailed_solution",
  "read_handoff",
  "codex_context",
  "export_pro_context",
  "handoff_to_agent",
  "handoff_to_claude_code",
  "handoff_poll",
  "handoff_to_codex"
] as const;

function codexSessionToolNames(config: CodexProConfig): string[] {
  if (config.codexSessions === "off") return [];
  return config.codexSessions === "read"
    ? ["codex_sessions", "read_codex_session"]
    : ["codex_sessions"];
}

function toolNamesForMode(config: CodexProConfig): string[] {
  const names: string[] =
    config.toolMode === "full"
      ? [...FULL_TOOL_NAMES]
      : config.toolMode === "minimal"
        ? [...MINIMAL_TOOL_NAMES]
        : [...STANDARD_TOOL_NAMES];
  if (config.bashMode === "off") {
    const bashIndex = names.indexOf("bash");
    if (bashIndex !== -1) names.splice(bashIndex, 1);
  }
  if (config.writeMode !== "workspace") {
    for (const writeTool of ["write", "edit"]) {
      const toolIndex = names.indexOf(writeTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  for (const name of codexSessionToolNames(config)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

const MINIMAL_TOOLS = new Set<string>(MINIMAL_TOOL_NAMES);
const STANDARD_TOOLS = new Set<string>(STANDARD_TOOL_NAMES);
const registeredToolNamesByServer = new WeakMap<object, string[]>();

function rememberRegisteredTool(server: McpServer, name: string): void {
  const key = server as object;
  const names = registeredToolNamesByServer.get(key) ?? [];
  if (!registeredToolNamesByServer.has(key)) registeredToolNamesByServer.set(key, names);
  if (!names.includes(name)) names.push(name);
}

function registeredToolNames(server: McpServer): string[] {
  return [...(registeredToolNamesByServer.get(server as object) ?? [])];
}

function shouldRegisterTool(config: CodexProConfig, name: string): boolean {
  if (name === "bash" && config.bashMode === "off") return false;
  if ((name === "write" || name === "edit") && config.writeMode !== "workspace") return false;
  if (name === "codex_sessions") return config.codexSessions !== "off";
  if (name === "read_codex_session") return config.codexSessions === "read";
  if (config.toolMode === "full") return true;
  if (config.toolMode === "minimal") return MINIMAL_TOOLS.has(name);
  return STANDARD_TOOLS.has(name);
}

function registerCodexTool(
  config: CodexProConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: any) => Promise<any> | any
): void {
  if (!shouldRegisterTool(config, name)) return;
  registerToolCompat(server, name, descriptorOptionsForConfig(config, options), handler);
  rememberRegisteredTool(server, name);
}

function serverInstructions(config: CodexProConfig): string {
  const editInstruction =
    config.writeMode === "workspace"
      ? "4. Edit source files with write/edit. After edits, call show_changes once for git status, diff stats, and review diff."
      : config.writeMode === "handoff"
        ? "4. Source writes are disabled and generic write/edit tools are unavailable. Use handoff_to_agent/handoff_to_codex for plans."
        : "4. Write/edit tools are disabled. Do not attempt direct file writes; use handoff or context export workflows instead.";
  const bashInstruction =
    config.bashMode === "off"
      ? "5. Bash is disabled and the bash tool is unavailable. Do not attempt shell commands."
      : "5. Use bash only for meaningful verification commands such as npm test, npm run build, lint, typecheck, or an existing project script.";

  return [
    "CodexPro connects ChatGPT to one local development workspace.",
    "",
    "Preferred workflow:",
    "1. Start with open_current_workspace. Use open_workspace only when the user gives a different root or asks to switch folders.",
    "2. Follow any AGENTS.md-style instructions returned by the workspace open call before editing files.",
    "3. Inspect with tree, search, and read. Do not use bash for git status, git diff, cat, sed, grep, rg, find, ls, or file reading.",
    editInstruction,
    bashInstruction,
    "6. Keep tool calls minimal. Prefer one targeted search plus show_changes instead of repeated broad inspection calls.",
    config.codexSessions !== "off"
      ? `7. Codex session history access is enabled in ${config.codexSessions} mode. Use it only when the user asks for local Codex session history.`
      : "",
    config.requireBashSession && config.bashSessionId
      ? `8. Bash session guard is enabled. Every bash call must include session_id="${config.bashSessionId}".`
      : config.bashSessionId
        ? `8. Bash session label for this server is "${config.bashSessionId}".`
        : "",
    "",
    `Current modes: tool=${config.toolMode}, bash=${config.bashMode}, write=${config.writeMode}.`
  ].filter(Boolean).join("\n");
}

function limitInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function diffBlock(diff: string): string {
  return `\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

function diffStats(diff: string): { additions: number; deletions: number; changed: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions, changed: Boolean(diff.trim()) };
}

function normalizeGitOutput(output: string): string {
  return output.trim() === "(no output)" ? "" : output;
}

function looksLikeGitError(output: string): boolean {
  const trimmed = output.trim();
  const lower = trimmed.toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    lower.includes("not a git repository")
  );
}

function previewText(value: string, maxLines = 40, maxChars = 12_000): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n").slice(0, maxLines).join("\n");
  return lines.length > maxChars ? `${lines.slice(0, maxChars)}\n...[preview truncated]` : lines;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, Math.max(0, maxChars))}\n...[truncated]`, truncated: true };
}

function normalizeList(value: unknown, maxItems = 80): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function bulletList(items: string[], fallback = "- None specified."): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : fallback;
}

function numberedList(items: string[], fallback = "1. No steps specified."): string {
  return items.length ? items.map((item, index) => `${index + 1}. ${item}`).join("\n") : fallback;
}

async function readOptionalWorkspaceFile(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  relPath: string,
  maxBytes = config.maxReadBytes
): Promise<string> {
  try {
    return await readRawTextFileBounded(config, guard, workspace, relPath, maxBytes);
  } catch (error) {
    if (error instanceof CodexProError) return "";
    throw error;
  }
}

async function appendWorkspaceJsonl(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  relPath: string,
  event: Record<string, unknown>
): Promise<void> {
  const resolved = guard.resolve(workspace, relPath, { forWrite: true });
  await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  await fsp.appendFile(resolved.absPath, `${JSON.stringify(event)}\n`, "utf8");
}

function parseJsonl(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed);
    } catch {
      // Ignore malformed legacy lines; search still covers markdown files.
    }
  }
  return rows;
}

function normalizeSessionProvider(value: unknown): string {
  const provider = cleanOneLine(value, "chatgpt", 40).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return provider || "chatgpt";
}

function normalizeChatSessionId(value: unknown, seed: string): string {
  const raw = String(value ?? "").trim();
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  if (cleaned && cleaned !== "." && cleaned !== ".." && !cleaned.includes("..")) return cleaned;
  return `session-${sha256Hex(seed).slice(0, 16)}`;
}

function normalizeChatRole(value: unknown): string {
  const role = cleanOneLine(value, "unknown", 32).toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(role) ? role : "unknown";
}

function normalizeChatTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

type SavedChatSessionMessage = {
  type: "message";
  index: number;
  role: string;
  content: string;
  ts?: string;
};

function normalizeChatSessionMessages(args: any): SavedChatSessionMessage[] {
  const messages: SavedChatSessionMessage[] = [];
  const rawMessages = Array.isArray(args.messages) ? args.messages : [];
  for (const item of rawMessages) {
    if (!item || typeof item !== "object") continue;
    const content = String((item as { content?: unknown }).content ?? "").trim();
    if (!content) continue;
    messages.push({
      type: "message",
      index: messages.length,
      role: normalizeChatRole((item as { role?: unknown }).role),
      content,
      ...(normalizeChatTimestamp((item as { ts?: unknown; timestamp?: unknown }).ts ?? (item as { timestamp?: unknown }).timestamp)
        ? { ts: normalizeChatTimestamp((item as { ts?: unknown; timestamp?: unknown }).ts ?? (item as { timestamp?: unknown }).timestamp) }
        : {})
    });
    if (messages.length >= 500) break;
  }

  const transcript = String(args.transcript ?? "").trim();
  if (!messages.length && transcript) {
    messages.push({ type: "message", index: 0, role: "transcript", content: transcript });
  }
  if (!messages.length) throw new CodexProError("messages or transcript must contain at least one non-empty item.");
  return messages;
}

function chatSessionFilePath(config: CodexProConfig, provider: string, sessionId: string): string {
  return `${config.contextDir}/chat-sessions/${provider}-${sessionId}.jsonl`;
}

function chatSessionIndexPath(config: CodexProConfig): string {
  return `${config.contextDir}/chat-session-index.jsonl`;
}

function sessionDisplayTitle(value: unknown, fallback: string): string {
  return cleanOneLine(value, fallback, 160);
}

function chatSessionHeader(args: {
  provider: string;
  sessionId: string;
  title: string;
  sourceUrl?: string;
  tags: string[];
  messageCount: number;
}): Record<string, unknown> {
  return {
    type: "session_meta",
    ts: new Date().toISOString(),
    provider: args.provider,
    session_id: args.sessionId,
    title: args.title,
    source_url: args.sourceUrl,
    tags: args.tags,
    message_count: args.messageCount
  };
}

function formatSavedChatSessionText(meta: Record<string, unknown>, messages: SavedChatSessionMessage[], truncated: boolean): string {
  const transcript = messages.map((message) => {
    const when = message.ts ? ` ${message.ts}` : "";
    return `### ${message.role}${when}\n\n${message.content}`;
  }).join("\n\n");
  return [
    "# Saved Chat Session",
    "",
    `Provider: ${meta.provider ?? "unknown"}`,
    `Session: ${meta.session_id ?? "unknown"}`,
    meta.title ? `Title: ${meta.title}` : "",
    meta.source_url ? `Source: ${meta.source_url}` : "",
    truncated ? "Transcript truncated by configured limits." : "",
    "",
    "## Transcript",
    "",
    transcript || "No readable transcript messages found."
  ].filter((line) => line !== "").join("\n");
}

function parseSavedChatSession(text: string, maxMessages: number, maxTotalBytes: number): {
  meta: Record<string, unknown>;
  messages: SavedChatSessionMessage[];
  truncated: boolean;
  totalMessages: number;
} {
  let meta: Record<string, unknown> = {};
  const messages: SavedChatSessionMessage[] = [];
  let totalMessages = 0;
  let usedBytes = 0;
  let truncated = false;
  for (const row of parseJsonl(text)) {
    if (row.type === "session_meta") {
      meta = row;
      continue;
    }
    if (row.type !== "message") continue;
    totalMessages += 1;
    const content = String(row.content ?? "");
    const nextBytes = Buffer.byteLength(content, "utf8");
    if (messages.length >= maxMessages || usedBytes + nextBytes > maxTotalBytes) {
      truncated = true;
      continue;
    }
    usedBytes += nextBytes;
    messages.push({
      type: "message",
      index: Number(row.index ?? messages.length),
      role: normalizeChatRole(row.role),
      content,
      ...(typeof row.ts === "string" ? { ts: row.ts } : {})
    });
  }
  return { meta, messages, truncated, totalMessages };
}

async function readChatSessionIndex(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<Record<string, unknown>[]> {
  const raw = await readOptionalWorkspaceFile(config, guard, workspace, chatSessionIndexPath(config), 500_000);
  return parseJsonl(raw);
}

async function resolveSavedChatSessionPath(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  sessionId: string,
  provider?: string
): Promise<{ relPath: string; provider: string }> {
  const wantedProvider = provider ? normalizeSessionProvider(provider) : "";
  const index = await readChatSessionIndex(config, guard, workspace);
  const match = [...index].reverse().find((row) => {
    if (String(row.session_id ?? "") !== sessionId) return false;
    if (wantedProvider && String(row.provider ?? "") !== wantedProvider) return false;
    return typeof row.path === "string" && row.path;
  });
  if (match) {
    const relPath = String(match.path);
    const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const sessionDir = `${config.contextDir.replace(/^\.\//, "").replace(/\/+$/, "")}/chat-sessions/`;
    if (!normalized.startsWith(sessionDir) || normalized.includes("../")) {
      throw new CodexProError("Saved chat session index path is outside .ai-bridge/chat-sessions.");
    }
    return { relPath: normalized, provider: String(match.provider ?? (wantedProvider || "chatgpt")) };
  }
  const resolvedProvider = wantedProvider || "chatgpt";
  return { relPath: chatSessionFilePath(config, resolvedProvider, normalizeChatSessionId(sessionId, sessionId)), provider: resolvedProvider };
}

function formatProjectContext(summary: string, decisions: string[], todos: string[], links: string[]): string {
  return [
    "# Project Context",
    "",
    `Updated: ${new Date().toISOString()}`,
    "",
    "## Current Summary",
    "",
    summary.trim() || "No summary saved yet.",
    "",
    "## Stable Decisions",
    "",
    bulletList(decisions),
    "",
    "## Open Todos",
    "",
    bulletList(todos),
    "",
    "## Useful Links Or Handles",
    "",
    bulletList(links)
  ].join("\n");
}

function buildDetailedSolutionMarkdown(options: {
  title: string;
  objective: string;
  nonGoals: string[];
  systemUnderstanding: string;
  evidence: string[];
  recommendedApproach: string;
  alternatives: string[];
  implementationSteps: string[];
  filesToChange: string[];
  validation: string[];
  risks: string[];
  rollback: string[];
  handoffPrompt: string;
}): string {
  return [
    `# ${options.title}`,
    "",
    `Updated: ${new Date().toISOString()}`,
    "",
    "## Objective",
    "",
    options.objective.trim() || "No objective supplied.",
    "",
    "## Non Goals",
    "",
    bulletList(options.nonGoals),
    "",
    "## Current System Understanding",
    "",
    options.systemUnderstanding.trim() || "No system understanding supplied.",
    "",
    "## Evidence And Context",
    "",
    bulletList(options.evidence),
    "",
    "## Recommended Approach",
    "",
    options.recommendedApproach.trim() || "No recommended approach supplied.",
    "",
    "## Alternatives Considered",
    "",
    bulletList(options.alternatives),
    "",
    "## Implementation Steps",
    "",
    numberedList(options.implementationSteps),
    "",
    "## Files To Change Or Inspect",
    "",
    bulletList(options.filesToChange),
    "",
    "## Validation Plan",
    "",
    bulletList(options.validation),
    "",
    "## Risks",
    "",
    bulletList(options.risks),
    "",
    "## Rollback Plan",
    "",
    bulletList(options.rollback),
    "",
    "## Executor Handoff Prompt",
    "",
    "```text",
    options.handoffPrompt.trim() || "Read this solution plan, implement in small steps, run validation, and report changes.",
    "```",
    ""
  ].join("\n");
}

function buildChecklistMarkdown(title: string, steps: string[], validation: string[]): string {
  return [
    `# ${title} Checklist`,
    "",
    `Updated: ${new Date().toISOString()}`,
    "",
    "## Implementation",
    "",
    steps.length ? steps.map((step) => `- [ ] ${step}`).join("\n") : "- [ ] No implementation steps specified.",
    "",
    "## Validation",
    "",
    validation.length ? validation.map((step) => `- [ ] ${step}`).join("\n") : "- [ ] No validation steps specified.",
    ""
  ].join("\n");
}

function buildReviewCriteriaMarkdown(title: string, validation: string[], risks: string[]): string {
  return [
    `# ${title} Review Criteria`,
    "",
    `Updated: ${new Date().toISOString()}`,
    "",
    "## Must Pass",
    "",
    validation.length ? validation.map((step) => `- ${step}`).join("\n") : "- Review final diff for correctness and scope.",
    "",
    "## Watch Closely",
    "",
    risks.length ? risks.map((risk) => `- ${risk}`).join("\n") : "- No explicit risks supplied.",
    ""
  ].join("\n");
}

async function readHandoffRunState(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<Record<string, unknown>> {
  const candidates = [
    `${config.contextDir}/handoff-run-state.json`,
    `${config.contextDir}/watch-handoff-state.json`,
    `${config.contextDir}/loop-handoff-state.json`
  ];
  for (const candidate of candidates) {
    const raw = await readOptionalWorkspaceFile(config, guard, workspace, candidate, 100_000);
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...parsed, state_file: candidate };
      }
    } catch {
      return { state: "state_parse_error", state_file: candidate };
    }
  }
  return {};
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function changedStatusLines(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("##"));
}

function jsonlEvent(event: string, data: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
}

function cleanOneLine(value: unknown, fallback: string, maxLength = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

function normalizeAgentId(value: unknown): string {
  const agent = cleanOneLine(value, "custom", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent)) {
    throw new CodexProError("agent must use only lowercase letters, numbers, dots, underscores, or hyphens.");
  }
  return agent;
}

function displayAgentName(agent: string, agentName?: unknown): string {
  const explicit = cleanOneLine(agentName, "", 80);
  if (explicit) return explicit;
  if (agent === "codex") return "Codex";
  if (agent === "opencode") return "OpenCode";
  if (agent === "pi") return "Pi";
  return agent;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function agentCommandHint(agent: string, planPath: string, model?: string): string {
  const modelArg = model ? ` --model ${shellQuote(model)}` : " --model '<provider/model>'";
  const quotedPlanPath = shellQuote(planPath);
  if (agent === "opencode") return `opencode run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "pi") return `pi run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "codex") return `Read ${planPath} and execute it in small, reviewable steps.`;
  if (agent === "claude-code" || agent === "claude") return `codexpro watch-handoff --agent claude-code --yes`;
  return `Run your local implementation agent manually with ${planPath} as the task input.`;
}

async function readRawTextFileBounded(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath: string, maxBytes = config.maxReadBytes): Promise<string> {
  const resolved = guard.resolve(workspace, filePath);
  await guard.assertTextFile(resolved.absPath, Math.min(maxBytes, config.maxReadBytes));
  return fsp.readFile(resolved.absPath, "utf8");
}

function buildAgentPlanBody(options: {
  title: string;
  plan: string;
  workspace: Workspace;
  agent: string;
  agentName: string;
  model?: string;
  statusPath: string;
  diffPath: string;
  executionLogPath: string;
}): string {
  const modelLine = options.model ? `Model: ${options.model}\n` : "";
  return `# ${options.title}

Updated: ${new Date().toISOString()}
Workspace: ${options.workspace.root}
Target agent: ${options.agentName} (${options.agent})
${modelLine}
## Plan

${options.plan.trim()}

## Implementation contract

- Work from this plan in small, reviewable steps.
- Keep edits scoped to the requested task and existing project conventions.
- Run focused verification before handing work back.
- Update ${options.statusPath} with files touched, checks run, results, blockers, and review notes.
- Save the final review diff to ${options.diffPath} when practical.
- Append notable execution events to ${options.executionLogPath} when the implementation agent supports logging.
`;
}

async function writeAgentHandoff(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    agent: string;
    agentName?: string;
    model?: string;
    title: string;
    plan: string;
    append: boolean;
    eventName: string;
  }
): Promise<{
  agent: string;
  agentName: string;
  model?: string;
  title: string;
  planPath: string;
  statusPath: string;
  diffPath: string;
  logPath: string;
  executionLogPath: string;
  prompt: string;
  writeResult: Awaited<ReturnType<typeof writeTextFile>>;
}> {
  await ensureAiBridge(config, guard, workspace);
  const agent = normalizeAgentId(options.agent);
  const agentName = displayAgentName(agent, options.agentName);
  const model = options.model ? cleanOneLine(options.model, "", 120) : undefined;
  const plan = String(options.plan ?? "").trim();
  if (!plan) throw new CodexProError("plan must not be empty.");
  const planPath = `${config.contextDir}/current-plan.md`;
  const statusPath = `${config.contextDir}/agent-status.md`;
  const legacyCodexStatusPath = `${config.contextDir}/codex-status.md`;
  const diffPath = `${config.contextDir}/implementation-diff.patch`;
  const logPath = `${config.contextDir}/session-log.jsonl`;
  const executionLogPath = `${config.contextDir}/execution-log.jsonl`;
  const body = buildAgentPlanBody({
    title: options.title,
    plan,
    workspace,
    agent,
    agentName,
    model,
    statusPath,
    diffPath,
    executionLogPath
  });

  let content = body;
  if (options.append) {
    const raw = await readRawTextFileBounded(config, guard, workspace, planPath);
    content = `${raw.trimEnd()}\n\n---\n\n${body}`;
  }

  const writeResult = await writeTextFile(config, guard, workspace, planPath, content, { createDirs: true, overwrite: true });
  const event = {
    agent,
    agent_name: agentName,
    model,
    title: options.title,
    plan_path: planPath,
    status_path: statusPath,
    diff_path: diffPath
  };
  const logResolved = guard.resolve(workspace, logPath, { forWrite: true });
  const executionLogResolved = guard.resolve(workspace, executionLogPath, { forWrite: true });
  await fsp.appendFile(logResolved.absPath, jsonlEvent(options.eventName, event), "utf8");
  await fsp.appendFile(executionLogResolved.absPath, jsonlEvent(options.eventName, event), "utf8");

  const promptLines = [
    `Read ${planPath} and execute it in small, reviewable steps.`,
    `After each meaningful change, update ${statusPath} with files touched, checks run, results, blockers, and the next review focus.`,
    `Before review, write the final diff to ${diffPath} when practical.`,
    agentCommandHint(agent, planPath, model)
  ];
  if (agent === "codex") {
    promptLines.splice(2, 0, `For legacy Codex handoffs, mirror key status notes to ${legacyCodexStatusPath} if your workflow expects that file.`);
  }
  const prompt = promptLines.join("\n");

  return {
    agent,
    agentName,
    model,
    title: options.title,
    planPath,
    statusPath,
    diffPath,
    logPath,
    executionLogPath,
    prompt,
    writeResult
  };
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const SESSION_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const LOCAL_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false };
const BASH_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false };
const HANDOFF_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false };

const workspaceManagers = new Map<string, WorkspaceManager>();

function workspaceManagerKey(config: CodexProConfig): string {
  return JSON.stringify({
    defaultRoot: config.defaultRoot,
    allowedRoots: [...config.allowedRoots].sort(),
    contextDir: config.contextDir
  });
}

function getSharedWorkspaceManager(config: CodexProConfig): WorkspaceManager {
  const key = workspaceManagerKey(config);
  const existing = workspaceManagers.get(key);
  if (existing) return existing;
  const manager = new WorkspaceManager(config);
  workspaceManagers.set(key, manager);
  return manager;
}

export function createCodexProServer(config: CodexProConfig): McpServer {
  const workspaces = getSharedWorkspaceManager(config);
  const guard = new PathGuard(config);
  const server = new McpServer({ name: "CodexPro", version: "0.28.5" }, { instructions: serverInstructions(config) });
  registeredToolNamesByServer.set(server as object, []);
  registerToolCardResource(server, config);

  registerCodexTool(
    config,
    server,
    "read_project_context",
    {
      title: "Read Project Context",
      description:
        "Read durable project bridge context for ChatGPT Pro planning: project-context.md, solution plan, checklist, review criteria, current handoff, agent status, and recent saved chat-memory rows.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_chat_memory: z.boolean().optional().describe("Include recent saved chat memory rows. Default: true."),
        max_chat_rows: z.number().int().min(1).max(80).optional().describe("Maximum chat-memory rows to include. Default: 12."),
        max_chars: z.number().int().min(4000).max(120000).optional().describe("Maximum response characters. Default: 40000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading project context...",
        "openai/toolInvocation/invoked": "Project context ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const maxChars = limitInt(args.max_chars, 40_000, 4_000, 120_000);
      const files = [
        `${config.contextDir}/project-context.md`,
        `${config.contextDir}/chat-session-index.jsonl`,
        `${config.contextDir}/solution-plan.md`,
        `${config.contextDir}/implementation-checklist.md`,
        `${config.contextDir}/review-criteria.md`,
        `${config.contextDir}/current-plan.md`,
        `${config.contextDir}/agent-status.md`,
        `${config.contextDir}/implementation-diff.patch`,
        `${config.contextDir}/execution-log.jsonl`
      ];
      const sections: string[] = ["# Project Context Bundle", "", `Workspace: ${workspace.root}`, ""];
      const includedFiles: string[] = [];
      for (const file of files) {
        const raw = await readOptionalWorkspaceFile(config, guard, workspace, file, 80_000);
        if (!raw.trim()) continue;
        const preview = truncateText(raw, file.endsWith(".patch") || file.endsWith(".jsonl") ? 12_000 : 20_000);
        sections.push(`## ${file}`, "", "```text", preview.text, "```", "");
        includedFiles.push(file);
      }

      const chatRows: Record<string, unknown>[] = [];
      if (parseBool(args.include_chat_memory, true)) {
        const raw = await readOptionalWorkspaceFile(config, guard, workspace, `${config.contextDir}/chat-memory.jsonl`, 250_000);
        chatRows.push(...parseJsonl(raw).slice(-limitInt(args.max_chat_rows, 12, 1, 80)));
        if (chatRows.length) {
          sections.push("## Recent Chat Memory", "", "```json");
          sections.push(JSON.stringify(chatRows, null, 2));
          sections.push("```", "");
          includedFiles.push(`${config.contextDir}/chat-memory.jsonl`);
        }
      }

      const response = truncateText(sections.join("\n"), maxChars);
      return textResult(response.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        files: includedFiles,
        file_count: includedFiles.length,
        chat_memory_rows: chatRows.length,
        truncated: response.truncated
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "search_project_memory",
    {
      title: "Search Project Memory",
      description:
        "Search saved .ai-bridge memory, solution plans, handoffs, and status artifacts. Use this before major planning so ChatGPT Pro can reuse prior decisions.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        query: z.string().describe("Case-insensitive text query."),
        max_results: z.number().int().min(1).max(80).optional().describe("Maximum matching snippets. Default: 12."),
        max_chars_per_result: z.number().int().min(200).max(4000).optional().describe("Maximum characters per result. Default: 1200.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Searching project memory...",
        "openai/toolInvocation/invoked": "Project memory searched"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const query = String(args.query ?? "").trim().toLowerCase();
      if (!query) throw new CodexProError("query must not be empty.");
      const maxResults = limitInt(args.max_results, 12, 1, 80);
      const maxChars = limitInt(args.max_chars_per_result, 1200, 200, 4000);
      const memoryFiles = [
        `${config.contextDir}/project-context.md`,
        `${config.contextDir}/chat-memory.jsonl`,
        `${config.contextDir}/chat-session-index.jsonl`,
        `${config.contextDir}/solution-plan.md`,
        `${config.contextDir}/implementation-checklist.md`,
        `${config.contextDir}/review-criteria.md`,
        `${config.contextDir}/current-plan.md`,
        `${config.contextDir}/agent-status.md`,
        `${config.contextDir}/decisions.md`,
        `${config.contextDir}/open-questions.md`,
        `${config.contextDir}/execution-log.jsonl`
      ];
      const results: Array<{ path: string; line: number; snippet: string }> = [];
      for (const file of memoryFiles) {
        const raw = await readOptionalWorkspaceFile(config, guard, workspace, file, 300_000);
        if (!raw) continue;
        const lines = raw.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].toLowerCase().includes(query)) continue;
          const start = Math.max(0, index - 2);
          const end = Math.min(lines.length, index + 3);
          const snippet = truncateText(lines.slice(start, end).join("\n"), maxChars).text;
          results.push({ path: file, line: index + 1, snippet });
          if (results.length >= maxResults) break;
        }
        if (results.length >= maxResults) break;
      }
      const text = results.length
        ? [
            "# Search Project Memory",
            "",
            `Query: ${args.query}`,
            "",
            ...results.map((result) => `## ${result.path}:${result.line}\n\n\`\`\`text\n${result.snippet}\n\`\`\``)
          ].join("\n")
        : `# Search Project Memory\n\nQuery: ${args.query}\n\nNo saved memory matches.`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        query: args.query,
        results,
        result_count: results.length
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "save_chat_summary",
    {
      title: "Save Chat Summary",
      description:
        "Persist the current ChatGPT Pro conversation summary, decisions, todos, and useful handles into .ai-bridge so future CodexPro/Claude/Codex runs can retrieve them. The model must provide the summary explicitly.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional().describe("Short memory title."),
        summary: z.string().describe("Concise but complete summary of the current conversation or decision."),
        decisions: z.array(z.string()).optional().describe("Stable decisions to preserve."),
        todos: z.array(z.string()).optional().describe("Open follow-up items."),
        links: z.array(z.string()).optional().describe("Useful file paths, thread ids, URLs, commands, or handles."),
        tags: z.array(z.string()).optional().describe("Search tags."),
        update_project_context: z.boolean().optional().describe("Also rewrite .ai-bridge/project-context.md from this summary. Default: true.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Saving chat summary...",
        "openai/toolInvocation/invoked": "Chat summary saved"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      await ensureAiBridge(config, guard, workspace);
      const summary = String(args.summary ?? "").trim();
      if (!summary) throw new CodexProError("summary must not be empty.");
      const decisions = normalizeList(args.decisions);
      const todos = normalizeList(args.todos);
      const links = normalizeList(args.links);
      const tags = normalizeList(args.tags, 40);
      const event = {
        ts: new Date().toISOString(),
        title: cleanOneLine(args.title, "ChatGPT Pro summary"),
        summary,
        decisions,
        todos,
        links,
        tags
      };
      const memoryPath = `${config.contextDir}/chat-memory.jsonl`;
      await appendWorkspaceJsonl(config, guard, workspace, memoryPath, event);
      const written = [memoryPath];
      if (parseBool(args.update_project_context, true)) {
        const projectContext = formatProjectContext(summary, decisions, todos, links);
        await writeTextFile(config, guard, workspace, `${config.contextDir}/project-context.md`, projectContext, {
          createDirs: true,
          overwrite: true
        });
        written.push(`${config.contextDir}/project-context.md`);
      }
      const text = [
        "# Save Chat Summary",
        "",
        `Saved: ${event.title}`,
        `Memory: ${memoryPath}`,
        parseBool(args.update_project_context, true) ? `Project context: ${config.contextDir}/project-context.md` : "Project context not rewritten.",
        "",
        "## Summary",
        "",
        summary
      ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        written,
        event
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "write_detailed_solution",
    {
      title: "Write Detailed Solution",
      description:
        "Write a durable, implementation-ready ChatGPT Pro solution plan plus checklist and review criteria into .ai-bridge. Use before direct implementation or Claude Code handoff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional().describe("Plan title. Default: Detailed solution plan."),
        objective: z.string().describe("What should be accomplished."),
        non_goals: z.array(z.string()).optional().describe("Explicit non-goals or scope exclusions."),
        system_understanding: z.string().optional().describe("Current understanding of the repo/system."),
        evidence: z.array(z.string()).optional().describe("Files, commands, observations, and facts supporting the plan."),
        recommended_approach: z.string().describe("The selected approach."),
        alternatives: z.array(z.string()).optional().describe("Alternatives considered and why they were not selected."),
        implementation_steps: z.array(z.string()).describe("Concrete ordered implementation steps."),
        files_to_change: z.array(z.string()).optional().describe("Expected files to inspect or edit."),
        validation: z.array(z.string()).optional().describe("Commands/checks/manual verification to run."),
        risks: z.array(z.string()).optional().describe("Risks, edge cases, and things to inspect during review."),
        rollback: z.array(z.string()).optional().describe("Rollback or recovery steps."),
        handoff_prompt: z.string().optional().describe("Executor-facing prompt for Claude Code/Codex/local agents."),
        also_write_current_plan: z.boolean().optional().describe("Also write .ai-bridge/current-plan.md. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing detailed solution...",
        "openai/toolInvocation/invoked": "Detailed solution written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      await ensureAiBridge(config, guard, workspace);
      const title = cleanOneLine(args.title, "Detailed solution plan", 120);
      const implementationSteps = normalizeList(args.implementation_steps, 200);
      if (!implementationSteps.length) throw new CodexProError("implementation_steps must contain at least one concrete step.");
      const validation = normalizeList(args.validation, 120);
      const risks = normalizeList(args.risks, 120);
      const plan = buildDetailedSolutionMarkdown({
        title,
        objective: String(args.objective ?? ""),
        nonGoals: normalizeList(args.non_goals),
        systemUnderstanding: String(args.system_understanding ?? ""),
        evidence: normalizeList(args.evidence, 160),
        recommendedApproach: String(args.recommended_approach ?? ""),
        alternatives: normalizeList(args.alternatives, 120),
        implementationSteps,
        filesToChange: normalizeList(args.files_to_change, 200),
        validation,
        risks,
        rollback: normalizeList(args.rollback, 80),
        handoffPrompt: String(args.handoff_prompt ?? "")
      });
      const checklist = buildChecklistMarkdown(title, implementationSteps, validation);
      const reviewCriteria = buildReviewCriteriaMarkdown(title, validation, risks);
      const solution = await writeTextFile(config, guard, workspace, `${config.contextDir}/solution-plan.md`, plan, {
        createDirs: true,
        overwrite: true
      });
      const checklistResult = await writeTextFile(config, guard, workspace, `${config.contextDir}/implementation-checklist.md`, checklist, {
        createDirs: true,
        overwrite: true
      });
      const reviewResult = await writeTextFile(config, guard, workspace, `${config.contextDir}/review-criteria.md`, reviewCriteria, {
        createDirs: true,
        overwrite: true
      });
      const written = [
        solution.path,
        checklistResult.path,
        reviewResult.path
      ];
      if (parseBool(args.also_write_current_plan, false)) {
        const current = await writeTextFile(config, guard, workspace, `${config.contextDir}/current-plan.md`, plan, {
          createDirs: true,
          overwrite: true
        });
        written.push(current.path);
      }
      await appendWorkspaceJsonl(config, guard, workspace, `${config.contextDir}/execution-log.jsonl`, {
        ts: new Date().toISOString(),
        event: "write_detailed_solution",
        title,
        files: written
      });
      const text = [
        "# Write Detailed Solution",
        "",
        `Wrote ${written.join(", ")}.`,
        `Implementation steps: ${implementationSteps.length}`,
        `Validation checks: ${validation.length}`,
        `Risks: ${risks.length}`,
        "",
        "Use handoff_to_claude_code when this solution should be executed by Claude Code, or use write/edit/bash directly when the selected ChatGPT model can use MCP tools."
      ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        written,
        title,
        implementation_step_count: implementationSteps.length,
        validation_count: validation.length,
        risk_count: risks.length,
        solution_sha256: solution.sha256
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "save_chat_session",
    {
      title: "Save Chat Session",
      description:
        "Persist one explicit ChatGPT Pro or other chat session transcript into .ai-bridge/chat-sessions. The model/user must provide the transcript or messages; CodexPro does not scrape ChatGPT web history.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        provider: z.string().optional().describe("Session provider label. Default: chatgpt."),
        session_id: z.string().optional().describe("Stable session id, such as the ChatGPT /c/<id> value. Unsafe characters are normalized."),
        title: z.string().optional().describe("Human-readable session title."),
        source_url: z.string().optional().describe("Optional source URL for the session."),
        tags: z.array(z.string()).optional().describe("Search tags."),
        messages: z.array(z.object({
          role: z.string().optional(),
          content: z.string(),
          ts: z.union([z.string(), z.number()]).optional(),
          timestamp: z.union([z.string(), z.number()]).optional()
        })).optional().describe("Ordered session messages to persist."),
        transcript: z.string().optional().describe("Fallback raw transcript text if structured messages are unavailable."),
        append: z.boolean().optional().describe("Append messages to an existing saved session instead of replacing it. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Saving chat session...",
        "openai/toolInvocation/invoked": "Chat session saved"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      await ensureAiBridge(config, guard, workspace);
      const messages = normalizeChatSessionMessages(args);
      const provider = normalizeSessionProvider(args.provider);
      const seed = JSON.stringify({ provider, title: args.title, sourceUrl: args.source_url, messages: messages.slice(0, 8) });
      const sessionId = normalizeChatSessionId(args.session_id, seed);
      const title = sessionDisplayTitle(args.title, sessionId);
      const sourceUrl = String(args.source_url ?? "").trim() || undefined;
      const tags = normalizeList(args.tags, 60);
      const sessionPath = chatSessionFilePath(config, provider, sessionId);
      const indexPath = chatSessionIndexPath(config);
      const resolved = guard.resolve(workspace, sessionPath, { forWrite: true });
      await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });

      const existing = parseBool(args.append, false)
        ? await readOptionalWorkspaceFile(config, guard, workspace, sessionPath, config.maxWriteBytes)
        : "";
      let startIndex = 0;
      if (existing) {
        const parsed = parseSavedChatSession(existing, 500, config.maxWriteBytes);
        startIndex = parsed.totalMessages;
      }
      const renumbered = messages.map((message, offset) => ({ ...message, index: startIndex + offset }));
      const header = chatSessionHeader({ provider, sessionId, title, sourceUrl, tags, messageCount: startIndex + renumbered.length });
      const bodyRows = [
        ...(existing ? [] : [header]),
        ...renumbered
      ].map((row) => JSON.stringify(row)).join("\n") + "\n";
      const nextSize = Buffer.byteLength(existing, "utf8") + Buffer.byteLength(bodyRows, "utf8");
      if (nextSize > config.maxWriteBytes) {
        throw new CodexProError(`Saved chat session would exceed CODEXPRO_MAX_WRITE_BYTES (${config.maxWriteBytes}).`);
      }
      if (existing) await fsp.appendFile(resolved.absPath, bodyRows, "utf8");
      else await fsp.writeFile(resolved.absPath, bodyRows, "utf8");

      const indexEvent = {
        ts: new Date().toISOString(),
        provider,
        session_id: sessionId,
        title,
        source_url: sourceUrl,
        tags,
        message_count: startIndex + renumbered.length,
        path: sessionPath,
        sha256: sha256Hex(existing + bodyRows)
      };
      await appendWorkspaceJsonl(config, guard, workspace, indexPath, indexEvent);
      const text = [
        "# Save Chat Session",
        "",
        `Provider: ${provider}`,
        `Session: ${sessionId}`,
        `Title: ${title}`,
        `Path: ${sessionPath}`,
        `Messages saved this call: ${renumbered.length}`,
        `Total messages recorded: ${startIndex + renumbered.length}`,
        "",
        "Use read_saved_chat_session with this session_id to retrieve the bounded transcript."
      ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        provider,
        session_id: sessionId,
        title,
        source_url: sourceUrl ?? null,
        path: sessionPath,
        index_path: indexPath,
        messages_saved: renumbered.length,
        message_count: startIndex + renumbered.length,
        appended: Boolean(existing),
        sha256: indexEvent.sha256
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_saved_chat_sessions",
    {
      title: "List Saved Chat Sessions",
      description:
        "List explicit chat sessions saved in .ai-bridge/chat-session-index.jsonl. This is project-local memory, not automatic ChatGPT web history.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        provider: z.string().optional().describe("Optional provider filter, e.g. chatgpt."),
        query: z.string().optional().describe("Optional case-insensitive search over session id, title, URL, tags, and path."),
        max_sessions: z.number().int().min(1).max(200).optional().describe("Maximum sessions to return. Default: 30.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing saved chat sessions...",
        "openai/toolInvocation/invoked": "Saved chat sessions ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const provider = args.provider ? normalizeSessionProvider(args.provider) : "";
      const query = String(args.query ?? "").trim().toLowerCase();
      const maxSessions = limitInt(args.max_sessions, 30, 1, 200);
      const rows = await readChatSessionIndex(config, guard, workspace);
      const latest = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const rowProvider = String(row.provider ?? "");
        const rowSessionId = String(row.session_id ?? "");
        if (!rowProvider || !rowSessionId) continue;
        if (provider && rowProvider !== provider) continue;
        const haystack = [
          row.provider,
          row.session_id,
          row.title,
          row.source_url,
          Array.isArray(row.tags) ? row.tags.join(" ") : "",
          row.path
        ].filter(Boolean).join("\n").toLowerCase();
        if (query && !haystack.includes(query)) continue;
        latest.set(`${rowProvider}:${rowSessionId}`, row);
      }
      const sessions = [...latest.values()]
        .sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")))
        .slice(0, maxSessions);
      const list = sessions.length
        ? sessions.map((row) => `- ${row.provider}:${row.session_id}  ${row.title || "(untitled)"}  messages=${row.message_count ?? "?"}`).join("\n")
        : "- No saved chat sessions found.";
      return textResult(`# Saved Chat Sessions\n\n${list}`, {
        workspace_id: workspace.id,
        root: workspace.root,
        sessions,
        session_count: sessions.length,
        total_index_rows: rows.length
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_saved_chat_session",
    {
      title: "Read Saved Chat Session",
      description:
        "Read one explicit project-local chat session saved by save_chat_session. Requires a session_id; output is bounded by message and byte limits.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        provider: z.string().optional().describe("Optional provider label. If omitted, the saved index is searched first."),
        session_id: z.string().describe("Saved session id returned by save_chat_session or list_saved_chat_sessions."),
        max_messages: z.number().int().min(1).max(500).optional().describe("Maximum messages to return. Default: 120."),
        max_total_bytes: z.number().int().min(4000).max(800000).optional().describe("Maximum transcript bytes to return. Default: 120000.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading saved chat session...",
        "openai/toolInvocation/invoked": "Saved chat session read"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const sessionId = String(args.session_id ?? "").trim();
      if (!sessionId) throw new CodexProError("session_id is required.");
      const { relPath, provider } = await resolveSavedChatSessionPath(config, guard, workspace, sessionId, args.provider);
      const maxMessages = limitInt(args.max_messages, 120, 1, 500);
      const maxTotalBytes = limitInt(args.max_total_bytes, 120_000, 4_000, 800_000);
      const raw = await readRawTextFileBounded(config, guard, workspace, relPath, Math.min(maxTotalBytes * 2, config.maxReadBytes));
      const parsed = parseSavedChatSession(raw, maxMessages, maxTotalBytes);
      if (!parsed.meta.session_id) {
        parsed.meta = {
          type: "session_meta",
          provider,
          session_id: sessionId,
          title: sessionId,
          path: relPath
        };
      }
      const text = formatSavedChatSessionText(parsed.meta, parsed.messages, parsed.truncated);
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        provider: parsed.meta.provider ?? provider,
        session_id: parsed.meta.session_id ?? sessionId,
        title: parsed.meta.title ?? null,
        source_url: parsed.meta.source_url ?? null,
        path: relPath,
        messages: parsed.messages,
        message_count: parsed.messages.length,
        total_messages: parsed.totalMessages,
        truncated: parsed.truncated,
        sha256: sha256Hex(raw)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "server_config",
    {
      title: "Server Config",
      description: "Show CodexPro server configuration, safety modes, limits, and blocked paths. Does not reveal auth tokens.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexPro server config...",
        "openai/toolInvocation/invoked": "CodexPro server config ready"
      }
    },
    async () => {
      const safeConfig = {
        defaultRoot: config.defaultRoot,
        allowedRoots: config.allowedRoots,
        host: config.host,
        port: config.port,
        widgetDomain: config.widgetDomain,
        authEnabled: Boolean(config.authToken),
        bashMode: config.bashMode,
        bashTranscript: config.bashTranscript,
        bashSessionId: config.bashSessionId ?? null,
        requireBashSession: config.requireBashSession,
        codexSessions: config.codexSessions,
        codexDir: config.codexDir,
        writeMode: config.writeMode,
        toolMode: config.toolMode,
        toolCards: config.toolCards,
        inheritEnv: config.inheritEnv,
        contextDir: config.contextDir,
        maxReadBytes: config.maxReadBytes,
        maxWriteBytes: config.maxWriteBytes,
        maxOutputBytes: config.maxOutputBytes,
        maxSearchResults: config.maxSearchResults,
        blockedGlobs: config.blockedGlobs,
        registeredTools: registeredToolNames(server),
        registeredToolCount: registeredToolNames(server).length
      };
      return textResult(`# CodexPro Server Config\n\n${JSON.stringify(safeConfig, null, 2)}`, safeConfig);
    }
  );

  registerCodexTool(
    config,
    server,
    "codexpro_self_test",
    {
      title: "CodexPro Self Test",
      description:
        "Run one controlled, local-only CodexPro diagnostic. It checks modes, expected tools, workspace access, skills, git, safe bash policy, selected-only Pro context, and optional .ai-bridge write/edit without touching source files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        write_probe: z.boolean().optional().describe("Create/edit only .ai-bridge/codexpro-self-test.md. Default: true."),
        bash_probe: z.boolean().optional().describe("Check bash policy with safe local commands only. Default: true."),
        pro_context_probe: z.boolean().optional().describe("Build a selected-only Pro context bundle in memory without writing pro-context.md. Default: true."),
        include_global_skills: z.boolean().optional().describe("Include user/plugin skill discovery in the inventory check. Default: true."),
        max_skills: z.number().int().min(1).max(120).optional().describe("Maximum skills to inspect during the inventory check. Default: 40.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running CodexPro self-test...",
        "openai/toolInvocation/invoked": "CodexPro self-test complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const started = Date.now();
      const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];
      const filesTouched: string[] = [];
      const probePath = `${config.contextDir}/codexpro-self-test.md`;

      const check = (name: string, status: "pass" | "warn" | "fail", detail: string) => {
        checks.push({ name, status, detail: cleanOneLine(detail, detail, 260) });
      };

      check("workspace", "pass", workspace.root);
      check("tool mode", config.toolMode === "full" ? "pass" : "warn", `${config.toolMode}; expected tools: ${toolNamesForMode(config).length}`);
      check("write mode", config.writeMode === "off" ? "warn" : "pass", config.writeMode);
      check("bash mode", config.bashMode === "full" ? "warn" : "pass", config.bashMode);
      check(
        "http auth",
        config.requireHttpToken && !config.authToken ? "fail" : "pass",
        config.requireHttpToken ? "token required for public/non-loopback access" : "loopback token not required"
      );
      const expectedTools = toolNamesForMode(config).sort();
      const actualTools = registeredToolNames(server).sort();
      const missingTools = expectedTools.filter((name) => !actualTools.includes(name));
      const extraTools = actualTools.filter((name) => !expectedTools.includes(name));
      check(
        "registered tool set",
        missingTools.length || extraTools.length ? "fail" : "pass",
        missingTools.length || extraTools.length
          ? `missing: ${missingTools.join(", ") || "none"}; extra: ${extraTools.join(", ") || "none"}`
          : `${actualTools.length} tools registered for ${config.toolMode} mode`
      );

      try {
        const inventory = await codexproInventory(config, workspace, {
          includeGlobalSkills: parseBool(args.include_global_skills, true),
          includeMcpServers: true,
          maxSkills: limitInt(args.max_skills, 40, 1, 120)
        });
        check("inventory", "pass", `${inventory.skills.length} skills inspected, ${inventory.mcpServers.length} MCP server names visible`);
      } catch (error) {
        check("inventory", "fail", errorText(error));
      }

      try {
        const status = gitStatus(config, workspace);
        const gitFailed = looksLikeGitError(status);
        const changed = gitFailed ? 0 : changedStatusLines(status).length;
        check("git status", gitFailed ? "warn" : "pass", gitFailed ? status : `${changed} changed entries`);
      } catch (error) {
        check("git status", "fail", errorText(error));
      }

      if (parseBool(args.write_probe, true)) {
        if (config.writeMode === "off") {
          check("write/edit probe", "warn", "skipped because CODEXPRO_WRITE_MODE=off");
        } else {
          try {
            assertWriteToolAllowed(config, probePath);
            const content = [
              "# CodexPro Self Test",
              "",
              `Updated: ${new Date().toISOString()}`,
              `Workspace: ${workspace.root}`,
              "marker: before",
              ""
            ].join("\n");
            await writeTextFile(config, guard, workspace, probePath, content, { createDirs: true, overwrite: true });
            await editTextFile(config, guard, workspace, probePath, "marker: before", "marker: after", { expectedReplacements: 1 });
            const readBack = await readTextFile(config, guard, workspace, probePath, { maxBytes: 20_000 });
            if (!readBack.text.includes("marker: after")) throw new CodexProError("self-test edit marker was not found after edit.");
            const scopedStatus = gitStatus(config, workspace, guard, probePath);
            const scopedFiles = changedStatusLines(scopedStatus);
            filesTouched.push(probePath);
            check(
              "write/edit probe",
              scopedFiles.length && scopedFiles.every((line) => line.includes(probePath)) ? "pass" : "warn",
              scopedFiles.length ? `path-scoped status: ${scopedFiles.join(", ")}` : "path-scoped status clean after write/edit"
            );
          } catch (error) {
            check("write/edit probe", "fail", errorText(error));
          }
        }
      } else {
        check("write/edit probe", "warn", "skipped by request");
      }

      if (parseBool(args.pro_context_probe, true)) {
        try {
          if (!filesTouched.includes(probePath)) {
            check("selected-only pro context", "warn", "skipped because write probe did not create the selected file");
          } else {
            const context = await buildProContext(config, guard, workspace, {
              title: "CodexPro Self Test Context",
              selectedPaths: [probePath],
              includeImportantFiles: false,
              includeChangedFiles: false,
              includeDiff: false,
              includeAiBridge: false,
              maxFiles: 4,
              maxTotalBytes: 80_000
            });
            const exactOnly = context.filesIncluded.length === 1 && context.filesIncluded[0] === probePath;
            check(
              "selected-only pro context",
              exactOnly ? "pass" : "fail",
              exactOnly ? `included only ${probePath}` : `included ${context.filesIncluded.join(", ") || "no files"}`
            );
          }
        } catch (error) {
          check("selected-only pro context", "fail", errorText(error));
        }
      } else {
        check("selected-only pro context", "warn", "skipped by request");
      }

      if (parseBool(args.bash_probe, true)) {
        try {
          if (config.bashMode === "off") {
            check("bash policy", "warn", "bash disabled");
          } else {
            const bashProbeOptions = { timeoutMs: 10_000, sessionId: config.bashSessionId };
            const pwd = await runBash(config, guard, workspace, "pwd", bashProbeOptions);
            if (config.bashMode === "safe") {
              try {
                await runBash(config, guard, workspace, "ls $HOME", bashProbeOptions);
                check("bash policy", "fail", "safe bash allowed environment expansion unexpectedly");
              } catch {
                check("bash policy", pwd.exitCode === 0 ? "pass" : "warn", "safe bash allowed pwd and blocked environment expansion");
              }
            } else {
              check("bash policy", pwd.exitCode === 0 ? "warn" : "fail", "full bash is enabled; use only for trusted local repos");
            }
          }
        } catch (error) {
          check("bash policy", "fail", errorText(error));
        }
      } else {
        check("bash policy", "warn", "skipped by request");
      }

      check(
        "terms boundary",
        "pass",
        "local workspace bridge only; does not provide models, proxy model access, bypass quotas, or execute remote/local agents from MCP"
      );

      const failed = checks.filter((item) => item.status === "fail").length;
      const warned = checks.filter((item) => item.status === "warn").length;
      const passed = checks.filter((item) => item.status === "pass").length;
      const status = failed ? "fail" : warned ? "warn" : "pass";
      const text = [
        "# CodexPro Self Test",
        "",
        `Status: ${status}`,
        `Workspace: ${workspace.root}`,
        `Mode: tools=${config.toolMode}, write=${config.writeMode}, bash=${config.bashMode}${config.bashSessionId ? `, bash_session=${config.bashSessionId}${config.requireBashSession ? " required" : ""}` : ""}`,
        `Expected tools: ${expectedTools.length}`,
        `Registered tools: ${actualTools.length}`,
        `Duration: ${Date.now() - started} ms`,
        "",
        "## Checks",
        "",
        ...checks.map((item) => `- ${item.status.toUpperCase()} ${item.name}: ${item.detail}`),
        "",
        "## Terms Boundary",
        "",
        "CodexPro exposes local repo tools to the ChatGPT session the user controls. It does not provide models, proxy model access, resell access, modify quotas, bypass limits, or run local implementation agents through remote MCP tools."
      ].join("\n");

      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        status,
        passed,
        warned,
        failed,
        duration_ms: Date.now() - started,
        expected_tools: expectedTools,
        expected_tool_count: expectedTools.length,
        registered_tools: actualTools,
        registered_tool_count: actualTools.length,
        bash_mode: config.bashMode,
        bash_session_id: config.bashSessionId ?? null,
        require_bash_session: config.requireBashSession,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        files_touched: filesTouched,
        checks,
        terms_boundary: {
          local_workspace_bridge: true,
          provides_models: false,
          proxies_model_access: false,
          bypasses_quotas: false,
          remote_agent_execution: false
        }
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "codexpro_inventory",
    {
      title: "CodexPro Inventory",
      description:
        "List CodexPro modes plus discovered skill names and configured MCP server names. Use this early when planning needs local agent capabilities.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_global_skills: z.boolean().optional().describe("Include user and plugin skill folders. Default: true."),
        include_mcp_servers: z.boolean().optional().describe("Include configured MCP server names from safe config files. Default: true."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to list. Default: 120.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexPro inventory...",
        "openai/toolInvocation/invoked": "CodexPro inventory ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const inventory = await codexproInventory(config, workspace, {
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        includeMcpServers: parseBool(args.include_mcp_servers, true),
        maxSkills: limitInt(args.max_skills, 120, 1, 500)
      });
      return textResult(inventory.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        skills: inventory.skills,
        skill_count: inventory.skills.length,
        mcp_servers: inventory.mcpServers,
        mcp_server_count: inventory.mcpServers.length,
        widget_uri: TOOL_CARD_URI
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "load_skill",
    {
      title: "Load Skill",
      description:
        "Load the bounded SKILL.md body for a discovered workspace, user, or plugin skill by name. Does not accept arbitrary paths; use after open_current_workspace/open_workspace shows skill_inventory.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        name: z.string().describe("Exact skill name from skill_inventory or codexpro_inventory."),
        source: z.enum(["workspace", "user", "plugin", "other"]).optional().describe("Optional source when multiple skills share a name."),
        path: z.string().optional().describe("Exact sanitized path from skill_inventory when name/source are still ambiguous."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills. Default: true."),
        max_bytes: z.number().int().min(1000).max(100000).optional().describe("Maximum bytes to return from SKILL.md. Default: 40000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading skill instructions...",
        "openai/toolInvocation/invoked": "Skill instructions loaded"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const loaded = await loadSkill(workspace, {
        name: String(args.name ?? ""),
        source: args.source,
        path: typeof args.path === "string" ? args.path : undefined,
        includeGlobal: parseBool(args.include_global_skills, true),
        maxBytes: limitInt(args.max_bytes, 40_000, 1_000, 100_000)
      });
      const truncated = loaded.truncated ? "\n\n[truncated: increase max_bytes if more context is required]" : "";
      const text = `# Load Skill\n\nName: ${loaded.skill.name}\nSource: ${loaded.skill.source}\nPath: ${loaded.skill.path}\nBytes: ${loaded.bytes}/${loaded.totalBytes}\n\n\`\`\`markdown\n${loaded.text}${truncated}\n\`\`\``;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        skill: loaded.skill,
        bytes: loaded.bytes,
        total_bytes: loaded.totalBytes,
        truncated: loaded.truncated,
        text: loaded.text
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List currently opened CodexPro workspaces for this MCP session.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing CodexPro workspaces...",
        "openai/toolInvocation/invoked": "CodexPro workspaces listed"
      }
    },
    async () => {
      const current = workspaces.listWorkspaces();
      const text = current.length
        ? current.map((workspace) => `- ${workspace.id} — ${workspace.root} (opened ${workspace.openedAt})`).join("\n")
        : "No workspaces opened yet. Call open_workspace first.";
      return textResult(text, { workspaces: current, count: current.length });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_current_workspace",
    {
      title: "Open Current Workspace",
      description:
        "Use this once at the start to open the configured default workspace without accepting a path. Do not call open_workspace after this unless switching roots.",
      inputSchema: {
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: false for speed."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth when include_tree=true. Default: 2."),
        include_skills: z.boolean().optional().describe("Discover workspace, user, and plugin skills by name/description. Default: true."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: true.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening current CodexPro workspace...",
        "openai/toolInvocation/invoked": "Current CodexPro workspace opened"
      }
    },
    async (args) => {
      const workspace = workspaces.defaultWorkspace();
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: parseBool(args.include_tree, false),
        maxDepth: limitInt(args.max_depth, 2, 1, 8),
        includeSkills: parseBool(args.include_skills, true),
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        bootstrapContext: false
      });
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_workspace",
    {
      title: "Open Workspace",
      description:
        "Open a local project directory as a CodexPro workspace. Returns a workspace_id plus git status, AGENTS.md, skills, and a compact file tree.",
      inputSchema: {
        root: z.string().optional().describe("Project directory to open. Omit to use CODEXPRO_ROOT/current working directory. Supports ~/ paths."),
        path: z.string().optional().describe("Alias for root. Useful for clients that naturally send path instead of root."),
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: true."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover workspace, user, and plugin skills by name/description. Default: true."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: true."),
        bootstrap_context: z.boolean().optional().describe("Deprecated and ignored. Use handoff_to_agent to create .ai-bridge files.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening CodexPro workspace...",
        "openai/toolInvocation/invoked": "CodexPro workspace opened"
      }
    },
    async (args) => {
      if (args.root && args.path && args.root !== args.path) {
        throw new CodexProError("open_workspace accepts either root or path. If both are provided, they must match.");
      }
      const workspace = workspaces.openWorkspace(args.root ?? args.path);
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: args.include_tree !== false,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, true),
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        bootstrapContext: false
      });
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "workspace_snapshot",
    {
      title: "Workspace Snapshot",
      description: "Return git status, recent commits, .ai-bridge context, and a compact tree for an opened workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover repo-local skills. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan home-level skill folders when include_skills=true. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Collecting workspace snapshot...",
        "openai/toolInvocation/invoked": "Workspace snapshot ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: true,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false)
      });
      const ai = await readAiBridgeContext(config, guard, workspace);
      const text = `${summary.text}\n\n## AI handoff context\n\n${ai.text}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        ai_context_files: ai.files,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "tree",
    {
      title: "File Tree",
      description: "List files and directories inside the workspace, excluding blocked paths.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Directory relative to workspace root. Default: ."),
        max_depth: z.number().int().min(1).max(12).optional().describe("Maximum depth. Default: 4."),
        include_hidden: z.boolean().optional().describe("Include dotfiles/dotfolders that are not blocked. Default: false."),
        max_entries: z.number().int().min(1).max(3000).optional().describe("Maximum entries. Default: 800.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing workspace files...",
        "openai/toolInvocation/invoked": "Workspace files listed"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await repoTree(config, guard, workspace, {
        path: args.path ?? ".",
        maxDepth: limitInt(args.max_depth, 4, 1, 12),
        includeHidden: parseBool(args.include_hidden, false),
        maxEntries: limitInt(args.max_entries, 800, 1, 3000)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "search",
    {
      title: "Search Files",
      description: "Use this for targeted verification or code lookup. Prefer one specific final search instead of repeated broad verification searches.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        query: z.string().describe("Text or regex to search for."),
        regex: z.boolean().optional().describe("Treat query as a regular expression. Default: false."),
        path: z.string().optional().describe("Directory or file relative to workspace root. Default: ."),
        glob: z.string().optional().describe("Optional glob, for example src/**/*.ts."),
        include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results: z.number().int().min(1).max(2000).optional().describe("Maximum results. Default from config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Searching workspace...",
        "openai/toolInvocation/invoked": "Workspace search complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await searchWorkspace(config, guard, workspace, {
        query: args.query,
        regex: parseBool(args.regex, false),
        root: args.path ?? ".",
        glob: args.glob,
        includeHidden: parseBool(args.include_hidden, false),
        maxResults: limitInt(args.max_results, config.maxSearchResults, 1, config.maxSearchResults)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "read",
    {
      title: "Read File",
      description: "Read a specific text file with line numbers. Avoid rereading files after write/edit unless exact final content is needed.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        start_line: z.number().int().min(1).optional().describe("First line to read. Default: 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to read. Default: end of file."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum file bytes. Capped by server config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading file...",
        "openai/toolInvocation/invoked": "File read"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await readTextFile(config, guard, workspace, args.path, {
        startLine: args.start_line,
        endLine: args.end_line,
        maxBytes: args.max_bytes
      });
      const text = `# Read File\n\nPath: ${result.path}\nLines: ${result.startLine}-${result.endLine} of ${result.totalLines}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\n\n\`\`\`text\n${result.text}\n\`\`\``;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "write",
    {
      title: "Write File",
      description: "Create or overwrite a meaningful text file inside the workspace. Returns a unified diff; do not create empty placeholder files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        content: z.string().describe("Complete file contents to write."),
        create_dirs: z.boolean().optional().describe("Create parent directories if missing. Default: true."),
        overwrite: z.boolean().optional().describe("Allow overwriting existing files. Default: true.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing file...",
        "openai/toolInvocation/invoked": "File written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await writeTextFile(config, guard, workspace, args.path, String(args.content ?? ""), {
        createDirs: args.create_dirs !== false,
        overwrite: args.overwrite !== false
      });
      const text = `# Write File\n\nPath: ${result.path}\nExisted before: ${result.existed}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        existed: result.existed,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "edit",
    {
      title: "Edit File",
      description: "Apply a targeted exact text replacement inside a workspace text file. Returns a unified diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        old_text: z.string().describe("Exact text to replace. Must match once unless replace_all=true."),
        new_text: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace all occurrences. Default: false."),
        expected_replacements: z.number().int().min(1).optional().describe("Fail if actual replacement count differs.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Editing file...",
        "openai/toolInvocation/invoked": "File edited"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await editTextFile(config, guard, workspace, args.path, String(args.old_text ?? ""), String(args.new_text ?? ""), {
        replaceAll: parseBool(args.replace_all, false),
        expectedReplacements: args.expected_replacements
      });
      const text = `# Edit File\n\nPath: ${result.path}\nReplacements: ${result.replacements}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        replacements: result.replacements,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "bash",
    {
      title: "Bash",
      description:
        "Run one allowlisted verification command in the workspace, such as tests, build, lint, typecheck, or a project script. Do not use for git status/diff or file inspection; use show_changes, tree, search, and read instead. Do not chain commands with &&, pipes, redirects, or shell file readers.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        command: z.string().describe("Command to run."),
        session_id: z.string().optional().describe(config.requireBashSession && config.bashSessionId ? `Required bash session id for this server: ${config.bashSessionId}.` : "Optional bash session id. If configured on the server, a provided value must match it."),
        cwd: z.string().optional().describe("Working directory relative to workspace root. Default: ."),
        timeout_ms: z.number().int().min(1000).max(180000).optional().describe("Timeout in milliseconds. Default: 30000.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running bash command...",
        "openai/toolInvocation/invoked": "Bash command finished"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await runBash(config, guard, workspace, String(args.command ?? ""), {
        cwd: args.cwd,
        timeoutMs: args.timeout_ms,
        sessionId: args.session_id
      });
      const text = bashTextResult(config, result);
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result, bash_session_id: result.bashSessionId ?? null });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_status",
    {
      title: "Git Status",
      description: "Show git branch and changed files for the workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git status...",
        "openai/toolInvocation/invoked": "Git status ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const status = gitStatus(config, workspace);
      const statusError = looksLikeGitError(status) ? status : "";
      const changedFiles = statusError ? [] : changedStatusLines(status);
      return textResult(status, {
        workspace_id: workspace.id,
        root: workspace.root,
        status,
        status_error: statusError || undefined,
        changed_files: changedFiles,
        changed: !statusError && changedFiles.length > 0
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_diff",
    {
      title: "Git Diff",
      description: "Show current unstaged or staged git diff, optionally scoped to a file.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the raw unified diff in the response. Default: true. Set false for stats-only checks.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git diff...",
        "openai/toolInvocation/invoked": "Git diff ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const rawDiff = normalizeGitOutput(gitDiff(config, guard, workspace, args.path, parseBool(args.staged, false)));
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const stats = diffError ? { additions: 0, deletions: 0, changed: false } : diffStats(rawDiff);
      const includeDiff = parseBool(args.include_diff, true);
      const text = diffError
        ? diffError
        : includeDiff
        ? rawDiff
        : [
            "# Git Diff",
            "",
            `Workspace: ${workspace.root}`,
            `Path: ${args.path ?? "workspace diff"}`,
            `Staged: ${parseBool(args.staged, false)}`,
            `Diff stats: +${stats.additions} -${stats.deletions}`,
            "",
            "Raw diff omitted by include_diff=false."
          ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace diff",
        staged: parseBool(args.staged, false),
        include_diff: includeDiff,
        diff_error: diffError || undefined,
        additions: stats.additions,
        deletions: stats.deletions,
        changed: !diffError && stats.changed,
        diff: diffError || includeDiff ? rawDiff : ""
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "show_changes",
    {
      title: "Show Changes",
      description: "Summarize the current workspace changes in one review-oriented result with git status, diff stats, and optional diff. Use this instead of bash git status, bash git diff, git_status, or git_diff when reviewing work.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the unified diff. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Summarizing workspace changes...",
        "openai/toolInvocation/invoked": "Workspace changes summarized"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const status = gitStatus(config, workspace, guard, scopedPath);
      const includeDiff = parseBool(args.include_diff, true);
      const rawDiff = includeDiff ? normalizeGitOutput(gitDiff(config, guard, workspace, scopedPath, parseBool(args.staged, false))) : "";
      const statusError = looksLikeGitError(status) ? status : "";
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const diff = diffError ? "" : rawDiff;
      const stats = diffStats(diff);
      const changedFiles = statusError ? [] : changedStatusLines(status);
      const changedText = statusError
        ? `- Git status unavailable: ${statusError}`
        : changedFiles.length
          ? changedFiles.map((line) => `- ${line}`).join("\n")
          : "- No changed files.";
      const diffText = includeDiff
        ? diffError
          ? `\n\nGit diff unavailable: ${diffError}`
          : diff
          ? diffBlock(diff)
          : "\n\nNo diff output."
        : "\n\nDiff omitted by request.";
      const text = `# Show Changes\n\nWorkspace: ${workspace.root}\n\n## Changed\n\n${changedText}\n\n## Diff stats\n\n+${stats.additions} -${stats.deletions}${diffText}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace changes",
        status,
        status_error: statusError || undefined,
        diff_error: diffError || undefined,
        changed_files: changedFiles,
        staged: parseBool(args.staged, false),
        include_diff: includeDiff,
        additions: stats.additions,
        deletions: stats.deletions,
        changed: !statusError && (changedFiles.length > 0 || stats.changed),
        diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_handoff",
    {
      title: "Read Handoff",
      description: "Read the shared .ai-bridge planning files used for ChatGPT-to-agent coordination.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading agent handoff context...",
        "openai/toolInvocation/invoked": "Agent handoff context ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const context = await readAiBridgeContext(config, guard, workspace);
      return textResult(context.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        files: context.files,
        file_count: context.files.length,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "codex_context",
    {
      title: "Codex Context",
      description:
        "Load Codex-style workspace context in one call: AGENTS instructions for a target path, .ai-bridge handoff files, and optional git status/diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        target_path: z.string().optional().describe("Workspace-relative file or directory whose AGENTS instruction chain should be loaded. Default: ."),
        include_ai_bridge: z.boolean().optional().describe("Include .ai-bridge plan, agent status, diff, decisions, questions, and execution log. Default: true."),
        include_git: z.boolean().optional().describe("Include git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include full git diff. Default: false for speed/noise."),
        max_agent_bytes: z.number().int().min(1000).max(200000).optional().describe("Maximum bytes per AGENTS file. Default: 60000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading Codex context...",
        "openai/toolInvocation/invoked": "Codex context ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const context = await readCodexContext(config, guard, workspace, {
        targetPath: args.target_path,
        includeAiBridge: args.include_ai_bridge,
        includeGit: args.include_git,
        includeDiff: parseBool(args.include_diff, false),
        maxAgentBytes: args.max_agent_bytes
      });
      return textResult(context.text, {
        workspace_id: context.workspaceId,
        root: context.root,
        target_path: context.targetPath,
        agents_files: context.agentsFiles,
        ai_context_files: context.aiContextFiles,
        included_git_status: context.gitStatus !== undefined,
        included_git_diff: context.gitDiff !== undefined,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "export_pro_context",
    {
      title: "Export Pro Context",
      description:
        "Create .ai-bridge/pro-context.md with repo tree, git state, selected files, and handoff context for high-context ChatGPT planning without live MCP tool calls.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional().describe("Markdown title for the context bundle."),
        selected_paths: z.array(z.string()).optional().describe("Specific workspace-relative files to include."),
        extra_globs: z.array(z.string()).optional().describe("Additional workspace-relative glob patterns to include, for example src/**/*.ts."),
        include_important_files: z.boolean().optional().describe("Auto-include important root config/docs such as AGENTS.md, README.md, and package.json. Default: true."),
        include_changed_files: z.boolean().optional().describe("Auto-include currently changed files from git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include the current git diff. Default: true."),
        include_ai_bridge: z.boolean().optional().describe("Include existing .ai-bridge planning files. Default: true."),
        max_depth: z.number().int().min(1).max(6).optional().describe("Repository tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(80).optional().describe("Maximum file contents to include. Default: 24."),
        max_file_bytes: z.number().int().min(1000).max(250000).optional().describe("Maximum bytes per included file. Default: 60000."),
        max_total_bytes: z.number().int().min(20000).max(2000000).optional().describe("Maximum bytes in the generated bundle.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Exporting Pro context...",
        "openai/toolInvocation/invoked": "Pro context exported"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await exportProContext(config, guard, workspace, {
        title: args.title,
        selectedPaths: args.selected_paths,
        extraGlobs: args.extra_globs,
        includeImportantFiles: args.include_important_files,
        includeChangedFiles: args.include_changed_files,
        includeDiff: args.include_diff,
        includeAiBridge: args.include_ai_bridge,
        maxDepth: args.max_depth,
        maxFiles: args.max_files,
        maxFileBytes: args.max_file_bytes,
        maxTotalBytes: args.max_total_bytes
      });
      const text = `# Export Pro Context\n\nWrote ${result.path}.\nBytes: ${result.bytes}\nFiles included: ${result.filesIncluded.length}\nFiles skipped: ${result.filesSkipped.length}\nTruncated: ${result.truncated}\n\nPaste ${result.path} into a high-context planning model when MCP tools are unavailable, then save the returned plan with codexpro pro-apply.`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        bytes: result.bytes,
        files_included: result.filesIncluded,
        files_skipped: result.filesSkipped,
        truncated: result.truncated
      });
    }
  );

  if (config.codexSessions !== "off") {
    registerCodexTool(
      config,
      server,
      "codex_sessions",
      {
        title: "Codex Sessions",
        description:
          "Opt-in, read-only local Codex session history browser. Lists metadata from the user's configured Codex session JSONL files without reading full transcripts.",
        inputSchema: {
          max_sessions: z.number().int().min(1).max(200).optional().describe("Maximum sessions to return. Default: 30."),
          query: z.string().optional().describe("Optional case-insensitive search over session id, title, summary, cwd, and source path.")
        },
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Listing local Codex sessions...",
          "openai/toolInvocation/invoked": "Codex sessions ready"
        }
      },
      async (args) => {
        const result = await listCodexSessions(config, {
          maxSessions: args.max_sessions,
          query: args.query
        });
        const rows = result.sessions.length
          ? result.sessions.map((session) => `- ${session.session_id}  ${session.title || "(untitled)"}${session.project_dir ? `  cwd=${session.project_dir}` : ""}`).join("\n")
          : "- No Codex sessions found.";
        const text = `# Codex Sessions\n\nCodex dir: ${result.codex_dir}\nMode: ${config.codexSessions}\nTotal matched: ${result.total_found}\n\n${rows}`;
        return textResult(text, {
          codex_dir: result.codex_dir,
          roots: result.roots,
          sessions: result.sessions,
          total_found: result.total_found,
          codex_sessions_mode: config.codexSessions
        });
      }
    );

    if (config.codexSessions === "read") {
      registerCodexTool(
        config,
        server,
        "read_codex_session",
        {
          title: "Read Codex Session",
          description:
            "Opt-in, read-only local Codex transcript reader. Requires --codex-sessions read and returns a bounded transcript from a local Codex session JSONL file.",
          inputSchema: {
            session_id: z.string().optional().describe("Codex session id from codex_sessions."),
            source_path: z.string().optional().describe("Source path from codex_sessions. Must be inside the configured Codex session roots."),
            max_messages: z.number().int().min(1).max(400).optional().describe("Maximum transcript messages. Default: 80."),
            max_total_bytes: z.number().int().min(4000).max(400000).optional().describe("Maximum transcript content bytes. Default: 80000.")
          },
          annotations: READ_ONLY_ANNOTATIONS,
          _meta: {
            ...toolCardMeta(),
            "openai/toolInvocation/invoking": "Reading local Codex session...",
            "openai/toolInvocation/invoked": "Codex session read"
          }
        },
        async (args) => {
          const result = await readCodexSession(config, {
            sessionId: args.session_id,
            sourcePath: args.source_path,
            maxMessages: args.max_messages,
            maxTotalBytes: args.max_total_bytes
          });
          return textResult(result.text, {
            session: result.session,
            messages: result.messages,
            message_count: result.messages.length,
            truncated: result.truncated,
            codex_sessions_mode: config.codexSessions
          });
        }
      );
    }
  }

  registerCodexTool(
    config,
    server,
    "handoff_to_agent",
    {
      title: "Handoff To Agent",
      description:
        "Write .ai-bridge/current-plan.md for Codex, OpenCode, Pi, or another local implementation agent. This only creates handoff files; it does not execute local agent commands.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        agent: z.string().optional().describe("Target agent id, for example codex, opencode, pi, or custom. Default: custom."),
        agent_name: z.string().optional().describe("Human-readable agent name for custom agents."),
        model: z.string().optional().describe("Optional model identifier to include in the handoff plan."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for the local agent."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing agent handoff plan...",
        "openai/toolInvocation/invoked": "Agent handoff plan written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: args.agent ?? "custom",
        agentName: args.agent_name,
        model: args.model,
        title: cleanOneLine(args.title, "Agent implementation plan"),
        plan: String(args.plan ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_agent"
      });

      const text = `# Handoff To Agent

Agent: ${result.agentName} (${result.agent})
${result.model ? `Model: ${result.model}\n` : ""}Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Execution log: ${result.executionLogPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Agent prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        model: result.model,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "handoff_to_claude_code",
    {
      title: "Handoff To Claude Code",
      description:
        "Write .ai-bridge/current-plan.md specifically for Claude Code CLI/headless execution. This only creates handoff files; a user-started local watcher or command runs Claude Code.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        model: z.string().optional().describe("Optional Claude model identifier or profile note to include in the handoff."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for Claude Code. Include files, exact steps, tests, and review criteria."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing Claude Code handoff plan...",
        "openai/toolInvocation/invoked": "Claude Code handoff plan written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: "claude-code",
        agentName: "Claude Code",
        model: args.model,
        title: cleanOneLine(args.title, "Claude Code implementation plan"),
        plan: String(args.plan ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_claude_code"
      });
      const planRaw = await readRawTextFileBounded(config, guard, workspace, result.planPath, 300_000);
      const planHashValue = sha256Hex(planRaw);
      const watcherCommand = [
        "codexpro watch-handoff",
        "--agent claude-code",
        "--yes"
      ].join(" ");
      const text = `# Handoff To Claude Code

Agent: Claude Code
${result.model ? `Model note: ${result.model}\n` : ""}Wrote ${result.planPath}.
Plan hash: ${planHashValue}
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Execution log: ${result.executionLogPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Start the local watcher from the workspace:

\`\`\`bash
${watcherCommand}
\`\`\`

After the watcher starts and runs the plan, call handoff_poll with plan_hash="${planHashValue}" to review status, logs, and diff.${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        model: result.model,
        plan_path: result.planPath,
        plan_hash: planHashValue,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        watcher_command: watcherCommand,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "handoff_poll",
    {
      title: "Handoff Poll",
      description:
        "Read-only long-poll for local handoff execution state and artifacts. Use after handoff_to_claude_code/handoff_to_agent while a local watcher or execute-handoff process runs.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        plan_hash: z.string().optional().describe("Expected SHA-256 hash of .ai-bridge/current-plan.md. Returned by handoff_to_claude_code."),
        max_wait_seconds: z.number().int().min(0).max(120).optional().describe("Maximum seconds to poll before returning running/timed_out. Default: 0."),
        poll_ms: z.number().int().min(250).max(10000).optional().describe("Poll interval. Default: 1000 ms."),
        include_diff: z.boolean().optional().describe("Include implementation-diff.patch excerpt. Default: true."),
        include_log_excerpt: z.boolean().optional().describe("Include execution-log.jsonl excerpt. Default: true."),
        include_status: z.boolean().optional().describe("Include agent-status.md excerpt. Default: true."),
        max_artifact_chars: z.number().int().min(1000).max(80000).optional().describe("Maximum characters per artifact excerpt. Default: 16000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Polling handoff execution...",
        "openai/toolInvocation/invoked": "Handoff execution polled"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const maxWaitMs = limitInt(args.max_wait_seconds, 0, 0, 120) * 1000;
      const pollMs = limitInt(args.poll_ms, 1000, 250, 10000);
      const maxArtifactChars = limitInt(args.max_artifact_chars, 16_000, 1_000, 80_000);
      const started = Date.now();
      const planPath = `${config.contextDir}/current-plan.md`;
      const statusPath = `${config.contextDir}/agent-status.md`;
      const diffPath = `${config.contextDir}/implementation-diff.patch`;
      const logPath = `${config.contextDir}/execution-log.jsonl`;

      let state: Record<string, unknown> = {};
      let currentHash = "";
      let finalState = "waiting_for_executor";
      do {
        const planRaw = await readOptionalWorkspaceFile(config, guard, workspace, planPath, 300_000);
        currentHash = planRaw ? sha256Hex(planRaw) : "";
        state = await readHandoffRunState(config, guard, workspace);
        const expected = typeof args.plan_hash === "string" && args.plan_hash.trim() ? args.plan_hash.trim() : "";
        if (!planRaw) {
          finalState = "no_plan";
          break;
        }
        if (expected && expected !== currentHash) {
          finalState = "plan_hash_mismatch";
          break;
        }
        if (state.state === "running") {
          finalState = "running";
        } else if (
          state.state === "completed" ||
          state.state === "failed" ||
          state.event === "watch_handoff_finished" ||
          state.lastPlanHash === currentHash ||
          state.plan_hash === currentHash
        ) {
          finalState = "completed";
          break;
        } else {
          finalState = "waiting_for_executor";
        }
        if (Date.now() - started >= maxWaitMs) break;
        await sleep(pollMs);
      } while (maxWaitMs > 0);

      const includeStatus = parseBool(args.include_status, true);
      const includeDiff = parseBool(args.include_diff, true);
      const includeLog = parseBool(args.include_log_excerpt, true);
      const statusRaw = includeStatus ? await readOptionalWorkspaceFile(config, guard, workspace, statusPath, 200_000) : "";
      const diffRaw = includeDiff ? await readOptionalWorkspaceFile(config, guard, workspace, diffPath, 500_000) : "";
      const logRaw = includeLog ? await readOptionalWorkspaceFile(config, guard, workspace, logPath, 300_000) : "";
      const status = truncateText(statusRaw, maxArtifactChars);
      const diff = truncateText(diffRaw, maxArtifactChars);
      const log = truncateText(logRaw.split(/\r?\n/).slice(-40).join("\n"), maxArtifactChars);
      const diffStatsValue = diffStats(diffRaw || "");
      const elapsed = Date.now() - started;
      const text = [
        "# Handoff Poll",
        "",
        `State: ${finalState}`,
        `Workspace: ${workspace.root}`,
        `Plan: ${planPath}`,
        `Plan hash: ${currentHash || "none"}`,
        `Elapsed: ${elapsed} ms`,
        `State file: ${state.state_file ?? "none"}`,
        `Exit code: ${state.exit_code ?? state.exitCode ?? "unknown"}`,
        `Diff stats: +${diffStatsValue.additions} -${diffStatsValue.deletions}`,
        "",
        includeStatus ? `## Agent Status\n\n\`\`\`text\n${status.text || "(empty)"}\n\`\`\`` : "",
        includeDiff ? `## Implementation Diff\n\n\`\`\`diff\n${diff.text || "(empty)"}\n\`\`\`` : "",
        includeLog ? `## Execution Log Tail\n\n\`\`\`jsonl\n${log.text || "(empty)"}\n\`\`\`` : ""
      ].filter(Boolean).join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        state: finalState,
        state_file: state.state_file ?? null,
        raw_state: state,
        plan_path: planPath,
        plan_hash: currentHash || null,
        expected_plan_hash: typeof args.plan_hash === "string" ? args.plan_hash : null,
        elapsed_ms: elapsed,
        status_path: statusPath,
        diff_path: diffPath,
        log_path: logPath,
        exit_code: state.exit_code ?? state.exitCode ?? null,
        additions: diffStatsValue.additions,
        deletions: diffStatsValue.deletions,
        diff_changed: diffStatsValue.changed,
        status_excerpt: status.text,
        diff_excerpt: diff.text,
        log_excerpt: log.text,
        truncated: status.truncated || diff.truncated || log.truncated
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "handoff_to_codex",
    {
      title: "Handoff To Codex",
      description: "Compatibility wrapper for handoff_to_agent with agent=codex.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for Codex."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing Codex handoff plan...",
        "openai/toolInvocation/invoked": "Codex handoff plan written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: "codex",
        title: cleanOneLine(args.title, "Codex implementation plan"),
        plan: String(args.plan ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_codex"
      });
      const text = `# Handoff To Codex

Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Codex prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  return server;
}
