/** Exercise ephemeral file presence with isolated server and workspace. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { EventStore } from '../dist/events.js';
import { TaskManager } from '../dist/tasks.js';
import { buildApp } from '../dist/http.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-presence-smoke-'));
fs.writeFileSync(path.join(root, 'first.txt'), 'first');
fs.writeFileSync(path.join(root, 'second.txt'), 'second');
fs.mkdirSync(path.join(root, '.ade'));
fs.writeFileSync(path.join(root, '.ade', 'private.txt'), 'private');
const config = { workspaceRoot: root, port: 0, host: '127.0.0.1', allowedOrigins: [], agents: [] };
const store = new EventStore(path.join(root, '.ade'));
const app = await buildApp({ config, store, tasks: new TaskManager(config, store) });
const clients = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(base) {
  const socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  clients.push(socket);
  const messages = [];
  socket.on('message', (data) => messages.push(JSON.parse(String(data))));
  const client = {
    socket,
    messages,
    send(path) { socket.send(JSON.stringify({ kind: 'presence.set', path })); },
    async wait(predicate, after = 0) {
      for (let i = 0; i < 250; i++) {
        const match = messages.slice(after).find(predicate);
        if (match) return match;
        await sleep(20);
      }
      throw new Error(`Timed out awaiting presence frame: ${JSON.stringify(messages.slice(after))}`);
    },
  };
  await client.wait((message) => message.kind === 'init');
  return client;
}

const count = (path, value) => (message) => message.kind === 'presence' && message.path === path && message.count === value;

try {
  const base = await app.listen({ port: 0, host: config.host });
  const a = await connect(base);
  a.send('first.txt');
  await a.wait(count('first.txt', 0));
  const b = await connect(base);
  assert.deepEqual(b.messages[0].payload.viewers, [{ path: 'first.txt', count: 1 }]);
  const markA = a.messages.length;
  b.send('first.txt');
  await a.wait(count('first.txt', 1), markA);
  await b.wait(count('first.txt', 1));

  const switched = a.messages.length;
  b.send('second.txt');
  await a.wait(count('first.txt', 0), switched);
  await a.wait(count('second.txt', 1), switched);

  const invalid = a.messages.length;
  for (const path of ['../outside.txt', '.ade/private.txt', 'first.txt/../second.txt', 'x'.repeat(1025), 123, {}, undefined]) {
    b.socket.send(JSON.stringify({ kind: 'presence.set', path }));
  }
  await sleep(150);
  assert.equal(a.messages.length, invalid, 'invalid paths changed presence');

  const disconnected = a.messages.length;
  b.socket.close();
  await a.wait(count('second.txt', 0), disconnected);
  const c = await connect(base);
  assert.deepEqual(c.messages[0].payload.viewers, [{ path: 'first.txt', count: 1 }]);
  const rejoined = a.messages.length;
  c.send('first.txt');
  await a.wait(count('first.txt', 1), rejoined);
  const afterClose = c.messages.length;
  a.socket.close();
  await c.wait(count('first.txt', 0), afterClose);

  const d = await connect(base);
  const rapid = c.messages.length;
  d.send('second.txt');
  d.send(null);
  await sleep(150);
  assert.equal(c.messages.length, rapid, 'stale path validation restored a cleared view');
  console.log('[presence-smoke] PASS: snapshot, other viewers, switch, invalid paths, disconnect, reconnect, rapid clear');
} finally {
  for (const socket of clients) socket.terminate();
  await app.close();
  const target = fs.realpathSync(root);
  if (path.dirname(target) === fs.realpathSync(os.tmpdir()) && path.basename(target).startsWith('ade-presence-smoke-')) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}
