/** Verify sequential agent chains against a running ADE server and a failing local process. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../dist/events.js';
import { TaskManager } from '../dist/tasks.js';

const base = process.argv[2] ?? process.env.ADE_URL ?? 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json',
  ...(process.env.ADE_TOKEN ? { authorization: `Bearer ${process.env.ADE_TOKEN}` } : {}) };

async function call(method, route, body) {
  const response = await fetch(new URL(route, base), { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

async function waitFor(condition, label, timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const first = await call('POST', '/api/tasks', {
  agentId: 'demo', prompt: 'chain first', nextSteps: [
    { agentId: 'demo', prompt: 'chain second' },
    { agentId: 'demo', prompt: 'chain third' },
  ],
});
assert.equal(first.status, 201, JSON.stringify(first));
const root = first.data.task;
assert.equal(root.chainId, root.id);
assert.equal(root.chainTotal, 3);

const chain = await waitFor(async () => {
  const { data } = await call('GET', '/api/tasks');
  const members = data.tasks.filter((task) => task.chainId === root.id);
  return members.length === 3 && members.every((task) => task.status === 'completed') ? members : null;
}, 'three completed chain steps');
for (const step of [1, 2, 3]) {
  const task = chain.find((item) => item.chainStep === step);
  assert.ok(task, `missing step ${step}`);
  assert.equal(task.chainTotal, 3);
  if (step > 1) {
    const previous = chain.find((item) => item.chainStep === step - 1);
    assert.equal(task.sourceTaskId, previous.id);
    const { data } = await call('GET', `/api/tasks/${task.id}/events`);
    const handoff = data.events.find((event) => event.type === 'task.handoff');
    assert.ok(handoff?.effectivePrompt.includes(`chain ${['first', 'second'][step - 2]}`));
  }
}

const gated = await call('POST', '/api/tasks', { agentId: 'demo', prompt: 'gated first', nextSteps: [
  { agentId: 'demo', prompt: 'gated second', requiresApproval: true },
  { agentId: 'demo', prompt: 'gated third', requiresApproval: true },
] });
assert.equal(gated.status, 201);
const gatedRoot = gated.data.task.id;
await waitFor(async () => {
  const { data } = await call('GET', '/api/tasks');
  return data.tasks.find((task) => task.id === gatedRoot)?.approval === 'pending';
}, 'first approval');
assert.equal((await call('GET', '/api/tasks')).data.tasks.filter((task) => task.chainId === gatedRoot).length, 1);
assert.equal((await call('POST', `/api/tasks/${gatedRoot}/approval`, { decision: 'invalid' })).status, 400);
const approved = await call('POST', `/api/tasks/${gatedRoot}/approval`, { decision: 'approve' });
assert.equal(approved.status, 200, JSON.stringify(approved));
assert.ok(approved.data.nextTaskId);
assert.equal((await call('POST', `/api/tasks/${gatedRoot}/approval`, { decision: 'approve' })).status, 409);
const secondId = approved.data.nextTaskId;
await waitFor(async () => {
  const { data } = await call('GET', '/api/tasks');
  return data.tasks.find((task) => task.id === secondId)?.approval === 'pending';
}, 'second approval');
const rejected = await call('POST', `/api/tasks/${secondId}/approval`, { decision: 'reject' });
assert.equal(rejected.status, 200);
assert.equal(rejected.data.nextTaskId, null);
assert.equal((await call('POST', `/api/tasks/${secondId}/approval`, { decision: 'approve' })).status, 409);
assert.equal((await call('GET', '/api/tasks')).data.tasks.filter((task) => task.chainId === gatedRoot).length, 2);
const { data: { events: approvalEvents } } = await call('GET', `/api/tasks/${secondId}/events`);
assert.deepEqual(approvalEvents.filter((event) => event.type.startsWith('task.approval.')).map((event) => event.type),
  ['task.approval.requested', 'task.approval.resolved']);
assert.equal(approvalEvents.find((event) => event.type === 'task.chain.stopped')?.skipped, 1);

for (const nextSteps of [
  [{ agentId: 'unknown', prompt: 'invalid' }],
  [{ agentId: 'terminal-demo', prompt: 'interactive' }],
  [{ agentId: 'demo', prompt: '' }],
  [{ agentId: 'demo', prompt: 'invalid approval', requiresApproval: 'yes' }],
  Array.from({ length: 4 }, () => ({ agentId: 'demo', prompt: 'too many' })),
]) {
  const result = await call('POST', '/api/tasks', { agentId: 'demo', prompt: 'rejected chain', nextSteps });
  assert.equal(result.status, 400, JSON.stringify(result));
}

const aborted = await call('POST', '/api/tasks', { agentId: 'demo', prompt: 'abort chain',
  nextSteps: [{ agentId: 'demo', prompt: 'should not run' }] });
assert.equal(aborted.status, 201);
assert.equal((await call('POST', `/api/tasks/${aborted.data.task.id}/abort`, {})).status, 200);
await waitFor(async () => {
  const { data } = await call('GET', `/api/tasks/${aborted.data.task.id}/events`);
  return data.events.find((event) => event.type === 'task.chain.stopped');
}, 'aborted chain to stop');
const listed = await call('GET', '/api/tasks');
assert.equal(listed.data.tasks.filter((task) => task.chainId === aborted.data.task.id).length, 1);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-chain-smoke-'));
try {
  const store = new EventStore(path.join(temp, '.ade'));
  const manager = new TaskManager({ workspaceRoot: temp, host: '127.0.0.1', port: 0,
    agents: [
      { id: 'fail', command: [process.execPath, '-e', 'process.exit(3)'] },
      { id: 'next', command: [process.execPath, '-e', 'process.stdout.write("unexpected")'] },
    ],
  }, store);
  const failed = manager.create('fail', 'fail first', '.', undefined,
    [{ agentId: 'next', prompt: 'never run' }]);
  const stop = await waitFor(() => store.readEvents(failed.id).find((event) => event.type === 'task.chain.stopped'),
    'failed chain to stop');
  assert.equal(stop.skipped, 1);
  assert.equal(store.list().length, 1);
  assert.equal(store.getMeta(failed.id).status, 'failed');

  const orphan = crypto.randomUUID();
  store.writeMeta({ id: orphan, agentId: 'fail', prompt: 'crash gap', cwd: '.', mode: 'exec',
    status: 'completed', createdAt: Date.now(), endedAt: Date.now(), exitCode: 0,
    chainId: orphan, chainStep: 1, chainTotal: 2, nextSteps: [{ agentId: 'next', prompt: 'lost step' }] });
  store.appendEvent(orphan, { type: 'task.completed', taskId: orphan, exitCode: 0, ts: Date.now() });
  store.recoverInterruptedTasks();
  assert.equal(store.readEvents(orphan).filter((event) => event.type === 'task.chain.stopped').length, 1);

  const pending = crypto.randomUUID();
  store.writeMeta({ id: pending, agentId: 'fail', prompt: 'waiting', cwd: '.', mode: 'exec',
    status: 'completed', approval: 'pending', createdAt: Date.now(), endedAt: Date.now(), exitCode: 0,
    chainId: pending, chainStep: 1, chainTotal: 2,
    nextSteps: [{ agentId: 'next', prompt: 'approved only', requiresApproval: true }] });
  store.appendEvent(pending, { type: 'task.output', taskId: pending, stream: 'stdout',
    data: 'source output', ts: Date.now() });
  store.recoverInterruptedTasks();
  store.recoverInterruptedTasks();
  assert.equal(store.getMeta(pending).approval, 'pending');
  assert.equal(store.readEvents(pending).filter((event) => event.type === 'task.approval.requested').length, 1);
  assert.equal(store.readEvents(pending).some((event) => event.type === 'task.chain.stopped'), false);
  const resumed = new TaskManager({ workspaceRoot: temp, host: '127.0.0.1', port: 0,
    agents: [{ id: 'next', command: [process.execPath, '-e', 'console.log("approved")'] }] }, store);
  const next = resumed.resolveApproval(pending, 'approve');
  assert.equal(next?.sourceTaskId, pending);
  await waitFor(() => store.getMeta(next.id).status === 'completed', 'approved step after recovery');
  store.recoverInterruptedTasks();
  assert.equal(store.readEvents(orphan).filter((event) => event.type === 'task.chain.stopped').length, 1);
} finally {
  const resolved = path.resolve(temp);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('ade-chain-smoke-')) {
    throw new Error('Refusing to remove a directory outside the chain smoke test');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

console.log('[chain-smoke] PASS: chained output, approvals, restart recovery, validation, abort and failure stop');
