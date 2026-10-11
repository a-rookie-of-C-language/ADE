import type { GitChange, GitChanges } from '@ade/shared';
import { RefreshCw } from 'lucide-react';

export interface ReviewSelection {
  path: string;
  side: 'staged' | 'working';
}

interface Props {
  data: GitChanges | null;
  error: string | null;
  selected: ReviewSelection | null;
  onSelect: (selection: ReviewSelection) => void;
  onRefresh: () => void;
}

function changeLabel(change: GitChange, side: ReviewSelection['side']): string {
  const code = side === 'staged' ? change.indexStatus : change.worktreeStatus;
  return ({ A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', '?': 'Untracked',
    T: 'Type changed', U: 'Conflict' } as Record<string, string>)[code] ?? 'Changed';
}

export default function GitChangesPane({ data, error, selected, onSelect, onRefresh }: Props) {
  const staged = data?.changes.filter((change) => change.staged) ?? [];
  const working = data?.changes.filter((change) => change.working) ?? [];
  const renderGroup = (title: string, side: ReviewSelection['side'], changes: GitChange[]) => (
    <section className="change-group" key={side}>
      <div className="change-group-title">{title} <span>{changes.length}</span></div>
      {changes.map((change) => (
        <button
          type="button"
          key={change.path}
          className={`change-row${selected?.path === change.path && selected.side === side ? ' active' : ''}`}
          onClick={() => onSelect({ path: change.path, side })}
          title={change.previousPath ? `${change.previousPath} -> ${change.path}` : change.path}
          aria-label={`${changeLabel(change, side)}: ${change.path}${change.previousPath ? ` (from ${change.previousPath})` : ''}`}
          aria-current={selected?.path === change.path && selected.side === side ? 'true' : undefined}
          disabled={change.conflicted}
        >
          <span className="change-code" aria-hidden="true">
            {side === 'staged' ? change.indexStatus : change.worktreeStatus === '?' ? 'U' : change.worktreeStatus}
          </span>
          <span className="change-path">{change.path}</span>
        </button>
      ))}
    </section>
  );

  return (
    <div className="changes-pane">
      <div className="changes-toolbar">
        <span>{data?.available ? `${data.changes.length} changed` : 'Git'}</span>
        <button type="button" onClick={onRefresh} title="Refresh changes" aria-label="Refresh changes">
          <RefreshCw size={16} />
        </button>
      </div>
      {error ? <div className="changes-message" role="alert">{error}</div> :
        data === null ? <div className="changes-message">Loading changes...</div> :
        !data.available ? <div className="changes-message">Workspace is not a Git repository.</div> :
        !data.changes.length ? <div className="changes-message">No changes</div> : (
          <>
            {staged.length ? renderGroup('Staged', 'staged', staged) : null}
            {working.length ? renderGroup('Working tree', 'working', working) : null}
          </>
        )}
    </div>
  );
}
