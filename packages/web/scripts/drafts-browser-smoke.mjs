/** Optional browser E2E. Requires a running ADE server and Chrome/Edge with CDP. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const base = process.env.ADE_URL ?? 'http://127.0.0.1:8787';
const browserPath = process.env.ADE_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const filename = `ade draft check-${crypto.randomUUID()}.txt`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-draft-ui-'));
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headers = { 'content-type': 'application/json',
  ...(process.env.ADE_TOKEN ? { authorization: `Bearer ${process.env.ADE_TOKEN}` } : {}) };
let socket;
let peer;
let phase = 'browser startup';
let created = false;

async function api(method, route, body) {
  const res = await fetch(base + route, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`);
  return res.json();
}

try {
  if (typeof WebSocket !== 'function') throw new Error('Browser smoke test requires Node.js 22 or newer');
  let port;
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(path.join(profile, 'DevToolsActivePort'))) {
      port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      break;
    }
    if (browser.exitCode !== null) throw new Error('Browser exited early');
    await wait(100);
  }
  if (!port) throw new Error('Browser debugging port unavailable');
  let revision = (await api('PUT', '/api/files/content', { path: filename, content: 'base', expectedRevision: null })).revision;
  created = true;
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
    const response = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 100; i++) {
      try {
        if (await evaluate(expression)) return;
      } catch (err) {
        if (!String(err).includes('Inspected target navigated or closed')) throw err;
      }
      await wait(120);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };

  await send('Page.enable');
  phase = 'first open';
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: process.env.ADE_TOKEN
    ? `${base}/#token=${encodeURIComponent(process.env.ADE_TOKEN)}` : base });
  await until(`!!document.querySelector('[title="${filename}"].tree-row')`);
  await evaluate(`document.querySelector('[title="${filename}"].tree-row').click()`);
  await until('!!document.querySelector(".editor-host .native-edit-context")');
  await until(`new URLSearchParams(location.search).get('file') === '${filename}'`);
  await evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true,
    value: { writeText: async (text) => { window.__copiedFileLink = text; } } })`);
  await evaluate('document.querySelector(".editor-share").click()');
  phase = 'share link';
  await until('document.querySelector(".editor-share")?.title === "Link copied"');
  const copiedFileLink = await evaluate('window.__copiedFileLink');
  assert.equal(new URL(copiedFileLink).searchParams.get('file'), filename);
  assert.equal(new URL(copiedFileLink).searchParams.has('task'), false);
  assert.equal(new URL(copiedFileLink).searchParams.has('token'), false);
  assert.equal(new URL(copiedFileLink).hash.includes('token='), false);
  await send('Page.reload', { ignoreCache: true });
  phase = 'clean reload';
  await until(`document.querySelector('.tab-name')?.textContent?.includes('${filename}') &&
    document.querySelector('.editor-status')?.textContent?.includes('saved')`);
  const peerUrl = new URL('/ws', base);
  peerUrl.protocol = peerUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  if (process.env.ADE_TOKEN) peerUrl.searchParams.set('token', process.env.ADE_TOKEN);
  peer = new WebSocket(peerUrl);
  await new Promise((resolve, reject) => { peer.onopen = resolve; peer.onerror = reject; });
  peer.send(JSON.stringify({ kind: 'presence.set', path: filename }));
  await until('document.querySelector(".editor-viewers")?.textContent?.includes("1 other viewing")');
  assert(await evaluate(`(() => {
    const path = document.querySelector('.editor-status-path').getBoundingClientRect();
    const viewers = document.querySelector('.editor-viewers').getBoundingClientRect();
    return path.right <= viewers.left && document.documentElement.scrollWidth <= innerWidth;
  })()`));
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
  assert(await evaluate(`(() => {
    const path = document.querySelector('.editor-status-path').getBoundingClientRect();
    const viewers = document.querySelector('.editor-viewers').getBoundingClientRect();
    const share = document.querySelector('.editor-share').getBoundingClientRect();
    return path.right <= viewers.left && share.width >= 44 && share.right <= innerWidth &&
      document.documentElement.scrollWidth <= innerWidth;
  })()`));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  peer.close();
  await until('!document.querySelector(".editor-viewers")');
  await evaluate('document.querySelector(".editor-host .native-edit-context").focus()');
  await send('Input.insertText', { text: 'draft text' });
  await until('document.querySelector(".editor-status")?.textContent?.includes("unsaved")');
  await until('Object.keys(localStorage).some(k => k.startsWith("ade:drafts:v1:") && localStorage[k].includes("draft text"))');
  await send('Page.reload', { ignoreCache: true });
  phase = 'draft reload';
  await until(`document.querySelector('.tab-name')?.textContent?.includes('${filename}') && document.querySelector('.editor-status')?.textContent?.includes('unsaved')`);
  revision = (await api('PUT', '/api/files/content', { path: filename, content: 'remote text', expectedRevision: revision })).revision;
  await send('Page.reload', { ignoreCache: true });
  phase = 'conflict reload';
  await until('!!document.querySelector(".editor-conflict")');
  assert(await evaluate('document.querySelector(".editor-conflict").textContent.includes("File changed on disk")'));
  await evaluate('document.querySelector(".editor-conflict-actions button:nth-child(2)").click()');
  await until('document.querySelector(".editor-status")?.textContent?.includes("saved") && !document.querySelector(".editor-conflict")');
  await until('!Object.keys(localStorage).some(k => k.startsWith("ade:drafts:v1:") && localStorage[k].includes("draft text"))');
  await evaluate('document.querySelector(".tab-close").click()');
  await until('!document.querySelector(".tab-name") && !new URLSearchParams(location.search).has("file")');
  await send('Page.reload', { ignoreCache: true });
  phase = 'closed reload';
  await until('!!document.querySelector(".quick-open-trigger")');
  assert.equal(await evaluate('!!document.querySelector(".tab-name")'), false);
  await send('Page.navigate', { url: copiedFileLink });
  phase = 'shared link navigation';
  await until(`document.querySelector('.tab-name')?.textContent?.includes('${filename}') &&
    document.querySelector('.editor-status')?.textContent?.includes('saved')`);
  console.log('[browser-drafts] PASS: file link/clean reload, mobile presence/layout, draft recovery and conflict');
} catch (err) {
  console.error(`[browser-drafts] FAIL at ${phase}:`, err);
  process.exitCode = 1;
} finally {
  socket?.close();
  peer?.close();
  browser.kill();
  if (created) {
    try {
      const current = await api('GET', `/api/files/content?p=${encodeURIComponent(filename)}`);
      await api('DELETE', '/api/files/content', { path: filename, expectedRevision: current.revision });
    } catch (err) {
      console.error('[browser-drafts] cleanup failed:', filename, err);
      process.exitCode = 1;
    }
  }
  await wait(400);
  const tempRoot = fs.realpathSync(os.tmpdir());
  const target = fs.realpathSync(profile);
  if (path.dirname(target) === tempRoot && path.basename(target).startsWith('ade-draft-ui-')) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); }
    catch { /* Browser may still be closing. */ }
  }
}
