'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { poll } from '@/lib/reach';
import {
  ABOUT_SIGNED_POSTS,
  COUNT_ONLY_SIGNED_TITLE,
  RECORDING_ONLY,
  RECORDING_ONLY_TITLE,
  SIGNATURE_DOES_NOT,
  SIGNATURE_DOES_NOT_TITLE,
  SIGNATURE_PROVES,
  SIGNATURE_PROVES_TITLE,
  SIGNED_POSTS_LINE,
  TRADEOFFS,
  TRADEOFFS_TITLE,
  UNSIGNED_IGNORED,
  UNSIGNED_SHOWN,
  WHEN_TO_TURN_ON,
  WHEN_TO_TURN_ON_TITLE,
  sharedReviewerConsequence,
  sharedReviewersFromAccounts,
  type SharedReviewers,
} from '@/lib/signed-posts';

/**
 * The (i) beside Signed posts.
 *
 * The line under the heading is why signing matters. This is the rest: what
 * a signature proves, what counting only signed posts changes — including
 * whether this install's reviewers share an account today — and the
 * trade-offs. Escape closes it, as every dialog here does.
 */
export function SignedPostsInfo({ shared }: { shared?: SharedReviewers | null }) {
  const consequence = useSharedReviewers(shared);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={ABOUT_SIGNED_POSTS}
          className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-edge-strong text-[11px] font-semibold italic leading-none text-muted hover:border-dim hover:text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
        >
          i
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Signed posts</DialogTitle>
        <DialogDescription>{SIGNED_POSTS_LINE}</DialogDescription>
        <div className="mt-4 flex flex-col gap-3 text-[12.5px] leading-relaxed">
          <Section title={SIGNATURE_PROVES_TITLE}>
            <ul className="list-disc pl-4">
              {SIGNATURE_PROVES.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Section>
          <Section title={SIGNATURE_DOES_NOT_TITLE}>
            <p>{SIGNATURE_DOES_NOT}</p>
          </Section>
          <Section title={COUNT_ONLY_SIGNED_TITLE}>
            <ul className="list-disc pl-4">
              <li>{UNSIGNED_IGNORED}</li>
              <li>{UNSIGNED_SHOWN}</li>
            </ul>
            <p className="mt-1">{consequence}</p>
          </Section>
          <Section title={RECORDING_ONLY_TITLE}>
            <p>{RECORDING_ONLY}</p>
          </Section>
          <Section title={TRADEOFFS_TITLE}>
            <ul className="list-disc pl-4">
              {TRADEOFFS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Section>
          <Section title={WHEN_TO_TURN_ON_TITLE}>
            <p>{WHEN_TO_TURN_ON}</p>
          </Section>
        </div>
        <div className="mt-5 flex justify-end">
          <DialogClose asChild>
            <Button size="sm" variant="ghost">
              Close
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="text-muted">
      <p className="font-medium text-body">{title}</p>
      <div className="mt-0.5">{children}</div>
    </section>
  );
}

/**
 * Whether this install's reviewers share an account.
 *
 * Passed in, that answer is used and nothing is read. Omitted — the settings
 * page, which does not hand the crew down here — the accounts are read once.
 * A failed read stays unknown rather than claiming they do not share.
 */
function useSharedReviewers(shared: SharedReviewers | null | undefined): string {
  const [read, setRead] = useState<SharedReviewers | null | 'unknown' | 'loading'>(shared !== undefined ? shared : 'loading');

  useEffect(() => {
    // Already known: reading again would replace a caller's answer with a later one.
    if (shared !== undefined) return;
    let cancelled = false;
    void poll<{ accounts?: { login: string; seats: { role: string; approves?: boolean }[] }[] }>('/api/github/identities').then((view) => {
      if (cancelled) return;
      setRead(view ? sharedReviewersFromAccounts(view.accounts ?? []) : 'unknown');
    });
    return () => {
      cancelled = true;
    };
  }, [shared]);

  if (shared !== undefined) return sharedReviewerConsequence(shared);
  return sharedReviewerConsequence(read);
}
