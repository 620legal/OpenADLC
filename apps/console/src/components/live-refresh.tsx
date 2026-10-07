'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { refreshWhileVisible } from '@/lib/live-refresh';

/**
 * Reads the page again every fifteen seconds while it is on screen: "needs
 * you", the header's chip, the board and the crew come from the server, and
 * this is what brings them up to date. What is on screen that is only in the
 * browser — a draft, a card being moved, an open thread — stays as it is.
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
  useEffect(() => refreshWhileVisible(() => router.refresh(), document), [router]);
  return null;
}
