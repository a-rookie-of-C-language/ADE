import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { AdeConfig } from './config.js';
import type { EventStore } from './events.js';
import { buildTree, readFileContent, writeFileContent } from './files.js';
import { HttpError } from './paths.js';
import type { TaskManager } from './tasks.js';
import { registerWs } from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface HttpDeps {
  config: AdeConfig;
  tasks: TaskManager;
  store: EventStore;
}

export async function buildApp(deps: HttpDeps) {
  const { config, tasks, store } = deps;
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  await app.register(fastifyCors, { origin: true });

  if (config.token) {
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api')) return;
      const query = request.query as Record<string, string | undefined>;
      const ok =
        request.headers.authorization === `Bearer ${config.token}` || query?.token === config.token;
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
  app.get('/api/agents', async () => config.agents);

  app.get('/api/files/tree', async () => ({
    root: path.basename(config.workspaceRoot) || 'workspace',
    tree: await buildTree(config.workspaceRoot),
  }));

  app.get('/api/files/content', async (request) => {
    const { p } = request.query as { p?: string };
    if (!p) throw new HttpError(400, 'Missing query parameter: p');
    return { path: p, content: await readFileContent(config.workspaceRoot, p) };
  });

  app.put('/api/files/content', async (request) => {
    const body = request.body as { path?: string; content?: string } | undefined;
    if (!body?.path || typeof body.content !== 'string') {
      throw new HttpError(400, 'Body must be { path, content }');
    }
    await writeFileContent(config.workspaceRoot, body.path, body.content);
    return { ok: true };
  });

  app.get('/api/tasks', async () => ({ tasks: tasks.list() }));
  app.post('/api/tasks', async (request, reply) => {
    const body = request.body as { agentId?: string; prompt?: string; cwd?: string } | undefined;
    const meta = tasks.create(String(body?.agentId ?? ''), String(body?.prompt ?? ''), body?.cwd ?? '.');
    reply.code(201);
    return { task: meta };
  });

  app.post('/api/tasks/:id/abort', async (request) => {
    const { id } = request.params as { id: string };
    tasks.abort(id);
    return { ok: true };
  });

  app.get('/api/tasks/:id/events', async (request) => {
    const { id } = request.params as { id: string };
    return { events: store.readEvents(id) };
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