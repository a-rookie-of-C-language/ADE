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
  /** 'closed' (default) sends EOF; 'prompt' writes the effective prompt then EOF; 'open' keeps stdin writable */
  stdin?: 'open' | 'closed' | 'prompt';
  mode?: 'exec' | 'pty';
  enabled?: boolean;
}

/** Public browser view; server-only command, env, cwd and stdin stay private. */
export interface AgentInfo extends Pick<AgentDefinition, 'id' | 'label' | 'description' | 'mode' | 'enabled'> {
  available: boolean;
  unavailableReason?: string;
  /** The server pins this agent to a configured working directory; the path stays private. */
  fixedWorkingDirectory?: boolean;
}

// ---------------------------------------------------------------------------
// Tasks & events (append-only, JSONL per task)
// ---------------------------------------------------------------------------

export type TaskStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface ChainStep {
  agentId: string;
  prompt: string;
  requiresApproval?: boolean;
}

export interface TaskMeta {
  id: string;
  agentId: string;
  prompt: string;
  sourceTaskId?: string;
  chainId?: string;
  chainStep?: number;
  chainTotal?: number;
  nextSteps?: ChainStep[];
  approval?: 'pending' | 'approved' | 'rejected';
  cwd: string;
  mode?: 'exec' | 'pty';
  status: TaskStatus;
  createdAt: number;
  endedAt?: number;
  exitCode?: number | null;
}

export const CHAIN_RESTART_GAP_REASON = 'ADE server restarted before the next step was recorded';

export type TaskEvent =
  | { type: 'task.created'; taskId: string; agentId: string; prompt: string; sourceTaskId?: string; chainId?: string; chainStep?: number; chainTotal?: number; nextSteps?: ChainStep[]; cwd: string; mode?: 'exec' | 'pty'; ts: number }
  | { type: 'task.handoff'; taskId: string; sourceTaskId: string; effectivePrompt: string; truncated: boolean; ts: number }
  | { type: 'task.started'; taskId: string; pid?: number; ts: number }
  | { type: 'task.output'; taskId: string; stream: 'stdout' | 'stderr' | 'pty'; data: string; ts: number }
  | { type: 'task.completed'; taskId: string; exitCode: number | null; ts: number }
  | { type: 'task.failed'; taskId: string; error: string; ts: number }
  | { type: 'task.aborted'; taskId: string; ts: number }
  | { type: 'task.chain.stopped'; taskId: string; reason: string; skipped: number; cause?: 'restart-gap'; ts: number }
  | { type: 'task.chain.resumed'; taskId: string; nextTaskId: string; ts: number }
  | { type: 'task.approval.requested'; taskId: string; ts: number }
  | { type: 'task.approval.resolved'; taskId: string; decision: 'approved' | 'rejected'; ts: number };

/** A restart gap is the only stopped chain that can be continued without rerunning a step. */
export function canResumeChain(meta: TaskMeta, events: TaskEvent[], hasChild: boolean): boolean {
  if (meta.status !== 'completed' || meta.exitCode !== 0 || !meta.nextSteps?.length || hasChild) return false;
  if (meta.approval === 'pending' || meta.approval === 'rejected' ||
      (meta.nextSteps[0].requiresApproval && meta.approval !== 'approved')) return false;
  const lastStop = events.filter((event) => event.type === 'task.chain.stopped').at(-1);
  return !!lastStop && (lastStop.cause === 'restart-gap' || lastStop.reason === CHAIN_RESTART_GAP_REASON) &&
    !events.some((event) => event.type === 'task.chain.resumed');
}

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

export interface GitChange {
  path: string;
  previousPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  working: boolean;
  conflicted: boolean;
}

export interface GitChanges {
  available: boolean;
  changes: GitChange[];
}

export interface GitDiff {
  path: string;
  side: 'staged' | 'working';
  original: string;
  modified: string;
  revision: string;
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

export interface InitPayload {
  agents: AgentInfo[];
  tasks: { meta: TaskMeta; events: TaskEvent[] }[];
  workspaceRoot: string;
  serverTime: number;
  /** Number of other live connections viewing each file; ephemeral, not an edit lock. */
  viewers: { path: string; count: number }[];
}

export type ServerMessage =
  | { kind: 'init'; payload: InitPayload }
  | { kind: 'task'; event: TaskEvent }
  | { kind: 'file'; event: FileChangeEvent }
  | { kind: 'file.moved'; from: string; to: string; revision: string }
  | { kind: 'tree.changed'; path: string; action: 'add' | 'unlink' }
  | { kind: 'presence'; path: string; count: number }
  | { kind: 'pong'; ts: number };

export type ClientMessage =
  | { kind: 'ping'; ts: number }
  | { kind: 'task.input'; taskId: string; data: string }
  | { kind: 'task.resize'; taskId: string; cols: number; rows: number }
  | { kind: 'task.abort'; taskId: string }
  | { kind: 'presence.set'; path: string | null };

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
    case 'task.approval.requested':
      return { ...meta, approval: 'pending' };
    case 'task.approval.resolved':
      return { ...meta, approval: event.decision };
    default:
      return meta;
  }
}
