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
