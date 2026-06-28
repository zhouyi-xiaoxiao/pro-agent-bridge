#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function usage() {
  console.log(`Capture the visible ChatGPT web session by scrolling Chrome

Usage:
  codexpro capture-chatgpt-session --root /path/to/repo
  codexpro-capture-chatgpt --root /path/to/repo --find-chatgpt

Options:
  --root <dir>              Workspace root. Default: current directory.
  --context-dir <dir>       Bridge directory. Default: .ai-bridge.
  --session-id <id>         Saved session id. Default: id from ChatGPT URL or a URL hash.
  --title <text>            Saved session title. Default: Chrome tab title.
  --provider <name>         Provider label. Default: chatgpt-web-scroll.
  --find-chatgpt            Use the first open chatgpt.com tab when the active tab is not ChatGPT.
  --cdp-url <url>           Use a Chrome DevTools endpoint instead of AppleScript, e.g. http://127.0.0.1:9222.
  --cdp-url-contains <text> Pick a CDP tab whose URL contains this text.
  --allow-non-chatgpt       Allow capture from non-ChatGPT pages. Useful for smoke tests.
  --max-scrolls <n>         Max upward and downward scroll steps. Default: 80.
  --settle-ms <ms>          Wait after each scroll for lazy loading. Default: 900.
  --stable-rounds <n>       Stop upward scan after this many stable top rounds. Default: 3.
  --max-session-bytes <n>   Refuse to write JSONL transcripts larger than this. Default: 25000000.
  --allow-sensitive         Allow secret-looking values to be written to the local private bridge.
  --enable-apple-events     Try to click Chrome's "Allow JavaScript from Apple Events" menu item first.
  --dry-run                 Capture and report counts without writing files.
  --help                    Show this message.

This command controls only the local Chrome tab you already have open. It does not access ChatGPT account history APIs, scrape hidden conversations, or send transcript data anywhere remote.
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    if (key === 'help') out.help = true;
    else if (key === 'find-chatgpt') out.findChatgpt = true;
    else if (key === 'allow-non-chatgpt') out.allowNonChatgpt = true;
    else if (key === 'allow-sensitive') out.allowSensitive = true;
    else if (key === 'enable-apple-events') out.enableAppleEvents = true;
    else if (key === 'dry-run') out.dryRun = true;
    else {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
      i += 1;
      out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next;
    }
  }
  return out;
}

function expandHome(input) {
  if (!input || input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function realDir(input) {
  const resolved = path.resolve(expandHome(input));
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return fs.realpathSync(resolved);
}

function safeRelPath(value, fallback) {
  const rel = String(value || fallback).replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) throw new Error(`Unsafe relative path: ${value}`);
  return rel;
}

function resolveInside(root, relPath) {
  const resolved = path.resolve(root, relPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path escapes workspace: ${relPath}`);
  return resolved;
}

function numberOption(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function cleanOneLine(value, fallback, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, max);
}

function normalizeId(value, seed) {
  const raw = String(value ?? '').trim();
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  if (cleaned && cleaned !== '.' && cleaned !== '..' && !cleaned.includes('..')) return cleaned;
  return `session-${sha256(seed).slice(0, 16)}`;
}

function normalizeProvider(value) {
  return cleanOneLine(value, 'chatgpt-web-scroll', 40).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'chatgpt-web-scroll';
}

const OPENAI_SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const SECRET_ASSIGNMENT_PATTERN = /\b[A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*=\s*(?:"[^"\r\n]{12,}"|'[^'\r\n]{12,}'|`[^`\r\n]{12,}`|[A-Za-z0-9_./+=-]{20,})/gi;

function isPlaceholderSecret(value) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('[redacted_secret]') ||
    normalized.includes('replace-me') ||
    normalized.includes('your-api-key-here') ||
    normalized.includes('<openai_api_key>') ||
    normalized.includes('process.env.') ||
    normalized.includes('import.meta.env.') ||
    normalized.includes('os.environ') ||
    normalized.includes('getenv(') ||
    normalized === 'sk-...' ||
    normalized.endsWith('=sk-...')
  );
}

function hasSecretValue(text) {
  for (const pattern of [OPENAI_SECRET_PATTERN, SECRET_ASSIGNMENT_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (!isPlaceholderSecret(match[0])) return true;
    }
  }
  return false;
}

async function chmodBestEffort(absPath, mode) {
  try {
    await fsp.chmod(absPath, mode);
  } catch {
    // Best-effort permission repair for filesystems that support chmod.
  }
}

function sessionIdFromUrl(url) {
  const match = String(url || '').match(/chatgpt\.com\/c\/([^/?#]+)/i) || String(url || '').match(/chat\.openai\.com\/c\/([^/?#]+)/i);
  return match?.[1];
}

function isChatGptUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(String(url || ''));
}

function runJxa(source) {
  const result = spawnSync('osascript', ['-l', 'JavaScript', '-e', source], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `osascript exited ${result.status}`;
    throw new Error(detail.trim());
  }
  return String(result.stdout || '').trim();
}

function runAppleScript(source) {
  const result = spawnSync('osascript', [], {
    input: source,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `osascript exited ${result.status}`;
    throw new Error(detail.trim());
  }
  return String(result.stdout || '').trim();
}

function chromeTabs() {
  const output = runJxa(`
const chrome = Application("Google Chrome");
const rows = [];
chrome.windows().forEach((win, wi) => {
  win.tabs().forEach((tab, ti) => {
    rows.push({ windowIndex: wi, tabIndex: ti, active: win.activeTabIndex() === ti + 1, title: tab.title(), url: tab.url() });
  });
});
JSON.stringify(rows);
`);
  return JSON.parse(output || '[]');
}

function activateTab(tab) {
  runJxa(`
const chrome = Application("Google Chrome");
chrome.activate();
const win = chrome.windows[${Number(tab.windowIndex)}];
win.activeTabIndex = ${Number(tab.tabIndex) + 1};
win.index = 1;
"ok";
`);
}

function activeTabInfo() {
  const output = runJxa(`
const chrome = Application("Google Chrome");
chrome.activate();
const win = chrome.windows[0];
const tab = win.activeTab();
JSON.stringify({ windowIndex: 0, tabIndex: win.activeTabIndex() - 1, title: tab.title(), url: tab.url() });
`);
  return JSON.parse(output);
}

function enableAppleEventsMenu() {
  return runAppleScript(`
tell application "System Events"
  tell process "Google Chrome"
    set frontmost to true
    delay 0.2
    set jsItem to menu item "Allow JavaScript from Apple Events" of menu 1 of menu item "Developer" of menu 1 of menu bar item "View" of menu bar 1
    try
      set markChar to value of attribute "AXMenuItemMarkChar" of jsItem
    on error
      set markChar to ""
    end try
    if markChar is missing value or markChar is "" then
      click jsItem
      delay 0.2
      return "clicked"
    else
      return "already-enabled"
    end if
  end tell
end tell
`);
}

function executeChromeJs(js) {
  try {
    const output = runJxa(`
const chrome = Application("Google Chrome");
const tab = chrome.windows[0].activeTab();
tab.execute({ javascript: ${JSON.stringify(js)} });
`);
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/JavaScript through AppleScript is turned off|Apple Events/i.test(message)) {
      throw new Error([
        'Chrome refused JavaScript from Apple Events.',
        'Open Chrome and enable: View > Developer > Allow JavaScript from Apple Events.',
        'If it is already checked but still fails, restart Chrome and rerun this command.',
        'You can also rerun with --enable-apple-events to let CodexPro try the menu click first.'
      ].join('\n'));
    }
    throw error;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

async function cdpTarget(cdpUrl, options = {}) {
  const base = String(cdpUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("--cdp-url must not be empty.");
  const targets = await fetchJson(`${base}/json/list`);
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!pages.length) throw new Error(`No page targets found at ${base}/json/list`);
  const wanted = String(options.urlContains || "").trim();
  const target = wanted
    ? pages.find((page) => String(page.url || "").includes(wanted))
    : options.findChatgpt
      ? pages.find((page) => isChatGptUrl(page.url))
      : pages.find((page) => isChatGptUrl(page.url)) || pages[0];
  if (!target) {
    const hint = wanted ? ` containing ${wanted}` : " matching a ChatGPT URL";
    throw new Error(`No CDP page target found${hint}`);
  }
  return {
    title: target.title || "",
    url: target.url || "",
    webSocketDebuggerUrl: target.webSocketDebuggerUrl
  };
}

async function createCdpExecutor(webSocketDebuggerUrl) {
  const { WebSocket } = await import("ws");
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const rejectAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  socket.on("message", (chunk) => {
    const message = JSON.parse(String(chunk));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
    else resolve(message.result);
  });
  socket.on("close", () => rejectAll(new Error("CDP WebSocket closed before Chrome returned a result.")));
  socket.on("error", (error) => rejectAll(error instanceof Error ? error : new Error(String(error))));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out after 30000 ms.`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "CDP Runtime.evaluate failed");
    }
    return result.result?.value ?? "";
  };
  return {
    evaluate,
    close: () => socket.close()
  };
}

function parseJsJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Chrome JavaScript returned non-JSON output: ${output.slice(0, 500)}`);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const extractJs = `
(() => {
  function norm(text) {
    return String(text || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  }
  function roleFor(node) {
    const own = node.getAttribute && node.getAttribute('data-message-author-role');
    const closest = node.closest && node.closest('[data-message-author-role]');
    const role = own || (closest && closest.getAttribute('data-message-author-role')) || '';
    if (role) return role;
    const label = norm(node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('data-testid')));
    if (/user|you/i.test(label)) return 'user';
    if (/assistant|chatgpt/i.test(label)) return 'assistant';
    return 'unknown';
  }
  const primary = Array.from(document.querySelectorAll('[data-message-author-role]'));
  const fallback = primary.length ? [] : Array.from(document.querySelectorAll('[data-testid^="conversation-turn"], article'));
  const nodes = primary.length ? primary : fallback;
  const messages = [];
  const occurrences = new Map();
  for (let ordinal = 0; ordinal < nodes.length; ordinal += 1) {
    const node = nodes[ordinal];
    const text = norm(node.innerText || node.textContent || '');
    if (!text || text.length < 2) continue;
    if (/^ChatGPT can make mistakes/i.test(text)) continue;
    const role = roleFor(node);
    const baseKey = role + '\\n' + text;
    const occurrence = occurrences.get(baseKey) || 0;
    occurrences.set(baseKey, occurrence + 1);
    const messageId =
      (node.getAttribute && node.getAttribute('data-message-id')) ||
      (node.closest && node.closest('[data-message-id]') && node.closest('[data-message-id]').getAttribute('data-message-id')) ||
      '';
    messages.push({ role, content: text, dom_id: messageId, occurrence, ordinal });
  }
  const scrolling = document.scrollingElement || document.documentElement || document.body;
  return JSON.stringify({
    title: document.title,
    url: location.href,
    scrollTop: scrolling ? scrolling.scrollTop : window.scrollY,
    scrollHeight: scrolling ? scrolling.scrollHeight : document.body.scrollHeight,
    clientHeight: scrolling ? scrolling.clientHeight : window.innerHeight,
    messages
  });
})()
`;

const scrollJs = (direction) => `
(() => {
  const scrolling = document.scrollingElement || document.documentElement || document.body;
  const amount = Math.max(600, Math.floor((scrolling ? scrolling.clientHeight : window.innerHeight) * 0.85));
  const before = scrolling ? scrolling.scrollTop : window.scrollY;
  if (${JSON.stringify(direction)} === 'up') {
    if (scrolling) scrolling.scrollTop = Math.max(0, before - amount);
    window.scrollBy(0, -amount);
  } else if (${JSON.stringify(direction)} === 'down') {
    if (scrolling) scrolling.scrollTop = Math.min(scrolling.scrollHeight, before + amount);
    window.scrollBy(0, amount);
  } else if (${JSON.stringify(direction)} === 'top') {
    if (scrolling) scrolling.scrollTop = 0;
    window.scrollTo(0, 0);
  }
  const after = scrolling ? scrolling.scrollTop : window.scrollY;
  return JSON.stringify({
    before,
    after,
    scrollHeight: scrolling ? scrolling.scrollHeight : document.body.scrollHeight,
    clientHeight: scrolling ? scrolling.clientHeight : window.innerHeight,
    atTop: after <= 2,
    atBottom: scrolling ? after + scrolling.clientHeight >= scrolling.scrollHeight - 2 : window.innerHeight + window.scrollY >= document.body.scrollHeight - 2
  });
})()
`;

function mergeMessages(store, messages, phase, iteration, orderCounter) {
  let added = 0;
  for (const message of messages) {
    const role = cleanOneLine(message.role, 'unknown', 32).toLowerCase();
    const content = String(message.content || '').trim();
    if (!content) continue;
    const domId = cleanOneLine(message.dom_id, '', 160);
    const occurrence = Number.isFinite(Number(message.occurrence)) ? Number(message.occurrence) : 0;
    const key = domId ? `dom:${domId}` : `occ:${sha256(`${role}\n${content}`)}:${occurrence}`;
    const existing = store.get(key);
    if (existing) {
      if (phase === 'down' && existing.downOrder === undefined) existing.downOrder = orderCounter.next++;
      existing.lastSeenPhase = phase;
      existing.lastSeenIteration = iteration;
      continue;
    }
    const record = {
      role,
      content,
      firstSeenPhase: phase,
      firstSeenIteration: iteration,
      lastSeenPhase: phase,
      lastSeenIteration: iteration,
      firstOrder: orderCounter.next++,
      downOrder: phase === 'down' ? orderCounter.next++ : undefined,
      captureKey: key,
      occurrence
    };
    store.set(key, record);
    added += 1;
  }
  return added;
}

async function captureConversation(options, executeJs = executeChromeJs) {
  const maxScrolls = numberOption(options.maxScrolls, 80, 1, 500);
  const settleMs = numberOption(options.settleMs, 900, 50, 10000);
  const stableRoundsTarget = numberOption(options.stableRounds, 3, 1, 20);
  const store = new Map();
  const orderCounter = { next: 0 };
  const stats = [];
  let meta = parseJsJson(await executeJs(extractJs));
  mergeMessages(store, meta.messages, 'initial', 0, orderCounter);

  let stableTopRounds = 0;
  let previousCount = store.size;
  for (let i = 1; i <= maxScrolls; i += 1) {
    const scroll = parseJsJson(await executeJs(scrollJs('up')));
    await sleep(settleMs);
    meta = parseJsJson(await executeJs(extractJs));
    const added = mergeMessages(store, meta.messages, 'up', i, orderCounter);
    stats.push({ phase: 'up', iteration: i, added, total: store.size, atTop: scroll.atTop, scrollTop: meta.scrollTop, scrollHeight: meta.scrollHeight });
    if (scroll.atTop && store.size === previousCount) stableTopRounds += 1;
    else stableTopRounds = 0;
    previousCount = store.size;
    if (stableTopRounds >= stableRoundsTarget) break;
  }

  await executeJs(scrollJs('top'));
  await sleep(settleMs);
  previousCount = store.size;
  for (let i = 1; i <= maxScrolls; i += 1) {
    meta = parseJsJson(await executeJs(extractJs));
    const added = mergeMessages(store, meta.messages, 'down', i, orderCounter);
    const scroll = parseJsJson(await executeJs(scrollJs('down')));
    stats.push({ phase: 'down', iteration: i, added, total: store.size, atBottom: scroll.atBottom, scrollTop: meta.scrollTop, scrollHeight: meta.scrollHeight });
    await sleep(settleMs);
    if (scroll.atBottom && store.size === previousCount) break;
    previousCount = store.size;
  }

  const messages = [...store.values()]
    .sort((a, b) => (a.downOrder ?? a.firstOrder) - (b.downOrder ?? b.firstOrder))
    .map((message, index) => ({
      type: 'message',
      index,
      role: message.role,
      content: message.content,
      capture: {
        first_seen_phase: message.firstSeenPhase,
        first_seen_iteration: message.firstSeenIteration,
        last_seen_phase: message.lastSeenPhase,
        last_seen_iteration: message.lastSeenIteration
      }
    }));

  return { meta, messages, stats };
}

async function writeSession(root, contextDir, session, options = {}) {
  const maxSessionBytes = numberOption(options.maxSessionBytes, 25_000_000, 100_000, 250_000_000);
  const bridgeDir = resolveInside(root, contextDir);
  const sessionsDir = resolveInside(root, path.join(contextDir, 'chat-sessions'));
  await fsp.mkdir(bridgeDir, { recursive: true, mode: 0o700 });
  await chmodBestEffort(bridgeDir, 0o700);
  await fsp.mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  await chmodBestEffort(sessionsDir, 0o700);
  const relPath = path.join(contextDir, 'chat-sessions', `${session.provider}-${session.sessionId}.jsonl`).replace(/\\/g, '/');
  const absPath = resolveInside(root, relPath);
  const rows = [
    {
      type: 'session_meta',
      ts: new Date().toISOString(),
      provider: session.provider,
      session_id: session.sessionId,
      title: session.title,
      source_url: session.url,
      tags: ['chatgpt-web-scroll'],
      message_count: session.messages.length,
      capture: session.capture
    },
    ...session.messages
  ];
  const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > maxSessionBytes) {
    throw new Error(
      `Captured session is ${bodyBytes} bytes, above --max-session-bytes ${maxSessionBytes}. ` +
        'Rerun with a larger explicit limit if you intentionally want to store this transcript.'
    );
  }
  if (!options.allowSensitive && hasSecretValue(body)) {
    throw new Error(
      'Captured session contains secret-looking content. Redact it first or rerun with --allow-sensitive to intentionally store it in the local private bridge.'
    );
  }
  await fsp.writeFile(absPath, body, { encoding: 'utf8', mode: 0o600 });
  await chmodBestEffort(absPath, 0o600);
  const sha = sha256(body);
  const indexPath = resolveInside(root, path.join(contextDir, 'chat-session-index.jsonl'));
  await fsp.appendFile(indexPath, `${JSON.stringify({
    ts: new Date().toISOString(),
    provider: session.provider,
    session_id: session.sessionId,
    title: session.title,
    source_url: session.url,
    tags: ['chatgpt-web-scroll'],
    message_count: session.messages.length,
    path: relPath,
    sha256: sha
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmodBestEffort(indexPath, 0o600);
  return { relPath, absPath, indexPath, sha };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  let tab;
  let executeJs = executeChromeJs;
  let cdpExecutor;
  if (args.cdpUrl) {
    tab = await cdpTarget(args.cdpUrl, { urlContains: args.cdpUrlContains, findChatgpt: args.findChatgpt });
    cdpExecutor = await createCdpExecutor(tab.webSocketDebuggerUrl);
    executeJs = cdpExecutor.evaluate;
  } else {
    if (process.platform !== 'darwin') {
      throw new Error('capture-chatgpt-session without --cdp-url requires macOS Google Chrome Apple Events automation.');
    }
    if (args.enableAppleEvents) {
      const result = enableAppleEventsMenu();
      console.error(`[codexpro-capture-chatgpt] Apple Events menu: ${result}`);
    }
  }

  if (!tab) tab = activeTabInfo();
  if (!args.cdpUrl && !isChatGptUrl(tab.url) && args.findChatgpt) {
    const found = chromeTabs().find((candidate) => isChatGptUrl(candidate.url));
    if (!found) throw new Error('No open chatgpt.com tab found.');
    activateTab(found);
    await sleep(300);
    tab = activeTabInfo();
  }
  if (!args.allowNonChatgpt && !isChatGptUrl(tab.url)) {
    throw new Error(`Active Chrome tab is not ChatGPT: ${tab.url}\nOpen the target ChatGPT conversation or rerun with --find-chatgpt.`);
  }

  const root = realDir(args.root || process.cwd());
  const contextDir = safeRelPath(args.contextDir, '.ai-bridge');
  const provider = normalizeProvider(args.provider);
  const title = cleanOneLine(args.title, tab.title || 'Captured ChatGPT session', 180);
  const sessionId = normalizeId(args.sessionId || sessionIdFromUrl(tab.url), `${tab.url}\n${title}`);
  const captureMethod = args.cdpUrl ? 'chrome-cdp-scroll' : 'chrome-apple-events-scroll';
  const maxSessionBytes = numberOption(args.maxSessionBytes, 25_000_000, 100_000, 250_000_000);

  let captured;
  try {
    captured = await captureConversation(args, executeJs);
  } finally {
    cdpExecutor?.close();
  }
  const session = {
    provider,
    sessionId,
    title,
    url: tab.url,
    messages: captured.messages,
    capture: {
      method: captureMethod,
      captured_at: new Date().toISOString(),
      max_scrolls: numberOption(args.maxScrolls, 80, 1, 500),
      settle_ms: numberOption(args.settleMs, 900, 50, 10000),
      stable_rounds: numberOption(args.stableRounds, 3, 1, 20),
      max_session_bytes: maxSessionBytes,
      stats: captured.stats.slice(-80)
    }
  };

  if (args.dryRun) {
    console.log(JSON.stringify({
      dry_run: true,
      root,
      context_dir: contextDir,
      provider,
      session_id: sessionId,
      title,
      source_url: tab.url,
      message_count: session.messages.length,
      capture_method: captureMethod,
      max_session_bytes: maxSessionBytes,
      stats_tail: session.capture.stats.slice(-8)
    }, null, 2));
    return;
  }

  const writeResult = await writeSession(root, contextDir, session, { maxSessionBytes, allowSensitive: Boolean(args.allowSensitive) });
  console.log(`Saved ChatGPT session: ${writeResult.relPath}`);
  console.log(`Messages: ${session.messages.length}`);
  console.log(`Index: ${path.relative(root, writeResult.indexPath)}`);
  console.log(`SHA-256: ${writeResult.sha}`);
  console.log(`Read later with MCP tool read_saved_chat_session session_id="${sessionId}".`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
