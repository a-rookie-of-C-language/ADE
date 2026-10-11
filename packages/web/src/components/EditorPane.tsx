import { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { DiffEditor } from '@monaco-editor/react';
import { Check, Code2, Link2, Users, X } from 'lucide-react';
import { languageForPath } from './monaco-setup';
import './monaco-setup';

export interface OpenFile {
  sessionId: string;
  path: string;
  content: string;
  saved: string;
  revision: string;
  conflict?: { content: string | null; revision: string | null };
  comparing?: boolean;
}

interface Props {
  tabs: OpenFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onCopyLink: (path: string) => Promise<boolean>;
  onClose: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  onCompare: (path: string) => void;
  onUseDisk: (path: string) => void;
  onOverwrite: (path: string) => void;
  saving: boolean;
  otherViewers: number;
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export default function EditorPane({ tabs, activePath, onSelect, onCopyLink, onClose, onChange, onSave, onCompare, onUseDisk, onOverwrite, saving, otherViewers }: Props) {
  const active = tabs.find((tab) => tab.path === activePath) ?? null;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => setCopied(false), [activePath]);

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
      <div className="editor-tab-bar">
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
                  {tab.conflict ? <span className="conflict-dot" title="Disk version changed" />
                    : dirty ? <span className="dirty-dot" title="Unsaved changes" /> : null}
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
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        {active ? <button type="button" className="editor-share"
          title={copied ? 'Link copied' : 'Copy link to file'}
          aria-label={copied ? 'Link copied' : 'Copy link to file'}
          onClick={() => { void onCopyLink(active.path).then((ok) => { if (ok) setCopied(true); }); }}>
          {copied ? <Check size={16} /> : <Link2 size={16} />}
        </button> : null}
      </div>
      {active?.conflict ? (
        <div className="editor-conflict" role="alert">
          <span>{active.conflict.content === null ? 'File removed on disk. Your draft is still here.' :
            'File changed on disk. Your draft is still here.'}</span>
          <div className="editor-conflict-actions">
            {active.conflict.content !== null ? (
              <>
                <button type="button" onClick={() => onCompare(active.path)}>
                  {active.comparing ? 'Edit draft' : 'Compare'}
                </button>
                <button type="button" onClick={() => onUseDisk(active.path)}>Use disk version</button>
              </>
            ) : null}
            <button type="button" disabled={saving} onClick={() => onOverwrite(active.path)}>
              {active.conflict.content === null ? 'Restore draft' : 'Overwrite disk'}
            </button>
          </div>
        </div>
      ) : null}
      <div className="editor-host">
        {active ? (
          active.comparing && active.conflict?.content !== null && active.conflict ? (
            <DiffEditor
              key={`${active.path}:diff`}
              original={active.conflict.content}
              modified={active.content}
              originalModelPath="ade-diff:///original"
              modifiedModelPath="ade-diff:///modified"
              keepCurrentOriginalModel
              keepCurrentModifiedModel
              language={languageForPath(active.path)}
              theme="ade-dark"
              options={{ readOnly: true, originalEditable: false, automaticLayout: true,
                renderSideBySide: false, minimap: { enabled: false } }}
            />
          ) : (
            <Editor
              key={active.path}
              value={active.content}
              language={languageForPath(active.path)}
              theme="ade-dark"
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
          )
        ) : (
          <div className="empty-hint big">
            <span className="empty-icon" aria-hidden="true"><Code2 size={27} strokeWidth={1.5} /></span>
            <strong>No file open</strong>
            <span className="hint-sub">Choose a file from Explorer to start editing.</span>
          </div>
        )}
      </div>
      {active ? (
        <div className="editor-status">
          <span className="mono editor-status-path" title={active.path}>{active.path}</span>
          <span className="editor-status-right">
            {otherViewers > 0 ? <span className="editor-viewers" title="Other live connections viewing this file; editing is not locked">
              <Users size={13} aria-hidden="true" /> {otherViewers} other{otherViewers === 1 ? '' : 's'} viewing
            </span> : null}
            <span>{saving ? 'saving' : active.conflict ? 'disk conflict' : active.content !== active.saved ? 'unsaved' : 'saved'}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
