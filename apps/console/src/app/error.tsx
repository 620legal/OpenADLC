'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { isStaleAction, sayConsoleUpdatedInPlace } from '@/lib/console-updated';

/**
 * What a page shows when drawing it failed in the browser, in place of Next's
 * "Application error" that replaced the whole page without a word of what to
 * do. A page that cannot reach the bridge says so itself (`BridgeDown`); this
 * is the backstop for everything else, a control the console did not catch
 * included. The header and the rest of the layout stay.
 *
 * An action refused because the console was updated since the page loaded
 * says that instead, with Reload alone: Try again sent the same refused
 * action again, and Next's own words for it did not say that nothing was done
 * (`lib/console-updated.ts`).
 */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  if (isStaleAction(error)) return <ConsoleUpdated />;
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col justify-center px-6">
      <h1 className="text-lg font-semibold">This page stopped working</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        Something on it failed in the browser. Try it again; if the console was just restarted or updated, reload the
        page. A request or a message you were writing is kept.
      </p>
      <pre className="pane mt-4 overflow-x-auto rounded-md border border-edge bg-panel p-3 text-muted">
        {error.message || 'no reason was given'}
        {error.digest ? ` (${error.digest})` : ''}
      </pre>
      <div className="mt-4 flex gap-2">
        <Button size="sm" variant="primary" onClick={() => reset()}>
          Try again
        </Button>
        <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
      </div>
    </main>
  );
}

/** In place of the page, with the one reload on screen: the notice over the page steps aside. */
function ConsoleUpdated() {
  useEffect(() => sayConsoleUpdatedInPlace(), []);
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col justify-center px-6">
      <h1 className="text-lg font-semibold">The console was updated</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        It was updated since this page loaded, so what you just did was not done. Reload the page, then do it again. A
        request or a message you were writing is kept.
      </p>
      <div className="mt-4 flex gap-2">
        <Button size="sm" variant="primary" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
      </div>
    </main>
  );
}
