import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthView } from '@fleetadlc/shared';
import {
  bridgeProblems,
  checkHealth,
  databaseBindingGap,
  databaseContainerGaps,
  databaseInUse,
  databaseLine,
  databasePasswordGap,
  healthLines,
  spendCapRemedy,
  unreachableDatabaseHint,
  webhookSecretMismatch,
  webhookTrustGap,
} from './doctor.js';

const SECRET = 'not-printed-0123456789abcdef';

describe('fleetadlc doctor on the bots’ folders from before', () => {
  it('names each bot’s own mirrors and homes, and nothing hostd uses now', async () => {
    const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { oldSeatFolders } = await import('./doctor.js');
    const work = mkdtempSync(join(tmpdir(), 'fleetadlc-doctor-work-'));
    try {
      for (const path of ['builder/repos/acme__widgets.git', 'builder/homes/widgets', 'intake/wt', 'mirrors/acme__widgets.git', 'slots/t1']) {
        mkdirSync(join(work, path), { recursive: true });
      }
      expect(oldSeatFolders(work)).toEqual([join(work, 'builder', 'repos'), join(work, 'builder', 'homes')]);
      expect(oldSeatFolders(join(work, 'none'))).toEqual([]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('fleetadlc doctor on a command to paste', () => {
  it('quotes each path as one word that the shell expands nothing in', async () => {
    const { shellQuote } = await import('./doctor.js');
    expect(shellQuote('/Users/me/Fleet Data/work/builder/repos')).toBe("'/Users/me/Fleet Data/work/builder/repos'");
    expect(shellQuote("/tmp/it's $HOME `x`")).toBe("'/tmp/it'\\''s $HOME `x`'");
    const { execFileSync } = await import('node:child_process');
    for (const path of ['/a b/c', "/it's", '/$HOME/`id`/\\n']) {
      expect(execFileSync('sh', ['-c', `printf %s ${shellQuote(path)}`], { encoding: 'utf8' })).toBe(path);
    }
  });
});

describe('fleetadlc doctor when only the database is down', () => {
  it('does not report the App’s client id or the webhook secret as missing, which it could not read', async () => {
    // It failed "no GitHub App client id" and "no webhook secret" beside
    // "cannot reach postgres", and sent the operator to make the app again.
    const { clientIdLine, webhookSecretLine } = await import('./doctor.js');
    expect(clientIdLine({ clientId: null, storedRead: false, staticOnly: 0 })).toEqual({
      kind: 'note',
      text: 'GitHub App client id: not checked: the database is unreachable',
    });
    expect(webhookSecretLine({ installSecret: '', environmentSecret: undefined, storedSecret: undefined })).toEqual({
      kind: 'note',
      text: 'webhook secret: not checked: the database is unreachable',
    });
  });

  it('still fails both when the table was read and has none, and passes what install.json has', async () => {
    const { clientIdLine, webhookSecretLine } = await import('./doctor.js');
    expect(clientIdLine({ clientId: null, storedRead: true, staticOnly: 0 })).toMatchObject({ kind: 'fail', text: 'no GitHub App client id' });
    expect(clientIdLine({ clientId: 'Iv1.0123456789abc', storedRead: false, staticOnly: 0 })).toMatchObject({ kind: 'ok' });
    expect(webhookSecretLine({ installSecret: '', environmentSecret: undefined, storedSecret: null })).toMatchObject({ kind: 'fail' });
    expect(webhookSecretLine({ installSecret: SECRET, environmentSecret: undefined, storedSecret: undefined })).toMatchObject({ kind: 'ok' });
  });
});

describe('fleetadlc doctor on tmux', () => {
  it('fails a host without it only under the local driver: the docker driver runs it in the bot image', async () => {
    const { tmuxLine } = await import('./doctor.js');
    expect(tmuxLine(null, 'local')).toMatchObject({ kind: 'fail', text: 'tmux is not installed' });
    expect(tmuxLine(null, 'docker')).toMatchObject({ kind: 'note' });
    expect(tmuxLine('tmux 3.5a', 'docker')).toEqual({ kind: 'ok', text: 'tmux 3.5a' });
  });
});

describe('fleetadlc doctor on the driver', () => {
  // With Docker installed it printed the version and nothing about a local
  // driver whose tasks could read the App's private key.
  it('warns under local with Docker installed, says how to switch, and counts no problem', async () => {
    const { dockerLines } = await import('./doctor.js');
    const lines = dockerLines('Docker version 27.1.1', 'local');
    expect(lines[0]).toEqual({ kind: 'ok', text: 'Docker version 27.1.1' });
    expect(lines[1]).toMatchObject({ kind: 'warn', text: expect.stringContaining('can read the secret store') });
    expect(lines.map((line) => line.text).join('\n')).toContain('infra/local/build-bot-image.sh, then fleetadlc init --driver docker');
    expect(lines.some((line) => line.kind === 'fail')).toBe(false);
  });

  it('says what local exposes without Docker, not "no isolation between bots"', async () => {
    const { dockerLines } = await import('./doctor.js');
    const lines = dockerLines(null, 'local');
    expect(lines[0]).toMatchObject({ kind: 'warn', text: expect.stringContaining('docker is not installed, so the local driver runs each task as this user') });
    expect(lines.map((line) => line.text).join('\n')).not.toContain('no isolation between bots');
    expect(lines.some((line) => line.kind === 'fail')).toBe(false);
  });

  it('is only the version under docker, and a problem when Docker is missing there', async () => {
    const { dockerLines } = await import('./doctor.js');
    expect(dockerLines('Docker version 27.1.1', 'docker')).toEqual([{ kind: 'ok', text: 'Docker version 27.1.1' }]);
    expect(dockerLines(null, 'docker')).toMatchObject([{ kind: 'fail' }]);
  });

  it('says Docker is not running, and how to start it, when it is installed and does not answer', async () => {
    // The version printed fine, and nothing said why no task could start.
    const { dockerLines } = await import('./doctor.js');
    expect(dockerLines('Docker version 27.1.1', 'docker', false)).toEqual([
      expect.objectContaining({ kind: 'fail', text: expect.stringContaining('Docker is installed but not running'), hint: expect.stringContaining('start Docker Desktop') }),
    ]);
    expect(dockerLines('Docker version 27.1.1', 'local', false).some((line) => line.kind === 'fail')).toBe(false);
  });
});

describe('fleetadlc doctor when the month is already spent', () => {
  it('points at Settings, which is where a saved cap is raised', () => {
    expect(spendCapRemedy()).toBe('Raise the cap in Settings → Spending limits, or wait for the next period.');
  });
});

/**
 * The platform database's password was `fleetadlc` on every install, and it is
 * printed in this repository: anything that reached the port — the LAN, or a
 * task's computer through host.docker.internal — logged in as superuser.
 */
describe('fleetadlc doctor on the platform database’s password', () => {
  const PUBLISHED = 'postgres://fleetadlc:fleetadlc@127.0.0.1:47432/fleetadlc_db';

  it('fails on the published password, and sends the install’s own database to `fleetadlc up`', () => {
    const gap = databasePasswordGap(PUBLISHED, true);
    expect(gap?.message).toMatch(/password published with OpenADLC/);
    expect(gap?.remedy).toMatch(/run `fleetadlc up`/);
  });

  it('says to change it by hand on a server OpenADLC does not manage', () => {
    const gap = databasePasswordGap('postgres://fleetadlc:fleetadlc@db:5432/fleetadlc_db', false);
    expect(gap?.remedy).toMatch(/does not manage this server/);
    expect(gap?.remedy).toMatch(/databaseUrl/);
    expect(gap?.remedy).not.toMatch(/fleetadlc up/);
  });

  it('fails on the superuser from before the rename, and sends that install to `fleetadlc up` too', () => {
    const gap = databasePasswordGap('postgres://fleet:fleet@127.0.0.1:47432/fleet_db', true);
    expect(gap?.message).toMatch(/password published with OpenADLC/);
    expect(gap?.remedy).toMatch(/run `fleetadlc up`/);
    expect(`${gap?.message} ${gap?.remedy}`).not.toContain('fleet:fleet');
  });

  it('is satisfied by any other password, and never prints one', () => {
    expect(databasePasswordGap(`postgres://fleetadlc:${SECRET}@127.0.0.1:47432/fleetadlc_db`, true)).toBeNull();
    expect(databasePasswordGap('postgres://fleet:0123abcd@127.0.0.1:47432/fleet_db', true)).toBeNull();
    const gap = databasePasswordGap(PUBLISHED, true);
    expect(`${gap?.message} ${gap?.remedy}`).not.toContain(':fleetadlc@');
  });
});

/**
 * An older `fleetadlc up` published its database on every address, which
 * Docker's rules let past a host firewall. `up` does not recreate it, because
 * its data is in an anonymous volume.
 */
describe('fleetadlc doctor on where the database container is published', () => {
  it('warns, naming the container and how to move it with its data, when it is beyond loopback', () => {
    const gap = databaseBindingGap('fleetadlc-db', [{ HostIp: '', HostPort: '47432' }]);
    expect(gap?.message).toBe('fleetadlc-db publishes postgres on every address:47432, not on 127.0.0.1 only');
    expect(gap?.remedy).toContain('--volumes-from fleetadlc-db-old -p 127.0.0.1:47432:5432');
    expect(databaseBindingGap('fleetadlc-db', [{ HostIp: '0.0.0.0', HostPort: '47432' }])?.message).toMatch(/on 0\.0\.0\.0:47432/);
  });

  it('says nothing about one on loopback, or no container at all', () => {
    expect(databaseBindingGap('fleetadlc-db', [{ HostIp: '127.0.0.1', HostPort: '47432' }])).toBeNull();
    expect(databaseBindingGap('fleetadlc-db', undefined)).toBeNull();
    expect(databaseBindingGap('fleetadlc-db', [])).toBeNull();
  });

  // An install from before the rename keeps Postgres in `fleet-db`, with no
  // `fleetadlc-db` beside it. Doctor looked at the new name only, so it said
  // nothing about that container's bindings and called its server unmanaged.
  it('looks at the fleet-db of an install from before the rename', async () => {
    const containers: Record<string, { HostIp?: string; HostPort?: string }[]> = { 'fleet-db': [{ HostIp: '', HostPort: '47432' }] };
    const inspect = async (name: string) => containers[name];
    const { password, exposed } = await databaseContainerGaps({ ports: { postgres: 47432 } }, 'postgres://fleet:fleet@127.0.0.1:47432/fleet_db', inspect, {});
    expect(exposed?.message).toBe('fleet-db publishes postgres on every address:47432, not on 127.0.0.1 only');
    expect(password?.remedy).toMatch(/run `fleetadlc up`/);
  });
});

describe('fleetadlc doctor on a missing webhook secret', () => {
  it('says every delivery is refused when no store has one', () => {
    const gap = webhookTrustGap({ installSecret: '', environmentSecret: undefined, storedSecret: null });

    expect(gap?.message).toMatch(/no webhook secret/);
    expect(gap?.message).toMatch(/refused/);
    expect(gap?.remedy).toMatch(/fleetadlc init/);
  });

  it('is satisfied by the install file, the environment, or the database', () => {
    expect(webhookTrustGap({ installSecret: 'a', environmentSecret: '', storedSecret: null })).toBeNull();
    expect(webhookTrustGap({ installSecret: '', environmentSecret: 'b', storedSecret: null })).toBeNull();
    expect(webhookTrustGap({ installSecret: '', environmentSecret: undefined, storedSecret: 'c' })).toBeNull();
  });

  it('prints nothing at all when a secret is configured, so it cannot leak one', () => {
    const gap = webhookTrustGap({ installSecret: '', environmentSecret: SECRET, storedSecret: null });
    expect(gap).toBeNull();
  });
});

/**
 * A secret in the environment that the bridge is not using.
 *
 * The self-hosting guide puts GitHub's secret in FLEETADLC_WEBHOOK_SECRET, and a
 * stored setting beats it. Doctor said a secret was configured, and every real
 * delivery was refused.
 */
describe('fleetadlc doctor on webhook secrets that disagree', () => {
  it('names the environment when the secret store holds a different one', () => {
    const mismatch = webhookSecretMismatch({
      installSecret: '',
      environmentSecret: 'the-one-github-has',
      storedSecret: 'one-fleetadlc-made-up',
    });

    expect(mismatch?.message).toMatch(/FLEETADLC_WEBHOOK_SECRET differs from the one in the secret store/);
    expect(mismatch?.remedy).toMatch(/the secret store/);
  });

  it('names the environment when the install file overrides it', () => {
    const mismatch = webhookSecretMismatch({ installSecret: 'a', environmentSecret: 'b', storedSecret: null });

    expect(mismatch?.message).toMatch(/FLEETADLC_WEBHOOK_SECRET differs from the one in install.json/);
  });

  it('is quiet when every place that has one has the same one, or only one place does', () => {
    expect(webhookSecretMismatch({ installSecret: 'a', environmentSecret: 'a', storedSecret: 'a' })).toBeNull();
    expect(webhookSecretMismatch({ installSecret: '', environmentSecret: 'a', storedSecret: null })).toBeNull();
    expect(webhookSecretMismatch({ installSecret: '', environmentSecret: undefined, storedSecret: null })).toBeNull();
  });

  it('does not include either value in what it would print', () => {
    const other = 'also-not-printed-fedcba9876543210';
    const mismatch = webhookSecretMismatch({ installSecret: '', environmentSecret: SECRET, storedSecret: other });

    const printed = `${mismatch?.message ?? ''} ${mismatch?.remedy ?? ''}`;
    expect(mismatch).not.toBeNull();
    expect(printed.includes(SECRET)).toBe(false);
    expect(printed.includes(other)).toBe(false);
  });
});

/**
 * The bridge's health checks in a terminal: the same checks that put a card on
 * the board, each failure with the thing to do and where, and a non-zero exit
 * while a blocking one fails.
 */
describe('fleetadlc doctor on the health checks', () => {
  const view = (partial: Partial<HealthView> & Pick<HealthView, 'id' | 'check' | 'state'>): HealthView => ({
    subject: null,
    proves: `${partial.check} proves something`,
    severity: partial.state === 'failing' ? 'blocking' : null,
    title: null,
    detail: null,
    action: null,
    since: null,
    checkedAt: '2026-09-25T12:00:00.000Z',
    bot: null,
    steps: [],
    waitingFor: [],
    ...partial,
  });

  it('prints no escape sequence or control character a card carries, an OSC hyperlink included', () => {
    const { lines } = healthLines(
      [
        view({
          id: 'attribution',
          check: 'attribution',
          state: 'failing',
          severity: 'warning',
          title: 'A review by \u001b]8;;https://evil.example\u0007fleetadlc-review\u001b]8;;\u0007 is not signed\u0000',
          detail: 'The latest, claiming to be the \u001b[2Jlead\u009b31m-reviewer\u0007: it does not check.\nIf you made it, say so.',
          action: { label: 'Open the post\u001b]0;pwned\u001b\\', url: 'https://github.com/exampleco/api/pull/31' },
        }),
      ],
      'http://127.0.0.1:47300',
    );
    expect(lines).toEqual([
      { level: 'warn', text: 'A review by fleetadlc-review is not signed' },
      { level: 'note', text: 'The latest, claiming to be the lead-reviewer: it does not check.\nIf you made it, say so.' },
      { level: 'note', text: '→ Open the post: https://github.com/exampleco/api/pull/31' },
    ]);
    expect(lines.map((line) => line.text).join('')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]|evil\.example/);
  });

  it('prints a passing check once, however many subjects it has', () => {
    const { lines, blocking } = healthLines(
      [
        view({ id: 'app-permissions:contents', check: 'app-permissions', state: 'ok', proves: 'The OpenADLC app holds every permission' }),
        view({ id: 'app-permissions:issues', check: 'app-permissions', state: 'ok', proves: 'The OpenADLC app holds every permission' }),
      ],
      'http://127.0.0.1:47300',
    );
    expect(lines).toEqual([{ level: 'ok', text: 'The OpenADLC app holds every permission' }]);
    expect(blocking).toBe(0);
  });

  it('prints each failure with what to do and where, a console page as its address, and counts the blocking ones', () => {
    const { lines, blocking } = healthLines(
      [
        view({
          id: 'app-permissions:git_signing_ssh_public_keys',
          check: 'app-permissions',
          state: 'failing',
          title: 'The OpenADLC app does not have “SSH signing keys”',
          detail: 'Add “SSH signing keys” on the app’s permissions page, under Account permissions, as **Read and write**.',
          action: { label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions' },
        }),
        view({
          id: 'signing-key:bot-builder',
          check: 'signing-key',
          state: 'failing',
          title: 'fleetadlc-atlas-janedoe’s signing key is not on its GitHub account',
          action: { label: 'Reconnect fleetadlc-atlas-janedoe', href: '/settings#github-accounts' },
          waitingFor: ['app-permissions:git_signing_ssh_public_keys'],
        }),
        view({ id: 'token-expiry', check: 'token-expiry', state: 'failing', severity: 'warning', title: 'The OpenADLC app’s user tokens never expire' }),
        view({ id: 'hostd', check: 'hostd', state: 'failing', title: 'OpenADLC’s host service is not answering', action: { label: 'Run fleetadlc up', command: 'fleetadlc up' } }),
        view({ id: 'webhook', check: 'webhook', state: 'unknown', proves: 'GitHub delivers', detail: 'nothing has happened on GitHub yet' }),
      ],
      'http://127.0.0.1:47300/',
    );

    expect(lines).toEqual([
      { level: 'fail', text: 'The OpenADLC app does not have “SSH signing keys”' },
      { level: 'note', text: 'Add “SSH signing keys” on the app’s permissions page, under Account permissions, as Read and write.' },
      { level: 'note', text: '→ Open the app’s permissions: https://github.com/settings/apps/fleetadlc-janedoe/permissions' },
      { level: 'fail', text: 'fleetadlc-atlas-janedoe’s signing key is not on its GitHub account' },
      { level: 'note', text: '→ Reconnect fleetadlc-atlas-janedoe: http://127.0.0.1:47300/settings#github-accounts' },
      { level: 'note', text: 'after: app-permissions:git_signing_ssh_public_keys' },
      { level: 'warn', text: 'The OpenADLC app’s user tokens never expire' },
      { level: 'fail', text: 'OpenADLC’s host service is not answering' },
      { level: 'note', text: '→ Run fleetadlc up: run `fleetadlc up`' },
      { level: 'unknown', text: 'GitHub delivers — not known yet: nothing has happened on GitHub yet' },
    ]);
    // Three blocking failures, whatever the warning; doctor exits non-zero on these.
    expect(blocking).toBe(3);
  });
});

describe('fleetadlc doctor asking the bridge', () => {
  const ports = { console: 47300, bridge: 47311, hostd: 47312, postgres: 47432 };
  // The bridge serves `/v1` only beside the console secret, which the CLI reads from the store.
  const store = {
    get: async (ref: string) => (ref === 'console-api-secret' ? 'c'.repeat(64) : null),
    set: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs every check now, and counts the blocking failures it will exit non-zero on', async () => {
    const asked: string[] = [];
    const secrets: (string | undefined)[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      asked.push(`${init?.method ?? 'GET'} ${String(input)}`);
      secrets.push((init?.headers as Record<string, string> | undefined)?.['x-fleetadlc-console-secret']);
      return new Response(
        JSON.stringify({
          checks: [
            { id: 'hostd', check: 'hostd', state: 'failing', severity: 'blocking', title: 'OpenADLC’s host service is not answering', proves: 'x', waitingFor: [], action: null, detail: null },
            { id: 'token-expiry', check: 'token-expiry', state: 'failing', severity: 'warning', title: 'The OpenADLC app’s user tokens never expire', proves: 'x', waitingFor: [], action: null, detail: null },
          ],
        }),
        { status: 200 },
      );
    });

    expect(await checkHealth({ ports }, store)).toBe(1);
    expect(asked).toEqual(['POST http://127.0.0.1:47311/v1/health/run']);
    expect(secrets).toEqual(['c'.repeat(64)]);
  });

  it('says the bridge could not be asked, rather than that nothing is wrong', async () => {
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(line));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:47311'));

    expect(await checkHealth({ ports }, store)).toBeNull();
    expect(printed.join('\n')).toContain('the bridge could not run its health checks');
  });

  it('says to start the install when it has no console secret to ask with', async () => {
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(line));
    const fetched = vi.spyOn(globalThis, 'fetch');

    expect(await checkHealth({ ports }, { ...store, get: async () => null })).toBeNull();
    expect(fetched).not.toHaveBeenCalled();
    expect(printed.join('\n')).toContain('start it with `fleetadlc up`');
  });
});

describe('fleetadlc doctor with the bridge down', () => {
  // A bridge that did not answer added nothing: doctor said "no problems
  // found" and exited 0 while nothing that needs the bridge was running.
  const ports = { console: 47300, bridge: 47311, hostd: 47312, postgres: 47432 };
  const store = {
    get: async (ref: string) => (ref === 'console-api-secret' ? 'c'.repeat(64) : null),
    set: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
  };
  const failures = () => {
    const said: string[] = [];
    return { said, fail: (message: string, hint?: string) => void said.push(`${message} — ${hint ?? ''}`) };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts a bridge that refuses the connection as a problem, with what to do', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:47311'));
    const { said, fail } = failures();

    expect(await bridgeProblems({ ports }, fail, store)).toBe(0);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('the bridge is not answering on :47311');
    expect(said[0]).toContain('fleetadlc up');
    expect(said[0]).toContain('fleetadlc logs bridge');
  });

  it('counts a bridge that answers with an error as a problem', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    const { said, fail } = failures();

    await bridgeProblems({ ports }, fail, store);
    expect(said).toHaveLength(1);
  });

  it('counts nothing more when the bridge answers with no blocking failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ checks: [] }), { status: 200 }));
    const { said, fail } = failures();

    expect(await bridgeProblems({ ports }, fail, store)).toBe(0);
    expect(said).toEqual([]);
  });
});

describe('fleetadlc doctor on which database it tried', () => {
  const config = { databaseUrl: 'postgres://fleetadlc:install-secret@127.0.0.1:47432/fleetadlc_db' };

  it('names the url the connection used, not install.json’s', () => {
    // It connected with an exported url and, when that failed, named
    // install.json's: a database that worked.
    const used = databaseInUse(config, { DATABASE_URL: 'postgres://u:shell-secret@db.example.com:5433/other_db' });
    expect(unreachableDatabaseHint(used)).toBe('DATABASE_URL points at other_db on db.example.com:5433');
    expect(unreachableDatabaseHint(databaseInUse(config, {}))).toBe('DATABASE_URL points at fleetadlc_db on 127.0.0.1:47432');
  });

  it('says which database under the install’s path, without a password', () => {
    expect(databaseLine(databaseInUse(config, {}))).toBe('database: fleetadlc_db on 127.0.0.1:47432');
    expect(databaseLine(config.databaseUrl)).not.toContain('secret');
  });
});

describe('fleetadlc status on who a request is from', () => {
  // The bridge's start-up line said which identity path was in force, and the
  // docs said `fleetadlc status` did too; it printed nothing of the kind.
  const store = {
    get: async (ref: string) => (ref === 'console-api-secret' ? 'c'.repeat(64) : null),
    set: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('prints the sentence the bridge reports', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { status } = await import('./doctor.js');
    const home = mkdtempSync(join(tmpdir(), 'fleetadlc-status-'));
    vi.stubEnv('FLEETADLC_HOME', home);
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(line));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (!String(input).endsWith('/v1/status')) return new Response('{}', { status: 200 });
      return new Response(
        JSON.stringify({
          board: {},
          budget: { spentUsd: 0, capUsd: 100, state: 'ok' },
          openGates: 0,
          activeLeases: 0,
          crew: [],
          identity: { mode: 'iap', detail: 'verified IAP assertion for audience /projects/1/global/backendServices/2' },
        }),
        { status: 200 },
      );
    });
    try {
      const config = { ports: { console: 47300, bridge: 47311, hostd: 47312, postgres: 47432 }, databaseUrl: 'postgres://u:p@127.0.0.1:47432/fleetadlc_db' };
      await status(config as never, store);
      const output = printed.join('\n');
      expect(output).toContain('Identity');
      expect(output).toContain('verified IAP assertion for audience /projects/1/global/backendServices/2');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
