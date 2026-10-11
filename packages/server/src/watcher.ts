import chokidar from 'chokidar';
import type { FileChangeEvent } from '@ade/shared';
import { IGNORED_DIRS, toRelative } from './paths.js';

/** Watch the workspace and broadcast file changes to every connected device. */
export function startWatcher(root: string, onChange: (event: FileChangeEvent) => void): () => void {
  const ignored = (watchedPath: string): boolean => {
    const rel = toRelative(root, watchedPath);
    if (!rel) return false;
    return rel.split('/').some((segment) => IGNORED_DIRS.has(segment));
  };

  const watcher = chokidar.watch(root, {
    ignored,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });

  const handle = (action: FileChangeEvent['action']) => (abs: string) => {
    const rel = toRelative(root, abs);
    if (!rel) return;
    onChange({ type: 'file.changed', path: rel, action, ts: Date.now() });
  };

  watcher.on('add', handle('add'));
  watcher.on('change', handle('change'));
  watcher.on('unlink', handle('unlink'));

  return () => {
    void watcher.close();
  };
}