import fs from 'node:fs';
import path from 'node:path';
import { CHAIN_RESTART_GAP_REASON, type TaskEvent, type TaskMeta } from '@ade/shared';
import { HttpError, isUuid } from './paths.js';

/**
 * Append-only event store: one directory per task under `<workspace>/.ade/tasks/`,
 * containing `meta.json` and `events.jsonl`. This is the audit log / replay source
 * and the foundation for the checkpoint features planned in later milestones.
 */
export class EventStore {
  private readonly tasksDir: string;

  constructor(baseDir: string) {
    this.tasksDir = path.join(baseDir, 'tasks');
    fs.mkdirSync(this.tasksDir, { recursive: true });
  }

  recoverInterruptedTasks(): void {
    const metas = this.list();
    const children = new Set(metas.map((meta) => meta.sourceTaskId).filter(Boolean));
    for (const meta of metas) {
      if (meta.approval === 'pending' && !this.readEvents(meta.id).some((event) => event.type === 'task.approval.requested')) {
        this.appendEvent(meta.id, { type: 'task.approval.requested', taskId: meta.id, ts: Date.now() });
      }
      if (meta.status === 'completed' && meta.exitCode === 0 &&
          meta.approval !== 'pending' && meta.approval !== 'rejected' &&
          meta.nextSteps?.length && (!meta.nextSteps[0].requiresApproval || meta.approval === 'approved') && !children.has(meta.id) &&
          !this.readEvents(meta.id).some((event) => event.type === 'task.chain.stopped')) {
        this.appendEvent(meta.id, { type: 'task.chain.stopped', taskId: meta.id,
          reason: CHAIN_RESTART_GAP_REASON, cause: 'restart-gap',
          skipped: meta.nextSteps.length, ts: Date.now() });
      }
      if (meta.status !== 'running') continue;
      const ts = Date.now();
      this.writeMeta({ ...meta, status: 'failed', endedAt: ts });
      this.appendEvent(meta.id, {
        type: 'task.failed', taskId: meta.id,
        error: 'ADE server restarted while this task was running', ts,
      });
      if (meta.nextSteps?.length) {
        this.appendEvent(meta.id, { type: 'task.chain.stopped', taskId: meta.id,
          reason: 'ADE server restarted while this task was running', skipped: meta.nextSteps.length, ts });
      }
    }
  }

  private taskDir(taskId: string): string {
    if (!isUuid(taskId)) throw new HttpError(400, 'Invalid task id');
    return path.join(this.tasksDir, taskId);
  }

  writeMeta(meta: TaskMeta): void {
    const dir = this.taskDir(meta.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  }

  appendEvent(taskId: string, event: TaskEvent): void {
    const dir = this.taskDir(taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
  }

  list(): TaskMeta[] {
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(this.tasksDir);
    } catch {
      return [];
    }
    const metas: TaskMeta[] = [];
    for (const id of ids) {
      if (!isUuid(id)) continue;
      try {
        const raw = fs.readFileSync(path.join(this.tasksDir, id, 'meta.json'), 'utf8');
        metas.push(JSON.parse(raw) as TaskMeta);
      } catch {
        // ignore partially written / unknown dirs
      }
    }
    return metas.sort((a, b) => b.createdAt - a.createdAt);
  }

  getMeta(taskId: string): TaskMeta {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.taskDir(taskId), 'meta.json'), 'utf8')) as TaskMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'Source task not found');
      throw err;
    }
  }

  /** Export the complete append-only log without buffering it in server memory. */
  streamEvents(taskId: string): fs.ReadStream {
    this.getMeta(taskId);
    const file = path.join(this.taskDir(taskId), 'events.jsonl');
    if (!fs.existsSync(file)) throw new HttpError(404, 'Task event log not found');
    return fs.createReadStream(file);
  }

  readEvents(taskId: string, limit = 500): TaskEvent[] {
    const file = path.join(this.taskDir(taskId), 'events.jsonl');
    if (limit <= 0) return [];
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      const end = fs.fstatSync(fd).size;
      if (!end) return [];
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const readFully = (buffer: Buffer, length: number, position: number): void => {
        let offset = 0;
        while (offset < length) {
          const count = fs.readSync(fd, buffer, offset, length - offset, position + offset);
          if (!count) throw new Error('Task event log changed while reading');
          offset += count;
        }
      };
      let cursor = end;
      let start = 0;
      let separators = 0;
      while (cursor > 0 && separators < limit) {
        const length = Math.min(chunk.length, cursor);
        cursor -= length;
        readFully(chunk, length, cursor);
        for (let index = length - 1; index >= 0; index--) {
          if (chunk[index] !== 10 || cursor + index === end - 1) continue;
          if (++separators === limit) {
            start = cursor + index + 1;
            break;
          }
        }
      }
      const data = Buffer.allocUnsafe(end - start);
      readFully(data, data.length, start);
      return data.toString('utf8').split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as TaskEvent);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Snapshot handed to a freshly connected client. */
  snapshotTasks(limit = 20): { meta: TaskMeta; events: TaskEvent[] }[] {
    return this.list()
      .slice(0, limit)
      .map((meta) => ({ meta, events: this.readEvents(meta.id, 100) }));
  }
}
