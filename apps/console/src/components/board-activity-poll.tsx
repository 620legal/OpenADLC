'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Board } from '@/lib/api';
import { ACTIVITY_EVERY_MS, needsFullRead, runningRefs, type BoardActivity } from '@/lib/board-activity';
import { REFRESH_EVERY_MS, refreshWhileVisible } from '@/lib/live-refresh';
import { poll } from '@/lib/reach';

/**
 * Reads the board's running cards every few seconds while one on it runs and
 * the page is on screen, and hands each answer to the board to draw them by
 * (`withActivity`). When the answer says a card started, paused or ended, it
 * reads the whole page instead, at most once a full refresh apart, so a
 * bridge whose two reads disagree costs no more than `LiveRefresh` does.
 *
 * Only in the browser, as `LiveRefresh` is: the router it refreshes is the
 * browser's, and a page drawn on the server has nothing to poll.
 *
 * Also while `watching`, the list of running tasks open: a task on no card
 * shown, a triage on a console request, ran with no card running, and its
 * list said the same minutes until the next full read.
 */
export function BoardActivityPoll(props: { board: Board; repo: string; watching?: boolean; onActivity: (board: Board, activity: BoardActivity) => void }) {
  const [inBrowser, setInBrowser] = useState(false);
  useEffect(() => setInBrowser(true), []);
  return inBrowser ? <Poller {...props} /> : null;
}

function Poller({ board, repo, watching = false, onActivity }: { board: Board; repo: string; watching?: boolean; onActivity: (board: Board, activity: BoardActivity) => void }) {
  const router = useRouter();
  const drawn = useRef(board);
  drawn.current = board;
  const report = useRef(onActivity);
  report.current = onActivity;
  const askedAt = useRef(-Infinity);
  const running = runningRefs(board).join('\n');

  useEffect(() => {
    if (!running && !watching) return;
    const url = `/api/board/activity?repo=${encodeURIComponent(repo)}`;
    return refreshWhileVisible(
      () => {
        const asked = drawn.current;
        void poll<BoardActivity>(url).then((activity) => {
          // Nothing usable this time, or the whole board came back meanwhile.
          if (!activity || !Array.isArray(activity.cards) || drawn.current !== asked) return;
          if (!needsFullRead(asked, activity)) return report.current(asked, activity);
          if (Date.now() - askedAt.current < REFRESH_EVERY_MS) return;
          askedAt.current = Date.now();
          router.refresh();
        });
      },
      document,
      { every: ACTIVITY_EVERY_MS },
    );
  }, [running, watching, repo, router]);

  return null;
}
