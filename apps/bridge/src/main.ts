import { heldBySeatPause, registerSeatPauseRoutes, seatPausedReason } from './seat-pause.js';
import { createServer } from 'node:http';
import { audit as auditEntry, bots, ciUsage, closePool, costs, deployRuns, issues as issueStore, leases as leaseStore, repos, settings, tasks, threads as threadStore, waitForDatabase } from '@fleetadlc/db';
import { registerPauseRoutes, restorePause } from './pause-work.js';
import { accountOf, appPrivateKeyRef, appVisibility, ensureAlertsSecret, ensureConsoleSecret, ensureInternalSecret, getSecretStore, installationTokenFor, redeliverFailedSince } from '@fleetadlc/github';
import { sameLogin } from '@fleetadlc/shared';
import { Actors } from './actors.js';
import { registerConsoleApi, retryDepsFor, stopTask } from './api.js';
import { SendBack } from './send-back.js';
import { DeliveryKnowledge } from './delivery-rules.js';
import { DeployPipeline } from './deploy-pipeline.js';
import { isPrerequisiteRow } from './health/checks/crew.js';
import { retryTask } from './task-retry.js';
import { AppReach } from './app-reach.js';
import { capReason as ciCapReason, monthStart as ciMonthStart, parseCap as parseCiCap, recordRun as recordCiRun, everyJob } from './ci-usage.js';
import { asAutomation, automationBotName } from './automation-bot.js';
import { accountIdOf, accountTypeOf } from './github-accounts.js';
import { defaultBackupDeps, registerBackupRoutes } from './backup.js';
import { sweepExpiredUndo } from './restore-into.js';
import { Automation } from './automation.js';
import { BotNames } from './bot-names.js';
import { loadBridgeConfig } from './config.js';
import { Context } from './context.js';
import { DispatchGate } from './dispatch-gate.js';
import { Gates, subjectClosed } from './gates.js';
import { readDefaultBranch, syncDefaultBranches } from './default-branch.js';
import { Notifier } from './notify.js';
import { identityFromConfig } from './identity.js';
import { HostdClient } from './hostd-client.js';
import { NO_CLIENT_ID, registerInternalApi } from './internal-api.js';
import { MergeLine } from './merge-line.js';
import { Onboarding } from './onboarding.js';
import { effectiveConfig, moveWebhookSecretToStore } from './effective-config.js';
import { engineUpdatesFor } from './engine-updates.js';
import { APP_API, InvitationService } from './invitation-service.js';
import { CrewAccessKeeper } from './crew-access.js';
import { Reconciler } from './reconciler.js';
import { JobTimer } from './job-timer.js';
import { Router } from './router.js';
import { REQUEST_SWEEP_MS, RequestQueue } from './request-queue.js';
import { WatermarkStream } from './thread-stream.js';
import { Scheduler, retryAfterRecovery } from './scheduler.js';
import { StageHandoff } from './stage-handoff.js';
import { TaskService } from './task-service.js';
import { Webhooks } from './webhooks.js';
import { WebhookSetup } from './webhook-setup.js';
import { RepoSetup } from './repo-setup.js';
import { Attribution } from './attribution.js';
import { sayDesignMemoryWith } from './design-memory.js';
import { AppGate } from './app-gate.js';
import { actsForOn, askAsTheApp, theApp } from './people.js';
import { resolveHumanIdsWith } from './human-ids.js';
import { UnlabeledIntake, openIssuesOn } from './unlabeled-intake.js';
import { ConflictRounds } from './conflict-round.js';
import { Stacking } from './stacking.js';
import { startBuild } from './build-start.js';
import { recordUnowned } from './unowned-issues.js';
import { registerItemControlRoutes } from './item-controls.js';
import { registerUnownedRoutes } from './unowned-routes.js';
import { registerDeployRoutes } from './deploy-routes.js';
import { resolveItem } from './items.js';
import { botNames, defaultChecks, settingUp } from './health/index.js';
import { anythingDispatches, dispatchModeOf } from './health/checks/dispatcher.js';
import { HealthRegistry } from './health/registry.js';
import { Dispatcher } from '@fleetadlc/dispatcher';
import { DispatchRunner } from './dispatch-runner.js';
import { abandonRequest, RequestFiling } from './request-lifecycle.js';
import { authorize, listFromEnv, Roles } from './roles.js';
import { liveUsersDeps, registerUsersRoutes } from './users-routes.js';

async function main(): Promise<void> {
  const config = loadBridgeConfig();
  await waitForDatabase();
  await costs.ensureBudget(costs.currentPeriod(), config.costs.monthlyCapUsd, config.costs.warningAt);

  // The bridge owns the shared secret because it owns the token service; hostd
  // reads it, and generating it here means an operator has nothing to set. It is
  // established before the hostd client exists, because that client now has to
  // present it on every call.
  const internalSecret = await ensureInternalSecret();
  // What an outside monitor holds to reach `/internal/alerts`, and nothing else.
  const alertsSecret = await ensureAlertsSecret();
  const hostd = new HostdClient(config.hostdUrl, internalSecret);
  // An older install kept the webhook secret in the settings table, and so in
  // every dump of the database. Moved before the first delivery is checked;
  // left where it was when the store cannot be written, which the bridge
  // still reads.
  await moveWebhookSecretToStore()
    .then((done) => {
      if (done === 'moved') console.log('[bridge] moved the webhook secret from the settings table into the secret store');
      if (done === 'dropped') console.log('[bridge] deleted the settings table’s copy of the webhook secret; the secret store already had one');
    })
    .catch((error: unknown) => console.warn(`[bridge] the webhook secret stays in the settings table for now: ${error instanceof Error ? error.message : 'unknown error'}`));
  // Throws in `iap` mode with no audience, rather than starting an install whose
  // identity check verifies a signature and then accepts anybody's. In `local`
  // mode `/v1` is served only to a caller holding the console secret; iap mode
  // never reads it.
  const identity = identityFromConfig(
    config.identityMode,
    config.iapAudience,
    config.identityMode === 'local' ? await ensureConsoleSecret() : '',
  );
  // Resolved per call: the console writes the client id into the database, so a
  // value read once at start-up is empty on exactly the installs that used it.
  const attribution = new Attribution();
  const actors = new Actors(
    async () => (await effectiveConfig(config)).gitHubClientId,
    async () => (await effectiveConfig(config)).installName,
    attribution,
  );
  const appCredentials = async () => {
    const clientId = (await effectiveConfig(config)).gitHubClientId;
    const privateKey = await getSecretStore().get(appPrivateKeyRef());
    return clientId && privateKey ? { clientId, privateKey } : null;
  };
  // `review-gate` from the app itself where it holds "Checks: write"; see app-gate.ts.
  const appGate = new AppGate({ credentials: appCredentials, api: APP_API });
  // Who can write to a repository, asked as the app when the automation account cannot ask; see people.ts.
  askAsTheApp(async (repoFullName) => {
    const credentials = await appCredentials();
    if (!credentials) return null;
    const { token } = await installationTokenFor(APP_API, credentials, repoFullName);
    return { request: <T,>(method: string, path: string, body?: unknown) => APP_API.request<T>(method, path, token, body) };
  });
  // Each of `humans` pinned to its GitHub account, asked as the automation
  // account; see human-ids.ts.
  resolveHumanIdsWith(async (login) => {
    const client = await asAutomation(actors, config).catch(() => null);
    const account = client ? await accountOf(client, login) : null;
    return account ? (account.id ?? null) : account;
  });
  const automation = new Automation(config, actors, appGate);
  // A design that supersedes an accepted entry is said on its issue, as the automation account.
  sayDesignMemoryWith((repoFullName, issueNumber, body) => automation.comment(repoFullName, issueNumber, body));
  const notifier = new Notifier(config);
  const gates = new Gates(actors, notifier, config.consoleUrl, config.costs.perTaskCapUsd, config.costs);
  const context = new Context(actors, config);
  // The one routine that renames a bot: when an account connects it takes
  // that account's handle, and everything named after it moves with it.
  const names = new BotNames({ hostd, exclusive: (held, fn) => actors.exclusive(held, fn) });
  const taskService = new TaskService(config, hostd, context, names);
  const onboarding = new Onboarding(config, actors);
  // Holds new work while a backup is restored into this install, and while a
  // person has paused it from Settings: the dispatcher's leases, a request's
  // triage, an issue's intake, and every retry, the recovery's below included.
  const dispatchGate = new DispatchGate();
  // The sweep of answered tasks leaves a paused install or repository paused.
  taskService.workPaused = (repo) => dispatchGate.paused(repo);
  const stages = new StageHandoff(automation, taskService, dispatchGate, null, (fullName, number) =>
    asAutomation(actors, config)
      .then((client) => (client ? subjectClosed(client, fullName, number) : false))
      .catch(() => false),
  );
  const mergeLine = new MergeLine(config, actors, taskService, automation);
  // The dispatcher, run here — where an issue changing or a task ending
  // arrives — as soon as either could let work start, and every five minutes
  // besides. `fleetadlc up` turns it on, except with scripted engines. The
  // integration suites drive the dispatcher a pass at a time, so a bridge they
  // run against — CI's, or a scratch install's — leaves it off.
  const dispatcher =
    process.env.FLEETADLC_DISPATCH_IN_BRIDGE === '1'
      ? new Dispatcher({
          bridgeUrl: `http://127.0.0.1:${config.port}`,
          internalSecret,
          costs: config.costs,
          leaseHours: Number(process.env.FLEETADLC_LEASE_HOURS ?? '12') || 12,
          // The gate itself, so a paused install or repository is passed over
          // before a lease is taken, rather than taken and refused.
          paused: (repo) => dispatchGate.paused(repo),
          // Which overlapping changes build side by side: the repository's own
          // `paths:` in .github/fleetadlc.yml, as the rest of its rules are read.
          pathPolicy: async (repo) => (await delivery.get(repo)).rules.paths,
        })
      : null;
  const dispatchRuns = dispatcher ? new DispatchRunner(() => dispatcher.runOnce()) : null;
  // Read once, so the `dispatcher` health check and the pause route's
  // `dispatching` cannot disagree about whether anything leases.
  const dispatchMode = dispatchModeOf(dispatcher !== null);
  // What the `/state` route does for a task that stops, for one an answer stopped.
  gates.onLeaseReleased((reason) => {
    dispatchRuns?.soon(reason);
    void gates
      .applyHeld()
      .then(async (ids) => {
        for (const id of ids) {
          await taskService.resume(id).catch((error: Error) => console.warn(`[bridge] resume after a plan change failed: ${error.message}`));
        }
      })
      .catch((error: unknown) =>
        console.warn(`[bridge] could not look at the plan changes waiting on paths: ${error instanceof Error ? error.message : error}`),
      );
  });
  // Links a console request to the issue its triage filed: first from the
  // issue's delivery, else when the triage ends.
  const requestFiling = new RequestFiling(actors, config);
  // A person's comment on an issue whose build ended without its pull request
  // goes on from its branch, the way Try again does.
  const continueBuild = (taskId: string, actor: string) => retryTask(taskId, actor, retryDepsFor({ taskService, automation, dispatchGate }));
  // Work going back to the stage before it: a task's own send-back, the
  // review loop's rounds, and a person moving a card back. See send-back.ts.
  const sendBack = new SendBack({
    config,
    automation,
    mergeLine,
    taskService,
    stages,
    dispatchRuns,
    stopTask: (taskId, actor, note) => stopTask(taskId, actor, note, hostd, { unfinished: true }),
    client: () => asAutomation(actors, config),
  });
  // A branch the merge line cannot bring up to date goes back to build.
  mergeLine.useSendBack((input) => sendBack.backToBuild(input));
  // A conflict at the front of the line gets a short resolution round, and
  // one in shared files is re-checked by the lead alone (`conflict-round.ts`).
  const conflictRounds = new ConflictRounds({
    taskService,
    client: () => asAutomation(actors, config),
    backToBuild: (input) => sendBack.backToBuild(input),
  });
  mergeLine.useConflictRounds(conflictRounds);
  // An issue that depends on one in review starts from its branch, and lands
  // after it (`stacking.ts`).
  const stacking = new Stacking({
    client: () => asAutomation(actors, config),
    startBuild: (input) => startBuild({ taskService, automation }, input),
    // A stacked build is new work: the dispatcher's gate holds it as it holds a lease.
    paused: (repo) => dispatchGate.paused(repo),
    dispatching: () => anythingDispatches(dispatchMode),
  });
  mergeLine.useStacking(stacking);
  // Approvals stand across a lead-only resolution and a stacked update; after
  // a resolution, the lead's own has to be of the resolution itself.
  automation.useCarriedHeads(async (repoName, prNumber, head) => {
    const carried = new Set<string>();
    for (const source of [conflictRounds, stacking]) {
      for (const sha of await source.carriedTo(repoName, prNumber, head).catch(() => new Set<string>())) carried.add(sha);
    }
    return carried;
  });
  automation.useResolutions((repoName, prNumber, head) => conflictRounds.resolvedAt(repoName, prNumber, head));
  // How each repository ships, by its own rules (`.github/fleetadlc.yml`), and
  // the pipeline that dispatches its deploys as the app. FLEETADLC_TESTING_URL is
  // read only as the deprecated fallback for a repository whose rules name no URL.
  const delivery = new DeliveryKnowledge(() => asAutomation(actors, config), config.testingUrl);
  const pipeline = new DeployPipeline({
    delivery,
    client: async (repoFullName) => (await appGate.client(repoFullName).catch(() => null)) ?? (await asAutomation(actors, config).catch(() => null)),
    sendBack,
  });
  const webhooks = new Webhooks(
    config,
    automation,
    gates,
    taskService,
    stages,
    mergeLine,
    notifier,
    dispatchRuns,
    requestFiling,
    attribution,
    continueBuild,
    sendBack,
  );
  webhooks.useDelivery(pipeline, delivery);
  // A QA task's testing.md names the URL these rules resolve to; see `Context.forQa`.
  context.useDelivery(delivery);
  // A closed pull request's reviews stop the way a card's Stop stops them.
  webhooks.useStopTask((taskId, actor, note) => stopTask(taskId, actor, note, hostd, { unfinished: true }));
  webhooks.useConflictRounds(conflictRounds);
  webhooks.useStacking(stacking);
  // GitHub Actions minutes: each completed run's, read from its jobs as the
  // automation account, and the month's cap the merge line holds at.
  webhooks.useCiUsage((delivery) =>
    recordCiRun(
      {
        repo: (name) => repos.getRepoByName(name),
        jobs: async (repoFullName, runId, attempt) => {
          const client = await asAutomation(actors, config);
          if (!client) throw new Error('the automation account is not connected, so the run’s jobs cannot be read');
          return everyJob(client, repoFullName, runId, attempt);
        },
        record: (row) => ciUsage.record(row),
      },
      delivery as never,
    ),
  );
  mergeLine.useCiCap(async () => {
    const cap = parseCiCap(await settings.getSetting('ciMinutesCap'));
    if (cap === null) return null;
    const used = (await ciUsage.listSince(ciMonthStart(new Date()))).filter((row) => row.billed).reduce((sum, row) => sum + row.minutes, 0);
    return ciCapReason(used, cap);
  });
  // Given the webhook's own handling of an issue: an issue reconcile finds on
  // GitHub and not on the board is one whose delivery never came, and it is
  // taken the way that delivery would have been.
  const reconciler = new Reconciler(config, actors, hostd, webhooks);
  // One for the process, shared with the console's routes, so a scheduled run
  // and one a person started are the same run and recorded once.
  const engineUpdates = engineUpdatesFor(hostd);
  const invitations = new InvitationService(actors, config);
  const automationToken = async (): Promise<string | null> =>
    actors
      .tokenFor(await automationBotName(config))
      .then((minted) => minted?.token ?? null)
      .catch(() => null);
  // Where the app is installed, and what a person does where it is not: one
  // answer for crew access, the app-installed check, settings and adding a
  // repository, so none of them says something the others do not.
  const appReach = new AppReach({
    credentials: async () => {
      const clientId = (await effectiveConfig(config)).gitHubClientId;
      const privateKey = await getSecretStore().get(appPrivateKeyRef());
      return clientId && privateKey ? { clientId, privateKey } : null;
    },
    api: APP_API,
    visibility: (slug) => appVisibility(slug),
    // Asked as the automation account when it is connected: its budget is
    // GitHub's authenticated one, not the sixty an hour this address shares.
    accountType: async (login) => accountTypeOf(login, { token: await automationToken() }),
    // The same answer, kept: one request tells both.
    accountId: async (login) => accountIdOf(login, { token: await automationToken() }),
    repositories: () => repos.listRepos(),
    organization: async () => (await effectiveConfig(config)).organization || null,
    allowedAccounts: async () => (await effectiveConfig(config)).allowedAccounts,
  });
  // Keeps the crew able to work in every repository OpenADLC works in: when one
  // is added, when the bridge starts, and each time it reconciles.
  const crewAccess = new CrewAccessKeeper(invitations, undefined, (repository) => appReach.reach(repository));
  // A repository's default branch as GitHub has it: asked as the app, which
  // reaches every repository it is installed on, else as the automation account.
  const defaultBranchOf = (fullName: string) =>
    readDefaultBranch(fullName, [() => appGate.client(fullName), () => asAutomation(actors, config)]);
  // What runs a failed task again once the check that explains it passes: on
  // the health run that saw it pass, and on the merge sweep for what that run
  // could not start (see `retryAfterRecovery`).
  await restorePause({
    gate: dispatchGate,
    read: () => settings.getSetting('workPaused'),
    readRepos: () => settings.getSetting('workPausedRepos'),
  });
  const retryDeps = retryDepsFor({ taskService, automation, dispatchGate });
  const recovery = {
    retry: (taskId: string, actor: string) => retryTask(taskId, actor, retryDeps),
    // A run again waits on overlapping work as the dispatcher's leases do, by the same paths policy.
    pathPolicy: async (repo: { id: string; name: string; fullName: string; defaultBranch: string }) => (await delivery.get(repo)).rules.paths,
  };
  const scheduler = new Scheduler(
    config,
    hostd,
    automation,
    reconciler,
    stages,
    mergeLine,
    taskService,
    notifier,
    engineUpdates,
    crewAccess,
    recovery,
    // Builds that ended without their pull request: continued only where
    // something dispatches, and only those that ended after this start.
    { dispatching: anythingDispatches(dispatchMode), startedAt: new Date() },
  );
  scheduler.useDelivery(pipeline, delivery);
  scheduler.useStacking(stacking);
  // What GitHub could not deliver while the bridge was down, sent again as the
  // app; nothing without the app's credentials.
  scheduler.useRedelivery(async (since) => {
    const credentials = await appCredentials();
    return credentials ? redeliverFailedSince(APP_API, credentials, since) : null;
  });
  scheduler.useDefaultBranches(() =>
    syncDefaultBranches({ repositories: () => repos.listRepos(), read: defaultBranchOf, store: (fullName, branch) => repos.setDefaultBranch(fullName, branch) }),
  );
  // Issues a person filed that OpenADLC never looked at go to intake, the
  // oldest in each repository first, one at a time (`unlabeled-intake.ts`).
  scheduler.useUnlabeledIntake(
    new UnlabeledIntake({
      repos: () => repos.listRepos(),
      openIssues: async (repoFullName) => {
        const client = await asAutomation(actors, config).catch(() => null);
        if (!client) return null;
        return openIssuesOn(client, repoFullName);
      },
      actsFor: async (repoFullName, author) => {
        const client = await asAutomation(actors, config).catch(() => null);
        const live = await effectiveConfig(config).catch(() => null);
        return actsForOn({ client, repoFullName, author, crew: await bots.listBots(), humans: live?.humans ?? [] });
      },
      intakeGoingIn: async (repoName) =>
        (await tasks.listTasks({ states: ['queued', 'running', 'paused'], limit: 200 })).some(
          (task) => task.kind === 'intake' && task.subjectRef.startsWith(`${repoName}#`),
        ),
      paused: (repoName) => dispatchGate.paused(repoName),
      intakePaused: async () => {
        const intake = (await bots.listBots()).find((bot) => bot.role === 'intake');
        return intake ? seatPausedReason(intake.name) : null;
      },
      recordUnowned: (repoName, list) => recordUnowned(repoName, list),
      learn: (repo, issue) =>
        webhooks.learnIssue(
          repo,
          { number: issue.number, title: issue.title, body: issue.body, htmlUrl: issue.htmlUrl, labels: issue.labels },
          'opened',
          issue.author,
        ),
    }),
  );

  // Watches the database so an open thread panel does not have to poll. One
  // watcher per bot, reference-counted, and none at all when nobody is looking.
  const threadStream = new WatermarkStream();

  // The jobs nobody asks for. Until now `POST /internal/schedule/:job` was the
  // only way in, so on a running install the credential check, the status issue
  // and the dependency sweep never happened at all.
  const jobs = new JobTimer(scheduler);
  jobs.start();
  // A promote queued before a restart and not yet walked is walked now,
  // rather than waiting for the next production deployment to find it.
  void webhooks.walkPromotes();
  // A task answered before a restart, while every host was full, was owed a
  // resume a timer held; the merge job looks too, but only once its period
  // has passed.
  void taskService
    .resumeAnswered()
    .then((lines) => lines.forEach((line) => console.log(`[bridge] ${line}`)))
    .catch((error: unknown) => console.warn(`[bridge] could not resume answered tasks: ${error instanceof Error ? error.message : error}`));
  for (const { job, minutes } of jobs.running) {
    console.log(`[bridge] ${job} every ${minutes} minute(s)`);
  }

  // Who may do what, by the verified identity: an admin everything, a user
  // what creating and running work takes. See `roles.ts`.
  const roles = new Roles({
    mode: config.identityMode,
    adminEmails: listFromEnv(process.env.FLEETADLC_ADMIN_EMAILS),
    consoleMembers: listFromEnv(process.env.FLEETADLC_CONSOLE_MEMBERS),
  });
  const router = new Router(identity, undefined, undefined, (method, path, person) => authorize(roles, method, path, person));
  // Owns the tunnel it raises, so the tunnel dies with the bridge rather than
  // outliving it as an orphan pointing at a port nothing answers on.
  const webhookSetup = new WebhookSetup({ config });
  // Runs as the app, not as a bot: the admin-gated half of this is out of reach
  // of a collaborator's token. See `repo-setup.ts`.
  const repoSetup = new RepoSetup({
    config,
    // The production environment the repository's rules call for: reviewers, or a soak.
    production: async (fullName) => {
      const repo = (await repos.listRepos()).find((one) => one.fullName === fullName);
      if (!repo) return null;
      const known = await delivery.get(repo);
      const { production } = known.rules;
      return { approval: production.approval, soakMinutes: production.soakMinutes, governedByFile: known.approvalInFile === true };
    },
  });
  // Everything OpenADLC cannot do for itself, proved by its effect and kept
  // proving: a failing check is a card on the board until it passes, and a
  // lasting blocking one is sent through the notifier. See `health/`.
  const health = new HealthRegistry({
    checks: defaultChecks({ config, actors, hostd, webhookSetup, repoSetup, appReach, dispatch: dispatchMode, delivery }),
    notify: (notice) => notifier.send({ event: notice.event, to: null, text: notice.text, link: notice.link }),
    settingUp,
    consoleUrl: config.consoleUrl,
    botNames,
    // What was held on a seat's sign-in, its place in a repository or the host
    // goes on when that passes: failed tasks are run again once, reviews the
    // gates wait on are started, and the dispatcher looks again.
    onFixed: async (ids) => {
      // A repository's configuration put right — a reviewer invited, a name
      // corrected — is a gate that can pass now: the gates are worked out
      // again from what the check just learned, rather than at the next sweep.
      if (ids.some((id) => id.startsWith('repo-config:')) && !ids.some(isPrerequisiteRow)) {
        for (const line of await scheduler.settleGates()) console.log(`[bridge] recovered: ${line}`);
        return;
      }
      if (!ids.some(isPrerequisiteRow)) return;
      // A bot let into a repository can be asked for a review there now; a
      // refusal kept from before would fail its gates until it aged out.
      if (ids.some((id) => id.startsWith('bot-access'))) await automation.forgetCrewStandings();
      const lines = [
        ...(await retryAfterRecovery(ids, recovery)),
        ...(await scheduler.settleGates()),
      ];
      for (const line of lines) console.log(`[bridge] recovered: ${line}`);
      dispatchRuns?.soon('a health check passed');
    },
  });
  onboarding.useInvitations(invitations);
  onboarding.useCrewAccess(crewAccess);
  // A bot let in is a check to ask again, not one to wait half an hour for.
  // What GitHub refused about a seat before is stale once its access changed.
  crewAccess.whenChanged(() => {
    health.runSoon(['bot-access']);
    void automation.forgetCrewStandings();
  });
  // A merge that changes who a repository names as its reviewers is checked now.
  webhooks.whenConfigurationChanged(() => health.runSoon(['repo-config']));
  // The app installed, suspended or given other repositories somewhere: what
  // it reaches is asked again now, so the line in settings and the card on the
  // board change as somebody comes back from GitHub. Only the repositories
  // OpenADLC works in there are let in; any other account is only looked at.
  webhooks.whenInstallationChanged(async (account) => {
    appReach.clear();
    health.runSoon(['app-installed', 'app-permissions']);
    for (const repo of await repos.listRepos()) {
      if (sameLogin(repo.fullName.split('/')[0], account)) void crewAccess.ensure(repo.fullName, 'reconcile').catch(() => undefined);
    }
  });
  onboarding.useWebhookSetup(webhookSetup);
  onboarding.useNames(names);
  onboarding.useHealth(health);
  // Console requests that wait for intake: started when it frees, every
  // minute, and now, for what waited through a restart. See request-queue.ts.
  // Nothing starts while work is paused, and a request for a paused
  // repository waits while the rest go ahead; resuming drains it.
  const requestQueue = new RequestQueue({ taskService, paused: (repo) => dispatchGate.paused(repo), seatPaused: (seat) => seatPausedReason(seat) });
  void requestQueue.drain();
  setInterval(() => void requestQueue.drain(), REQUEST_SWEEP_MS).unref();
  const deps = {
    requestQueue,
    config,
    hostd,
    actors,
    automation,
    gates,
    taskService,
    onboarding,
    invitations,
    threadStream,
    webhookSetup,
    repoSetup,
    names,
    crewAccess,
    health,
    dispatchGate,
    appReach,
    defaultBranchOf,
    attribution,
    sendBack,
    delivery,
  };
  registerConsoleApi(router, deps);
  // One seat paused from Crew takes no new work; resuming it starts what that
  // held: the requests intake left in line, the reviews and lead the gates wait
  // on, a dispatch for a builder, and the work only an event starts, which was
  // recorded with the pause's words and is run again here (`seat-pause.ts`).
  registerSeatPauseRoutes(router, {
    botNamed: async (reference) => (await bots.getBotByName(reference)) ?? (await bots.getBotBySlot(reference)),
    audit: auditEntry,
    resumed: async (seat) => {
      void requestQueue.drain();
      dispatchRuns?.soon(`${seat} was resumed`);
      for (const line of await scheduler.settleGates()) console.log(`[bridge] resumed: ${line}`);
      const bot = await bots.getBotByName(seat);
      if (!bot) return;
      const held = heldBySeatPause(await tasks.listTasks({ botId: bot.id, limit: 50 }));
      for (const task of held) {
        await retryTask(task.id, 'seat-resumed', retryDepsFor(deps)).catch((error: unknown) =>
          console.warn(`[bridge] ${task.subjectRef}: what ${seat}'s pause held did not start again: ${error instanceof Error ? error.message : error}`),
        );
      }
    },
  });
  // One piece of work held, let go on, put next or cancelled from its card
  // (`item-controls.ts`). Resuming starts what the hold kept back: a dispatch,
  // the stage sweep for intake and design, the reviews and lead the gates
  // wait on, and the merge line.
  registerItemControlRoutes(router, {
    resolve: async (subject) => {
      const found = await resolveItem(subject);
      if (!found?.repo || !found.item.repo) return null;
      const { item, repo } = found;
      const client = await asAutomation(actors, config).catch(() => null);
      const pull = item.pr && client ? await client.getPullRequest(repo.fullName, item.pr).catch(() => null) : null;
      return {
        key: item.key,
        repoName: repo.name,
        repoFullName: repo.fullName,
        repoId: repo.id,
        defaultBranch: (await repos.getRepoByName(repo.name).catch(() => null))?.defaultBranch ?? null,
        issue: item.issue
          ? {
              number: item.issue.number,
              title: item.issue.title,
              url: item.issue.url ?? `https://github.com/${repo.fullName}/issues/${item.issue.number}`,
              labels: (item.issue as { labels?: string[] }).labels ?? [],
              stage: item.issue.stage ?? null,
            }
          : null,
        pr: item.pr
          ? {
              number: item.pr,
              url: `https://github.com/${repo.fullName}/pull/${item.pr}`,
              branch: pull?.headRef ?? null,
              headRepoFullName: pull?.headRepoFullName ?? null,
              merged: pull?.merged ?? null,
              state: pull?.state ?? null,
            }
          : null,
        request: item.request && !item.issue ? { id: item.request.id, state: item.request.state } : null,
        subjects: item.subjects,
      };
    },
    abandonRequest: async (requestId, actor, note) => {
      const done = await abandonRequest({ requestId, actor, note, stop: (taskId, by, why) => stopTask(taskId, by, why, hostd, { unfinished: true }) });
      if (done.outcome === 'unknown') throw new Error('there is no such request');
      if (done.outcome === 'finished') {
        if (done.state === 'abandoned') return 'it was already abandoned';
        throw new Error(`the request is ${done.state}, so it was not abandoned`);
      }
      return `abandoned the request${done.stopped > 0 ? `, stopping ${done.stopped} triage` : ''}`;
    },
    github: async () => asAutomation(actors, config).catch(() => null),
    app: (repoFullName) => theApp(repoFullName),
    ensureLabel: (repoFullName, label) => repoSetup.ensureLabel(repoFullName, label),
    issuesOf: async (repoName) => (await issueStore.listIssues(repoName)).map((issue) => ({ number: issue.number, labels: issue.labels })),
    setLabels: (repoId, number, labels) => issueStore.setIssueLabels(repoId, number, labels),
    audit: auditEntry,
    tasks: async (subjects) => {
      const crew = new Map((await bots.listBots()).map((bot) => [bot.id, bot.name]));
      return (await tasks.listTasksOnSubjects(subjects)).map((task) => ({ id: task.id, bot: crew.get(task.botId) ?? task.botId, kind: task.kind, state: task.state }));
    },
    openQuestions: async (subjects) => {
      const ids = new Set((await tasks.listTasksOnSubjects(subjects)).map((task) => task.id));
      return (await threadStore.listOpenGates()).filter((gate) => gate.taskId && ids.has(gate.taskId)).length;
    },
    stop: (taskId, actor, note) => stopTask(taskId, actor, note, hostd, { unfinished: true }),
    closeQuestions: async (taskId, actor, reason) => (await threadStore.expireGatesOfTask(taskId, actor, reason)).length,
    leaveMergeLine: (repoName, prNumber) => mergeLine.leave(repoName, prNumber),
    releaseLease: async (repoId, issueNumber, reason) => {
      const lease = await leaseStore.getActiveLease(repoId, issueNumber);
      if (!lease) return false;
      await leaseStore.setLeaseState(lease.id, 'released');
      await auditEntry({ actor: 'bridge', action: 'lease.released', target: `${repoId}#${issueNumber}`, payload: { leaseId: lease.id, reason } });
      return true;
    },
    forget: (repoId, issueNumber) => issueStore.forget(repoId, issueNumber),
    resumed: async (item) => {
      dispatchRuns?.soon(`${item.key} was resumed`);
      for (const line of await stages.sweep()) console.log(`[bridge] resumed ${item.key}: ${line}`);
      for (const line of await scheduler.settleGates()) console.log(`[bridge] resumed ${item.key}: ${line}`);
      await mergeLine.advance(item.repoName).catch(() => null);
    },
    dispatchSoon: (reason) => dispatchRuns?.soon(reason),
    pausePull: (repoFullName, prNumber) => automation.pausePull(repoFullName, prNumber),
  });
  // Issues OpenADLC will not take on its own, decided by a person from Needs
  // you (`unowned-routes.ts`). Sent to intake, one goes as an opened issue goes.
  registerUnownedRoutes(router, {
    repo: async (name) => {
      const found = (await repos.listRepos()).find((one) => one.name === name || one.fullName === name);
      return found ? { id: found.id, name: found.name, fullName: found.fullName } : null;
    },
    github: async () => asAutomation(actors, config).catch(() => null),
    automationName: () => automationBotName(config),
    learn: (repo, issue) => webhooks.learnIssue(repo, issue, 'opened', null),
    audit: auditEntry,
  });
  // A promote held for a person, released from Needs you, or its repository
  // switched to automatic delivery (`deploy-routes.ts`).
  registerDeployRoutes(router, {
    repo: async (name) => {
      const found = (await repos.listRepos()).find((one) => one.name === name || one.fullName === name);
      return found ? { id: found.id, name: found.name, fullName: found.fullName, defaultBranch: found.defaultBranch } : null;
    },
    pipeline,
    delivery,
    setRules: (repoId, rules) => repos.setDelivery(repoId, { deliveryRules: rules }),
    recordChoice: (repoId, choice) => repos.setProductionChoice(repoId, choice),
    held: (repoId) => deployRuns.heldForPerson(repoId),
    soak: (repoId, sha, after, detail) => deployRuns.holdPromote(repoId, sha, after, detail),
    audit: auditEntry,
  });
  registerUsersRoutes(router, liveUsersDeps(roles, config.identityMode));
  // Resuming starts what waited: the queued requests, the issues whose
  // intake was deferred, oldest first, and — for a repository resumed on its
  // own, which the dispatcher passed over — its issues ready to build.
  registerPauseRoutes(router, dispatchGate, {
    // Whether anything leases an issue to a builder: this bridge's dispatcher,
    // or the integration suites beside scripted engines. Said with the pause,
    // so Settings and the board do not say work runs while builds cannot
    // start; the `dispatcher` health check says it as a card.
    dispatching: anythingDispatches(dispatchMode),
    resumed: () => {
      void requestQueue.drain();
      dispatchRuns?.soon('work resumed');
      void stages.resumed().catch((error: unknown) =>
        console.warn(`[bridge] could not start the intake that waited through the pause: ${error instanceof Error ? error.message : error}`),
      );
    },
  });
  // Backing the install up from Settings, restoring a clean one from the
  // walkthrough's first step, and restoring into this one — and undoing that —
  // from Settings.
  const backupDeps = defaultBackupDeps({ config, hostd, names, actors, dispatchGate, health });
  registerBackupRoutes(router, backupDeps);
  // A restore's undo holds every credential; a day old, it is removed even if
  // nobody opens Settings again.
  if (backupDeps.into) sweepExpiredUndo(backupDeps.into);
  registerInternalApi(router, { ...deps, webhooks, scheduler, stages, internalSecret, alertsSecret, dispatchRuns, requestFiling });

  const server = createServer((request, response) => {
    // A rejection here used to be unhandled, which under Node's default
    // terminates the process — so one request that got past `handle`'s own
    // try/catch could stop the bridge. Nothing is worth that.
    void router.handle(request, response).catch((error: unknown) => {
      console.error('[bridge] request failed outside the router:', error instanceof Error ? error.message : error);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'the request could not be handled' }));
      } else {
        response.end();
      }
    });
  });

  server.listen(config.port, '0.0.0.0', () => {
    // Every bot takes the handle of the account connected to it, and a bot
    // with none goes back to its seat. This is what moves an install that
    // still has persona names, and what finishes a rename a stopped bridge
    // left half done. After listening, because it is seconds per bot and
    // `fleetadlc up` waits on /healthz; a lease that arrives meanwhile waits for it.
    void names
      .begin('bridge')
      .then((outcomes) => {
        const renamed = outcomes.filter((outcome) => outcome.state === 'renamed');
        if (renamed.length > 0) {
          console.log(
            `[bridge] renamed ${renamed.length} bot(s): ${renamed.map((one) => `${one.from} → ${one.to}`).join(', ')}`,
          );
        }
      })
      .catch((error: unknown) => {
        console.warn(`[bridge] could not bring the crew's names up to date: ${error instanceof Error ? error.message : error}`);
      })
      // Then the crew into every repository, under the names they have now:
      // one added while the bridge was down, or a bot that has no access to
      // one, is let in without anybody having to look.
      .then(() => crewAccess.ensureAll('start'))
      .catch((error: unknown) => {
        console.warn(`[bridge] could not let the crew into the repositories: ${error instanceof Error ? error.message : error}`);
      });
    // After listening, because the tunnel forwards here: a tunnel install gets
    // its webhook back on its own, rather than GitHub delivering to the
    // address the last run's tunnel had.
    void webhookSetup
      .resume()
      .then((status) => {
        if (status) console.log(`[bridge] tunnel back up at ${status.publicUrl}; the GitHub app's webhook points at it`);
      })
      // Asked again now that the tunnel is back, so what the webhook check
      // says is about the tunnel this bridge runs, not the one it replaced.
      .finally(() => health.runSoon(['webhook']))
      .catch((error: unknown) => {
        console.warn(
          `[bridge] could not bring the webhook tunnel back: ${error instanceof Error ? error.message : error} — ` +
            'the webhook step can start one',
        );
      })
      // Then what GitHub could not deliver while the bridge was down, sent
      // again to the address it has now: a gate answered on GitHub meanwhile
      // is taken at start, not left waiting for good.
      .finally(() =>
        scheduler.redeliverFailed().then((line) => {
          if (line) console.log(`[bridge] ${line}`);
        }),
      );
    // At start, so an OpenADLC that asks for something the install does not have
    // yet — a permission a new version added to the app's manifest — says so
    // before any task runs into it.
    health.start();
    // After listening, because a dispatch reaches this bridge's own routes.
    dispatchRuns?.start();
    console.log(`[bridge] listening on :${config.port}`);
    console.log(`[bridge] hostd at ${config.hostdUrl}`);
    console.log(`[bridge] identity: ${identity.describe()}`);
    // The console's stored client id counts: checking the environment alone,
    // an install whose app was made in the walkthrough said this on every start.
    void effectiveConfig(config)
      .then((live) => {
        if (!live.gitHubClientId) console.log(`[bridge] ${NO_CLIENT_ID}`);
      })
      .catch(() => undefined);
  });

  const shutdown = async (): Promise<void> => {
    dispatchRuns?.stop();
    names.stop();
    health.stop();
    server.close();
    // Before the pool, because a tunnel left running keeps a public hostname
    // pointing at a port that no longer answers.
    await webhookSetup.shutdown();
    // A start cut off between its row and hostd left the row queued for good.
    await taskService.drain(10_000);
    await closePool();
    process.exit(0);
  };

  // Once: the keeper forwards the stop signal again after 8 s, which started
  // a second shutdown and a second `closePool()` mid-way through the first.
  let stopping: Promise<void> | null = null;
  const stopOnce = (): void => {
    stopping ??= shutdown();
  };
  process.on('SIGINT', stopOnce);
  process.on('SIGTERM', stopOnce);
  // A crash exits without `shutdown`, and only what is synchronous runs then:
  // the tunnel is killed here, or it outlives the bridge and the next start
  // raises another beside it.
  process.on('exit', () => void webhookSetup.stopTunnel().catch(() => undefined));
}

// A promise nobody awaited that rejects would end the bridge, and with it what
// only its memory holds: local CI runs, device flows, rerun bookkeeping. It is
// logged with its stack and the bridge carries on; an uncaught exception still
// ends it, since what threw may have left its state half-changed.
process.on('unhandledRejection', (reason) => {
  console.error('[bridge] a promise rejected with nothing to catch it:', reason instanceof Error ? reason.stack : reason);
});

main().catch((error) => {
  console.error('[bridge] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
