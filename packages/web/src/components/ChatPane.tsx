import { useEffect, useRef, useState } from 'react';
import type { AgentDefinition, TaskEvent, TaskMeta } from '@ade/shared';

interface Props {
  agents: AgentDefinition[];
  selectedAgent: string;
  onSelectAgent: (agentId: string) => void;
  tasks: TaskMeta[];
  activeTaskId: string | null;
  eventsForActive: TaskEvent[];
  onSelectTask: (taskId: string) => void;
  onRun: (agentId: string, prompt: string) => void;
  onAbort: (taskId: string) => void;
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

export default function ChatPane({
  agents,
  selectedAgent,
  onSelectAgent,
  tasks,
  activeTaskId,
  eventsForActive,
  onSelectTask,
  onRun,
  onAbort,
}: Props) {
  const [prompt, setPrompt] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeMeta = tasks.find((task) => task.id === activeTaskId) ?? null;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [eventsForActive.length, activeTaskId]);

  const submit = (): void => {
    const trimmed = prompt.trim();
    if (!trimmed || !selectedAgent) return;
    onRun(selectedAgent, trimmed);
    setPrompt('');
  };

  return (
    <div className="chat-pane">
      <div className="task-list">
        <div className="pane-title">Tasks</div>
        {tasks.length === 0 ? (
          <div className="empty-hint">No tasks yet — dispatch one below.</div>
        ) : (
          tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={`task-row${task.id === activeTaskId ? ' active' : ''}`}
              onClick={() => onSelectTask(task.id)}
            >
              <span className={`status-dot ${statusClass[task.status]}`} />
              <span className="task-agent">{task.agentId}</span>
              <span className="task-prompt">{task.prompt || '(empty)'}</span>
              <span className="task-time">{timeOf(task.createdAt)}</span>
            </button>
          ))
        )}
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
                ) : null}
              </div>
              <div className="bubble-body">{activeMeta.prompt}</div>
            </div>
            <div className={`bubble agent ${activeMeta.status}`}>
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
                  return null;
                })
              )}
            </div>
          </>
        ) : (
          <div className="empty-hint big">
            Dispatch a task to an agent
            <span className="hint-sub">codex · claude · pi — anything with a CLI</span>
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-row">
          <select value={selectedAgent} onChange={(e) => onSelectAgent(e.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label}
              </option>
            ))}
          </select>
        </div>
        <textarea
          value={prompt}
          placeholder="Describe the task… (Enter to run, Shift+Enter for newline)"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-row">
          <span className="dim small">{activeMeta?.status ?? 'idle'}</span>
          <button type="button" className="run" onClick={submit} disabled={!prompt.trim()}>
            Run
          </button>
        </div>
      </div>
    </div>
  );
}