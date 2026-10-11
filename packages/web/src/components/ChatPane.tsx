import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, Download, Search } from 'lucide-react';
import { canResumeChain, type AgentInfo, type ChainStep, type FileNode, type TaskEvent, type TaskMeta } from '@ade/shared';
import TerminalPane from './TerminalPane';

interface Props {
  agents: AgentInfo[];
  tree: FileNode | null;
  selectedAgent: string;
  onSelectAgent: (agentId: string) => void;
  tasks: TaskMeta[];
  activeTaskId: string | null;
  eventsForActive: TaskEvent[];
  unreadTasks: ReadonlySet<string>;
  connected: boolean;
  onSelectTask: (taskId: string) => void;
  onCopyTaskLink: (taskId: string) => Promise<boolean>;
  onExportTaskLog: (taskId: string) => Promise<void>;
  onRun: (agentId: string, prompt: string, sourceTaskId?: string, nextSteps?: ChainStep[], cwd?: string) => Promise<boolean>;
  onAbort: (taskId: string) => void;
  onResolveApproval: (taskId: string, decision: 'approve' | 'reject') => Promise<void>;
  onResumeChain: (taskId: string) => Promise<void>;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

const statusClass: Record<TaskMeta['status'], string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  aborted: 'aborted',
};

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function folders(root: FileNode | null): string[] {
  if (!root) return [];
  return (root.children ?? []).flatMap((node): string[] => node.type === 'dir'
    ? [node.path, ...folders(node)] : []);
}

export default function ChatPane({
  agents,
  tree,
  selectedAgent,
  onSelectAgent,
  tasks,
  activeTaskId,
  eventsForActive,
  unreadTasks,
  connected,
  onSelectTask,
  onCopyTaskLink,
  onExportTaskLog,
  onRun,
  onAbort,
  onResolveApproval,
  onResumeChain,
  onInput,
  onResize,
}: Props) {
  const [prompt, setPrompt] = useState('');
  const [sourceTaskId, setSourceTaskId] = useState<string | null>(null);
  const [cwd, setCwd] = useState('.');
  const [submitting, setSubmitting] = useState(false);
  const [resolvingApproval, setResolvingApproval] = useState(false);
  const [resumingChain, setResumingChain] = useState(false);
  const [nextSteps, setNextSteps] = useState<ChainStep[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'approval' | TaskMeta['status']>('all');
  const [agentFilter, setAgentFilter] = useState('all');
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const [exportingTaskId, setExportingTaskId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const activeMeta = tasks.find((task) => task.id === activeTaskId) ?? null;
  const sourceTask = tasks.find((task) => task.id === sourceTaskId) ?? null;
  const parentTask = tasks.find((task) => task.id === activeMeta?.sourceTaskId) ?? null;
  const runnableAgents = agents.filter((agent) => agent.available);
  const execAgents = runnableAgents.filter((agent) => agent.mode !== 'pty');
  const selectedAgentInfo = agents.find((agent) => agent.id === selectedAgent);
  const directoryOptions = folders(tree);
  const directoryAvailable = cwd === '.' || directoryOptions.includes(cwd);
  const fixedDirectory = selectedAgentInfo?.fixedWorkingDirectory === true;
  const fixedChainDirectory = nextSteps.some((step) => agents.find((agent) => agent.id === step.agentId)?.fixedWorkingDirectory);
  const unavailableAgents = agents.filter((agent) => !agent.available && agent.enabled !== false);
  const canRun = !!prompt.trim() && (fixedDirectory || directoryAvailable) &&
    runnableAgents.some((agent) => agent.id === selectedAgent) && !submitting &&
    (!nextSteps.length || (execAgents.some((agent) => agent.id === selectedAgent) &&
      nextSteps.every((step) => !!step.prompt.trim() && execAgents.some((agent) => agent.id === step.agentId))));
  const followUps = tasks.filter((task) => task.sourceTaskId === activeTaskId);
  const canResume = activeMeta && canResumeChain(activeMeta, eventsForActive, followUps.length > 0);
  const query = search.trim().toLocaleLowerCase();
  const visibleTasks = tasks.filter((task) =>
    (statusFilter === 'all' || (statusFilter === 'approval' ? task.approval === 'pending' : task.status === statusFilter)) &&
    (agentFilter === 'all' || task.agentId === agentFilter) &&
    (!query || `${task.agentId} ${task.prompt} ${task.cwd} ${task.id}`.toLocaleLowerCase().includes(query)));

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [eventsForActive.length, activeTaskId]);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const copyLink = async (taskId: string): Promise<void> => {
    if (!await onCopyTaskLink(taskId)) return;
    setCopiedTaskId(taskId);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedTaskId(null), 2000);
  };

  const submit = async (): Promise<void> => {
    const trimmed = prompt.trim();
    if (!canRun) return;
    setSubmitting(true);
    try {
      if (await onRun(selectedAgent, trimmed, sourceTaskId ?? undefined,
        nextSteps.length ? nextSteps : undefined, fixedDirectory ? '.' : cwd)) {
        setPrompt((current) => current === prompt ? '' : current);
        setSourceTaskId((current) => current === sourceTaskId ? null : current);
        setNextSteps([]);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const decide = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (!activeMeta || resolvingApproval) return;
    setResolvingApproval(true);
    try {
      await onResolveApproval(activeMeta.id, decision);
    } finally {
      setResolvingApproval(false);
    }
  };

  const resume = async (): Promise<void> => {
    if (!activeMeta || resumingChain) return;
    setResumingChain(true);
    try {
      await onResumeChain(activeMeta.id);
    } finally {
      setResumingChain(false);
    }
  };

  return (
    <div className="chat-pane" data-chain={nextSteps.length > 0}>
      <div className="task-list">
        <div className="task-list-heading">
          <div className="pane-title"><Bot size={15} aria-hidden="true" /> Agent activity <span className="task-count">{tasks.length}</span>
            {unreadTasks.size > 0 && <span className="task-unread-count" role="status">
              {unreadTasks.size} new
            </span>}
          </div>
          <div className="task-filters">
            <Search size={15} className="task-search-icon" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search tasks"
              placeholder="Search tasks"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select aria-label="Filter by agent" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}>
              <option value="all">All agents</option>
              {[...new Set(tasks.map((task) => task.agentId))].sort().map((id) => (
                <option key={id} value={id}>{agents.find((agent) => agent.id === id)?.label ?? id}</option>
              ))}
            </select>
            <select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">All status</option>
              <option value="running">Running</option>
              <option value="approval">Needs approval</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="aborted">Aborted</option>
            </select>
          </div>
        </div>
        <div className="task-results">
          {visibleTasks.length === 0 ? (
            <div className="empty-hint">{tasks.length ? 'No matching tasks.' : 'No tasks yet.'}</div>
          ) : visibleTasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={`task-row${task.id === activeTaskId ? ' active' : ''}${unreadTasks.has(task.id) ? ' unread' : ''}`}
              aria-current={task.id === activeTaskId ? 'true' : undefined}
              title={`${task.agentId} - ${task.status} - ${new Date(task.createdAt).toLocaleString()}\n${task.cwd} - ${task.prompt}`}
              onClick={() => onSelectTask(task.id)}
            >
              <span className={`status-dot ${task.approval === 'pending' ? 'approval' : statusClass[task.status]}`} />
              <span className="task-agent">{task.agentId}{task.chainStep ? ` ${task.chainStep}/${task.chainTotal}` : task.sourceTaskId ? ' / handoff' : ''}</span>
              <span className="task-prompt">{task.prompt || '(empty)'}</span>
              {task.approval === 'pending' && <span className="task-approval-tag">Review</span>}
              {unreadTasks.has(task.id) && <span className="task-new">New</span>}
              <span className="task-time">{timeOf(task.createdAt)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="chat-stream" ref={scrollRef}>
        {activeMeta ? (
          <>
            <div className="bubble user">
              <div className="bubble-meta">
                you → {activeMeta.agentId} · {timeOf(activeMeta.createdAt)}
                {activeMeta.status === 'running' ? (
                  <button type="button" className="abort" onClick={() => onAbort(activeMeta.id)}>
                    abort
                  </button>
                ) : eventsForActive.some((event) => event.type === 'task.output') ? (
                  <button type="button" className="handoff-action" onClick={() => {
                    setSourceTaskId(activeMeta.id);
                    setCwd(activeMeta.cwd || '.');
                    promptRef.current?.focus();
                  }}>
                    Hand off output
                  </button>
                ) : null}
                <button type="button" className="task-link-action" onClick={() => void copyLink(activeMeta.id)}>
                  {copiedTaskId === activeMeta.id ? 'Copied' : 'Copy link'}
                </button>
                <button type="button" className="task-log-action" title="Download complete task log (JSONL)"
                  aria-label="Download complete task log" disabled={exportingTaskId === activeMeta.id}
                  onClick={() => {
                    setExportingTaskId(activeMeta.id);
                    void onExportTaskLog(activeMeta.id).finally(() => setExportingTaskId(null));
                  }}><Download size={15} /></button>
              </div>
              {activeMeta.sourceTaskId ? (
                <div className="task-source">
                  From {parentTask ? (
                    <button type="button" onClick={() => onSelectTask(parentTask.id)}>
                      {parentTask.agentId} task
                    </button>
                  ) : activeMeta.sourceTaskId}
                </div>
              ) : null}
              <div className="task-directory" title={activeMeta.cwd}>
                Working directory: {agents.find((agent) => agent.id === activeMeta.agentId)?.fixedWorkingDirectory
                  ? 'set by server' : activeMeta.cwd === '.' ? 'Workspace root' : activeMeta.cwd}
              </div>
              {activeMeta.chainStep ? (
                <div className="task-chain-label">Chain step {activeMeta.chainStep} of {activeMeta.chainTotal}</div>
              ) : null}
              {activeMeta.nextSteps?.length ? (
                <div className="task-chain-queued">
                  {activeMeta.status === 'running' ? 'Next' : 'Planned'}: {activeMeta.nextSteps.map((step, index) => (
                    <span key={index} title={step.prompt}>{step.agentId}: {step.prompt}</span>
                  ))}
                </div>
              ) : null}
              {activeMeta.approval === 'pending' && activeMeta.nextSteps?.[0] && (
                <div className="approval-prompt" role="group" aria-label="Approve next chain step">
                  <strong>Approve step {(activeMeta.chainStep ?? 1) + 1}?</strong>
                  <span>{activeMeta.nextSteps[0].agentId}: {activeMeta.nextSteps[0].prompt}</span>
                  <div className="approval-actions">
                    <button type="button" disabled={resolvingApproval} onClick={() => void decide('reject')}>Reject</button>
                    <button type="button" disabled={resolvingApproval} onClick={() => void decide('approve')}>Approve &amp; run</button>
                  </div>
                </div>
              )}
              {canResume && activeMeta.nextSteps?.[0] && (
                <div className="approval-prompt" role="group" aria-label="Continue interrupted chain">
                  <strong>Next step was not started after the server restarted</strong>
                  <span>{activeMeta.nextSteps[0].agentId}: {activeMeta.nextSteps[0].prompt}</span>
                  <div className="approval-actions">
                    <button type="button" disabled={!connected || resumingChain} onClick={() => void resume()}>
                      {resumingChain ? 'Continuing…' : 'Continue next step'}
                    </button>
                  </div>
                </div>
              )}
              {followUps.length > 0 ? (
                <div className="task-followups">
                  Next: {followUps.map((task) => (
                    <button key={task.id} type="button" onClick={() => onSelectTask(task.id)}
                      title={task.prompt}>
                      {task.agentId} - {timeOf(task.createdAt)}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="bubble-body">{activeMeta.prompt}</div>
            </div>
            {activeMeta.mode === 'pty' ? (
              <TerminalPane
                key={activeMeta.id}
                taskId={activeMeta.id}
                running={activeMeta.status === 'running'}
                connected={connected}
                events={eventsForActive}
                onInput={onInput}
                onResize={onResize}
              />
            ) : <div className={`bubble agent ${activeMeta.status}`}>
              {eventsForActive.length === 0 ? (
                <div className="bubble-body dim">starting…</div>
              ) : (
                eventsForActive.map((event, index) => {
                  if (event.type === 'task.output') {
                    return (
                      <div key={index} className={`out-line ${event.stream}`}>
                        {event.data}
                      </div>
                    );
                  }
                  if (event.type === 'task.failed') {
                    return (
                      <div key={index} className="out-line stderr">
                        process error: {event.error}
                      </div>
                    );
                  }
                  if (event.type === 'task.completed') {
                    return (
                      <div key={index} className="out-footer">
                        exit {event.exitCode ?? 'null'}
                      </div>
                    );
                  }
                  if (event.type === 'task.aborted') {
                    return (
                      <div key={index} className="out-footer">
                        aborted
                      </div>
                    );
                  }
                  if (event.type === 'task.chain.stopped') {
                    return <div key={index} className="out-footer chain-stopped">
                      Chain stopped: {event.reason} ({event.skipped} step{event.skipped === 1 ? '' : 's'} skipped)
                    </div>;
                  }
                  if (event.type === 'task.chain.resumed') {
                    return <div key={index} className="out-footer">Chain continued manually</div>;
                  }
                  if (event.type === 'task.approval.requested') {
                    return <div key={index} className="out-footer">Waiting for approval before the next step</div>;
                  }
                  if (event.type === 'task.approval.resolved') {
                    return <div key={index} className="out-footer">Next step {event.decision}</div>;
                  }
                  return null;
                })
              )}
            </div>}
          </>
        ) : (
          <div className="empty-hint big">
            <span className="empty-icon" aria-hidden="true"><Bot size={27} strokeWidth={1.5} /></span>
            <strong>Ready when you are</strong>
            <span className="hint-sub">Select an agent and start a task.</span>
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-modes" role="group" aria-label="Task mode">
          <button type="button" className={!nextSteps.length ? 'active' : ''}
            aria-pressed={!nextSteps.length} onClick={() => setNextSteps([])}>Single</button>
          <button type="button" className={nextSteps.length ? 'active' : ''}
            aria-pressed={!!nextSteps.length} disabled={!execAgents.length}
            onClick={() => {
              if (nextSteps.length) return;
              if (!execAgents.some((agent) => agent.id === selectedAgent)) onSelectAgent(execAgents[0].id);
              setNextSteps([{ agentId: execAgents[0].id, prompt: '' }]);
            }}>Chain</button>
        </div>
        {sourceTask ? (
          <div className="handoff-source">
            <span>From {sourceTask.agentId}: {sourceTask.prompt}</span>
            <button type="button" onClick={() => setSourceTaskId(null)}>Clear</button>
          </div>
        ) : null}
        <div className="composer-row">
          <select aria-label="Agent" value={selectedAgent} onChange={(e) => onSelectAgent(e.target.value)}>
            {!selectedAgent && <option value="">No runnable agents</option>}
            {(nextSteps.length ? execAgents : agents.filter((agent) => agent.enabled !== false)).map((agent) => (
              <option key={agent.id} value={agent.id} disabled={!agent.available}>
                {agent.label}{agent.mode === 'pty' ? ' · terminal' : ''}{!agent.available ? ' · unavailable' : ''}
              </option>
            ))}
          </select>
        </div>
        <label className="directory-picker">
          <span>Working directory</span>
          {fixedDirectory ? <span className="directory-fixed">Set by server for this agent</span> :
            <select aria-label="Working directory" value={cwd} onChange={(event) => setCwd(event.target.value)}>
              <option value=".">Workspace root</option>
              {!directoryAvailable && <option value={cwd} disabled>{cwd} (missing)</option>}
              {directoryOptions.map((directory) => <option value={directory} key={directory}>{directory}</option>)}
            </select>}
        </label>
        {fixedChainDirectory && !fixedDirectory ? <div className="directory-note">
          Some chain steps use a directory configured on the server.
        </div> : null}
        {unavailableAgents.length > 0 && (
          <div className="agent-availability" role="status">
            Unavailable on server: {unavailableAgents.map((agent) => agent.label).join(', ')}
          </div>
        )}
        <textarea
          ref={promptRef}
          aria-label="Task prompt"
          value={prompt}
          placeholder="Describe the task… (Enter to run, Shift+Enter for newline)"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {nextSteps.map((step, index) => (
          <div className="chain-step-editor" key={index}>
            <div className="chain-step-header">
              <span>Step {index + 2}</span>
              <select aria-label={`Step ${index + 2} agent`} value={step.agentId}
                onChange={(event) => setNextSteps((prev) => prev.map((item, pos) =>
                  pos === index ? { ...item, agentId: event.target.value } : item))}>
                {execAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
              </select>
              <button type="button" aria-label={`Remove step ${index + 2}`} title={`Remove step ${index + 2}`}
                onClick={() => setNextSteps((prev) => prev.filter((_, pos) => pos !== index))}>×</button>
            </div>
            <textarea aria-label={`Step ${index + 2} prompt`} value={step.prompt} placeholder="What should this agent do with the previous output?"
              onChange={(event) => setNextSteps((prev) => prev.map((item, pos) =>
                pos === index ? { ...item, prompt: event.target.value } : item))} />
            <label className="chain-approval-choice">
              <input type="checkbox" checked={!!step.requiresApproval}
                onChange={(event) => setNextSteps((prev) => prev.map((item, pos) =>
                  pos === index ? { ...item, requiresApproval: event.target.checked } : item))} />
              Review before this step
            </label>
          </div>
        ))}
        {nextSteps.length > 0 && nextSteps.length < 3 ? (
          <button type="button" className="chain-add" onClick={() => setNextSteps((prev) =>
            [...prev, { agentId: execAgents[0].id, prompt: '' }])}>Add step</button>
        ) : null}
        <div className="composer-row">
          <span className="dim small">{activeMeta?.status ?? 'idle'}</span>
          <button type="button" className="run" onClick={() => void submit()} disabled={!canRun}>
            <ArrowUp size={17} aria-hidden="true" />{submitting ? 'Starting…' : nextSteps.length ? `Run ${nextSteps.length + 1} steps` : 'Run task'}
          </button>
        </div>
      </div>
    </div>
  );
}
