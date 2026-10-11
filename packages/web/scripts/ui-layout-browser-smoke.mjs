/** Check the ADE shell at phone, tablet and desktop sizes against the built web app. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../../server/dist/events.js';
import { TaskManager } from '../../server/dist/tasks.js';
import { buildApp } from '../../server/dist/http.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-ui-workspace-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-ui-profile-'));
const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-ui-screenshots-'));
const browserPath = process.env.ADE_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app;
let browser;
let socket;
let phase = 'startup';

try {
  fs.writeFileSync(path.join(root, 'example.ts'), 'export const hello = "ADE";\n');
  const config = { workspaceRoot: root, host: '127.0.0.1', port: 0, allowedOrigins: [], agents: [
    { id: 'codex', label: 'Codex', command: [process.execPath, '-e', 'console.log("ready")'] },
  ] };
  const store = new EventStore(path.join(root, '.ade'));
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
    if (!entry) return;
    pending.delete(frame.id);
    frame.error ? entry.reject(new Error(JSON.stringify(frame.error))) : entry.resolve(frame.result);
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
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  for (const width of [320, 390, 768, 1024, 1440]) {
    const mobile = width <= 960;
    phase = `${width}px shell`;
    await send('Emulation.setDeviceMetricsOverride', { width, height: 840, deviceScaleFactor: 1, mobile });
    await send('Page.navigate', { url: base });
    await until('!!document.querySelector(".conn.open") && !!document.querySelector(".task-filters input")');
    const panes = mobile ? ['chat', 'files', 'editor'] : ['editor', 'chat', 'files'];
    for (const pane of panes) {
      phase = `${width}px ${pane}`;
      if (mobile) {
        await evaluate(`document.querySelector('.mobile-nav button:nth-child(${({ files: 1, editor: 2, chat: 3 })[pane]})').click()`);
        await until(`document.querySelector('.app')?.dataset.pane === '${pane}'`);
      }
      if (pane === 'editor') await until('!!document.querySelector(".editor-pane")');
      const layout = await evaluate(`(() => {
        const rect = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        return { overflow: document.documentElement.scrollWidth > innerWidth,
          bar: rect('.topbar'), brand: rect('.brand'), actions: rect('.top-right'),
          nav: rect('.mobile-nav'), pane: rect('.${pane === 'files' ? 'files-pane' : pane === 'editor' ? 'editor-pane-wrapper' : 'chat-pane-wrapper'}'),
          composer: rect('.composer'), editor: rect('.editor-host'),
          topbarScroll: document.querySelector('.topbar').scrollWidth > document.querySelector('.topbar').clientWidth };
      })()`);
      assert.equal(layout.overflow, false, `${phase} document overflow: ${JSON.stringify(layout)}`);
      assert.equal(layout.topbarScroll, false, `${phase} header overflow`);
      assert(layout.brand.right <= layout.actions.left + 1, `${phase} header controls overlap`);
      assert(layout.pane && layout.pane.width >= (pane === 'files' && !mobile ? 240 : 300), `${phase} pane too narrow`);
      assert(layout.pane.left >= 0 && layout.pane.right <= width + 1, `${phase} pane outside viewport`);
      if (mobile) {
        assert(layout.nav.top >= layout.pane.bottom - 1, `${phase} navigation overlaps pane`);
        assert(layout.nav.bottom <= 840 + 1, `${phase} navigation clipped`);
      } else {
        assert(layout.editor.width >= 300, `${phase} editor too narrow`);
      }
      if (pane === 'chat') assert(layout.composer.top >= layout.pane.top && layout.composer.bottom <= layout.pane.bottom + 1,
        `${phase} composer clipped`);
      if (width === 390 || width === 768 || width === 1440) {
        const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(path.join(shots, `${width}-${pane}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }
  }
  console.log(`[ui-layout] PASS: phone, tablet and desktop; screenshots ${shots}`);
} catch (error) {
  console.error(`[ui-layout] FAIL at ${phase}:`, error);
  process.exitCode = 1;
} finally {
  socket?.close();
  browser?.kill();
  await app?.close();
  await sleep(400);
  for (const [dir, prefix] of [[profile, 'ade-ui-profile-'], [root, 'ade-ui-workspace-']]) {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith(prefix)) {
      throw new Error('Refusing to remove a directory outside the browser test');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}
