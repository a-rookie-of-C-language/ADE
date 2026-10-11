import type { TaskEvent, TaskMeta, TaskStatus } from '@ade/shared';

const finished = (status: TaskStatus): boolean => status === 'completed' || status === 'failed';

// A snapshot is a baseline on first load; later snapshots can reveal work finished while disconnected.
export function observeTaskSnapshot(known: Map<string, TaskStatus>, tasks: TaskMeta[], since?: number): string[] {
  const changed: string[] = [];
  for (const task of tasks) {
    const previous = known.get(task.id);
    if (previous && previous !== 'running') continue;
    if (since !== undefined && finished(task.status) &&
      (previous === 'running' || (previous === undefined && (task.endedAt ?? 0) > since))) {
      changed.push(task.id);
    }
    known.set(task.id, task.status);
  }
  return changed;
}

export function observeTaskEvent(known: Map<string, TaskStatus>, event: TaskEvent): string | null {
  if (event.type === 'task.created' || event.type === 'task.started') {
    if (!known.has(event.taskId)) known.set(event.taskId, 'running');
    return null;
  }
  const status = event.type === 'task.completed'
    ? event.exitCode === 0 ? 'completed' : 'failed'
    : event.type === 'task.failed' ? 'failed'
    : event.type === 'task.aborted' ? 'aborted' : null;
  if (!status) return null;
  const previous = known.get(event.taskId);
  if (previous && previous !== 'running') return null;
  known.set(event.taskId, status);
  return finished(status) ? event.taskId : null;
}
