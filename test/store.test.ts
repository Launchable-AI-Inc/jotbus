import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addWorkspace, isExpired, isGone, listWorkspaces, readStore, removeWorkspace, type StoredWorkspace } from '../src/store.js';

const entry = (over: Partial<StoredWorkspace> = {}): StoredWorkspace => ({
  workspace_id: 'ws_a', name: 'navy-heron', connection: 'jb_live_x.key', url: 'https://app.jotbus.com/mcp',
  temporary: true, expires_at: new Date(Date.now() + 3600e3).toISOString(), role: 'host', added_at: new Date().toISOString(), ...over,
});

describe('local workspace list', () => {
  const path = () => join(mkdtempSync(join(tmpdir(), 'jotbus-store-')), 'jotbus', 'workspaces.json');

  it('adds workspaces side by side and replaces one by id', () => {
    const p = path();
    addWorkspace(entry(), p);
    addWorkspace(entry({ workspace_id: 'ws_b', name: 'blue-meadow', role: 'guest' }), p);
    addWorkspace(entry({ connection: 'jb_live_y.key', role: 'guest' }), p); // same workspace joined again
    const list = readStore(p);
    expect(list.map((w) => w.name).sort()).toEqual(['blue-meadow', 'navy-heron']);
    expect(list.find((w) => w.workspace_id === 'ws_a')!.connection).toBe('jb_live_y.key');
  });

  it('is private to the user', () => {
    const p = path();
    addWorkspace(entry(), p);
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('removes by name or id', () => {
    const p = path();
    addWorkspace(entry(), p);
    addWorkspace(entry({ workspace_id: 'ws_b', name: 'blue-meadow' }), p);
    expect(removeWorkspace('Navy-Heron', p).map((w) => w.name)).toEqual(['navy-heron']);
    expect(removeWorkspace('ws_b', p)).toHaveLength(1);
    expect(removeWorkspace('nothing', p)).toEqual([]);
    expect(readStore(p)).toEqual([]);
  });

  it('forgets temporary workspaces a while after they expire, never persistent ones', () => {
    const p = path();
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
    addWorkspace(entry({ workspace_id: 'ws_old', name: 'old-one', expires_at: hoursAgo(3) }), p);
    addWorkspace(entry({ workspace_id: 'ws_recent', name: 'recent-one', expires_at: hoursAgo(0.5) }), p);
    addWorkspace(entry({ workspace_id: 'ws_keep', name: 'kept-one', temporary: false, expires_at: null, role: 'account' }), p);
    expect(listWorkspaces(p).map((w) => w.name).sort()).toEqual(['kept-one', 'recent-one']);
    expect(readStore(p)).toHaveLength(2);
    const recent = readStore(p).find((w) => w.name === 'recent-one')!;
    expect(isExpired(recent)).toBe(true);
    expect(isGone(recent)).toBe(false);
  });

  it('treats a missing or corrupt file as empty', () => {
    expect(readStore(join(tmpdir(), 'does-not-exist', 'workspaces.json'))).toEqual([]);
  });
});
