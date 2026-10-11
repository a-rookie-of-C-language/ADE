import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { AgentDefinition } from '@ade/shared';

export interface AdeConfig {
  /** absolute path of the single source of truth */
  workspaceRoot: string;
  port: number;
  host: string;
  /** optional bearer token; when set, /api and /ws require it */
  token?: string;
  /** Additional trusted browser origins, e.g. the HTTPS origin of a reverse proxy. */
  allowedOrigins: string[];
  push?: { publicKey: string; privateKey: string; subject: string };
  agents: AgentDefinition[];
}

interface ConfigFile {
  workspaceRoot?: string;
  port?: number;
  host?: string;
  token?: string;
  allowedOrigins?: string[];
  agents?: AgentDefinition[];
}

const DEMO_AGENT_CODE = [
  "const prompt = process.argv.slice(1).join(' ');",
  "console.log('[demo] task received:', prompt);",
  'let i = 0;',
  'const timer = setInterval(() => {',
  '  i += 1;',
  '  console.log(`[demo] step ${i}/5 — ${prompt}`);',
  '  if (i >= 5) { clearInterval(timer); console.log("[demo] done"); }',
  '}, 300);',
].join('\n');

export function defaultAgents(): AgentDefinition[] {
  return [
    {
      id: 'demo',
      label: 'Demo',
      description: 'Simulated agent — always available, useful for smoke tests',
      command: ['node', '-e', DEMO_AGENT_CODE, '{{prompt}}'],
    },
    {
      id: 'terminal-demo',
      label: 'Terminal Demo',
      description: 'Interactive PTY smoke test: type exit to finish',
      mode: 'pty',
      command: ['node', '-e', 'process.stdout.write("READY: type exit to finish\\r\\n"); process.stdin.on("data", d => { process.stdout.write("received: " + d); if (d.toString().trim() === "exit") process.exit(0) })'],
    },
    {
      id: 'codex',
      label: 'Codex',
      description: 'OpenAI Codex CLI (requires `codex` in PATH)',
      command: ['codex', 'exec', '--', '{{prompt}}'],
    },
    {
      id: 'codex-terminal',
      label: 'Codex Terminal',
      description: 'Interactive Codex CLI in a persistent PTY',
      command: ['codex', '{{prompt}}'],
      mode: 'pty',
    },
    {
      id: 'claude',
      label: 'Claude Code',
      description: 'Anthropic Claude Code CLI (requires `claude` in PATH)',
      command: ['claude', '-p', '{{prompt}}'],
    },
    {
      id: 'pi',
      label: 'Pi',
      description: 'Pi coding agent CLI (requires `pi` in PATH and configured credentials)',
      command: ['pi', '--print'],
      stdin: 'prompt',
    },
  ];
}

export function loadConfig(configPath = 'ade.config.json'): AdeConfig {
  let file: ConfigFile = {};
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ConfigFile;
    } catch (err) {
      throw new Error(`Failed to parse ${configPath}: ${String(err)}`);
    }
  }
  const workspaceRoot = path.resolve(process.env.ADE_WORKSPACE ?? file.workspaceRoot ?? './workspace');
  const port = Number(process.env.ADE_PORT ?? file.port ?? 8787);
  const host = process.env.ADE_HOST ?? file.host ?? '127.0.0.1';
  const token = process.env.ADE_TOKEN ?? file.token;
  const allowedOrigins = process.env.ADE_ALLOWED_ORIGINS
    ? process.env.ADE_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim())
    : file.allowedOrigins ?? [];
  if (!isLoopbackHost(host) && !token) {
    throw new Error('ADE_TOKEN is required when ADE_HOST is not loopback');
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) =>
    typeof origin !== 'string' || !isValidOrigin(origin))) {
    throw new Error('ADE_ALLOWED_ORIGINS must contain exact http(s) origins without paths');
  }
  if (allowedOrigins.some((origin) => !isLoopbackHost(new URL(origin).hostname)) && !token) {
    throw new Error('ADE_TOKEN is required when allowing remote browser origins');
  }
  const pushValues = [process.env.ADE_VAPID_PUBLIC_KEY, process.env.ADE_VAPID_PRIVATE_KEY, process.env.ADE_VAPID_SUBJECT];
  if (pushValues.some(Boolean) && !pushValues.every(Boolean)) {
    throw new Error('ADE_VAPID_PUBLIC_KEY, ADE_VAPID_PRIVATE_KEY and ADE_VAPID_SUBJECT must be set together');
  }
  const push = pushValues.every(Boolean) ? {
    publicKey: pushValues[0]!, privateKey: pushValues[1]!, subject: pushValues[2]!,
  } : undefined;
  if (push && !/^mailto:[^\s@]+@[^\s@]+$|^https:\/\/[^\s]+$/.test(push.subject)) {
    throw new Error('ADE_VAPID_SUBJECT must be a mailto: address or HTTPS URL');
  }
  const agents = file.agents?.length ? file.agents : defaultAgents();
  return { workspaceRoot, port, host, token, allowedOrigins, push, agents };
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.startsWith('127.'));
}

function isValidOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}
