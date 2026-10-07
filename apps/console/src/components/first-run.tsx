'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRole } from '@/components/app-header';
import { BotAvatar } from '@/components/avatar';
import { CheckIcon, ExternalIcon, PlusIcon, WarningIcon } from '@/components/icons';
import { IntakeDialog } from '@/components/intake-dialog';
import { RepoDot } from '@/components/repo-badge';
import type { BoardColumn, CrewMember } from '@/lib/api';
import { findBot, labelIn, type BotLabel } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import type { CrewCounts } from '@/lib/crew';
import { crewCheck, reviewGateCheck, webhookCheck, type ReadinessCheck, type RepoPlanView } from '@/lib/readiness';
import type { RepoLook } from '@/lib/repo-colors';
import { STAGES, stageOf } from '@/lib/stages';

/** What a stage's crew is called when there is more than one of them. */
const PLURAL: Record<string, string> = {
  intake: 'intake bots',
  spec: 'system engineers',
  build: 'builders',
  review: 'reviewers',
  merged: 'SREs',
};

/**
 * The board before anything is on it.
 *
 * Six empty columns and a row of idle bots is what a new install used to see,
 * which reads as a broken product rather than one waiting for its first
 * request. This says what to do — file a request — and what will happen to it:
 * the six stages, and who does each.
 */
export function FirstRun({
  columns,
  crew,
  counts,
  repos,
  repo,
  repoFullName,
  repositories = [],
  labelOf,
}: {
  columns: readonly BoardColumn[];
  crew: readonly CrewMember[];
  counts: CrewCounts;
  repos: string[];
  repo: string;
  /** `owner/name`, for filing on GitHub directly, and for the review-gate check. */
  repoFullName: string | null;
  /** Every repository, when the board shows them all and there is no one to file in. */
  repositories?: readonly RepoLook[];
  labelOf: (name: string) => BotLabel;
}) {
  // Setting up is an admin's; a user is not sent to the walkthrough, which the bridge refuses them.
  const admin = useRole() === 'admin';
  const [webhook, setWebhook] = useState<ReadinessCheck | null>(null);
  const [reviewGate, setReviewGate] = useState<ReadinessCheck | null>(null);

  // Asked after the page is up, not before: both are questions for GitHub, and
  // the page should not wait on them. Until they answer, and if they cannot,
  // their line is simply not there.
  useEffect(() => {
    let live = true;
    void fetch('/api/webhook', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((status) => live && setWebhook(webhookCheck(status)))
      .catch(() => undefined);
    if (repoFullName) {
      void fetch('/api/repo-setup', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { repositories?: RepoPlanView[] } | null) => live && setReviewGate(reviewGateCheck(body?.repositories, repoFullName)))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [repoFullName]);

  const ready = counts.total > 0 && counts.connected === counts.total && !counts.needsReconnecting;
  const checks = [crewCheck(counts), webhook, reviewGate].filter((check): check is ReadinessCheck => check !== null);

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-9 px-4 py-8 md:flex-1 md:justify-center md:px-6 md:py-10">
      <section aria-labelledby="first-title" className="flex flex-col gap-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-dim">
          {ready ? 'Your crew is ready' : 'Finish setting up your crew'}
        </p>
        <h1 id="first-title" className="text-[26px] font-semibold leading-tight tracking-[-0.015em] text-body">
          File your first request
        </h1>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted">
          Describe the change in a sentence. The intake bot asks for anything missing and files the issue on GitHub.
          The crew builds, reviews and ships it, and asks you in Needs you when it needs something.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3.5">
          <IntakeDialog repos={repos} labelOf={labelOf} defaultRepo={repo}>
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-md bg-body px-4 text-sm font-medium text-surface transition-colors hover:bg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
            >
              <PlusIcon size={15} />
              New request
            </button>
          </IntakeDialog>
          {repoFullName ? (
            <a
              href={`https://github.com/${repoFullName}/issues/new`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-[5px] text-[13px] text-link hover:underline"
            >
              or file an issue on GitHub
              <ExternalIcon size={12} />
            </a>
          ) : (
            // Several repositories, and no one of them this page is about: the
            // way to GitHub is one per repository rather than none at all.
            repositories.some((repository) => repository.fullName) && (
              <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
                or file an issue on GitHub in
                {repositories
                  .filter((repository) => repository.fullName)
                  .map((repository) => (
                    <a
                      key={repository.name}
                      href={`https://github.com/${repository.fullName}/issues/new`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-link hover:underline"
                    >
                      <RepoDot color={repository.color} />
                      {repository.name}
                      <ExternalIcon size={11} />
                    </a>
                  ))}
              </span>
            )
          )}
        </div>

        <ul aria-label="What is ready" className="mt-3.5 flex flex-wrap gap-x-[22px] gap-y-2 text-[12.5px] text-soft">
          {checks.map((check) => (
            <li key={check.text} className="flex items-center gap-1.5">
              {check.ok ? (
                <CheckIcon className="text-signal" />
              ) : (
                <WarningIcon className="text-attention" />
              )}
              <span className={check.ok ? undefined : 'text-attention'}>{check.text}</span>
              {check.fix && admin && (
                <Link href={check.fix.href} className="text-link hover:underline">
                  {check.fix.label}
                </Link>
              )}
            </li>
          ))}
          {admin && (
            <li className="flex items-center">
              <Link href="/onboarding" className="text-link hover:underline">
                See the setup
              </Link>
            </li>
          )}
        </ul>
      </section>

      <section
        aria-labelledby="flow-title"
        className="flex flex-col gap-3.5 rounded-[10px] border border-edge bg-panel px-5 pb-5 pt-[18px]"
      >
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h2 id="flow-title" className="text-[13px] font-semibold text-body">
            How a request moves
          </h2>
          <span className="text-[12px] text-dim">
            Who does each stage. Change it in{' '}
            <Link href="/settings" className="text-link hover:underline">
              Settings
            </Link>
            .
          </span>
        </div>
        <ol className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          {STAGES.map((stage, index) => {
            const column = columns.find((one) => one.stage === stage.key);
            return (
              <li key={stage.key} className="flex flex-col gap-2 rounded-lg border border-edge bg-surface p-3">
                <div className="flex items-center gap-2">
                  <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-edge-strong text-[10px] text-muted">
                    {index + 1}
                  </span>
                  <span className="text-[13px] font-semibold text-body">{stage.title}</span>
                </div>
                <p className="text-[12px] leading-normal text-muted">{stage.subtitle}</p>
                <Staff stage={stage.key} names={column?.bots.map((bot) => bot.name) ?? []} crew={crew} />
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

/** Who does a stage: one bot by name, several as a row of faces and a count, Done as nobody. */
function Staff({ stage, names, crew }: { stage: string; names: string[]; crew: readonly CrewMember[] }) {
  if (names.length === 0) {
    return (
      <span className="mt-auto text-[11.5px] text-dim">{stage === 'done' ? 'Nobody needed' : 'Nobody staffs it yet'}</span>
    );
  }
  const bots = names.map((name) => findBot(crew, name) ?? { name });
  if (bots.length === 1) {
    const label = labelIn(crew, names[0]!);
    return (
      <span className="mt-auto flex min-w-0 items-center gap-1.5 text-[11.5px] text-soft" title={label.text}>
        <BotAvatar bot={bots[0]!} size="sm" />
        <span className="truncate">{label.name}</span>
      </span>
    );
  }
  return (
    <span className="mt-auto flex items-center gap-1.5 text-[11.5px] text-soft" title={names.map((name) => labelIn(crew, name).text).join(', ')}>
      <span className="flex">
        {bots.map((bot, index) => (
          <BotAvatar key={bot.name ?? index} bot={bot} size="sm" ring className={cn(index > 0 && '-ml-[5px]')} />
        ))}
      </span>
      {bots.length} {PLURAL[stage] ?? stageOf(stage)?.title ?? 'bots'}
    </span>
  );
}
