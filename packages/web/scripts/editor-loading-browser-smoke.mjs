/** Verify that the phone chat shell does not load Monaco until an editor surface is opened. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../../server/dist/events.js';
import { TaskManager } from '../../server/dist/tasks.js';
import { buildApp } from '../../server/dist/http.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-lazy-editor-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-lazy-profile-'));
const browserPath = process.env.ADE_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requests = [];
let app;
let browser;
let socket;
let phase = 'setup';

try {
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root, windowsHide: true });
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'original\n');
  execFileSync('git', ['add', 'fixture.txt'], { cwd: root, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.invalid',
    'commit', '-qm', 'initial'], { cwd: root, windowsHide: true });
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'changed\n');
  const config = { workspaceRoot: root, host: '127.0.0.1', port: 0, allowedOrigins: [], agents: [] };
  const store = new EventStore(path.join(root, '.ade'));
  app = await buildApp({ config, store, tasks: new TaskManager(config, store) });
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
    if (frame.method === 'Network.requestWillBeSent') requests.push(frame.params.request.url);
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
    const frame = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (frame.exceptionDetails) throw new Error(JSON.stringify(frame.exceptionDetails));
    return frame.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 120; i++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  const monacoRequests = () => requests.filter((url) =>
    /\/assets\/(EditorPane|GitReviewPane|monaco-setup|editor\.api|editor\.worker|ts\.worker)/.test(url));

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  phase = 'phone chat first load';
  await send('Page.navigate', { url: base });
  await until('!!document.querySelector(".conn.open") && !!document.querySelector(".mobile-nav")');
  await sleep(400);
  assert.equal(await evaluate('document.querySelector(".app")?.dataset.pane'), 'chat');
  assert.equal(await evaluate('!!document.querySelector(".editor-pane")'), false);
  assert.deepEqual(monacoRequests(), [], 'Phone chat loaded editor resources');

  phase = 'phone editor';
  await evaluate('document.querySelectorAll(".mobile-nav button")[1].click()');
  await until('!!document.querySelector(".editor-pane")');
  assert(monacoRequests().some((url) => /\/EditorPane-/.test(url)), 'Editor chunk was not requested');
  await evaluate('document.querySelectorAll(".mobile-nav button")[0].click()');
  await until('!!document.querySelector("[title=\\"fixture.txt\\"].tree-row")');
  await evaluate('document.querySelector("[title=\\"fixture.txt\\"].tree-row").click()');
  await until('!!document.querySelector(".editor-host .native-edit-context")');
  await evaluate('document.querySelector(".editor-host .native-edit-context").focus()');
  await send('Input.insertText', { text: 'draft ' });
  await until('document.querySelector(".editor-status")?.textContent.includes("unsaved")');

  phase = 'phone diff and draft';
  await evaluate('document.querySelectorAll(".mobile-nav button")[0].click()');
  await evaluate('document.querySelectorAll(".sidebar-modes button")[1].click()');
  await until('!!document.querySelector(".change-row")');
  await evaluate('document.querySelector(".change-row").click()');
  await until('!!document.querySelector(".review-host .native-edit-context")');
  assert(monacoRequests().some((url) => /\/GitReviewPane-/.test(url)), 'Diff chunk was not requested');
  await evaluate('document.querySelector(".review-back").click()');
  await until('document.querySelector(".editor-status")?.textContent.includes("unsaved")');

  phase = 'desktop default editor';
  requests.length = 0;
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base });
  await until('!!document.querySelector(".editor-pane") && !!document.querySelector(".conn.open")');
  assert(monacoRequests().some((url) => /\/EditorPane-/.test(url)), 'Desktop editor did not load');

  phase = 'phone file link';
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${base}/?file=fixture.txt` });
  await until('document.querySelector(".app")?.dataset.pane === "editor" && !!document.querySelector(".editor-host .native-edit-context")');
  assert.equal(await evaluate('document.querySelector(".editor-status-path")?.textContent'), 'fixture.txt');
  console.log('[browser-editor-loading] PASS: phone chat stays light; editor, diff, draft, desktop and file link load');
} catch (error) {
  console.error(`[browser-editor-loading] FAIL at ${phase}:`, error);
  process.exitCode = 1;
} finally {
  socket?.close();
  browser?.kill();
  await app?.close();
  await sleep(400);
  for (const [dir, prefix] of [[profile, 'ade-lazy-profile-'], [root, 'ade-lazy-editor-']]) {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith(prefix)) {
      throw new Error('Refusing to remove a directory outside the browser test');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}
