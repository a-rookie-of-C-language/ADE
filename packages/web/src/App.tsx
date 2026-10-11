import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentDefinition, FileNode, ServerMessage, TaskEvent, TaskMeta } from '@ade/shared';
import { applyTaskEvent } from '@ade/shared';
import { api } from './lib/api';
import { connectWs, type WsStatus } from './lib/ws';
import FileTree from './components/FileTree';
import EditorPane, { type OpenFile } from './components/EditorPane';
import ChatPane from './components/ChatPane';

type MobilePane = 'files' | 'editor' | 'chat';

const MAX_EVENTS_PER_TASK = 2000;

export default function App() {
  // Allow bootstrapping auth on a fresh device via https://host/?token=xxx
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) {
      localStorage.setItem('ade-token', token);
      params.delete('token');
      const query = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    }
  }, []);

  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [tree, setTree] = useState<FileNode | null>(null);
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Record<string, TaskMeta>>({});
  const [events, setEvents] = useState<Record<string, TaskEvent[]>>({});
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<WsStatus>('connecting');
  const [pane, setPane] = useState<MobilePane>('chat');
  const [selectedAgent, setSelectedAgent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const treeRefreshTimer = useRef<number | undefined>(undefined);

  // ---- initial bootstrap over REST (WS also sends an init snapshot) --------
  useEffect(() => {
    void api.agents().then((list) => {
      setAgents(list);
      setSelectedAgent((current) => current || (list.find((a) => a.enabled !== false)?.id ?? ''));
    });
    void api.tree().then((res) => setTree(res.tree));
    void api.config().then((res) => setWorkspaceRoot(res.workspaceRoot));
    void api
      .tasks()
      .then((res) => setTasks(Object.fromEntries(res.tasks.map((meta) => [meta.id, meta]))))
      .catch((err: unknown) => setError(String(err)));
  }, []);

  const refreshTree = useCallback(() => {
    if (treeRefreshTimer.current !== undefined) clearTimeout(treeRefreshTimer.current);
    treeRefreshTimer.current = window.setTimeout(() => {
      void api.tree().then((res) => setTree(res.tree)).catch(() => undefined);
    }, 400);
  }, []);

  // ---- realtime channel ----------------------------------------------------
  useEffect(() => {
    return connectWs((message: ServerMessage) => {
      if (message.kind === 'init') {
        const { payload } = message;
        setAgents(payload.agents);
        setWorkspaceRoot(payload.workspaceRoot);
        setTasks(Object.fromEntries(payload.tasks.map((t) => [t.meta.id, t.meta])));
        setEvents(Object.fromEntries(payload.tasks.map((t) => [t.meta.id, t.events])));
        setActiveTaskId((current) => current ?? payload.tasks[0]?.meta.id ?? null);
      } else if (message.kind === 'task') {
        const event = message.event;
        setEvents((prev) => {
          const next = [...(prev[event.taskId] ?? []), event];
          if (next.length <= MAX_EVENTS_PER_TASK) return { ...prev, [event.taskId]: next };
          return { ...prev, [event.taskId]: next.slice(-MAX_EVENTS_PER_TASK) };
        });
        setTasks((prev) => {
          const meta = prev[event.taskId];
          if (!meta) return prev;
          return { ...prev, [event.taskId]: applyTaskEvent(meta, event) };
        });
      } else if (message.kind === 'file') {
        refreshTree();
        const changed = message.event.path;
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.path !== changed || tab.content !== tab.saved) return tab;
            // reload on-disk content for clean tabs; dirty tabs keep local edits
            void api
              .readFile(changed)
              .then((res) =>
                setTabs((cur) =>
                  cur.map((t) => (t.path === changed && t.content === t.saved
                    ? { ...t, content: res.content, saved: res.content }
                    : t)),
                ),
              )
              .catch(() => undefined);
            return tab;
          }),
        );
      }
    }, setStatus);
  }, [refreshTree]);

  // ---- editor actions ------------------------------------------------------
  const openFile = useCallback(async (path: string) => {
    if (tabs.some((tab) => tab.path === path)) {
      setActivePath(path);
      setPane('editor');
      return;
    }
    try {
      const res = await api.readFile(path);
      setTabs((prev) => [...prev, { path, content: res.content, saved: res.content }]);
      setActivePath(path);
      setPane('editor');
    } catch (err) {
      setError(String(err));
    }
  }, [tabs]);

  const changeFile = useCallback((path: string, content: string) => {
    setTabs((prev) => prev.map((tab) => (tab.path === path ? { ...tab, content } : tab)));
  }, []);

  const saveFile = useCallback(async (path: string) => {
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return;
    try {
      await api.writeFile(path, tab.content);
      setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, saved: t.content } : t)));
    } catch (err) {
      setError(String(err));
    }
  }, [tabs]);

  const closeTab = useCallback((path: string) => {
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.path !== path);
      setActivePath((current) => (current === path ? (next.at(-1)?.path ?? null) : current));
      return next;
    });
  }, []);

  // ---- task actions --------------------------------------------------------
  const runTask = useCallback(async (agentId: string, prompt: string) => {
    try {
      const { task } = await api.runTask(agentId, prompt);
      setTasks((prev) => ({ ...prev, [task.id]: task }));
      setEvents((prev) => ({ ...prev, [task.id]: [] }));
      setActiveTaskId(task.id);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const abortTask = useCallback(async (taskId: string) => {
    try {
      await api.abortTask(taskId);
    } catch {
      // already finished
    }
  }, []);

  // ---- derived -------------------------------------------------------------
  const sortedTasks = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);
  const activeEvents = activeTaskId ? (events[activeTaskId] ?? []) : [];
  const statusDot = status === 'open' ? 'open' : status === 'connecting' ? 'connecting' : 'closed';

  return (
    <div className="app" data-pane={pane}>
      <header className="topbar">
        <div className="brand">
          <span className="logo">AD</span>
          <span className="brand-name">ADE</span>
          <span className="ws-path">{workspaceRoot ? workspaceRoot.split(/[\\/]/).pop() : '…'}</span>
        </div>
        <div className="top-right">
          {error ? (
            <button type="button" className="error-pill" onClick={() => setError(null)}>
              {error} ×
            </button>
          ) : null}
          <span className={`conn ${statusDot}`}>
            <span className="conn-dot" />
            {status}
          </span>
        </div>
      </header>

      <div className="body">
        <aside className="pane files-pane">
          <div className="pane-title">Workspace</div>
          <FileTree root={tree} activePath={activePath} onOpen={(path) => void openFile(path)} />
        </aside>

        <main className="pane editor-pane-wrapper">
          <EditorPane
            tabs={tabs}
            activePath={activePath}
            onSelect={setActivePath}
            onClose={closeTab}
            onChange={changeFile}
            onSave={(path) => void saveFile(path)}
          />
        </main>

        <section className="pane chat-pane-wrapper">
          <ChatPane
            agents={agents}
            selectedAgent={selectedAgent}
            onSelectAgent={setSelectedAgent}
            tasks={sortedTasks}
            activeTaskId={activeTaskId}
            eventsForActive={activeEvents}
            onSelectTask={setActiveTaskId}
            onRun={(agentId, prompt) => void runTask(agentId, prompt)}
            onAbort={(taskId) => void abortTask(taskId)}
          />
        </section>
      </div>

      <nav className="mobile-nav">
        <button type="button" className={pane === 'files' ? 'active' : ''} onClick={() => setPane('files')}>
          Files
        </button>
        <button type="button" className={pane === 'editor' ? 'active' : ''} onClick={() => setPane('editor')}>
          Editor
        </button>
        <button type="button" className={pane === 'chat' ? 'active' : ''} onClick={() => setPane('chat')}>
          Agent
        </button>
      </nav>
    </div>
  );
}