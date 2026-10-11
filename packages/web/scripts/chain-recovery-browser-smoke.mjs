/** Exercise the restart-gap action at phone and desktop widths in an isolated ADE server. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../../server/dist/events.js';
import { TaskManager } from '../../server/dist/tasks.js';
import { buildApp } from '../../server/dist/http.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-resume-browser-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-resume-profile-'));
const browserPath = process.env.ADE_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let app;
let browser;
let socket;
let evaluate;
let phase = 'setup';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const config = { workspaceRoot: root, host: '127.0.0.1', port: 0, allowedOrigins: [],
    agents: [{ id: 'next', label: 'Next', command: [process.execPath, '-e', 'console.log("done")'] }] };
  const store = new EventStore(path.join(root, '.ade'));
  for (const prompt of ['phone gap', 'desktop gap']) {
    const id = crypto.randomUUID();
    store.writeMeta({ id, agentId: 'next', prompt, cwd: '.', status: 'completed', exitCode: 0,
      chainId: id, chainStep: 1, chainTotal: 2, createdAt: Date.now(), endedAt: Date.now(),
      nextSteps: [{ agentId: 'next', prompt: `continue ${prompt}` }] });
    store.appendEvent(id, { type: 'task.output', taskId: id, stream: 'stdout', data: 'prior output', ts: Date.now() });
  }
  store.recoverInterruptedTasks();
  app = await buildApp({ config, tasks: new TaskManager(config, store), store });
  const base = await app.listen({ host: config.host, port: 0 });
  phase = 'browser startup';
  browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
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
  const pending = new Map();
  let commandId = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  for (const [width, prompt] of [[320, 'phone gap'], [1280, 'desktop gap']]) {
    phase = `${width}px resume`;
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width === 320 });
    await send('Page.navigate', { url: base });
    await until('!!document.querySelector(".conn.open") && !!document.querySelector(".task-row")');
    await evaluate(`[...document.querySelectorAll('.task-row')].find(row => row.title.includes(${JSON.stringify(prompt)})).click()`);
    await until('!!document.querySelector(".approval-prompt button")');
    assert(await evaluate(`(() => {
      const button = document.querySelector('.approval-prompt button').getBoundingClientRect();
      return button.height >= 44 && button.left >= 0 && button.right <= innerWidth &&
        document.documentElement.scrollWidth <= innerWidth;
    })()`), `${width}px recovery action overflowed`);
    assert.equal(await evaluate('document.querySelector(".approval-prompt button").disabled'), false);
    const screenshot = (await send('Page.captureScreenshot', { format: 'png' })).data;
    assert(Buffer.from(screenshot, 'base64').length > 10000, 'Empty screenshot');
    await evaluate('document.querySelector(".approval-prompt button").click()');
    await until(`document.querySelector('.task-chain-label')?.textContent.includes('step 2') &&
      !document.querySelector('.approval-prompt')`);
    assert.equal(store.list().filter((task) => task.prompt === `continue ${prompt}`).length, 1);
  }
  console.log('[browser-chain-recovery] PASS: mobile and desktop recovery action, layout and single child');
} catch (error) {
  console.error(`[browser-chain-recovery] FAIL at ${phase}:`, error);
  if (socket?.readyState === WebSocket.OPEN && evaluate) {
    console.error('Browser state:', await evaluate('document.querySelector(".chat-stream")?.innerText.slice(0, 650)'));
    console.error('Browser error:', await evaluate('document.querySelector(".error-pill")?.textContent'));
    console.error('Task state:', (await app.inject({ method: 'GET', url: '/api/tasks', headers: { host: '127.0.0.1' } })).json().tasks.map((task) => ({ prompt: task.prompt, status: task.status, sourceTaskId: task.sourceTaskId })));
  }
  process.exitCode = 1;
} finally {
  socket?.close();
  browser?.kill();
  await app?.close();
  await sleep(400);
  for (const [dir, prefix] of [[profile, 'ade-resume-profile-'], [root, 'ade-resume-browser-']]) {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith(prefix)) {
      throw new Error('Refusing to remove a directory outside the browser test');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}
