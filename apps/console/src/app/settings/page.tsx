import { AppShell } from '@/components/app-header';
import { BackupCard } from '@/components/backup-card';
import { BridgeDown } from '@/components/bridge-down';
import { EngineUpdates } from '@/components/engine-updates';
import { GitHubCard } from '@/components/github-card';
import { CrewTable } from '@/components/github-accounts';
import { RepositoriesCard } from '@/components/repositories-card';
import { SettingsNav } from '@/components/settings-nav';
import { ModelAccountsCard } from '@/components/model-accounts-card';
import { modelAccountsKey } from '@/lib/model-accounts-key';
import { PauseWorkCard } from '@/components/pause-work';
import { SpendingSummary } from '@/components/spending-limits';
import { AppearanceSection, SettingsCard } from '@/components/settings-sections';
import { AdminsOnly } from '@/components/not-a-user';
import { UsersSection } from '@/components/users-section';
import { api, readMe, type WorkPauses } from '@/lib/api';
import { accountsFrom } from '@/lib/model-onboarding';
import { colorMapOf } from '@/lib/repo-colors';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/**
 * Settings, a section for each thing they set, with a navigation of their own:
 * the repositories — a list, each linking to its own page of settings, and
 * adding another; GitHub — where the app is installed, the install name its
 * posts are headed with, and the accounts OpenADLC signs in as; AI models — the
 * accounts the crew thinks with, set up before the table that picks one; the
 * crew — which GitHub account and which model each bot uses; the weekly engine
 * updates; the spending caps, summarised, with the amounts edited on their own
 * page; a backup of the install; pausing new work, across the install or in
 * chosen repositories; who may use the console; and how it looks: the color
 * mode, and each repository's and crew member's color.
 */
export default async function SettingsPage() {
  // Settings are an admin's: a user has no link here, and the bridge refuses
  // every change they could make. Someone who types the address is told so
  // rather than shown a page of sections that could not be read.
  const me = await readMe();
  if (me?.known && me.role !== 'admin') return <AdminsOnly email={me.email} identityMode={me.identityMode} what="Settings need" doing="changes settings" />;

  try {
    // The repositories and the crew are the page; the rest are parts of it a
    // bridge that cannot answer them leaves out rather than failing the page.
    //
    // The GitHub App, the install name, the engine updates and the backup used
    // to read their own after the page arrived, each a second or so later. The
    // first two sit above the crew, so the crew's buttons moved 400 pixels down
    // under a pointer already on its way to one: a click landed on whatever
    // was there before, and only the second one hit. Read here, the page is
    // drawn at the height it keeps; a section the bridge does not answer here
    // within `SECTION_READ_MS` still reads its own, so a slow GitHub costs the
    // page at most that.
    const [repos, crew, costs, spending, accounts, github, installations, install, engineUpdates, backup, paused] = await Promise.all([
      api.repos(),
      api.crew(),
      api.costs().catch(() => null),
      api.spendingLimits().catch(() => null),
      api.modelAccounts().then((body) => body.accounts).catch(() => null),
      api.githubAccounts().catch(() => null),
      api.installations().catch(() => null),
      api.install().catch(() => null),
      api.engineUpdates().catch(() => null),
      api.backup().catch(() => null),
      api.workPauses().catch((): WorkPauses => ({ paused: null, repos: {} })),
    ]);
    const users = await api.users().catch(() => null);
    const header = await readHeader({
      repos: repos.repos.map((repo) => repo.name),
      colors: colorMapOf(repos.repos),
      crew: crew.bots,
      costs,
    });

    return (
      <AppShell page="settings" data={header}>
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-4 py-6 md:flex-row md:gap-10 md:px-6 md:py-7">
          <SettingsNav />

          <main className="flex min-w-0 max-w-[820px] flex-1 flex-col gap-[18px]">
            <h1 className="sr-only">Settings</h1>

            {/*
              * `#repository` still, so a link to it from before there were
              * several lands here. A list: each repository's own settings are
              * on its page, `/settings/repositories/<name>`.
              */}
            <section id="repository" aria-labelledby="repositories-title" className="flex scroll-mt-7 flex-col">
              <RepositoriesCard repositories={repos.repos} crew={crew.bots} />
            </section>

            <GitHubCard accounts={github} installations={installations} install={install} />

            {/*
              * The accounts the crew thinks with, added, signed in, checked and
              * removed here: the walkthrough's accounts step, not a copy of it.
              * They come before the crew, so a row has an account to pick.
              * Which bot uses which is chosen on its row below.
              */}
            <ModelAccountsCard
              key={modelAccountsKey(crew.bots)}
              initial={accounts ? accountsFrom({ accounts }) : null}
            />

            {/*
              * One table for the crew: each bot, the GitHub account it acts as
              * and the model it thinks with, each changed on its row.
              */}
            <SettingsCard
              id="crew"
              title="Crew"
              line="Each bot, the GitHub account it acts as, and the model it thinks with."
            >
              <CrewTable crew={crew.bots} accounts={accounts ?? []} github={github} />
            </SettingsCard>

            <EngineUpdates initial={engineUpdates} />

            <SpendingSummary initial={spending} />

            <BackupCard initial={backup} />

            <PauseWorkCard initial={paused} repositories={repos.repos} />

            <UsersSection initial={users} me={me?.known ? me.email : ''} identityMode={me?.known ? me.identityMode : undefined} />

            <AppearanceSection repositories={repos.repos} crew={crew.bots} />
          </main>
        </div>
      </AppShell>
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
