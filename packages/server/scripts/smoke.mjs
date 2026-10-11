/** End-to-end smoke test against a running ADE server. Usage: node smoke.mjs [baseUrl] */
const BASE = process.argv[2] ?? process.env.ADE_URL ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.ADE_TOKEN;
const headers = { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };

async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

const log = (...args) => console.log('[smoke]', ...args);

const health = await call('GET', '/health');
if (!health.ok) throw new Error('health check failed');
log('health ok');

const agents = await call('GET', '/api/agents');
if (!agents.some((a) => a.id === 'demo')) throw new Error('demo agent missing');
log(`agents: ${agents.map((a) => a.id).join(', ')}`);

const tree = await call('GET', '/api/files/tree');
log(`file tree ok, root=${tree.root}, top-level=${tree.tree.children.length}`);

const { task } = await call('POST', '/api/tasks', {
  agentId: 'demo',
  prompt: 'smoke test from ADE skeleton',
});
log(`task created: ${task.id}`);

const deadline = Date.now() + 20000;
let events = [];
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 400));
  ({ events } = await call('GET', `/api/tasks/${task.id}/events`));
  const last = events.at(-1);
  if (last && (last.type === 'task.completed' || last.type === 'task.failed' || last.type === 'task.aborted')) break;
}

const outputs = events.filter((e) => e.type === 'task.output');
log(`events: ${events.length}, output lines: ${outputs.length}`);
for (const line of outputs) process.stdout.write('  ' + line.data);

const finished = events.some((e) => e.type === 'task.completed' && e.exitCode === 0);
if (!finished) {
  console.error('[smoke] FAIL: demo task did not complete successfully');
  process.exit(1);
}
log('PASS: health / agents / tree / task dispatch / event stream');