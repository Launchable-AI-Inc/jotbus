// The workspaces this machine has joined: one private file, shared by every agent's local Jotbus server.
// `npx jotbus` / `join` / `connect` add to it; the MCP server re-reads it, so a workspace joined in a terminal is
// usable right away in agent sessions that are already open. Holds secrets (connection strings): mode 600.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface StoredWorkspace {
  workspace_id: string;
  name: string;
  /** Connection string: jb_live_<token>.<key>. Only the token part is ever sent to Jotbus. */
  connection: string;
  /** MCP endpoint this workspace lives on (production unless created against another environment). */
  url: string;
  temporary: boolean;
  expires_at: string | null;
  /** host = created on this machine (can keep it with the claim link); guest = joined; account = from the dashboard. */
  role: 'host' | 'guest' | 'account';
  added_at: string;
}

interface StoreFile {
  version: 1;
  workspaces: StoredWorkspace[];
}

/** Temporary workspaces are purged about an hour after they expire; forget them a little after that. */
const FORGET_AFTER_EXPIRY_MS = 2 * 60 * 60 * 1000;

/**
 * ~/.config/jotbus/workspaces.json, or $JOTBUS_HOME/workspaces.json. Deliberately not $XDG_CONFIG_HOME: agents may start
 * MCP servers with a filtered environment, and the CLI and every agent's server must agree on one file.
 */
export function storePath(): string {
  if (process.env.JOTBUS_HOME) return join(process.env.JOTBUS_HOME, 'workspaces.json');
  return join(homedir(), '.config', 'jotbus', 'workspaces.json');
}

export function isGone(w: StoredWorkspace, now = Date.now()): boolean {
  return Boolean(w.temporary && w.expires_at && new Date(w.expires_at).getTime() + FORGET_AFTER_EXPIRY_MS < now);
}

export function isExpired(w: StoredWorkspace, now = Date.now()): boolean {
  return Boolean(w.expires_at && new Date(w.expires_at).getTime() <= now);
}

export function readStore(path = storePath()): StoredWorkspace[] {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
    return Array.isArray(data.workspaces) ? data.workspaces.filter((w) => w && w.connection && w.workspace_id) : [];
  } catch {
    return [];
  }
}

function writeStore(list: StoredWorkspace[], path = storePath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, workspaces: list } satisfies StoreFile, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort (e.g. Windows)
  }
}

/** Adds or updates a workspace (keyed by workspace id) and forgets long-expired temporary ones. Returns the new list. */
export function addWorkspace(entry: StoredWorkspace, path = storePath()): StoredWorkspace[] {
  const list = readStore(path).filter((w) => w.workspace_id !== entry.workspace_id && !isGone(w));
  list.push(entry);
  writeStore(list, path);
  return list;
}

/** Removes workspaces matching a name or id. Returns the removed entries. */
export function removeWorkspace(ref: string, path = storePath()): StoredWorkspace[] {
  const s = ref.trim().toLowerCase();
  const list = readStore(path);
  const removed = list.filter((w) => w.workspace_id.toLowerCase() === s || w.name === s);
  if (removed.length) writeStore(list.filter((w) => !removed.includes(w)), path);
  return removed;
}

/** Live entries only (drops long-expired temporary workspaces from the file as a side effect). */
export function listWorkspaces(path = storePath()): StoredWorkspace[] {
  const list = readStore(path);
  const live = list.filter((w) => !isGone(w));
  if (live.length !== list.length) writeStore(live, path);
  return live;
}

/** JOTBUS_TEST=1 marks workspaces this client creates as test traffic, so analytics can tell them from real use. */
export const testTag = (): { test?: true } => (process.env.JOTBUS_TEST === '1' ? { test: true } : {});
