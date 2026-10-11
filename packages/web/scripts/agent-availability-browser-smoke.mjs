/** Check runnable-agent selection on desktop and phone against an isolated ADE server. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../../server/dist/events.js';
import { TaskManager } from '../../server/dist/tasks.js';
import { buildApp } from '../../server/dist/http.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-agent-browser-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-agent-profile-'));
const browserPath = process.env.ADE_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let app;
let browser;
let socket;
let phase = 'startup';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const config = { workspaceRoot: workspace, host: '127.0.0.1', port: 0, allowedOrigins: [], agents: [
    { id: 'missing', label: 'Missing CLI', command: ['ade-not-installed-test-cli'] },
    { id: 'ready', label: 'Ready', command: [process.execPath, '-e', 'console.log(process.cwd())'] },
    { id: 'fixed', label: 'Fixed', command: [process.execPath, '-e', 'console.log(process.cwd())'], cwd: 'nested' },
  ] };
  fs.mkdirSync(path.join(workspace, 'nested'));
  const store = new EventStore(path.join(workspace, '.ade'));
  app = await buildApp({ config, tasks: new TaskManager(config, store), store });
  const base = await app.listen({ host: config.host, port: 0 });
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
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const frame = JSON.parse(data);
    const entry = pending.get(frame.id);
    if (entry) {
      pending.delete(frame.id);
      frame.error ? entry.reject(new Error(JSON.stringify(frame.error))) : entry.resolve(frame.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const value = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
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
  const downloads = path.join(profile, 'downloads');
  fs.mkdirSync(downloads);
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  for (const width of [320, 1280]) {
    phase = `${width}px availability`;
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width === 320 });
    await send('Page.navigate', { url: base });
    await until(`document.querySelector('.composer select[aria-label="Agent"]')?.value === 'ready' &&
      !!document.querySelector('.conn.open')`);
    const state = await evaluate(`(() => {
      const select = document.querySelector('.composer select[aria-label="Agent"]');
      const missing = select.querySelector('option[value="missing"]');
      const warning = document.querySelector('.agent-availability');
      return { missingDisabled: missing?.disabled, missingLabel: missing?.textContent,
        selected: select.value, warning: warning?.textContent,
        overflow: document.documentElement.scrollWidth > innerWidth };
    })()`);
    assert.equal(state.missingDisabled, true);
    assert.match(state.missingLabel, /unavailable/);
    assert.equal(state.selected, 'ready');
    assert.match(state.warning, /Missing CLI/);
    assert.equal(state.overflow, false, `${width}px layout overflowed`);
    phase = `${width}px scoped dispatch`;
    await until('!!document.querySelector(".directory-picker select option[value=nested]")');
    await evaluate(`(() => {
      const select = document.querySelector('.directory-picker select');
      select.value = 'nested';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const prompt = document.querySelector('.composer > textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(prompt, 'scoped task');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until('!document.querySelector(".run").disabled');
    await evaluate('document.querySelector(".run").click()');
    await until('document.querySelector(".task-directory")?.textContent.includes("nested")');
    const taskId = await evaluate('new URLSearchParams(location.search).get("task")');
    const getTask = async (id) => (await (await fetch(`${base}/api/tasks`)).json()).tasks.find((task) => task.id === id);
    assert.equal((await getTask(taskId)).cwd, 'nested');
    for (let i = 0; i < 100; i++) {
      const events = (await (await fetch(`${base}/api/tasks/${taskId}/events`)).json()).events;
      if (events.some((event) => event.type === 'task.completed')) {
        assert(events.some((event) => event.type === 'task.output' &&
          event.data.trim() === path.join(workspace, 'nested')), 'Task ran outside selected directory');
        break;
      }
      if (i === 99) throw new Error('Scoped task did not complete');
      await sleep(100);
    }
    await until('!!document.querySelector(".handoff-action")');
    phase = `${width}px task log download`;
    const logButton = await evaluate(`(() => {
      const button = document.querySelector('.task-log-action');
      const bounds = button?.getBoundingClientRect();
      return { label: button?.getAttribute('aria-label'), width: bounds?.width, right: bounds?.right };
    })()`);
    assert.equal(logButton.label, 'Download complete task log');
    assert(logButton.width >= (width === 320 ? 44 : 36));
    assert(logButton.right <= width, 'Download button overflowed the viewport');
    await evaluate('document.querySelector(".task-log-action").click()');
    const logFile = path.join(downloads, `ade-task-${taskId}.jsonl`);
    for (let i = 0; i < 100 && !fs.existsSync(logFile); i++) await sleep(100);
    assert(fs.existsSync(logFile), 'Task log was not downloaded');
    const logRows = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').map((row) => JSON.parse(row));
    assert(logRows.some((event) => event.type === 'task.output'));
    assert(logRows.some((event) => event.type === 'task.completed'));
    phase = `${width}px handoff`;
    await evaluate('document.querySelector(".handoff-action").click()');
    assert.equal(await evaluate('document.querySelector(".directory-picker select").value'), 'nested');
    await evaluate(`(() => {
      const prompt = document.querySelector('.composer > textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(prompt, 'follow up');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until('!document.querySelector(".run").disabled');
    await evaluate('document.querySelector(".run").click()');
    await until(`new URLSearchParams(location.search).get('task') !== '${taskId}'`);
    const handoffTaskId = await evaluate('new URLSearchParams(location.search).get("task")');
    assert.equal((await getTask(handoffTaskId)).cwd, 'nested');
    assert.equal((await getTask(handoffTaskId)).sourceTaskId, taskId);

    await evaluate(`(() => {
      const select = document.querySelector('.composer select[aria-label="Agent"]');
      select.value = 'fixed';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until('!!document.querySelector(".directory-fixed")');
    assert.equal(await evaluate('document.querySelector(".directory-fixed")?.textContent'), 'Set by server for this agent');
    await evaluate(`(() => {
      const prompt = document.querySelector('.composer > textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(prompt, 'fixed agent run');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until('!document.querySelector(".run").disabled');
    await evaluate('document.querySelector(".run").click()');
    await until(`new URLSearchParams(location.search).get('task') !== '${handoffTaskId}'`);
    const fixedTaskId = await evaluate('new URLSearchParams(location.search).get("task")');
    assert.equal((await getTask(fixedTaskId)).cwd, '.');
    await until('document.querySelector(".task-directory")?.textContent.includes("set by server")');
    for (let i = 0; i < 100; i++) {
      const events = (await (await fetch(`${base}/api/tasks/${fixedTaskId}/events`)).json()).events;
      if (events.some((event) => event.type === 'task.completed')) {
        assert(events.some((event) => event.type === 'task.output' &&
          event.data.trim() === path.join(workspace, 'nested')), 'Fixed agent ignored its configured directory');
        break;
      }
      if (i === 99) throw new Error('Fixed task did not complete');
      await sleep(100);
    }
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    const screenshot = (await send('Page.captureScreenshot', { format: 'png' })).data;
    assert(Buffer.from(screenshot, 'base64').length > 10000, 'Empty screenshot');
  }
  console.log('[browser-agents] PASS: desktop/mobile availability, scoped dispatch, task log download, handoff, fixed agent and layout');
} catch (error) {
  console.error(`[browser-agents] FAIL at ${phase}:`, error);
  process.exitCode = 1;
} finally {
  socket?.close();
  browser?.kill();
  await app?.close();
  await sleep(400);
  for (const [dir, prefix] of [[profile, 'ade-agent-profile-'], [workspace, 'ade-agent-browser-']]) {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith(prefix)) {
      throw new Error('Refusing to remove a directory outside the browser test');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}
