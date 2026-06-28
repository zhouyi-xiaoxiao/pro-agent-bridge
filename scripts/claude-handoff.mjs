#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_PLAN_BYTES = 120_000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function usage() {
  console.log(`Usage:
  codexpro-claude-handoff --plan-file .ai-bridge/current-plan.md [--model sonnet] [--claude-bin claude]

Runs Claude Code in non-interactive print mode against a CodexPro handoff plan.
The CodexPro watcher owns process execution, timeout, logs, and final diff capture.`);
}

function readPlan(filePath) {
  if (!filePath) throw new Error('--plan-file is required.');
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
  if (stat.size > MAX_PLAN_BYTES) {
    throw new Error(
      `Plan file is too large for Claude Code argv handoff: ${stat.size} bytes. ` +
        `Keep it under ${MAX_PLAN_BYTES} bytes or pass a custom --command that streams the plan file.`
    );
  }
  return { path: resolved, text: fs.readFileSync(resolved, 'utf8') };
}

function buildPrompt(planPath, planText) {
  return [
    'You are Claude Code executing a CodexPro handoff plan written by ChatGPT Pro.',
    '',
    `Plan file: ${planPath}`,
    '',
    'Execution contract:',
    '- Read and follow the plan, but keep changes scoped and reviewable.',
    '- Inspect relevant files before editing.',
    '- Prefer exact, minimal edits that match the existing project style.',
    '- Run focused verification when practical.',
    '- Update .ai-bridge/agent-status.md with changed files, checks run, results, blockers, and remaining review notes.',
    '- Do not claim success unless verification or a clear blocker is recorded.',
    '',
    'Handoff plan:',
    '',
    planText
  ].join('\n');
}

function hasProxyEnv(env) {
  return Boolean(
    env.HTTPS_PROXY ||
      env.https_proxy ||
      env.HTTP_PROXY ||
      env.http_proxy ||
      env.ALL_PROXY ||
      env.all_proxy
  );
}

function parseScutilProxy(text) {
  const config = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.+?)\s*$/);
    if (match) config[match[1]] = match[2];
  }
  return config;
}

function proxyHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function macSystemProxyEnv() {
  if (process.platform !== 'darwin') return { env: {}, summary: null };
  let output = '';
  try {
    output = execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    });
  } catch {
    return { env: {}, summary: null };
  }

  const config = parseScutilProxy(output);
  const env = {};
  const summaries = [];
  if (config.HTTPSEnable === '1' && config.HTTPSProxy && config.HTTPSPort) {
    env.HTTPS_PROXY = `http://${proxyHost(config.HTTPSProxy)}:${config.HTTPSPort}`;
    summaries.push(`HTTPS ${config.HTTPSProxy}:${config.HTTPSPort}`);
  }
  if (config.HTTPEnable === '1' && config.HTTPProxy && config.HTTPPort) {
    env.HTTP_PROXY = `http://${proxyHost(config.HTTPProxy)}:${config.HTTPPort}`;
    summaries.push(`HTTP ${config.HTTPProxy}:${config.HTTPPort}`);
  } else if (env.HTTPS_PROXY) {
    env.HTTP_PROXY = env.HTTPS_PROXY;
  }
  if (config.SOCKSEnable === '1' && config.SOCKSProxy && config.SOCKSPort) {
    env.ALL_PROXY = `socks5h://${proxyHost(config.SOCKSProxy)}:${config.SOCKSPort}`;
    summaries.push(`SOCKS ${config.SOCKSProxy}:${config.SOCKSPort}`);
  }
  return { env, summary: summaries.join(', ') || null };
}

function claudeChildEnv(baseEnv) {
  const env = { ...baseEnv };
  if (hasProxyEnv(env)) return { env, proxySummary: null };
  const systemProxy = macSystemProxyEnv();
  Object.assign(env, systemProxy.env);
  return { env, proxySummary: systemProxy.summary };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }
  const plan = readPlan(args.planFile);
  const claudeBin = String(args.claudeBin || process.env.CLAUDE_HANDOFF_BIN || process.env.CLAUDE_BIN || 'claude');
  const model = String(args.model || '').trim();
  const prompt = buildPrompt(plan.path, plan.text);
  const extraArgs = process.env.CLAUDE_HANDOFF_ARGS
    ? process.env.CLAUDE_HANDOFF_ARGS.split(/\s+/).filter(Boolean)
    : [];
  const childArgs = ['-p', ...(model ? ['--model', model] : []), ...extraArgs, prompt];
  const { env: childEnv, proxySummary } = claudeChildEnv(process.env);

  console.error(`[codexpro-claude-handoff] running ${claudeBin} -p <handoff prompt>`);
  if (proxySummary) {
    console.error(`[codexpro-claude-handoff] using macOS system proxy for Claude Code: ${proxySummary}`);
  }
  const child = spawn(claudeBin, childArgs, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv
  });

  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  const code = await new Promise((resolve) => {
    child.on('error', (error) => {
      console.error(`[codexpro-claude-handoff] failed to start Claude Code: ${error.message}`);
      resolve(127);
    });
    child.on('close', (exitCode, signal) => {
      if (signal) console.error(`[codexpro-claude-handoff] Claude Code terminated by ${signal}`);
      resolve(exitCode ?? 1);
    });
  });
  process.exitCode = code;
}

main().catch((error) => {
  console.error(`[codexpro-claude-handoff] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
