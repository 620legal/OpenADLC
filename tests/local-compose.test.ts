import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The local compose file used to pass an empty webhook secret through, and the
 * bridge treated empty as "do not check". The bridge no longer does that, and
 * the file has to give the container a secret rather than an empty default.
 */
const compose = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'local', 'docker-compose.yml'),
  'utf8',
);

const HOME = '${OPENADLC_COMPOSE_HOME:-${HOME}/.openadlc-compose}';
const service = (name: string) => compose.split(/\n {2}(?=[a-z]+:\n)/).find((part) => part.startsWith(`${name}:`)) ?? '';

describe('the local compose file', () => {
  it('has no default database password, and does not publish the database on the host', () => {
    // `openadlc` was the default, printed here, and the port was published on
    // every address: anything that reached the host logged in as superuser.
    expect(compose).not.toContain(':-openadlc');
    const required = '${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD';
    expect(service('db')).toContain(`POSTGRES_PASSWORD: ${required}`);
    for (const name of ['setup', 'hostd', 'bridge']) {
      expect(service(name)).toContain(`DATABASE_URL: postgres://openadlc:${required}`);
      expect(service(name)).toContain('@db:5432/openadlc_db');
    }
    // The services reach it as db:5432 on the compose network.
    expect(service('db')).not.toMatch(/^ {4}ports:/m);
    expect(compose).not.toContain(':5432\'');
  });

  it('generates a webhook secret instead of starting the bridge with none', () => {
    expect(compose).toContain('randomBytes(32)');
    expect(compose).toContain('/var/lib/openadlc/webhook-secret');
    expect(compose).toContain('webhook-secret:/var/lib/openadlc');
  });

  it('does not print the secret it generates', () => {
    expect(compose).not.toMatch(/echo[^\n]*OPENADLC_WEBHOOK_SECRET/);
    expect(compose).not.toMatch(/console\.log\([^\n]*webhook/i);
  });

  it('gives hostd and the bridge one install home, where the secret store they share is', () => {
    // The secret store is `$OPENADLC_HOME/secrets`. The file mounted a directory
    // at /secrets, which nothing reads, and set no OPENADLC_HOME, so each
    // container kept its own store: hostd never found the internal secret the
    // bridge wrote, and refused every call from it.
    for (const name of ['hostd', 'bridge']) {
      expect(service(name)).toContain(`OPENADLC_HOME: ${HOME}/home`);
      expect(service(name)).toContain(`- ${HOME}:${HOME}`);
    }
    expect(compose).not.toContain(':/secrets');
  });

  it('mounts the install home at the same path it has on the host, so a bot task’s mounts resolve there', () => {
    // hostd drives the host's daemon, which resolves every bind mount it gives a
    // bot on the host. /work inside hostd's container was nothing out there.
    const hostd = service('hostd');
    for (const variable of ['OPENADLC_WORK_ROOT', 'OPENADLC_SKILLS_ROOT', 'OPENADLC_ROLES_ROOT', 'OPENADLC_RUNNER_BUNDLE', 'OPENADLC_GH_SHIM_DIR']) {
      expect(hostd).toMatch(new RegExp(`${variable}: \\$\\{OPENADLC_COMPOSE_HOME:-\\$\\{HOME\\}/\\.openadlc-compose\\}/`));
    }
    expect(hostd).toContain('OPENADLC_HOSTD_TASK_BRIDGE_URL: http://host.docker.internal:${OPENADLC_BRIDGE_PORT:-47311}');
    expect(hostd).toContain('OPENADLC_HOSTD_TASK_HOSTD_URL: http://host.docker.internal:${OPENADLC_HOSTD_PORT:-47312}');
    expect(compose).not.toContain('- work:/work');
  });

  it('applies the migrations before it starts the services, as openadlc up does', () => {
    expect(compose).toContain('node packages/db/dist/cli/migrate.js');
    // hostd, the bridge, and the console, which mounts the secret setup writes.
    expect(compose.match(/condition: service_completed_successfully/g)).toHaveLength(3);
  });

  it('makes the console secret in the install home when it is missing, as openadlc up does', () => {
    // The bridge serves `/v1` only beside it; without one the console is refused.
    const setup = service('setup');
    expect(setup).toContain(`OPENADLC_HOME: ${HOME}/home`);
    expect(setup).toContain(`- ${HOME}:${HOME}`);
    expect(setup).toContain('secret="$$OPENADLC_HOME/secrets/console-api-secret.secret"');
    expect(setup).toContain('if [ ! -s "$$secret" ]; then');
    expect(setup).toContain('umask 077');
    expect(setup).toContain('randomBytes(32).toString("hex")');
    expect(setup).not.toMatch(/echo[^\n]*secret"/);
  });

  it('gives the console that one secret, read-only, and not the install home', () => {
    const served = service('console');
    expect(served).toContain('type: bind');
    expect(served).toContain(`source: ${HOME}/home/secrets/console-api-secret.secret`);
    expect(served).toContain('target: /run/openadlc/console-api-secret.secret');
    expect(served).toContain('read_only: true');
    // The whole home holds every sign-in and key; the console must not see them.
    expect(served).not.toContain(`- ${HOME}:${HOME}`);
    expect(served).not.toContain(`${HOME}/home:`);
    // Exported before Next starts, so the console's server carries it to the bridge.
    expect(served).toMatch(/OPENADLC_CONSOLE_SECRET="\$\$\(tr -d "\\n" < \/run\/openadlc\/console-api-secret\.secret\)"\n\s+export OPENADLC_CONSOLE_SECRET\n\s+exec pnpm start/);
  });

  it('publishes the console on 127.0.0.1 unless OPENADLC_CONSOLE_HOST says otherwise', () => {
    const served = service('console');
    expect(served).toContain("- '${OPENADLC_CONSOLE_HOST:-127.0.0.1}:${OPENADLC_CONSOLE_PORT:-47300}:47300'");
    // Inside the container it listens everywhere, or the published port reaches nothing.
    expect(served).toContain("OPENADLC_CONSOLE_HOST: '0.0.0.0'");
  });

  it('starts the services when the seed reports a problem, as openadlc up does', () => {
    // A refused seat sets the seed's exit code; only a failed migration is fatal.
    expect(compose).toContain('node packages/db/dist/cli/seed.js || echo');
  });

  it('restarts hostd, the bridge and the console when they exit, as openadlc up’s keeper does', () => {
    // A process that died on a lost database connection stayed down.
    for (const name of ['hostd', 'bridge', 'console']) {
      expect(service(name)).toMatch(/\n {4}restart: unless-stopped\n/);
    }
  });

  it('no longer says bot tasks do not run under it', () => {
    expect(compose).not.toContain('Bot tasks do not run under it');
  });

  it('names and labels its bots as its own install, so it never takes the default install’s', () => {
    // Container names are global on a daemon, and both installs seat a builder.
    const hostd = service('hostd');
    expect(hostd).toContain('OPENADLC_BOT_PREFIX: ${COMPOSE_PROJECT_NAME}-bot-');
    expect(hostd).toContain('OPENADLC_INSTALL_ID: compose-${COMPOSE_PROJECT_NAME}');
  });

  it('runs a bot image of its own, which its engine update replaces and rolls back beside openadlc up’s', () => {
    // The update builds `<repo>:candidate` and keeps `<repo>:previous` after
    // whatever `:latest` hostd runs; on the default `openadlc-bot:latest` the
    // compose stack's update retagged the image `openadlc up`'s bots run.
    const hostd = service('hostd');
    const image = /OPENADLC_BOT_IMAGE: (\S+)/.exec(hostd)?.[1] ?? '';
    expect(image).toBe('compose-${COMPOSE_PROJECT_NAME}-bot:latest');
    expect(image.startsWith('openadlc-bot:')).toBe(false);
    // Built on first start when the project has none, with the script a person runs.
    expect(hostd).toContain('docker image inspect "$$OPENADLC_BOT_IMAGE"');
    expect(hostd).toContain('IMAGE="$$OPENADLC_BOT_IMAGE" env -u NODE_VERSION -u GH_VERSION -u GH_FROM infra/local/build-bot-image.sh');
  });

  it('builds the bot image on the script’s own pins, not the NODE_VERSION hostd’s node:* image exports', () => {
    const hostd = service('hostd');
    const build = hostd.split('\n').find((line) => line.includes('IMAGE="$$OPENADLC_BOT_IMAGE"')) ?? '';
    for (const name of ['NODE_VERSION', 'GH_VERSION', 'GH_FROM']) expect(build).toContain(`-u ${name}`);
    expect(build.indexOf('env -u')).toBeLessThan(build.indexOf('infra/local/build-bot-image.sh'));
  });

  it('refuses a relative home and ports that do not move together, before hostd starts', () => {
    const hostd = service('hostd');
    expect(hostd).toContain('OPENADLC_COMPOSE_HOME must be an absolute path');
    expect(hostd).toContain('OPENADLC_BRIDGE_PORT and OPENADLC_HOSTD_PORT must move together');
    expect(hostd).toMatch(/bridge:\n\s+condition: service_started/);
  });

  it('refreshes the assets in the directories that are there, rather than swapping them', () => {
    // On Linux a bot's bind mount holds the directory it was given; a swapped
    // one left every existing bot with a deleted, empty directory.
    const hostd = service('hostd');
    expect(hostd).not.toMatch(/mv "\$\$assets\.new"/);
    expect(hostd).toContain('find "$$assets/$$name" -mindepth 1 -delete');
  });

  it('hands an install the root images made to uid 1000 before the services start, and only what is not already its', () => {
    // The bridge and hostd now run as uid 1000; an older install's home/,
    // work/ and webhook-secret volume were root's, and nobody is asked to
    // chown them by hand.
    const setup = service('setup');
    expect(setup).toContain("user: '0:0'");
    expect(setup).toContain('- webhook-secret:/var/lib/openadlc');
    expect(setup).toContain('find "$$1" ! -uid 1000 -exec chown -h 1000:1000 {} +');
    for (const dir of ['own /var/lib/openadlc', 'own "$$OPENADLC_HOME"', 'own "$$OPENADLC_COMPOSE_HOME/work"']) {
      expect(setup, dir).toContain(dir);
      expect(setup.indexOf(dir), dir).toBeLessThan(setup.indexOf('node packages/db/dist/cli/migrate.js'));
    }
    // After the console secret is made, or that file stays root's and the console cannot read it.
    expect(setup.indexOf('console-api-secret.secret')).toBeLessThan(setup.indexOf('own "$$OPENADLC_HOME"'));
    // A path it cannot hand over stops the start, named.
    expect(setup).toContain('echo "[setup] could not give $$1 to uid 1000');
    expect(setup).toMatch(/could not give[^\n]*\n\s*exit 1/);
    // assets/ stays root's.
    expect(setup).not.toMatch(/own[^\n]*assets/);
  });

  it('runs the bridge and the console as uid 1000', () => {
    expect(service('bridge')).toContain("user: '1000:1000'");
    expect(service('console')).toContain("user: '1000:1000'");
  });

  it('copies hostd’s assets as root, then runs hostd as uid 1000 with the Docker socket’s group', () => {
    const hostd = service('hostd');
    expect(hostd).toContain("user: '0:0'");
    expect(hostd).not.toContain('exec node apps/hostd/dist/main.js');
    const drop = 'exec setpriv --reuid=1000 --regid=1000 --groups="$$(stat -c %g /var/run/docker.sock)" node apps/hostd/dist/main.js';
    expect(hostd).toContain(drop);
    expect(hostd.indexOf('cp -R "$$from/." "$$assets/$$name/"')).toBeLessThan(hostd.indexOf(drop));
    expect(hostd.indexOf('export HOME=/home/node')).toBeLessThan(hostd.indexOf(drop));
  });

  it('hands hostd a private registry from the shell, as openadlc up does', () => {
    // Without it a task on a compose install never got a registry credential:
    // hostd answered that there was no registry, and the install was refused.
    expect(service('hostd')).toContain('OPENADLC_REGISTRY_HOST: ${OPENADLC_REGISTRY_HOST:-}');
  });
});
