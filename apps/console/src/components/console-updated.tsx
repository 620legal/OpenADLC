'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { consoleWasUpdated, noticeWanted, onConsoleUpdated, reloadWhenIdle } from '@/lib/console-updated';

/**
 * Says, over whatever page is open, that the console was updated since the
 * page loaded, with the one thing that helps: a reload. Shown once the page
 * learns it, from an action the console refused or from the page's own check
 * before it reads itself again (`LiveRefresh`), and kept until the reload,
 * unless the page's error screen says it in its place (`error.tsx`). An
 * untouched page reloads itself after five minutes (`reloadWhenIdle`): one
 * nobody is at, such as a board on a wall, would otherwise stay stale behind
 * the notice for good.
 *
 * In the root layout, so every page has it, outside each page's error
 * boundary. Above a dialog, which leaves the rest of the page unclickable
 * while it is open: the notice takes pointer events back for itself.
 */
export function ConsoleUpdatedNotice() {
  const [shown, setShown] = useState(false);
  const [known, setKnown] = useState(false);
  useEffect(() => {
    const read = (): void => {
      setShown(noticeWanted());
      setKnown(consoleWasUpdated());
    };
    read();
    return onConsoleUpdated(read);
  }, []);
  useEffect(() => (known ? reloadWhenIdle(() => window.location.reload()) : undefined), [known]);
  if (!shown) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center px-3 pt-3">
      <div
        role="status"
        className="pointer-events-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-attention/40 bg-panel px-3 py-2 text-[12.5px] text-body shadow-xl"
      >
        <p className="min-w-0 flex-1">
          The console was updated since this page loaded, so the page is out of date and some of its buttons no longer work.
          Reload it to go on.
        </p>
        <Button size="sm" variant="primary" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
      </div>
    </div>
  );
}
