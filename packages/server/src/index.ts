import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { EventStore } from './events.js';
import { buildApp } from './http.js';
import { TaskManager } from './tasks.js';
import { startWatcher } from './watcher.js';

async function main(): Promise<void> {
  const config = loadConfig();

  fs.mkdirSync(config.workspaceRoot, { recursive: true });
  const store = new EventStore(path.join(config.workspaceRoot, '.ade'));
  const tasks = new TaskManager(config, store);
  const app = await buildApp({ config, tasks, store });

  await app.listen({ port: config.port, host: config.host });

  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  console.log('[ade] workspace :', config.workspaceRoot);
  console.log('[ade] server    :', `http://${shownHost}:${config.port}`);
  console.log('[ade] agents    :', config.agents.map((a) => a.id).join(', '));
  if (!config.token) {
    console.log('[ade] auth      : none (set ADE_TOKEN or "token" in ade.config.json)');
  }

  const stopWatcher = startWatcher(config.workspaceRoot, (event) => {
    app.broadcast({ kind: 'file', event });
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    stopWatcher();
    tasks.abortAll();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('[ade] fatal:', error);
  process.exit(1);
});