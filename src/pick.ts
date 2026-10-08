// A small dependency-free multi-select for the terminal: ↑/↓ to move, space to toggle, a for all, enter to confirm.
import { emitKeypressEvents } from 'node:readline';

export interface PickItem {
  label: string;
  hint?: string;
  checked: boolean;
}

const tty = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
const paint = (code: string) => (s: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const cyan = paint('36');
const green = paint('32');

/** Returns each item's final checked state. Without a terminal, returns the defaults unchanged. */
export async function multiSelect(title: string, items: PickItem[]): Promise<boolean[]> {
  const state = items.map((i) => i.checked);
  if (!tty() || items.length === 0) return state;
  let cursor = 0;
  const out = process.stdout;
  const lines = items.length + 2;

  const render = (first: boolean) => {
    if (!first) out.write(`\x1b[${lines}A`);
    out.write(`\x1b[2K${title}\n`);
    items.forEach((it, i) => {
      const pointer = i === cursor ? cyan('❯') : ' ';
      const box = state[i] ? green('◉') : dim('◯');
      out.write(`\x1b[2K ${pointer} ${box} ${it.label}${it.hint ? dim(`  ${it.hint}`) : ''}\n`);
    });
    out.write(`\x1b[2K${dim('  ↑/↓ move · space select · a all/none · enter confirm')}\n`);
  };

  return new Promise((resolve) => {
    const stdin = process.stdin;
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    out.write('\x1b[?25l'); // hide the cursor while the menu is up
    render(true);

    const finish = () => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      out.write('\x1b[?25h');
    };
    const onKey = (_s: string, key: { name?: string; ctrl?: boolean }) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        finish();
        out.write('\n');
        process.exit(130);
      }
      if (key.name === 'up' || key.name === 'k') cursor = (cursor - 1 + items.length) % items.length;
      else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') cursor = (cursor + 1) % items.length;
      else if (key.name === 'space') state[cursor] = !state[cursor];
      else if (key.name === 'a') state.fill(!state.every(Boolean));
      else if (key.name === 'return' || key.name === 'enter') {
        finish();
        resolve(state);
        return;
      } else return;
      render(false);
    };
    stdin.on('keypress', onKey);
  });
}
