/** Exercise Pi's print-mode stdin contract with a mock CLI in an isolated workspace. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultAgents } from '../dist/config.js';
import { EventStore } from '../dist/events.js';
import { TaskManager } from '../dist/tasks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const configured = JSON.parse(fs.readFileSync(path.join(root, 'ade.config.json'), 'utf8'))
  .agents.find((agent) => agent.id === 'pi');
const defaults = defaultAgents().find((agent) => agent.id === 'pi');
for (const agent of [configured, defaults]) {
  assert.deepEqual(agent.command, ['pi', '--print']);
  assert.equal(agent.stdin, 'prompt');
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-pi-smoke-'));
try {
  const store = new EventStore(path.join(workspace, '.ade'));
  const mock = [
    'let prompt = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => prompt += chunk);',
    'process.stdin.on("end", () => console.log(JSON.stringify({ argv: process.argv.slice(1), prompt, cwd: process.cwd() })));',
  ].join('\n');
  const tasks = new TaskManager({ workspaceRoot: workspace, port: 0, host: '127.0.0.1',
    allowedOrigins: [], agents: [{ ...configured, command: [process.execPath, '-e', mock, '--', '--print'] }] }, store);

  const prompt = '-flag @private-file\n第二行 {{prompt}}';
  const first = tasks.create('pi', prompt, '.', undefined,
    [{ agentId: 'pi', prompt: '@another-file 继续处理' }]);
  const deadline = Date.now() + 15000;
  let chain;
  while (Date.now() < deadline) {
    chain = store.list().filter((task) => task.chainId === first.id);
    if (chain.length === 2 && chain.every((task) => task.status !== 'running')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(chain?.length, 2, 'second Pi step was not launched');
  const [source, next] = chain.sort((a, b) => a.chainStep - b.chainStep);
  assert.equal(source.status, 'completed');
  assert.equal(next.status, 'completed');
  assert.equal(next.sourceTaskId, first.id);

  function output(id) {
    const events = store.readEvents(id);
    const text = events.filter((event) => event.type === 'task.output' && event.stream === 'stdout')
      .map((event) => event.data).join('');
    return { events, result: JSON.parse(text) };
  }
  const previous = output(first.id);
  const following = output(next.id);
  assert.deepEqual(previous.result.argv, ['--print']);
  assert.equal(previous.result.cwd, workspace);
  assert.equal(previous.result.prompt, prompt);
  assert.deepEqual(following.result.argv, ['--print']);
  assert.equal(following.result.cwd, workspace);
  const handoff = following.events.find((event) => event.type === 'task.handoff');
  assert.equal(handoff?.sourceTaskId, first.id);
  assert.equal(following.result.prompt, handoff.effectivePrompt);
  const context = following.result.prompt.split('\n\nNew request:\n')[0].split('\n\n').at(-1);
  assert.deepEqual(JSON.parse(JSON.parse(context).output), previous.result);
  assert.ok(following.result.prompt.includes('@another-file 继续处理'));

  assert.throws(() => new TaskManager({ workspaceRoot: workspace, port: 0, host: '127.0.0.1',
    allowedOrigins: [], agents: [{ ...configured, mode: 'pty' }] }, store).create('pi', 'invalid'),
  /Prompt stdin requires a non-interactive agent/);
  console.log('[pi-smoke] PASS: print-mode argv, stdin prompt, persisted output, chained handoff, PTY rejection');
} finally {
  const resolved = path.resolve(workspace);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('ade-pi-smoke-')) {
    throw new Error('Refusing to remove a directory outside the Pi smoke test');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
