// Local stdio MCP server: proxies the hosted Jotbus endpoint and handles end-to-end encryption on this machine.
// Tool definitions come from the hosted server, so they never drift. Launched by agents (claude mcp add ... npx jotbus).
//
// One server serves every workspace this machine has joined: connections come from the local workspace list
// (store.ts, written by `npx jotbus` / `join` / `connect`) plus, for older setups, JOTBUS_TOKEN. Each tool call is
// routed to the right connection by its `workspace` argument, so an agent can use "the navy-heron jotbus" and
// "the blue-meadow jotbus" side by side.
import { webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { createCipher, decryptFile, decryptFileMeta, encryptFile, encryptFileMeta, isEnvelope, parseConnectionString, sha256Hex, type WorkspaceCipher } from './e2e.js';
import { agentName } from './identity.js';
import { installClientCopy } from './agents.js';
import { markSeen } from './inbox.js';
import { CREATE_TOOL, createWorkspace } from './create.js';
import { listWorkspaces, storePath } from './store.js';

import { VERSION } from './version.js';
const MAX_PLAINTEXT_BYTES = 64 * 1024;

if (!globalThis.crypto) (globalThis as any).crypto = webcrypto;

// Logs go to stderr: stdout is the MCP channel. Never log the token or key.
const log = (msg: string) => process.stderr.write(`[jotbus] ${msg}\n`);

// Files: the hosted limit is per plan (25 MB, 2 MB in temporary workspaces); this only avoids encrypting huge files.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const FILE_ID_RE = /file_[A-Za-z0-9]{20}/;
const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.patch': 'text/x-diff', '.diff': 'text/x-diff', '.html': 'text/html', '.xml': 'application/xml', '.yaml': 'application/yaml',
  '.yml': 'application/yaml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
};
const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
/** A file name that's safe to write: no directories, no control characters. */
const safeName = (name: string) => basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+$/, '') || 'file';

const NO_WORKSPACES =
  'No Jotbus workspaces are connected on this machine yet. Create one with create_workspace, or ask the user to run ' +
  '`npx jotbus` (new temporary workspace) or `npx jotbus join <invite>` in a terminal; it becomes available here right away.';

interface WorkspaceInfo {
  id: string;
  name: string;
  description?: string;
  encrypted?: boolean;
  key_check?: string;
  temporary?: boolean;
  expires_at?: string;
  created_by_you?: boolean;
}

/** One connection string (token + optional key) on one endpoint. A token can reach one or more workspaces. */
interface Conn {
  raw: string;
  token: string;
  key: string | null;
  cipher: WorkspaceCipher | null;
  url: string;
  source: 'store' | 'env';
  upstream: Client | null;
  workspaces: WorkspaceInfo[] | null;
}

export async function runServer(defaultUrl: string): Promise<void> {
  // ---------------------------------------------------------------------------
  // Connections: the local workspace list plus JOTBUS_TOKEN (older setups). Re-read on every call.
  // ---------------------------------------------------------------------------

  const conns = new Map<string, Conn>(); // by token

  async function makeConn(raw: string, url: string, source: Conn['source']): Promise<Conn | null> {
    let parsed: ReturnType<typeof parseConnectionString>;
    try {
      parsed = parseConnectionString(raw);
    } catch {
      log(`ignoring an invalid connection string (${source})`);
      return null;
    }
    if (!parsed.token) {
      log(`ignoring a connection string without a token (${source})`);
      return null;
    }
    return {
      raw, token: parsed.token, key: parsed.key, cipher: parsed.key ? await createCipher(parsed.key) : null,
      url, source, upstream: null, workspaces: null,
    };
  }

  async function refreshConnections(): Promise<Conn[]> {
    const wanted = new Map<string, { raw: string; url: string; source: Conn['source'] }>();
    for (const w of listWorkspaces()) {
      const token = w.connection.split('.')[0];
      if (!wanted.has(token)) wanted.set(token, { raw: w.connection, url: w.url || defaultUrl, source: 'store' });
    }
    const env = process.env.JOTBUS_TOKEN?.trim();
    if (env) {
      const token = env.split('.')[0];
      if (!wanted.has(token)) wanted.set(token, { raw: env, url: defaultUrl, source: 'env' });
    }
    for (const token of [...conns.keys()]) if (!wanted.has(token)) conns.delete(token);
    for (const [token, w] of wanted) {
      const existing = conns.get(token);
      if (existing && existing.raw === w.raw && existing.url === w.url) continue;
      const c = await makeConn(w.raw, w.url, w.source);
      if (c) conns.set(token, c);
    }
    return [...conns.values()];
  }

  // ---------------------------------------------------------------------------
  // Upstream (hosted endpoint), one MCP session per connection
  // ---------------------------------------------------------------------------

  async function connectUpstream(c: Conn): Promise<Client> {
    if (c.upstream) return c.upstream;
    const client = new Client({ name: 'jotbus', version: VERSION });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(c.url), {
        requestInit: {
          // Only the token part of the connection string is ever sent. The key stays on this machine.
          headers: {
            Authorization: `Bearer ${c.token}`,
            'x-jotbus-e2e': '1',
            // Proves which key we encrypt with (reveals nothing about it); the server refuses stale keys.
            ...(c.cipher ? { 'x-jotbus-key-check': c.cipher.check } : {}),
            'User-Agent': `jotbus/${VERSION}`,
          },
        },
      }),
    );
    c.upstream = client;
    return client;
  }

  async function callUpstream(c: Conn, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      return (await (await connectUpstream(c)).callTool({ name, arguments: args })) as CallToolResult;
    } catch (err) {
      c.upstream = null; // reconnect on the next call
      throw err;
    }
  }

  const textOf = (r: CallToolResult) => (r.content?.[0]?.type === 'text' ? r.content[0].text : '');
  const jsonResult = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

  // ---------------------------------------------------------------------------
  // Workspaces across all connections
  // ---------------------------------------------------------------------------

  const originOf = (c: Conn) => c.url.replace(/\/mcp\/?$/, '');
  const claimLink = (c: Conn) => `${originOf(c)}/claim#${c.raw}`;

  async function loadWorkspaces(c: Conn, force = false): Promise<WorkspaceInfo[]> {
    if (c.workspaces && !force) return c.workspaces;
    const r = await callUpstream(c, 'list_workspaces', {});
    if (r.isError) throw new Error(textOf(r));
    c.workspaces = JSON.parse(textOf(r)) as WorkspaceInfo[];
    return c.workspaces;
  }

  interface Located {
    ws: WorkspaceInfo;
    conn: Conn;
  }

  /** Every reachable workspace, deduplicated by id (a workspace reachable twice uses the connection whose key fits). */
  async function allWorkspaces(force = false): Promise<Located[]> {
    const list = await refreshConnections();
    const results = await Promise.allSettled(list.map(async (conn) => (await loadWorkspaces(conn, force)).map((ws) => ({ ws, conn }))));
    const byId = new Map<string, Located>();
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        log(`a connection is unavailable (${list[i].source}): ${(r.reason as Error).message}`);
        return;
      }
      for (const l of r.value) {
        const prev = byId.get(l.ws.id);
        if (!prev || (keyProblem(prev.conn, prev.ws) && !keyProblem(l.conn, l.ws))) byId.set(l.ws.id, l);
      }
    });
    return [...byId.values()];
  }

  const describe = (l: Located) =>
    `${l.ws.name}${l.ws.temporary && l.ws.expires_at ? ` (temporary, expires ${new Date(l.ws.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}`;

  /** Resolves a `workspace` argument (name or id) across every connection. */
  async function locate(ref: unknown): Promise<Located | { error: string }> {
    let all = await allWorkspaces();
    const s = ref === undefined || ref === null ? '' : String(ref).trim();
    const match = () =>
      all.filter((l) => l.ws.id === s).length ? all.filter((l) => l.ws.id === s) : all.filter((l) => l.ws.name === s.toLowerCase());
    if (s && match().length === 0) all = await allWorkspaces(true); // joined since we last looked?
    if (all.length === 0) return { error: NO_WORKSPACES };
    const names = all.map(describe).join(', ');
    if (!s) {
      if (all.length === 1) return all[0];
      return {
        error: `Several Jotbus workspaces are connected on this machine: ${names}. Pass \`workspace\` with one of these names. ` +
          "If the user didn't say which one, ask them.",
      };
    }
    const found = match();
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      return { error: `More than one workspace is named "${s}": ${found.map((l) => l.ws.id).join(', ')}. Pass the workspace id instead.` };
    }
    return { error: `No Jotbus workspace "${s}" is connected on this machine. Connected: ${names}.` };
  }

  function keyProblem(c: Conn, ws: WorkspaceInfo): string | null {
    if (!ws.encrypted) return null;
    if (!c.cipher) {
      return `Workspace "${ws.name}" is end-to-end encrypted, but its connection has no key. Use the full connection string (token.key) shown when the token was minted.`;
    }
    if (c.cipher.check !== ws.key_check) {
      return `The encryption key for workspace "${ws.name}" doesn't match. Mint a new token from a browser where the workspace is unlocked, then run \`npx jotbus connect <connection string>\`.`;
    }
    return null;
  }

  /** Near expiry, tell the agent (and, for the creator, how to keep the workspace) so it can tell the user. */
  function withExpiryNotice(r: CallToolResult, l: Located): CallToolResult {
    if (r.isError) return r;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(textOf(r));
    } catch {
      return r;
    }
    // The server reports the current expiry with each call; the cached value may be stale (e.g. after a claim).
    const expiresAt = 'expires_at' in data ? (data.expires_at as string | null) : l.ws.expires_at;
    if (!expiresAt) return r;
    const minutes = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60000);
    if (minutes > 20) return r;
    const notice = minutes <= 0
      ? `The temporary Jotbus workspace "${l.ws.name}" has expired.`
      : `The temporary Jotbus workspace "${l.ws.name}" expires in ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
        (l.ws.created_by_you
          ? `Tell the user: to keep it (with its history and connected agents), they can open ${claimLink(l.conn)}`
          : 'Tell the user: whoever created it can keep it with the link `npx jotbus` printed, or start a new one with `npx jotbus`.');
    return jsonResult({ ...data, notice });
  }

  // ---------------------------------------------------------------------------
  // Tool handlers
  // ---------------------------------------------------------------------------

  async function decryptRead(r: CallToolResult, l: Located): Promise<CallToolResult> {
    if (r.isError) return r;
    const data = JSON.parse(textOf(r));
    if (!data.encrypted) return r;
    const problem = keyProblem(l.conn, l.ws);
    if (problem) return errorResult(problem);
    const attachmentsOf = async (list: Array<{ file_id: string; bytes: number; meta: string }> | null) => {
      if (!list?.length) return undefined;
      return Promise.all(list.map(async (a) => {
        try {
          const meta = await decryptFileMeta(l.conn.cipher!, data.workspace_id, a.meta);
          return { file_id: a.file_id, name: meta.name, type: meta.type, size: meta.size };
        } catch {
          return { file_id: a.file_id, name: '[unreadable]' };
        }
      }));
    };
    data.messages = await Promise.all(
      data.messages.map(async (m: { content: string; metadata: unknown; attachments?: Array<{ file_id: string; bytes: number; meta: string }> | null }) => {
        const { attachments: raw, ...rest } = m;
        const attachments = await attachmentsOf(raw ?? null);
        const withFiles = attachments ? { attachments } : {};
        if (!isEnvelope(m.content)) return { ...rest, content: '[unreadable: not an encrypted message]', ...withFiles };
        try {
          const p = await l.conn.cipher!.decrypt(data.workspace_id, m.content);
          return { ...rest, author: p.a ?? (m as { author?: string }).author, content: p.c, metadata: p.m ?? null, ...withFiles };
        } catch {
          return { ...rest, content: '[unreadable: could not decrypt with this key]', ...withFiles };
        }
      }),
    );
    delete data.workspace_id;
    return jsonResult(data);
  }

  /** Encrypts a local file and uploads it to the workspace. Returns its file id. */
  async function uploadFile(l: Located, path: string): Promise<string> {
    const full = resolve(path);
    let size: number;
    try {
      const st = statSync(full);
      if (!st.isFile()) throw new Error(`Not a file: ${path}`);
      size = st.size;
    } catch (err) {
      throw new Error((err as Error).message.startsWith('Not a file') ? (err as Error).message : `File not found: ${path} (use an absolute path)`);
    }
    if (size > MAX_UPLOAD_BYTES) throw new Error(`${basename(full)} is ${(size / 1048576).toFixed(1)} MB; files can be at most 25 MB.`);
    const data = new Uint8Array(readFileSync(full));
    const name = basename(full);
    const cipher = l.conn.cipher!;
    const { blob, key } = encryptFile(l.ws.id, data);
    const meta = await encryptFileMeta(cipher, l.ws.id, { name, type: mimeOf(name), size: data.length, sha256: sha256Hex(data), key });
    const created = await callUpstream(l.conn, 'create_file_upload', { workspace: l.ws.id, bytes: blob.length, sha256: sha256Hex(blob), meta });
    if (created.isError) throw new Error(`${name}: ${textOf(created)}`);
    const { file_id, upload_url } = JSON.parse(textOf(created)) as { file_id: string; upload_url: string };
    const put = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(blob) });
    if (!put.ok) throw new Error(`${name}: upload failed (HTTP ${put.status})`);
    const done = await callUpstream(l.conn, 'complete_file_upload', { file_id });
    if (done.isError) throw new Error(`${name}: ${textOf(done)}`);
    return file_id;
  }

  /** Downloads, verifies and decrypts a file to this machine. */
  async function getFile(args: Record<string, unknown>): Promise<CallToolResult> {
    const id = FILE_ID_RE.exec(String(args.file ?? args.file_id ?? ''))?.[0];
    if (!id) return errorResult('Pass `file`: a file ID like file_… (from a message\'s attachments or list_files).');
    let candidates: Conn[];
    if (args.workspace) {
      const l = await locate(args.workspace);
      if ('error' in l) return errorResult(l.error);
      candidates = [l.conn];
    } else candidates = await refreshConnections();
    if (candidates.length === 0) return errorResult(NO_WORKSPACES);
    let info: { workspace_id: string; download_url: string; sha256: string; meta: string; uploaded_by?: string; message_id?: string; created_at: string } | null = null;
    let conn: Conn | null = null;
    let lastError = `File ${id} not found in the workspaces on this machine.`;
    for (const c of candidates) {
      const r = await callUpstream(c, 'get_file', { file_id: id });
      if (!r.isError) {
        info = JSON.parse(textOf(r));
        conn = c;
        break;
      }
      if (!/not found/i.test(textOf(r))) lastError = textOf(r);
    }
    if (!info || !conn?.cipher) return errorResult(lastError);
    const res = await fetch(info.download_url);
    if (!res.ok) return errorResult(`Download failed (HTTP ${res.status}). Try again.`);
    const blob = new Uint8Array(await res.arrayBuffer());
    if (sha256Hex(blob) !== info.sha256) return errorResult('The downloaded file failed its integrity check, so it was not saved.');
    let meta, data: Uint8Array;
    try {
      meta = await decryptFileMeta(conn.cipher, info.workspace_id, info.meta);
      data = decryptFile(info.workspace_id, blob, meta.key);
    } catch {
      return errorResult('Could not decrypt this file with the workspace key.');
    }
    if (meta.sha256 && sha256Hex(data) !== meta.sha256) return errorResult('The decrypted file failed its integrity check, so it was not saved.');
    const dir = args.save_to ? resolve(String(args.save_to)) : join(tmpdir(), 'jotbus', id);
    mkdirSync(dir, { recursive: true });
    let out = join(dir, safeName(meta.name));
    if (args.save_to && existsSync(out)) {
      const ext = extname(out);
      out = `${out.slice(0, out.length - ext.length)}-${id.slice(5, 11)}${ext}`;
    }
    writeFileSync(out, data);
    return jsonResult({
      path: out, name: meta.name, type: meta.type, size: meta.size,
      message_id: info.message_id ?? null, created_at: info.created_at,
      note: 'Decrypted on this machine. Open it with your normal file tools.',
    });
  }

  async function handle(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name === 'create_workspace') {
      try {
        return jsonResult(await createWorkspace(args, defaultUrl));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
    if (name === 'get_file') return getFile(args);
    if (name === 'list_workspaces') {
      const all = await allWorkspaces(true);
      if (all.length === 0) return jsonResult({ workspaces: [], notice: NO_WORKSPACES });
      return jsonResult(
        all.map(({ ws: { key_check: _kc, ...w }, conn }, i) => ({ ...w, ...(w.encrypted ? { key_ok: !keyProblem(conn, all[i].ws) } : {}) })),
      );
    }
    if (name === 'jotbus_help') {
      const all = await allWorkspaces();
      const any = all[0]?.conn ?? (await refreshConnections())[0];
      if (!any) return { content: [{ type: 'text', text: `# Jotbus\n\n${NO_WORKSPACES}` }] };
      const r = await callUpstream(any, name, args);
      if (r.isError) return r;
      const extra: string[] = [];
      if (all.length > 1) {
        extra.push(`Workspaces connected on this machine: ${all.map(describe).join(', ')}. Pass \`workspace\` to choose one.`);
      }
      for (const l of all.filter((x) => x.ws.temporary)) {
        extra.push(
          l.ws.created_by_you
            ? `This machine created the temporary workspace "${l.ws.name}". Link to keep it (give it to the user only if they want to keep the workspace): ${claimLink(l.conn)}`
            : `"${l.ws.name}" is a temporary workspace created by someone else; only its creator can keep it.`,
        );
      }
      const text = textOf(r) + (extra.length ? `\n\n## This machine\n${extra.join('\n')}` : '');
      return { content: [{ type: 'text', text }] };
    }

    const l = await locate(args.workspace);
    if ('error' in l) return errorResult(l.error);
    const { ws, conn } = l;

    switch (name) {
      case 'write_workspace': {
        const author = (typeof args.author === 'string' && args.author.trim()) || me();
        if (!ws.encrypted) return callUpstream(conn, name, { ...args, workspace: ws.id, author }); // plain workspace
        const problem = keyProblem(conn, ws);
        if (problem) return errorResult(problem);
        const content = String(args.content ?? '');
        if (!content.trim()) return errorResult('content must be a non-empty string');
        if (Buffer.byteLength(content) > MAX_PLAINTEXT_BYTES) return errorResult('Message is too large; the maximum is 64 KB of text.');
        const meta = args.metadata as Record<string, unknown> | undefined;
        const paths = Array.isArray(args.files) ? args.files.map(String) : [];
        if (paths.length > 10) return errorResult('Attach at most 10 files per message.');
        const attachments: string[] = [];
        for (const p of paths) {
          try {
            attachments.push(await uploadFile(l, p));
          } catch (err) {
            return errorResult(`Message not sent: couldn't attach ${(err as Error).message}`);
          }
        }
        const envelope = await conn.cipher!.encrypt(ws.id, { c: content, a: author, ...(meta ? { m: meta } : {}) });
        // No plaintext author or metadata: the server sees only the token's label.
        const { metadata: _m, author: _a, files: _f, attachments: _x, ...rest } = args;
        const r = await callUpstream(conn, name, { ...rest, workspace: ws.id, content: envelope, ...(attachments.length ? { attachments } : {}) });
        if (r.isError || !attachments.length) return withExpiryNotice(r, l);
        return withExpiryNotice(jsonResult({ ...JSON.parse(textOf(r)), attached: attachments }), l);
      }
      case 'invite_to_workspace': {
        if (!ws.encrypted) return errorResult('Invites are available for end-to-end encrypted workspaces. Share an install command from the dashboard instead.');
        const problem = keyProblem(conn, ws);
        if (problem) return errorResult(problem);
        const r = await callUpstream(conn, name, { ...args, workspace: ws.id });
        if (r.isError) return r;
        const info = JSON.parse(textOf(r)) as Record<string, unknown> & { invite_secret: string };
        // The key is appended here, on this machine; the server only ever saw the invite secret.
        const invite = `${info.invite_secret}.${conn.key}`;
        const { invite_secret: _s, workspace_id: _w, ...rest } = info;
        return jsonResult({
          ...rest,
          join_command: `npx jotbus@latest join ${invite}`,
          join_link: `${originOf(conn)}/join#${invite}`,
          tell_the_user:
            'Send the join command (or link) privately; it contains the workspace\'s encryption key. The other person runs it in a ' +
            `terminal on their machine (Node 20+, no account needed), then tells their agent "Use the ${ws.name} Jotbus to collaborate."`,
        });
      }
      case 'list_files': {
        if (!ws.encrypted) return errorResult('Files are available in end-to-end encrypted workspaces.');
        const r = await callUpstream(conn, name, { ...args, workspace: ws.id });
        if (r.isError) return r;
        const data = JSON.parse(textOf(r)) as { workspace: string; workspace_id: string; files: Array<Record<string, unknown> & { meta: string }> };
        const files = await Promise.all(data.files.map(async ({ meta: m, workspace_id: _w, sha256: _s, bytes: _b, ...f }) => {
          try {
            const meta = await decryptFileMeta(conn.cipher!, data.workspace_id, m);
            return { ...f, name: meta.name, type: meta.type, size: meta.size };
          } catch {
            return { ...f, name: '[unreadable]' };
          }
        }));
        return jsonResult({ workspace: data.workspace, files });
      }
      case 'read_workspace':
      case 'listen_workspace': {
        const r = await decryptRead(await callUpstream(conn, name, { ...args, workspace: ws.id }), l);
        if (!r.isError) {
          // What the agent has read itself isn't delivered to it again by the inbox hook.
          try {
            const cursors = (JSON.parse(textOf(r)).messages ?? []).map((m: { cursor: number }) => m.cursor);
            if (cursors.length) markSeen(me(), ws.id, Math.max(...cursors));
          } catch { /* bookkeeping only */ }
        }
        return withExpiryNotice(r, l);
      }
      default:
        return callUpstream(conn, name, { ...args, workspace: ws.id });
    }
  }

  // ---------------------------------------------------------------------------
  // Local stdio server
  // ---------------------------------------------------------------------------

  const MULTI_NOTE =
    'Several Jotbus workspaces can be connected on this machine; list_workspaces shows them. When the user refers to one ' +
    'by name (for example "use the navy-heron jotbus"), pass that name as `workspace`. With more than one connected and no ' +
    'name given, ask the user which one.';

  let instructions = 'Shared scratchpad for coding agents (Jotbus).';
  try {
    const all = await allWorkspaces();
    const first = all[0]?.conn ?? (await refreshConnections())[0];
    if (first) instructions = (await connectUpstream(first)).getInstructions() ?? instructions;
    for (const l of all) {
      const p = keyProblem(l.conn, l.ws);
      if (p) log(p);
    }
    log(all.length ? `connected: ${all.length} workspace(s): ${all.map((l) => l.ws.name).join(', ')}` : 'no workspaces connected yet');
  } catch (err) {
    log(`could not reach Jotbus yet (${(err as Error).message}); will retry on first use`);
  }
  instructions += '\n\nMessages in encrypted workspaces are encrypted and decrypted on this machine; the server only stores ciphertext. Still never post secrets.';
  instructions += `\n\n${MULTI_NOTE}`;
  if (conns.size === 0) instructions += `\n\n${NO_WORKSPACES}`;

  // Upstream instructions name the token's label; with a shared token the real identity is agent + machine.
  instructions = instructions.replace(/\n*Other agents see your messages as written by[^\n]*/, '');

  const server = new Server({ name: 'jotbus', version: VERSION }, { capabilities: { tools: { listChanged: true } }, instructions });
  const me = () => agentName(server.getClientVersion()?.name);

  /** Tool list from the hosted server (any connection), or a local stub until a workspace is connected. */
  async function upstreamTools(): Promise<Tool[] | null> {
    for (const c of await refreshConnections()) {
      try {
        return (await (await connectUpstream(c)).listTools()).tools;
      } catch {
        c.upstream = null;
      }
    }
    return null;
  }

  const STUB_TOOLS: Tool[] = [
    { name: 'list_workspaces', description: `List the Jotbus workspaces connected on this machine. ${NO_WORKSPACES}`, inputSchema: { type: 'object', properties: {} } },
    { name: 'jotbus_help', description: 'How Jotbus works and how to connect a workspace.', inputSchema: { type: 'object', properties: {} } },
    CREATE_TOOL,
  ];

  let servedStub = false;
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await upstreamTools();
    servedStub = !tools;
    if (!tools) return { tools: STUB_TOOLS };
    const hidden = new Set(['create_file_upload', 'complete_file_upload', 'create_account_workspace']);
    return {
      tools: [...tools.filter((t) => !hidden.has(t.name)), CREATE_TOOL as Tool].map((t) => {
        let description = t.description ?? '';
        if (t.name === 'write_workspace') {
          const props = { ...((t.inputSchema?.properties as Record<string, object>) ?? {}) };
          delete props.attachments;
          props.files = {
            type: 'array', items: { type: 'string' }, maxItems: 10,
            description: 'Local paths of files to attach (absolute paths are safest). Each is encrypted on this machine before upload. ' +
              'Up to 25 MB each (2 MB in temporary workspaces).',
          };
          t = { ...t, inputSchema: { ...t.inputSchema, properties: props } };
          description += ' To share files (logs, patches, screenshots, reports), pass their local paths in `files`.';
        }
        if (t.name === 'get_file') {
          t = {
            ...t,
            inputSchema: {
              type: 'object',
              properties: {
                file: { type: 'string', description: 'File ID (file_…), e.g. from a message\'s attachments or list_files.' },
                workspace: { type: 'string', description: 'Optional workspace name; searched across all of them otherwise.' },
                save_to: { type: 'string', description: 'Optional directory to save into. Default: a temporary directory.' },
              },
              required: ['file'],
            },
          };
          description = 'Download a shared file, verify and decrypt it on this machine, and return its local path so you can open it with your normal file tools.';
        }
        if (t.name === 'write_workspace') {
          description += ` You appear to other agents as "${me()}"; they can @mention you as @${me()}. In encrypted workspaces the text is encrypted on this machine before upload.`;
        }
        if ((t.inputSchema?.properties as Record<string, unknown> | undefined)?.workspace) {
          description += ' Several workspaces can be connected on this machine: pass `workspace` (a name from list_workspaces) when the user names one or more than one is connected.';
        }
        return { ...t, description };
      }),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await handle(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    } catch (err) {
      return errorResult(`Jotbus request failed: ${(err as Error).message}`);
    }
  });

  // A workspace joined in a terminal shows up without restarting the agent. If we only had the stub tools, tell the
  // client the full tool list is now available.
  const path = storePath();
  watchFile(path, { interval: 2000 }, () => {
    void refreshConnections().then((list) => {
      if (servedStub && list.length > 0) {
        servedStub = false;
        void server.sendToolListChanged().catch(() => {});
      }
    });
  });

  // Exit when the parent agent goes away (stdin closes); otherwise the open upstream connection keeps us alive.
  const shutdown = () => {
    unwatchFile(path);
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  server.onclose = shutdown;

  installClientCopy();
  await server.connect(new StdioServerTransport());
}
