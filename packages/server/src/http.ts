import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { AdeConfig } from './config.js';
import type { EventStore } from './events.js';
import { buildTree, createDirectory, deleteEmptyDirectory, deleteFile, moveFile, readFileContent, writeFileContent } from './files.js';
import { getGitChanges, getGitDiff, updateGitIndex } from './git.js';
import { HttpError, toAbsolute, toRelative } from './paths.js';
import { acceptsBrowserOrigin } from './origin.js';
import type { TaskManager } from './tasks.js';
import { registerWs } from './ws.js';
import { PushService } from './push.js';
import { listAgents } from './agents.js';
import type { sendNotification } from 'web-push';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface HttpDeps {
  config: AdeConfig;
  tasks: TaskManager;
  store: EventStore;
  pushSend?: typeof sendNotification;
}

export async function buildApp(deps: HttpDeps) {
  const { config, tasks, store } = deps;
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  app.addHook('onRequest', async (request, reply) => {
    if (!acceptsBrowserOrigin(request, config)) {
      return reply.code(403).send({ error: 'untrusted origin or host' });
    }
  });

  if (config.token) {
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api')) return;
      const ok = request.headers.authorization === `Bearer ${config.token}`;
      if (!ok) return reply.code(401).send({ error: 'unauthorized' });
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: error.message });
    }
    const err = error as Error & { statusCode?: number };
    const status = err.statusCode ?? 500;
    if (status >= 500) console.error('[ade] internal error:', error);
    return reply.code(status).send({ error: err.message });
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/api/config', async () => ({ workspaceRoot: config.workspaceRoot, version: '0.1.0' }));
  app.get('/api/agents', async () => listAgents(config));

  const push = config.push ? new PushService(config.push, config.workspaceRoot, deps.pushSend) : null;
  app.get('/api/push/config', async () => ({ publicKey: push?.publicKey ?? null }));
  app.post('/api/push/subscriptions', async (request) => {
    if (!push) throw new HttpError(503, 'Push is not configured');
    push.subscribe(request.body);
    return { ok: true };
  });
  app.delete('/api/push/subscriptions', async (request) => {
    if (!push) throw new HttpError(503, 'Push is not configured');
    push.unsubscribe((request.body as { endpoint?: unknown } | undefined)?.endpoint);
    return { ok: true };
  });
  if (push) {
    const unsubscribe = tasks.subscribe((event) => { void push.notify(event, store); });
    app.addHook('onClose', async () => { unsubscribe(); });
  }

  app.get('/api/files/tree', async () => ({
    root: path.basename(config.workspaceRoot) || 'workspace',
    tree: await buildTree(config.workspaceRoot),
  }));

  app.get('/api/files/content', async (request) => {
    const { p } = request.query as { p?: string };
    if (!p) throw new HttpError(400, 'Missing query parameter: p');
    return { path: p, ...await readFileContent(config.workspaceRoot, p) };
  });

  app.put('/api/files/content', async (request) => {
    const body = request.body as { path?: string; content?: string; expectedRevision?: string | null } | undefined;
    if (!body?.path || typeof body.content !== 'string') {
      throw new HttpError(400, 'Body must include path and content');
    }
    if (!Object.hasOwn(body, 'expectedRevision')) throw new HttpError(428, 'expectedRevision is required');
    if (body.expectedRevision !== null &&
        (typeof body.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/i.test(body.expectedRevision))) {
      throw new HttpError(400, 'Invalid expectedRevision');
    }
    const revision = await writeFileContent(config.workspaceRoot, body.path, body.content, body.expectedRevision);
    return { ok: true, revision };
  });

  const requireRevision = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
      throw new HttpError(428, 'A valid expectedRevision is required');
    }
    return value;
  };

  app.post('/api/files/directory', async (request) => {
    const body = request.body as { path?: unknown } | undefined;
    if (typeof body?.path !== 'string' || !body.path) throw new HttpError(400, 'Path is required');
    await createDirectory(config.workspaceRoot, body.path);
    app.broadcast({ kind: 'tree.changed', path: toRelative(config.workspaceRoot, toAbsolute(config.workspaceRoot, body.path)), action: 'add' });
    return { ok: true };
  });

  app.delete('/api/files/directory', async (request) => {
    const body = request.body as { path?: unknown } | undefined;
    if (typeof body?.path !== 'string' || !body.path) throw new HttpError(400, 'Path is required');
    await deleteEmptyDirectory(config.workspaceRoot, body.path);
    app.broadcast({ kind: 'tree.changed', path: toRelative(config.workspaceRoot, toAbsolute(config.workspaceRoot, body.path)), action: 'unlink' });
    return { ok: true };
  });

  app.post('/api/files/move', async (request) => {
    const body = request.body as { from?: unknown; to?: unknown; expectedRevision?: unknown } | undefined;
    if (typeof body?.from !== 'string' || !body.from || typeof body.to !== 'string' || !body.to) {
      throw new HttpError(400, 'Source and destination paths are required');
    }
    const expectedRevision = requireRevision(body.expectedRevision);
    await moveFile(config.workspaceRoot, body.from, body.to, expectedRevision);
    app.broadcast({ kind: 'file.moved',
      from: toRelative(config.workspaceRoot, toAbsolute(config.workspaceRoot, body.from)),
      to: toRelative(config.workspaceRoot, toAbsolute(config.workspaceRoot, body.to)),
      revision: expectedRevision });
    return { ok: true };
  });

  app.delete('/api/files/content', async (request) => {
    const body = request.body as { path?: unknown; expectedRevision?: unknown } | undefined;
    if (typeof body?.path !== 'string' || !body.path) throw new HttpError(400, 'Path is required');
    await deleteFile(config.workspaceRoot, body.path, requireRevision(body.expectedRevision));
    return { ok: true };
  });

  app.get('/api/git/changes', async () => getGitChanges(config.workspaceRoot));
  app.get('/api/git/diff', async (request) => {
    const { p, side } = request.query as { p?: unknown; side?: unknown };
    if (typeof p !== 'string' || (side !== 'staged' && side !== 'working')) {
      throw new HttpError(400, 'Diff requires a path and staged or working side');
    }
    return getGitDiff(config.workspaceRoot, p, side);
  });
  app.post('/api/git/index', async (request) => {
    const { path: file, action, expectedRevision } = (request.body ?? {}) as {
      path?: string; action?: 'stage' | 'unstage'; expectedRevision?: string;
    };
    await updateGitIndex(config.workspaceRoot, file!, action!, expectedRevision!);
    return { ok: true };
  });

  app.get('/api/tasks', async () => ({ tasks: tasks.list() }));
  app.post('/api/tasks', async (request, reply) => {
    const body = request.body as { agentId?: string; prompt?: string; cwd?: string; sourceTaskId?: string; nextSteps?: unknown } | undefined;
    const meta = tasks.create(String(body?.agentId ?? ''), String(body?.prompt ?? ''), body?.cwd ?? '.', body?.sourceTaskId, body?.nextSteps);
    reply.code(201);
    return { task: meta };
  });

  app.post('/api/tasks/:id/abort', async (request) => {
    const { id } = request.params as { id: string };
    tasks.abort(id);
    return { ok: true };
  });

  app.post('/api/tasks/:id/approval', async (request) => {
    const { id } = request.params as { id: string };
    const { decision } = (request.body ?? {}) as { decision?: unknown };
    if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'Invalid approval decision');
    const next = tasks.resolveApproval(id, decision);
    return { ok: true, nextTaskId: next?.id ?? null };
  });

  app.post('/api/tasks/:id/resume', async (request) => {
    const { id } = request.params as { id: string };
    const next = tasks.resumeChain(id);
    return { ok: true, nextTaskId: next.id };
  });

  app.get('/api/tasks/:id/events', async (request) => {
    const { id } = request.params as { id: string };
    return { events: store.readEvents(id, 2000) };
  });

  app.get('/api/tasks/:id/log', async (request, reply) => {
    const { id } = request.params as { id: string };
    const stream = store.streamEvents(id);
    return reply.header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="ade-task-${id}.jsonl"`)
      .type('application/x-ndjson; charset=utf-8').send(stream);
  });

  await app.register(fastifyWebsocket);
  registerWs(app, { config, tasks, store });

  // Serve the built web UI when available (production / single-port mode).
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith('/api')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
