import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The command as a script sees it: by its exit code. `main` runs when the
 * module is loaded, so each case loads it afresh with its own arguments.
 */

const before = { argv: process.argv, env: { ...process.env }, exitCode: process.exitCode };
let home = '';
let printed: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fleetadlc-main-'));
  process.env.FLEETADLC_HOME = home;
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(String(line)));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = before.argv;
  for (const key of Object.keys(process.env)) if (!(key in before.env)) delete process.env[key];
  Object.assign(process.env, before.env);
  process.exitCode = before.exitCode;
  rmSync(home, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<number | string | undefined> {
  vi.resetModules();
  process.argv = [process.execPath, 'fleetadlc', ...args];
  process.exitCode = undefined;
  await import('./main.js');
  await vi.waitFor(() => expect(printed.some((line) => line.includes('✗'))).toBe(true));
  return process.exitCode;
}

describe('a command the CLI does not have', () => {
  it('fails with the usage code, so a script does not carry on', async () => {
    // Each printed ✗ and exited 0: `fleetadlc github chek && deploy` deployed.
    expect(await run('auth', 'logn')).toBe(2);
    expect(await run('github', 'chek')).toBe(2);
    expect(await run('attach')).toBe(2);
  });
});

describe('a flag a sibling subcommand reads', () => {
  it('stops the subcommand that does not read it before it acts', async () => {
    // `github apply --repo acme/one` was taken, ignored, and wrote to every repository.
    expect(await run('github', 'apply', '--repo', 'acme/one')).toBe(2);
    expect(printed.join('\n')).toContain('fleetadlc github apply does not take --repo');
    expect(await run('cloud', 'plan', '--bucket', 'b')).toBe(2);
    expect(await run('auth', '--bot', 'x')).toBe(2);
  });
});

describe('fleetadlc help', () => {
  it('names every command and every flag the CLI takes', async () => {
    // `config`, `cloud push`, `cloud validate`, `up --no-seed` and the init and
    // cloud flags were accepted and documented in docs/cli.md, but `help` left
    // them out, so someone learning the CLI from it could not find them.
    const { FLAGS } = await import('./flags.js');
    vi.resetModules();
    process.argv = [process.execPath, 'fleetadlc', 'help'];
    await import('./main.js');
    await vi.waitFor(() => expect(printed.some((line) => line.includes('fleetadlc init'))).toBe(true));
    const help = printed.join('\n');
    const commandLines = help.split('\n').filter((line) => line.startsWith('  fleetadlc '));

    for (const [name, flags] of Object.entries(FLAGS)) {
      const [command, subcommand] = name.split(' ');
      const lines = commandLines.filter((line) => line.startsWith(`  fleetadlc ${command}`));
      expect(lines, name).not.toEqual([]);
      if (subcommand) expect(lines.some((line) => line.split(/[\s|]+/).includes(subcommand)), name).toBe(true);
      for (const flag of flags) expect(help, `${name} --${flag}`).toContain(`--${flag}`);
    }
  });
});

/** Runs the CLI until a printed line contains `until`, and gives back its exit code. */
async function runUntil(until: string, ...args: string[]): Promise<number | string | undefined> {
  vi.resetModules();
  process.argv = [process.execPath, 'fleetadlc', ...args];
  process.exitCode = undefined;
  await import('./main.js');
  await vi.waitFor(() => expect(printed.some((line) => line.includes(until))).toBe(true));
  return process.exitCode;
}

describe('help after a command', () => {
  it('says what the command does and runs nothing', async () => {
    // `fleetadlc down -h` stopped the stack, and `up -h` started it.
    expect(await runUntil('fleetadlc down', 'down', '-h')).toBeUndefined();
    expect(printed.join('\n')).toContain('stop the stack');
    expect(printed.join('\n')).not.toContain('Stopping');
    expect(printed.join('\n')).not.toContain('fleetadlc init');

    printed = [];
    expect(await runUntil('fleetadlc up', 'up', '--help')).toBeUndefined();
    expect(printed.join('\n')).not.toContain('Starting');
  });

  it('refuses a single-dash argument a command does not take', async () => {
    expect(await run('config', '-x')).toBe(2);
    expect(printed.join('\n')).toContain('fleetadlc config does not take -x');
  });
});

describe('an install.json that is not JSON', () => {
  it('still lets help and config answer, and names the file to every other command', async () => {
    writeFileSync(join(home, 'install.json'), '{"driver": "local",}');
    await runUntil('fleetadlc —', '--help');
    printed = [];
    await runUntil(join(home, 'install.json'), 'config');
    printed = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runUntil('✗', 'status');
    expect(printed.join('\n')).toContain(`${join(home, 'install.json')} is not valid JSON`);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
