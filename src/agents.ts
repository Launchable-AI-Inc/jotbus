// The coding agents `npx jotbus` can register its MCP server with. Registration is machine-wide and holds no secret:
// every agent runs `npx -y jotbus@latest`, which serves all workspaces on this machine (store.ts).
// Two kinds of adapter: the agent's own CLI (preferred), or a careful edit of its JSON config file.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export interface Outcome {
  ok: boolean;
  /** What the user can do by hand when we couldn't (or shouldn't) do it automatically. */
  manual?: string;
}

/** Passive delivery: hooks that add messages addressed to this agent to its context while it works. */
export interface InboxHooks {
  has(): boolean;
  add(): Outcome;
  remove(): Outcome;
  /** Shown once after installing, if the agent needs a one-time step (e.g. trusting new hooks). */
  note?: string;
}

export interface AgentAdapter {
  /** Short id for `--agents`. */
  id: string;
  name: string;
  installed(): boolean;
  registered(): boolean;
  add(): Outcome;
  remove(): Outcome;
  /** How to add it by hand. */
  manual(): string;
  /** Shown after adding, e.g. "restart Cursor". */
  after?: string;
  inbox?: InboxHooks;
}

const win = process.platform === 'win32';
const home = homedir();

/** The MCP server every agent launches. */
export const SERVER_ARGS = ['-y', 'jotbus@latest'];
const server = { command: 'npx', args: SERVER_ARGS };
const serverCmdline = `npx ${SERVER_ARGS.join(' ')}`;

const run = (bin: string, args: string[]) =>
  spawnSync(bin, args, { stdio: 'pipe', encoding: 'utf8', timeout: 30000, shell: win });

/** Is `bin` on PATH? (No process spawn: some agents are slow to start.) */
export function onPath(bin: string): boolean {
  const exts = win ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, bin + ext), win ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

/** Per-OS application-support directory (macOS Library/Application Support, Windows %APPDATA%, Linux ~/.config). */
export function appData(): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support');
  if (win) return process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME ?? join(home, '.config');
}

// ---------------------------------------------------------------------------
// JSON config files
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Reads a JSON config. Returns null if it exists but isn't plain JSON (e.g. has comments), so we never mangle it. */
function readJson(path: string): Json | null {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

function writeJson(path: string, data: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.jotbus-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

function child(obj: Json, key: string): Json {
  const v = obj[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json;
  const fresh: Json = {};
  obj[key] = fresh;
  return fresh;
}

interface JsonAgentSpec {
  id: string;
  name: string;
  /** Config file to edit. */
  file: () => string;
  /** Path to the object holding servers, e.g. ['mcpServers']. */
  key: string[];
  /** The entry to write for jotbus. */
  entry: () => Json;
  installed: () => boolean;
  after?: string;
}

export function jsonAgent(spec: JsonAgentSpec): AgentAdapter {
  const servers = (data: Json) => spec.key.reduce(child, data);
  const manual = () =>
    `add to ${spec.file()} under ${spec.key.map((k) => `"${k}"`).join(' → ')}: "jotbus": ${JSON.stringify(spec.entry())}`;
  return {
    id: spec.id,
    name: spec.name,
    after: spec.after,
    installed: spec.installed,
    manual,
    registered() {
      const data = readJson(spec.file());
      if (data === null) return /"jotbus"\s*:/.test(readFileSync(spec.file(), 'utf8'));
      let node: unknown = data;
      for (const k of spec.key) node = node && typeof node === 'object' ? (node as Json)[k] : undefined;
      return Boolean(node && typeof node === 'object' && 'jotbus' in (node as Json));
    },
    add() {
      const data = readJson(spec.file());
      if (data === null) return { ok: false, manual: manual() };
      servers(data).jotbus = spec.entry();
      writeJson(spec.file(), data);
      return { ok: true };
    },
    remove() {
      const data = readJson(spec.file());
      if (data === null) return { ok: false, manual: `remove "jotbus" from ${spec.file()}` };
      delete servers(data).jotbus;
      writeJson(spec.file(), data);
      return { ok: true };
    },
  };
}

/** Does a JSON config have `jotbus` under this key path? Falls back to a text search for files with comments. */
function jsonHas(file: string, key: string[]): boolean {
  if (!existsSync(file)) return false;
  const data = readJson(file);
  if (data === null) return /"jotbus"\s*:/.test(readFileSync(file, 'utf8'));
  let node: unknown = data;
  for (const k of key) node = node && typeof node === 'object' ? (node as Json)[k] : undefined;
  return Boolean(node && typeof node === 'object' && 'jotbus' in (node as Json));
}

interface CliAgentSpec {
  id: string;
  name: string;
  bin: string;
  /** Arguments for `<bin> …` that add the server; the server command is appended. */
  addArgs: string[];
  /** Whether the server command goes after a `--` separator. */
  dashDash: boolean;
  removeArgs: string[];
  /** Where the agent stores it, for a fast check without starting the agent. */
  file: () => string;
  key: string[];
  after?: string;
  inbox?: InboxHooks;
}

/** An agent with its own `mcp add` / `mcp remove` commands (all verified by running them). */
function cliAgent(spec: CliAgentSpec): AgentAdapter {
  const cmd = [...spec.addArgs, ...(spec.dashDash ? ['--'] : []), server.command, ...server.args];
  return {
    id: spec.id,
    name: spec.name,
    after: spec.after,
    inbox: spec.inbox,
    installed: () => onPath(spec.bin),
    registered: () => jsonHas(spec.file(), spec.key),
    add: () => ({ ok: run(spec.bin, cmd).status === 0 }),
    remove: () => ({ ok: run(spec.bin, spec.removeArgs).status === 0 }),
    manual: () => `${spec.bin} ${[...spec.addArgs, ...(spec.dashDash ? ['--'] : [])].join(' ')} ${serverCmdline}`,
  };
}

const exists = (...p: string[]) => existsSync(join(...p));

// ---------------------------------------------------------------------------
// Passive delivery hooks
// ---------------------------------------------------------------------------

/** A copy of this client next to the workspace list, so hooks start in milliseconds (no npx lookup per prompt). */
export const clientCopyPath = () => join(dirname(process.env.JOTBUS_HOME ? join(process.env.JOTBUS_HOME, 'x') : join(home, '.config', 'jotbus', 'x')), 'bin', 'jotbus.mjs');

/** Refreshes the local client copy from the running script (npx cache or a local build). Best effort. */
export function installClientCopy(): void {
  try {
    const src = process.argv[1];
    if (!src || !existsSync(src)) return;
    const body = readFileSync(src);
    const dest = clientCopyPath();
    if (existsSync(dest) && readFileSync(dest).equals(body)) return;
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, dest);
  } catch {
    // hooks will fall back to whatever copy exists
  }
}

/** Our hook commands contain both of these (checked separately: serialized JSON escapes the quote between them). */
const ours = (text: string) => text.includes('jotbus.mjs') && text.includes(' inbox --agent ');
const hookCommand = (kind: string, event: 'prompt' | 'tool', format: string) =>
  `node "${clientCopyPath()}" inbox --agent ${kind} --event ${event} --format ${format}`;
const isOurs = (entry: unknown) => ours(JSON.stringify(entry));

/** Hooks in a settings file shaped like Claude Code's: { hooks: { Event: [ { matcher?, hooks: [ { type, command, timeout } ] } ] } }. */
function jsonHooks(spec: {
  file: () => string;
  kind: string;
  format: string;
  events: { prompt: string; tool: string };
  timeout: number;
  note?: string;
}): InboxHooks {
  const groups = (data: Json, event: string) => {
    const hooks = child(data, 'hooks');
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    return hooks[event] as unknown[];
  };
  return {
    note: spec.note,
    has() {
      const data = readJson(spec.file());
      if (data === null) return existsSync(spec.file()) && ours(readFileSync(spec.file(), 'utf8'));
      return ours(JSON.stringify(data));
    },
    add() {
      const data = readJson(spec.file());
      if (data === null) return { ok: false, manual: `add Jotbus inbox hooks to ${spec.file()} (it has comments, so we won't rewrite it)` };
      for (const [event, name] of [['prompt', spec.events.prompt], ['tool', spec.events.tool]] as const) {
        const list = groups(data, name);
        if (list.some(isOurs)) continue;
        list.push({
          ...(event === 'tool' ? { matcher: '*' } : {}),
          hooks: [{ type: 'command', command: hookCommand(spec.kind, event, spec.format), timeout: spec.timeout }],
        });
      }
      writeJson(spec.file(), data);
      return { ok: true };
    },
    remove() {
      const data = readJson(spec.file());
      if (data === null) return { ok: false, manual: `remove the Jotbus inbox hooks from ${spec.file()}` };
      const hooks = data.hooks as Json | undefined;
      if (hooks) {
        for (const name of [spec.events.prompt, spec.events.tool]) {
          if (Array.isArray(hooks[name])) {
            hooks[name] = (hooks[name] as unknown[]).filter((g) => !isOurs(g));
            if (!(hooks[name] as unknown[]).length) delete hooks[name];
          }
        }
        if (!Object.keys(hooks).length) delete data.hooks;
      }
      writeJson(spec.file(), data);
      return { ok: true };
    },
  };
}

/** opencode: an in-process plugin. At a prompt the mail is attached to the user message; after tool calls, to the tool result. */
const opencodePlugin = () => [
  '// Jotbus passive delivery (written by npx jotbus; remove with: npx jotbus inbox off).',
  "// Messages addressed to this agent are added to its context while it works. Nothing runs while it's idle.",
  "import { execFile } from 'node:child_process';",
  'const GAP = String.fromCharCode(10, 10);',
  `const run = (event) => new Promise((resolve) => execFile('node', [${JSON.stringify(clientCopyPath())}, 'inbox', '--agent', 'opencode', '--event', event, '--format', 'text'],`,
  "  { timeout: 10000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim())));",
  'export const JotbusInbox = async () => {',
  '  return {',
  '    // At a prompt: attach the messages to the user message as an extra (synthetic) text part.',
  "    'chat.message': async (input, output) => {",
  "      const t = await run('prompt');",
  "      if (t) output.parts.push({ id: 'prt_jotbus' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), sessionID: input.sessionID, messageID: output.message.id, type: 'text', text: t, synthetic: true });",
  '    },',
  '    // After a tool call: append them to the tool result the model reads next.',
  "    'tool.execute.after': async (_input, output) => { const t = await run('tool'); if (t && typeof output.output === 'string') output.output += GAP + t; },",
  '  };',
  '};',
  '',
].join('\n');

function opencodeInbox(): InboxHooks {
  const dir = () => join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode', 'plugins');
  const file = () => join(dir(), 'jotbus-inbox.js');
  return {
    has: () => existsSync(file()),
    add() {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(file(), opencodePlugin());
      return { ok: true };
    },
    remove() {
      try { rmSync(file(), { force: true }); } catch { /* already gone */ }
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// The agents
// ---------------------------------------------------------------------------

const opencodeDir = () => join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode');
const opencodeFiles = () => ['opencode.json', 'opencode.jsonc', 'config.json'].map((f) => join(opencodeDir(), f));

export const AGENTS: AgentAdapter[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    installed: () => onPath('claude'),
    registered: () => run('claude', ['mcp', 'get', 'jotbus']).status === 0,
    add: () => ({ ok: run('claude', ['mcp', 'add', '--scope', 'user', 'jotbus', '--', server.command, ...server.args]).status === 0 }),
    remove: () => ({ ok: run('claude', ['mcp', 'remove', 'jotbus', '--scope', 'user']).status === 0 }),
    manual: () => `claude mcp add --scope user jotbus -- ${serverCmdline}`,
    inbox: jsonHooks({
      file: () => join(home, '.claude', 'settings.json'), kind: 'claude', format: 'claude',
      events: { prompt: 'UserPromptSubmit', tool: 'PostToolUse' }, timeout: 10,
    }),
  },
  {
    id: 'codex',
    name: 'Codex',
    installed: () => onPath('codex'),
    registered: () => /^jotbus\b/m.test(run('codex', ['mcp', 'list']).stdout ?? ''),
    add: () => ({ ok: run('codex', ['mcp', 'add', 'jotbus', '--', server.command, ...server.args]).status === 0 }),
    remove: () => ({ ok: run('codex', ['mcp', 'remove', 'jotbus']).status === 0 }),
    manual: () => `codex mcp add jotbus -- ${serverCmdline}`,
    inbox: jsonHooks({
      file: () => join(process.env.CODEX_HOME ?? join(home, '.codex'), 'hooks.json'), kind: 'codex', format: 'codex',
      events: { prompt: 'UserPromptSubmit', tool: 'PostToolUse' }, timeout: 10,
      note: 'Codex asks you to trust new hooks once: run /hooks in Codex',
    }),
  },
  {
    id: 'opencode',
    name: 'opencode',
    installed: () => onPath('opencode'),
    // `opencode mcp list` starts every server, so read its global config instead.
    registered: () => opencodeFiles().some((f) => existsSync(f) && /"jotbus"\s*:/.test(readFileSync(f, 'utf8'))),
    add: () => ({ ok: run('opencode', ['mcp', 'add', 'jotbus', '--', server.command, ...server.args]).status === 0 }),
    remove: () => {
      // No `opencode mcp remove`; edit the config only if it's plain JSON (it may have comments).
      for (const f of opencodeFiles().filter(existsSync)) {
        const data = readJson(f);
        if (data === null) return { ok: false, manual: `remove "jotbus" under "mcp" in ${f}` };
        const mcp = data.mcp as Json | undefined;
        if (mcp && 'jotbus' in mcp) {
          delete mcp.jotbus;
          writeJson(f, data);
        }
      }
      return { ok: true };
    },
    manual: () => `opencode mcp add jotbus -- ${serverCmdline}`,
    inbox: opencodeInbox(),
  },
  cliAgent({
    id: 'gemini', name: 'Gemini CLI', bin: 'gemini',
    // Default scope is the project, so --scope user; the command is a positional (no `--`).
    addArgs: ['mcp', 'add', '--scope', 'user', 'jotbus'], dashDash: false,
    removeArgs: ['mcp', 'remove', '--scope', 'user', 'jotbus'],
    file: () => join(home, '.gemini', 'settings.json'), key: ['mcpServers'],
    inbox: jsonHooks({
      file: () => join(home, '.gemini', 'settings.json'), kind: 'gemini', format: 'gemini',
      events: { prompt: 'BeforeAgent', tool: 'AfterTool' }, timeout: 10_000, // Gemini timeouts are milliseconds
    }),
  }),
  cliAgent({
    id: 'qwen', name: 'Qwen Code', bin: 'qwen',
    addArgs: ['mcp', 'add', '--scope', 'user', 'jotbus'], dashDash: false,
    removeArgs: ['mcp', 'remove', '--scope', 'user', 'jotbus'],
    file: () => join(home, '.qwen', 'settings.json'), key: ['mcpServers'],
  }),
  cliAgent({
    id: 'copilot', name: 'GitHub Copilot CLI', bin: 'copilot',
    addArgs: ['mcp', 'add', 'jotbus'], dashDash: true, removeArgs: ['mcp', 'remove', 'jotbus'],
    file: () => join(process.env.COPILOT_HOME ?? join(home, '.copilot'), 'mcp-config.json'), key: ['mcpServers'],
  }),
  cliAgent({
    id: 'amp', name: 'Amp', bin: 'amp',
    addArgs: ['mcp', 'add', 'jotbus'], dashDash: true, removeArgs: ['mcp', 'remove', 'jotbus'],
    file: () => join(home, '.config', 'amp', 'settings.json'), key: ['amp.mcpServers'],
  }),
  cliAgent({
    id: 'auggie', name: 'Augment (Auggie)', bin: 'auggie',
    addArgs: ['mcp', 'add', 'jotbus'], dashDash: true, removeArgs: ['mcp', 'remove', 'jotbus'],
    file: () => join(home, '.augment', 'settings.json'), key: ['mcpServers'],
  }),
  // Desktop and IDE apps without an `mcp add` command: edit their documented config file.
  jsonAgent({
    id: 'cursor', name: 'Cursor', key: ['mcpServers'],
    file: () => join(home, '.cursor', 'mcp.json'),
    entry: () => ({ type: 'stdio', ...server }),
    installed: () => exists(home, '.cursor') || onPath('cursor') || onPath('cursor-agent'),
    after: 'Cursor and its CLI share this setting; reload Cursor if it is open',
  }),
  jsonAgent({
    id: 'claude-desktop', name: 'Claude Desktop', key: ['mcpServers'],
    file: () => join(appData(), 'Claude', 'claude_desktop_config.json'),
    entry: () => ({ ...server }),
    // No official Linux build.
    installed: () => process.platform !== 'linux' && exists(appData(), 'Claude'),
    after: 'quit and reopen Claude Desktop',
  }),
  jsonAgent({
    id: 'windsurf', name: 'Windsurf / Devin Desktop', key: ['mcpServers'],
    // Renamed in 2026: prefer the new location, fall back to the legacy one if that's what's installed.
    file: () => {
      const devin = win ? join(appData(), 'devin') : join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'devin');
      const legacy = join(home, '.codeium', 'windsurf');
      return join(existsSync(devin) || !existsSync(legacy) ? devin : legacy, 'mcp_config.json');
    },
    entry: () => ({ ...server }),
    installed: () =>
      exists(home, '.codeium', 'windsurf') || existsSync(win ? join(appData(), 'devin') : join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'devin')),
    after: 'restart it if it is open',
  }),
  jsonAgent({
    id: 'kiro', name: 'Kiro', key: ['mcpServers'],
    file: () => join(home, '.kiro', 'settings', 'mcp.json'),
    entry: () => ({ ...server }),
    installed: () => exists(home, '.kiro') || onPath('kiro-cli'),
  }),
  jsonAgent({
    id: 'junie', name: 'JetBrains Junie', key: ['mcpServers'],
    file: () => join(home, '.junie', 'mcp', 'mcp.json'),
    entry: () => ({ ...server }),
    installed: () => exists(home, '.junie') || onPath('junie'),
  }),
];

/** Supported only by hand for now (config formats we won't edit automatically yet). */
export const MANUAL_ONLY = [
  'Zed (context_servers in its settings.json)',
  'Goose (extensions in config.yaml)',
  'VS Code (code --add-mcp)',
  'Cline, Continue, Crush, Factory Droid',
];

export const agentById = (id: string) => AGENTS.find((a) => a.id === id.trim().toLowerCase());

// ---------------------------------------------------------------------------
// Remembered choices: agents the user chose not to connect aren't pre-selected again.
// ---------------------------------------------------------------------------

export function readDeclined(path: string): string[] {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as { declined?: unknown };
    return Array.isArray(v.declined) ? v.declined.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeDeclined(path: string, declined: string[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ declined: [...new Set(declined)].sort() }, null, 2)}\n`);
}
