/** Verify persisted agent-to-agent handoff against a running ADE server. */
const base = process.argv[2] ?? process.env.ADE_URL ?? 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json',
  ...(process.env.ADE_TOKEN ? { authorization: `Bearer ${process.env.ADE_TOKEN}` } : {}) };

async function call(method, route, body) {
  const response = await fetch(new URL(route, base), { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

async function finished(taskId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { data } = await call('GET', `/api/tasks/${taskId}/events`);
    if (data.events.some((event) => ['task.completed', 'task.failed', 'task.aborted'].includes(event.type))) {
      return data.events;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Task ${taskId} did not finish`);
}

const created = await call('POST', '/api/tasks', { agentId: 'demo', prompt: 'handoff source marker' });
if (created.status !== 201) throw new Error(`Source task failed: ${JSON.stringify(created)}`);
const sourceId = created.data.task.id;
const originalEvents = await finished(sourceId);
if (!originalEvents.some((event) => event.type === 'task.output' && event.data.includes('handoff source marker'))) {
  throw new Error('Source output was not captured');
}

const chained = await call('POST', '/api/tasks', {
  agentId: 'demo', prompt: 'summarize the previous result', sourceTaskId: sourceId,
});
if (chained.status !== 201 || chained.data.task.sourceTaskId !== sourceId ||
    chained.data.task.prompt !== 'summarize the previous result') {
  throw new Error(`Handoff task failed: ${JSON.stringify(chained)}`);
}
const handoffId = chained.data.task.id;
const events = await finished(handoffId);
const handoff = events.find((event) => event.type === 'task.handoff');
if (handoff?.sourceTaskId !== sourceId || !handoff.effectivePrompt.includes('handoff source marker') ||
    !handoff.effectivePrompt.includes('summarize the previous result') ||
    !events.some((event) => event.type === 'task.output' && event.data.includes('handoff source marker'))) {
  throw new Error('Effective handoff prompt did not reach the next agent or was not persisted');
}
const listed = await call('GET', '/api/tasks');
if (!listed.data.tasks.some((task) => task.id === handoffId && task.sourceTaskId === sourceId)) {
  throw new Error('Handoff lineage missing from persisted task metadata');
}
const invalid = await call('POST', '/api/tasks', { agentId: 'demo', prompt: 'should fail', sourceTaskId: 'invalid' });
if (invalid.status !== 400) throw new Error(`Invalid source task accepted: ${JSON.stringify(invalid)}`);

const terminal = await call('POST', '/api/tasks', { agentId: 'terminal-demo', prompt: 'running source' });
if (terminal.status !== 201) throw new Error(`Terminal setup failed: ${JSON.stringify(terminal)}`);
try {
  const running = await call('POST', '/api/tasks', {
    agentId: 'demo', prompt: 'should fail', sourceTaskId: terminal.data.task.id,
  });
  if (running.status !== 409) throw new Error(`Running source accepted: ${JSON.stringify(running)}`);
} finally {
  await call('POST', `/api/tasks/${terminal.data.task.id}/abort`, {});
}

console.log('[handoff-smoke] PASS: output handoff, persisted lineage and prompt, invalid/running source rejected');
