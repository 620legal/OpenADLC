import { PROJECT_URL } from '@openadlc/shared';
import type { HealthCheck } from '../types.js';

/** The card's title, which the docs repeat. */
export const OLD_NAMES_TITLE = 'This cloud install still has the names from before the rename to OpenADLC';

/** Where the steps are, which the card opens. */
export const RENAME_RUNBOOK = `${PROJECT_URL}/blob/main/docs/runbooks/rename-gcp-host.md`;

/**
 * A cloud install made before the rename keeps its secrets as `fleet-<ref>`,
 * and its host keeps `fleet-hostd` and /var/lib/fleet, until a person renames
 * them with the host idle (docs/runbooks/rename-gcp-host.md). It runs on them
 * meanwhile, since the secret store, the host's cloud-init and `openadlc cloud
 * update` read either; but nothing said the step was left, and those readers
 * go once every install has been renamed, taking an install that was not with
 * them. The old secrets are what the bridge can see, and the runbook deletes
 * them last, once the host is checked, so none left is the rename done. A
 * warning, since nothing is wrong yet. Remove with the readers.
 */
export function cloudNamesCheck(store: { beforeRename(): Promise<string[]> } | null): HealthCheck {
  return {
    id: 'cloud-names',
    proves: 'The cloud install’s secrets and host have OpenADLC’s names, not the ones from before the rename',
    how: 'lists the Secret Manager secrets labelled fleet=secret, which the rename deletes last',
    everyMinutes: 60,
    steps: [],
    async run() {
      // Only Secret Manager had the old names; a file store never did.
      if (!store) return [];
      let left: string[];
      try {
        left = await store.beforeRename();
      } catch (error) {
        return [{ ok: null, reason: `Secret Manager could not be listed: ${error instanceof Error ? error.message : String(error)}` }];
      }
      if (left.length === 0) return [{ ok: true, fixed: 'The cloud install has OpenADLC’s names now' }];
      const named = `${left.slice(0, 3).join(', ')}${left.length > 3 ? `, and ${left.length - 3} more` : ''}`;
      return [
        {
          ok: false,
          severity: 'warning',
          title: OLD_NAMES_TITLE,
          detail:
            `Secret Manager still holds ${left.length === 1 ? 'a secret' : `${left.length} secrets`} under the old names (${named}), ` +
            'and the host may still run as fleet-hostd from /var/lib/fleet. The install works on them for now: this release ' +
            'reads either name. A later one reads only OpenADLC’s, so rename them first, with no task running: copy each ' +
            'secret to its new name, apply the module, which resets the host, check it, then delete the old secrets, ' +
            'which clears this card.',
          action: { label: 'Open the rename’s steps', url: RENAME_RUNBOOK },
          facts: { secrets: left.length },
        },
      ];
    },
  };
}
