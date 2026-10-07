'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { letCrewIn } from '@/app/actions';
import Link from 'next/link';
import { ChevronRightIcon, ExternalIcon, PlusIcon } from '@/components/icons';
import { RepoDot } from '@/components/repo-badge';
import { RepositoryField } from '@/components/repository-field';
import { atStart, labelIn, type BotFacts } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { accessLine, type RepoAccess } from '@/lib/crew-access';
import { repoSettingsPath } from '@/lib/settings';

/** A repository as the card lists it. */
export interface CardRepository {
  name: string;
  fullName?: string | null;
  color?: string | null;
  access?: RepoAccess | null;
}

const TONE = {
  signal: 'text-signal',
  attention: 'text-attention',
  alarm: 'text-alarm',
  muted: 'text-muted',
} as const;

/**
 * The head of settings' Repositories: what they are, whether the crew can
 * work in each, and adding another.
 *
 * Adding one used to be possible only in the walkthrough, which asked for a
 * single repository, so an install stayed with the one it started with. This
 * adds through the same route the walkthrough does — the builder owns it, and
 * it gets the next colour — from the repositories the app can reach, and the
 * bridge lets the crew into it straight away. Each repository's line says how
 * that went: all of them in, being let in, or the first one that could not
 * get in and why, with a way to try again.
 */
export function RepositoriesCard({
  repositories,
  crew = [],
}: {
  repositories: readonly CardRepository[];
  /** The crew, to name a bot the way a person knows it. */
  crew?: readonly BotFacts[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(repositories.length === 0);
  const panel = useId();
  const added = repositories.map((repo) => repo.fullName ?? repo.name);

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-edge bg-panel px-5 py-[18px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id="repositories-title" className="text-[13.5px] font-semibold text-body">
            Repositories
          </h2>
          <p className="text-[12.5px] leading-snug text-muted">
            {repositories.length === 0
              ? 'No repository yet: the crew works nowhere until you add one.'
              : 'Where the crew works. When the board shows every repository, each is told apart by its color and its name.'}
          </p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((shown) => !shown)}
          className={cn(
            'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors md:h-8',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link',
            open ? 'border-edge-strong bg-well text-body' : 'border-edge-strong text-soft hover:text-body',
          )}
        >
          <PlusIcon size={13} />
          Add a repository
        </button>
      </div>

      {repositories.length > 0 && (
        <ul aria-label="Whether the crew can work in each repository" className="flex flex-col border-t border-well">
          {repositories.map((repo) => (
            <AccessRow key={repo.name} repo={repo} nameOf={(bot) => atStart(labelIn(crew, bot).said)} onDone={() => router.refresh()} />
          ))}
        </ul>
      )}

      {open && (
        <div id={panel} className="border-t border-well pt-3.5">
          <RepositoryField added={added} onAdded={() => router.refresh()} />
        </div>
      )}
    </div>
  );
}

/**
 * What to say of the crew's access: a Try again's answer until the page has
 * read a newer one. The answer was kept for good, and the line said "1 of 2
 * bots" after the second had connected, until a reload.
 */
export function newerAccess(answer: RepoAccess | null, read: RepoAccess | null | undefined): RepoAccess | null {
  if (!answer) return read ?? null;
  if (!read?.checkedAt) return answer;
  return (answer.checkedAt ?? '') >= read.checkedAt ? answer : read;
}

/** One repository: its colour and name, whether the crew can work there, and trying again. */
function AccessRow({
  repo,
  nameOf,
  onDone,
}: {
  repo: CardRepository;
  nameOf: (bot: string) => string;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [answer, setAnswer] = useState<RepoAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = accessLine(pending ? { repository: repo.fullName ?? repo.name, running: true, trigger: 'retry', checkedAt: null, error: null, bots: [] } : newerAccess(answer, repo.access), nameOf);

  const retry = (): void => {
    setError(null);
    startTransition(async () => {
      const result = await letCrewIn(repo.name);
      if (!result.ok) {
        setError(result.error ?? 'the bridge refused it');
        return;
      }
      if (result.access) setAnswer(result.access);
      onDone();
    });
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-well py-2.5 last:border-b-0 last:pb-0">
      <Link
        href={repoSettingsPath(repo.name)}
        aria-label={`${repo.name} settings`}
        className="-my-1 flex min-h-11 min-w-[8rem] items-center gap-2 rounded-md text-[13px] font-medium text-body hover:underline focus-visible:outline-2 focus-visible:outline-link md:min-h-0"
        title={repo.fullName ?? repo.name}
      >
        <RepoDot color={repo.color} />
        <span className="truncate">{repo.name}</span>
        <ChevronRightIcon size={12} className="shrink-0 text-dim" />
      </Link>
      <span role="status" className="flex min-w-0 flex-1 flex-col gap-0.5 text-[12.5px]">
        <span className={cn('font-medium', TONE[shown.tone], shown.busy && 'animate-pulse')}>{shown.text}</span>
        {(shown.reason || error) && <span className="leading-snug text-muted">{error ? `Not tried: ${error}` : shown.reason}</span>}
      </span>
      {shown.action && (
        <button
          type="button"
          onClick={retry}
          disabled={pending}
          className="inline-flex h-11 shrink-0 items-center rounded-md border border-edge-strong px-3 text-[12.5px] text-soft transition-colors hover:text-body focus-visible:outline-2 focus-visible:outline-link disabled:opacity-60 md:h-7"
        >
          {shown.action}
        </button>
      )}
      {/* The step is on GitHub; the page reads itself again, so the line changes once it is done. */}
      {shown.link && (
        <a
          href={shown.link.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md bg-body px-3 text-[12.5px] font-medium text-surface transition-colors hover:bg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link md:h-7"
        >
          {shown.link.label}
          <ExternalIcon size={11} />
        </a>
      )}
    </li>
  );
}
