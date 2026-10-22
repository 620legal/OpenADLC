import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The passphrase prompt in a real terminal, a pseudo-terminal made by
 * `script`, which every Linux and macOS has: a fake stream cannot show what
 * the terminal itself echoes, and the bug this guards against (#99) passed
 * every test that gave readline an output to write to and then looked only at
 * what came back. `openadlc backup` itself needs a database before it asks, so
 * this drives the same io it and `restore` ask with, `terminalIo().askSecret`.
 */

const CLI = fileURLToPath(new URL('../..', import.meta.url));
const BACKUP = pathToFileURL(fileURLToPath(new URL('./backup.ts', import.meta.url))).href;
const TYPED = 'ZQXJ-typed-at-the-prompt';

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** How this machine's `script` runs a command in a pseudo-terminal, or why it cannot. */
function scriptCommand(command: string[]): { argv: string[] } | { missing: string } {
  if (spawnSync('sh', ['-c', 'command -v script'], { stdio: 'ignore' }).status !== 0) {
    return { missing: 'no `script` on this machine to make a pseudo-terminal with' };
  }
  // util-linux takes the command as one string for the shell; the BSDs' and
  // macOS's take it as the arguments after the file it records to.
  if (process.platform === 'linux') return { argv: ['-q', '-e', '-c', command.map(quote).join(' '), '/dev/null'] };
  if (process.platform === 'darwin' || process.platform.endsWith('bsd')) return { argv: ['-q', '/dev/null', ...command] };
  return { missing: `no known way to run \`script\` on ${process.platform}` };
}

/** Everything the terminal showed while `keys` were typed at the question, and how it ended. */
async function typeAtPrompt(work: string, keys: string): Promise<{ screen: string; code: number | null }> {
  const driver = join(work, 'driver.mjs');
  writeFileSync(
    driver,
    [
      `const { terminalIo } = await import(${JSON.stringify(BACKUP)});`,
      `const answer = await terminalIo().askSecret('Passphrase');`,
      // Whether it read the right thing, without printing what it read.
      'process.stdout.write(`[${answer === process.env.EXPECTED ? "same" : "different"}, raw ${process.stdin.isRaw}]\\n`);',
    ].join('\n'),
  );
  const how = scriptCommand([process.execPath, '--import', 'tsx', driver]);
  if ('missing' in how) throw new Error(how.missing);
  // Through `cat`, because macOS's `script` refuses a socket for its stdin
  // ("tcgetattr/ioctl: Operation not supported on socket"), and a socket is
  // what node gives a child for a pipe.
  const child = spawn('sh', ['-c', `cat | exec script ${how.argv.map(quote).join(' ')}`], {
    cwd: CLI,
    env: { ...process.env, EXPECTED: TYPED },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let screen = '';
  let typed = false;
  let answered = false;
  // A shell that died early fails the test by what the screen shows, not by
  // an EPIPE from writing to it.
  child.stdin.on('error', () => {});
  return new Promise((resolve, reject) => {
    const stop = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      reject(new Error(`no answer from the prompt in time; the terminal showed: ${JSON.stringify(screen)}`));
    }, 25_000);
    const read = (chunk: Buffer) => {
      screen += chunk.toString('utf8');
      // Only once the question is up, as a person would: what is typed before
      // the prompt has the terminal is echoed by the terminal, not by the CLI.
      if (!typed && screen.includes('Passphrase: ')) {
        typed = true;
        child.stdin.write(keys);
      }
      // `cat` waits for the end of its input, and `script` passes that end on
      // as a Ctrl-D, which a BSD terminal echoes: so only after the answer.
      if (!answered && /\[(same|different), raw \w+\]/.test(screen)) {
        answered = true;
        child.stdin.end();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(stop);
      resolve({ screen: screen.replaceAll('\r\n', '\n'), code });
    });
  });
}

describe('the passphrase prompt in a terminal', () => {
  it('shows nothing that was typed, reads it whole, and leaves the terminal as it was', async (context) => {
    const how = scriptCommand(['true']);
    if ('missing' in how) return context.skip(how.missing);
    const work = mkdtempSync(join(tmpdir(), 'openadlc-pty-'));
    try {
      const { screen, code } = await typeAtPrompt(work, `${TYPED}\r`);

      // Nothing between the question and the end of its line: one echoed
      // character, a mask, or readline's cursor move before the text
      // (`^[[11G`) fails it. What a person typed is nowhere on the screen.
      expect(screen).toContain('  Passphrase: \n[same, raw false]\n');
      expect(screen).not.toContain(TYPED.slice(0, 4));
      expect(code).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
