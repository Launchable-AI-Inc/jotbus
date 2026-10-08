// Agents creating workspaces ("start a jotbus workspace and post X to it").
//  - Signed-in machine (`npx jotbus login`): a persistent, end-to-end encrypted workspace on the account, with a new
//    workspace-scoped token. The machine token itself never becomes a workspace connection.
//  - Otherwise, or when asked for a temporary one: a 60-minute workspace, exactly like `npx jotbus`.
// Either way the key is generated here, and the workspace is added to this machine's list (store.ts), so every agent
// session on the machine can use it right away.
import { connectionString, createCipher, formatInvite, generateKey } from './e2e.js';
import { readAccount } from './account.js';
import { addWorkspace, testTag } from './store.js';
import { VERSION } from './version.js';

export const CREATE_TOOL = {
  name: 'create_workspace',
  description:
    'Create a new Jotbus workspace and connect it on this machine. Use this when the user asks you to start, create or make a ' +
    'Jotbus workspace (then pass its name as `workspace` to write_workspace). If this machine is signed in to a Jotbus account ' +
    '(npx jotbus login), it is persistent on that account; otherwise, or with persistent: false, it is a free temporary workspace ' +
    'that lasts 60 minutes. Returns its name and how to share it.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Optional name (lowercase letters, digits, ".", "_", "-"). Persistent workspaces only; random otherwise.' },
      description: { type: 'string', description: 'Optional description (persistent workspaces).' },
      persistent: {
        type: 'boolean',
        description: 'Default: true when this machine is signed in, false otherwise. Persistent workspaces need `npx jotbus login` and a subscription.',
      },
    },
  },
};

/** One JSON-RPC tools/call against a hosted MCP endpoint (stateless server: no session handshake needed). */
async function hostedTool(url: string, token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'x-jotbus-e2e': '1', 'User-Agent': `jotbus/${VERSION}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw;
    try { msg = JSON.parse(raw).error ?? raw; } catch { /* keep text */ }
    return { isError: true, text: res.status === 401 ? 'This machine\'s Jotbus sign-in is no longer valid. Run npx jotbus login again.' : msg };
  }
  // Either plain JSON or an SSE stream with a single "data:" event.
  const body = raw.trim().startsWith('{') ? raw : raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
  const msg = JSON.parse(body) as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message: string } };
  if (msg.error) return { isError: true, text: msg.error.message };
  return { isError: Boolean(msg.result?.isError), text: msg.result?.content?.[0]?.text ?? '' };
}

export interface Created {
  workspace: string;
  workspace_id: string;
  persistent: boolean;
  expires_at: string | null;
  [k: string]: unknown;
}

export async function createWorkspace(args: { name?: unknown; description?: unknown; persistent?: unknown }, defaultMcpUrl: string): Promise<Created> {
  const account = readAccount();
  const persistent = typeof args.persistent === 'boolean' ? args.persistent : Boolean(account);
  const key = generateKey();
  const cipher = await createCipher(key);

  if (persistent) {
    if (!account) {
      throw new Error('Persistent workspaces need this machine to be signed in: ask the user to run `npx jotbus login` in a terminal, ' +
        'or create a temporary workspace (persistent: false).');
    }
    const r = await hostedTool(`${account.origin}/mcp`, account.token, 'create_account_workspace', {
      ...(typeof args.name === 'string' && args.name.trim() ? { name: args.name.trim() } : {}),
      ...(typeof args.description === 'string' && args.description.trim() ? { description: args.description.trim() } : {}),
      key_check: cipher.check,
    });
    if (r.isError) throw new Error(r.text);
    const ws = JSON.parse(r.text) as { workspace_id: string; name: string; token: string };
    addWorkspace({
      workspace_id: ws.workspace_id, name: ws.name, connection: connectionString(ws.token, key), url: `${account.origin}/mcp`,
      temporary: false, expires_at: null, role: 'account', added_at: new Date().toISOString(),
    });
    return {
      workspace: ws.name, workspace_id: ws.workspace_id, persistent: true, expires_at: null, account: account.email,
      // The key travels in the #fragment, which browsers never send to servers; that page loads no analytics.
      open_in_dashboard: `${account.origin}/open#${ws.workspace_id}.${key}`,
      tell_the_user:
        `Created the persistent, end-to-end encrypted workspace "${ws.name}" on their Jotbus account; it's connected on this machine. ` +
        'To see it in the dashboard, they can open the open_in_dashboard link in their browser (it carries the encryption key, so it is ' +
        'private to them). To add another machine, agent or person, use invite_to_workspace.',
    };
  }

  const origin = defaultMcpUrl.replace(/\/mcp\/?$/, '');
  const res = await fetch(`${origin}/anon/workspaces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'jotbus-cli' }, body: JSON.stringify({ key_check: cipher.check, ...testTag() }),
  });
  const ws = (await res.json().catch(() => ({}))) as { workspace_id?: string; name?: string; expires_at?: string; token?: string; invite?: string; error?: string };
  if (!res.ok || !ws.workspace_id) throw new Error(ws.error ?? `Couldn't create a temporary workspace (HTTP ${res.status}).`);
  const conn = connectionString(ws.token!, key);
  addWorkspace({
    workspace_id: ws.workspace_id, name: ws.name!, connection: conn, url: `${origin}/mcp`,
    temporary: true, expires_at: ws.expires_at ?? null, role: 'host', added_at: new Date().toISOString(),
  });
  const invite = formatInvite(ws.invite!, key);
  return {
    workspace: ws.name!, workspace_id: ws.workspace_id, persistent: false, expires_at: ws.expires_at ?? null,
    join_command: `npx jotbus@latest join ${invite}`,
    join_link: `${origin}/join#${invite}`,
    keep_link: `${origin}/claim#${conn}`,
    tell_the_user:
      `Created the temporary workspace "${ws.name}" (60 minutes, end-to-end encrypted); it's connected on this machine. ` +
      'To connect another machine or person, send them the join command privately (it contains the key). To keep the workspace, ' +
      'they can open keep_link (needs a subscription).' + (readAccount() ? '' : ' For persistent workspaces created by agents, run `npx jotbus login`.'),
  };
}
