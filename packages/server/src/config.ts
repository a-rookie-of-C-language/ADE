import fs from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '@ade/shared';

export interface AdeConfig {
  /** absolute path of the single source of truth */
  workspaceRoot: string;
  port: number;
  host: string;
  /** optional bearer token; when set, /api and /ws require it */
  token?: string;
  agents: AgentDefinition[];
}

interface ConfigFile {
  workspaceRoot?: string;
  port?: number;
  host?: string;
  token?: string;
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
      id: 'codex',
      label: 'Codex',
      description: 'OpenAI Codex CLI (requires `codex` in PATH)',
      command: ['codex', 'exec', '--', '{{prompt}}'],
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
      description: 'Pi agent — adjust the command to your install',
      command: ['pi', '{{prompt}}'],
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
  const agents = file.agents?.length ? file.agents : defaultAgents();
  return { workspaceRoot, port, host, token, agents };
}