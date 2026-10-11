import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, FilePlus2, FolderPlus, MoreHorizontal, X } from 'lucide-react';
import type { FileNode } from '@ade/shared';

type Action = { kind: 'file' | 'folder'; parent: string } | { kind: 'rename'; path: string };

interface Props {
  root: FileNode | null;
  activePath: string | null;
  onOpen: (path: string) => void;
  onCreateFile: (path: string) => Promise<boolean>;
  onCreateFolder: (path: string) => Promise<boolean>;
  onRename: (from: string, to: string) => Promise<boolean>;
  onDelete: (path: string) => Promise<void>;
  onDeleteFolder: (path: string) => Promise<void>;
}

export default function FileTree({ root, activePath, onOpen, onCreateFile, onCreateFolder, onRename, onDelete, onDeleteFolder }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [menu, setMenu] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuContainerRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      menuTriggerRef.current?.focus();
      setMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  function start(next: Action) {
    setMenu(null);
    setAction(next);
    setName(next.kind === 'rename' ? next.path.split('/').pop() ?? '' : '');
    if (next.kind !== 'rename') setExpanded((prev) => new Set(prev).add(next.parent));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action || busy) return;
    const value = name.trim();
    if (!value || value === '.' || value === '..' || /[\\/]/.test(value)) return;
    const parent = action.kind === 'rename' ? action.path.split('/').slice(0, -1).join('/') : action.parent;
    const target = [parent, value].filter(Boolean).join('/');
    if (action.kind === 'rename' && target === action.path) { setAction(null); return; }
    setBusy(true);
    try {
      const ok = action.kind === 'rename' ? await onRename(action.path, target)
        : action.kind === 'folder' ? await onCreateFolder(target) : await onCreateFile(target);
      if (ok) setAction(null);
    } finally {
      setBusy(false);
    }
  }

  function row(node: FileNode, depth: number) {
    const isDir = node.type === 'dir';
    const open = expanded.has(node.path);
    return (
      <div key={node.path}>
        <div className="tree-entry" ref={menu === node.path ? menuContainerRef : undefined}>
          <button type="button" className={`tree-row ${isDir ? 'tree-dir' : 'tree-file'}${node.path === activePath ? ' active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }} title={node.path || root?.name}
            aria-expanded={isDir ? open : undefined}
            onClick={() => isDir ? setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
              return next;
            }) : onOpen(node.path)}>
            <span className={`chevron${open ? ' open' : ''}`}>{isDir ? '›' : ''}</span>
            <span className="tree-name">{node.name}</span>
          </button>
          {node.path && (
            <button type="button" className="tree-more" title={`Actions for ${node.path}`}
              ref={menu === node.path ? menuTriggerRef : undefined}
              aria-label={`Actions for ${node.path}`} aria-expanded={menu === node.path}
              onClick={() => setMenu(menu === node.path ? null : node.path)}><MoreHorizontal size={16} /></button>
          )}
          {menu === node.path && node.path && (
            <div className="tree-menu">
              {isDir ? <>
                <button type="button" onClick={() => start({ kind: 'file', parent: node.path })}>New file</button>
                <button type="button" onClick={() => start({ kind: 'folder', parent: node.path })}>New folder</button>
                <button type="button" onClick={() => { setMenu(null); void onDeleteFolder(node.path); }}>Delete empty folder</button>
              </> : <>
                <button type="button" onClick={() => start({ kind: 'rename', path: node.path })}>Rename</button>
                <button type="button" onClick={() => { setMenu(null); void onDelete(node.path); }}>Delete</button>
              </>}
            </div>
          )}
        </div>
        {isDir && open && node.children?.map((child) => row(child, depth + 1))}
      </div>
    );
  }

  return (
    <div className="tree">
      <div className="tree-toolbar">
        <span>Explorer</span>
        <button type="button" title="New file" aria-label="New file" onClick={() => start({ kind: 'file', parent: '' })}>
          <FilePlus2 size={16} />
        </button>
        <button type="button" title="New folder" aria-label="New folder" onClick={() => start({ kind: 'folder', parent: '' })}>
          <FolderPlus size={16} />
        </button>
      </div>
      {action && <form className="tree-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="tree-name-input">{action.kind === 'rename' ? 'Rename file' : `New ${action.kind}`}</label>
        <span className="tree-form-parent" title={action.kind === 'rename' ? action.path : action.parent}>
          {action.kind === 'rename' ? action.path : action.parent || root?.name}
        </span>
        <div className="tree-form-input">
          <input id="tree-name-input" autoFocus required value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
          <button type="submit" title="Apply" aria-label="Apply" disabled={busy}><Check size={16} /></button>
          <button type="button" title="Cancel" aria-label="Cancel" disabled={busy} onClick={() => setAction(null)}><X size={16} /></button>
        </div>
      </form>}
      {root ? row(root, 0) : <div className="empty-hint">Loading workspace…</div>}
    </div>
  );
}
