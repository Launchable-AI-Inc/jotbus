import { describe, expect, it } from 'vitest';
import {
  createCipher, decryptFile, encryptFile, formatInvite, generateKey, isEnvelope, parseConnectionString, parseInvite,
} from '../src/e2e.js';

describe('end-to-end encryption', () => {
  it('round-trips a message, author included, with the workspace key', async () => {
    const c = await createCipher(generateKey());
    const env = await c.encrypt('ws_a', { c: 'the plan', a: 'claude-macbook' });
    expect(isEnvelope(env)).toBe(true);
    expect(env).not.toContain('the plan');
    expect(env).not.toContain('claude-macbook');
    expect(await c.decrypt('ws_a', env)).toMatchObject({ c: 'the plan', a: 'claude-macbook' });
  });

  it('uses a fresh nonce every time', async () => {
    const c = await createCipher(generateKey());
    expect(await c.encrypt('ws_a', { c: 'same' })).not.toBe(await c.encrypt('ws_a', { c: 'same' }));
  });

  it('fails with another key, in another workspace, or after tampering', async () => {
    const key = generateKey();
    const c = await createCipher(key);
    const env = await c.encrypt('ws_a', { c: 'secret' });
    await expect((await createCipher(generateKey())).decrypt('ws_a', env)).rejects.toThrow();
    await expect(c.decrypt('ws_b', env)).rejects.toThrow(); // bound to its workspace
    const flipped = env.slice(0, -2) + (env.endsWith('A') ? 'BA' : 'AA');
    await expect(c.decrypt('ws_a', flipped)).rejects.toThrow();
  });

  it('has a stable key check per key that differs between keys and does not contain the key', async () => {
    const key = generateKey();
    const a = await createCipher(key);
    const b = await createCipher(key);
    expect(a.check).toBe(b.check);
    expect(a.check).not.toBe((await createCipher(generateKey())).check);
    expect(a.check).not.toContain(key);
  });

  it('keeps the key out of what is sent: invites and connection strings carry it after the dot', () => {
    const key = generateKey();
    const invite = formatInvite('jb1_' + 'a'.repeat(24), key);
    expect(parseInvite(invite)).toEqual({ invite: 'jb1_' + 'a'.repeat(24), key });
    expect(parseInvite('jb1_' + 'a'.repeat(24))).toBeNull(); // no key, no join
    const conn = `jb_live_${'b'.repeat(40)}.${key}`;
    expect(parseConnectionString(conn)).toEqual({ token: `jb_live_${'b'.repeat(40)}`, key });
  });

  it('encrypts files with their own key, bound to the workspace', () => {
    const data = new TextEncoder().encode('log line\n'.repeat(100));
    const { blob, key } = encryptFile('ws_a', data);
    expect(Buffer.from(blob).includes(Buffer.from('log line'))).toBe(false);
    expect(Buffer.from(decryptFile('ws_a', blob, key)).equals(Buffer.from(data))).toBe(true);
    expect(() => decryptFile('ws_b', blob, key)).toThrow();
  });
});
