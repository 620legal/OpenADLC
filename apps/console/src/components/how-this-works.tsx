'use client';

import { useEffect, useId, useState } from 'react';
import { ExternalIcon } from '@/components/icons';
import { useViewerIdentity } from '@/components/viewer';
import { cn } from '@/lib/cn';
import {
  HOW_THIS_WORKS_CHANGED,
  storedStripOpen,
  storeStripOpen,
  stripKey,
  type StripChange,
  type StripId,
} from '@/lib/how-this-works-preferences';

/**
 * Where the strips' links go. The console does not serve `docs/`, and the
 * docs describe OpenADLC itself, so a link goes to OpenADLC's file on GitHub
 * whatever repository the page shows (as `RELEASE_ACCOUNT_DOCS` does).
 */
export const DOCS_BASE = 'https://github.com/620legal/OpenADLC/blob/main/';

export interface HowThisWorksProps {
  strip: StripId;
  title: string;
  /** Three or four short steps, in order. */
  steps: string[];
  link: { href: string; label: string };
}

/**
 * Each page's strip, in one place so the wording is reviewed in one place.
 * Every step is a fact the cited record says at the time of writing (#373's
 * design); change the step when the record changes.
 */
export const HOW_THIS_WORKS: Record<StripId, HowThisWorksProps> = {
  'needs-you': {
    strip: 'needs-you',
    title: 'How Needs you works',
    steps: [
      'Each card is something only a person can settle: a bot’s question, a plan change or promote waiting for an approver, a pull request waiting on your approval, a cost cap, or the crew’s own trouble.',
      'You see the cards for your roles: a question goes to the role it names, approvals to people with Approves on, a cost cap to admins.',
      'A question shows what it decides and what each choice leads to. Your answer goes on the issue, and the paused task starts again with it.',
      'A card clears itself once what it waited on is done.',
    ],
    link: { href: `${DOCS_BASE}docs/adr/0035-needs-you-items-follow-person-roles.md`, label: 'ADR 0035: Needs you follows person roles' },
  },
  releases: {
    strip: 'releases',
    title: 'How a release is cut',
    steps: [
      'If the head’s version is not above the last release, Prepare next version files a request, and the crew raises the version in a pull request.',
      'Cut release, by a person with Approves on, pins the default branch’s commit this page shows.',
      'You approve a device code with your own GitHub account. Nothing is built until you do.',
      'It is built in the release account and signed, and only then is that commit tagged and the release published, as the app.',
    ],
    link: {
      href: `${DOCS_BASE}docs/adr/0072-a-release-is-cut-by-an-approver-from-a-pinned-view-with-a-fresh-device-code-proof.md`,
      label: 'ADR 0072: a release is cut by an approver',
    },
  },
  'host-checks': {
    strip: 'host-checks',
    title: 'How a host check works',
    steps: [
      'It runs once the crew approves a pull request’s head: the lead and every approver, with no request for changes standing.',
      'It runs the command an admin set on the repository, on this machine, as its own OS account with no credential.',
      'A new head, a close or a merge cancels it, and every run ends with nothing of the account left running.',
      'The merge reads the bridge’s own record of the run, never the host-check status on GitHub.',
    ],
    link: {
      href: `${DOCS_BASE}docs/adr/0064-a-host-check-runs-as-its-own-account-and-the-merge-reads-the-bridges-record.md`,
      label: 'ADR 0064: a host check runs as its own account',
    },
  },
  'merge-state': {
    strip: 'merge-state',
    title: 'What this pull request needs to merge',
    steps: [
      'Only the merge line merges it, as the app. No bot merges or approves its own work.',
      'The lead approves this head, or an earlier head with the same diff.',
      'GitHub Actions’ ci passes on it.',
      'Each person AGENTS.md names for a changed path approves, on GitHub or, if they opened it, with their sign-off in the console.',
    ],
    link: { href: `${DOCS_BASE}AGENTS.md#invariants`, label: 'The merge invariant in AGENTS.md' },
  },
  costs: {
    strip: 'costs',
    title: 'What counts toward the caps',
    steps: [
      'Each run’s usage is written down before its output is acted on, so a cap stops work between turns.',
      'A run on an API key is billed, and counts toward the monthly, bot and provider limits and the leasing budget.',
      'A run on a subscription is an estimate: it is shown here, but counts toward none of those.',
      'A subscription run is still stopped at the runaway guard, ten times the per-task cap.',
    ],
    link: {
      href: `${DOCS_BASE}docs/adr/0050-a-subscription-run-is-estimated-not-billed.md`,
      label: 'ADR 0050: a subscription run is estimated, not billed',
    },
  },
};

/**
 * A short, collapsible account of what happens after a person acts on this
 * page. Open on a first visit; collapsing or opening it again is remembered
 * for this person in this browser.
 *
 * It draws open on the server and on the first client render, and reads what
 * is stored only after mount: the server cannot see this browser's storage,
 * and reading it during render would draw a different page than the server
 * sent.
 */
export function HowThisWorks({ strip, title, steps, link, className }: HowThisWorksProps & { className?: string }) {
  const identity = useViewerIdentity();
  const [open, setOpen] = useState(true);
  const id = useId();

  useEffect(() => {
    setOpen(storedStripOpen(strip, identity));
    if (identity === null) return;
    // Another strip of the same kind in this tab: take its state from the
    // event rather than storage, which may have refused the write.
    const onChange = (event: Event) => {
      const change = (event as CustomEvent<StripChange>).detail;
      if (change && change.strip === strip && change.identity === identity) setOpen(change.open);
    };
    // Another tab.
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === stripKey(strip, identity)) setOpen(storedStripOpen(strip, identity));
    };
    window.addEventListener(HOW_THIS_WORKS_CHANGED, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(HOW_THIS_WORKS_CHANGED, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [strip, identity]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    storeStripOpen(strip, identity, next);
  };

  return (
    <section className={cn('rounded-lg border border-edge bg-panel/40 px-4 py-2.5', className)} data-how-this-works={strip}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        className="flex w-full items-center gap-2 text-left text-[12px] font-semibold text-body hover:text-link"
      >
        <span aria-hidden="true" className="inline-block w-3 text-muted">
          {open ? '▾' : '▸'}
        </span>
        {title}
      </button>
      <div id={id} hidden={!open} className="mt-2">
        <ol className="list-decimal space-y-1 pl-8 text-[12px] text-soft">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="mt-2 ml-5 inline-flex items-center gap-1 text-[11.5px] text-link hover:underline"
        >
          {link.label}
          <ExternalIcon size={11} />
        </a>
      </div>
    </section>
  );
}
