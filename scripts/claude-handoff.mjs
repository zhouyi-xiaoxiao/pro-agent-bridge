#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
  codexpro-claude-handoff --plan-file .ai-bridge/current-plan.md [--claude-bin claude]

Runs Claude Code in non-interactive print mode against a CodexPro handoff plan.
The CodexPro watcher owns process execution, timeout, logs, and final diff capture.`);
}

function readPlan(filePath) {
  if (!filePath) throw new Error('--plan-file is required.');
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
  if (stat.size > 800_000) throw new Error(`Plan file is too large: ${stat.size} bytes.`);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }
  const plan = readPlan(args.planFile);
  const claudeBin = String(args.claudeBin || process.env.CLAUDE_BIN || 'claude');
  const prompt = buildPrompt(plan.path, plan.text);
  const extraArgs = process.env.CLAUDE_HANDOFF_ARGS
    ? process.env.CLAUDE_HANDOFF_ARGS.split(/\s+/).filter(Boolean)
    : [];
  const childArgs = ['-p', prompt, ...extraArgs];

  console.error(`[codexpro-claude-handoff] running ${claudeBin} -p <handoff prompt>`);
  const child = spawn(claudeBin, childArgs, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
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
