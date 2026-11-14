import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { ChevronLeftIcon } from '@/components/icons';
import { AdminsOnly } from '@/components/not-a-user';
import { RepoSettings } from '@/components/repo-settings';
import { api, readMe, saveHostCheck, type DesignMemoryEntry, type HostCheckSetting, type TaskPostgresView, type WorkPauses } from '@/lib/api';
import { findBot } from '@/lib/bot-label';
import { colorMapOf } from '@/lib/repo-colors';
import { readHeader } from '@/lib/read-header';
import { buildersOf } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/**
 * One repository's settings, on a page of its own: who builds it, how many
 * tasks at once, what each stage may do without asking, its colour, and
 * taking it out of OpenADLC. They were all on the settings page, one repository
 * after another, which made that page as long as the list of repositories;
 * settings now lists them and links here.
 */
export default async function RepositorySettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  /** `hostCheckError`: the bridge's refusal of the last host check save, said beside its form. */
  searchParams?: Promise<{ hostCheckError?: string }>;
}) {
  const { name } = await params;
  const { hostCheckError } = (await searchParams) ?? {};
  const wanted = decodeURIComponent(name);
  // A repository's settings are an admin's, as Settings is: a user who types
  // the address is told so, rather than shown controls whose every save, and
  // the design memory's read, the bridge refuses.
  const me = await readMe();
  if (me?.known && me.role !== 'admin')
    return <AdminsOnly email={me.email} identityMode={me.identityMode} what="Repository settings need" doing="changes a repository’s settings" />;
  let read;
  try {
    const [repos, crew, costs, pauses, memory, taskPostgres] = await Promise.all([
      api.repos(),
      api.crew(),
      api.costs().catch(() => null),
      api.workPauses().catch((): WorkPauses => ({ paused: null, repos: {} })),
      // A bridge a release behind has no design memory: the page still draws.
      (async () => api.designMemory(wanted))().catch((): DesignMemoryEntry[] => []),
      // Nor its Postgres servers for its tasks: the section is left out.
      (async () => api.taskPostgres(wanted))().catch((): TaskPostgresView | null => null),
    ]);
    const header = await readHeader({
      repos: repos.repos.map((one) => one.name),
      colors: colorMapOf(repos.repos),
      crew: crew.bots,
      costs,
    });
    read = { repos, crew, header, pauses, memory, taskPostgres };
  } catch (error) {
    return <BridgeDown error={error} />;
  }

  const { repos, crew, header, pauses, memory, taskPostgres } = read;
  const repo = repos.repos.find((one) => one.name === wanted);
  // A repository taken out of OpenADLC, or a link with a name that never was one.
  if (!repo) notFound();
  const owner = repo.owner ? (findBot(crew.bots, repo.owner) ?? null) : null;
  const reviewers = crew.bots.filter((bot) => bot.role.startsWith('review')).length;

  return (
    <AppShell page="settings" data={header}>
      <main className="mx-auto flex w-full max-w-[820px] flex-col gap-4 px-4 py-6 md:px-6 md:py-7">
        <Link
          href="/settings#repository"
          className="inline-flex h-11 items-center gap-1 self-start text-[12.5px] text-link hover:underline md:h-auto"
        >
          <ChevronLeftIcon size={12} />
          Settings
        </Link>
        <section aria-label={`${repo.name} settings`} className="rounded-[10px] border border-edge bg-panel px-5 py-[18px]">
          <RepoSettings
            repo={repo}
            owner={owner}
            builders={buildersOf(owner, crew.bots)}
            reviewers={reviewers}
            maxReviewRounds={repos.maxReviewRounds ?? null}
            pause={pauses.repos[repo.name] ?? null}
            installPaused={Boolean(pauses.paused)}
            designMemory={memory}
            taskPostgres={taskPostgres}
          />
          {/* The seed writes what config/repos.yaml sets at every start, over a change made here. */}
          <p className="mt-2.5 text-[12.5px] text-muted">
            A setting written for this repository in config/repos.yaml is put back at the next start. One the file leaves out
            stays as you set it here.
          </p>
        </section>
        <HostCheckSection repo={repo.name} setting={repo.hostCheck ?? null} error={hostCheckError ?? null} />
      </main>
    </AppShell>
  );
}

/** The time limit a new host check is given, as the bridge's own default. */
const DEFAULT_HOST_CHECK_MINUTES = 60;

/**
 * A repository's host check (#327): a command, such as `make host-ci`, that
 * hostd runs on this machine as an account of its own once the crew approves
 * a head, for a build no container can do. It is set here, by an admin, and
 * nowhere a pull request can change. Saved by a server action: an empty
 * command, or Clear, takes it away; the bridge checks the rest and its words
 * come back on the page when it refuses.
 */
function HostCheckSection({ repo, setting, error }: { repo: string; setting: HostCheckSetting | null; error: string | null }) {
  const here = `/settings/repositories/${encodeURIComponent(repo)}`;
  async function save(form: FormData) {
    'use server';
    const command = String(form.get('command') ?? '').trim();
    const clear = form.get('intent') === 'clear' || command === '';
    const minutes = Number(form.get('timeoutMinutes'));
    const saved = await saveHostCheck(
      repo,
      clear ? null : { command, timeoutMinutes: Number.isFinite(minutes) ? Math.round(minutes) : DEFAULT_HOST_CHECK_MINUTES, required: form.get('required') === 'on' },
    );
    revalidatePath(here);
    redirect(saved.ok ? `${here}#host-check` : `${here}?hostCheckError=${encodeURIComponent(saved.error ?? 'it was not saved')}#host-check`);
  }
  return (
    <section id="host-check" aria-label="Host check" className="rounded-[10px] border border-edge bg-panel px-5 py-[18px]">
      <h3 className="text-[14px] font-semibold text-body">Host check</h3>
      <p className="mt-1 text-[12.5px] text-muted">
        Runs on this machine, outside the containers, as an account of its own, once the crew approves a head; set the account
        up first as docs/self-hosting.md#host-checks says.
      </p>
      <form action={save} className="mt-3 flex flex-col gap-2.5 text-[12.5px]">
        <label className="flex flex-col gap-1">
          <span className="text-soft">Command</span>
          <input
            name="command"
            type="text"
            maxLength={500}
            defaultValue={setting?.command ?? ''}
            placeholder="make host-ci"
            className="h-9 rounded-md border border-edge bg-surface px-2.5 font-mono text-body"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-soft">Time limit, in minutes</span>
          <input
            name="timeoutMinutes"
            type="number"
            min={1}
            max={1440}
            step={1}
            defaultValue={setting?.timeoutMinutes ?? DEFAULT_HOST_CHECK_MINUTES}
            className="h-9 w-32 rounded-md border border-edge bg-surface px-2.5 text-body"
          />
        </label>
        <label className="inline-flex items-center gap-2">
          {/* On by default: a host check is set because the change has to build here before it lands. */}
          <input name="required" type="checkbox" defaultChecked={setting?.required ?? true} />
          <span className="text-body">Required for merge</span>
        </label>
        {error && (
          <p role="status" data-error className="text-alarm">
            {error}
          </p>
        )}
        <div className="flex gap-1.5">
          <button type="submit" name="intent" value="save" className="h-9 rounded-md border border-edge bg-surface px-3 text-body hover:bg-panel">
            Save
          </button>
          {setting && (
            <button type="submit" name="intent" value="clear" className="h-9 rounded-md border border-edge px-3 text-soft hover:bg-surface">
              Clear
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
