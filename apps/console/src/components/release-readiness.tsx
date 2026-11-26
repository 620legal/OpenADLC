'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReleaseReadiness as Readiness, ReleaseReadinessItem } from '@/lib/api';

/**
 * The checklist above Cut release (#371, docs/adr/0084): what a cut needs,
 * each item passing or failing with the exact thing to do, so a setup problem
 * shows here rather than halfway through a build, in its log.
 *
 * It only informs: it never disables, hides or changes Cut release, and is
 * given nothing of it. It reads the bridge again every minute while the page
 * is visible, and at once when the page becomes visible again. A read that
 * fails keeps the last items on screen, marked stale.
 */

/** How often the checklist is read again while the page is visible. */
export const READINESS_READ_MS = 60_000;

const MARK: Record<ReleaseReadinessItem['status'], { sign: string; word: string; tone: string }> = {
  pass: { sign: '✓', word: 'Passes', tone: 'text-signal' },
  fail: { sign: '✗', word: 'Fails', tone: 'text-alarm' },
  unknown: { sign: '?', word: 'Could not check', tone: 'text-attention' },
};

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `the console answered ${response.status}`;
}

export function ReleaseReadiness({ repo, initial }: { repo: string; initial: Readiness | null }) {
  const [readiness, setReadiness] = useState<Readiness | null>(initial);
  const [failed, setFailed] = useState<string | null>(initial ? null : 'the bridge did not answer');

  const read = useCallback(async () => {
    try {
      const response = await fetch(`/api/releases/${encodeURIComponent(repo)}/readiness`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await errorOf(response));
      setReadiness((await response.json()) as Readiness);
      setFailed(null);
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : String(cause));
    }
  }, [repo]);

  // The page could not read it: asked once more from the browser rather than a minute on.
  useEffect(() => {
    if (!initial) void read();
  }, [initial, read]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, READINESS_READ_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [read]);

  const checks = readiness?.items.filter((item) => !item.informational) ?? [];
  const informational = readiness?.items.filter((item) => item.informational) ?? [];
  const failing = checks.filter((item) => item.status !== 'pass').length;

  return (
    <section data-readiness className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold text-body">Before you cut</h2>
      <p className="text-[12px] text-dim">
        {readiness
          ? failing === 0
            ? 'Everything a cut needs is in place.'
            : `${failing} of ${checks.length} need${failing === 1 ? 's' : ''} attention before a build would get through. This only informs; Cut release works as always.`
          : 'What a cut needs could not be checked yet.'}
      </p>
      {failed && (
        <p data-readiness-stale className="text-[12px] text-attention">
          {readiness ? `Stale: the last read failed (${failed}); showing what was checked at ${readiness.checkedAt}.` : `Could not check: ${failed}.`}
        </p>
      )}
      {checks.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-[12.5px]">
          {checks.map((item) => (
            <Item key={item.id} item={item} />
          ))}
        </ul>
      )}
      {informational.length > 0 && (
        <div className="flex flex-col gap-1.5 text-[12.5px]">
          <p className="text-[11px] uppercase tracking-wide text-dim">For information</p>
          <ul className="flex flex-col gap-1.5">
            {informational.map((item) => (
              <Item key={item.id} item={item} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Item({ item }: { item: ReleaseReadinessItem }) {
  const mark = MARK[item.status];
  return (
    <li data-readiness-item={item.id} data-status={item.status} className="flex gap-2">
      <span className={`${mark.tone} w-3 shrink-0 text-center`} aria-label={mark.word} title={mark.word}>
        {mark.sign}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p>
          <span className="font-medium text-body">{item.title}</span>
          {item.status === 'unknown' && <span className="text-attention"> · could not check</span>}
          <span className="text-soft"> — {item.says}</span>
        </p>
        {item.status === 'fail' && item.fix && (
          <p data-readiness-fix className="text-soft">
            {item.fix}
          </p>
        )}
        {item.status === 'fail' && item.action && <Action action={item.action} />}
      </div>
    </li>
  );
}

function Action({ action }: { action: NonNullable<ReleaseReadinessItem['action']> }) {
  if ('command' in action) {
    return (
      <p className="flex flex-wrap items-center gap-2">
        <code data-readiness-command className="break-all rounded bg-well px-1.5 py-0.5 font-mono text-[11.5px] text-body">
          {action.command}
        </code>
        <button
          type="button"
          className="text-[11.5px] text-link hover:underline"
          onClick={() => void navigator.clipboard?.writeText(action.command).catch(() => undefined)}
        >
          Copy
        </button>
      </p>
    );
  }
  const href = 'url' in action ? action.url : action.href;
  const external = 'url' in action;
  return (
    <a data-readiness-action href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} className="text-[12px] text-link hover:underline">
      {action.label}
    </a>
  );
}
