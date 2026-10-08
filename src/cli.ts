// Human-facing CLI: `npx jotbus` creates a temporary workspace, `npx jotbus join <invite>` joins one. Both add it to
// this machine's workspace list (store.ts) and make sure the Jotbus MCP server is registered with the coding agents
// found here. The registration holds no secret and is shared by every workspace, so agents can use several by name.
import { dirname, join as joinPath } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { connectionString, createCipher, formatInvite, generateKey, parseConnectionString, parseInvite } from './e2e.js';
import { AGENTS, MANUAL_ONLY, SERVER_ARGS, agentById, installClientCopy, readDeclined, writeDeclined, type AgentAdapter } from './agents.js';
import { multiSelect } from './pick.js';
import { addWorkspace, isExpired, listWorkspaces, removeWorkspace, storePath, type StoredWorkspace, testTag } from './store.js';
import { DEFAULT_ORIGIN, VERSION } from './version.js';

const color = (code: string) => (s: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = color('1');
const dim = color('2');
const green = color('32');
const cyan = color('36');
const yellow = color('33');

const out = (s = '') => process.stdout.write(`${s}\n`);

export interface CliOptions {
  origin: string;
  yes: boolean;
  install: boolean;
  /** --agents claude,codex | all | none: which agents to register, without asking. */
  agents?: string[] | 'all' | 'none';
  /** false with --no-inbox: don't install passive delivery hooks. */
  inbox?: boolean;
}

function die(msg: string): never {
  process.stderr.write(`${color('31')('✗')} ${msg}\n`);
  process.exit(1);
}

async function post<T>(opts: CliOptions, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${opts.origin}/anon/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'jotbus-cli' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    die(`Couldn't reach ${opts.origin} (${(err as Error).message}).`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) die(data.error ?? `Request failed (${res.status}).`);
  return data;
}

function minutesLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000));
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ---------------------------------------------------------------------------
// Registering with local agents
// ---------------------------------------------------------------------------

interface InstallResult {
  /** Agents that got Jotbus registered just now (they need a new session). */
  added: string[];
  /** Agents that already had it (they see the new workspace right away). */
  already: string[];
}

const declinedPath = () => joinPath(dirname(storePath()), 'agents.json');

/** Resolves --agents against the agents found here. Unknown ids are reported. */
function chosenByFlag(opts: CliOptions, found: AgentAdapter[], already: AgentAdapter[] = []): AgentAdapter[] | null {
  if (!opts.agents) return null;
  if (opts.agents === 'all') return found;
  if (opts.agents === 'none') return [];
  const picked: AgentAdapter[] = [];
  for (const id of opts.agents) {
    const a = agentById(id);
    if (!a) out(`${yellow('!')} Unknown agent "${id}". Known: ${AGENTS.map((x) => x.id).join(', ')}`);
    else if (already.includes(a)) continue; // already set up (reported above)
    else if (!found.includes(a)) out(`${yellow('!')} ${a.name} isn't installed here; skipped.`);
    else picked.push(a);
  }
  return picked;
}

/** Passive delivery: messages addressed to the agent reach it while it works. Installed with the agent unless --no-inbox. */
function ensureInbox(a: AgentAdapter, opts: CliOptions, quiet = false) {
  if (!a.inbox || opts.inbox === false || a.inbox.has()) return;
  installClientCopy();
  const r = a.inbox.add();
  if (r.ok && !quiet) out(`${green('✓')} ${a.name} picks up messages addressed to it automatically${a.inbox.note ? dim(` (${a.inbox.note})`) : ''}`);
  else if (!r.ok) out(`${yellow('!')} Couldn't set up automatic delivery for ${a.name}: ${r.manual}`);
}

function addTo(a: AgentAdapter, result: InstallResult, opts: CliOptions = { origin: '', yes: false, install: true }) {
  const r = a.add();
  if (r.ok) {
    result.added.push(a.name);
    out(`${green('✓')} Added Jotbus to ${a.name}${a.after ? dim(` (${a.after})`) : ''}`);
    ensureInbox(a, opts);
  } else {
    out(`${yellow('!')} Couldn't add Jotbus to ${a.name} automatically. ${r.manual ? 'Instead,' : 'Run:'}\n  ${r.manual ?? a.manual()}`);
  }
}

/** Registers Jotbus with the agents the user picks (once per machine). Existing registrations are left alone. */
async function install(opts: CliOptions, conn: string): Promise<InstallResult> {
  const result: InstallResult = { added: [], already: [] };
  const printManual = (title: string) => {
    out(bold(title));
    for (const a of AGENTS) out(`  ${dim(a.name + ':')} ${a.manual()}`);
    out(`  ${dim('Other MCP clients:')} command "npx ${SERVER_ARGS.join(' ')}" (reads ${storePath()}),`);
    out(`  ${dim('  or, where that list isn\'t available:')} the same command with env JOTBUS_TOKEN=${conn}`);
  };
  if (!opts.install) {
    printManual('Add Jotbus to your agent (once per machine):');
    return result;
  }
  const found = AGENTS.filter((a) => a.installed());
  if (found.length === 0) {
    printManual('No supported coding agents found on this machine. Add Jotbus to yours (once per machine):');
    return result;
  }
  const registered = found.filter((a) => a.registered());
  installClientCopy(); // keep the copy hooks run up to date
  for (const a of registered) {
    result.already.push(a.name);
    out(`${green('✓')} ${a.name} already has Jotbus`);
    ensureInbox(a, opts);
  }
  const candidates = found.filter((a) => !registered.includes(a));
  const declined = readDeclined(declinedPath());
  let chosen = chosenByFlag(opts, candidates, registered);
  if (!chosen && candidates.length) {
    const picks = await multiSelect(
      bold(registered.length ? 'Also add Jotbus to:' : 'Add Jotbus to which agents?'),
      candidates.map((a) => ({ label: a.name, checked: !declined.includes(a.id) })),
    );
    chosen = candidates.filter((_, i) => picks[i]);
    const no = candidates.filter((a) => !chosen!.includes(a)).map((a) => a.id);
    writeDeclined(declinedPath(), [...declined.filter((id) => !chosen!.some((a) => a.id === id)), ...no]);
  }
  for (const a of chosen ?? []) addTo(a, result, opts);
  const skipped = candidates.filter((a) => !(chosen ?? []).includes(a));
  if (skipped.length) out(dim(`  Not added: ${skipped.map((a) => a.name).join(', ')}. Change this any time: npx jotbus agents`));
  return result;
}

/** `npx jotbus agents`: choose which agents on this machine have Jotbus (adds and removes). */
export async function agents(opts: CliOptions): Promise<void> {
  const found = AGENTS.filter((a) => a.installed());
  const missing = AGENTS.filter((a) => !found.includes(a));
  if (found.length === 0) {
    out(`No supported coding agents found on this machine. Supported: ${AGENTS.map((a) => a.name).join(', ')}.`);
    return;
  }
  const current = found.map((a) => a.registered());
  let want: boolean[];
  const flag = chosenByFlag(opts, found);
  if (flag) want = found.map((a) => flag.includes(a));
  else want = await multiSelect(bold('Which agents should have Jotbus?'), found.map((a, i) => ({ label: a.name, checked: current[i] })));
  const result: InstallResult = { added: [], already: [] };
  found.forEach((a, i) => {
    if (want[i] && !current[i]) addTo(a, result, opts);
    else if (!want[i] && current[i]) {
      a.inbox?.remove();
      const r = a.remove();
      out(r.ok ? `${green('✓')} Removed Jotbus from ${a.name}` : `${yellow('!')} Couldn't remove Jotbus from ${a.name} automatically: ${r.manual}`);
    } else out(dim(`  ${a.name}: ${want[i] ? 'has Jotbus' : 'no Jotbus'} (unchanged)`));
  });
  writeDeclined(declinedPath(), found.filter((_, i) => !want[i]).map((a) => a.id));
  if (result.added.length) out(dim(`  (Start a new ${result.added.join(' / ')} session so it picks up Jotbus.)`));
  if (missing.length) out(dim(`  Also supported, not found on this machine: ${missing.map((a) => a.name).join(', ')}`));
  out(dim(`  Set up by hand for now: ${MANUAL_ONLY.join('; ')}. Run with --no-install to see the server command.`));
}

function nextSteps(r: InstallResult, name: string) {
  out();
  out(bold('Then tell your agent:'));
  out(`  ${cyan(`"Use the ${name} Jotbus to collaborate."`)}`);
  if (r.added.length) out(dim(`  (Start a new ${r.added.join(' / ')} session so it picks up Jotbus.)`));
  if (r.already.length) out(dim(`  (${r.already.join(' / ')} can use it right away, even in sessions that are already open.)`));
  const others = listWorkspaces().filter((w) => w.name !== name && !isExpired(w));
  if (others.length) out(dim(`  Also on this machine: ${others.map((w) => w.name).join(', ')}. Agents pick one by name; see \`npx jotbus list\`.`));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function create(opts: CliOptions): Promise<void> {
  const key = generateKey();
  const cipher = await createCipher(key);
  const ws = await post<{ workspace_id: string; name: string; expires_at: string; token: string; invite: string }>(
    opts, 'workspaces', { key_check: cipher.check, ...testTag() });
  const invite = formatInvite(ws.invite, key);

  out(`${green('✓')} Created temporary workspace ${bold(ws.name)} ${dim(`(end-to-end encrypted, expires in ${minutesLeft(ws.expires_at)} minutes at ${clock(ws.expires_at)})`)}`);
  remember(opts, { workspace_id: ws.workspace_id, name: ws.name, connection: connectionString(ws.token, key), temporary: true, expires_at: ws.expires_at, role: 'host' });
  const added = await install(opts, connectionString(ws.token, key));
  out();
  out(bold('Connect another machine or person:'));
  // @latest: an older npx-cached jotbus would ignore "join" and start the MCP server instead.
  const originFlag = opts.origin === DEFAULT_ORIGIN ? '' : ` --origin ${opts.origin}`;
  out(`  ${cyan(`npx jotbus@latest join ${invite}${originFlag}`)}`);
  out(dim(`  or share this link: ${opts.origin}/join#${invite}`));
  out(dim('  No account needed. Up to 3 connected clients. The invite includes the encryption key, so share it privately.'));
  out();
  out(bold('Keep it beyond 60 minutes:'));
  out(dim(`  ${opts.origin}/claim#${connectionString(ws.token, key)}`));
  out(dim('  (only you have this link; it keeps the history and every connected agent)'));
  nextSteps(added, ws.name);
}

export async function join(opts: CliOptions, input: string | undefined): Promise<void> {
  const parsed = input ? parseInvite(input) : null;
  if (!parsed) die('Usage: npx jotbus join <invite>  (the jb1_… invite or join link you were sent)');
  const cipher = await createCipher(parsed.key);
  // Only the invite secret goes to the server; the key stays on this machine.
  const ws = await post<{ workspace_id: string; name: string; expires_at: string; key_check: string; token: string }>(
    opts, 'join', { invite: parsed.invite });
  if (ws.key_check !== cipher.check) die('This invite\'s encryption key doesn\'t match the workspace. Ask for a fresh invite.');

  out(`${green('✓')} Joined ${bold(ws.name)} ${dim(`(end-to-end encrypted, expires in ${minutesLeft(ws.expires_at)} minutes at ${clock(ws.expires_at)})`)}`);
  remember(opts, { workspace_id: ws.workspace_id, name: ws.name, connection: connectionString(ws.token, parsed.key), temporary: true, expires_at: ws.expires_at, role: 'guest' });
  const added = await install(opts, connectionString(ws.token, parsed.key));
  nextSteps(added, ws.name);
}

function remember(opts: CliOptions, w: Omit<StoredWorkspace, 'url' | 'added_at'>) {
  addWorkspace({ ...w, url: `${opts.origin}/mcp`, added_at: new Date().toISOString() });
}

/** `npx jotbus connect <connection string>`: adds a workspace from the dashboard (persistent) to this machine. */
export async function connect(opts: CliOptions, input: string | undefined): Promise<void> {
  let parsed: ReturnType<typeof parseConnectionString> | null = null;
  try {
    parsed = input ? parseConnectionString(input.trim()) : null;
  } catch {
    parsed = null;
  }
  if (!parsed?.token) die('Usage: npx jotbus connect <connection string>  (the jb_live_… string the dashboard shows when you mint a token)');
  const cipher = parsed.key ? await createCipher(parsed.key) : null;
  const url = `${opts.origin}/mcp`;
  const client = new Client({ name: 'jotbus-cli', version: VERSION });
  let list: Array<{ id: string; name: string; encrypted?: boolean; key_check?: string; temporary?: boolean; expires_at?: string; created_by_you?: boolean }>;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${parsed.token}`, 'x-jotbus-e2e': '1', ...(cipher ? { 'x-jotbus-key-check': cipher.check } : {}), 'User-Agent': `jotbus/${VERSION}` } },
    }));
    const r = (await client.callTool({ name: 'list_workspaces', arguments: {} })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    const text = r.content?.[0]?.text ?? '';
    if (r.isError) die(text || 'Jotbus refused this connection string.');
    list = JSON.parse(text);
  } catch (err) {
    die(`Couldn't connect with that connection string (${(err as Error).message}).`);
  } finally {
    await client.close().catch(() => {});
  }
  const usable = list.filter((w) => !w.encrypted || (cipher && w.key_check === cipher.check));
  if (usable.length === 0) die('This connection string doesn\'t unlock any workspace. Mint a new token from a browser where the workspace is unlocked.');
  for (const w of usable) {
    remember(opts, {
      workspace_id: w.id, name: w.name, connection: input!.trim(), temporary: Boolean(w.temporary), expires_at: w.expires_at ?? null,
      role: w.temporary ? (w.created_by_you ? 'host' : 'guest') : 'account',
    });
    out(`${green('✓')} Connected ${bold(w.name)}${w.encrypted ? dim(' (end-to-end encrypted)') : ''}`);
  }
  const added = await install(opts, input!.trim());
  nextSteps(added, usable[0].name);
}

/** `npx jotbus list`: the workspaces this machine has joined. */
export function list(): void {
  const all = listWorkspaces();
  if (all.length === 0) {
    out(`No workspaces on this machine yet. Run ${cyan('npx jotbus')} to start one, or ${cyan('npx jotbus join <invite>')}.`);
    return;
  }
  out(bold('Jotbus workspaces on this machine:'));
  for (const w of all) {
    const state = !w.temporary ? 'persistent' : isExpired(w) ? 'expired' : `temporary, expires ${clock(w.expires_at!)}`;
    const role = w.role === 'host' ? 'created here' : w.role === 'guest' ? 'joined' : 'from your account';
    const env = w.url === `${DEFAULT_ORIGIN}/mcp` ? '' : `, ${w.url.replace(/\/mcp\/?$/, '')}`;
    out(`  ${bold(w.name)} ${dim(`(${state}, ${role}${env})`)}`);
  }
  out(dim(`Agents pick one by name: "Use the ${all[0].name} Jotbus to …". Forget one here with: npx jotbus remove <name>`));
}

/** `npx jotbus remove <name>`: forgets a workspace on this machine (it isn't deleted). */
export function remove(ref: string | undefined): void {
  if (!ref) die('Usage: npx jotbus remove <workspace name>');
  const removed = removeWorkspace(ref);
  if (removed.length === 0) die(`No workspace "${ref}" on this machine. See: npx jotbus list`);
  for (const w of removed) out(`${green('✓')} Removed ${bold(w.name)} from this machine ${dim('(the workspace itself is unchanged; agents here can no longer use it)')}`);
}

/** `npx jotbus inbox on|off|status`: automatic delivery of messages addressed to your agents. */
export async function inboxCommand(opts: CliOptions, sub: string | undefined): Promise<void> {
  const found = AGENTS.filter((a) => a.inbox && a.installed() && a.registered());
  if (sub === 'off') {
    for (const a of AGENTS.filter((x) => x.inbox?.has())) {
      const r = a.inbox!.remove();
      out(r.ok ? `${green('✓')} ${a.name}: automatic delivery off` : `${yellow('!')} ${a.name}: ${r.manual}`);
    }
    return;
  }
  if (sub === 'on') {
    if (!found.length) out('No agents with Jotbus that support automatic delivery. Run npx jotbus first.');
    for (const a of found) ensureInbox(a, { ...opts, inbox: true });
    for (const a of found) if (a.inbox!.has()) out(dim(`  ${a.name}: on`));
    return;
  }
  out(bold('Automatic delivery of messages addressed to your agents:'));
  for (const a of AGENTS.filter((x) => x.inbox && x.installed())) out(`  ${a.name}: ${a.inbox!.has() ? green('on') : 'off'}`);
  out(dim('Agents get messages that @mention them when you prompt them or while they work; nothing runs while they\'re idle.'));
  out(dim('Turn it on or off with: npx jotbus inbox on|off'));
}
