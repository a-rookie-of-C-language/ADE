import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitChange, GitChanges, GitDiff } from '@ade/shared';
import { HttpError, toAbsolute } from './paths.js';

const exec = promisify(execFile);
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const indexQueues = new Map<string, Promise<void>>();

async function git(root: string, ...args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await exec('git', ['-C', root, ...args], {
      encoding: 'buffer', maxBuffer: 5 * 1024 * 1024, timeout: 10000,
      windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' },
    });
    return stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(503, 'Git is not installed on the ADE server');
    }
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new HttpError(413, 'Git output is too large to preview');
    }
    throw error;
  }
}

export async function getGitChanges(root: string): Promise<GitChanges> {
  let repoRoot: string;
  try {
    repoRoot = (await git(root, 'rev-parse', '--show-toplevel')).toString('utf8').trim();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return { available: false, changes: [] };
  }
  if (path.normalize(await fs.realpath(repoRoot)) !== path.normalize(await fs.realpath(root))) {
    return { available: false, changes: [] };
  }

  const records = (await git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'))
    .toString('utf8').split('\0');
  const changes: GitChange[] = [];
  for (let i = 0; i < records.length && records[i]; i++) {
    const record = records[i];
    if (record.length < 4 || record[2] !== ' ') continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const change: GitChange = {
      path: record.slice(3), indexStatus, worktreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
      working: worktreeStatus !== ' ' || indexStatus === '?',
      conflicted: CONFLICTS.has(record.slice(0, 2)) || indexStatus === 'U' || worktreeStatus === 'U',
    };
    // In porcelain -z output, a rename is followed by the old path.
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
      change.previousPath = records[++i];
    }
    if (change.path !== '.ade' && !change.path.startsWith('.ade/')) changes.push(change);
  }
  return { available: true, changes };
}

function decodeDiff(buffer: Buffer): string {
  if (buffer.length > MAX_DIFF_BYTES) throw new HttpError(413, 'Diff side is larger than 2 MB');
  if (buffer.includes(0)) throw new HttpError(415, 'Binary files cannot be previewed');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new HttpError(415, 'Non-UTF-8 files cannot be previewed');
  }
}

async function blob(root: string, rev: 'HEAD' | ':', file: string): Promise<string> {
  try {
    return decodeDiff(await git(root, 'show', rev === ':' ? `:${file}` : `HEAD:${file}`));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, 'Git changed while opening the diff; refresh Changes');
  }
}

async function workingFile(root: string, file: string): Promise<string> {
  const abs = toAbsolute(root, file);
  try {
    const real = await fs.realpath(abs);
    const realRoot = await fs.realpath(root);
    const stat = await fs.lstat(abs);
    if (!real.startsWith(realRoot + path.sep) || !stat.isFile()) {
      throw new HttpError(415, 'Links and non-file entries cannot be previewed');
    }
    if (stat.size > MAX_DIFF_BYTES) throw new HttpError(413, 'Diff side is larger than 2 MB');
    return decodeDiff(await fs.readFile(abs));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(409, 'File changed while opening the diff; refresh Changes');
    }
    throw error;
  }
}

export async function getGitDiff(root: string, file: string, side: 'staged' | 'working'): Promise<GitDiff> {
  toAbsolute(root, file);
  const { available, changes } = await getGitChanges(root);
  if (!available) throw new HttpError(404, 'Workspace root is not a Git repository');
  const change = changes.find((item) => item.path === file &&
    (side === 'staged' ? item.staged : item.working));
  if (!change || change.conflicted || (side === 'staged' ? !change.staged : !change.working)) {
    throw new HttpError(404, 'Change not found on this side');
  }
  const renamed = (side === 'staged' ? change.indexStatus : change.worktreeStatus) === 'R';
  const oldPath = renamed ? change.previousPath ?? file : file;
  const original = side === 'staged'
    ? change.indexStatus === 'A' ? '' : await blob(root, 'HEAD', oldPath)
    : change.indexStatus === '?' ? '' : await blob(root, ':', oldPath);
  const modified = side === 'staged'
    ? change.indexStatus === 'D' ? '' : await blob(root, ':', file)
    : change.worktreeStatus === 'D' ? '' : await workingFile(root, file);
  const revision = crypto.createHash('sha256').update(JSON.stringify({
    path: file, side, original, modified,
    indexStatus: change.indexStatus, worktreeStatus: change.worktreeStatus,
    previousPath: change.previousPath,
  })).digest('hex');
  return { path: file, side, original, modified, revision };
}

export async function updateGitIndex(root: string, file: string, action: 'stage' | 'unstage',
  expectedRevision: string): Promise<void> {
  if (typeof file !== 'string' || !file || typeof expectedRevision !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(expectedRevision) || (action !== 'stage' && action !== 'unstage')) {
    throw new HttpError(400, 'A file, action and review revision are required');
  }
  toAbsolute(root, file);
  if (file.split('/').some((segment) => segment === '.git' || segment === '.ade')) {
    throw new HttpError(400, 'Internal workspace files cannot be staged');
  }

  const previous = indexQueues.get(root) ?? Promise.resolve();
  let done!: () => void;
  const pending = new Promise<void>((resolve) => { done = resolve; });
  indexQueues.set(root, pending);
  await previous;
  try {
    const side = action === 'stage' ? 'working' : 'staged';
    const current = await getGitDiff(root, file, side);
    if (current.revision !== expectedRevision) {
      throw new HttpError(409, 'Git change no longer matches the reviewed version');
    }
    const { changes } = await getGitChanges(root);
    const change = changes.find((entry) => entry.path === file);
    if (!change || change.conflicted ||
        (change.previousPath && change.previousPath.split('/').some((segment) => segment === '.git' || segment === '.ade'))) {
      throw new HttpError(409, 'Git change is no longer available');
    }
    const paths = change.previousPath ? [change.previousPath, file] : [file];
    try {
      if (action === 'stage') await git(root, 'add', '-A', '--', ...paths);
      else if (change.indexStatus === 'A') await git(root, 'rm', '--cached', '--', file);
      else await git(root, 'restore', '--staged', '--', ...paths);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, 'Git changed while updating the index; refresh Changes');
    }
  } finally {
    done();
    if (indexQueues.get(root) === pending) indexQueues.delete(root);
  }
}
