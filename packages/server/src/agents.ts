import fs from 'node:fs';
import path from 'node:path';
import type { AgentDefinition, AgentInfo } from '@ade/shared';
import type { AdeConfig } from './config.js';
import { toAbsoluteDir } from './paths.js';

function isExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function agentAvailability(agent: AgentDefinition, root: string, cwd = '.'): Pick<AgentInfo, 'available' | 'unavailableReason'> {
  if (agent.enabled === false) return { available: false, unavailableReason: 'Disabled in ADE configuration' };
  const command = agent.command?.[0];
  if (!command) return { available: false, unavailableReason: 'No command configured' };

  let directory: string;
  try {
    directory = toAbsoluteDir(root, agent.cwd ?? cwd);
  } catch {
    return { available: false, unavailableReason: 'Invalid working directory' };
  }
  const nativeOnly = agent.mode === 'pty' && process.platform === 'win32';
  const extensions = process.platform === 'win32'
    ? nativeOnly ? ['.exe'] : ['.exe', '.com', '.cmd', '.bat']
    : [''];
  const candidates = (file: string): string[] => {
    if (process.platform !== 'win32') return [file];
    const ext = path.extname(file).toLowerCase();
    return ext ? extensions.includes(ext) ? [file] : [] : extensions.map((suffix) => file + suffix);
  };
  const paths = command.includes('/') || command.includes('\\')
    ? [path.resolve(directory, command)]
    : (agent.env?.PATH ?? agent.env?.Path ?? process.env.PATH ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin'))
      .split(path.delimiter).map((entry) => path.resolve(entry || directory, command));

  if (paths.some((file) => candidates(file).some(isExecutable))) return { available: true };
  return { available: false, unavailableReason: nativeOnly
    ? 'Native executable not found on ADE server'
    : 'Executable not found on ADE server' };
}

export function listAgents(config: AdeConfig): AgentInfo[] {
  return config.agents.map((agent) => ({
    id: agent.id,
    label: agent.label,
    ...(agent.description === undefined ? {} : { description: agent.description }),
    ...(agent.mode === undefined ? {} : { mode: agent.mode }),
    ...(agent.enabled === undefined ? {} : { enabled: agent.enabled }),
    ...(agent.cwd === undefined ? {} : { fixedWorkingDirectory: true }),
    ...agentAvailability(agent, config.workspaceRoot),
  }));
}
