/** Exercise HTTP/WS browser-origin and token boundaries in an isolated workspace. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { loadConfig } from '../dist/config.js';
import { EventStore } from '../dist/events.js';
import { buildApp } from '../dist/http.js';
import { TaskManager } from '../dist/tasks.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-security-smoke-'));
const savedHost = process.env.ADE_HOST;
const savedToken = process.env.ADE_TOKEN;
const savedOrigins = process.env.ADE_ALLOWED_ORIGINS;

function setEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function requestWithHost(base, host) {
  const url = new URL('/api/tasks', base);
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { host } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
}

async function wsAttempt(base, origin, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws${token ? `?token=${token}` : ''}`,
      { origin, handshakeTimeout: 3000 });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error(`WebSocket handshake timed out for ${origin}`)); }, 4000);
    socket.once('open', () => {
      socket.once('close', () => { clearTimeout(timeout); resolve(101); });
      socket.close();
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      socket.terminate();
      resolve(response.statusCode);
    });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function wsUnauthorized(base) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`,
      { origin: base, handshakeTimeout: 3000 });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Unauthorized WebSocket did not close')); }, 4000);
    socket.once('close', (code) => { clearTimeout(timeout); resolve(code); });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function testServer(token) {
  const workspaceRoot = path.join(temp, token ? 'protected' : 'local');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const config = { workspaceRoot, port: 0, host: '127.0.0.1', token,
    allowedOrigins: token ? ['https://remote.example'] : [], agents: [] };
  const store = new EventStore(path.join(workspaceRoot, '.ade'));
  const app = await buildApp({ config, store, tasks: new TaskManager(config, store) });
  const connections = new Set();
  app.server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const origin = address;
    const opts = { headers: { origin: 'https://attacker.example',
      ...(token ? { authorization: `Bearer ${token}` } : {}) } };
    const hostile = await fetch(`${address}/api/tasks`, opts);
    assert.equal(hostile.status, 403);
    assert.equal(hostile.headers.get('access-control-allow-origin'), null);
    const preflight = await fetch(`${address}/api/tasks`, { method: 'OPTIONS',
      headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.status, 403);
    assert.equal(await wsAttempt(address, 'https://attacker.example', token), 403);
    assert.equal(await wsAttempt(address, origin, token), 101);
    assert.equal(await wsAttempt(address, 'http://localhost:5173', token), 101);
    const normal = await fetch(`${address}/api/tasks`, { headers: {
      origin, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    assert.equal(normal.status, 200);
    if (token) {
      assert.equal((await fetch(`${address}/api/tasks?token=${token}`)).status, 401);
      assert.equal(await wsUnauthorized(address), 4001);
      const trusted = await fetch(`${address}/api/tasks`, { headers: {
        origin: 'https://remote.example', authorization: `Bearer ${token}` } });
      assert.equal(trusted.status, 200);
      assert.equal(await wsAttempt(address, 'https://remote.example', token), 101);
    } else {
      assert.equal(await requestWithHost(address, 'attacker.example'), 403);
    }
  } finally {
    for (const socket of connections) socket.destroy();
    app.server.closeAllConnections();
    await app.close();
  }
}

try {
  setEnv('ADE_HOST', '0.0.0.0');
  setEnv('ADE_TOKEN', undefined);
  setEnv('ADE_ALLOWED_ORIGINS', undefined);
  assert.throws(() => loadConfig(path.join(temp, 'nonexistent.json')), /ADE_TOKEN is required/);
  setEnv('ADE_HOST', '127.0.0.1');
  assert.equal(loadConfig(path.join(temp, 'nonexistent.json')).host, '127.0.0.1');
  setEnv('ADE_ALLOWED_ORIGINS', 'https://remote.example');
  assert.throws(() => loadConfig(path.join(temp, 'nonexistent.json')), /ADE_TOKEN is required/);
  setEnv('ADE_TOKEN', 'test-secret');
  assert.deepEqual(loadConfig(path.join(temp, 'nonexistent.json')).allowedOrigins, ['https://remote.example']);
  await testServer(undefined);
  await testServer('test-secret');
  console.log('[security-smoke] PASS: remote bind guard, origin/host rejection, API auth, WebSocket origin');
} finally {
  setEnv('ADE_HOST', savedHost);
  setEnv('ADE_TOKEN', savedToken);
  setEnv('ADE_ALLOWED_ORIGINS', savedOrigins);
  const resolved = path.resolve(temp);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(resolved).startsWith('ade-security-smoke-')) {
    throw new Error('Refusing to remove a directory outside the security smoke test');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
