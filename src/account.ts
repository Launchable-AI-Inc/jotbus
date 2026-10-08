// Machine sign-in: `npx jotbus login` (device authorization, like `gh auth login`), `logout` and `whoami`.
// The credential is a MACHINE token that can only create workspaces on the account (see create.ts); it's kept next
// to the workspace list in a private file (mode 600) and is revocable from the dashboard's Tokens page.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { storePath } from './store.js';

export interface Account {
  /** App origin the machine signed in to, e.g. https://app.jotbus.com */
  origin: string;
  token: string;
  label: string;
  email: string | null;
  signed_in_at: string;
}

export const accountPath = () => join(dirname(storePath()), 'account.json');

export function readAccount(): Account | null {
  try {
    const a = JSON.parse(readFileSync(accountPath(), 'utf8')) as Account;
    return a && typeof a.token === 'string' && typeof a.origin === 'string' ? a : null;
  } catch {
    return null;
  }
}

function writeAccount(a: Account): void {
  const p = accountPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
  try {
    chmodSync(p, 0o600);
  } catch {
    // best effort (e.g. Windows)
  }
}

async function post<T>(origin: string, path: string, body: unknown, token?: string): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(`${origin}/anon/device/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'jotbus-cli', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, status: res.status, data };
}

const machineName = () => hostname().split('.')[0].replace(/[^A-Za-z0-9._ -]/g, '-').slice(0, 40) || 'machine';

export interface LoginIO {
  out(s?: string): void;
  sleep?(ms: number): Promise<void>;
}

/** Runs the device flow; resolves with the stored account, or throws with a user-facing message. */
export async function login(origin: string, io: LoginIO): Promise<Account> {
  const sleep = io.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = await post<{ device_code: string; user_code: string; expires_in: number; interval: number }>(origin, 'start', { label: machineName() });
  if (!start.ok) throw new Error(start.data.error ?? `Couldn't start sign-in (HTTP ${start.status}).`);
  const { device_code, user_code, expires_in } = start.data;
  let interval = Math.max(5, start.data.interval ?? 5);
  io.out(`To sign this machine in to Jotbus, open:`);
  io.out(`  ${origin}/#/device?code=${user_code}`);
  io.out(`and check that it shows the code ${user_code}. Waiting for approval…`);
  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const r = await post<{ status: string; token?: string; label?: string; email?: string; reason?: string }>(origin, 'poll', { device_code });
    if (!r.ok) throw new Error(r.data.error ?? `Sign-in failed (HTTP ${r.status}).`);
    switch (r.data.status) {
      case 'pending':
        continue;
      case 'slow_down':
        interval += 5;
        continue;
      case 'denied':
        throw new Error(r.data.reason ?? 'Sign-in was denied.');
      case 'expired':
        throw new Error('The sign-in code expired. Run npx jotbus login again.');
      case 'approved': {
        const account: Account = {
          origin, token: r.data.token!, label: r.data.label ?? machineName(), email: r.data.email ?? null, signed_in_at: new Date().toISOString(),
        };
        writeAccount(account);
        return account;
      }
      default:
        throw new Error(`Unexpected sign-in response: ${r.data.status}`);
    }
  }
  throw new Error('The sign-in code expired. Run npx jotbus login again.');
}

/** Revokes this machine's token on the server (best effort) and forgets it locally. */
export async function logout(): Promise<{ wasSignedIn: boolean; revoked: boolean }> {
  const a = readAccount();
  if (!a) return { wasSignedIn: false, revoked: false };
  let revoked = false;
  try {
    revoked = Boolean((await post<{ revoked: boolean }>(a.origin, 'logout', {}, a.token)).data.revoked);
  } catch {
    // offline: still forget it here; it can be revoked from the dashboard
  }
  rmSync(accountPath(), { force: true });
  return { wasSignedIn: true, revoked };
}

export async function whoami(): Promise<{ account: Account; email?: string; plan?: string; error?: string } | null> {
  const a = readAccount();
  if (!a) return null;
  const r = await post<{ email: string; plan: string }>(a.origin, 'whoami', {}, a.token);
  if (!r.ok) return { account: a, error: r.data.error ?? `HTTP ${r.status}` };
  return { account: a, email: r.data.email, plan: r.data.plan };
}
