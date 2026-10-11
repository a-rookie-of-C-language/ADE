/** Git review boundaries and staged/working comparisons in an isolated repository. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../dist/events.js';
import { buildApp } from '../dist/http.js';
import { TaskManager } from '../dist/tasks.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-git-smoke-'));
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
const config = { workspaceRoot: root, host: '127.0.0.1', port: 0, token: 'secret', allowedOrigins: [], agents: [] };
const store = new EventStore(path.join(root, '.ade'));
const app = await buildApp({ config, store, tasks: new TaskManager(config, store) });
const auth = { authorization: 'Bearer secret', host: '127.0.0.1:8787' };
async function request(url) {
  const response = await app.inject({ method: 'GET', url, headers: auth });
  return { status: response.statusCode, data: response.json() };
}
const diff = (file, side) => request(`/api/git/diff?p=${encodeURIComponent(file)}&side=${side}`);
const index = async (file, action, expectedRevision) => {
  const response = await app.inject({ method: 'POST', url: '/api/git/index', headers: auth,
    payload: { path: file, action, expectedRevision } });
  return { status: response.statusCode, data: response.json() };
};

try {
  assert.deepEqual((await request('/api/git/changes')).data, { available: false, changes: [] });
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'tracked file.txt'), 'initial\n');
  fs.writeFileSync(path.join(root, 'old name.txt'), 'rename me\n');
  fs.writeFileSync(path.join(root, 'removed.txt'), 'remove me\n');
  git('add', '.');
  git('-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.invalid', 'commit', '-qm', 'initial');
  fs.writeFileSync(path.join(root, 'tracked file.txt'), 'staged\n');
  git('add', 'tracked file.txt');
  fs.writeFileSync(path.join(root, 'tracked file.txt'), 'working\n');
  git('mv', 'old name.txt', 'new name.txt');
  fs.unlinkSync(path.join(root, 'removed.txt'));
  fs.writeFileSync(path.join(root, 'new file.txt'), 'untracked\n');
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(root, 'late-binary.bin'), Buffer.concat([
    Buffer.alloc(9000, 65), Buffer.from([0]),
  ]));
  fs.writeFileSync(path.join(root, 'invalid-utf8.bin'), Buffer.from([0xff, 0xfe]));

  const changes = (await request('/api/git/changes')).data;
  assert.equal(changes.available, true);
  assert.equal(changes.changes.find((item) => item.path === 'tracked file.txt').indexStatus, 'M');
  assert.equal(changes.changes.find((item) => item.path === 'tracked file.txt').worktreeStatus, 'M');
  assert.equal(changes.changes.find((item) => item.path === 'new name.txt').previousPath, 'old name.txt');
  assert.equal(changes.changes.find((item) => item.path === 'new file.txt').working, true);
  const stagedBefore = (await diff('tracked file.txt', 'staged')).data;
  assert.equal(stagedBefore.original, 'initial\n');
  assert.equal(stagedBefore.modified, 'staged\n');
  assert.match(stagedBefore.revision, /^[a-f0-9]{64}$/);
  const workingBefore = (await diff('tracked file.txt', 'working')).data;
  assert.equal(workingBefore.original, 'staged\n');
  assert.equal(workingBefore.modified, 'working\n');
  assert.equal((await diff('new name.txt', 'staged')).data.original, 'rename me\n');
  assert.equal((await diff('removed.txt', 'working')).data.modified, '');
  assert.equal((await diff('new file.txt', 'working')).data.modified, 'untracked\n');
  assert.equal((await diff('binary.bin', 'working')).status, 415);
  assert.equal((await diff('late-binary.bin', 'working')).status, 415);
  assert.equal((await diff('invalid-utf8.bin', 'working')).status, 415);
  assert.equal((await index('tracked file.txt', 'stage', workingBefore.revision)).status, 200);
  assert.equal((await diff('tracked file.txt', 'working')).status, 404);
  assert.equal((await diff('tracked file.txt', 'staged')).data.modified, 'working\n');
  assert.equal(fs.readFileSync(path.join(root, 'tracked file.txt'), 'utf8'), 'working\n');
  assert.equal((await index('tracked file.txt', 'unstage', stagedBefore.revision)).status, 409);
  const stagedAfter = (await diff('tracked file.txt', 'staged')).data;
  assert.equal((await index('tracked file.txt', 'unstage', stagedAfter.revision)).status, 200);
  assert.equal((await diff('tracked file.txt', 'staged')).status, 404);
  const latest = (await diff('tracked file.txt', 'working')).data;
  fs.writeFileSync(path.join(root, 'tracked file.txt'), 'updated after review\n');
  assert.equal((await index('tracked file.txt', 'stage', latest.revision)).status, 409);
  assert.equal((await diff('tracked file.txt', 'working')).data.modified, 'updated after review\n');

  const newFile = (await diff('new file.txt', 'working')).data;
  assert.equal((await index('new file.txt', 'stage', newFile.revision)).status, 200);
  assert.equal((await index('new file.txt', 'unstage', (await diff('new file.txt', 'staged')).data.revision)).status, 200);
  assert.equal((await diff('new file.txt', 'working')).data.modified, 'untracked\n');
  assert.ok(fs.existsSync(path.join(root, 'new file.txt')));

  assert.equal((await index('removed.txt', 'stage', (await diff('removed.txt', 'working')).data.revision)).status, 200);
  assert.equal((await index('removed.txt', 'unstage', (await diff('removed.txt', 'staged')).data.revision)).status, 200);
  assert.equal((await diff('removed.txt', 'working')).data.modified, '');

  const renamed = (await diff('new name.txt', 'staged')).data;
  assert.equal((await index('new name.txt', 'unstage', renamed.revision)).status, 200);
  assert.ok(fs.existsSync(path.join(root, 'new name.txt')));
  assert.equal((await diff('new name.txt', 'staged')).status, 404);

  fs.writeFileSync(path.join(root, 'literal[1].txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'literal1.txt'), 'two\n');
  assert.equal((await index('literal[1].txt', 'stage', (await diff('literal[1].txt', 'working')).data.revision)).status, 200);
  assert.equal((await diff('literal1.txt', 'working')).data.modified, 'two\n');
  assert.equal((await diff('literal1.txt', 'staged')).status, 404);
  assert.equal((await index('binary.bin', 'stage', 'a'.repeat(64))).status, 415);
  assert.equal((await index('.ade/private.txt', 'stage', 'a'.repeat(64))).status, 400);
  assert.equal((await index('../outside.txt', 'stage', 'a'.repeat(64))).status, 400);
  assert.equal((await index('tracked file.txt', 'unknown', 'a'.repeat(64))).status, 400);
  assert.equal((await index('tracked file.txt', 'stage', 'missing')).status, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/git/index', payload: {
    path: 'tracked file.txt', action: 'stage', expectedRevision: latest.revision,
  }, headers: { host: auth.host } })).statusCode, 401);
  fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(6 * 1024 * 1024, 65));
  git('add', 'large.txt');
  assert.equal((await diff('large.txt', 'staged')).status, 413);
  assert.equal((await diff('../outside.txt', 'working')).status, 400);
  assert.equal((await diff('tracked file.txt', 'invalid')).status, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/git/changes', headers: { host: auth.host } })).statusCode, 401);
  console.log('[git-smoke] PASS: review, stage/unstage, stale review, rename, literal paths, binary, auth');
} finally {
  await app.close();
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(resolved).startsWith('ade-git-smoke-')) {
    throw new Error('Refusing to remove a directory outside the Git smoke test');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
