'use client';

import { useEffect, useState } from 'react';

export interface GitHubAccount {
  login: string;
  type: 'User' | 'Organization';
  avatarUrl: string;
  htmlUrl: string;
}

export interface GitHubLookup {
  exact: GitHubAccount | null;
  suggestions: GitHubAccount[];
  rateLimited: boolean;
  /** GitHub could not be asked: unreachable, or an error that is not a rate limit. */
  unavailable?: boolean;
}

/** What a failed lookup answers with: nothing known about the name either way. */
const UNAVAILABLE: GitHubLookup = { exact: null, suggestions: [], rateLimited: false, unavailable: true };

/** Whether GitHub gave no answer about the name: rate-limited, or not reached. */
export function couldNotAsk(lookup: GitHubLookup | null): boolean {
  return Boolean(lookup?.rateLimited || lookup?.unavailable);
}

/** What is looked up for a value: the name as GitHub has it, without an `@`. */
export function lookupTerm(value: string): string {
  return value.trim().replace(/^@/, '');
}

/**
 * Who a half-typed name is on GitHub, asked of the bridge while it is typed.
 *
 * Debounced, because GitHub allows ten unauthenticated searches a minute and
 * a keystroke each would spend that in a word. A failure is not an error the
 * field stops on: it answers `unavailable`, which, like a rate limit, says
 * nothing about the name, so a field that needs a match offers to take it
 * unchecked rather than saying nobody is called that.
 *
 * Only the answer for what is typed now is returned. A slow answer for an
 * earlier term used to land after a newer one: "jane" arriving after
 * "janedoe" said nobody was called janedoe, and its `looking: false` let Save
 * through while the newer lookup was still out.
 */
export function useGitHubLookup(value: string): { lookup: GitHubLookup | null; looking: boolean } {
  const [answer, setAnswer] = useState<{ term: string; lookup: GitHubLookup | null } | null>(null);
  const [looking, setLooking] = useState(false);
  const term = lookupTerm(value);

  useEffect(() => {
    if (term.length < 2) {
      setAnswer(null);
      setLooking(false);
      return;
    }

    let current = true;
    const controller = new AbortController();
    setLooking(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/github-accounts?q=${encodeURIComponent(term)}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        const lookup = response.ok ? ((await response.json()) as GitHubLookup) : UNAVAILABLE;
        if (current) setAnswer({ term, lookup });
      } catch {
        if (current) setAnswer({ term, lookup: UNAVAILABLE });
      } finally {
        if (current) setLooking(false);
      }
    }, 400);

    return () => {
      current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [term]);

  return { lookup: answer?.term === term ? answer.lookup : null, looking };
}
