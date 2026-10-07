/** The part of the bridge's view of a check this reads. */
export interface CheckState {
  check: string;
  state: string;
}

/**
 * What to say after "Check again" when the check still fails. The card itself
 * redraws exactly as it was, so without a word the press looks like it did
 * nothing; null when the check passed and the card is gone.
 */
export function stillFailing(checks: readonly CheckState[], checkId: string): string | null {
  const failing = checks.some((view) => view.check === checkId && view.state === 'failing');
  return failing ? 'Still failing: checked just now.' : null;
}
