'use client';

import Link from 'next/link';
import { useState, useTransition, type ReactNode, type Ref } from 'react';
import { countOnlySignedPosts, holdPull } from '@/app/actions';
import { useRole } from '@/components/app-header';
import { PAUSE_WORK } from '@/components/pause-work';
import type { UnsignedIncident } from '@/lib/api';
import { COUNT_ONLY_SIGNED_CHANGES, thisPostCounted } from '@/lib/signed-posts';

/** Where each step's thing is done, on GitHub, signed in as the account. */
const GITHUB_ACCOUNT_PAGES = [
  { label: 'Authorized GitHub Apps', url: 'https://github.com/settings/apps/authorizations', says: 'revoke the OpenADLC app; every seat on this account stops until you reconnect it' },
  { label: 'Password and authentication', url: 'https://github.com/settings/security', says: 'change the password, check two-factor' },
  { label: 'Sessions', url: 'https://github.com/settings/sessions', says: 'sign out anything you do not recognise' },
  { label: 'Personal access tokens', url: 'https://github.com/settings/tokens', says: 'delete any you did not make' },
  { label: 'SSH and signing keys', url: 'https://github.com/settings/keys', says: 'remove any you did not add' },
] as const;

const BUTTON =
  'inline-flex h-9 items-center justify-center rounded-md border border-edge-strong px-3 text-[12.5px] text-body transition-colors hover:border-dim disabled:opacity-60 md:h-7 md:px-2.5';
const LINK = 'text-link hover:underline';

/**
 * What to do about a crew post OpenADLC did not sign, as steps in the card's
 * sheet, each with the thing to press where there is one. The same steps are
 * `docs/runbooks/unsigned-post.md`. What an unsigned post counts as is
 * `signed-posts.ts`, the words Settings uses, so the two cannot disagree.
 * "This was me" is the card's own Dismiss, passed in, so it is pressed the
 * way the card presses it.
 *
 * Holding a pull request, counting only signed posts and Settings are an
 * admin's, and the bridge refuses a user them: a user is told to ask an admin,
 * as the card hides its admin-only actions, rather than offered buttons that
 * fail with a role error in the middle of an incident.
 */
export function IncidentSteps({ incident, thisWasMe, ref }: { incident: UnsignedIncident; thisWasMe: ReactNode; ref?: Ref<HTMLElement> }) {
  const { target } = incident;
  const admin = useRole() === 'admin';
  return (
    // Focusable, so What to do opens the sheet here rather than at its top.
    <section ref={ref} tabIndex={-1} aria-label="What to do" className="flex scroll-mt-4 flex-col gap-2 text-[12.5px] leading-relaxed outline-none">
      <p className="text-[11px] uppercase tracking-wider text-dim">What to do</p>
      <p className="text-muted">
        A {incident.did} by {incident.login}
        {target ? ` on #${target.number}` : ''} carries no signature from OpenADLC.{' '}
        {thisPostCounted(incident.counted)}{' '}
        The same steps are in <code className="font-mono text-[11.5px]">docs/runbooks/unsigned-post.md</code>.
      </p>
      <ol className="flex list-decimal flex-col gap-3 pl-5 marker:text-dim">
        <li>
          <p className="font-medium text-body">Make sure it wasn’t you.</p>
          <p className="text-muted">Someone signed in to {incident.login} by hand, in a browser or with gh, posts without a signature.</p>
          <div className="mt-1">{thisWasMe}</div>
        </li>
        <li>
          <p className="font-medium text-body">See what it affected.</p>
          {target ? (
            <p className="text-muted">
              <a href={target.url} target="_blank" rel="noreferrer" className={LINK}>
                {target.kind === 'pr' ? 'Pull request' : 'Issue'} #{target.number} ↗
              </a>
              {incident.postUrl && (
                <>
                  {' · '}
                  <a href={incident.postUrl} target="_blank" rel="noreferrer" className={LINK}>
                    the post ↗
                  </a>
                </>
              )}
            </p>
          ) : (
            <p className="text-muted">The post does not say what it was on; open it from the card.</p>
          )}
          {target?.kind === 'pr' &&
            (admin ? (
              <HoldPull repo={incident.repo} number={target.number} />
            ) : (
              <p className="text-muted">Ask an admin to hold #{target.number}: holding a pull request is an admin’s.</p>
            ))}
          <p className="text-muted">If it already merged, revert it: Revert on the pull request, or git revert the merge commit and open a pull request.</p>
          <p className="text-muted">
            Check what else {incident.login} did: its recent pushes and branches, the pull requests and issues it opened or updated, and, signed in as
            it, its{' '}
            <a href="https://github.com/settings/security-log" target="_blank" rel="noreferrer" className={LINK}>
              security log ↗
            </a>
            .
          </p>
        </li>
        <li>
          <p className="font-medium text-body">Count only signed posts.</p>
          <p className="text-muted">{COUNT_ONLY_SIGNED_CHANGES}</p>
          {admin ? (
            <CountOnlySigned already={incident.mode === 'enforce'} />
          ) : incident.mode === 'enforce' ? (
            <p className="text-signal">This install counts only signed posts.</p>
          ) : (
            <p className="text-muted">An admin changes this in Settings; ask one to.</p>
          )}
        </li>
        <li>
          <p className="font-medium text-body">Lock the account down.</p>
          <p className="text-muted">On GitHub, signed in as {incident.login}:</p>
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-muted">
            {GITHUB_ACCOUNT_PAGES.map((page) => (
              <li key={page.url}>
                <a href={page.url} target="_blank" rel="noreferrer" className={LINK}>
                  {page.label} ↗
                </a>{' '}
                — {page.says}
              </li>
            ))}
          </ul>
          {admin ? (
            <p className="text-muted">
              Then, once, in OpenADLC:{' '}
              <Link href="/settings#github-accounts" className={LINK}>
                reconnect {incident.login}
              </Link>
              .
            </p>
          ) : (
            <p className="text-muted">Then ask an admin to reconnect {incident.login} once, in Settings, which replaces the sign-in OpenADLC holds.</p>
          )}
        </li>
        <li>
          <p className="font-medium text-body">Pause OpenADLC until it’s cleared.</p>
          {admin ? (
            <p className="text-muted">
              <Link href={PAUSE_WORK} className={LINK}>
                Settings → Pause work
              </Link>{' '}
              stops anything new from starting until you resume it.
            </p>
          ) : (
            <p className="text-muted">An admin pauses work in Settings, which stops anything new from starting until it is resumed; ask one to.</p>
          )}
        </li>
      </ol>
    </section>
  );
}

function HoldPull({ repo, number }: { repo: string; number: number }) {
  const [pending, startTransition] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={BUTTON}
        disabled={pending || said?.ok === true}
        onClick={() =>
          startTransition(async () => {
            const result = await holdPull(repo, number);
            setSaid(
              result.ok
                ? {
                    ok: true,
                    text: result.autoMergeOff
                      ? `Held: #${number} is labelled needs-human, auto-merge is off, and review-gate stays pending until the label comes off.`
                      : `Held: #${number} is labelled needs-human and review-gate stays pending, but auto-merge could not be turned off — turn it off on the pull request.`,
                  }
                : { ok: false, text: result.error ?? 'that did not go through' },
            );
          })
        }
      >
        {pending ? 'Holding…' : 'Hold this PR'}
      </button>
      {said && <span className={said.ok ? 'text-signal' : 'text-alarm'}>{said.text}</span>}
    </div>
  );
}

function CountOnlySigned({ already }: { already: boolean }) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState(already);
  const [error, setError] = useState<string | null>(null);
  if (done) return <p className="text-signal">This install counts only signed posts.</p>;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {asking ? (
        <>
          <button
            type="button"
            className={`${BUTTON} border-alarm/50 text-alarm`}
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await countOnlySignedPosts();
                if (result.ok) setDone(true);
                else setError(result.error ?? 'that did not go through');
              })
            }
          >
            {pending ? 'Switching…' : 'Yes, count only signed posts'}
          </button>
          <button type="button" className={BUTTON} onClick={() => setAsking(false)}>
            Not now
          </button>
        </>
      ) : (
        <button type="button" className={BUTTON} onClick={() => setAsking(true)}>
          Count only signed posts
        </button>
      )}
      {error && <span className="text-alarm">{error}</span>}
    </div>
  );
}
