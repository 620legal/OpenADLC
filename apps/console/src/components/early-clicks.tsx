'use client';

import { useEffect } from 'react';
import { reactStarted, replayEarlyClick } from '@/lib/early-clicks';

/**
 * Presses the button a person clicked before React had started, once it can
 * answer; see `lib/early-clicks.ts`. In the root layout, so every page has it,
 * and it runs once, after the first render has hydrated.
 */
export function EarlyClicks() {
  useEffect(() => {
    replayEarlyClick(window as unknown as Record<string, unknown>, {
      started: reactStarted(document),
      warn: (message) => console.warn(message),
    });
  }, []);
  return null;
}
