import type { ProjectMapView } from '../../hostd-client.js';
import type { HealthCheck } from '../types.js';

export const PROJECT_MAP_CHECK = 'project-map';

/** Where the map and its refresh are explained, for the card's button. */
export const PROJECT_MAP_DOCS_URL = 'https://github.com/620legal/OpenADLC/blob/main/docs/architecture.md#the-project-map';

export interface ProjectMapReader {
  repositories: { listRepos(): Promise<{ fullName: string }[]> };
  /** What hostd holds: each map, and its last attempt since hostd started. */
  maps(): Promise<ProjectMapView[]>;
}

/**
 * Whether each managed repository's project map was rebuilt the last time
 * hostd tried (docs/adr/0087). A failed build keeps the previous map, so the
 * card says which commit the kept one is from, or that there is none yet.
 * Nothing here is a person's step: the card clears itself on the next good
 * build.
 */
export function projectMapCheck(reader: ProjectMapReader): HealthCheck {
  return {
    id: PROJECT_MAP_CHECK,
    proves: 'Each managed repository’s project map was rebuilt from its default branch the last time hostd tried',
    how: 'asks hostd for each map’s last attempt (GET /project-maps), which it records in memory until its next try',
    everyMinutes: 15,
    steps: [],
    async run() {
      const repos = await reader.repositories.listRepos();
      let maps: ProjectMapView[];
      try {
        maps = await reader.maps();
      } catch (error) {
        const reason = `hostd could not be asked about the project maps: ${error instanceof Error ? error.message : error}`;
        return repos.map((repo) => ({ subject: repo.fullName, ok: null, reason }));
      }
      const byRepo = new Map(maps.map((map) => [map.repo.toLowerCase(), map]));
      return repos.map((repo) => {
        const map = byRepo.get(repo.fullName.toLowerCase());
        if (!map || map.state === 'never') {
          return { subject: repo.fullName, ok: null, reason: 'hostd has not built this repository’s project map since it started' };
        }
        if (map.state === 'failed') {
          const kept = map.commit
            ? `The map built from ${map.commit.slice(0, 7)}${map.builtAt ? ` at ${map.builtAt}` : ''} is kept until a build succeeds.`
            : 'It has no map yet.';
          return {
            subject: repo.fullName,
            ok: false,
            severity: 'warning',
            title: `The project map of ${repo.fullName} could not be rebuilt`,
            detail: `${map.error ?? 'hostd gave no reason'}. ${kept} The next try is on the maps job, within a quarter of an hour.`,
            action: { label: 'Open how the map is built', url: PROJECT_MAP_DOCS_URL },
          } as const;
        }
        return {
          subject: repo.fullName,
          ok: true,
          says: `built from ${(map.commit ?? '').slice(0, 7)}${map.builtAt ? ` at ${map.builtAt}` : ''}`,
          fixed: 'The project map is current again',
        } as const;
      });
    },
  };
}
