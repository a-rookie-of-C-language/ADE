import fs from 'node:fs';
import path from 'node:path';

/** Directories that are pruned from the tree / watcher / traversal targets. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.ade',
  'dist',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.venv',
]);

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Resolve a workspace-relative path safely and return its absolute form. */
export function toAbsolute(root: string, rel: string): string {
  const normalizedRoot = path.resolve(root);
  const abs = path.resolve(normalizedRoot, rel.replace(/\\/g, '/'));
  if (abs === normalizedRoot) {
    throw new HttpError(400, 'Path must point to a file inside the workspace, not the root');
  }
  if (!abs.startsWith(normalizedRoot + path.sep)) {
    throw new HttpError(400, 'Path escapes the workspace');
  }
  return abs;
}

/** Like toAbsolute, but allows the workspace root itself (for task cwd). */
export function toAbsoluteDir(root: string, rel: string): string {
  if (typeof rel !== 'string') throw new HttpError(400, 'Invalid working directory');
  const normalizedRoot = path.resolve(root);
  const abs = path.resolve(normalizedRoot, rel.replace(/\\/g, '/'));
  if (!abs.startsWith(normalizedRoot + path.sep) && abs !== normalizedRoot) {
    throw new HttpError(400, 'Path escapes the workspace');
  }
  // A lexically contained path can still escape through a symlink or junction.
  let current = normalizedRoot;
  for (const part of path.relative(normalizedRoot, abs).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(400, 'Working directory does not exist');
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new HttpError(400, 'Working directory must be a real folder');
  }
  if (!fs.statSync(abs).isDirectory()) throw new HttpError(400, 'Working directory must be a folder');
  return abs;
}

/** Convert an absolute path into a workspace-relative POSIX-style path. */
export function toRelative(root: string, abs: string): string {
  return path.relative(path.resolve(root), abs).split(path.sep).join('/');
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
