import type { AgentInfo, ChainStep, FileNode, GitChanges, GitDiff, TaskEvent, TaskMeta } from '@ade/shared';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('ade-token');
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ApiError(res.status, `${res.status} ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export const api = {
  config: () => request<{ workspaceRoot: string; version: string }>('GET', '/api/config'),
  agents: () => request<AgentInfo[]>('GET', '/api/agents'),
  pushConfig: () => request<{ publicKey: string | null }>('GET', '/api/push/config'),
  subscribePush: (subscription: PushSubscriptionJSON) =>
    request<{ ok: boolean }>('POST', '/api/push/subscriptions', subscription),
  unsubscribePush: (endpoint: string) =>
    request<{ ok: boolean }>('DELETE', '/api/push/subscriptions', { endpoint }),
  tree: () => request<{ root: string; tree: FileNode }>('GET', '/api/files/tree'),
  readFile: (path: string) =>
    request<{ path: string; content: string; revision: string }>(
      'GET',
      `/api/files/content?p=${encodeURIComponent(path)}`,
    ),
  writeFile: (path: string, content: string, expectedRevision: string | null) =>
    request<{ ok: boolean; revision: string }>('PUT', '/api/files/content', { path, content, expectedRevision }),
  createDirectory: (path: string) => request<{ ok: boolean }>('POST', '/api/files/directory', { path }),
  deleteDirectory: (path: string) => request<{ ok: boolean }>('DELETE', '/api/files/directory', { path }),
  moveFile: (from: string, to: string, expectedRevision: string) =>
    request<{ ok: boolean }>('POST', '/api/files/move', { from, to, expectedRevision }),
  deleteFile: (path: string, expectedRevision: string) =>
    request<{ ok: boolean }>('DELETE', '/api/files/content', { path, expectedRevision }),
  gitChanges: () => request<GitChanges>('GET', '/api/git/changes'),
  gitDiff: (path: string, side: 'staged' | 'working') =>
    request<GitDiff>('GET', `/api/git/diff?p=${encodeURIComponent(path)}&side=${side}`),
  updateGitIndex: (path: string, action: 'stage' | 'unstage', expectedRevision: string) =>
    request<{ ok: boolean }>('POST', '/api/git/index', { path, action, expectedRevision }),
  tasks: () => request<{ tasks: TaskMeta[] }>('GET', '/api/tasks'),
  runTask: (agentId: string, prompt: string, sourceTaskId?: string, nextSteps?: ChainStep[], cwd = '.') =>
    request<{ task: TaskMeta }>('POST', '/api/tasks', { agentId, prompt, cwd, sourceTaskId, nextSteps }),
  abortTask: (taskId: string) => request<{ ok: boolean }>('POST', `/api/tasks/${taskId}/abort`),
  resolveApproval: (taskId: string, decision: 'approve' | 'reject') =>
    request<{ ok: boolean; nextTaskId: string | null }>('POST', `/api/tasks/${taskId}/approval`, { decision }),
  resumeChain: (taskId: string) =>
    request<{ ok: boolean; nextTaskId: string }>('POST', `/api/tasks/${taskId}/resume`),
  taskEvents: (taskId: string) =>
    request<{ events: TaskEvent[] }>('GET', `/api/tasks/${taskId}/events`),
  downloadTaskLog: async (taskId: string): Promise<void> => {
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/log`, { headers: authHeaders() });
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${await res.text().catch(() => res.statusText)}`);
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `ade-task-${taskId}.jsonl`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
