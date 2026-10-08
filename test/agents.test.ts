import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonAgent, readDeclined, writeDeclined } from '../src/agents.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'jotbus-agents-'));
const agentFor = (file: string, key = ['mcpServers']) =>
  jsonAgent({ id: 'x', name: 'X', file: () => file, key, entry: () => ({ command: 'npx', args: ['-y', 'jotbus@latest'] }), installed: () => true });

describe('config-file agents', () => {
  it('adds jotbus next to existing servers and settings, then removes only jotbus', () => {
    const file = join(tmp(), 'mcp.json');
    writeFileSync(file, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } }));
    const a = agentFor(file);
    expect(a.registered()).toBe(false);
    expect(a.add().ok).toBe(true);
    expect(a.registered()).toBe(true);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    expect(data).toEqual({ theme: 'dark', mcpServers: { other: { command: 'other' }, jotbus: { command: 'npx', args: ['-y', 'jotbus@latest'] } } });
    expect(a.remove().ok).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'dark', mcpServers: { other: { command: 'other' } } });
  });

  it('creates the file and nested keys when missing', () => {
    const file = join(tmp(), 'nested', 'settings.json');
    const a = agentFor(file, ['amp', 'mcpServers']);
    expect(a.add().ok).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).amp.mcpServers.jotbus.command).toBe('npx');
  });

  it("never rewrites a config it can't parse (e.g. comments); gives manual steps instead", () => {
    const file = join(tmp(), 'settings.json');
    const original = '{\n  // my settings\n  "context_servers": {}\n}\n';
    writeFileSync(file, original);
    const a = agentFor(file, ['context_servers']);
    const r = a.add();
    expect(r.ok).toBe(false);
    expect(r.manual).toContain('jotbus');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('remembers declined agents', () => {
    const file = join(tmp(), 'agents.json');
    expect(readDeclined(file)).toEqual([]);
    writeDeclined(file, ['codex', 'codex', 'gemini']);
    expect(readDeclined(file)).toEqual(['codex', 'gemini']);
  });
});
