import { GitHubAccountsCard } from '@/components/github-accounts-card';
import { GitHubAppCard } from '@/components/github-app-card';
import { InstallNamePart } from '@/components/install-name-card';
import { SettingsCard } from '@/components/settings-sections';
import type { InstallSettings } from '@/components/install-settings';
import type { GitHubAccountsView } from '@/lib/api';
import type { InstallationsView } from '@/lib/app-reach';

/**
 * Settings' GitHub, in one card: the app OpenADLC works through, the name every
 * post it writes there is headed with, and the accounts it signs in as. Each
 * part keeps the id links land on — `#github-app`, `#install`,
 * `#github-accounts` — from when they were sections of their own.
 *
 * Which bot uses which account is not here: that is the crew's, row by row.
 */
export function GitHubCard({
  accounts,
  installations = null,
  install = null,
}: {
  accounts: GitHubAccountsView | null;
  /** Read by the page for the first paint; each part reads its own when absent. */
  installations?: InstallationsView | null;
  install?: InstallSettings | null;
}) {
  return (
    <SettingsCard id="github" title="GitHub" line="The app, what OpenADLC’s posts are headed with, and the accounts it signs in as.">
      <GitHubAppCard initial={installations} />
      <InstallNamePart initial={install} />
      <GitHubAccountsCard view={accounts} />
    </SettingsCard>
  );
}
