import { execSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { addressedTo, formatDeliveries, type InboxMessage } from '../src/inbox.js';

const CLIENT = fileURLToPath(new URL('../dist/index.js', import.meta.url));
beforeAll(() => {
  execSync('node build.mjs', { cwd: fileURLToPath(new URL('..', import.meta.url)) });
});

const msg = (over: Partial<InboxMessage>): InboxMessage => ({
  message_id: 'msg_1', cursor: 1, author: 'claude-a', content: '', created_at: '2026-10-06T12:00:00Z', ...over,
});

describe('inbox filtering and formatting', () => {
  it('delivers whole-word @mentions of this agent, never its own messages, never twice', () => {
    const ms = [
      msg({ message_id: 'a', content: '@codex-b please review' }),
      msg({ message_id: 'b', content: 'hey @CODEX-B, you too' }),
      msg({ message_id: 'c', content: '@codex-bot is someone else' }),
      msg({ message_id: 'd', content: 'email me@codex-b.dev' }),
      msg({ message_id: 'e', content: 'no mention' }),
      msg({ message_id: 'f', author: 'codex-b', content: 'note to self @codex-b' }),
    ];
    expect(addressedTo('codex-b', ms).map((m) => m.message_id)).toEqual(['a', 'b']);
    expect(addressedTo('codex-b', ms, ['a']).map((m) => m.message_id)).toEqual(['b']);
  });

  it('labels deliveries as coming from other agents and lists attachments', () => {
    const text = formatDeliveries('codex-b', [{
      workspace: 'navy-heron',
      message: msg({ cursor: 7, content: '@codex-b logs attached', attachments: [{ file_id: 'file_x', name: 'server.log' }] }),
    }]);
    expect(text).toMatch(/not from the user/);
    expect(text).toContain('From @claude-a in workspace "navy-heron" (cursor 7');
    expect(text).toContain('server.log (get_file file_x)');
    expect(formatDeliveries('codex-b', [])).toBe('');
  });
});

describe('installing the hooks', () => {
  it('adds Claude Code hooks next to existing ones and removes only its own', () => {
    const home = mkdtempSync(join(tmpdir(), 'jotbus-hooks-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n'); // "claude mcp get jotbus" succeeds: registered
    chmodSync(join(bin, 'claude'), 0o755);
    mkdirSync(join(home, '.claude'));
    const settings = join(home, '.claude', 'settings.json');
    writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }));
    const run = (...args: string[]) => spawnSync(process.execPath, [CLIENT, ...args], {
      encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, JOTBUS_HOME: join(home, '.config', 'jotbus'), NO_COLOR: '1' },
    });
    expect(run('inbox', 'on').stdout).toMatch(/Claude Code picks up messages/);
    const on = JSON.parse(readFileSync(settings, 'utf8'));
    expect(on.theme).toBe('dark');
    expect(on.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/jotbus\.mjs" inbox --agent claude --event prompt --format claude$/);
    expect(on.hooks.PostToolUse).toHaveLength(2);
    run('inbox', 'on'); // idempotent
    expect(JSON.parse(readFileSync(settings, 'utf8')).hooks.PostToolUse).toHaveLength(2);
    run('inbox', 'off');
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ theme: 'dark', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } });
  });
});
