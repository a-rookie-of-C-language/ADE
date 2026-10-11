import type { FastifyRequest } from 'fastify';
import type { AdeConfig } from './config.js';
import { isLoopbackHost } from './config.js';

/** Browser connections must come from this ADE host or an explicitly trusted frontend. */
export function acceptsBrowserOrigin(request: FastifyRequest, config: AdeConfig): boolean {
  const host = request.headers.host;
  if (!host) return false;
  let hostname: string;
  try {
    const authority = new URL(`http://${host}`);
    if (authority.host !== host || authority.username || authority.password || authority.pathname !== '/') return false;
    hostname = authority.hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  // Without a token, reject DNS rebinding to a loopback listener.
  if (!config.token && !isLoopbackHost(hostname)) return false;

  const origin = request.headers.origin;
  if (origin === undefined) return true; // CLI clients do not send Origin.
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return false;
  if (config.allowedOrigins.includes(origin)) return true;
  if (url.host === host && (config.token || isLoopbackHost(hostname))) return true;

  // The local Vite server proxies /api and /ws to the ADE server in dev mode.
  return isLoopbackHost(hostname) && isLoopbackHost(url.hostname.replace(/^\[|\]$/g, '')) &&
    url.protocol === 'http:' && url.port === '5173';
}
