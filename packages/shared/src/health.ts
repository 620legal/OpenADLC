/**
 * What OpenADLC knows about the things it cannot do for itself.
 *
 * Asked "if the user has to do it, will the system let them know?", the answer
 * was: anything OpenADLC cannot do for itself gets a check that proves it was
 * done — by its effect, not by a setting — run continuously. A failing check is
 * a card on the board with the exact thing to do and a button to where it is
 * done; it clears itself when the check passes; a lasting blocking one is sent
 * through the notifications; the walkthrough marks a step done from the same
 * check; and `fleetadlc doctor` prints the same checks in a terminal.
 *
 * These are the shapes all of those read. The checks themselves are the
 * bridge's, in `apps/bridge/src/health/`.
 */

/**
 * `blocking` stops work: a bot that cannot sign in, a webhook GitHub is not
 * sending from. `warning` is wrong and costs something, and the work goes on:
 * user tokens that never expire, commits that read Unverified where nothing
 * requires them to be signed.
 */
export type HealthSeverity = 'blocking' | 'warning';

/**
 * Where a person goes to do what a failing check asks: a place in the console,
 * a page on GitHub, or — for the one thing only a shell on the machine can do —
 * a command to run.
 */
export type HealthAction =
  | { label: string; href: string }
  | { label: string; url: string }
  | { label: string; command: string };

/**
 * `unknown` is not a failure: GitHub could not be asked, or nothing has
 * happened yet that would prove it either way. It never raises a card and
 * never clears one.
 */
export type HealthState = 'ok' | 'failing' | 'unknown';

/** One check's latest answer about one subject, as `GET /v1/health` gives it. */
export interface HealthView {
  /** The check and its subject: `signing-key:<bot id>`, or `webhook`. */
  id: string;
  /** The check: `signing-key`. */
  check: string;
  /** What it is about — a bot's id, a repository, a permission — or null. */
  subject: string | null;
  /** What the check proves, in a sentence. */
  proves: string;
  state: HealthState;
  severity: HealthSeverity | null;
  /** What is wrong, in a line: "GitHub is not sending events to OpenADLC". */
  title: string | null;
  /** What to do about it, in a sentence or two; why it is unknown, when it is. */
  detail: string | null;
  action: HealthAction | null;
  /** When it started failing. */
  since: string | null;
  checkedAt: string;
  /** The bot it is about, by the name it goes by now. */
  bot: string | null;
  /** The walkthrough steps it answers. */
  steps: string[];
  /**
   * A failing check whose fix comes after another's — a bot's signing key
   * after the app's permission to register one — and whose card waits for it.
   */
  waitingFor: string[];
}

/** The action's target, whichever kind it is. */
export function actionTarget(action: HealthAction): string {
  return 'href' in action ? action.href : 'url' in action ? action.url : action.command;
}
