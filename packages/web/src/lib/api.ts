import type { AgentDefinition, FileNode, TaskEvent, TaskMeta } from '@ade/shared';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('ade-token');
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  config: () => request<{ workspaceRoot: string; version: string }>('GET', '/api/config'),
  agents: () => request<AgentDefinition[]>('GET', '/api/agents'),
  tree: () => request<{ root: string; tree: FileNode }>('GET', '/api/files/tree'),
  readFile: (path: string) =>
    request<{ path: string; content: string }>(
      'GET',
      `/api/files/content?p=${encodeURIComponent(path)}`,
    ),
  writeFile: (path: string, content: string) =>
    request<{ ok: boolean }>('PUT', '/api/files/content', { path, content }),
  tasks: () => request<{ tasks: TaskMeta[] }>('GET', '/api/tasks'),
  runTask: (agentId: string, prompt: string, cwd = '.') =>
    request<{ task: TaskMeta }>('POST', '/api/tasks', { agentId, prompt, cwd }),
  abortTask: (taskId: string) => request<{ ok: boolean }>('POST', `/api/tasks/${taskId}/abort`),
  taskEvents: (taskId: string) =>
    request<{ events: TaskEvent[] }>('GET', `/api/tasks/${taskId}/events`),
};