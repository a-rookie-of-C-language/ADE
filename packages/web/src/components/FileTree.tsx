import { useState } from 'react';
import type { FileNode } from '@ade/shared';

interface Props {
  root: FileNode | null;
  activePath: string | null;
  onOpen: (path: string) => void;
}

function TreeNode({
  node,
  depth,
  activePath,
  onOpen,
}: {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);

  if (node.type === 'dir') {
    return (
      <div>
        <button
          type="button"
          className="tree-row tree-dir"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`chevron${open ? ' open' : ''}`}>›</span>
          <span className="tree-name">{node.name}</span>
        </button>
        {open &&
          node.children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpen={onOpen}
            />
          ))}
      </div>
    );
  }

  const active = node.path === activePath;
  return (
    <button
      type="button"
      className={`tree-row tree-file${active ? ' active' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 + 14 }}
      onClick={() => onOpen(node.path)}
      title={node.path}
    >
      <span className="tree-name">{node.name}</span>
    </button>
  );
}

export default function FileTree({ root, activePath, onOpen }: Props) {
  return (
    <div className="tree">
      {root ? (
        <TreeNode node={root} depth={0} activePath={activePath} onOpen={onOpen} />
      ) : (
        <div className="empty-hint">Loading workspace…</div>
      )}
    </div>
  );
}