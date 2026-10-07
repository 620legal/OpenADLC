import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLAGS, flagValue, hasFlag, refusal, strayArgument, unknownFlag, wantsHelp } from './flags.js';

/**
 * A flag no command reads used to do nothing and say nothing: `fleetadlc up --demo`
 * started the real install `~/.fleetadlc` pointed at.
 */

describe('a flag a command does not read', () => {
  it('is refused, and the refusal says what the command does take', () => {
    expect(unknownFlag('up', ['--demo'])).toBe('--demo');
    expect(refusal('up', '--demo')).toBe('fleetadlc up does not take --demo; it takes --no-seed');
    expect(unknownFlag('up', ['--skip-seed'])).toBe('--skip-seed');
    expect(refusal('down', '--force')).toBe('fleetadlc down does not take --force; it takes no flags');
  });

  it('is not what a command reads, with its value or in either order', () => {
    expect(unknownFlag('up', ['--no-seed'])).toBeNull();
    expect(unknownFlag('backup', ['--out', '/tmp/fleetadlc.bak', '--history', '--no-sign-ins', '--bots', 'builder,sre'])).toBeNull();
    expect(unknownFlag('restore', ['--dry-run', '/tmp/fleetadlc.bak'])).toBeNull();
    expect(unknownFlag('auth', ['login', '--bot', 'builder'])).toBeNull();
    expect(unknownFlag('init', ['--driver=docker'])).toBeNull();
  });

  it('is left alone for a command the table does not know, which says so itself', () => {
    expect(unknownFlag('help', ['--verbose'])).toBeNull();
    expect(unknownFlag(undefined, ['--help'])).toBeNull();
  });
});

describe('a single-dash argument, and help', () => {
  // `-x` was passed over as a path or a name, so `fleetadlc down -h` stopped the
  // stack and `fleetadlc config -x` printed and succeeded.
  it('is refused as a flag the command does not take', () => {
    expect(unknownFlag('down', ['-x'])).toBe('-x');
    expect(unknownFlag('config', ['-x'])).toBe('-x');
    expect(unknownFlag('github', ['apply', '-r'])).toBe('-r');
    expect(refusal('down', '-x')).toBe('fleetadlc down does not take -x; it takes no flags');
  });

  it('asks for help with -h or --help anywhere after the command', () => {
    expect(wantsHelp(['-h'])).toBe(true);
    expect(wantsHelp(['login', '--help'])).toBe(true);
    expect(wantsHelp(['--bot', 'builder'])).toBe(false);
  });
});

describe('an argument a command takes none of', () => {
  it('is named, so a command that takes none does not run with one', () => {
    expect(strayArgument('down', ['now'])).toBe('now');
    expect(strayArgument('up', ['--no-seed', 'please'])).toBe('please');
    expect(strayArgument('up', ['--no-seed'])).toBeNull();
    expect(strayArgument('restore', ['/tmp/fleetadlc.bak'])).toBeNull();
    expect(strayArgument('logs', ['hostd'])).toBeNull();
  });
});

describe('a flag a sibling subcommand reads', () => {
  // Listed by command, `github apply --repo acme/one` was taken and ignored, and
  // apply wrote rulesets and templates to every repository.
  it('is refused by the subcommand that does not read it', () => {
    expect(unknownFlag('github', ['apply', '--repo', 'acme/one'])).toBe('--repo');
    expect(unknownFlag('github', ['check', '--repo', 'x'])).toBe('--repo');
    expect(refusal('github', '--repo', 'check')).toBe('fleetadlc github check does not take --repo; it takes no flags');
    expect(refusal('github', '--repo', 'apply')).toBe(
      'fleetadlc github apply does not take --repo; it takes --production, --reviewer, --soak',
    );
    for (const action of ['plan', 'apply', 'push', 'output']) {
      expect(unknownFlag('cloud', [action, '--bucket', 'b'])).toBe('--bucket');
      expect(unknownFlag('cloud', [action, '--prefix', 'p'])).toBe('--prefix');
    }
    expect(refusal('cloud', '--bucket', 'plan')).toBe('fleetadlc cloud plan does not take --bucket; it takes --provider');
    expect(unknownFlag('auth', ['status', '--bot', 'x'])).toBe('--bot');
  });

  it('is refused by bare auth, which runs status', () => {
    expect(unknownFlag('auth', ['--bot', 'x'])).toBe('--bot');
    expect(refusal('auth', '--bot', '--bot')).toBe('fleetadlc auth status does not take --bot; it takes no flags');
  });

  it('is taken by the subcommand that reads it', () => {
    expect(unknownFlag('github', ['sync-labels', '--repo', 'acme/one'])).toBeNull();
    expect(unknownFlag('github', ['apply', '--production', 'reviewers', '--reviewer', 'alice', '--soak', '30'])).toBeNull();
    expect(unknownFlag('cloud', ['pull', '--bucket', 'b', '--prefix', 'p'])).toBeNull();
    for (const action of ['configure', 'pull', 'push', 'plan', 'apply', 'output', 'validate']) {
      expect(unknownFlag('cloud', [action, '--provider', 'gcp'])).toBeNull();
    }
    expect(unknownFlag('auth', ['login', '--bot', 'builder'])).toBeNull();
    expect(unknownFlag('auth', ['login', '--all'])).toBeNull();
    expect(unknownFlag('attribution', ['rotate', '--drop-old'])).toBeNull();
    expect(refusal('attribution', '--force', 'rotate')).toBe('fleetadlc attribution rotate does not take --force; it takes --drop-old');
  });

  it('is left alone for a subcommand the table does not know, which main says is unknown', () => {
    expect(unknownFlag('github', ['frob', '--repo', 'x'])).toBeNull();
    expect(unknownFlag('cloud', ['--bucket', 'b'])).toBeNull();
  });
});

describe('reading a flag', () => {
  // The check above let `--name=value` through and the reader dropped it:
  // `backup --without=crew,accounts --out=/secure/x` backed up everything to ~.
  it('reads a value written after = as it reads one after a space', () => {
    expect(flagValue(['backup', '--out=/secure/x'], 'out')).toBe('/secure/x');
    expect(flagValue(['backup', '--without=crew,accounts'], 'without')).toBe('crew,accounts');
    expect(flagValue(['init', '--driver=docker'], 'driver')).toBe('docker');
    expect(flagValue(['auth', 'login', '--bot=builder'], 'bot')).toBe('builder');
    expect(flagValue(['backup', '--out', '/secure/x'], 'out')).toBe('/secure/x');
  });

  it('splits on the first = only, so a value may carry its own', () => {
    expect(flagValue(['init', '--database-url=postgres://u:p@h/db?sslmode=require'], 'database-url')).toBe(
      'postgres://u:p@h/db?sslmode=require',
    );
  });

  it('reads a flag with no value, or followed by another flag, as empty, and one not given as undefined', () => {
    expect(flagValue(['backup', '--out'], 'out')).toBe('');
    expect(flagValue(['backup', '--out', '--history'], 'out')).toBe('');
    expect(flagValue(['backup', '--history'], 'out')).toBeUndefined();
  });

  it('sees a flag given in either form, and only by its exact name', () => {
    expect(hasFlag(['up', '--no-seed'], 'no-seed')).toBe(true);
    expect(hasFlag(['up', '--no-seed=true'], 'no-seed')).toBe(true);
    expect(hasFlag(['backup', '--sign-ins-x=1'], 'sign-ins')).toBe(false);
    expect(hasFlag(['backup', '--no-sign-ins'], 'sign-ins')).toBe(false);
    expect(flagValue(['backup', '--outfile=/x'], 'out')).toBeUndefined();
  });
});

describe('the table', () => {
  it('names every flag the CLI reads, so a flag added to a command is not refused', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'main.ts'), 'utf8');
    const read = [...source.matchAll(/\b(?:flag|has)\('([a-z-]+)'\)/g)].map((match) => match[1]);
    const listed = new Set(Object.values(FLAGS).flat());

    expect(read.length).toBeGreaterThan(10);
    expect(read.filter((name) => !listed.has(name as string))).toEqual([]);
  });
});
