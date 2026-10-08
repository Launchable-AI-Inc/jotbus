// End-to-end encryption for Jotbus workspaces. Shared by the dashboard (browser) and jotbus (Node).
// Uses the audited, dependency-free @noble libraries rather than WebCrypto's crypto.subtle, which browsers only
// expose on HTTPS/localhost. Randomness still comes from the platform CSPRNG (crypto.getRandomValues).
//
//   workspace key   32 random bytes, generated in the browser, never sent to the server (base64url, 43 chars)
//   enc key         HKDF-SHA256(key, info "agentpad/v1/enc")   -> AES-256-GCM
//   check key       HKDF-SHA256(key, info "agentpad/v1/check") -> HMAC-SHA256("agentpad/v1/key-check")
//                   = key_check, stored server-side so clients can verify a key without revealing it
//   envelope        "ape1." + b64url(iv, 12 bytes) + "." + b64url(AES-GCM(JSON {c, m?}))
//                   with AAD "agentpad/v1/" + workspace id, binding each ciphertext to its workspace
//   connection str  "<jb_live_ token>.<workspace key>". Agents get one string; the client splits it and
//                   only ever sends the token part to the server.
//   file blob       "JBF1" + iv (12) + AES-256-GCM(file bytes) under a random per-file key, AAD "jotbus/v1/file/" +
//                   workspace id. The file key, name, type, size and plaintext hash travel in an envelope encrypted for
//                   "<workspace id>/file" (envelope encryption): storage only ever sees ciphertext of N bytes, and rotating
//                   the workspace key re-encrypts the small envelopes while blobs stay as they are.

import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Wire-format identifiers ("ape1", "agentpad/v1/…") predate the Jotbus name. They are frozen protocol constants:
// changing them would make every existing encrypted message unreadable. Bump the version instead.

const te = new TextEncoder();
const td = new TextDecoder();

export const ENVELOPE_PREFIX = 'ape1';
const ENVELOPE_RE = /^ape1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = /^jb_live_[A-Za-z0-9]{40}$/;

export interface Payload {
  /** content */
  c: string;
  /** metadata */
  m?: Record<string, unknown>;
  /** author: kept inside the ciphertext so the server can't see which agent/machine wrote what */
  a?: string;
}

export function toB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function generateKey(): string {
  return toB64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export const isKey = (s: string) => KEY_RE.test(s);
export const isEnvelope = (s: unknown): s is string => typeof s === 'string' && ENVELOPE_RE.test(s);

/** Parses "jb_live_…" or "jb_live_….<key>". Also accepts a bare key (for unlocking the dashboard). */
export function parseConnectionString(input: string): { token: string | null; key: string | null } {
  const s = input.trim();
  if (isKey(s)) return { token: null, key: s };
  const [token, key, ...rest] = s.split('.');
  if (!TOKEN_RE.test(token) || rest.length || (key !== undefined && !isKey(key))) {
    throw new Error('Not a valid Jotbus token or connection string');
  }
  return { token, key: key ?? null };
}

export const connectionString = (token: string, key: string) => `${token}.${key}`;

export interface WorkspaceCipher {
  /** key_check value for this key; compare with the workspace's to verify the key. */
  check: string;
  encrypt(workspaceId: string, payload: Payload): Promise<string>;
  decrypt(workspaceId: string, envelope: string): Promise<Payload>;
}

/** What a file's encrypted metadata envelope holds. */
export interface FileMeta {
  name: string;
  type: string;
  size: number;
  /** hex SHA-256 of the plaintext, checked after decryption */
  sha256: string;
  /** the file's own key (base64url); only ever stored inside this encrypted envelope */
  key: string;
}

const FILE_MAGIC = te.encode('JBF1');
const fileAad = (workspaceId: string) => te.encode(`jotbus/v1/file/${workspaceId}`);

/** Encrypts a file under a fresh random key. Keep the key in the file's metadata envelope. */
export function encryptFile(workspaceId: string, data: Uint8Array): { blob: Uint8Array; key: string } {
  const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = gcm(key, iv, fileAad(workspaceId)).encrypt(data);
  const blob = new Uint8Array(FILE_MAGIC.length + 12 + ct.length);
  blob.set(FILE_MAGIC, 0);
  blob.set(iv, 4);
  blob.set(ct, 16);
  return { blob, key: toB64url(key) };
}

/** Decrypts a blob from encryptFile. Throws if it was tampered with, or belongs to another workspace. */
export function decryptFile(workspaceId: string, blob: Uint8Array, key: string): Uint8Array {
  if (blob.length < 16 + 16 || FILE_MAGIC.some((b, i) => blob[i] !== b)) throw new Error('Not an encrypted Jotbus file');
  return gcm(fromB64url(key), blob.subarray(4, 16), fileAad(workspaceId)).decrypt(blob.subarray(16));
}

export const sha256Hex = (data: Uint8Array) => Array.from(sha256(data), (b) => b.toString(16).padStart(2, '0')).join('');

export const encryptFileMeta = (cipher: WorkspaceCipher, workspaceId: string, meta: FileMeta) =>
  cipher.encrypt(`${workspaceId}/file`, { c: meta.name, m: { type: meta.type, size: meta.size, sha256: meta.sha256, key: meta.key } });

export async function decryptFileMeta(cipher: WorkspaceCipher, workspaceId: string, envelope: string): Promise<FileMeta> {
  const p = await cipher.decrypt(`${workspaceId}/file`, envelope);
  const m = (p.m ?? {}) as { type?: unknown; size?: unknown; sha256?: unknown; key?: unknown };
  return {
    name: p.c, type: String(m.type ?? 'application/octet-stream'), size: Number(m.size ?? 0),
    sha256: String(m.sha256 ?? ''), key: String(m.key ?? ''),
  };
}

export async function createCipher(key: string): Promise<WorkspaceCipher> {
  if (!isKey(key)) throw new Error('Invalid workspace key');
  const ikm = fromB64url(key);
  const salt = new Uint8Array(32);
  const enc = hkdf(sha256, ikm, salt, te.encode('agentpad/v1/enc'), 32);
  const mac = hkdf(sha256, ikm, salt, te.encode('agentpad/v1/check'), 32);
  const check = toB64url(hmac(sha256, mac, te.encode('agentpad/v1/key-check')));
  const aad = (workspaceId: string) => te.encode(`agentpad/v1/${workspaceId}`);

  return {
    check,
    async encrypt(workspaceId, payload) {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = gcm(enc, iv, aad(workspaceId)).encrypt(te.encode(JSON.stringify(payload)));
      return `${ENVELOPE_PREFIX}.${toB64url(iv)}.${toB64url(ct)}`;
    },
    async decrypt(workspaceId, envelope) {
      const m = ENVELOPE_RE.exec(envelope);
      if (!m) throw new Error('Not an encrypted message');
      const pt = gcm(enc, fromB64url(m[1]), aad(workspaceId)).decrypt(fromB64url(m[2]));
      const payload = JSON.parse(td.decode(pt)) as Payload;
      if (typeof payload?.c !== 'string') throw new Error('Malformed message');
      return payload;
    },
  };
}

export async function keyCheck(key: string): Promise<string> {
  return (await createCipher(key)).check;
}

/** The workspace's setup token is stored server-side encrypted under the workspace key (domain-separated AAD). */
export const encryptSetupToken = (cipher: WorkspaceCipher, workspaceId: string, token: string) =>
  cipher.encrypt(`${workspaceId}/setup-token`, { c: token });

export const decryptSetupToken = async (cipher: WorkspaceCipher, workspaceId: string, envelope: string) =>
  (await cipher.decrypt(`${workspaceId}/setup-token`, envelope)).c;

// Invites for temporary workspaces: "jb1_<24-char invite secret>.<workspace key>". Only the part before the "." is
// ever sent to the server (it is exchanged for a per-client access token); the key stays with the recipient.
const INVITE_RE = /jb1_([A-Za-z0-9]{24})\.([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;

export const formatInvite = (inviteSecret: string, key: string) => `${inviteSecret}.${key}`;

/** Accepts a bare invite or anything containing one (e.g. an https://app.jotbus.com/join#… link). */
export function parseInvite(input: string): { invite: string; key: string } | null {
  const m = INVITE_RE.exec(input.trim());
  return m ? { invite: `jb1_${m[1]}`, key: m[2] } : null;
}
