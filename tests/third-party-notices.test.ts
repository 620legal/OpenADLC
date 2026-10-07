import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * `infra/local/third-party-notices.sh` lists the licences of what a built
 * image installs by running the image, so nothing is added to it; whoever
 * publishes an image ships the list beside it (docs/self-hosting.md).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'infra', 'local', 'third-party-notices.sh');

function notices(args: string[], env: NodeJS.ProcessEnv = process.env) {
  // bash by its path, so a PATH without docker still finds the shell.
  return spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8', env });
}

describe('third-party-notices.sh, asked wrongly', () => {
  it('says how it is used, and exits 64, when given no image, too much or a flag', () => {
    for (const args of [[], ['a', 'b', 'c'], ['--image'], [''], ['fleetadlc-bot:latest', '']]) {
      const run = notices(args);
      expect(run.status, JSON.stringify(args)).toBe(64);
      expect(run.stderr).toContain('usage: infra/local/third-party-notices.sh IMAGE [OUTPUT]');
    }
  });

  it('says how it is used on --help, and succeeds', () => {
    const run = notices(['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('usage: infra/local/third-party-notices.sh IMAGE [OUTPUT]');
  });

  it('says docker is missing, and exits 69, where there is none', () => {
    const empty = mkdtempSync(join(tmpdir(), 'fleetadlc-no-docker-'));
    try {
      const run = notices(['fleetadlc-bot:latest'], { PATH: empty });
      expect(run.status).toBe(69);
      expect(run.stderr).toContain('docker is not installed');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

/** Docker answers, and one of these bases is here already, so the test pulls nothing. */
function localBase(): string | null {
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return null;
  return ['debian:12-slim', 'node:22-bookworm-slim'].find((image) => spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0) ?? null;
}

const base = localBase();

describe.skipIf(!base)('third-party-notices.sh, against an image', () => {
  it('lists its Debian packages, what is under /usr/local/share/doc and its npm packages, and changes nothing in it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-notices-'));
    const tag = `third-party-notices-test:${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(
        join(dir, 'Dockerfile'),
        [
          `FROM ${base}`,
          'RUN mkdir -p /usr/local/lib/node_modules/fixture-pad /usr/local/share/doc/fixture-tool \\',
          `    && printf '%s\\n' '{"name": "fixture-pad", "version": "1.2.3", "license": "MIT"}' > /usr/local/lib/node_modules/fixture-pad/package.json \\`,
          "    && printf '%s\\n' 'The fixture-pad licence text.' > /usr/local/lib/node_modules/fixture-pad/LICENSE \\",
          "    && printf '%s\\n' 'The fixture-tool licence text.' > /usr/local/share/doc/fixture-tool/LICENSE",
          '',
        ].join('\n'),
      );
      execFileSync('docker', ['build', '-q', '-t', tag, dir], { stdio: 'ignore' });
      const before = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' }).trim();
      const output = join(dir, 'notices.txt');

      const run = notices([tag, output]);

      expect(run.status, run.stderr).toBe(0);
      expect(existsSync(`${output}.partial`)).toBe(false);
      const text = readFileSync(output, 'utf8');
      expect(text).toContain(`Third-party notices for ${tag}`);
      expect(text).toContain(before);
      expect(text).toMatch(/^Debian package dpkg /m);
      expect(text).toContain('fixture-tool/LICENSE');
      expect(text).toContain('The fixture-tool licence text.');
      expect(text).toContain('npm package fixture-pad 1.2.3');
      expect(text).toContain('The fixture-pad licence text.');
      expect(execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' }).trim()).toBe(before);
    } finally {
      spawnSync('docker', ['rmi', '-f', tag], { stdio: 'ignore' });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
