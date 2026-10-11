import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';
import type { FileNode } from '@ade/shared';
import { HttpError, IGNORED_DIRS, toAbsolute, toRelative } from './paths.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_DEPTH = 14;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const pendingWrites = new Map<string, Promise<void>>();

async function checkWorkspacePath(root: string, abs: string): Promise<void> {
  let current = path.resolve(root);
  const parts = path.relative(current, abs).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (IGNORED_DIRS.has(part)) throw new HttpError(400, 'Path is not available in the workspace tree');
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new HttpError(400, 'Symbolic links are not supported');
      if (index < parts.length - 1 && !stat.isDirectory()) throw new HttpError(400, 'Parent is not a directory');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

async function ensureParent(root: string, abs: string): Promise<void> {
  const parent = path.dirname(abs);
  const rel = path.relative(path.resolve(root), parent);
  let current = path.resolve(root);
  for (const part of rel ? rel.split(path.sep) : []) {
    current = path.join(current, part);
    try {
      await fs.mkdir(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HttpError(400, 'Parent is not a directory');
  }
}

function revision(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function currentRevision(abs: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) throw new HttpError(400, 'Symbolic links are not supported');
    if (!stat.isFile()) throw new HttpError(400, 'Not a file');
    if (stat.size > MAX_FILE_BYTES) throw new HttpError(413, 'File is larger than 2 MB');
    const handle = await fs.open(abs, constants.O_RDONLY | NOFOLLOW);
    let buf: Buffer;
    try {
      buf = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (buf.length > MAX_FILE_BYTES) throw new HttpError(413, 'File is larger than 2 MB');
    return revision(buf);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function withWriteLock<T>(abs: string, work: () => Promise<T>): Promise<T> {
  const previous = pendingWrites.get(abs);
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  pendingWrites.set(abs, done);
  if (previous) await previous;
  try {
    return await work();
  } finally {
    release();
    if (pendingWrites.get(abs) === done) pendingWrites.delete(abs);
  }
}

function withPathLocks<T>(paths: string[], work: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort();
  const lock = (index: number): Promise<T> => index === ordered.length
    ? work() : withWriteLock(ordered[index], () => lock(index + 1));
  return lock(0);
}

export async function buildTree(root: string): Promise<FileNode> {
  async function walk(abs: string, depth: number): Promise<FileNode[]> {
    if (depth > MAX_TREE_DEPTH) return [];
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const visible = entries.filter((e) => !IGNORED_DIRS.has(e.name));
    const dirs = visible.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = visible.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));
    const nodes: FileNode[] = [];
    for (const dir of dirs) {
      const absChild = path.join(abs, dir.name);
      nodes.push({
        name: dir.name,
        path: toRelative(root, absChild),
        type: 'dir',
        children: await walk(absChild, depth + 1),
      });
    }
    for (const file of files) {
      nodes.push({
        name: file.name,
        path: toRelative(root, path.join(abs, file.name)),
        type: 'file',
      });
    }
    return nodes;
  }
  return {
    name: path.basename(path.resolve(root)) || 'workspace',
    path: '',
    type: 'dir',
    children: await walk(root, 0),
  };
}

/** Presence accepts only a real, visible file with its canonical tree path. */
export async function validateViewedFilePath(root: string, rel: unknown): Promise<boolean> {
  if (typeof rel !== 'string' || !rel || rel.length > 1024 || rel.includes('\\') || rel.includes('\0')) return false;
  try {
    const abs = toAbsolute(root, rel);
    if (toRelative(root, abs) !== rel) return false;
    await checkWorkspacePath(root, abs);
    return (await fs.lstat(abs)).isFile();
  } catch {
    return false;
  }
}

export async function readFileContent(root: string, rel: string): Promise<{ content: string; revision: string }> {
  const abs = toAbsolute(root, rel);
  await checkWorkspacePath(root, abs);
  let stat;
  try {
    stat = await fs.lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'File not found');
    throw err;
  }
  if (stat.isSymbolicLink()) throw new HttpError(400, 'Symbolic links are not supported');
  if (!stat.isFile()) throw new HttpError(400, 'Not a file');
  if (stat.size > MAX_FILE_BYTES) throw new HttpError(413, 'File is larger than 2 MB');
  const handle = await fs.open(abs, constants.O_RDONLY | NOFOLLOW);
  let buf: Buffer;
  try {
    buf = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (buf.length > MAX_FILE_BYTES) throw new HttpError(413, 'File is larger than 2 MB');
  const probe = Math.min(buf.length, 8192);
  for (let i = 0; i < probe; i++) {
    if (buf[i] === 0) throw new HttpError(415, 'Binary files are not supported yet');
  }
  return { content: buf.toString('utf8'), revision: revision(buf) };
}

export async function writeFileContent(root: string, rel: string, content: string, expectedRevision: string | null): Promise<string> {
  const abs = toAbsolute(root, rel);
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new HttpError(413, 'File is larger than 2 MB');
  return withWriteLock(abs, async () => {
    await checkWorkspacePath(root, abs);
    if (await currentRevision(abs) !== expectedRevision) throw new HttpError(409, 'File changed on disk');
    await ensureParent(root, abs);
    await checkWorkspacePath(root, abs);
    const handle = await fs.open(abs, expectedRevision === null
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW
      : constants.O_WRONLY | NOFOLLOW, 0o666).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST' || err.code === 'ENOENT') throw new HttpError(409, 'File changed on disk');
      throw err;
    });
    try {
      await handle.writeFile(content, 'utf8');
      await handle.truncate(Buffer.byteLength(content, 'utf8'));
    } finally {
      await handle.close();
    }
    return revision(Buffer.from(content, 'utf8'));
  });
}

export async function createDirectory(root: string, rel: string): Promise<void> {
  const abs = toAbsolute(root, rel);
  await withWriteLock(abs, async () => {
    await checkWorkspacePath(root, abs);
    await ensureParent(root, abs);
    try {
      await fs.mkdir(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, 'Path already exists');
      throw err;
    }
  });
}

export async function deleteEmptyDirectory(root: string, rel: string): Promise<void> {
  const abs = toAbsolute(root, rel);
  await withWriteLock(abs, async () => {
    await checkWorkspacePath(root, abs);
    try {
      const stat = await fs.lstat(abs);
      if (!stat.isDirectory()) throw new HttpError(400, 'Not a folder');
      await fs.rmdir(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') throw new HttpError(409, 'Folder is not empty');
      if (code === 'ENOENT') throw new HttpError(404, 'Folder not found');
      if (code === 'ENOTDIR') throw new HttpError(400, 'Not a folder');
      throw err;
    }
  });
}

export async function moveFile(root: string, from: string, to: string, expectedRevision: string): Promise<void> {
  const source = toAbsolute(root, from);
  const target = toAbsolute(root, to);
  if (source === target) throw new HttpError(400, 'Source and destination must differ');
  await withPathLocks([source, target], async () => {
    await checkWorkspacePath(root, source);
    await checkWorkspacePath(root, target);
    if (await currentRevision(source) !== expectedRevision) throw new HttpError(409, 'File changed on disk');
    try {
      await fs.lstat(target);
      throw new HttpError(409, 'Destination already exists');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await ensureParent(root, target);
    await checkWorkspacePath(root, target);
    // A hard link reserves the destination without ever replacing an existing file.
    await fs.link(source, target).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') throw new HttpError(409, 'Destination already exists');
      throw err;
    });
    try {
      await fs.unlink(source);
    } catch (err) {
      await fs.unlink(target).catch(() => undefined);
      throw err;
    }
  });
}

export async function deleteFile(root: string, rel: string, expectedRevision: string): Promise<void> {
  const abs = toAbsolute(root, rel);
  await withWriteLock(abs, async () => {
    await checkWorkspacePath(root, abs);
    if (await currentRevision(abs) !== expectedRevision) throw new HttpError(409, 'File changed on disk');
    await fs.unlink(abs);
  });
}
