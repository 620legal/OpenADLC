import type { ReactNode } from 'react';

/**
 * One step of a thing set up by hand, numbered, with what to do under it.
 *
 * A crew account's sign-up — "1 Open GitHub's sign-up page in a private
 * window", "2 Sign up with these" — and the AI models step's too, "1 Copy the
 * command", "2 Paste the token it printed", so a Claude seat reads the same
 * way a GitHub account does: what to do, in order, with the value to copy beside it.
 * An item of an `<ol>`, which the caller supplies.
 */
export function Numbered({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-edge-strong text-[10px] text-muted">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] text-body">{title}</p>
        <div className="mt-1.5">{children}</div>
      </div>
    </li>
  );
}
