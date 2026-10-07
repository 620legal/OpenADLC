import type { HealthAction, HealthSeverity, ManualStep } from '@fleetadlc/shared';

/**
 * What one run of a check says about one subject.
 *
 * `ok: null` is no answer at all — GitHub could not be asked, or nothing has
 * happened yet that would prove it either way. It never raises a card and
 * never clears one; a row that was failing stays failing until a check can
 * say it is not.
 */
export type CheckResult =
  | {
      /** What it is about: a bot's id, a repository, a permission. None for a check about the install. */
      subject?: string | null;
      ok: true;
      /** Said once on the board when this passes after failing: "GitHub is delivering again". */
      fixed?: string;
      /**
       * Something OpenADLC did about it on its own, said once on the board whether
       * or not the check was failing: "Released #12, which nothing was working on".
       */
      note?: string;
      facts?: Record<string, unknown>;
    }
  | {
      subject?: string | null;
      ok: false;
      severity: HealthSeverity;
      /** What is wrong, in a line a person reads first. */
      title: string;
      /** What to do about it, and why it matters. */
      detail: string;
      /** The one thing to press. */
      action: HealthAction;
      /** Rows (`check:subject`) whose fix comes first; this card waits while any of them fails. */
      waitingFor?: string[];
      facts?: Record<string, unknown>;
    }
  | {
      subject?: string | null;
      ok: null;
      /** Why there is no answer, which `fleetadlc doctor` prints. */
      reason: string;
      facts?: Record<string, unknown>;
    };

/**
 * One thing a person had to do, and how OpenADLC knows it was done.
 *
 * A check answers by the effect of what was done, never by a setting that says
 * it was: GitHub's list of what it delivered, not the webhook's address; the
 * keys GitHub lists for an account, not the key OpenADLC stored. Every subject it
 * no longer returns is forgotten — a bot removed from the crew is not failing.
 */
export interface HealthCheck {
  /** Stable, and part of every row's id: `signing-key`. */
  id: string;
  /** What passing proves, in a sentence: "Each bot that commits has its signing key on its GitHub account". */
  proves: string;
  /** How it looks, by effect: "lists the account's signing keys on GitHub and compares the stored key's public half". */
  how: string;
  /** Minutes between runs when nothing asks sooner. */
  everyMinutes: number;
  /** The walkthrough steps this is the proof of; see `MANUAL_STEPS`. */
  steps: readonly ManualStep[];
  /**
   * Its cards are about something that happened — a post that was not
   * signed — rather than a state a person can put right, so nothing they do
   * makes it pass sooner. Such a card offers Dismiss, for what it names now
   * (`facts.occurrence`), and not Check again, which pressed after a fix
   * said "Still failing" for ever.
   */
  history?: boolean;
  /**
   * How long one run may take before its answer is given up on, when it is
   * not the registry's own limit: a check that asks GitHub once per repository
   * needs longer than one that asks once.
   */
  timeoutMs?: number;
  run(now: Date): Promise<CheckResult[]>;
}
