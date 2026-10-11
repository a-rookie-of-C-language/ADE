import fs from 'node:fs';
import path from 'node:path';
import { lock } from 'proper-lockfile';
import { loadConfig } from './config.js';
import { EventStore } from './events.js';
import { buildApp } from './http.js';
import { TaskManager } from './tasks.js';
import { ensurePushKeys } from './push.js';
import { startWatcher } from './watcher.js';

async function main(): Promise<void> {
  const config = loadConfig();

  fs.mkdirSync(config.workspaceRoot, { recursive: true });
  config.workspaceRoot = fs.realpathSync.native(config.workspaceRoot);
  const dataDir = path.join(config.workspaceRoot, '.ade');
  fs.mkdirSync(dataDir, { recursive: true });

  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await lock(config.workspaceRoot, {
      lockfilePath: path.join(dataDir, 'server.lock'),
      onCompromised: (error) => {
        console.error('[ade] workspace lock compromised:', error);
        process.exit(1);
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new Error(`Workspace already has an ADE server: ${config.workspaceRoot}`, { cause: error });
    }
    throw error;
  }

  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let tasks: TaskManager | undefined;
  let stopWatcher: (() => void) | undefined;
  try {
    config.push ??= ensurePushKeys(config.workspaceRoot);
    const store = new EventStore(dataDir);
    store.recoverInterruptedTasks();
    tasks = new TaskManager(config, store);
    app = await buildApp({ config, tasks, store });

    await app.listen({ port: config.port, host: config.host });

    const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    console.log('[ade] workspace :', config.workspaceRoot);
    console.log('[ade] server    :', `http://${shownHost}:${config.port}`);
    console.log('[ade] agents    :', config.agents.map((a) => a.id).join(', '));
    if (!config.token) {
      console.log('[ade] auth      : none (set ADE_TOKEN or "token" in ade.config.json)');
    }

    stopWatcher = startWatcher(config.workspaceRoot, (event) => {
      app?.broadcast({ kind: 'file', event });
    });

    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    stopWatcher?.();
    try {
      try {
        await tasks?.abortAll();
      } finally {
        await app?.close();
      }
    } finally {
      await releaseLock();
    }
  }
}

main().catch((error) => {
  console.error('[ade] fatal:', error);
  process.exit(1);
});
