/** Interactive PTY smoke test against a running ADE server. */
const base = process.argv[2] ?? process.env.ADE_URL ?? 'http://127.0.0.1:8787';
const token = process.env.ADE_TOKEN;
const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
const wsUrl = new URL('/ws', base);
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
if (token) wsUrl.searchParams.set('token', token);

const response = await fetch(new URL('/api/tasks', base), {
  method: 'POST', headers,
  body: JSON.stringify({ agentId: 'terminal-demo', prompt: 'PTY smoke' }),
});
if (!response.ok) throw new Error(`Task dispatch failed: ${response.status} ${await response.text()}`);
const { task } = await response.json();
console.log('[terminal-smoke] task', task.id);

const socket = new WebSocket(wsUrl);
const received = [];
let finished = false;
try {
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.onerror = () => reject(new Error('WebSocket connection failed'));
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.kind === 'init') {
          const history = message.payload.tasks.find((item) => item.meta.id === task.id)?.events ?? [];
          received.push(...history.filter((event) => event.type === 'task.output').map((event) => event.data));
          socket.send(JSON.stringify({ kind: 'task.resize', taskId: task.id, cols: 80, rows: 24 }));
          socket.send(JSON.stringify({ kind: 'task.input', taskId: task.id, data: 'exit\r' }));
        }
        if (message.kind !== 'task' || message.event.taskId !== task.id) return;
        if (message.event.type === 'task.output') received.push(message.event.data);
        if (message.event.type === 'task.completed') {
          finished = message.event.exitCode === 0;
          resolve();
        }
        if (message.event.type === 'task.failed' || message.event.type === 'task.aborted') {
          reject(new Error(`Task ended: ${message.event.type}`));
        }
      };
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for PTY')), 12000)),
  ]);
  if (!finished || !received.join('').includes('READY: type exit')) {
    throw new Error(`PTY replay or completion missing: ${JSON.stringify(received)}`);
  }
  console.log('[terminal-smoke] PASS: PTY replay, resize, remote input, completion');
} finally {
  socket.close();
  if (!finished) await fetch(new URL(`/api/tasks/${task.id}/abort`, base), { method: 'POST', headers, body: '{}' });
}
