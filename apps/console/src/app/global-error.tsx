'use client';

import './globals.css';

/**
 * The backstop under the layout itself: `error.tsx` sits inside the layout,
 * so a failure in the layout reaches only this. It draws its own document,
 * since the layout's is the part that failed.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
          <h1 className="text-lg font-semibold">The console stopped working</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            Try it again; if the console was just restarted or updated, reload the page.
          </p>
          <pre className="pane mt-4 overflow-x-auto rounded-md border border-edge bg-panel p-3 text-muted">
            {error.message || 'no reason was given'}
            {error.digest ? ` (${error.digest})` : ''}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex h-7 items-center rounded-md bg-body px-2.5 text-xs font-medium text-surface hover:bg-soft"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium text-soft hover:bg-well hover:text-body"
            >
              Reload the page
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
