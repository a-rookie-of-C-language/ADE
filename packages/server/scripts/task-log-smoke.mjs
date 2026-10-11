/** Verify the full task log is downloadable with auth, even beyond the UI replay window. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../dist/events.js';
import { TaskManager } from '../dist/tasks.js';
import { buildApp } from '../dist/http.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-task-log-smoke-'));
let app;
try {
  const token = crypto.randomUUID();
  const config = { workspaceRoot: workspace, host: '127.0.0.1', port: 0,
    token, allowedOrigins: [], agents: [] };
  const store = new EventStore(path.join(workspace, '.ade'));
  app = await buildApp({ config, tasks: new TaskManager(config, store), store });
  const id = crypto.randomUUID();
  store.writeMeta({ id, agentId: 'demo', prompt: 'long run', cwd: '.',
    status: 'completed', createdAt: Date.now(), endedAt: Date.now(), exitCode: 0 });
  store.appendEvent(id, { type: 'task.output', taskId: id, stream: 'stdout',
    data: 'prefix'.repeat(500000), ts: -1 });
  for (let index = 0; index < 2105; index++) {
    store.appendEvent(id, { type: 'task.output', taskId: id, stream: 'stdout',
      data: `line ${index}\n`, ts: index });
  }

  const get = (url, authorized = true) => app.inject({ method: 'GET', url,
    headers: { host: '127.0.0.1', ...(authorized ? { authorization: `Bearer ${token}` } : {}) } });
  assert.equal((await get(`/api/tasks/${id}/log`, false)).statusCode, 401);
  assert.equal((await get('/api/tasks/invalid/log')).statusCode, 400);
  assert.equal((await get(`/api/tasks/${crypto.randomUUID()}/log`)).statusCode, 404);

  const originalReadFile = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (String(file).endsWith('events.jsonl')) throw new Error('Unbounded event log read');
    return originalReadFile(file, ...args);
  };
  try {
    assert.deepEqual(store.readEvents(id, 0), []);
    assert.equal(store.readEvents(id, 1)[0].data, 'line 2104\n');
    assert.equal(store.readEvents(id, 2000)[0].data, 'line 105\n');
    assert.equal(store.readEvents(id, 3000)[0].data.length, 3000000);
  } finally {
    fs.readFileSync = originalReadFile;
  }

  const replay = await get(`/api/tasks/${id}/events`);
  assert.equal(replay.json().events.length, 2000);
  const log = await get(`/api/tasks/${id}/log`);
  assert.equal(log.statusCode, 200);
  assert.match(log.headers['content-type'], /^application\/x-ndjson/);
  assert.equal(log.headers['cache-control'], 'no-store');
  assert.match(log.headers['content-disposition'], new RegExp(`ade-task-${id}\\.jsonl`));
  const rows = log.body.trimEnd().split('\n').map((row) => JSON.parse(row));
  assert.equal(rows.length, 2106);
  assert.equal(rows[0].data.length, 3000000);
  assert.equal(rows[1].data, 'line 0\n');
  assert.equal(rows.at(-1).data, 'line 2104\n');
  console.log('[task-log-smoke] PASS: bounded tail reads, complete streamed log, auth and invalid ids');
} finally {
  await app?.close();
  const resolved = path.resolve(workspace);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('ade-task-log-smoke-')) {
    throw new Error('Refusing to remove a directory outside the task log smoke test');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
