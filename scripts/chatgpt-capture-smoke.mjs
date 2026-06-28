#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function chromePath() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
  ];
  return candidates.find((candidate) => spawnSync('test', ['-x', candidate]).status === 0);
}

async function waitForDevToolsPort(profileDir, timeoutMs = 10000) {
  const portPath = path.join(profileDir, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const text = await fs.readFile(portPath, 'utf8');
      const [port] = text.trim().split(/\r?\n/);
      if (port) return port;
    } catch {
      // Wait until Chrome writes the port file.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Chrome DevToolsActivePort');
}

function runCapture(args) {
  const result = spawnSync(process.execPath, ['scripts/chatgpt-scroll-capture.mjs', ...args], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    timeout: 30000
  });
  if (result.status !== 0) {
    throw new Error(`capture failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function runCaptureExpectFailure(args, expectedText) {
  const result = spawnSync(process.execPath, ['scripts/chatgpt-scroll-capture.mjs', ...args], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    timeout: 10000
  });
  if (result.status === 0) {
    throw new Error(`capture unexpectedly succeeded\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (expectedText && !combined.includes(expectedText)) {
    throw new Error(`capture failure did not include ${expectedText}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

if (process.platform !== 'darwin') {
  console.log('chatgpt capture smoke skipped: macOS Chrome automation only');
  process.exit(0);
}

const chrome = chromePath();
if (!chrome) {
  console.log('chatgpt capture smoke skipped: Chrome not installed');
  process.exit(0);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-chatgpt-capture-'));
const profile = path.join(tmp, 'chrome-profile');
const root = path.join(tmp, 'workspace');
await fs.mkdir(root, { recursive: true });
await fs.mkdir(profile, { recursive: true });
const fixturePath = path.join(tmp, 'fixture.html');
const emptyFixturePath = path.join(tmp, 'empty-fixture.html');
const fixtureHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Capture Fixture</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
    .spacer { height: 850px; }
    [data-message-author-role] { margin: 24px auto; max-width: 720px; padding: 16px; border: 1px solid #ccc; }
  </style>
</head>
<body>
  <main>
    <div class="spacer"></div>
    <article data-message-author-role="user">Top user message for scroll capture.</article>
    <div class="spacer"></div>
    <article data-message-author-role="assistant">Middle assistant message for scroll capture.</article>
    <div class="spacer"></div>
    <article data-message-author-role="user">Repeat duplicate user message.</article>
    <article data-message-author-role="user">Repeat duplicate user message.</article>
    <div class="spacer"></div>
    <article data-message-author-role="user">Bottom user message for scroll capture.</article>
    <div class="spacer"></div>
  </main>
</body>
</html>`;
await fs.writeFile(fixturePath, fixtureHtml, 'utf8');
await fs.writeFile(emptyFixturePath, '<!doctype html><title>Empty Capture Fixture</title><main></main>', 'utf8');

const chromeProcess = spawn(chrome, [
  `--user-data-dir=${profile}`,
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  `file://${fixturePath}`,
  `file://${emptyFixturePath}`
], {
  stdio: 'ignore'
});

try {
  const port = await waitForDevToolsPort(profile);
  runCaptureExpectFailure([
    '--root',
    root,
    '--allow-non-chatgpt',
    '--cdp-url',
    'http://127.0.0.1:1',
    '--dry-run'
  ], 'fetch');
  runCapture([
    '--root',
    root,
    '--allow-non-chatgpt',
    '--cdp-url',
    `http://127.0.0.1:${port}`,
    '--cdp-url-contains',
    '/fixture.html',
    '--session-id',
    'fixture-scroll-session',
    '--title',
    'Fixture Scroll Session',
    '--max-scrolls',
    '12',
    '--settle-ms',
    '50'
  ]);
  const saved = await fs.readFile(path.join(root, '.ai-bridge', 'chat-sessions', 'chatgpt-web-scroll-fixture-scroll-session.jsonl'), 'utf8');
  if (!saved.includes('"method":"chrome-cdp-scroll"')) throw new Error(`saved transcript missing CDP capture method\n${saved}`);
  for (const expected of [
    'Top user message for scroll capture.',
    'Middle assistant message for scroll capture.',
    'Repeat duplicate user message.',
    'Bottom user message for scroll capture.'
  ]) {
    if (!saved.includes(expected)) throw new Error(`saved transcript missing: ${expected}\n${saved}`);
  }
  const duplicateCount = (saved.match(/Repeat duplicate user message\./g) || []).length;
  if (duplicateCount !== 2) throw new Error(`duplicate fixture messages should be preserved twice, got ${duplicateCount}\n${saved}`);
  const index = await fs.readFile(path.join(root, '.ai-bridge', 'chat-session-index.jsonl'), 'utf8');
  if (!index.includes('fixture-scroll-session')) throw new Error(`index missing fixture session\n${index}`);
  const emptyDryRun = runCapture([
    '--root',
    root,
    '--allow-non-chatgpt',
    '--cdp-url',
    `http://127.0.0.1:${port}`,
    '--cdp-url-contains',
    'empty-fixture.html',
    '--dry-run',
    '--max-scrolls',
    '2',
    '--settle-ms',
    '50'
  ]);
  const emptySummary = JSON.parse(emptyDryRun.stdout);
  if (emptySummary.message_count !== 0) {
    throw new Error(`empty fixture should capture zero messages\n${emptyDryRun.stdout}`);
  }
  console.log('✓ chatgpt capture smoke test passed');
} finally {
  chromeProcess.kill('SIGTERM');
}
