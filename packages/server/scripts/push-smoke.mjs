/** Test subscription security, persistence and delivery without contacting a push gateway. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import webpush from 'web-push';
import { EventStore } from '../dist/events.js';
import { PushService, ensurePushKeys } from '../dist/push.js';
import { buildApp } from '../dist/http.js';
import { TaskManager } from '../dist/tasks.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-push-smoke-'));
const keys = webpush.generateVAPIDKeys();
const push = { ...keys, subject: 'mailto:ade@example.com' };
const config = { workspaceRoot: root, host: '127.0.0.1', port: 0, allowedOrigins: [],
  token: 'local-test-token', agents: [{ id: 'demo', command: ['node', '-e', 'process.exit(0)'] }], push };
const store = new EventStore(path.join(root, '.ade'));
const sent = [];
const service = new PushService(push, root, async (subscription, payload) => {
  sent.push({ endpoint: subscription.endpoint, data: JSON.parse(payload) });
  if (subscription.endpoint.endsWith('/expired')) throw { statusCode: 410 };
  return { statusCode: 201, body: '', headers: {} };
});
const subscription = (suffix, host = 'fcm.googleapis.com') => ({
  endpoint: `https://${host}/fcm/send/${suffix}`,
  keys: { p256dh: Buffer.alloc(65, 2).toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') },
});
let app;
try {
  const generated = ensurePushKeys(root);
  assert.equal(ensurePushKeys(root).publicKey, generated.publicKey);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.ade', 'push-vapid.json'))).privateKey, generated.privateKey);
  for (const host of ['localhost', '127.0.0.1', 'fcm.googleapis.com.evil.test', '192.168.1.2']) {
    assert.throws(() => service.subscribe(subscription('bad', host)), /Invalid push subscription/);
  }
  service.subscribe({ ...subscription('one'), extra: 'must not persist' });
  assert(!fs.readFileSync(path.join(root, '.ade', 'push-subscriptions.json'), 'utf8').includes('must not persist'));
  service.subscribe(subscription('one'));
  service.subscribe(subscription('expired'));
  const reloaded = new PushService(push, root, async () => { throw new Error('unexpected'); });
  assert.equal(reloaded.publicKey, keys.publicKey);
  const id = '123e4567-e89b-42d3-a456-426614174000';
  store.writeMeta({ id, agentId: 'demo', prompt: 'secret task prompt', cwd: '.', status: 'failed', createdAt: 100 });
  await service.notify({ type: 'task.completed', taskId: id, exitCode: 1, ts: 200 }, store);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].data, { taskId: id, agentId: 'demo', kind: 'result', failed: true });
  assert(!JSON.stringify(sent).includes('secret task prompt'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.ade', 'push-subscriptions.json'))).length, 1);
  store.writeMeta({ id, agentId: 'demo', prompt: 'private approval prompt', cwd: '.', status: 'completed',
    approval: 'pending', createdAt: 100, nextSteps: [{ agentId: 'demo', prompt: 'private follow-up' }] });
  await service.notify({ type: 'task.completed', taskId: id, exitCode: 0, ts: 201 }, store);
  assert.equal(sent.length, 2, 'completion before approval must not trigger a second notification');
  await service.notify({ type: 'task.approval.requested', taskId: id, ts: 202 }, store);
  assert.deepEqual(sent[2].data, { taskId: id, agentId: 'demo', kind: 'approval' });
  assert(!JSON.stringify(sent).includes('private approval prompt'));
  assert(!JSON.stringify(sent).includes('private follow-up'));
  service.unsubscribe(subscription('one').endpoint);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.ade', 'push-subscriptions.json'))), []);

  const handlers = new Map();
  const notifications = [];
  vm.runInNewContext(fs.readFileSync(new URL('../../web/public/push-sw.js', import.meta.url), 'utf8'), {
    self: { addEventListener: (name, handler) => handlers.set(name, handler),
      registration: { showNotification: async (title, options) => notifications.push({ title, options }) } },
  });
  for (const data of [sent[0].data, sent[2].data]) {
    let pending;
    handlers.get('push')({ data: { json: () => data }, waitUntil: (promise) => { pending = promise; } });
    await pending;
  }
  assert.equal(notifications[0].title, 'ADE: Task failed');
  assert.equal(notifications[1].title, 'ADE: Approval needed');
  assert.equal(notifications[1].options.data.taskId, id);
  assert(!JSON.stringify(notifications).includes('private follow-up'));

  const delivered = [];
  app = await buildApp({ config, tasks: new TaskManager(config, store), store,
    pushSend: async (_subscription, payload) => {
      delivered.push(JSON.parse(payload));
      return { statusCode: 201, body: '', headers: {} };
    } });
  const unauthorized = await app.inject({ url: '/api/push/config', headers: { host: '127.0.0.1:8787' } });
  assert.equal(unauthorized.statusCode, 401);
  const headers = { host: '127.0.0.1:8787', authorization: `Bearer ${config.token}` };
  assert.equal((await app.inject({ url: '/api/push/config', headers })).json().publicKey, keys.publicKey);
  const rejected = await app.inject({ method: 'POST', url: '/api/push/subscriptions', headers,
    payload: subscription('bad', '127.0.0.1') });
  assert.equal(rejected.statusCode, 400);
  const registered = await app.inject({ method: 'POST', url: '/api/push/subscriptions', headers,
    payload: subscription('from-api') });
  assert.equal(registered.statusCode, 200);
  const run = await app.inject({ method: 'POST', url: '/api/tasks', headers,
    payload: { agentId: 'demo', prompt: 'do not send my prompt' } });
  assert.equal(run.statusCode, 201);
  for (let i = 0; i < 70 && delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(delivered, [{ taskId: run.json().task.id, agentId: 'demo', kind: 'result', failed: false }]);
  const gated = await app.inject({ method: 'POST', url: '/api/tasks', headers,
    payload: { agentId: 'demo', prompt: 'sensitive original',
      nextSteps: [{ agentId: 'demo', prompt: 'sensitive next step', requiresApproval: true }] } });
  assert.equal(gated.statusCode, 201);
  for (let i = 0; i < 70 && delivered.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(delivered[1], { taskId: gated.json().task.id, agentId: 'demo', kind: 'approval' });
  assert.equal(delivered.length, 2, 'a pending chain should send only the approval notification');
  assert(!JSON.stringify(delivered).includes('sensitive'));
  const approval = await app.inject({ method: 'POST', url: `/api/tasks/${gated.json().task.id}/approval`, headers,
    payload: { decision: 'reject' } });
  assert.equal(approval.statusCode, 200);
  const deleted = await app.inject({ method: 'DELETE', url: '/api/push/subscriptions', headers,
    payload: { endpoint: subscription('from-api').endpoint } });
  assert.equal(deleted.statusCode, 200);
  console.log('[push] PASS: auth, safe result/approval payloads, single notification, stale-device removal');
} finally {
  if (app) await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
