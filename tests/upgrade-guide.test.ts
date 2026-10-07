import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What someone upgrading an install from before the rename is told.
 *
 * The rename moved every header FleetADLC's parts send each other from
 * `x-fleet-*` to `x-fleetadlc-*`, and nothing accepts the old names. The guide
 * said everything outside FleetADLC's control kept its old name, so a monitor
 * calling `/internal/*` got a silent 401. Its steps pulled and built before
 * `down`, so a task ran on across the upgrade with a runner whose reports the
 * new bridge refused. And the restart it pointed a cloud install at named a
 * hostd unit the host does not have.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const guide = readFileSync(join(ROOT, 'docs', 'upgrading-from-fleet.md'), 'utf8');
const selfHosting = readFileSync(join(ROOT, 'docs', 'self-hosting.md'), 'utf8');
const cloudInit = readFileSync(join(ROOT, 'infra', 'gcp', 'cloud-init', 'host.yaml'), 'utf8');

/** Prose wraps anywhere, so a phrase is looked for with its line breaks as spaces. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

const RENAMED_HEADERS = ['internal-secret', 'identity', 'on-behalf-of', 'task-token', 'iap-assertion', 'user'];

describe('the upgrade guide', () => {
  it('says the old header names are gone', () => {
    const row = guide.split('\n').find((line) => line.startsWith('|') && line.includes('x-fleetadlc-internal-secret'));
    expect(row, 'the table has no row for the HTTP headers').toBeDefined();
    for (const header of RENAMED_HEADERS) {
      expect(row).toContain(`x-fleet-${header}`);
      expect(row).toContain(`-${header}\``);
    }
    expect(row).toContain('Gone');
    expect(row).toContain('401');
  });

  it('pauses work and stops the install before pulling the new release, and resumes after', () => {
    const steps = guide.slice(guide.indexOf('## Steps'));
    const block = /```bash\n([\s\S]*?)```/.exec(steps);
    expect(block, 'the Steps section has no command block').not.toBeNull();
    const commands = block?.[1] ?? '';
    const before = flat(steps.slice(0, block?.index ?? 0));
    const after = flat(steps.slice((block?.index ?? 0) + (block?.[0].length ?? 0)));

    expect(before).toContain('Pause work');
    const pull = commands.indexOf('git pull');
    expect(pull).toBeGreaterThan(-1);
    expect(commands.indexOf('.mjs status')).toBeGreaterThan(-1);
    expect(commands.indexOf('.mjs status')).toBeLessThan(pull);
    expect(commands.indexOf('.mjs down')).toBeGreaterThan(-1);
    expect(commands.indexOf('.mjs down')).toBeLessThan(pull);
    expect(commands.indexOf('.mjs up')).toBeGreaterThan(pull);
    expect(after).toContain('Resume');
  });

  it('rolls a cloud install out with work paused, restarting the hostd unit the host has', () => {
    const cloud = flat(guide.slice(guide.indexOf('A cloud install pulls its settings')));
    expect(cloud).toContain('Pause work');
    expect(cloud).toContain('Resume');
    expect(cloud).toContain('systemctl restart fleet-hostd');
  });
});

describe('the hostd unit the docs tell someone to restart', () => {
  it('is the one the cloud host defines', () => {
    const unit = /^\s+- path: \/etc\/systemd\/system\/([a-z-]*hostd)\.service$/m.exec(cloudInit)?.[1];
    expect(unit).toBe('fleet-hostd');
    const restarted = [...selfHosting.matchAll(/systemctl restart ([a-z-]+)/g)].map((match) => match[1]);
    expect(restarted.length).toBeGreaterThan(0);
    for (const name of restarted) expect(name).toBe(unit);
    expect(selfHosting).not.toContain('fleetadlc-hostd');
  });
});
