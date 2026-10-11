import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AgentInfo, ChainStep, FileNode, GitChanges, GitDiff, ServerMessage, TaskEvent, TaskMeta } from '@ade/shared';
import { applyTaskEvent } from '@ade/shared';
import { api, ApiError } from './lib/api';
import { canRelocateActive, relocateFileTabs } from './lib/file-moves';
import { draftKey, dirtyDrafts, parseDrafts, restoreDraft, serializeDrafts } from './lib/drafts';
import { connectWs, type WsConnection, type WsStatus } from './lib/ws';
import { observeTaskEvent, observeTaskSnapshot } from './lib/task-notices';
import FileTree from './components/FileTree';
import type { OpenFile } from './components/EditorPane';
import ChatPane from './components/ChatPane';
import GitChangesPane, { type ReviewSelection } from './components/GitChangesPane';
import QuickOpen from './components/QuickOpen';
import PushToggle from './components/PushToggle';
import { Bot, Code2, Files, Search, TerminalSquare } from 'lucide-react';

type MobilePane = 'files' | 'editor' | 'chat';

const EditorPane = lazy(() => import('./components/EditorPane'));
const GitReviewPane = lazy(() => import('./components/GitReviewPane'));

const MAX_EVENTS_PER_TASK = 2000;

// History and live frames may overlap or arrive out of order after reconnect.
function mergeHistory(current: TaskEvent[], history: TaskEvent[]): TaskEvent[] {
  if (!history.length) return current;
  if (!current.length) return history.slice(-MAX_EVENTS_PER_TASK);
  const key = (event: TaskEvent) => JSON.stringify(event);
  const currentKeys = current.map(key);
  const historyKeys = history.map(key);
  const contains = (outer: string[], inner: string[]) => outer.some((_, start) =>
    start + inner.length <= outer.length && inner.every((item, index) => outer[start + index] === item));
  if (contains(historyKeys, currentKeys)) return history.slice(-MAX_EVENTS_PER_TASK);
  if (contains(currentKeys, historyKeys)) return current.slice(-MAX_EVENTS_PER_TASK);
  for (let size = Math.min(current.length, history.length); size > 0; size--) {
    if (currentKeys.slice(-size).every((item, index) => item === historyKeys[index])) {
      return [...current, ...history.slice(size)].slice(-MAX_EVENTS_PER_TASK);
    }
    if (historyKeys.slice(-size).every((item, index) => item === currentKeys[index])) {
      return [...history, ...current.slice(size)].slice(-MAX_EVENTS_PER_TASK);
    }
  }
  return history.slice(-MAX_EVENTS_PER_TASK);
}

function mergeTaskSnapshot(current: Record<string, TaskMeta>, incoming: TaskMeta[]): Record<string, TaskMeta> {
  const next = { ...current };
  for (const meta of incoming) {
    const existing = next[meta.id];
    if (existing?.status !== 'running' && existing && meta.status === 'running') continue;
    if (existing?.endedAt && meta.endedAt && existing.endedAt > meta.endedAt) continue;
    next[meta.id] = meta;
  }
  return next;
}

export default function App() {
  // Fragment tokens are not sent with HTTP requests; accept old query links too.
  useEffect(() => {
    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const token = fragment.get('token') ?? url.searchParams.get('token');
    if (token) {
      localStorage.setItem('ade-token', token);
      url.searchParams.delete('token');
      fragment.delete('token');
      url.hash = fragment.toString();
      window.history.replaceState({}, '', url);
    }
  }, []);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [tree, setTree] = useState<FileNode | null>(null);
  const [sidebarMode, setSidebarMode] = useState<'files' | 'changes'>('files');
  const [gitChanges, setGitChanges] = useState<GitChanges | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewSelection | null>(null);
  const [reviewDiff, setReviewDiff] = useState<GitDiff | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewActionError, setReviewActionError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [draftWorkspace, setDraftWorkspace] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const [openingLinkedFile, setOpeningLinkedFile] = useState(Boolean(new URLSearchParams(window.location.search).get('file')));
  const [activePath, setActivePath] = useState<string | null>(null);
  const viewedPath = review ? null : activePath;
  const viewedPathRef = useRef(viewedPath);
  viewedPathRef.current = viewedPath;
  const [viewers, setViewers] = useState<Map<string, number>>(() => new Map());
  const [tasks, setTasks] = useState<Record<string, TaskMeta>>({});
  const [events, setEvents] = useState<Record<string, TaskEvent[]>>({});
  const [unreadTasks, setUnreadTasks] = useState<Set<string>>(() => new Set());
  const knownTaskStatuses = useRef(new Map<string, TaskMeta['status']>());
  const lastSnapshotTime = useRef<number | undefined>(undefined);
  const initialTaskId = useRef(new URLSearchParams(window.location.search).get('task'));
  const [activeTaskId, setActiveTaskId] = useState<string | null>(initialTaskId.current);
  const activeTaskIdRef = useRef(activeTaskId);
  activeTaskIdRef.current = activeTaskId;
  const [status, setStatus] = useState<WsStatus>('connecting');
  const [pane, setPane] = useState<MobilePane>('chat');
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 960px)').matches);
  const [editorActivated, setEditorActivated] = useState(() => !window.matchMedia('(max-width: 960px)').matches);
  const showEditor = !compact || pane === 'editor' || editorActivated;
  const paneRef = useRef(pane);
  paneRef.current = pane;

  useEffect(() => {
    const query = window.matchMedia('(max-width: 960px)');
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!compact || pane === 'editor') setEditorActivated(true);
  }, [compact, pane]);
  const [quickOpen, setQuickOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savingPaths, setSavingPaths] = useState<Set<string>>(() => new Set());
  const savingRef = useRef(new Set<string>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const readVersions = useRef(new Map<string, number>());
  const treeRefreshTimer = useRef<number | undefined>(undefined);
  const wsRef = useRef<WsConnection | null>(null);
  const reviewRequest = useRef(0);
  const changesLoading = useRef(false);
  const draftSession = useRef<string | null>(null);
  const draftHydrating = useRef(false);
  const draftSafe = useRef(true);

  const taskIsVisible = useCallback((taskId: string): boolean =>
    document.visibilityState === 'visible' && activeTaskIdRef.current === taskId &&
    (!window.matchMedia('(max-width: 960px)').matches || paneRef.current === 'chat'), []);

  const markUnread = useCallback((taskIds: string[]) => {
    const hidden = taskIds.filter((id) => !taskIsVisible(id));
    if (!hidden.length) return;
    setUnreadTasks((current) => new Set([...current, ...hidden]));
  }, [taskIsVisible]);

  useEffect(() => {
    if (!activeTaskId) return;
    const clearVisible = () => {
      if (!taskIsVisible(activeTaskId)) return;
      setUnreadTasks((current) => {
        if (!current.has(activeTaskId)) return current;
        const next = new Set(current);
        next.delete(activeTaskId);
        return next;
      });
    };
    clearVisible();
    document.addEventListener('visibilitychange', clearVisible);
    return () => document.removeEventListener('visibilitychange', clearVisible);
  }, [activeTaskId, pane, taskIsVisible]);

  useEffect(() => {
    if (!workspaceRoot || draftWorkspace === workspaceRoot || draftHydrating.current) return;
    draftHydrating.current = true;
    const hydrate = async () => {
      try {
        let session = sessionStorage.getItem('ade-draft-session');
        if (!session) {
          session = crypto.randomUUID();
          sessionStorage.setItem('ade-draft-session', session);
        }
        draftSession.current = session;
        const drafts = parseDrafts(localStorage.getItem(draftKey(workspaceRoot, session)));
        const restored: OpenFile[] = [];
        for (const draft of drafts) {
          let disk;
          try {
            disk = await api.readFile(draft.path);
          } catch (err) {
            if (!(err instanceof ApiError && err.status === 404)) throw err;
            disk = null;
          }
          const tab = restoreDraft(draft, disk);
          if (tab && !restored.some((entry) => entry.path === tab.path)) restored.push(tab);
        }
        if (restored.length) {
          setTabs((prev) => [...prev, ...restored.filter((tab) => !prev.some((item) => item.path === tab.path))]);
          setActivePath((current) => current ?? restored[0].path);
          setPane('editor');
        }
        setDraftWorkspace(workspaceRoot);
      } catch {
        draftSafe.current = false;
        setError('Local drafts could not be restored. Check browser storage or connection.');
      } finally {
        draftHydrating.current = false;
        setDraftReady(true);
      }
    };
    void hydrate();
  }, [workspaceRoot, draftWorkspace, status]);

  useEffect(() => {
    if (!draftWorkspace || draftWorkspace !== workspaceRoot || !draftSession.current) return;
    try {
      const key = draftKey(workspaceRoot, draftSession.current);
      if (dirtyDrafts(tabs).length) localStorage.setItem(key, serializeDrafts(tabs));
      else localStorage.removeItem(key);
      draftSafe.current = true;
    } catch {
      draftSafe.current = false;
      setError('Local draft storage is full or unavailable. Save files before leaving this page.');
    }
  }, [tabs, draftWorkspace, workspaceRoot]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (draftSafe.current && draftWorkspace === workspaceRoot) return;
      if (!dirtyDrafts(tabsRef.current).length) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [draftWorkspace, workspaceRoot]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const refreshChanges = useCallback(() => {
    if (changesLoading.current) return;
    changesLoading.current = true;
    void api.gitChanges().then((data) => { setGitChanges(data); setGitError(null); })
      .catch((err: unknown) => setGitError(String(err)))
      .finally(() => { changesLoading.current = false; });
  }, []);

  useEffect(() => {
    if (sidebarMode !== 'changes') return;
    refreshChanges();
    const interval = window.setInterval(refreshChanges, 4000);
    return () => window.clearInterval(interval);
  }, [sidebarMode, refreshChanges]);

  const openReview = useCallback(async (selection: ReviewSelection) => {
    const requestId = ++reviewRequest.current;
    setReview(selection);
    setReviewDiff(null);
    setReviewError(null);
    setReviewActionError(null);
    setPane('editor');
    try {
      const diff = await api.gitDiff(selection.path, selection.side);
      if (reviewRequest.current === requestId) setReviewDiff(diff);
    } catch (err) {
      if (reviewRequest.current === requestId) setReviewError(String(err));
    }
  }, []);

  const closeReview = useCallback(() => {
    reviewRequest.current++;
    setReview(null);
  }, []);

  const updateIndex = useCallback(async (selection: ReviewSelection, revision: string) => {
    if (reviewBusy) return;
    const requestId = reviewRequest.current;
    setReviewBusy(true);
    setReviewActionError(null);
    try {
      await api.updateGitIndex(selection.path, selection.side === 'working' ? 'stage' : 'unstage', revision);
      refreshChanges();
      if (reviewRequest.current === requestId) closeReview();
    } catch (err) {
      if (reviewRequest.current === requestId) {
        if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
          setReviewDiff(null);
          setReviewError('The change has moved. Refresh Changes and reopen this diff.');
          refreshChanges();
        } else {
          setReviewActionError(String(err));
        }
      }
    } finally {
      setReviewBusy(false);
    }
  }, [reviewBusy, refreshChanges, closeReview]);

  const invalidateRead = useCallback((path: string): number => {
    const version = (readVersions.current.get(path) ?? 0) + 1;
    readVersions.current.set(path, version);
    return version;
  }, []);

  // ---- initial bootstrap over REST (WS also sends an init snapshot) --------
  useEffect(() => {
    void api.agents().then((list) => {
      setAgents(list);
      setSelectedAgent((current) => list.some((agent) => agent.id === current && agent.available)
        ? current : list.find((agent) => agent.available)?.id ?? '');
    });
    void api.tree().then((res) => setTree(res.tree));
    void api.config().then((res) => setWorkspaceRoot(res.workspaceRoot));
    void api
      .tasks()
      .then((res) => {
        markUnread(observeTaskSnapshot(knownTaskStatuses.current, res.tasks, lastSnapshotTime.current));
        setTasks((prev) => mergeTaskSnapshot(prev, res.tasks));
        setActiveTaskId((current) => current && current !== initialTaskId.current
          ? current : current && res.tasks.some((task) => task.id === current)
          ? current : res.tasks[0]?.id ?? null);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [markUnread]);

  useEffect(() => {
    if (!activeTaskId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('task') === activeTaskId) return;
    url.searchParams.set('task', activeTaskId);
    window.history.replaceState(null, '', url);
  }, [activeTaskId]);

  useEffect(() => {
    const onPopState = () => {
      const requested = new URLSearchParams(window.location.search).get('task');
      setActiveTaskId(requested && tasks[requested] ? requested : Object.values(tasks)
        .sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null);
      setPane('chat');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [tasks]);

  const selectTask = useCallback((taskId: string) => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('task') !== taskId) {
      url.searchParams.set('task', taskId);
      window.history.pushState(null, '', url);
    }
    setActiveTaskId(taskId);
    activeTaskIdRef.current = taskId;
    setPane('chat');
    paneRef.current = 'chat';
    setUnreadTasks((current) => {
      if (!current.has(taskId)) return current;
      const next = new Set(current);
      next.delete(taskId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onPushOpen = (event: MessageEvent) => {
      const message = event.data as { kind?: unknown; taskId?: unknown } | null;
      if (message?.kind === 'task.open' && typeof message.taskId === 'string' &&
          /^[a-f0-9-]{36}$/i.test(message.taskId)) selectTask(message.taskId);
    };
    navigator.serviceWorker.addEventListener('message', onPushOpen);
    return () => navigator.serviceWorker.removeEventListener('message', onPushOpen);
  }, [selectTask]);

  const copyTaskLink = useCallback(async (taskId: string): Promise<boolean> => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      const fragment = new URLSearchParams(url.hash.slice(1));
      fragment.delete('token');
      url.hash = fragment.toString();
      url.searchParams.set('task', taskId);
      url.searchParams.delete('file');
      await navigator.clipboard.writeText(url.toString());
      return true;
    } catch {
      setError('Could not copy link; check clipboard permissions');
      return false;
    }
  }, []);

  const refreshTree = useCallback(() => {
    if (treeRefreshTimer.current !== undefined) clearTimeout(treeRefreshTimer.current);
    treeRefreshTimer.current = window.setTimeout(() => {
      void api.tree().then((res) => setTree(res.tree)).catch(() => undefined);
    }, 400);
  }, []);

  const reconcileFile = useCallback(async (path: string) => {
    if (!tabsRef.current.some((tab) => tab.path === path)) return;
    const version = invalidateRead(path);
    try {
      const remote = await api.readFile(path);
      if (readVersions.current.get(path) !== version) return;
      setTabs((prev) => prev.map((tab) => {
        if (tab.path !== path || tab.revision === remote.revision) return tab;
        if (tab.content === tab.saved || tab.content === remote.content) {
          return { ...tab, content: remote.content, saved: remote.content, revision: remote.revision,
            conflict: undefined, comparing: false };
        }
        return { ...tab, conflict: { content: remote.content, revision: remote.revision } };
      }));
    } catch (err) {
      if (readVersions.current.get(path) === version && err instanceof ApiError && err.status === 404) {
        setTabs((prev) => prev.map((tab) => tab.path === path
          ? { ...tab, conflict: { content: null, revision: null }, comparing: false } : tab));
      }
    }
  }, [invalidateRead]);

  const applyFileMove = useCallback((from: string, to: string, revision: string) => {
    invalidateRead(from);
    invalidateRead(to);
    const moveActive = canRelocateActive(tabsRef.current, from, to, revision);
    setTabs((prev) => relocateFileTabs(prev, from, to, revision));
    setActivePath((current) => current === from && moveActive ? to : current);
    refreshTree();
  }, [invalidateRead, refreshTree]);

  // ---- realtime channel ----------------------------------------------------
  useEffect(() => {
    const connection = connectWs((message: ServerMessage) => {
      if (message.kind === 'init') {
        const { payload } = message;
        const previousSnapshotTime = lastSnapshotTime.current;
        lastSnapshotTime.current = payload.serverTime;
        markUnread(observeTaskSnapshot(knownTaskStatuses.current,
          payload.tasks.map((task) => task.meta), previousSnapshotTime));
        if (previousSnapshotTime !== undefined) {
          void api.tasks().then((res) => {
            markUnread(observeTaskSnapshot(knownTaskStatuses.current, res.tasks, previousSnapshotTime));
            setTasks((prev) => mergeTaskSnapshot(prev, res.tasks));
          }).catch(() => undefined);
        }
        setViewers(new Map(payload.viewers.map(({ path, count }) => [path, count])));
        wsRef.current?.send({ kind: 'presence.set', path: viewedPathRef.current });
        setAgents(payload.agents);
        setSelectedAgent((current) => payload.agents.some((agent) => agent.id === current && agent.available)
          ? current : payload.agents.find((agent) => agent.available)?.id ?? '');
        setWorkspaceRoot(payload.workspaceRoot);
        setTasks((prev) => mergeTaskSnapshot(prev, payload.tasks.map((task) => task.meta)));
        setEvents((prev) => {
          const next = { ...prev };
          for (const task of payload.tasks) {
            next[task.meta.id] = mergeHistory(next[task.meta.id] ?? [], task.events);
          }
          return next;
        });
        setActiveTaskId((current) => current ?? payload.tasks[0]?.meta.id ?? null);
      } else if (message.kind === 'task') {
        const event = message.event;
        const finishedId = observeTaskEvent(knownTaskStatuses.current, event);
        if (finishedId) markUnread([finishedId]);
        if (event.type === 'task.created' && event.chainStep && event.chainStep > 1 && event.sourceTaskId) {
          setActiveTaskId((current) => current === event.sourceTaskId ? event.taskId : current);
        }
        setEvents((prev) => {
          const next = [...(prev[event.taskId] ?? []), event];
          if (next.length <= MAX_EVENTS_PER_TASK) return { ...prev, [event.taskId]: next };
          return { ...prev, [event.taskId]: next.slice(-MAX_EVENTS_PER_TASK) };
        });
        setTasks((prev) => {
          const meta = prev[event.taskId] ?? (event.type === 'task.created' ? {
            id: event.taskId,
            agentId: event.agentId,
            prompt: event.prompt,
            sourceTaskId: event.sourceTaskId,
            chainId: event.chainId,
            chainStep: event.chainStep,
            chainTotal: event.chainTotal,
            nextSteps: event.nextSteps,
            cwd: event.cwd,
            mode: event.mode,
            status: 'running' as const,
            createdAt: event.ts,
          } : null);
          if (!meta) return prev;
          return { ...prev, [event.taskId]: applyTaskEvent(meta, event) };
        });
      } else if (message.kind === 'file') {
        refreshTree();
        if (!tabsRef.current.some((tab) => tab.path === message.event.path)) {
          invalidateRead(message.event.path);
        }
        void reconcileFile(message.event.path);
      } else if (message.kind === 'file.moved') {
        applyFileMove(message.from, message.to, message.revision);
      } else if (message.kind === 'tree.changed') {
        refreshTree();
      } else if (message.kind === 'presence') {
        setViewers((prev) => {
          const next = new Map(prev);
          if (message.count > 0) next.set(message.path, message.count);
          else next.delete(message.path);
          return next;
        });
      }
    }, (next) => {
      setStatus(next);
      if (next !== 'open') setViewers(new Map());
    });
    wsRef.current = connection;
    return () => {
      connection.close();
      if (wsRef.current === connection) wsRef.current = null;
    };
  }, [refreshTree, reconcileFile, invalidateRead, applyFileMove, markUnread]);

  useEffect(() => {
    if (status === 'open') wsRef.current?.send({ kind: 'presence.set', path: viewedPath });
  }, [viewedPath, status]);

  useEffect(() => {
    if (status === 'open') for (const tab of tabsRef.current) void reconcileFile(tab.path);
  }, [status, reconcileFile]);

  useEffect(() => {
    if (!activeTaskId || status !== 'open') return;
    void api.taskEvents(activeTaskId).then(({ events: history }) => {
      setEvents((prev) => ({ ...prev, [activeTaskId]: mergeHistory(prev[activeTaskId] ?? [], history) }));
    }).catch(() => undefined);
  }, [activeTaskId, status]);

  // ---- editor actions ------------------------------------------------------
  const openFile = useCallback(async (path: string) => {
    closeReview();
    if (tabsRef.current.some((tab) => tab.path === path)) {
      setActivePath(path);
      setPane('editor');
      return;
    }
    try {
      let version: number;
      let res: Awaited<ReturnType<typeof api.readFile>>;
      do {
        version = invalidateRead(path);
        res = await api.readFile(path);
      } while (readVersions.current.get(path) !== version);
      setTabs((prev) => prev.some((tab) => tab.path === path) ? prev :
        [...prev, { sessionId: crypto.randomUUID(), path, content: res.content,
          saved: res.content, revision: res.revision }]);
      setActivePath(path);
      setPane('editor');
    } catch (err) {
      setError(String(err));
    }
  }, [invalidateRead, closeReview]);

  useEffect(() => {
    if (!draftReady || !workspaceRoot) return;
    const requested = new URLSearchParams(window.location.search).get('file');
    if (requested) void openFile(requested).finally(() => setOpeningLinkedFile(false));
    else setOpeningLinkedFile(false);
    const onPopState = () => {
      const path = new URLSearchParams(window.location.search).get('file');
      if (path) void openFile(path);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [draftReady, workspaceRoot, openFile]);

  useEffect(() => {
    if (!draftReady || openingLinkedFile) return;
    const url = new URL(window.location.href);
    if (activePath) url.searchParams.set('file', activePath);
    else url.searchParams.delete('file');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [activePath, draftReady, openingLinkedFile]);

  const copyFileLink = useCallback(async (path: string): Promise<boolean> => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      const fragment = new URLSearchParams(url.hash.slice(1));
      fragment.delete('token');
      url.hash = fragment.toString();
      url.searchParams.delete('task');
      url.searchParams.set('file', path);
      await navigator.clipboard.writeText(url.toString());
      return true;
    } catch {
      setError('Could not copy link; check clipboard permissions');
      return false;
    }
  }, []);

  const changeFile = useCallback((path: string, content: string) => {
    draftSafe.current = false;
    setTabs((prev) => prev.map((tab) => (tab.path === path ? { ...tab, content } : tab)));
  }, []);

  const saveFile = useCallback(async (path: string, overwrite = false) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || savingRef.current.has(path)) return;
    if (tab.conflict && !overwrite) {
      setTabs((prev) => prev.map((t) => t.path === path ? { ...t, comparing: t.conflict?.content !== null } : t));
      return;
    }
    savingRef.current.add(path);
    setSavingPaths(new Set(savingRef.current));
    try {
      const { revision } = await api.writeFile(path, tab.content, overwrite ? tab.conflict?.revision ?? null : tab.revision);
      invalidateRead(path);
      setTabs((prev) => prev.map((t) => t.sessionId === tab.sessionId ? { ...t, saved: tab.content,
        revision, conflict: undefined, comparing: false } : t));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const version = invalidateRead(path);
        try {
          const remote = await api.readFile(path).catch((readError: unknown) => {
            if (readError instanceof ApiError && readError.status === 404) {
              return { content: null, revision: null };
            }
            throw readError;
          });
          if (readVersions.current.get(path) === version) {
            setTabs((prev) => prev.map((t) => t.sessionId === tab.sessionId
              ? { ...t, conflict: remote, comparing: false } : t));
          }
        } catch (readError) {
          setError(String(readError));
        }
      } else {
        setError(String(err));
      }
    } finally {
      savingRef.current.delete(path);
      setSavingPaths(new Set(savingRef.current));
    }
  }, [invalidateRead]);

  const useDiskVersion = useCallback((path: string) => {
    invalidateRead(path);
    setTabs((prev) => prev.map((tab) => tab.path === path && tab.conflict?.content !== null && tab.conflict
      ? { ...tab, content: tab.conflict.content!, saved: tab.conflict.content!,
        revision: tab.conflict.revision!, conflict: undefined, comparing: false } : tab));
  }, [invalidateRead]);

  const closeTab = useCallback((path: string) => {
    const tab = tabsRef.current.find((item) => item.path === path);
    if (tab && (tab.content !== tab.saved || tab.conflict) &&
        !window.confirm(`Discard unsaved changes to ${path}?`)) return;
    invalidateRead(path);
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.path !== path);
      setActivePath((current) => (current === path ? (next.at(-1)?.path ?? null) : current));
      return next;
    });
  }, [invalidateRead]);

  const createFile = useCallback(async (path: string): Promise<boolean> => {
    try {
      await api.writeFile(path, '', null);
      refreshTree();
      await openFile(path);
      return true;
    } catch (err) {
      setError(String(err));
      refreshTree();
      return false;
    }
  }, [openFile, refreshTree]);

  const createFolder = useCallback(async (path: string): Promise<boolean> => {
    try {
      await api.createDirectory(path);
      refreshTree();
      return true;
    } catch (err) {
      setError(String(err));
      refreshTree();
      return false;
    }
  }, [refreshTree]);

  const renameFile = useCallback(async (from: string, to: string): Promise<boolean> => {
    if (savingRef.current.has(from) || savingRef.current.has(to)) {
      setError('Wait for the file to finish saving');
      return false;
    }
    try {
      const tab = tabsRef.current.find((item) => item.path === from);
      const revision = tab?.revision ?? (await api.readFile(from)).revision;
      await api.moveFile(from, to, revision);
      applyFileMove(from, to, revision);
      return true;
    } catch (err) {
      setError(String(err));
      refreshTree();
      return false;
    }
  }, [applyFileMove, refreshTree]);

  const deleteWorkspaceFolder = useCallback(async (path: string): Promise<void> => {
    if (!window.confirm(`Delete empty folder ${path}?`)) return;
    try {
      await api.deleteDirectory(path);
      refreshTree();
    } catch (err) {
      setError(String(err));
      refreshTree();
    }
  }, [refreshTree]);

  const deleteWorkspaceFile = useCallback(async (path: string): Promise<void> => {
    if (savingRef.current.has(path)) { setError('Wait for the file to finish saving'); return; }
    const tab = tabsRef.current.find((item) => item.path === path);
    if (!window.confirm(tab && (tab.content !== tab.saved || tab.conflict)
      ? `Delete ${path} and discard its unsaved draft?` : `Delete ${path}?`)) return;
    try {
      const revision = tab?.revision ?? (await api.readFile(path)).revision;
      await api.deleteFile(path, revision);
      invalidateRead(path);
      setTabs((prev) => {
        const next = prev.filter((item) => item.path !== path);
        setActivePath((current) => current === path ? next.at(-1)?.path ?? null : current);
        return next;
      });
      refreshTree();
    } catch (err) {
      setError(String(err));
      refreshTree();
      if (tab) void reconcileFile(path);
    }
  }, [invalidateRead, reconcileFile, refreshTree]);

  // ---- task actions --------------------------------------------------------
  const runTask = useCallback(async (agentId: string, prompt: string, sourceTaskId?: string,
    nextSteps?: ChainStep[], cwd = '.'): Promise<boolean> => {
    try {
      const { task } = await api.runTask(agentId, prompt, sourceTaskId, nextSteps, cwd);
      setTasks((prev) => ({ ...prev, [task.id]: prev[task.id]
        ? { ...task, ...prev[task.id], mode: task.mode } : task }));
      selectTask(task.id);
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }, [selectTask]);

  const abortTask = useCallback(async (taskId: string) => {
    try {
      await api.abortTask(taskId);
    } catch {
      // already finished
    }
  }, []);

  const resolveApproval = useCallback(async (taskId: string, decision: 'approve' | 'reject') => {
    try {
      await api.resolveApproval(taskId, decision);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const resumeChain = useCallback(async (taskId: string) => {
    try {
      await api.resumeChain(taskId);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const exportTaskLog = useCallback(async (taskId: string): Promise<void> => {
    try {
      await api.downloadTaskLog(taskId);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // ---- derived -------------------------------------------------------------
  const sortedTasks = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);
  const activeEvents = activeTaskId ? (events[activeTaskId] ?? []) : [];
  const statusDot = status === 'open' ? 'open' : status === 'connecting' ? 'connecting' : 'closed';
  const activeTask = activeTaskId ? tasks[activeTaskId] : null;

  return (
    <div className="app" data-pane={pane} data-terminal={activeTask?.mode === 'pty'}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true"><TerminalSquare size={19} strokeWidth={2.2} /></span>
          <span className="brand-copy"><span className="brand-name">ADE</span><span className="brand-caption">Agent Development Environment</span></span>
          <span className="workspace-identity" title={workspaceRoot}>
            <span className="workspace-label">WORKSPACE</span>
            <span className="ws-path">{workspaceRoot ? workspaceRoot.split(/[\\/]/).pop() : 'Loading'}</span>
          </span>
        </div>
        <div className="top-right">
          <PushToggle onError={setError} />
          <button type="button" className="quick-open-trigger" title="Open file" aria-label="Open file"
            onClick={() => setQuickOpen(true)}><Search size={17} /></button>
          {error ? (
            <button type="button" className="error-pill" onClick={() => setError(null)}>
              {error} ×
            </button>
          ) : null}
          <span className={`conn ${statusDot}`} role="status" aria-label={`Connection ${status}`}>
            <span className="conn-dot" />
            {status}
          </span>
        </div>
      </header>

      {quickOpen && <QuickOpen root={tree} onOpen={(path) => { void openFile(path); }}
        onClose={() => setQuickOpen(false)} />}

      <div className="body">
        <aside className="pane files-pane">
          <div className="pane-title">Explorer <span className="pane-title-context">/ Workspace</span></div>
          <div className="sidebar-modes" role="tablist" aria-label="Workspace views">
            <button type="button" role="tab" aria-selected={sidebarMode === 'files'}
              className={sidebarMode === 'files' ? 'active' : ''} onClick={() => setSidebarMode('files')}>Files</button>
            <button type="button" role="tab" aria-selected={sidebarMode === 'changes'}
              className={sidebarMode === 'changes' ? 'active' : ''} onClick={() => setSidebarMode('changes')}>Changes</button>
          </div>
          {sidebarMode === 'files' ?
            <FileTree root={tree} activePath={activePath} onOpen={(path) => void openFile(path)}
              onCreateFile={createFile} onCreateFolder={createFolder} onRename={renameFile}
              onDelete={deleteWorkspaceFile} onDeleteFolder={deleteWorkspaceFolder} /> :
            <GitChangesPane data={gitChanges} error={gitError} selected={review}
              onSelect={(selection) => void openReview(selection)}
              onRefresh={() => { refreshChanges(); if (review) void openReview(review); }} />}
        </aside>

        <main className="pane editor-pane-wrapper">
          {showEditor ? <Suspense fallback={<div className="empty-hint big" role="status">Loading editor...</div>}>
            {review ? <GitReviewPane selection={review} diff={reviewDiff} error={reviewError}
              actionError={reviewActionError} busy={reviewBusy} onBack={closeReview} onIndexChange={updateIndex} /> :
            <EditorPane
              tabs={tabs}
              activePath={activePath}
              onSelect={setActivePath}
              onCopyLink={copyFileLink}
              onClose={closeTab}
              onChange={changeFile}
              onSave={(path) => void saveFile(path)}
              onCompare={(path) => setTabs((prev) => prev.map((tab) => tab.path === path
                ? { ...tab, comparing: !tab.comparing } : tab))}
              onUseDisk={useDiskVersion}
              onOverwrite={(path) => void saveFile(path, true)}
              saving={activePath ? savingPaths.has(activePath) : false}
              otherViewers={activePath && status === 'open' ? viewers.get(activePath) ?? 0 : 0}
            />}
          </Suspense> : null}
        </main>

        <section className="pane chat-pane-wrapper">
          <ChatPane
            agents={agents}
            tree={tree}
            selectedAgent={selectedAgent}
            onSelectAgent={setSelectedAgent}
            tasks={sortedTasks}
            activeTaskId={activeTaskId}
            eventsForActive={activeEvents}
            unreadTasks={unreadTasks}
            connected={status === 'open'}
            onSelectTask={selectTask}
            onCopyTaskLink={copyTaskLink}
            onExportTaskLog={exportTaskLog}
            onRun={runTask}
            onAbort={(taskId) => void abortTask(taskId)}
            onResolveApproval={resolveApproval}
            onResumeChain={resumeChain}
            onInput={(data) => activeTaskId && wsRef.current?.send({ kind: 'task.input', taskId: activeTaskId, data })}
            onResize={(cols, rows) => activeTaskId && wsRef.current?.send({ kind: 'task.resize', taskId: activeTaskId, cols, rows })}
          />
        </section>
      </div>

      <nav className="mobile-nav">
        <button type="button" className={pane === 'files' ? 'active' : ''} aria-current={pane === 'files' ? 'page' : undefined} onClick={() => setPane('files')}>
          <Files size={19} aria-hidden="true" /><span>Files</span>
        </button>
        <button type="button" className={pane === 'editor' ? 'active' : ''} aria-current={pane === 'editor' ? 'page' : undefined} onClick={() => setPane('editor')}>
          <Code2 size={19} aria-hidden="true" /><span>Editor</span>
        </button>
        <button type="button" className={pane === 'chat' ? 'active' : ''} aria-current={pane === 'chat' ? 'page' : undefined} onClick={() => setPane('chat')}>
          <Bot size={19} aria-hidden="true" /><span>Agent</span>{unreadTasks.size > 0 ? <span className="nav-unread" aria-label={`${unreadTasks.size} unread tasks`}>{unreadTasks.size}</span> : null}
        </button>
      </nav>
    </div>
  );
}
