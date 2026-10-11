import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import type { TaskEvent, TaskMeta } from '@ade/shared';
import type { AdeConfig } from './config.js';
import type { EventStore } from './events.js';
import { HttpError, toAbsoluteDir } from './paths.js';

interface RunningTask {
  meta: TaskMeta;
  child: ChildProcess;
  aborted: boolean;
}

/**
 * TaskManager runs agent CLIs (codex / claude / pi / ...) as managed child
 * processes inside the workspace. M0 uses stdio pipes which is perfect for
 * headless modes (`codex exec`, `claude -p`); interactive TUI support via
 * node-pty is planned for M1.
 */
export class TaskManager {
  private readonly running = new Map<string, RunningTask>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();

  constructor(
    private readonly config: AdeConfig,
    private readonly store: EventStore,
  ) {}

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): TaskMeta[] {
    return this.store.list();
  }

  create(agentId: string, rawPrompt: string, cwd = '.'): TaskMeta {
    const agent = this.config.agents.find((a) => a.id === agentId);
    if (!agent) throw new HttpError(400, `Unknown agent: ${agentId}`);
    if (agent.enabled === false) throw new HttpError(400, `Agent ${agentId} is disabled`);
    const prompt = rawPrompt.trim();
    if (!prompt) throw new HttpError(400, 'Prompt is required');

    const id = crypto.randomUUID();
    const absCwd = toAbsoluteDir(this.config.workspaceRoot, agent.cwd ?? cwd ?? '.');
    const meta: TaskMeta = { id, agentId, prompt, cwd, status: 'running', createdAt: Date.now() };

    this.store.writeMeta(meta);
    this.emit({ type: 'task.created', taskId: id, agentId, prompt, cwd, ts: meta.createdAt });

    const vars: Record<string, string> = {
      prompt,
      workspace: this.config.workspaceRoot,
    };
    // Single-pass substitution so that prompt content can never be re-expanded,
    // and `{{...}}` never collides with JS template literals (`${prompt}`).
    const args = agent.command
      .slice(1)
      .map((part) => part.replace(/\{\{(prompt|workspace)\}\}/g, (_, key: string) => vars[key]));
    const child = spawn(agent.command[0], args, {
      cwd: absCwd,
      env: { ...process.env, ...agent.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcess;

    // One-shot agents (codex exec / claude -p / pi) wait for stdin EOF; close it
    // unless the agent is explicitly configured with stdin: open.
    if ((agent.stdin ?? 'closed') === 'closed') child.stdin?.end();

    const record: RunningTask = { meta, child, aborted: false };
    this.running.set(id, record);
    this.emit({ type: 'task.started', taskId: id, pid: child.pid, ts: Date.now() });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => {
      this.emit({ type: 'task.output', taskId: id, stream: 'stdout', data, ts: Date.now() });
    });
    child.stderr?.on('data', (data: string) => {
      this.emit({ type: 'task.output', taskId: id, stream: 'stderr', data, ts: Date.now() });
    });
    child.on('error', (err: Error) => {
      this.finish(record, 'failed', null, err.message);
    });
    child.on('close', (code: number | null) => {
      if (record.aborted) this.finish(record, 'aborted', code);
      else this.finish(record, code === 0 ? 'completed' : 'failed', code);
    });
    return meta;
  }

  writeInput(taskId: string, data: string): void {
    const record = this.running.get(taskId);
    if (!record) throw new HttpError(404, 'Task is not running');
    record.child.stdin?.write(data);
  }

  abort(taskId: string): void {
    const record = this.running.get(taskId);
    if (!record) throw new HttpError(404, 'Task is not running');
    record.aborted = true;
    record.child.kill();
  }

  abortAll(): void {
    for (const record of this.running.values()) {
      record.aborted = true;
      record.child.kill();
    }
  }

  private emit(event: TaskEvent): void {
    this.store.appendEvent(event.taskId, event);
    for (const listener of this.listeners) listener(event);
  }

  private finish(record: RunningTask, status: TaskMeta['status'], exitCode: number | null, error?: string): void {
    if (!this.running.has(record.meta.id)) return;
    this.running.delete(record.meta.id);
    const ts = Date.now();
    const meta: TaskMeta = { ...record.meta, status, exitCode, endedAt: ts };
    record.meta = meta;
    this.store.writeMeta(meta);
    if (status === 'aborted') {
      this.emit({ type: 'task.aborted', taskId: meta.id, ts });
    } else if (error) {
      this.emit({ type: 'task.failed', taskId: meta.id, error, ts });
    } else {
      this.emit({ type: 'task.completed', taskId: meta.id, exitCode, ts });
    }
  }
}