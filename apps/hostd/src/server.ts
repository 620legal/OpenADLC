import { execFile as execFileCallback } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { audit, bots, sessions as sessionStore, tasks } from '@fleetadlc/db';
import { TASK_TOKEN_HEADER, getSecretStore, taskTokenMatches } from '@fleetadlc/github';
import { commandInImage, readinessFor } from '@fleetadlc/engines';
import { DEFAULT_MIN_RELEASE_AGE_DAYS, isMinReleaseAgeDays, redactSecrets, SYSTEM_TOOLS, type ContextDocument, type EngineName, type EngineVersions, type TaskAttachment } from '@fleetadlc/shared';
import type { AttachTokens } from './attach-tokens.js';
import { auditActor, authenticate, type Caller } from './auth.js';
import type { HostdConfig } from './config.js';
import type { ExecDriver } from './drivers/types.js';
import { EngineUpdateRefused, parseVersion, type EngineUpdater } from './engine-updates.js';
import { hasLogin, isAccountId, LoginRefused, type LoginService } from './logins.js';
import { RenameRefused, renameBotComputer } from './rename.js';
import { isRefusal, type RegistryCredentials } from './registry.js';
import { HostFull, type ReviewMode, type TaskRunner } from './task-runner.js';
import { readEngineCredential } from './session-env.js';
import { isWorktreeRefusal, readWorktree } from './worktree-files.js';
import { LocalCiRefused, type LocalCi } from './local-ci.js';
import { ATTACH_SUBPROTOCOL_PREFIX } from './terminal-gateway.js';

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const VERSION_KEYS = SYSTEM_TOOLS.map((tool) => tool.key);

/**
 * Versions from a body (`hold`, or `pins`), as the bridge passes them: known
 * packages and exact version strings only, so nothing else a body carries
 * reaches the decision.
 */
function heldVersions(value: unknown): EngineVersions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const held: EngineVersions = {};
  for (const pkg of VERSION_KEYS) {
    const version = (value as Record<string, unknown>)[pkg];
    if (typeof version === 'string' && parseVersion(version) === version) held[pkg] = version;
  }
  return held;
}

/** Tool ids or package keys a run may change, and nothing else a body names. */
function selectedKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tool = SYSTEM_TOOLS.find((one) => one.id === item || one.key === item);
    if (tool && !keys.includes(tool.key)) keys.push(tool.key);
  }
  return keys;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(payload);
}

/**
 * Records how much of the actor hostd actually established. `principal` is what
 * it authenticated; `asserted` is whether a person's name came along with it,
 * which hostd takes on trust from the caller it authenticated.
 */
function assertion(caller: Caller): Record<string, unknown> {
  return { principal: caller.principal, asserted: caller.onBehalfOf !== null };
}

const execFile = promisify(execFileCallback);

/**
 * hostd's API. Only the platform calls it, and now it says so: every route but
 * `/healthz`, and a task's own `/tasks/:id/registry-token` (which takes that
 * task's token), needs the install's internal secret, because each of them starts a
 * task, kills a session, restarts a container, mints a terminal attach token or
 * reads a file out of a bot's worktree, and the private network was the only
 * thing standing in front of them.
 *
 * `/healthz` stays open on purpose — `fleetadlc up` and `fleetadlc status` poll
 * it to find out whether hostd is even there, and it reveals nothing a caller
 * could act on. The `/terminal` socket is open too, and
 * authorised differently: a browser cannot hold the install's secret, so the
 * gateway admits a one-use attach token that hostd itself minted for one bot and
 * one session (`TerminalGateway`).
 *
 * `secret` is read per request rather than captured, because hostd starts before
 * the bridge that generates it.
 */
export function createHostdServer(input: {
  config: HostdConfig;
  driver: ExecDriver;
  runner: TaskRunner;
  attachTokens: AttachTokens;
  registry: RegistryCredentials;
  perTaskCapUsd: number;
  secret: () => Promise<string | null>;
  /** Signs subscriptions in and checks accounts. Absent, those routes say so. */
  logins?: LoginService;
  /** Keeps the engine CLIs in the bot image current. Absent, its routes say so. */
  engineUpdates?: Pick<EngineUpdater, 'status' | 'update' | 'rollback'>;
  /** Runs a task's checks on its head for the bridge (`local-ci.ts`). Absent, its routes say so. */
  localCi?: Pick<LocalCi, 'start' | 'get'>;
}): Server {
  const { config, driver, runner, attachTokens } = input;

  return createServer((request, response) => {
    void handle(request, response).catch((error) => {
      // A host with no room is not a fault: the bridge tries the task again
      // as it does a busy seat, and records nothing as failed.
      const status = error instanceof HostFull ? error.status : 500;
      send(response, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      return send(response, 200, {
        ok: true,
        host: config.hostName,
        driver: driver.kind,
        activeTasks: runner.activeTaskIds().length,
        // That this hostd refuses a caller without the secret. `fleetadlc doctor`
        // proves it instead, by making the call it expects to be refused.
        authenticating: true,
      });
    }

    const expected = await input.secret();
    if (!expected) {
      // Fail closed. Without the secret hostd cannot tell its own bridge from
      // anything else that reached the port, so it serves neither.
      return send(response, 503, {
        error: 'hostd has no internal secret yet, so it cannot authenticate anyone',
        remedy: 'start the bridge, which generates it, then retry: fleetadlc up',
      });
    }

    // The one route a task's own session reaches, and it cannot hold the
    // install's secret to do it: that secret also starts tasks and kills
    // sessions. It presents an HMAC of its own task id instead — the same
    // credential the bridge already accepts for `/internal/tasks/:id/*`, minted
    // by hostd when the task started, useless for any other task and for every
    // other route here. Every session has that token and hostd's URL, so any
    // task active on this host, whatever its repository or skill, can read the
    // raw registry token: which is why the stored one has to be read-only.
    const registryMatch = /^\/tasks\/([^/]+)\/registry-token$/.exec(path);
    if (method === 'GET' && registryMatch?.[1]) {
      const taskId = registryMatch[1];
      const presented = request.headers[TASK_TOKEN_HEADER];
      const holdsTaskToken = taskTokenMatches(taskId, expected, typeof presented === 'string' ? presented : '');

      // Falls back to the install secret rather than the other way round, so a
      // wrong task token is never quietly upgraded by one.
      if (!holdsTaskToken && !authenticate(request, expected)) {
        return send(response, 401, {
          error: `GET ${path} needs this task's own token`,
          remedy: `the session has it as FLEETADLC_TASK_TOKEN; send it as ${TASK_TOKEN_HEADER}`,
        });
      }

      // A token for a task that has ended is a token nobody should be installing
      // with — the session is gone and whatever is asking is not it.
      const task = await tasks.getTask(taskId);
      if (!task) return send(response, 404, { error: 'unknown task' });
      if (!runner.activeTaskIds().includes(taskId)) {
        return send(response, 409, {
          error: `task ${taskId} is not running on this host`,
          remedy: 'a registry credential is served to a live session and nothing else',
        });
      }

      const grant = await input.registry.grant();
      // 501, not 500: an install with no private registry is a configuration,
      // not a fault, and a wrapper reading this should install without a token
      // rather than fail. A registry named with no token stored is the other
      // way round: 503, which the wrapper refuses, because installing without
      // the token resolves private names against the public registry.
      if (isRefusal(grant)) return send(response, grant.configured ? 503 : 501, grant);
      return send(response, 200, grant);
    }

    // The repository's pnpm store filled again from the session's own
    // lockfile, which OpenADLC's `pnpm` asks for when the session adds,
    // updates or removes a dependency: the store is read-only in the task's
    // computer, and only hostd writes it. With the task's own token, as the
    // registry credential is, and only from that task's own worktree.
    const pnpmStoreMatch = /^\/tasks\/([^/]+)\/pnpm-store$/.exec(path);
    if (method === 'POST' && pnpmStoreMatch?.[1]) {
      const taskId = pnpmStoreMatch[1];
      const presented = request.headers[TASK_TOKEN_HEADER];
      if (!taskTokenMatches(taskId, expected, typeof presented === 'string' ? presented : '') && !authenticate(request, expected)) {
        return send(response, 401, {
          error: `POST ${path} needs this task's own token`,
          remedy: `the session has it as FLEETADLC_TASK_TOKEN; send it as ${TASK_TOKEN_HEADER}`,
        });
      }
      if (!runner.activeTaskIds().includes(taskId)) {
        return send(response, 409, {
          error: `task ${taskId} is not running on this host`,
          remedy: 'a pnpm store is filled for a live session and nothing else',
        });
      }
      const fill = await runner.refillPnpmStore(taskId);
      if (fill.filled) return send(response, 200, { filled: true });
      // The wrapper installs into the task's own store instead, and says so.
      return send(response, 503, { error: `the pnpm store was not filled: ${fill.reason}` });
    }

    const caller = authenticate(request, expected);
    if (!caller) {
      return send(response, 401, {
        error: `${method} ${path} needs the install's internal secret`,
        remedy: 'only the bridge and `fleetadlc attach` call hostd; they read it from the secret store',
      });
    }

    /**
     * Whether the crew could think, asked on the host where they would.
     *
     * It belongs here and not on the bridge: the engines are CLIs and keys in
     * *this* process's environment, so the bridge asking its own would answer
     * about the wrong machine. Reported before any work is filed, because
     * `chooseEngine` otherwise answers the same question by failing a task
     * somebody has already gone to watch.
     */
    if (method === 'GET' && path === '/engines') {
      const records = await bots.listBots();
      const crew = records.map((bot) => ({
        bot: bot.name,
        engine: bot.engine as EngineName,
      }));
      const byName = new Map(records.map((bot) => [bot.name, bot]));

      // The credential is the bot's model account when one is assigned, and the
      // per-bot engine key otherwise. The store is this host's, which is the
      // one whose answer matters — the task runs here.
      const store = getSecretStore();

      /**
       * Where to look for an engine's command. Under the docker driver a bot is
       * a container built from the bot image, and hostd's own image is a plain
       * node base carrying no engine CLI — so asking this filesystem would
       * report every bot as unable to run while their containers would have run
       * fine. Under the local driver a bot shares hostd's PATH, so this one is
       * the right one to ask.
       */
      const probe =
        config.driver === 'docker'
          ? commandInImage(process.env.FLEETADLC_BOT_IMAGE ?? 'fleetadlc-bot:latest', async (command, args) => {
              try {
                await execFile(command, args);
                return true;
              } catch {
                return false;
              }
            })
          : undefined;

      const answers = await readinessFor(
        crew,
        async (bot) => {
          const credential = await readEngineCredential(
            { bot, engine: byName.get(bot)?.engine ?? '' },
            store,
            undefined,
            (accountId) => driver.loginPath(accountId),
          ).catch(() => null);
          // An OpenAI or xAI subscription has no key: it has a credential once
          // its CLI has written a login into the account's sign-in directory. A Claude
          // subscription has one once its token is stored, like a key.
          if (credential?.login) {
            return credential.accountId ? hasLogin(config.loginRoot, credential.accountId) : false;
          }
          return Boolean(credential?.key);
        },
        probe,
      );

      return send(response, 200, { host: config.hostName, bots: answers });
    }

    /**
     * The engine CLIs in the bot image: which versions the crew runs, and the
     * weekly update that keeps them current (`engine-updates.ts`).
     *
     * `GET /engines` above is whether each bot can think at all, which the
     * walkthrough asks within seconds; this is the image's versions and the
     * last run, which can mean asking an unlabelled image's CLIs in a
     * container. An update answers at once with the run it started or joined
     * — a build takes minutes — and the caller follows `GET` for the result.
     * The bridge records every outcome; nothing here writes to the audit log,
     * so nothing is written twice.
     */
    if (path === '/engines/update' || path === '/engines/rollback') {
      const updates = input.engineUpdates;
      if (!updates) return send(response, 503, { error: 'this hostd was started without the engine updater' });
      try {
        if (method === 'GET' && path === '/engines/update') return send(response, 200, await updates.status());
        if (method === 'POST' && path === '/engines/update') {
          const body = await readBody(request);
          const pins = body.pins === undefined ? undefined : heldVersions(body.pins);
          const started = updates.update({
            trigger: typeof body.trigger === 'string' && body.trigger ? body.trigger.slice(0, 40) : 'console',
            requestedBy: caller.onBehalfOf,
            hold: heldVersions(body.hold),
            // Absent `only` is every engine, which is what a caller from before
            // per-tool updates sends. An empty list is a run that may report
            // and must not change anything.
            ...(Array.isArray(body.only) ? { only: selectedKeys(body.only) } : {}),
            ...(pins && Object.keys(pins).length > 0 ? { pins } : {}),
            // A bridge from before the setting sends none, and a malformed
            // one is not trusted: either way the default.
            minReleaseAgeDays: isMinReleaseAgeDays(body.minReleaseAgeDays) ? body.minReleaseAgeDays : DEFAULT_MIN_RELEASE_AGE_DAYS,
          });
          return send(response, started.running ? 202 : 200, started);
        }
        if (method === 'POST' && path === '/engines/rollback') {
          return send(response, 200, await updates.rollback(caller.onBehalfOf));
        }
      } catch (error) {
        if (error instanceof EngineUpdateRefused) return send(response, error.status, { error: error.message });
        throw error;
      }
    }

    /**
     * Signing a subscription in, checking an account, forgetting a login, and
     * asking an xAI seat's CLI what it can call.
     *
     * hostd reads the account itself and takes nothing about it from the
     * caller: which CLI runs, against which directory, with which credential,
     * all follow from the row. The only part of a sign-in that leaves here is
     * the link and the one-time code, in the answer to the call that started
     * it — they are never logged and never audited.
     */
    const loginMatch = /^\/model-accounts\/([^/]+)\/login$/.exec(path);
    const verifyMatch = /^\/model-accounts\/([^/]+)\/verify$/.exec(path);
    const modelsMatch = /^\/model-accounts\/([^/]+)\/models$/.exec(path);
    const filesMatch = /^\/model-accounts\/([^/]+)\/login\/files$/.exec(path);
    const adoptMatch = /^\/model-accounts\/([^/]+)\/login\/adopt$/.exec(path);
    const accountRoute = loginMatch ?? verifyMatch ?? modelsMatch ?? filesMatch ?? adoptMatch;
    if (accountRoute?.[1]) {
      const accountId = decodeURIComponent(accountRoute[1]);
      if (!input.logins) {
        return send(response, 503, { error: 'this hostd was started without a sign-in service' });
      }
      if (!isAccountId(accountId)) return send(response, 404, { error: `no model account ${accountId}` });

      try {
        if (loginMatch && method === 'POST') {
          const state = await input.logins.start(accountId);
          await audit({
            actor: auditActor(caller),
            action: 'model_account.sign_in',
            target: accountId,
            payload: { ...assertion(caller), state: state.state },
          });
          return send(response, 200, state);
        }
        if (loginMatch && method === 'GET') {
          return send(response, 200, await input.logins.status(accountId));
        }
        if (loginMatch && method === 'DELETE') {
          await input.logins.forget(accountId);
          await audit({
            actor: auditActor(caller),
            action: 'model_account.login_forgotten',
            target: accountId,
            payload: assertion(caller),
          });
          return send(response, 200, { ok: true });
        }
        if (verifyMatch && method === 'POST') {
          const check = await input.logins.verify(accountId);
          await audit({
            actor: auditActor(caller),
            action: 'model_account.checked',
            target: accountId,
            // Whether it answered, not what it said.
            payload: { ...assertion(caller), ok: check.ok },
          });
          return send(response, 200, check);
        }
        /*
         * A subscription's sign-in, taken into a backup, and taken over from
         * one. The files are credentials: they go to the bridge, which seals
         * them into an archive, and come back from one — and come back only
         * by being checked, on a copy, and kept when the CLI answered. Neither
         * is logged, and the audit line says which account, how many files
         * and whether it answered — never what is in them.
         */
        if (filesMatch && method === 'GET') {
          return send(response, 200, { files: await input.logins.signInFiles(accountId) });
        }
        if (adoptMatch && method === 'POST') {
          const body = await readBody(request);
          const files = body.files;
          if (typeof files !== 'object' || files === null || Array.isArray(files)) {
            return send(response, 400, { error: 'send the sign-in folder as files' });
          }
          const check = await input.logins.adoptSignIn(accountId, files as Record<string, string>);
          await audit({
            actor: auditActor(caller),
            action: 'model_account.login_adopted',
            target: accountId,
            payload: { ...assertion(caller), files: Object.keys(files).length, ok: check.ok },
          });
          return send(response, 200, check);
        }
        if (modelsMatch && method === 'GET') {
          // A read, so nothing is audited. The ids are grok's, dated by
          // nobody; the default is the one `newest:grok` resolves to.
          const models = await input.logins.models(accountId);
          return send(response, 200, {
            models: models.map((model) => ({
              id: model.id,
              createdAt: model.createdAt,
              isDefault: model.isDefault === true,
            })),
          });
        }
      } catch (error) {
        if (error instanceof LoginRefused) return send(response, error.status, { error: error.message });
        throw error;
      }
    }

    if (method === 'POST' && path === '/tasks') {
      const body = await readBody(request);
      const started = await runner.start({
        taskId: String(body.taskId ?? body.task_id ?? ''),
        bot: String(body.bot ?? ''),
        repo: body.repo ? String(body.repo) : null,
        kind: (body.kind ?? 'implement') as never,
        subjectRef: String(body.subjectRef ?? body.subject_ref ?? ''),
        branch: body.branch ? String(body.branch) : null,
        skill: String(body.skill ?? 'implement'),
        context: Array.isArray(body.context) ? (body.context as ContextDocument[]) : [],
        declaredPaths: Array.isArray(body.declaredPaths) ? (body.declaredPaths as string[]) : [],
        // The bridge sends the cap: the lower of the global and repository
        // per-task limits. `perTaskCapUsd` is only the fallback when a request
        // omits it.
        costCapUsd: Number(body.costCapUsd ?? input.perTaskCapUsd),
        checkoutExistingBranch: Boolean(body.checkoutExistingBranch),
        // A build continued on its branch after it ended without its pull
        // request (the bridge's `build-left.ts`) may have pushed nothing yet.
        startFromBaseIfMissing: Boolean(body.startFromBaseIfMissing),
        ...(typeof body.postHeader === 'string' ? { postHeader: body.postHeader } : {}),
        ...(Array.isArray(body.attachments) ? { attachments: body.attachments as TaskAttachment[] } : {}),
        ...(isReviewMode(body.reviewMode) ? { reviewMode: body.reviewMode } : {}),
        ...(isReviewLens(body.reviewLens) ? { reviewLens: body.reviewLens } : {}),
        // A stacked build starts from the branch it depends on. Only a plain
        // branch name, since it is used as a ref.
        ...(typeof body.baseRef === 'string' && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(body.baseRef) && !body.baseRef.includes('..')
          ? { baseRef: body.baseRef }
          : {}),
      });
      return send(response, 200, started);
    }

    // The repository's checks on a task's head, started and read by the
    // bridge for the task's session (`fleetadlc-ci`); the result reaches the
    // bridge from here, never from the session (`local-ci.ts`).
    const localCiMatch = /^\/tasks\/([^/]+)\/local-ci(?:\/([^/]+))?$/.exec(path);
    if (localCiMatch?.[1]) {
      if (!input.localCi) return send(response, 501, { error: 'this hostd runs no local CI' });
      if (method === 'POST' && !localCiMatch[2]) {
        try {
          return send(response, 202, { run: input.localCi.start(localCiMatch[1]) });
        } catch (error) {
          if (error instanceof LocalCiRefused) return send(response, 409, { error: error.message });
          throw error;
        }
      }
      if (method === 'GET' && localCiMatch[2]) {
        const run = input.localCi.get(localCiMatch[1], localCiMatch[2]);
        return run ? send(response, 200, { run }) : send(response, 404, { error: `no local CI run ${localCiMatch[2]} for task ${localCiMatch[1]} on this host` });
      }
    }

    const resumeMatch = /^\/tasks\/([^/]+)\/resume$/.exec(path);
    if (method === 'POST' && resumeMatch?.[1]) {
      const body = await readBody(request);
      const context = Array.isArray(body.context) ? (body.context as ContextDocument[]) : [];
      const postHeader = typeof body.postHeader === 'string' ? body.postHeader : undefined;
      const attachments = Array.isArray(body.attachments) ? (body.attachments as TaskAttachment[]) : undefined;
      const reviewMode = isReviewMode(body.reviewMode) ? body.reviewMode : undefined;
      const reviewLens = isReviewLens(body.reviewLens) ? body.reviewLens : undefined;
      return send(response, 200, await runner.resume(resumeMatch[1], context, postHeader, attachments, reviewMode, reviewLens));
    }

    const cancelMatch = /^\/tasks\/([^/]+)\/cancel$/.exec(path);
    if (method === 'POST' && cancelMatch?.[1]) {
      const body = await readBody(request);
      const reason = String(body.reason ?? 'cancelled by the bridge');
      await runner.cancel(cancelMatch[1], reason);
      return send(response, 200, { ok: true, reason });
    }

    // Cleanup releases the worktree and session of a task that has already
    // reached a terminal state; it must not overwrite that state.
    const cleanupMatch = /^\/tasks\/([^/]+)\/cleanup$/.exec(path);
    if (method === 'POST' && cleanupMatch?.[1]) {
      const body = await readBody(request);
      await runner.end(cleanupMatch[1], String(body.reason ?? 'task ended'));
      return send(response, 200, { ok: true });
    }

    const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);
    if (method === 'GET' && taskMatch?.[1]) {
      const task = await tasks.getTask(taskMatch[1]);
      if (!task) return send(response, 404, { error: 'unknown task' });
      const location = runner.sessionOf(task.id);
      const pane = location ? await driver.capturePane(location.bot, location.session, 40) : [];
      return send(response, 200, { task, pane: pane.map(redactSecrets) });
    }

    // Reading what a bot has written, without attaching to it and without a
    // second author in its worktree. Every answer here is a read: a bounded slice
    // of one file, or one directory's names. `readWorktree` decides what is
    // inside the worktree and what is not; the route's own job is to be sure the
    // root it hands over is one hostd created for a task that is running here.
    const worktreeMatch = /^\/tasks\/([^/]+)\/worktree$/.exec(path);
    if (method === 'GET' && worktreeMatch?.[1]) {
      const taskId = worktreeMatch[1];
      const task = await tasks.getTask(taskId);
      if (!task) return send(response, 404, { error: 'unknown task' });

      const root = runner.worktreeOf(taskId);
      if (!root) {
        return send(response, 409, {
          error: `task ${taskId} is not running on this host`,
          remedy: 'a worktree exists while its task does; a finished task’s work is on its branch',
        });
      }

      const view = await readWorktree(root, url.searchParams.get('path') ?? '');
      if (isWorktreeRefusal(view)) {
        return send(response, view.status, { error: view.error, remedy: view.remedy });
      }
      return send(response, 200, view);
    }

    const sessionsMatch = /^\/bots\/([^/]+)\/sessions$/.exec(path);
    if (method === 'GET' && sessionsMatch?.[1]) {
      const listed = await driver.listSessions(sessionsMatch[1]);
      return send(response, 200, {
        sessions: listed.map((session) => ({
          ...session,
          lastLine: session.lastLine === null ? null : redactSecrets(session.lastLine),
          pane: session.pane.map(redactSecrets),
        })),
      });
    }

    const paneMatch = /^\/bots\/([^/]+)\/sessions\/([^/]+)\/pane$/.exec(path);
    if (method === 'GET' && paneMatch?.[1] && paneMatch[2]) {
      const lines = Number(url.searchParams.get('lines') ?? '60');
      // A pane is what a session printed, a credential included; the console
      // shows it masked (`redactSecrets`, packages/shared/src/redact.ts).
      const pane = await driver.capturePane(paneMatch[1], paneMatch[2], lines);
      return send(response, 200, { pane: pane.map(redactSecrets) });
    }

    const killMatch = /^\/bots\/([^/]+)\/sessions\/([^/]+)\/kill$/.exec(path);
    if (method === 'POST' && killMatch?.[1] && killMatch[2]) {
      const stopping = await runner.stoppingByPerson(killMatch[1], killMatch[2], auditActor(caller));
      try {
        await driver.killSession(killMatch[1], killMatch[2]);
      } catch (error) {
        // The task is still running, so the note that a person stopped it is
        // not true; left in place, a later crash would read as on purpose.
        if (stopping) await runner.notStoppedAfterAll(stopping);
        throw error;
      }
      await audit({
        actor: auditActor(caller),
        action: 'session.kill',
        target: `${killMatch[1]}/${killMatch[2]}`,
        payload: assertion(caller),
      });
      return send(response, 200, { ok: true });
    }

    /**
     * "Restart" a bot: every task it has here is cancelled, which takes each
     * task's computer down, and its issue goes back to the board through the
     * bridge. There is no one container of a bot's to restart any more —
     * a computer is a task's — so this is what restarting ever did that still
     * means anything. The local driver's idle shell comes back.
     */
    const restartMatch = /^\/bots\/([^/]+)\/restart$/.exec(path);
    if (method === 'POST' && restartMatch?.[1]) {
      const bot = restartMatch[1];

      await bots.setBotStatus(bot, 'restarting');
      for (const taskId of runner.activeTaskIds()) {
        const location = runner.sessionOf(taskId);
        if (location?.bot === bot) await runner.cancel(taskId, 'its bot was restarted');
      }
      // And what is still starting: held only once it has started, it would
      // otherwise come up after the restart and run on.
      for (const taskId of runner.startingTaskIds(bot)) await runner.cancel(taskId, 'its bot was restarted');
      const record = await bots.getBotByName(bot);
      if (record) await sessionStore.removeSessionsForBot(record.id);
      if (driver.kind === 'local') await driver.ensureBot(bot).catch(() => undefined);
      await bots.setBotStatus(bot, 'running');
      await audit({ actor: auditActor(caller), action: 'bot.restart', target: bot, payload: assertion(caller) });
      return send(response, 200, { ok: true });
    }

    /**
     * A bot's computer, renamed: the bridge's first step when a bot takes the
     * handle of the account that connected, or goes back to its seat.
     *
     * Everything hostd keeps for a bot is named after it, so its task
     * computers and sessions go, with the work folder carried across; see
     * `renameBotComputer`. Nothing is made for the new name: a task's
     * computer, login and database are given when the task starts (`acquire`).
     */
    const renameMatch = /^\/bots\/([^/]+)\/rename$/.exec(path);
    if (method === 'POST' && renameMatch?.[1]) {
      const from = decodeURIComponent(renameMatch[1]);
      const body = await readBody(request);
      const to = String(body.to ?? '');

      try {
        const renamed = await renameBotComputer({
          from,
          to,
          driver,
          runner,
          workRoot: config.workRoot,
          taskState: async (taskId) => (await tasks.getTask(taskId))?.state ?? null,
        });
        await audit({
          actor: auditActor(caller),
          action: 'bot.computer_renamed',
          target: to,
          payload: { ...assertion(caller), from, folder: renamed.folder },
        });
        return send(response, 200, renamed);
      } catch (error) {
        if (error instanceof RenameRefused) return send(response, error.status, { error: error.message });
        throw error;
      }
    }

    if (method === 'POST' && path === '/terminal/tokens') {
      const body = await readBody(request);
      let bot = String(body.bot ?? '');
      let session = String(body.session ?? '');

      // By task, when the caller knows it: a task's session is in the task's
      // own computer, and the task is what knows which. One with no computer
      // here is said plainly rather than handed a token for nothing.
      const taskId = typeof body.taskId === 'string' && body.taskId ? body.taskId : null;
      if (taskId) {
        const location = runner.sessionOf(taskId);
        if (!location) {
          const refusal = await runner.whyNoComputer(taskId);
          return send(response, refusal.status, { error: refusal.error });
        }
        bot = location.bot;
        session = location.session;
      }

      // The grant carries the identity hostd authenticated, so redeeming it and
      // the socket that follows cannot name a different person than the mint.
      const minted = attachTokens.mint({ bot, session, identity: auditActor(caller) });
      await audit({
        actor: auditActor(caller),
        action: 'terminal.token',
        target: `${bot}/${session}`,
        payload: assertion(caller),
      });
      return send(response, 200, {
        ...minted,
        // Where a client opens its socket, and the subprotocol that carries
        // the token, good for one use. Never in the query string: the gateway
        // refuses that, and a proxy would have logged the token on the request line.
        websocketPath: '/terminal',
        subprotocol: `${ATTACH_SUBPROTOCOL_PREFIX}${minted.token}`,
      });
    }

    // `fleetadlc attach` redeems the same token for a command to run in a real terminal.
    if (method === 'POST' && path === '/terminal/redeem') {
      const body = await readBody(request);
      const grant = attachTokens.redeem(String(body.token ?? ''));
      if (!grant) return send(response, 401, { error: 'attach token is expired or unknown' });

      await audit({
        actor: grant.identity,
        action: 'terminal.attach',
        target: `${grant.bot}/${grant.session}`,
        payload: { via: 'cli' },
      });
      return send(response, 200, {
        command: driver.attachCommand(grant.bot, grant.session),
        bot: grant.bot,
        session: grant.session,
      });
    }

    return send(response, 404, { error: `no route for ${method} ${path}` });
  }
}

/** A review task's part, as the bridge sends it; anything else is no part, and holds the session to nothing more. */
function isReviewMode(value: unknown): value is ReviewMode {
  return value === 'lead' || value === 'blocking' || value === 'advisory';
}

/**
 * A review task's lens, as the bridge sends it. Lenses are free-form in
 * config/review.yaml and this one is written into the task's brief as a line
 * of its own, so it is a word or a few, never a newline that would start
 * another line of the brief.
 */
function isReviewLens(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
}
