import { join } from 'node:path';
import { bots, closePool, hosts, modelAccounts, repos, tasks, waitForDatabase } from '@fleetadlc/db';
import { getSecretStore, internalSecretRef } from '@fleetadlc/github';
import { AttachTokens } from './attach-tokens.js';
import { DEFAULT_LOCAL_CI_TIMEOUT_MINUTES, loadHostdConfig } from './config.js';
import { TerminalGateway } from './terminal-gateway.js';
import { DockerDriver, docker } from './drivers/docker.js';
import { EngineUpdater, candidateCredential, candidateModels } from './engine-updates.js';
import { LocalDriver } from './drivers/local.js';
import type { ExecDriver } from './drivers/types.js';
import { LoginService, moveSignInsIntoPlace, removeAdoptCopies } from './logins.js';
import { SessionObserver } from './observer.js';
import { isRefusal, RegistryCredentials } from './registry.js';
import { createHostdServer } from './server.js';
import { TaskDatabases, taskdbBindAddress } from './task-db.js';
import { WarmPool } from './warm-pool.js';
import { repoKeyOf } from './drivers/base-env.js';
import { TaskRunner } from './task-runner.js';
import { LocalCi, bridgeReporter } from './local-ci.js';
import { TokenClient } from './token-client.js';

async function main(): Promise<void> {
  const config = loadHostdConfig();
  await waitForDatabase();

  const botImage = process.env.FLEETADLC_BOT_IMAGE ?? 'fleetadlc-bot:latest';
  // One Postgres per host, a database per task; see `TaskDatabases`. The
  // default install's is `fleetadlc-taskdb`; another install's is its own.
  const databases =
    config.driver === 'docker'
      ? new TaskDatabases({
          docker,
          container: config.botPrefix ? `${config.botPrefix}taskdb` : 'fleetadlc-taskdb',
          image: process.env.FLEETADLC_TASKDB_IMAGE ?? process.env.FLEETADLC_SIDECAR_IMAGE ?? 'pgvector/pgvector:pg16',
          installLabel: `fleetadlc.install=${config.installId ?? 'default'}`,
          bindAddress: await taskdbBindAddress(docker, config.taskdbBind ?? null),
          // What a task role's password is derived from, so an adopted
          // computer's URL can be rebuilt; read when asked, since the bridge
          // makes it and may start after hostd.
          key: () => getSecretStore().get(internalSecretRef()),
        })
      : null;
  const dockerDriver =
    config.driver === 'docker'
      ? new DockerDriver({
          image: botImage,
          // Where each seat's network was, before a task had its own computer:
          // only to retire them. The default install's kept the old names.
          networkPrefix: config.botPrefix ? `${config.botPrefix}net` : 'fleetadlc-bot',
          ...(config.botPrefix ? { botPrefix: config.botPrefix } : {}),
          ...(config.installId ? { installId: config.installId } : {}),
          workRoot: config.workRoot,
          runnerBundle: config.runnerBundle ?? join(import.meta.dirname, 'skill-runner.bundle.mjs'),
          ...(config.ghShimDir ? { ghShimDir: config.ghShimDir } : {}),
          skillsRoot: config.skillsRoot,
          rolesRoot: config.rolesRoot,
          hostdUrl: config.taskHostdUrl ?? `http://host.docker.internal:${config.port}`,
          loginRoot: config.loginRoot,
          egressProxy: process.env.FLEETADLC_BOT_EGRESS_PROXY || undefined,
          ...(databases ? { databases } : {}),
          // Read when a pnpm store is filled, so a rotation takes at the next fill.
          registry: async () => {
            const grant = await new RegistryCredentials(config.registryHost).grant();
            return isRefusal(grant) ? null : { host: grant.host, token: grant.token };
          },
        })
      : null;
  const driver: ExecDriver = dockerDriver ?? new LocalDriver(config.tmuxBin, config.workRoot, config.loginRoot);

  const host = await hosts.registerHost({
    name: config.hostName,
    zone: config.zone,
    driver: driver.kind,
    capacityBots: config.capacityBots,
    capacityTasks: config.capacityTasks,
  });

  // No refresh token lives here: tokens come from the bridge's token service,
  // which is the install's only broker.
  const tokens = new TokenClient(config.bridgeUrl);

  // Signing a subscription in, and checking any account, happen here because
  // this is where the bots think: the same image, the same login directory,
  // the same credential a session would be given. It is also what asks an
  // xAI seat's CLI which models it can call, for a task resolving
  // `newest:grok` and for the picker alike.
  const secretStore = getSecretStore();
  const logins = new LoginService({
    driver: driver.kind,
    loginRoot: config.loginRoot,
    image: botImage,
    store: secretStore,
  });
  // A backup's sign-in left mid-check by the last hostd; see `removeAdoptCopies`.
  removeAdoptCopies(config.loginRoot);
  // Where an earlier build kept each sign-in; see `moveSignInsIntoPlace`.
  moveSignInsIntoPlace(config.loginRoot);

  const runner = new TaskRunner(config, driver, tokens, undefined, (accountId) => logins.models(accountId));
  runner.hostId = host.id;

  // Computers made ahead of their task, when the install asks for them. One
  // for work on no repository, one for each repository worked in during the
  // last two hours, within what the host has room for beside its tasks.
  if (dockerDriver && config.warmPool) {
    dockerDriver.usePool(
      new WarmPool({
        host: dockerDriver,
        enabled: true,
        max: config.warmPoolMax ?? 3,
        room: () => config.capacityTasks - runner.computersHeld(),
        activeRepos: async () => {
          const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
          const names = new Map((await repos.listRepos()).map((repo) => [repo.id, repo.fullName]));
          const keys = (await tasks.listTasksSince(since))
            .filter((task) => Date.parse(task.createdAt) >= since.getTime() && task.repoId)
            .map((task) => repoKeyOf(names.get(task.repoId ?? '') ?? null))
            .filter((key): key is string => Boolean(key));
          return [...new Set(keys)];
        },
        log: (line) => console.log(line),
      }),
    );
  }
  // The runner is passed so a task the database has finished with does not
  // leave this host holding a container that looks busy for ever, and so the
  // reaper can take back computers that outlived the last hostd.
  const observer = new SessionObserver(driver, config.hostName, 10_000, runner, config.pausedKeepMinutes * 60_000);

  // Each bot kept a mirror of every repository it worked in, and a paused
  // task's unpushed commits were in its bot's. Mirrors are one per repository
  // now, so those are carried across before any clone is cleared or resumed.
  const crewNow = await bots.listBots();
  const repoNames = new Map((await repos.listRepos({ includeRemoved: true })).map((repo) => [repo.id, repo.fullName]));
  const paused = (await tasks.listTasks({ states: ['paused'], limit: 500 }).catch(() => []))
    .map((task) => ({
      taskId: task.id,
      bot: crewNow.find((bot) => bot.id === task.botId)?.name ?? '',
      repoFullName: (task.repoId && repoNames.get(task.repoId)) || '',
      branch: task.branch ?? '',
    }))
    .filter((task) => task.bot && task.repoFullName && task.branch);
  const imported = await runner.importLegacyMirrors(paused).catch(() => ({ tasks: 0, mirrors: 0 }));
  if (imported.tasks + imported.mirrors > 0) {
    console.log(`[hostd] carried ${imported.tasks} paused task(s) and ${imported.mirrors} bot mirror(s) into the per-repository mirrors`);
  }

  // The worktrees the per-seat layout left in each bot's folder belong to no
  // computer now: their branches are kept in the mirror, and they go.
  for (const bot of crewNow) {
    const pruned = await runner.pruneAbandonedWorktrees(bot.name).catch(() => 0);
    if (pruned > 0) console.log(`[hostd] ${bot.name}: cleared ${pruned} worktree(s) left by tasks that had ended`);
  }

  if (dockerDriver) {
    // The install's network for task computers and its task database server,
    // before the first task needs either. Neither failing stops hostd: a task
    // start says what is wrong, where a person is looking.
    await dockerDriver.ensureNetwork().catch((error: unknown) => {
      console.warn(`[hostd] the task network is not ready: ${error instanceof Error ? error.message : error}`);
    });
    await databases?.ensure().catch((error: unknown) => {
      console.warn(`[hostd] the task database server is not ready; tasks start without a database until it is: ${error instanceof Error ? error.message : error}`);
    });
    // Each seat's own container from before, for every seat with nothing
    // running in it; one still running a task is retired at a later start.
    const seats = await Promise.all(
      crewNow.map(async (bot) => ({ name: bot.name, busy: (await tasks.countActiveTasksForBot(bot.id).catch(() => 1)) > 0 })),
    );
    await dockerDriver.retireSeats(seats).catch((error: unknown) => {
      console.warn(`[hostd] could not retire the seats' old containers: ${error instanceof Error ? error.message : error}`);
    });
  } else {
    // Sessions named before the rename, which nothing else here looks for.
    if (driver instanceof LocalDriver) {
      await driver.retireLegacySessions().catch((error: unknown) => {
        console.warn(`[hostd] could not look for sessions from before the rename: ${error instanceof Error ? error.message : error}`);
      });
    }
    // Under the local driver every bot keeps an idle shell on the host, so the
    // crew is attachable before any task starts.
    for (const bot of crewNow) {
      await driver.ensureBot(bot.name).catch((error: unknown) => {
        console.warn(`[hostd] could not prepare ${bot.name}: ${error instanceof Error ? error.message : error}`);
      });
    }
  }

  // Computers that outlived the last hostd: a running task's is taken back,
  // so its session is watched and it ends as it would have; a finished one's
  // goes; task folders nobody holds are cleared, their branches kept. Before
  // the observer starts, so its first look at the sessions finds them held.
  await observer.reapComputers().catch((error: unknown) => {
    console.warn(`[hostd] could not square the computers on this host with their tasks: ${error instanceof Error ? error.message : error}`);
  });
  observer.start();

  // hostd does not own this secret and does not create it: the bridge does,
  // because the bridge owns the token service it admits. `fleetadlc up` starts hostd
  // first, so it may not exist yet — read it on demand and keep it once found,
  // rather than caching a miss for the life of the process and refusing the
  // bridge forever.
  let cachedSecret: string | null = null;
  const secret = async (): Promise<string | null> => {
    if (cachedSecret) return cachedSecret;
    cachedSecret = await secretStore.get(internalSecretRef());
    return cachedSecret;
  };

  // The weekly engine update: this is the process that owns Docker and the
  // bot image, and the one that knows what a task on each bot would present.
  // `fleetadlc up` runs hostd from the repository, which is where the build
  // script is; the bridge decides when.
  const engineUpdates = new EngineUpdater({
    driver: driver.kind,
    image: botImage,
    buildScript: process.env.FLEETADLC_BOT_IMAGE_SCRIPT ?? join(process.cwd(), 'infra/local/build-bot-image.sh'),
    buildProxy: process.env.FLEETADLC_BOT_EGRESS_PROXY || undefined,
    crew: () => bots.listBots(),
    account: async (id) => {
      const account = await modelAccounts.get(id);
      return account ? { id: account.id, provider: account.provider, kind: account.kind, label: account.label } : null;
    },
    chooseModelFor: candidateModels((accountId, image, name) => logins.modelsIn(accountId, image, name), 'fleetadlc-engines'),
    credential: candidateCredential({
      store: secretStore,
      loginRoot: config.loginRoot,
      locate: (accountId) => driver.loginPath(accountId),
    }),
    callModel: (call) => logins.callModel(call),
    // A computer is made from the image when its task starts, so the next
    // task runs on the new one and a running task finishes on its own.
    refresh: async () => (dockerDriver ? dockerDriver.refreshComputers() : { refreshed: [], deferred: [] }),
  });

  // The repository's checks on a task's head, which the bridge records from
  // what this reports, never from what a session says.
  const localCi = new LocalCi(
    driver,
    (taskId) => runner.localCiTarget(taskId),
    bridgeReporter(config.bridgeUrl, secretStore),
    Date.now,
    (config.localCiTimeoutMinutes ?? DEFAULT_LOCAL_CI_TIMEOUT_MINUTES) * 60_000,
  );

  const attachTokens = new AttachTokens();
  const server = createHostdServer({
    config,
    driver,
    runner,
    attachTokens,
    registry: new RegistryCredentials(config.registryHost, secretStore),
    perTaskCapUsd: Number(process.env.FLEETADLC_PER_TASK_CAP_USD ?? '15'),
    secret,
    logins,
    engineUpdates,
    localCi,
  });

  // Take-over rides on the same port: the console opens a socket at /terminal
  // with a token the bridge obtained for it.
  new TerminalGateway(driver, (token) => attachTokens.redeem(token)).attachTo(server);

  server.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[hostd] ${config.hostName} (${driver.kind} driver) listening on :${config.port}`,
    );
    console.log(`[hostd] host id ${host.id}; work root ${config.workRoot}; logins under ${config.loginRoot}`);
    console.log(`[hostd] task tokens come from the bridge's token service at ${config.bridgeUrl}`);
  });

  const shutdown = async (): Promise<void> => {
    console.log('[hostd] draining');
    observer.stop();
    // A task paused on a person's answer is kept: its answer starts it again.
    const drained = await runner.drain('hostd shutting down');
    if (drained.timedOut.length > 0) {
      console.warn(`[hostd] did not finish stopping ${drained.timedOut.join(', ')} in time; the next start adopts or cleans up each`);
    }
    // A sign-in container outlives the process that started it otherwise,
    // holding its code open for the rest of fifteen minutes.
    await logins.stopAll().catch(() => undefined);
    server.close();
    await closePool();
    process.exit(0);
  };

  // Once: the keeper forwards the stop signal again after 8 s, and a second
  // drain and a second `closePool()` mid-shutdown were what it started.
  let stopping: Promise<void> | null = null;
  const stopOnce = (): void => {
    stopping ??= shutdown();
  };
  process.on('SIGINT', stopOnce);
  process.on('SIGTERM', stopOnce);
}

// A promise nobody awaited that rejects would end the service, and with it
// what only its memory holds. It is logged with its stack and the service
// carries on; an uncaught exception still ends it.
process.on('unhandledRejection', (reason) => {
  console.error('[hostd] a promise rejected with nothing to catch it:', reason instanceof Error ? reason.stack : reason);
});

main().catch((error) => {
  console.error('[hostd] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
