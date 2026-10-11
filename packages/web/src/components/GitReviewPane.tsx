import type { GitDiff } from '@ade/shared';
import { DiffEditor } from '@monaco-editor/react';
import { ArrowLeft, Plus, Undo2 } from 'lucide-react';
import { languageForPath } from './monaco-setup';
import type { ReviewSelection } from './GitChangesPane';
import './monaco-setup';

interface Props {
  selection: ReviewSelection;
  diff: GitDiff | null;
  error: string | null;
  actionError: string | null;
  busy: boolean;
  onBack: () => void;
  onIndexChange: (selection: ReviewSelection, revision: string) => void;
}

export default function GitReviewPane({ selection, diff, error, actionError, busy, onBack, onIndexChange }: Props) {
  const currentDiff = diff?.path === selection.path && diff.side === selection.side ? diff : null;
  return (
    <div className="review-pane">
      <div className="review-header">
        <button type="button" className="review-back" onClick={onBack} title="Back to editor" aria-label="Back to editor">
          <ArrowLeft size={17} />
        </button>
        <span className="review-path" title={selection.path}>{selection.path}</span>
        <span className="review-side">{selection.side === 'staged' ? 'HEAD to index' : 'Index to disk'}</span>
        <button type="button" className="review-action" disabled={!currentDiff || busy || Boolean(error)}
          onClick={() => currentDiff && onIndexChange(selection, currentDiff.revision)}
          title={selection.side === 'staged' ? 'Remove this file from staging' : 'Stage this entire file'}>
          {selection.side === 'staged' ? <Undo2 size={16} /> : <Plus size={16} />}
          {busy ? 'Working…' : selection.side === 'staged' ? 'Unstage' : 'Stage'}
        </button>
      </div>
      {actionError ? <div className="review-alert" role="alert">{actionError}</div> : null}
      <div className="review-host">
        {error ? <div className="empty-hint big" role="alert">{error}</div> : diff ? (
          <DiffEditor
            key={`${selection.side}:${selection.path}`}
            original={diff.original}
            modified={diff.modified}
            language={languageForPath(selection.path)}
            theme="ade-dark"
            options={{ readOnly: true, originalEditable: false, automaticLayout: true,
              renderSideBySide: false, minimap: { enabled: false }, scrollBeyondLastLine: false }}
          />
        ) : <div className="empty-hint big">Loading diff...</div>}
      </div>
    </div>
  );
}
