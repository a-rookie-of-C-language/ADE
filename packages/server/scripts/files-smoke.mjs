/** Verify revision-checked file edits against a running ADE server. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const base = process.argv[2] ?? process.env.ADE_URL ?? 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json',
  ...(process.env.ADE_TOKEN ? { authorization: `Bearer ${process.env.ADE_TOKEN}` } : {}) };

async function call(method, url, body) {
  const response = await fetch(new URL(url, base), { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

const config = await call('GET', '/api/config');
if (config.status !== 200) throw new Error('Cannot read workspace configuration');
const rel = `ade-file-smoke-${crypto.randomUUID()}.txt`;
const abs = path.join(config.data.workspaceRoot, rel);
const put = (content, expectedRevision) => call('PUT', '/api/files/content',
  { path: rel, content, expectedRevision });
const read = () => call('GET', `/api/files/content?p=${encodeURIComponent(rel)}`);

try {
  const created = await put('original', null);
  if (created.status !== 200) throw new Error(`Create failed: ${JSON.stringify(created)}`);
  if ((await put('unexpected', null)).status !== 409) throw new Error('Create replaced an existing file');
  const first = await read();
  if (first.data.revision !== created.data.revision || first.data.content !== 'original') {
    throw new Error('Read revision does not match created file');
  }
  const writes = await Promise.all([put('device A', first.data.revision), put('device B', first.data.revision)]);
  if (writes.filter((result) => result.status === 200).length !== 1 ||
      writes.filter((result) => result.status === 409).length !== 1) {
    throw new Error(`Concurrent writes not serialized: ${JSON.stringify(writes)}`);
  }
  const latest = await read();
  if (!['device A', 'device B'].includes(latest.data.content) ||
      latest.data.revision !== writes.find((result) => result.status === 200).data.revision) {
    throw new Error('Winning write was lost');
  }
  if ((await put('stale', first.data.revision)).status !== 409) throw new Error('Stale write succeeded');
  if ((await call('PUT', '/api/files/content', { path: rel, content: 'unconditional' })).status !== 428) {
    throw new Error('Unconditional write succeeded');
  }
  if ((await put('confirmed overwrite', latest.data.revision)).status !== 200 ||
      (await read()).data.content !== 'confirmed overwrite') {
    throw new Error('Fresh revision did not permit explicit overwrite');
  }
  console.log('[files-smoke] PASS: create, parallel CAS, stale rejection, explicit overwrite');
} finally {
  await fs.unlink(abs).catch((err) => { if (err.code !== 'ENOENT') throw err; });
}
