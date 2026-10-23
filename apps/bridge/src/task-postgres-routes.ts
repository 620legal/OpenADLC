import { audit, hosts, repos } from '@openadlc/db';
import {
  COMPOSE_FILES,
  parseTaskPostgres,
  postgresFromCompose,
  TASK_POSTGRES_ENV,
  TASK_POSTGRES_IMAGES,
  withoutPasswords,
  type ComposePostgresServer,
  type TaskPostgresSetting,
} from '@openadlc/shared';
import { HttpFailure, type Router } from './router.js';

/**
 * A repository's Postgres servers for its tasks, in Settings → Repositories
 * (`TaskPostgresSetting`, packages/shared/src/task-postgres.ts): read and set
 * by a person, never the crew. Both routes are an admin's (`roles.ts`), and
 * every `/v1` route is served only to a person — the console's server and
 * the CLI holding the console secret, or IAP's signed identity — never to a
 * task, whose token opens `/internal/tasks/<its id>/*` and nothing else. A
 * file the crew can edit was not an option: whatever the setting names runs
 * beside every task of the repository.
 *
 * Whether the install can give a task one is said beside it: the `local`
 * driver has no containers, and a setting it cannot honour is shown as
 * that, not saved in silence.
 */

/** A host is live while it heartbeats: every ten seconds, so two minutes is several missed. */
const LIVE_MS = 2 * 60_000;

export interface TaskPostgresSupport {
  /** True when a live host runs the docker driver; false when every live host runs `local`; null when no host is live. */
  ok: boolean | null;
  /** What to do about it, when it is not true. */
  why: string | null;
}

/** Whether the install's hosts can give a task a server of its own, from what each registered and when it last checked in. */
export function taskPostgresSupport(
  found: readonly { name: string; driver: 'docker' | 'local'; status: string; lastSeenAt: string | null }[],
  now = Date.now(),
): TaskPostgresSupport {
  const live = found.filter((host) => host.status !== 'down' && host.lastSeenAt !== null && now - Date.parse(host.lastSeenAt) < LIVE_MS);
  if (live.some((host) => host.driver === 'docker')) return { ok: true, why: null };
  if (live.length > 0) {
    return {
      ok: false,
      why:
        `${live.map((host) => host.name).join(', ')} ${live.length === 1 ? 'runs' : 'run'} the local driver, which has no containers to make a server in: ` +
        "a task here starts without one, and is told so. Run hostd with the docker driver (openadlc init --driver docker, then openadlc down && openadlc up) for these to take effect.",
    };
  }
  return { ok: null, why: 'No host has checked in for two minutes, so whether one can give a task a server of its own is not known: start hostd, and this says.' };
}

/**
 * What the repository's Compose file starts, for the form to be filled with
 * (`GET /v1/repos/:name/task-postgres/compose`): the file it was read from,
 * on which branch, and the servers; or why there are none to suggest.
 */
export type TaskPostgresCompose =
  | { ok: true; file: string; branch: string; servers: ComposePostgresServer[]; notes: string[] }
  | { ok: false; file: string | null; branch: string | null; why: string };

/** Reading a repository's files on GitHub, as the account the bridge reads GitHub with. */
export interface TaskPostgresGitHub {
  /** Who it reads as, to name in what to do when it cannot. */
  account: string;
  /** A file on a ref, null when it is not there; anything else GitHub answers is thrown. Null when the account is not connected. */
  client: { readFileIfPresent(repo: string, path: string, ref: string): Promise<string | null> } | null;
}

export interface TaskPostgresRouteDeps {
  repo(name: string): Promise<{ id: string; name: string; fullName: string; defaultBranch: string } | null>;
  read(repoId: string): Promise<unknown | null>;
  write(repoId: string, setting: TaskPostgresSetting | null): Promise<void>;
  hosts(): Promise<{ name: string; driver: 'docker' | 'local'; status: string; lastSeenAt: string | null }[]>;
  audit(entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<void>;
  /** GitHub, for the Compose file; absent where nothing asks it, and the form is then told so. */
  github?: () => Promise<TaskPostgresGitHub>;
  now?: () => number;
}

/** The routes' store, hosts and audit log, and GitHub as `github` reads it. */
export function liveTaskPostgresDeps(github?: () => Promise<TaskPostgresGitHub>): TaskPostgresRouteDeps {
  return {
    repo: (name) => repos.getRepoByName(name),
    read: (repoId) => repos.getTaskPostgres(repoId),
    write: (repoId, setting) => repos.setTaskPostgres(repoId, setting),
    hosts: () => hosts.listHosts(),
    audit: (entry) => audit(entry),
    ...(github ? { github } : {}),
  };
}

/**
 * The servers a repository's Compose file starts, read from its default
 * branch: what a laptop runs for it, where Compose looks, in the order it
 * prefers. The names are read at once; a file that could not be read is said,
 * rather than passed over for one Compose would take only after it.
 */
export async function composeSuggestion(
  repo: { fullName: string; defaultBranch: string },
  github: TaskPostgresGitHub | null,
): Promise<TaskPostgresCompose> {
  const branch = repo.defaultBranch;
  if (!github?.client) {
    const account = github?.account ?? 'automation';
    return {
      ok: false,
      file: null,
      branch,
      why: `${account} is not connected to GitHub, so the repository's Compose file cannot be read. Run: openadlc auth login --bot ${account}`,
    };
  }
  const client = github.client;
  const reads = await Promise.allSettled(COMPOSE_FILES.map((path) => client.readFileIfPresent(repo.fullName, path, branch)));
  for (const [index, path] of COMPOSE_FILES.entries()) {
    const read = reads[index];
    if (!read) continue;
    if (read.status === 'rejected') {
      const said = read.reason instanceof Error ? read.reason.message : String(read.reason);
      return { ok: false, file: path, branch, why: `${path} on ${branch} could not be read from GitHub (${said.slice(0, 200)}): try again` };
    }
    if (read.value === null) continue;
    const found = postgresFromCompose(read.value, path);
    return found.ok ? { ok: true, file: path, branch, servers: found.servers, notes: found.notes } : { ok: false, file: path, branch, why: found.why };
  }
  return { ok: false, file: null, branch, why: `${repo.fullName} has no Compose file on ${branch}: none of ${COMPOSE_FILES.join(', ')}` };
}

export function registerTaskPostgresRoutes(router: Router, deps: TaskPostgresRouteDeps = liveTaskPostgresDeps()): void {
  const view = async (repoId: string) => {
    const stored = await deps.read(repoId);
    const read = parseTaskPostgres(stored);
    return {
      // A stored setting that no longer reads is shown as what it is, so the
      // person can correct it: hostd refuses to start a task on it.
      taskPostgres: read.ok ? read.setting : null,
      unreadable: read.ok ? null : read.error,
      supported: taskPostgresSupport(await deps.hosts().catch(() => []), (deps.now ?? Date.now)()),
      images: TASK_POSTGRES_IMAGES,
      env: TASK_POSTGRES_ENV,
    };
  };

  const repoNamed = async (name: string | undefined) => {
    const repo = await deps.repo(name ?? '');
    if (!repo) throw new HttpFailure(404, `there is no repository ${name} in OpenADLC`);
    return repo;
  };

  router.get('/v1/repos/:name/task-postgres', async ({ params }) => view((await repoNamed(params.name)).id));

  /**
   * What the repository's Compose file would fill the form with. Read-only:
   * it saves nothing and audits nothing, and what it suggests reaches a task
   * only when a person saves it through the PUT, checked as anything typed is.
   */
  router.get('/v1/repos/:name/task-postgres/compose', async ({ params }) => {
    const repo = await repoNamed(params.name);
    return composeSuggestion(repo, deps.github ? await deps.github().catch(() => null) : null);
  });

  /**
   * The whole setting, replacing what was there: `{ servers: [] }` (or null)
   * takes it away. Refused whole with what to correct, so a half-written
   * server never reaches a task.
   */
  router.add('PUT', '/v1/repos/:name/task-postgres', async ({ params, body, identity }) => {
    const repo = await repoNamed(params.name);
    const input = await body<unknown>().catch(() => {
      throw new HttpFailure(400, 'send the setting as JSON: { servers: [{ port, superuser, password, database, image }], sharedDatabase }');
    });
    const read = parseTaskPostgres(input);
    if (!read.ok) throw new HttpFailure(400, read.error);
    await deps.write(repo.id, read.setting);
    await deps.audit({
      actor: identity,
      action: 'repo.task_postgres',
      target: repo.fullName,
      // The passwords are a repository's local defaults, and still not the
      // audit log's to show every admin who reads it.
      payload: { setting: withoutPasswords(read.setting) as Record<string, unknown> | null },
    });
    return view(repo.id);
  });
}
