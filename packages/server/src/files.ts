import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileNode } from '@ade/shared';
import { HttpError, IGNORED_DIRS, toAbsolute, toRelative } from './paths.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_DEPTH = 14;

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

export async function readFileContent(root: string, rel: string): Promise<string> {
  const abs = toAbsolute(root, rel);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new HttpError(400, 'Not a file');
  if (stat.size > MAX_FILE_BYTES) throw new HttpError(413, 'File is larger than 2 MB');
  const buf = await fs.readFile(abs);
  const probe = Math.min(buf.length, 8192);
  for (let i = 0; i < probe; i++) {
    if (buf[i] === 0) throw new HttpError(415, 'Binary files are not supported yet');
  }
  return buf.toString('utf8');
}

export async function writeFileContent(root: string, rel: string, content: string): Promise<void> {
  const abs = toAbsolute(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}