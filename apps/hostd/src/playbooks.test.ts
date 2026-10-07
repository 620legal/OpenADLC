import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_ROLES, parseYamlFile } from '@fleetadlc/shared';
import { describe, expect, it } from 'vitest';
import { ROLES_IN_CONTAINER } from './drivers/docker.js';
import { playbookPaths } from './task-runner.js';

/**
 * A role's playbook is the first context a task is given, and a missing one is
 * not an error — hostd warns and starts the task anyway, which is right, because
 * a bot with no playbook is still a working bot. It also means nobody finds out.
 *
 * Nine roles used to share four files. `spec` read the builder's playbook,
 * `qa` read the reviewer's, and the automation account read intake's, so three
 * bots were briefed as something they are not and nothing said so. A role now
 * resolves to `crew/roles/<role>.md` with no map in between, and this is what fails
 * when one is added without a playbook.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROLES = join(ROOT, 'crew', 'roles');

const crew = parseYamlFile(join(ROOT, 'config', 'bots.yaml')) as {
  bots: { slot: string; role: string }[];
};

describe('every role has a playbook of its own', () => {
  it.each(BOT_ROLES)('%s', (role) => {
    expect(existsSync(join(ROLES, `${role}.md`)), `roles/${role}.md is missing`).toBe(true);
  });

  it('covers every role the crew is configured with', () => {
    // `BOT_ROLES` is the type; `config/bots.yaml` is what an install runs. A
    // role in one and not the other is how a bot ends up with no briefing.
    for (const bot of crew.bots) {
      expect(BOT_ROLES as readonly string[], `${bot.slot} has role ${bot.role}`).toContain(bot.role);
    }
  });

  it('has no playbook that belongs to no role', () => {
    // A file left behind after a rename is a file somebody will keep editing.
    const orphans = readdirSync(ROLES)
      .filter((file) => file.endsWith('.md') && file !== 'README.md')
      .map((file) => file.replace(/\.md$/, ''))
      .filter((name) => !(BOT_ROLES as readonly string[]).includes(name));
    expect(orphans).toEqual([]);
  });
});

describe('where a session finds its playbook', () => {
  // On the live install every bot in a container ran without its playbook: the
  // runner was handed /Users/…/roles/intake.md, which exists on the host and
  // not in the container, where the playbooks are mounted at /roles.
  it('is the mount in a container, and the file itself on the host', () => {
    expect(playbookPaths('intake', { rolesRoot: '/Users/someone/fleetadlc/roles', driver: 'docker' })).toEqual({
      onHost: '/Users/someone/fleetadlc/roles/intake.md',
      inSession: '/roles/intake.md',
    });
    expect(playbookPaths('intake', { rolesRoot: '/Users/someone/fleetadlc/roles', driver: 'local' })).toEqual({
      onHost: '/Users/someone/fleetadlc/roles/intake.md',
      inSession: '/Users/someone/fleetadlc/roles/intake.md',
    });
  });

  it('is where the docker driver mounts the playbooks', () => {
    const driver = readFileSync(join(ROOT, 'apps', 'hostd', 'src', 'drivers', 'docker.ts'), 'utf8');
    expect(driver).toContain('`${this.options.rolesRoot}:${ROLES_IN_CONTAINER}:ro`');
    expect(playbookPaths('qa', { rolesRoot: ROLES, driver: 'docker' }).inSession).toBe(`${ROLES_IN_CONTAINER}/qa.md`);
  });
});

describe('what a playbook has to say', () => {
  it.each(BOT_ROLES)('%s states what it owns, never does, and hands to', (role) => {
    // Every playbook has to say what the role owns, never does and hands to: a
    // playbook that only says what the bot does is a job description.
    const text = readFileSync(join(ROLES, `${role}.md`), 'utf8');
    expect(text).toContain('## You own');
    expect(text).toContain('## You never');
    expect(text).toContain('## You hand to');
  });

  it.each(BOT_ROLES)('%s stays short enough to be the first thing in a prompt', (role) => {
    // Every task pays for this in tokens, on every run. A playbook that grows
    // into a manual stops being read by the model and by anyone else.
    const lines = readFileSync(join(ROLES, `${role}.md`), 'utf8').split('\n').length;
    expect(lines, `roles/${role}.md is ${lines} lines`).toBeLessThan(60);
  });
});
