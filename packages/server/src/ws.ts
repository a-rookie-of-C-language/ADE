import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@ade/shared';
import type { AdeConfig } from './config.js';
import type { EventStore } from './events.js';
import type { TaskManager } from './tasks.js';

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
  const sockets = new Set<WebSocket>();

  app.decorate('broadcast', (message: ServerMessage) => {
    const raw = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(raw);
    }
  });

  app.get('/ws', { websocket: true }, (socket, request) => {
    const query = request.query as Record<string, string | undefined>;
    if (config.token && query.token !== config.token) {
      socket.close(4001, 'unauthorized');
      return;
    }

    sockets.add(socket);
    const init: ServerMessage = {
      kind: 'init',
      payload: {
        agents: config.agents,
        tasks: store.snapshotTasks(),
        workspaceRoot: config.workspaceRoot,
        serverTime: Date.now(),
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
      try {
        switch (message.kind) {
          case 'ping':
            socket.send(JSON.stringify({ kind: 'pong', ts: Date.now() } satisfies ServerMessage));
            break;
          case 'task.input':
            tasks.writeInput(message.taskId, message.data);
            break;
          case 'task.abort':
            tasks.abort(message.taskId);
            break;
        }
      } catch {
        // task no longer running etc. — ignore for now, errors surface via events
      }
    });

    const cleanup = () => sockets.delete(socket);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // Forward task events from the manager to every connected device.
  tasks.subscribe((event) => {
    app.broadcast({ kind: 'task', event });
  });
}