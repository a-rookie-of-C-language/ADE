import type { ClientMessage, ServerMessage } from '@ade/shared';

export type WsStatus = 'connecting' | 'open' | 'closed';
export interface WsConnection {
  close(): void;
  send(message: ClientMessage): boolean;
}

export function connectWs(
  onMessage: (message: ServerMessage) => void,
  onStatus: (status: WsStatus) => void,
): WsConnection {
  let socket: WebSocket | null = null;
  let closedByUser = false;
  let retries = 0;
  let timer: number | undefined;

  const url = (): string => {
    const dev = import.meta.env.DEV;
    const proto = dev ? 'ws' : location.protocol === 'https:' ? 'wss' : 'ws';
    const host = dev ? `${location.hostname}:8787` : location.host;
    const token = localStorage.getItem('ade-token');
    return `${proto}://${host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  };

  const open = (): void => {
    onStatus('connecting');
    socket = new WebSocket(url());
    socket.onopen = () => {
      retries = 0;
      onStatus('open');
    };
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data as string) as ServerMessage);
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      onStatus('closed');
      if (!closedByUser) {
        timer = window.setTimeout(open, Math.min(1000 * 2 ** retries++, 8000));
      }
    };
    socket.onerror = () => socket?.close();
  };

  open();

  return {
    close() {
      closedByUser = true;
      if (timer !== undefined) clearTimeout(timer);
      socket?.close();
    },
    send(message) {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
  };
}
