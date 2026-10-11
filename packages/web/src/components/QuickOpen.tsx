import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { FileNode } from '@ade/shared';
import { collectFiles, findFiles } from '../lib/file-search';

interface Props {
  root: FileNode | null;
  onOpen: (path: string) => void;
  onClose: () => void;
}

export default function QuickOpen({ root, onOpen, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const files = useMemo(() => collectFiles(root), [root]);
  const matches = useMemo(() => findFiles(files, query), [files, query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const open = (path: string) => {
    onOpen(path);
    onClose();
  };

  return (
    <dialog ref={dialogRef} className="quick-open" aria-labelledby="quick-open-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === dialogRef.current) onClose(); }}>
      <div className="quick-open-header">
        <Search size={18} aria-hidden="true" />
        <h2 id="quick-open-title">Open file</h2>
        <button type="button" className="quick-open-close" title="Close" aria-label="Close" onClick={onClose}><X size={18} /></button>
      </div>
      <input type="search" autoFocus aria-label="Find file" placeholder="Find file by name or path"
        value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (matches.length) setSelected((current) =>
              (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
          } else if (event.key === 'Enter' && matches.length) {
            event.preventDefault();
            open(matches[Math.min(selected, matches.length - 1)].path);
          }
        }} />
      <div className="quick-open-results" aria-label="Matching files">
        {matches.length ? matches.map((file, index) => (
          <button type="button" key={file.path} className={index === selected ? 'selected' : ''}
            onMouseEnter={() => setSelected(index)} onClick={() => open(file.path)}>
            <span className="quick-open-name">{file.name}</span>
            <span className="quick-open-path">{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : root?.name}</span>
          </button>
        )) : <div className="empty-hint">{files.length ? 'No matching files' : 'No files in workspace'}</div>}
      </div>
    </dialog>
  );
}
