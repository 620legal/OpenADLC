import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BIN = join(import.meta.dirname, '..', 'bin');
const SHIM = join(BIN, 'rg');

// What `toolsPolicyEnv` writes (packages/engines/src/tools.ts), by what the skill may write.
const READ_ONLY = JSON.stringify({ pushBranchPrefix: null, forcePush: false, localCi: false, denyGithub: ['push'], readOnly: true });
const WRITES = JSON.stringify({ pushBranchPrefix: 'agent/', forcePush: false, localCi: true, denyGithub: [], readOnly: false });
const BEFORE_READ_ONLY = JSON.stringify({ pushBranchPrefix: null, forcePush: false, localCi: false, denyGithub: ['push'] });

describe('OpenADLC’s rg', () => {
  // `rg --pre CMD` runs CMD on every file it searches, and no engine's rules
  // read an argument after the first words. A stand-in rg after the shim on
  // PATH writes down that it ran, its arguments and RIPGREP_CONFIG_PATH, so
  // "nothing ran" is checked without the machine needing ripgrep.
  let dir: string;
  let real: string;
  let record: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openadlc-rg-shim-'));
    real = join(dir, 'real');
    record = join(dir, 'ran');
    mkdirSync(real);
    writeFileSync(
      join(real, 'rg'),
      ['#!/bin/sh', `printf '%s\\n' "config=\${RIPGREP_CONFIG_PATH:-unset}" "$@" > '${record}'`, 'exit 0', ''].join('\n'),
    );
    chmodSync(join(real, 'rg'), 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const rg = (args: string[], policy: string | null, extra: Record<string, string> = {}) =>
    spawnSync(SHIM, args, {
      cwd: dir,
      env: { ...process.env, PATH: `${BIN}:${real}:${process.env.PATH ?? ''}`, OPENADLC_TOOLS_POLICY: policy ?? '', ...extra },
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
  const recorded = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').slice(0, -1) : null);

  const RUNS_A_PROGRAM: Array<[string[], string]> = [
    [['x', '--pre', 'sh', 's.sh'], '--pre'],
    [['--pre=sh', 'x'], '--pre'],
    [['--pre', 'sh', 'x', '.'], '--pre'],
    [['x', '--pre-glob', '*'], '--pre-glob'],
    [['--pre-glob=*', 'x'], '--pre-glob'],
    [['x', '.', '--hostname-bin=s.sh'], '--hostname-bin'],
    [['x', '.', '--hostname-bin', 's.sh'], '--hostname-bin'],
    // The value of another option: refused too, which fails closed.
    [['-e', '--pre', '.'], '--pre'],
  ];

  it.each(RUNS_A_PROGRAM)('refuses %j for a skill that writes nothing, and runs nothing', (args, option) => {
    const refused = rg(args, READ_ONLY);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toBe(`rg: not running — rg ${option} is how rg runs a program of its own, and this task's skill writes nothing\n`);
    expect(recorded()).toBeNull();
  });

  it.each([
    ['a skill with a write scope', WRITES],
    ['a policy written before readOnly', BEFORE_READ_ONLY],
    ['a person’s shell, with no rules', null],
  ])('hands every argument to the real rg unchanged for %s', (_name, policy) => {
    for (const [args] of RUNS_A_PROGRAM) {
      const ran = rg(args, policy, { RIPGREP_CONFIG_PATH: '/tmp/rg.conf' });
      expect(ran.stderr).toBe('');
      expect(ran.status).toBe(0);
      expect(recorded()).toEqual(['config=/tmp/rg.conf', ...args]);
    }
  });

  it('searches as asked for a skill that writes nothing, a pattern after -- included', () => {
    for (const args of [['-n', 'pre', '.'], ['--pretty', 'x'], ['--', '--pre', '.'], ['-e', 'x', '--', '--hostname-bin=s.sh']]) {
      const ran = rg(args, READ_ONLY);
      expect(ran.stderr, args.join(' ')).toBe('');
      expect(ran.status).toBe(0);
      expect(recorded()).toEqual(['config=unset', ...args]);
    }
  });

  it('drops RIPGREP_CONFIG_PATH for a skill that writes nothing, since a config file can supply --pre', () => {
    const config = join(dir, 'rg.conf');
    writeFileSync(config, `--pre=${join(dir, 'evil.sh')}\n`);
    const ran = rg(['x', '.'], READ_ONLY, { RIPGREP_CONFIG_PATH: config });
    expect(ran.status).toBe(0);
    expect(recorded()).toEqual(['config=unset', 'x', '.']);
  });

  it('runs the rg after it on PATH, not another copy of this folder, which would exec it back for good', () => {
    const other = join(dir, 'other-shims');
    cpSync(BIN, other, { recursive: true });
    const ran = spawnSync(SHIM, ['x'], {
      env: { ...process.env, PATH: `${BIN}:${other}:${real}:${process.env.PATH ?? ''}`, OPENADLC_TOOLS_POLICY: READ_ONLY },
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(ran.error).toBeUndefined();
    expect(ran.status).toBe(0);
    expect(recorded()).toEqual(['config=unset', 'x']);
  });

  it('runs the rg after it, not a stand-in before it that runs it', () => {
    const stand = join(dir, 'stand-in');
    const runs = join(dir, 'runs');
    mkdirSync(stand);
    writeFileSync(
      join(stand, 'rg'),
      [
        '#!/bin/sh',
        `[ -f '${runs}' ] && [ "$(wc -l < '${runs}')" -ge 5 ] && { echo 'the stand-in was run again' >&2; exit 97; }`,
        `echo "$*" >> '${runs}'`,
        `exec '${SHIM}' "$@"`,
        '',
      ].join('\n'),
    );
    chmodSync(join(stand, 'rg'), 0o755);
    const ran = spawnSync(join(stand, 'rg'), ['x'], {
      env: { ...process.env, PATH: `${stand}:${BIN}:${real}:${process.env.PATH ?? ''}`, OPENADLC_TOOLS_POLICY: READ_ONLY },
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(readFileSync(runs, 'utf8')).toBe('x\n');
    expect(recorded()).toEqual(['config=unset', 'x']);
  });

  it('run by its full path from a PATH without it, takes the first rg there', () => {
    const ran = spawnSync(SHIM, ['x'], {
      env: { ...process.env, PATH: `${real}:${process.env.PATH ?? ''}`, OPENADLC_TOOLS_POLICY: READ_ONLY },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(ran.status).toBe(0);
    expect(recorded()).toEqual(['config=unset', 'x']);
  });

  it('says there is no rg after it on PATH, rather than that rg is not installed, when none is', () => {
    const tools = join(dir, 'tools');
    mkdirSync(tools);
    // What the wrapper itself runs, and no rg.
    symlinkSync(execFileSync('sh', ['-c', 'command -v dirname'], { encoding: 'utf8' }).trim(), join(tools, 'dirname'));
    const ran = spawnSync(SHIM, ['x'], { env: { PATH: [BIN, tools].join(':'), OPENADLC_TOOLS_POLICY: '' }, encoding: 'utf8', timeout: 10_000 });
    expect(ran.status).toBe(127);
    expect(ran.stderr).toBe(`rg: no rg after OpenADLC's (${BIN}) on PATH; put the real rg's directory after it\n`);
  });

  // The refusal matches names exactly, not by prefix — `--pre` is a prefix of
  // `--pretty` — which holds only because rg takes no abbreviation of a long
  // option. Checked against the real rg where the machine has one.
  const realRg = spawnSync('sh', ['-c', 'command -v rg'], { encoding: 'utf8' }).stdout.trim();
  it.skipIf(!realRg)('relies on the real rg refusing an abbreviation of --pre-glob (skipped where ripgrep is not installed)', () => {
    const ran = spawnSync(realRg, ['--pre-g', '*', 'x', dir], { encoding: 'utf8' });
    expect(ran.status).toBe(2);
    expect(ran.stderr).toMatch(/--pre-g/);
  });
});
