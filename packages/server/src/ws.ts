import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@ade/shared';
import type { AdeConfig } from './config.js';
import type { EventStore } from './events.js';
import type { TaskManager } from './tasks.js';
import { validateViewedFilePath } from './files.js';
import { listAgents } from './agents.js';

declare module 'fastify' {
  interface FastifyInstance {
    broadcast(message: ServerMessage): void;
  }
}

export interface WsDeps {
  config: AdeConfig;
  tasks: TaskManager;
  store: EventStore;
}

export function registerWs(app: FastifyInstance, deps: WsDeps): void {
  const { config, tasks, store } = deps;
  const sockets = new Map<WebSocket, string | null>();

  const countsFor = (socket: WebSocket): { path: string; count: number }[] => {
    const counts = new Map<string, number>();
    for (const [other, path] of sockets) {
      if (other !== socket && path) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    return [...counts].map(([path, count]) => ({ path, count }));
  };

  const notifyPresence = (...paths: (string | null)[]): void => {
    const totals = new Map<string, number>();
    for (const viewed of sockets.values()) {
      if (viewed) totals.set(viewed, (totals.get(viewed) ?? 0) + 1);
    }
    for (const path of new Set(paths.filter((value): value is string => value !== null))) {
      for (const [socket, viewed] of sockets) {
        if (socket.readyState !== socket.OPEN) continue;
        const count = (totals.get(path) ?? 0) - Number(viewed === path);
        socket.send(JSON.stringify({ kind: 'presence', path, count } satisfies ServerMessage));
      }
    }
  };

  app.decorate('broadcast', (message: ServerMessage) => {
    const raw = JSON.stringify(message);
    for (const socket of sockets.keys()) {
      if (socket.readyState === socket.OPEN) socket.send(raw);
    }
  });

  app.get('/ws', { websocket: true }, (socket, request) => {
    const query = request.query as Record<string, string | undefined>;
    if (config.token && query.token !== config.token) {
      socket.close(4001, 'unauthorized');
      return;
    }

    sockets.set(socket, null);
    let presenceVersion = 0;
    const init: ServerMessage = {
      kind: 'init',
      payload: {
        agents: listAgents(config),
        tasks: store.snapshotTasks(),
        workspaceRoot: config.workspaceRoot,
        serverTime: Date.now(),
        viewers: countsFor(socket),
      },
    };
    socket.send(JSON.stringify(init));

    socket.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      try {
        switch (message.kind) {
          case 'ping':
            socket.send(JSON.stringify({ kind: 'pong', ts: Date.now() } satisfies ServerMessage));
            break;
          case 'task.input':
            tasks.writeInput(message.taskId, message.data);
            break;
          case 'task.resize':
            tasks.resize(message.taskId, message.cols, message.rows);
            break;
          case 'task.abort':
            tasks.abort(message.taskId);
            break;
          case 'presence.set': {
            const version = ++presenceVersion;
            const path = message.path;
            if (path !== null && !(typeof path === 'string' && path.length <= 1024)) break;
            void (path === null ? Promise.resolve(true) : validateViewedFilePath(config.workspaceRoot, path))
              .then((valid) => {
                if (!valid || version !== presenceVersion || !sockets.has(socket)) return;
                const previous = sockets.get(socket) ?? null;
                if (previous === path) return;
                sockets.set(socket, path);
                notifyPresence(previous, path);
              });
            break;
          }
        }
      } catch {
        // task no longer running etc. — ignore for now, errors surface via events
      }
    });

    const cleanup = () => {
      presenceVersion++;
      if (!sockets.has(socket)) return;
      const path = sockets.get(socket) ?? null;
      sockets.delete(socket);
      notifyPresence(path);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // Forward task events from the manager to every connected device.
  tasks.subscribe((event) => {
    app.broadcast({ kind: 'task', event });
  });
}
