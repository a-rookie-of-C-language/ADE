/** Isolated workspace checks for file management and path boundaries. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { EventStore } from '../dist/events.js';
import { buildApp } from '../dist/http.js';
import { TaskManager } from '../dist/tasks.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-management-smoke-'));
const root = path.join(base, 'workspace');
const outside = path.join(base, 'outside');
fs.mkdirSync(root);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
const config = { workspaceRoot: root, host: '127.0.0.1', port: 0, token: 'secret', allowedOrigins: [], agents: [] };
const store = new EventStore(path.join(root, '.ade'));
const app = await buildApp({ config, store, tasks: new TaskManager(config, store) });
const headers = { authorization: 'Bearer secret', host: '127.0.0.1:8787' };
let socket;
const messages = [];
async function expectMessage(predicate) {
  const deadline = Date.now() + 2000;
  while (!messages.some(predicate) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(messages.some(predicate), 'Expected WebSocket notification was not received');
}

async function request(method, url, body) {
  const response = await app.inject({ method, url, headers, payload: body });
  return { status: response.statusCode, data: response.json() };
}
const put = (file, content, expectedRevision) => request('PUT', '/api/files/content',
  { path: file, content, expectedRevision });
const read = (file) => request('GET', `/api/files/content?p=${encodeURIComponent(file)}`);

try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws?token=secret`, { origin: address });
  socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  assert.equal((await request('POST', '/api/files/directory', { path: 'src' })).status, 200);
  await expectMessage((msg) => msg.kind === 'tree.changed' && msg.path === 'src' && msg.action === 'add');
  assert.equal((await request('POST', '/api/files/directory', { path: 'src' })).status, 409);
  assert.equal((await request('POST', '/api/files/directory', { path: 'src/empty' })).status, 200);
  assert.equal((await request('DELETE', '/api/files/directory', { path: 'src/empty' })).status, 200);
  await expectMessage((msg) => msg.kind === 'tree.changed' && msg.path === 'src/empty' && msg.action === 'unlink');
  assert.equal((await request('DELETE', '/api/files/directory', { path: 'src/empty' })).status, 404);
  const created = await put('src/first.txt', 'v1', null);
  assert.equal((await request('DELETE', '/api/files/directory', { path: 'src' })).status, 409);
  assert.equal((await request('DELETE', '/api/files/directory', { path: 'src/first.txt' })).status, 400);
  assert.equal((await request('DELETE', '/api/files/directory', { path: '.' })).status, 400);
  assert.equal(created.status, 200);
  assert.equal((await request('POST', '/api/files/move',
    { from: 'src/first.txt', to: 'src/second.txt' })).status, 428);
  assert.equal((await request('DELETE', '/api/files/content', { path: 'src/first.txt' })).status, 428);
  assert.equal((await request('POST', '/api/files/move',
    { from: 'src/first.txt', to: 'src/second.txt', expectedRevision: '0'.repeat(64) })).status, 409);
  await put('src/second.txt', 'existing', null);
  assert.equal((await request('POST', '/api/files/move',
    { from: 'src/first.txt', to: 'src/second.txt', expectedRevision: created.data.revision })).status, 409);
  assert.equal((await read('src/second.txt')).data.content, 'existing');
  assert.equal((await request('POST', '/api/files/move',
    { from: 'src/first.txt', to: 'src/moved.txt', expectedRevision: created.data.revision })).status, 200);
  await expectMessage((msg) => msg.kind === 'file.moved' && msg.from === 'src/first.txt' &&
    msg.to === 'src/moved.txt' && msg.revision === created.data.revision);
  assert.equal((await read('src/first.txt')).status, 404);
  assert.equal((await read('src/moved.txt')).data.content, 'v1');
  assert.equal((await request('DELETE', '/api/files/content',
    { path: 'src/moved.txt', expectedRevision: '0'.repeat(64) })).status, 409);
  assert.equal((await request('DELETE', '/api/files/content',
    { path: 'src/moved.txt', expectedRevision: created.data.revision })).status, 200);
  assert.equal((await read('src/moved.txt')).status, 404);
  const racing = await put('src/racing.txt', 'original', null);
  const outcomes = await Promise.all([
    request('POST', '/api/files/move', { from: 'src/racing.txt', to: 'src/renamed.txt', expectedRevision: racing.data.revision }),
    request('DELETE', '/api/files/content', { path: 'src/racing.txt', expectedRevision: racing.data.revision }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [200, 409]);
  assert.equal(fs.existsSync(path.join(root, 'src/racing.txt')), false);
  assert.equal((await request('POST', '/api/files/directory', { path: '.ade/injected' })).status, 400);
  assert.equal((await request('POST', '/api/files/directory', { path: '../outside/secret.txt' })).status, 400);

  try {
    fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    console.log('[file-management-smoke] SKIP: symlink creation requires permission');
  }
  if (fs.existsSync(path.join(root, 'linked'))) {
    assert.equal((await read('linked/secret.txt')).status, 400);
    assert.equal((await put('linked/new.txt', 'bad', null)).status, 400);
    assert.equal((await put('linked/secret.txt', 'bad', null)).status, 400);
    assert.equal((await request('POST', '/api/files/directory', { path: 'linked/folder' })).status, 400);
    assert.equal((await request('DELETE', '/api/files/directory', { path: 'linked' })).status, 400);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
    assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  }
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linked-file.txt'), 'file');
    assert.equal((await read('linked-file.txt')).status, 400);
    assert.equal((await put('linked-file.txt', 'bad', null)).status, 400);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    console.log('[file-management-smoke] SKIP: file symlink creation requires permission');
  }
  console.log('[file-management-smoke] PASS: create, move notifications, empty-folder deletion, collision, stale revisions, path boundaries');
} finally {
  socket?.terminate();
  await app.close();
  const resolved = path.resolve(base);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(resolved).startsWith('ade-management-smoke-')) {
    throw new Error('Refusing to remove a directory outside the file management smoke test');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
