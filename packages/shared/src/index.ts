/** Shared types for the ADE server, web client and future tooling. */

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  id: string;
  label: string;
  description?: string;
  /** argv template; "{{prompt}}" and "{{workspace}}" are substituted per task */
  command: string[];
  /** working directory relative to the workspace root */
  cwd?: string;
  env?: Record<string, string>;
  /** 'closed' (default) sends EOF right after spawn — right for one-shot CLIs like codex exec / claude -p; 'open' keeps stdin for future interactive agents */
  stdin?: 'open' | 'closed';
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Tasks & events (append-only, JSONL per task)
// ---------------------------------------------------------------------------

export type TaskStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface TaskMeta {
  id: string;
  agentId: string;
  prompt: string;
  cwd: string;
  status: TaskStatus;
  createdAt: number;
  endedAt?: number;
  exitCode?: number | null;
}

export type TaskEvent =
  | { type: 'task.created'; taskId: string; agentId: string; prompt: string; cwd: string; ts: number }
  | { type: 'task.started'; taskId: string; pid?: number; ts: number }
  | { type: 'task.output'; taskId: string; stream: 'stdout' | 'stderr'; data: string; ts: number }
  | { type: 'task.completed'; taskId: string; exitCode: number | null; ts: number }
  | { type: 'task.failed'; taskId: string; error: string; ts: number }
  | { type: 'task.aborted'; taskId: string; ts: number };

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface FileNode {
  name: string;
  /** workspace-relative POSIX-style path ('' for the root) */
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface FileChangeEvent {
  type: 'file.changed';
  path: string;
  action: 'add' | 'change' | 'unlink';
  ts: number;
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

export interface InitPayload {
  agents: AgentDefinition[];
  tasks: { meta: TaskMeta; events: TaskEvent[] }[];
  workspaceRoot: string;
  serverTime: number;
}

export type ServerMessage =
  | { kind: 'init'; payload: InitPayload }
  | { kind: 'task'; event: TaskEvent }
  | { kind: 'file'; event: FileChangeEvent }
  | { kind: 'pong'; ts: number };

export type ClientMessage =
  | { kind: 'ping'; ts: number }
  | { kind: 'task.input'; taskId: string; data: string }
  | { kind: 'task.abort'; taskId: string };

/** Fold a task event into a TaskMeta (used by clients to keep lists in sync). */
export function applyTaskEvent(meta: TaskMeta, event: TaskEvent): TaskMeta {
  if (event.taskId !== meta.id) return meta;
  switch (event.type) {
    case 'task.started':
      return { ...meta, status: 'running' };
    case 'task.completed':
      return {
        ...meta,
        status: event.exitCode === 0 ? 'completed' : 'failed',
        exitCode: event.exitCode,
        endedAt: event.ts,
      };
    case 'task.failed':
      return { ...meta, status: 'failed', endedAt: event.ts };
    case 'task.aborted':
      return { ...meta, status: 'aborted', endedAt: event.ts };
    default:
      return meta;
  }
}