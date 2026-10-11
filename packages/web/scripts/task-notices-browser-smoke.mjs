/** Optional mobile browser regression against a running ADE server with the demo agent. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const base = process.env.ADE_URL ?? 'http://127.0.0.1:8787';
const browserPath = process.env.ADE_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-notices-ui-'));
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let phase = 'browser startup';

try {
  let port;
  for (let i = 0; i < 100; i++) {
    const activePort = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(activePort)) { port = Number(fs.readFileSync(activePort, 'utf8').split('\n')[0]); break; }
    if (browser.exitCode !== null) throw new Error('Browser exited early');
    await wait(100);
  }
  if (!port) throw new Error('Browser debugging port unavailable');
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${base}/`, { method: 'PUT' })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const browserErrors = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      browserErrors.push(message.params.args.map((arg) => arg.description ?? arg.value).join(' '));
    }
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
    const response = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 110; i++) {
      if (await evaluate(expression)) return;
      await wait(120);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 720, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: process.env.ADE_TOKEN
    ? `${base}/#token=${encodeURIComponent(process.env.ADE_TOKEN)}` : base });
  phase = 'initial baseline';
  await until('!!document.querySelector(".conn.open") && !!document.querySelector(".task-list")');
  assert.equal(await evaluate('document.querySelector(".nav-unread")?.textContent ?? ""'), '');
  if (process.env.ADE_TEST_PUSH === '1') {
    phase = 'push opt-in';
    assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 200);
    assert.equal((await fetch(`${base}/push-sw.js`)).status, 200);
    assert.equal((await fetch(`${base}/icon-192.png`)).headers.get('content-type'), 'image/png');
    await until('!!document.querySelector(".push-toggle")');
    assert.equal(await evaluate('document.querySelector(".push-toggle").disabled'), false);
    assert(await evaluate(`(() => {
      const brand = document.querySelector('.brand').getBoundingClientRect();
      const actions = document.querySelector('.top-right').getBoundingClientRect();
      const bell = document.querySelector('.push-toggle').getBoundingClientRect();
      return brand.right <= actions.left && bell.width >= 44 && actions.right <= innerWidth;
    })()`));
    await send('Browser.grantPermissions', { permissions: ['notifications'], origin: new URL(base).origin });
    await evaluate('document.querySelector(".push-toggle").click()');
    await until(`document.querySelector('.push-toggle')?.getAttribute('aria-pressed') === 'true' ||
      !!document.querySelector('.error-pill')`);
    assert.equal(await evaluate('document.querySelector(".push-toggle").getAttribute("aria-pressed")'), 'true',
      `Could not subscribe: ${await evaluate('document.querySelector(".error-pill")?.textContent ?? ""')} ${browserErrors.join(' | ')}`);
    await evaluate('document.querySelector(".push-toggle").click()');
    await until('document.querySelector(".push-toggle")?.getAttribute("aria-pressed") === "false"');
  }
  await evaluate('document.querySelectorAll(".mobile-nav button")[0].click()');
  phase = 'task completion outside Agent pane';
  const prompt = `notice smoke ${crypto.randomUUID()}`;
  const response = await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(process.env.ADE_TOKEN ? { authorization: `Bearer ${process.env.ADE_TOKEN}` } : {}) },
    body: JSON.stringify({ agentId: 'demo', prompt, cwd: '.' }),
  });
  assert.equal(response.status, 201);
  await response.json();
  await until(`document.querySelector('.nav-unread')?.textContent === '1' &&
    [...document.querySelectorAll('.task-row')].some(row => row.title.includes('${prompt}') && row.classList.contains('unread'))`);
  assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  phase = 'read and reload';
  await evaluate('document.querySelectorAll(".mobile-nav button")[2].click()');
  await until(`!![...document.querySelectorAll('.task-row.unread')].find(row => row.title.includes('${prompt}'))`);
  await evaluate(`[...document.querySelectorAll('.task-row.unread')].find(row => row.title.includes('${prompt}')).click()`);
  await until('!document.querySelector(".nav-unread") && !document.querySelector(".task-row.unread")');
  await send('Page.reload', { ignoreCache: true });
  await until('!!document.querySelector(".conn.open") && !!document.querySelector(".task-list")');
  assert.equal(await evaluate('document.querySelector(".nav-unread")?.textContent ?? ""'), '');
  if (process.env.ADE_TEST_APPROVAL === '1') {
    phase = 'chain approval composer';
    await evaluate('document.querySelectorAll(".mobile-nav button")[2].click()');
    await evaluate('document.querySelectorAll(".composer-modes button")[1].click()');
    await until('!!document.querySelector(".chain-step-editor input[type=checkbox]")');
    // React listens for native input changes through its value setter.
    await evaluate(`(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      const first = document.querySelector('.composer > textarea');
      const second = document.querySelector('.chain-step-editor textarea');
      set.call(first, 'mobile approval first');
      first.dispatchEvent(new Event('input', { bubbles: true }));
      set.call(second, 'mobile approval second');
      second.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.chain-step-editor input[type=checkbox]').click();
    })()`);
    await until('!document.querySelector(".composer .run").disabled');
    await evaluate('document.querySelector(".composer .run").click()');
    await until('!!document.querySelector(".approval-prompt")');
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
    phase = 'approval survives mobile reload';
    await send('Page.reload', { ignoreCache: true });
    await until('!!document.querySelector(".conn.open") && !!document.querySelector(".approval-prompt")');
    await evaluate(`[...document.querySelectorAll('.approval-actions button')].find(button => button.textContent.includes('Approve')).click()`);
    await until(`document.querySelector('.task-chain-label')?.textContent.includes('step 2') &&
      document.querySelector('.bubble.agent .out-footer')?.textContent.includes('exit')`);
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  }
  console.log('[browser-task-notices] PASS: mobile unread badge, task read and reload baseline' +
    (process.env.ADE_TEST_PUSH === '1' ? ', push opt-in and opt-out' : '') +
    (process.env.ADE_TEST_APPROVAL === '1' ? ', chain approval and reload' : ''));
} catch (err) {
  console.error(`[browser-task-notices] FAIL at ${phase}:`, err);
  process.exitCode = 1;
} finally {
  socket?.close();
  browser.kill();
  await wait(400);
  const tempRoot = fs.realpathSync(os.tmpdir());
  const target = fs.realpathSync(profile);
  if (path.dirname(target) === tempRoot && path.basename(target).startsWith('ade-notices-ui-')) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); }
    catch { /* Browser may still be closing. */ }
  }
}
