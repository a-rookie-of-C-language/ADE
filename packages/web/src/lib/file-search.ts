import type { FileNode } from '@ade/shared';

export interface FileMatch {
  name: string;
  path: string;
}

export function collectFiles(root: FileNode | null): FileMatch[] {
  if (!root) return [];
  const files: FileMatch[] = [];
  const visit = (node: FileNode): void => {
    if (node.type === 'file') {
      files.push({ name: node.name, path: node.path });
      return;
    }
    node.children?.forEach(visit);
  };
  visit(root);
  return files;
}

export function findFiles(files: FileMatch[], query: string, limit = 100): FileMatch[] {
  const term = query.trim().toLocaleLowerCase();
  return files
    .filter((file) => file.path.toLocaleLowerCase().includes(term))
    .sort((a, b) => {
      const rank = (file: FileMatch): number => {
        const name = file.name.toLocaleLowerCase();
        if (!term) return 0;
        if (name === term) return 0;
        if (name.startsWith(term)) return 1;
        if (name.includes(term)) return 2;
        return 3;
      };
      return rank(a) - rank(b) || a.path.localeCompare(b.path);
    })
    .slice(0, Math.max(0, limit));
}
