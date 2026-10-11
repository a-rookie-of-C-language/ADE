/** Exercise workspace locking against real, independent server processes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { EventStore } from '../dist/events.js';
import { TaskManager } from '../dist/tasks.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-lock-smoke-'));
const taskId = crypto.randomUUID();
const taskDir = path.join(root, '.ade', 'tasks', taskId);
const lockDir = path.join(root, '.ade', 'server.lock');
const children = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function start(port = 0) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, ADE_WORKSPACE: root, ADE_PORT: String(port), ADE_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    children.delete(child);
    resolve({ code, signal });
  }));
  return { child, exited, output: () => output };
}

async function ready(proc) {
  for (let i = 0; i < 200; i++) {
    if (proc.output().includes('[ade] server')) return;
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) break;
    await sleep(50);
  }
  throw new Error(`Server did not start: ${proc.output()}`);
}

async function exited(proc) {
  let timer;
  try {
    return await Promise.race([
      proc.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Server did not exit: ${proc.output()}`)), 15000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

try {
  const first = start();
  await ready(first);
  assert.ok(fs.existsSync(lockDir), 'running server must hold workspace lock');

  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify({
    id: taskId, agentId: 'demo', prompt: 'lock test', cwd: '.', mode: 'exec',
    status: 'running', createdAt: Date.now(),
  }));
  const duplicate = start();
  const conflict = await exited(duplicate);
  assert.notEqual(conflict.code, 0, 'duplicate server should fail');
  assert.match(duplicate.output(), /Workspace already has an ADE server/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'))).status, 'running',
    'lock conflict must not recover tasks');

  first.child.kill('SIGTERM');
  await exited(first);
  if (process.platform === 'win32') {
    assert.ok(fs.existsSync(lockDir), 'forced termination leaves a lock on Windows');
    await sleep(11000);
  } else {
    assert.ok(!fs.existsSync(lockDir), 'graceful shutdown releases lock');
  }
  const successor = start();
  await ready(successor);
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'))).status, 'failed',
    'successor should recover interrupted task');
  successor.child.kill('SIGTERM');
  await exited(successor);
  if (process.platform === 'win32') await sleep(11000);

  // Startup failures must release their lock without accepting traffic.
  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  try {
    const failed = start(busy.address().port);
    assert.notEqual((await exited(failed)).code, 0, 'port conflict should fail startup');
    assert.ok(!fs.existsSync(lockDir), 'failed startup must release lock');
  } finally {
    await new Promise((resolve) => busy.close(resolve));
  }

  const crashed = start();
  await ready(crashed);
  // SIGKILL is unavailable on Windows; taskkill /F bypasses JS exit handlers there.
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(crashed.child.pid), '/F'], { windowsHide: true });
    await new Promise((resolve, reject) => {
      killer.once('error', reject);
      killer.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited ${code}`)));
    });
  } else crashed.child.kill('SIGKILL');
  await exited(crashed);
  assert.ok(fs.existsSync(lockDir), 'crash should leave stale lock');

  const immediate = start();
  assert.notEqual((await exited(immediate)).code, 0, 'stale lock must not be stolen too early');
  await sleep(11000);
  const recovered = start();
  await ready(recovered);
  recovered.child.kill('SIGTERM');
  await exited(recovered);

  const store = new EventStore(path.join(root, '.ade'));
  const manager = new TaskManager({ workspaceRoot: root, port: 0, host: '127.0.0.1', agents: [
    { id: 'linger', command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] },
  ] }, store);
  const running = manager.create('linger', 'abort before releasing lock');
  await manager.abortAll();
  assert.equal(store.getMeta(running.id).status, 'aborted', 'stop must await child exit');

  console.log('[lock-smoke] PASS: exclusive startup, no recovery on conflict, failed-start release, crash recovery, task drain');
} finally {
  for (const child of children) child.kill();
  await Promise.all([...children].map((child) => new Promise((resolve) => child.once('exit', resolve))));
  const target = fs.realpathSync(root);
  if (path.dirname(target) === fs.realpathSync(os.tmpdir()) && path.basename(target).startsWith('ade-lock-smoke-')) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* temp cleanup may be restricted */ }
  }
}
