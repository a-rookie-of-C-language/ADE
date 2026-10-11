import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { api } from '../lib/api';

type PushState = 'off' | 'on' | 'busy' | 'blocked' | 'unsupported';

function applicationKey(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export default function PushToggle({ onError }: { onError: (message: string) => void }) {
  const [key, setKey] = useState<string | null>(null);
  const [state, setState] = useState<PushState>('off');

  useEffect(() => {
    let active = true;
    void api.pushConfig().then(async ({ publicKey }) => {
      if (!active || !publicKey) return;
      setKey(publicKey);
      if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) ||
          !('Notification' in window)) { setState('unsupported'); return; }
      if (Notification.permission === 'denied') { setState('blocked'); return; }
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (active && subscription && keyFingerprint(subscription.options.applicationServerKey) ===
          keyFingerprint(applicationKey(publicKey))) setState('on');
    }).catch(() => { if (active) onError('Could not check push notification settings'); });
    return () => { active = false; };
  }, [onError]);

  if (!key) return null;
  const title = state === 'on' ? 'Disable task notifications' : state === 'blocked'
    ? 'Notifications are blocked in browser settings' : state === 'unsupported'
    ? 'Notifications require a secure connection and browser support' : 'Enable task notifications';

  const toggle = async () => {
    if (state !== 'on' && state !== 'off') return;
    const wasOn = state === 'on';
    // Permission must be requested directly from the user gesture.
    const permission = wasOn ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') { setState(permission === 'denied' ? 'blocked' : 'off'); return; }
    setState('busy');
    try {
      await navigator.serviceWorker.register('/push-sw.js');
      const registration = await navigator.serviceWorker.ready;
      let current = await registration.pushManager.getSubscription();
      if (wasOn) {
        if (current) {
          await api.unsubscribePush(current.endpoint);
          await current.unsubscribe();
        }
        setState('off');
      } else {
        if (current && keyFingerprint(current.options.applicationServerKey) !== keyFingerprint(applicationKey(key))) {
          await api.unsubscribePush(current.endpoint);
          await current.unsubscribe();
          current = null;
        }
        const subscription = current ?? await registration.pushManager.subscribe({
          userVisibleOnly: true, applicationServerKey: applicationKey(key),
        });
        try {
          await api.subscribePush(subscription.toJSON());
        } catch (error) {
          if (!current) await subscription.unsubscribe();
          throw error;
        }
        setState('on');
      }
    } catch (error) {
      setState(wasOn ? 'on' : 'off');
      console.error('[ade] push subscription error:', error);
      onError('Could not update task notifications');
    }
  };

  return <button type="button" className={`push-toggle${state === 'on' ? ' enabled' : ''}`}
    title={title} aria-label={title} aria-pressed={state === 'on'}
    disabled={state === 'busy' || state === 'blocked' || state === 'unsupported'}
    onClick={() => void toggle()}>
    {state === 'on' ? <Bell size={17} /> : <BellOff size={17} />}
  </button>;
}

function keyFingerprint(value: ArrayBuffer | ArrayBufferView | null): string {
  if (!value) return '';
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) :
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Array.from(bytes).join(',');
}
