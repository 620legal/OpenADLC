'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { consoleServesThisPage } from '@/app/actions';
import { consoleWasUpdated, sayConsoleUpdated } from '@/lib/console-updated';
import { readUnlessUpdated, refreshWhileVisible } from '@/lib/live-refresh';

/**
 * Reads the page again every fifteen seconds while it is on screen: "needs
 * you", the header's chip, the board and the crew come from the server, and
 * this is what brings them up to date. What is on screen that is only in the
 * browser — a draft, a card being moved, an open thread — stays as it is.
 *
 * Once the console was updated since the page loaded, it stops, and the page
 * says so with a reload (`readUnlessUpdated`, `ConsoleUpdatedNotice`).
 *
 * Only in the browser: the router it refreshes is the browser's, and a page
 * being drawn on the server has nothing to refresh.
 */
export function LiveRefresh() {
  const [inBrowser, setInBrowser] = useState(false);
  useEffect(() => setInBrowser(true), []);
  return inBrowser ? <Refresher /> : null;
}

function Refresher() {
  const router = useRouter();
  useEffect(() => {
    const stop = refreshWhileVisible(() => {
      if (consoleWasUpdated()) return stop();
      void readUnlessUpdated(consoleServesThisPage, () => router.refresh()).then((outcome) => {
        if (outcome !== 'updated') return;
        stop();
        sayConsoleUpdated();
      });
    }, document);
    return stop;
  }, [router]);
  return null;
}
