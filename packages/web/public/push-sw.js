self.addEventListener('push', (event) => {
  let data;
  try { data = event.data?.json(); } catch { return; }
  if (!data || typeof data.taskId !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.taskId)) return;
  const agent = typeof data.agentId === 'string' ? data.agentId.slice(0, 48) : 'Agent';
  const approval = data.kind === 'approval';
  event.waitUntil(self.registration.showNotification(approval ? 'ADE: Approval needed' :
    data.failed ? 'ADE: Task failed' : 'ADE: Task complete', {
    body: approval ? `${agent} chain is waiting for review` : `${agent} task ${data.failed ? 'failed' : 'completed'}`,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: `ade-${data.taskId}`,
    data: { taskId: data.taskId },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const taskId = event.notification.data?.taskId;
  if (typeof taskId !== 'string' || !/^[a-f0-9-]{36}$/i.test(taskId)) return;
  const url = new URL('/', self.location.origin);
  url.searchParams.set('task', taskId);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ kind: 'task.open', taskId });
    } else {
      await self.clients.openWindow(url.href);
    }
  })());
});
