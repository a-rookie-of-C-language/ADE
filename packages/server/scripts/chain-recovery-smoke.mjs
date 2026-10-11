/** Exercise manual restart-gap recovery through HTTP in an isolated workspace. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../dist/events.js';
import { TaskManager } from '../dist/tasks.js';
import { buildApp } from '../dist/http.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-chain-recovery-'));
let app;
try {
  const store = new EventStore(path.join(workspace, '.ade'));
  const config = {
    workspaceRoot: workspace, host: '127.0.0.1', port: 0, allowedOrigins: [],
    agents: [{ id: 'next', label: 'Next', command: [process.execPath, '-e', 'console.log("next output")'] }],
  };

  function parent({ status = 'completed', approval, requiresApproval = false, output = true, exitCode = 0 } = {}) {
    const id = crypto.randomUUID();
    store.writeMeta({ id, agentId: 'next', prompt: 'before restart', cwd: '.', mode: 'exec',
      status, approval, exitCode, createdAt: Date.now(), endedAt: Date.now(), chainId: id,
      chainStep: 1, chainTotal: 2,
      nextSteps: [{ agentId: 'next', prompt: 'after restart', ...(requiresApproval ? { requiresApproval: true } : {}) }] });
    if (output) store.appendEvent(id, { type: 'task.output', taskId: id, stream: 'stdout', data: 'prior output', ts: Date.now() });
    if (status === 'completed') store.appendEvent(id, { type: 'task.completed', taskId: id, exitCode, ts: Date.now() });
    if (approval === 'approved') store.appendEvent(id, { type: 'task.approval.resolved', taskId: id, decision: 'approved', ts: Date.now() });
    return id;
  }

  const interrupted = parent();
  const approved = parent({ approval: 'approved', requiresApproval: true });
  const pending = parent({ approval: 'pending', requiresApproval: true });
  const rejected = parent({ approval: 'rejected', requiresApproval: true });
  const failed = parent({ status: 'failed', exitCode: 1 });
  const aborted = parent({ status: 'aborted' });
  const badExit = parent({ exitCode: 1 });
  const noApproval = parent({ requiresApproval: true });
  const noOutput = parent({ output: false });
  const alreadyStarted = parent();
  store.writeMeta({ id: crypto.randomUUID(), agentId: 'next', prompt: 'existing child', cwd: '.',
    mode: 'exec', status: 'completed', exitCode: 0, sourceTaskId: alreadyStarted, createdAt: Date.now() });
  store.recoverInterruptedTasks();
  const recovered = new EventStore(path.join(workspace, '.ade'));
  recovered.recoverInterruptedTasks();
  assert.equal(recovered.readEvents(interrupted).filter((event) => event.type === 'task.chain.stopped').length, 1);
  assert.equal(recovered.readEvents(approved).find((event) => event.cause === 'restart-gap')?.skipped, 1);
  for (const id of [pending, rejected, failed, aborted, badExit, noApproval, alreadyStarted]) {
    assert.equal(recovered.readEvents(id).some((event) => event.cause === 'restart-gap'), false, id);
  }

  const tasks = new TaskManager(config, recovered);
  app = await buildApp({ config, tasks, store: recovered });
  const resume = async (id) => {
    const response = await app.inject({ method: 'POST', url: `/api/tasks/${id}/resume`,
      headers: { host: '127.0.0.1' } });
    return { status: response.statusCode, body: response.json() };
  };
  const [first, duplicate] = await Promise.all([resume(interrupted), resume(interrupted)]);
  assert.deepEqual([first.status, duplicate.status].sort(), [200, 409]);
  const nextId = first.status === 200 ? first.body.nextTaskId : duplicate.body.nextTaskId;
  assert.equal(recovered.getMeta(nextId).sourceTaskId, interrupted);
  assert.equal(recovered.readEvents(interrupted).filter((event) => event.type === 'task.chain.resumed').length, 1);
  assert.equal((await resume(interrupted)).status, 409);
  const approvedNext = await resume(approved);
  assert.equal(approvedNext.status, 200);
  assert.equal(recovered.getMeta(approvedNext.body.nextTaskId).sourceTaskId, approved);
  assert.equal((await resume(noOutput)).status, 409);
  assert.equal(recovered.readEvents(noOutput).filter((event) => event.type === 'task.chain.stopped').length, 2);
  assert.equal((await resume(noOutput)).status, 409);
  for (const id of [pending, rejected, failed, aborted, badExit, noApproval, alreadyStarted]) {
    assert.equal((await resume(id)).status, 409, id);
  }
  assert.equal((await resume('not-an-id')).status, 400);

  const deadline = Date.now() + 5000;
  while ([nextId, approvedNext.body.nextTaskId].some((id) => recovered.getMeta(id).status === 'running')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for resumed steps');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  console.log('[chain-recovery-smoke] PASS: restart gaps, concurrency, approvals, and invalid resumes');
} finally {
  await app?.close();
  const resolved = path.resolve(workspace);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('ade-chain-recovery-')) {
    throw new Error('Refusing to remove a directory outside the chain recovery test');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
