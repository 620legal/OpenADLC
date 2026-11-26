import type { ContextDocument } from '@openadlc/shared';
import type { HostdClient, ProjectMapView } from './hostd-client.js';

/** How long between forced passes: the nightly rebuild, which reads every tree even where the commit is the same. */
export const PROJECT_MAP_FORCE_EVERY_MS = 24 * 60 * 60_000;

export interface ProjectMapRefresherDeps {
  repositories: { listRepos(): Promise<{ fullName: string; defaultBranch: string | null }[]> };
  hostd: Pick<HostdClient, 'refreshProjectMap' | 'projectMaps' | 'removeProjectMap'>;
  /** The seat whose token fetches each repository into hostd's mirror: the automation bot's. */
  bot: () => Promise<string>;
  now?: () => Date;
}

/**
 * Keeps hostd's project map of every managed repository current
 * (docs/adr/0087). The app is not subscribed to `push`, so a moved default
 * branch is found by asking: the `maps` job every quarter hour, the merge job
 * after it merged, and hostd rebuilds only when the commit changed. The first
 * pass after the bridge starts, and one a day after it, is forced, so a map
 * whose generator changed is rebuilt without a merge.
 */
export class ProjectMapRefresher {
  private running: Promise<string[]> | null = null;
  private lastForcedAt: number | null = null;

  constructor(private readonly deps: ProjectMapRefresherDeps) {}

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /**
   * One pass over every managed repository, one at a time, so a host is never
   * fetching all of them at once. A pass already going is joined rather than
   * started again beside it: the merge job's nudge and the clock can meet.
   * Returns a line for each map rebuilt and each that could not be.
   */
  refreshAll(options: { force?: boolean } = {}): Promise<string[]> {
    if (this.running) return this.running;
    this.running = this.pass(options).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(options: { force?: boolean }): Promise<string[]> {
    const now = this.now();
    const force = Boolean(options.force) || this.lastForcedAt === null || now - this.lastForcedAt >= PROJECT_MAP_FORCE_EVERY_MS;
    const repos = await this.deps.repositories.listRepos();
    const bot = await this.deps.bot();
    const lines: string[] = [];
    // The clock moves only after a forced pass hostd answered for every
    // repository: set before the pass, a first pass that met a hostd still
    // starting would put the next forced rebuild a day away, and a map from an
    // older generator would keep its stale bytes all that time.
    let answeredAll = true;
    for (const repo of repos) {
      try {
        const { map } = await this.deps.hostd.refreshProjectMap(repo.fullName, {
          defaultBranch: repo.defaultBranch || 'main',
          bot,
          ...(force ? { force: true } : {}),
        });
        const line = describe(map);
        if (line) lines.push(line);
      } catch (error) {
        answeredAll = false;
        lines.push(`${repo.fullName}: could not ask hostd for its project map: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (force && answeredAll) this.lastForcedAt = now;
    // A map of a repository OpenADLC no longer manages goes with it.
    const managed = new Set(repos.map((repo) => repo.fullName.toLowerCase()));
    try {
      const { maps } = await this.deps.hostd.projectMaps();
      for (const map of maps) {
        if (managed.has(map.repo.toLowerCase())) continue;
        const { deleted } = await this.deps.hostd.removeProjectMap(map.repo);
        if (deleted) lines.push(`${map.repo}: removed its project map, since it is no longer managed`);
      }
    } catch (error) {
      lines.push(`could not clear the project maps of repositories no longer managed: ${error instanceof Error ? error.message : error}`);
    }
    return lines;
  }
}

function describe(map: ProjectMapView): string | null {
  if (map.state === 'written') return `${map.repo}: project map rebuilt at ${(map.commit ?? '').slice(0, 7)}`;
  if (map.state === 'failed') return `${map.repo}: project map could not be rebuilt: ${map.error ?? 'no reason given'}`;
  return null;
}

/** A repository's map as the console and a task's context read it: hostd's view and the map's text. */
export interface ProjectMapRead {
  repo: string;
  commit: string | null;
  builtAt: string | null;
  state: ProjectMapView['state'];
  /** Redacted by hostd. */
  error: string | null;
  triedAt: string | null;
  /** The whole map, or null where there is none yet. */
  content: string | null;
}

/** One repository's map, from hostd's work root and never from a worktree (docs/adr/0088). */
export async function readProjectMap(hostd: Pick<HostdClient, 'projectMap'>, repoFullName: string): Promise<ProjectMapRead> {
  const { map, content } = await hostd.projectMap(repoFullName);
  return { repo: repoFullName, commit: map.commit, builtAt: map.builtAt, state: map.state, error: map.error, triedAt: map.triedAt, content };
}

/**
 * How much of a map a session is given. A repository of 200 areas makes a map
 * of about 100 KB, tens of thousands of tokens on every spec and implement
 * task; past this the rest is on the Map page, which always shows it whole.
 */
export const MAP_CONTEXT_BYTES = 48 * 1024;

export const PROJECT_MAP_DOCUMENT = 'project-map.md';

/**
 * The map as a context document, cut at the last line that fits
 * `MAP_CONTEXT_BYTES`; null where there is no map. skill-runner fences it
 * with its own source line, as OpenADLC's generated data, never instructions.
 */
export function mapDocument(read: ProjectMapRead, options: { consoleUrl?: string | null } = {}): ContextDocument | null {
  if (!read.content) return null;
  let map = read.content;
  if (Buffer.byteLength(map, 'utf8') > MAP_CONTEXT_BYTES) {
    // Cut on bytes, then back to the last whole line: a character split at
    // the limit, or half a line, would read as part of the map.
    const head = Buffer.from(map, 'utf8').subarray(0, MAP_CONTEXT_BYTES).toString('utf8');
    const at = head.lastIndexOf('\n');
    const kept = at < 0 ? '' : head.slice(0, at + 1);
    const left = map.slice(kept.length).replace(/\n$/, '').split('\n').length;
    const page = options.consoleUrl ? ` (${options.consoleUrl.replace(/\/+$/, '')}/map/${encodeURIComponent(read.repo)})` : '';
    map = `${kept}\n_The map continues past here: ${left} more ${left === 1 ? 'line' : 'lines'}, on the Map page${page}._\n`;
  }
  const short = read.commit ? read.commit.slice(0, 7) : 'an unknown commit';
  return {
    name: PROJECT_MAP_DOCUMENT,
    title: `The project map of ${read.repo}, built from ${short} at ${read.builtAt ?? 'an unknown time'}`,
    content: [
      `A summary of ${read.repo}'s default branch at ${read.commit ?? 'an unknown commit'}, generated by OpenADLC. Read it to find your way; open the files it names before you rely on them.`,
      '',
      map,
    ].join('\n'),
  };
}
