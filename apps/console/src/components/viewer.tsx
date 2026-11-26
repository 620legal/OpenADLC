'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Who is looking: the identity the bridge answered `/v1/me` with (the IAP
 * email behind IAP, `OPENADLC_IDENTITY` or `console` on a local install), read
 * by the root layout once per page. `null` when the bridge did not answer or
 * does not know them, and in a component drawn in a test with no provider.
 *
 * It keys this person's own browser state, such as which "How this works"
 * strips they collapsed, so another person on the same browser starts afresh.
 * It never decides what anyone may do: the bridge decides that on every call
 * (ADR 0082). With `null`, a feature draws its default and stores nothing.
 */
const ViewerContext = createContext<string | null>(null);

export function ViewerProvider({ identity, children }: { identity: string | null; children: ReactNode }) {
  return <ViewerContext.Provider value={identity}>{children}</ViewerContext.Provider>;
}

export function useViewerIdentity(): string | null {
  return useContext(ViewerContext);
}
