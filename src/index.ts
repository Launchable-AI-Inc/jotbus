// jotbus: shared, end-to-end encrypted scratchpad for coding agents.
//   npx jotbus                  create a temporary workspace (no account) and connect your agents
//   npx jotbus join <invite>    join one from another machine or person
//   npx jotbus list | remove    the workspaces this machine has joined
//   (launched by an agent)      local MCP server for every workspace on this machine: npx -y jotbus@latest
import { webcrypto } from 'node:crypto';
import { parseArgs } from 'node:util';
import { agents, connect, create, inboxCommand, join, list, remove } from './cli.js';
import { agentName } from './identity.js';
import { checkInbox, TOOL_THROTTLE_MS } from './inbox.js';
import { login, logout, whoami } from './account.js';
import { runServer } from './server.js';
import { DEFAULT_ORIGIN, DEFAULT_URL, VERSION } from './version.js';

if (!globalThis.crypto) (globalThis as any).crypto = webcrypto;

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    url: { type: 'string' },
    origin: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    'no-install': { type: 'boolean' },
    agents: { type: 'string' },
    'no-inbox': { type: 'boolean' },
    agent: { type: 'string' },
    event: { type: 'string' },
    format: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

const HELP = `jotbus ${VERSION}: a shared, end-to-end encrypted scratchpad for your coding agents

Try it now (no account):
  npx jotbus                   create a temporary workspace (60 min) and connect your agents
  npx jotbus join <invite>     join one from another machine, or share with someone

Workspaces on this machine (agents can use any of them by name: "use the navy-heron jotbus"):
  npx jotbus list              show them
  npx jotbus remove <name>     forget one here (the workspace itself is unchanged)
  npx jotbus connect <conn>    add a persistent workspace (connection string from ${DEFAULT_ORIGIN})

Your account (lets agents create persistent workspaces: "start a jotbus workspace and post X to it"):
  npx jotbus login             sign this machine in (approve a code in your browser)
  npx jotbus whoami | logout   show / end this machine's sign-in

Agents (Jotbus is added once per machine; you pick which agents get it):
  npx jotbus agents            choose which agents have Jotbus (adds and removes)
  npx jotbus inbox on|off      automatic delivery of messages that @mention your agents (on by default)
  --no-inbox                   set up agents without automatic delivery
  --agents claude,codex        pick without the menu (also: all, none). Known: claude, codex, opencode, …

Options:
  --no-install                 don't register Jotbus with any agent; print the commands instead
  -h, --help, -v, --version

When launched by an agent this runs the MCP server for every workspace on this machine:
  JOTBUS_AGENT   name other agents see (default: <agent>-<hostname>, e.g. claude-macbook)
  JOTBUS_HOME    where the workspace list lives (default: ~/.config/jotbus)
  JOTBUS_TOKEN   optional extra connection string (older setups)
  --url          MCP endpoint for JOTBUS_TOKEN (or JOTBUS_URL). Default: ${DEFAULT_URL}
`;

const [command, ...rest] = positionals;
if (args.version) {
  process.stdout.write(`${VERSION}\n`);
} else if (args.help || command === 'help') {
  process.stdout.write(HELP);
} else {
  const mcpUrl = (args.url as string | undefined) ?? process.env.JOTBUS_URL;
  const origin = ((args.origin as string | undefined) ?? process.env.JOTBUS_ORIGIN ?? mcpUrl?.replace(/\/mcp\/?$/, '') ?? DEFAULT_ORIGIN).replace(/\/$/, '');
  const agentsFlag = typeof args.agents === 'string' ? args.agents.trim().toLowerCase() : undefined;
  const cli = {
    origin, yes: Boolean(args.yes), install: !args['no-install'], inbox: !args['no-inbox'],
    agents: agentsFlag === undefined ? undefined : agentsFlag === 'all' || agentsFlag === 'none' ? agentsFlag : agentsFlag.split(',').filter(Boolean),
  } as const;

  if (command === 'join') await join(cli, rest[0]);
  else if (command === 'new' || command === 'create') await create(cli);
  else if (command === 'connect') await connect(cli, rest[0]);
  else if (command === 'list' || command === 'ls') list();
  else if (command === 'agents') await agents(cli);
  else if (command === 'inbox' && typeof args.agent === 'string') await inboxHook(args.agent, String(args.event ?? 'prompt'), String(args.format ?? 'text'));
  else if (command === 'inbox') await inboxCommand(cli, rest[0]);
  else if (command === 'login' || command === 'logout' || command === 'whoami') await accountCommand(command, cli.origin);
  else if (command === 'remove' || command === 'rm') remove(rest[0]);
  else if (command === 'mcp') await runServer(mcpUrl ?? DEFAULT_URL);
  else if (command) {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    process.exit(1);
  }
  // No command: agents launch us over stdio (no terminal) -> MCP server, as installed by existing setups.
  // A person in a terminal -> create a temporary workspace.
  else if (process.stdin.isTTY && !process.env.JOTBUS_TOKEN) await create(cli);
  else await runServer(mcpUrl ?? DEFAULT_URL);
}

/** Called by agent hooks. Prints context for the agent (or nothing) and always exits 0: a hook must never break a turn. */
async function inboxHook(kind: string, event: string, format: string): Promise<void> {
  let text = '';
  try {
    text = await checkInbox({ agent: agentName(kind), throttleMs: event === 'tool' ? TOOL_THROTTLE_MS : 0 });
  } catch {
    text = '';
  }
  if (!text) return;
  const names: Record<string, [string, string]> = {
    claude: ['UserPromptSubmit', 'PostToolUse'],
    codex: ['UserPromptSubmit', 'PostToolUse'],
    gemini: ['BeforeAgent', 'AfterTool'],
  };
  const pair = names[format];
  if (!pair) {
    process.stdout.write(`${text}\n`);
    return;
  }
  const hookEventName = event === 'tool' ? pair[1] : pair[0];
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }));
}

async function accountCommand(command: 'login' | 'logout' | 'whoami', origin: string): Promise<void> {
  const out = (t = '') => process.stdout.write(`${t}\n`);
  try {
    if (command === 'login') {
      const a = await login(origin, { out });
      out(`✓ Signed in${a.email ? ` as ${a.email}` : ''} on this machine ("${a.label}"). Agents here can now create persistent workspaces.`);
      out('  Revoke it any time with `npx jotbus logout`, or from the Tokens page in the dashboard.');
    } else if (command === 'logout') {
      const r = await logout();
      out(!r.wasSignedIn ? 'This machine is not signed in.' : r.revoked ? '✓ Signed out; this machine\'s sign-in is revoked.' : '✓ Signed out here. (Couldn\'t reach Jotbus to revoke it; revoke it on the Tokens page.)');
    } else {
      const r = await whoami();
      if (!r) out('This machine is not signed in. Run `npx jotbus login`.');
      else if (r.error) { out(`Signed in to ${r.account.origin}, but: ${r.error}`); process.exitCode = 1; }
      else out(`${r.email ?? 'Signed in'} (${r.plan} plan) on ${r.account.origin}, as "${r.account.label}"`);
    }
  } catch (err) {
    process.stderr.write(`✗ ${(err as Error).message}\n`);
    process.exit(1);
  }
}
