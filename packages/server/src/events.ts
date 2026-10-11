import fs from 'node:fs';
import path from 'node:path';
import type { TaskEvent, TaskMeta } from '@ade/shared';
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

  readEvents(taskId: string, limit = 500): TaskEvent[] {
    const file = path.join(this.taskDir(taskId), 'events.jsonl');
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => JSON.parse(line) as TaskEvent)
      .filter(Boolean);
  }

  /** Snapshot handed to a freshly connected client. */
  snapshotTasks(limit = 20): { meta: TaskMeta; events: TaskEvent[] }[] {
    return this.list()
      .slice(0, limit)
      .map((meta) => ({ meta, events: this.readEvents(meta.id, 100) }));
  }
}