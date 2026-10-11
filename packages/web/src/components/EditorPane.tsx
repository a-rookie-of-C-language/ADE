import { useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { languageForPath } from './monaco-setup';
import './monaco-setup';

export interface OpenFile {
  path: string;
  content: string;
  saved: string;
}

interface Props {
  tabs: OpenFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export default function EditorPane({ tabs, activePath, onSelect, onClose, onChange, onSave }: Props) {
  const active = tabs.find((tab) => tab.path === activePath) ?? null;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (activePath) onSave(activePath);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activePath, onSave]);

  return (
    <div className="editor-pane">
      <div className="tabs">
        {tabs.map((tab) => {
          const dirty = tab.content !== tab.saved;
          return (
            <div
              key={tab.path}
              className={`tab${tab.path === activePath ? ' active' : ''}`}
              onClick={() => onSelect(tab.path)}
              role="tab"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(tab.path)}
            >
              <span className="tab-name">
                {baseName(tab.path)}
                {dirty ? <span className="dirty-dot" title="Unsaved changes" /> : null}
              </span>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${tab.path}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.path);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="editor-host">
        {active ? (
          <Editor
            key={active.path}
            value={active.content}
            language={languageForPath(active.path)}
            theme="vs-dark"
            onChange={(value) => onChange(active.path, value ?? '')}
            options={{
              fontSize: 13,
              fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
              minimap: { enabled: false },
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              renderWhitespace: 'selection',
              padding: { top: 10 },
            }}
          />
        ) : (
          <div className="empty-hint big">
            Select a file from the workspace
            <span className="hint-sub">Ctrl/Cmd+S saves to the server</span>
          </div>
        )}
      </div>
      {active ? (
        <div className="editor-status">
          <span className="mono">{active.path}</span>
          <span>{active.content !== active.saved ? 'unsaved' : 'saved'}</span>
        </div>
      ) : null}
    </div>
  );
}