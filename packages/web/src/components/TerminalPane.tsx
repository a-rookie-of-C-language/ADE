import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TaskEvent } from '@ade/shared';

interface Props {
  taskId: string;
  running: boolean;
  connected: boolean;
  events: TaskEvent[];
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export default function TerminalPane({ taskId, running, connected, events, onInput, onResize }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const callbacks = useRef({ onInput, onResize });
  callbacks.current = { onInput, onResize };
  const canInput = useRef(running && connected);
  canInput.current = running && connected;

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontSize: 12,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      theme: { background: '#121819', foreground: '#e5e9e7', cursor: '#68d6ae' },
      scrollback: 3000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    terminal.current = term;
    const input = term.onData((data) => { if (canInput.current) callbacks.current.onInput(data); });
    const resize = new ResizeObserver(() => {
      if (!container.clientWidth || !container.clientHeight) return;
      fit.fit();
      callbacks.current.onResize(term.cols, term.rows);
    });
    resize.observe(container);
    fit.fit();
    callbacks.current.onResize(term.cols, term.rows);
    term.focus();

    return () => {
      resize.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [taskId]);

  useEffect(() => {
    if (connected && running && terminal.current) callbacks.current.onResize(terminal.current.cols, terminal.current.rows);
  }, [connected, running, taskId]);

  const lastWritten = useRef<TaskEvent | null>(null);
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    const index = lastWritten.current ? events.indexOf(lastWritten.current) : -1;
    if (lastWritten.current && index < 0) {
      term.reset();
    }
    for (const event of events.slice(index < 0 ? 0 : index + 1)) {
      if (event.type === 'task.output' && event.stream === 'pty') term.write(event.data);
      if (event.type === 'task.failed') term.writeln(`\r\nProcess error: ${event.error}`);
    }
    lastWritten.current = events.at(-1) ?? null;
  }, [events]);

  const sendKey = (data: string) => {
    if (running && connected) callbacks.current.onInput(data);
    terminal.current?.focus();
  };

  return (
    <div className="terminal-wrap">
      <div className="terminal-host" ref={host} aria-label="Interactive agent terminal" />
      {running && !connected ? <div className="terminal-offline">Reconnecting to terminal...</div> : null}
      {running ? (
        <div className="terminal-keys" aria-label="Terminal quick keys">
          <button type="button" disabled={!connected} onClick={() => sendKey('\r')}>Enter</button>
          <button type="button" disabled={!connected} onClick={() => sendKey('\x1b')}>Esc</button>
          <button type="button" disabled={!connected} onClick={() => sendKey('\x03')}>Ctrl+C</button>
          <button type="button" disabled={!connected} onClick={() => sendKey('\x1b[A')}>↑</button>
          <button type="button" disabled={!connected} onClick={() => sendKey('\x1b[B')}>↓</button>
        </div>
      ) : null}
    </div>
  );
}
