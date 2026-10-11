/** Git review actions in desktop and phone layouts, using an isolated repository. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../../server/dist/events.js';
import { TaskManager } from '../../server/dist/tasks.js';
import { buildApp } from '../../server/dist/http.js';

const temp = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(temp, 'ade-git-browser-'));
const profile = fs.mkdtempSync(path.join(temp, 'ade-git-profile-'));
const browserPath = process.env.ADE_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true });
let app;
let socket;
let phase = 'setup';

try {
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'review.txt'), 'before\n');
  git('add', 'review.txt');
  git('-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.invalid', 'commit', '-qm', 'initial');
  fs.writeFileSync(path.join(root, 'review.txt'), 'after\n');
  const config = { workspaceRoot: root, host: '127.0.0.1', port: 0, allowedOrigins: [], agents: [] };
  const store = new EventStore(path.join(root, '.ade'));
  app = await buildApp({ config, store, tasks: new TaskManager(config, store) });
  const base = await app.listen({ host: config.host, port: 0 });
  phase = 'browser startup';
  let port;
  for (let i = 0; i < 100; i++) {
    const active = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(active)) { port = Number(fs.readFileSync(active, 'utf8').split('\n')[0]); break; }
    if (browser.exitCode !== null) throw new Error('Browser exited early');
    await sleep(100);
  }
  if (!port) throw new Error('Browser debugging port unavailable');
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${base}/`, { method: 'PUT' })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 140; i++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  for (const [width, height, mobile] of [[1280, 800, false], [320, 720, true]]) {
    phase = `${width}px review`;
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await send('Page.navigate', { url: base });
    await until('!!document.querySelector(".conn.open") && !!document.querySelector(".sidebar-modes")');
    if (mobile) await evaluate('document.querySelectorAll(".mobile-nav button")[0].click()');
    await evaluate('document.querySelectorAll(".sidebar-modes button")[1].click()');
    await until('!!document.querySelector(".change-row")');
    await evaluate('document.querySelector(".change-row").click()');
    await until('!!document.querySelector(".review-action:not(:disabled)")');
    assert(await evaluate(`(() => {
      const header = document.querySelector('.review-header').getBoundingClientRect();
      const action = document.querySelector('.review-action').getBoundingClientRect();
      const back = document.querySelector('.review-back').getBoundingClientRect();
      return action.left >= back.right && action.right <= innerWidth && header.right <= innerWidth &&
        document.documentElement.scrollWidth <= innerWidth;
    })()`), `${width}px review header overflowed`);
    const screenshot = (await send('Page.captureScreenshot', { format: 'png' })).data;
    fs.writeFileSync(path.join(root, `review-${width}.png`), Buffer.from(screenshot, 'base64'));
    phase = `${width}px stage then unstage`;
    await evaluate('document.querySelector(".review-action").click()');
    await until('!!document.querySelector(".change-group-title") && document.querySelector(".change-group-title").textContent.includes("Staged")');
    await evaluate('document.querySelector(".change-row").click()');
    await until('document.querySelector(".review-action:not(:disabled)")?.textContent.includes("Unstage")');
    await evaluate('document.querySelector(".review-action").click()');
    await until('!!document.querySelector(".change-group-title") && document.querySelector(".change-group-title").textContent.includes("Working")');
  }
  assert.equal(fs.readFileSync(path.join(root, 'review.txt'), 'utf8'), 'after\n');
  console.log(`[browser-git] PASS: desktop/mobile stage and unstage, mobile review layout; screenshots ${root}`);
} catch (error) {
  console.error(`[browser-git] FAIL at ${phase}:`, error);
  process.exitCode = 1;
} finally {
  socket?.close();
  browser.kill();
  await app?.close();
  await sleep(400);
  if (path.dirname(fs.realpathSync(profile)) === temp && path.basename(profile).startsWith('ade-git-profile-')) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch { /* Browser closing. */ }
  }
}
