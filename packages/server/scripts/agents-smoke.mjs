/** Verify executable availability, REST/WS reporting, and dispatch preflight in an isolated workspace. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { agentAvailability, listAgents } from '../dist/agents.js';
import { EventStore } from '../dist/events.js';
import { TaskManager } from '../dist/tasks.js';
import { buildApp } from '../dist/http.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-agents-smoke-'));
let app;
try {
  const secret = `private-agent-secret-${Date.now()}`;
  const missing = `ade-command-missing-${secret}`;
  const agents = [
    { id: 'ready', label: 'Ready', command: [process.execPath, '-e', `console.log(process.cwd()) /* ${secret} */`],
      env: { ADE_PRIVATE_KEY: secret }, stdin: 'closed' },
    { id: 'missing', label: 'Missing', command: [missing] },
    { id: 'disabled', label: 'Disabled', enabled: false, command: [process.execPath], cwd: secret },
    { id: 'path', label: 'Path', command: ['helper'], env: { PATH: workspace } },
  ];
  const config = { workspaceRoot: workspace, host: '127.0.0.1', port: 0, allowedOrigins: [], agents };
  const store = new EventStore(path.join(workspace, '.ade'));
  const tasks = new TaskManager(config, store);
  app = await buildApp({ config, tasks, store });
  const base = await app.listen({ host: config.host, port: 0 });
  const call = async (body) => app.inject({ method: 'POST', url: '/api/tasks',
    headers: { host: '127.0.0.1' }, payload: body });

  const listed = (await app.inject({ method: 'GET', url: '/api/agents', headers: { host: '127.0.0.1' } })).json();
  assert.deepEqual(listed.map(({ id, available }) => [id, available]),
    [['ready', true], ['missing', false], ['disabled', false], ['path', false]]);
  assert.match(listed[1].unavailableReason, /Executable not found/);
  assert.equal(JSON.stringify(listed).includes(secret), false, 'server-only config leaked through REST');
  assert.deepEqual(Object.keys(listed[0]).sort(), ['available', 'id', 'label']);
  assert.deepEqual(Object.keys(listed[1]).sort(), ['available', 'id', 'label', 'unavailableReason']);
  assert.deepEqual(Object.keys(listed[2]).sort(), ['available', 'enabled', 'fixedWorkingDirectory', 'id', 'label', 'unavailableReason']);
  assert.equal(listed[2].fixedWorkingDirectory, true);
  assert.equal(agentAvailability({ id: 'relative', label: 'Relative', command: ['./helper'] }, workspace).available, false);
  assert.equal(agentAvailability({ id: 'bad', label: 'Bad', command: ['helper'], cwd: '../outside' }, workspace).available, false);
  assert.equal(agentAvailability({ id: 'wrong-path', label: 'Wrong PATH', command: ['node'],
    env: { PATH: workspace } }, workspace).available, false);

  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  try {
    const init = await new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(JSON.parse(String(data))));
      socket.once('error', reject);
    });
    assert.equal(init.kind, 'init');
    assert.deepEqual(init.payload.agents, listed);
    assert.equal(JSON.stringify(init.payload.agents).includes(secret), false, 'server-only config leaked through WebSocket');
  } finally {
    socket.close();
  }

  assert.equal((await call({ agentId: 'missing', prompt: 'run' })).statusCode, 503);
  assert.equal((await call({ agentId: 'ready', prompt: 'run', nextSteps: [
    { agentId: 'missing', prompt: 'next' },
  ] })).statusCode, 503);
  assert.equal(store.list().length, 0, 'missing executables must not create task records');

  fs.mkdirSync(path.join(workspace, 'scope'));
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'not a directory');
  assert.equal((await call({ agentId: 'ready', prompt: 'run', cwd: 'file.txt' })).statusCode, 400);
  assert.equal((await call({ agentId: 'ready', prompt: 'run', cwd: 'missing' })).statusCode, 400);
  assert.equal((await call({ agentId: 'ready', prompt: 'run', cwd: '../outside' })).statusCode, 400);
  assert.equal((await call({ agentId: 'ready', prompt: 'run', cwd: 42 })).statusCode, 400);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-agents-outside-'));
  try {
    fs.symlinkSync(outside, path.join(workspace, 'scope', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await call({ agentId: 'ready', prompt: 'run', cwd: 'scope/linked' })).statusCode, 400);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
  assert.equal(store.list().length, 0, 'invalid working directories must not create task records');

  const helper = path.join(workspace, process.platform === 'win32' ? 'helper.cmd' : 'helper');
  fs.writeFileSync(helper, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n');
  if (process.platform !== 'win32') fs.chmodSync(helper, 0o755);
  assert.equal(listAgents(config).find((agent) => agent.id === 'path')?.available, true,
    'availability must refresh after a CLI is installed');
  assert.equal(agentAvailability({ id: 'relative', label: 'Relative', command: ['./helper'] }, workspace).available, true);
  const nested = path.join(workspace, 'nested');
  fs.mkdirSync(nested);
  fs.copyFileSync(helper, path.join(nested, path.basename(helper)));
  if (process.platform !== 'win32') fs.chmodSync(path.join(nested, path.basename(helper)), 0o755);
  assert.equal(agentAvailability({ id: 'relative', label: 'Relative', command: ['./helper'] }, workspace, 'nested').available, true);
  if (process.platform === 'win32') {
    assert.equal(agentAvailability({ id: 'terminal', label: 'Terminal', mode: 'pty',
      command: ['helper'], env: { PATH: workspace } }, workspace).available, false);
  }

  const launched = await call({ agentId: 'ready', prompt: 'run' });
  assert.equal(launched.statusCode, 201);
  const deadline = Date.now() + 8000;
  while (store.getMeta(launched.json().task.id).status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(store.getMeta(launched.json().task.id).status, 'completed');
  const scoped = await call({ agentId: 'ready', prompt: 'first', cwd: 'scope', nextSteps: [
    { agentId: 'ready', prompt: 'second' },
  ] });
  assert.equal(scoped.statusCode, 201);
  const chainId = scoped.json().task.id;
  const chainDeadline = Date.now() + 10000;
  let chain;
  do {
    chain = store.list().filter((task) => task.chainId === chainId);
    if (chain.length === 2 && chain.every((task) => task.status !== 'running')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < chainDeadline);
  assert.equal(chain.length, 2, 'Chain must spawn a second task');
  for (const task of chain) {
    assert.equal(task.status, 'completed');
    assert.equal(task.cwd, 'scope');
    assert(store.readEvents(task.id).some((event) => event.type === 'task.output' &&
      event.data.trim() === path.join(workspace, 'scope')), 'Chain step ran outside selected directory');
  }
  console.log('[agents-smoke] PASS: availability, config privacy, cwd containment, scoped chain execution');
} finally {
  await app?.close();
  const resolved = path.resolve(workspace);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('ade-agents-smoke-')) {
    throw new Error('Refusing to remove a directory outside the agents smoke test');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
