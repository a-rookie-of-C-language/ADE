import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import type { PushSubscription } from 'web-push';
import type { TaskEvent } from '@ade/shared';
import type { AdeConfig } from './config.js';
import type { EventStore } from './events.js';
import { HttpError } from './paths.js';

const MAX_SUBSCRIPTIONS = 32;

export function ensurePushKeys(workspace: string): NonNullable<AdeConfig['push']> {
  const file = path.join(workspace, '.ade', 'push-vapid.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    const keys = webpush.generateVAPIDKeys();
    try {
      fs.writeFileSync(file, JSON.stringify(keys), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const keys = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (typeof keys.publicKey !== 'string' || typeof keys.privateKey !== 'string') {
    throw new Error('Invalid .ade/push-vapid.json; restore the original VAPID keypair');
  }
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:ade@localhost' };
}

function validSubscription(value: unknown): value is PushSubscription {
  if (!value || typeof value !== 'object') return false;
  const { endpoint, keys } = value as Record<string, unknown>;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !keys || typeof keys !== 'object') return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return false;
    const host = url.hostname.toLowerCase();
    if (host !== 'fcm.googleapis.com' &&
        !['push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'].some((domain) =>
          host.endsWith(`.${domain}`))) return false;
  } catch { return false; }
  const { p256dh, auth } = keys as Record<string, unknown>;
  return typeof p256dh === 'string' && /^[\w-]{80,110}$/.test(p256dh) &&
    typeof auth === 'string' && /^[\w-]{16,40}$/.test(auth);
}

export class PushService {
  private readonly file: string;
  private subscriptions: PushSubscription[];

  constructor(private readonly config: NonNullable<AdeConfig['push']>, workspace: string,
    private readonly send: typeof webpush.sendNotification = webpush.sendNotification) {
    this.file = path.join(workspace, '.ade', 'push-subscriptions.json');
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown : [];
    if (!Array.isArray(saved)) throw new Error('Invalid push subscriptions file');
    this.subscriptions = saved.filter(validSubscription).slice(0, MAX_SUBSCRIPTIONS);
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  }

  get publicKey(): string { return this.config.publicKey; }

  subscribe(value: unknown): void {
    if (!validSubscription(value)) throw new HttpError(400, 'Invalid push subscription');
    const subscription: PushSubscription = { endpoint: value.endpoint,
      keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
    if (!this.subscriptions.some((item) => item.endpoint === value.endpoint) &&
        this.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new HttpError(429, 'Too many push subscriptions');
    this.subscriptions = [...this.subscriptions.filter((item) => item.endpoint !== value.endpoint), subscription];
    this.persist();
  }

  unsubscribe(endpoint: unknown): void {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) throw new HttpError(400, 'Invalid push endpoint');
    this.subscriptions = this.subscriptions.filter((item) => item.endpoint !== endpoint);
    this.persist();
  }

  async notify(event: TaskEvent, store: EventStore): Promise<void> {
    if (event.type !== 'task.completed' && event.type !== 'task.failed' &&
        event.type !== 'task.approval.requested') return;
    const meta = store.getMeta(event.taskId);
    if (event.type === 'task.completed' && meta.approval === 'pending') return;
    const payload = JSON.stringify(event.type === 'task.approval.requested'
      ? { taskId: event.taskId, agentId: meta.agentId, kind: 'approval' }
      : { taskId: event.taskId, agentId: meta.agentId, kind: 'result',
        failed: event.type === 'task.failed' || event.exitCode !== 0 });
    await Promise.all(this.subscriptions.map(async (subscription) => {
      try {
        await this.send(subscription, payload, { TTL: 3600, timeout: 10000, vapidDetails: this.config });
      } catch (error) {
        const code = (error as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          if (this.subscriptions.includes(subscription)) {
            this.subscriptions = this.subscriptions.filter((item) => item !== subscription);
            this.persist();
          }
        } else {
          console.error('[ade] push delivery failed:', code ?? String(error));
        }
      }
    }));
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.subscriptions), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
