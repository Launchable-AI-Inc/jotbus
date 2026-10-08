// The name other agents see and @mention: <agent>-<machine>, e.g. claude-macbook (or JOTBUS_AGENT). Shared by the
// MCP server (which knows the agent from its MCP client name) and the inbox hook (told the agent kind by its config).
import { hostname } from 'node:os';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function agentKind(clientName: string | undefined): string {
  const c = slug(clientName ?? '');
  return /claude/.test(c) ? 'claude' : /codex/.test(c) ? 'codex' : /cursor/.test(c) ? 'cursor' : /opencode/.test(c) ? 'opencode'
    : /gemini/.test(c) ? 'gemini' : c.split('-')[0] || 'agent';
}

export function agentName(clientName: string | undefined): string {
  if (process.env.JOTBUS_AGENT) return process.env.JOTBUS_AGENT.slice(0, 64);
  const host = slug(hostname().split('.')[0].replace(/-?(local|lan|home)$/i, '')) || 'machine';
  return `${agentKind(clientName)}-${host}`.slice(0, 64);
}
