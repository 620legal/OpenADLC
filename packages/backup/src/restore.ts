import { BackupError, type BackupContents } from './archive.js';
import { applyRestore, type RestoreOutcome, type RestoreTarget } from './apply.js';
import { planRestore, restoredIdentities, restoredName, type InstallShape, type RestorePlan } from './plan.js';
import {
  keepOnlySignIns,
  restoredIdentityOfSignIn,
  refusedChoice,
  selectSignIns,
  signInLines,
  takeOverSignIns,
  type SignIn,
  type SignInChoices,
  type SignInLine,
  type TakeOverPorts,
} from './signins.js';
import { summarizeRestore, type RestoreSummary } from './summary.js';

/**
 * A restore from start to finish, the same wherever it is run from.
 *
 * The walkthrough's restore onto a clean install, `fleetadlc restore`, and a
 * restore into an install that is already set up all come through here, with
 * the archive's sign-ins already judged (`judgeSignIns`) and a choice made of
 * them. In order:
 *
 *   1. A choice that ticks a sign-in that cannot be ticked is refused before
 *      anything else happens.
 *   2. Every sign-in not to be written as the archive has it is taken out of
 *      the archive — blocked, the same as here, not chosen, or rotating — so
 *      the plan and the one transaction that writes it cannot hold one.
 *   3. The rows and the working sign-ins are written, in that transaction.
 *   4. Each chosen rotating sign-in is checked by using it, and taken over only
 *      when the provider accepts it; a refusal writes nothing for it.
 *   5. Every bot that now holds a sign-in takes its account's handle.
 *
 * What comes back says what became of every sign-in, and what is left for a
 * person: each bot to connect again, and why.
 */

export interface RestoreRun {
  contents: BackupContents;
  shape: InstallShape;
  signIns: readonly SignIn[];
  choices: SignInChoices;
  target: RestoreTarget;
  takeOver: TakeOverPorts;
  actor: string;
  auditAction?: string;
  /** How the archive's caps are written (`applyRestore`): replaced by default. */
  spending?: 'replace' | 'merge';
  now?: () => Date;
}

export interface RestoreRename {
  name: string;
  to: string;
  state: string;
  reason?: string;
}

export interface RestoreReport {
  plan: RestorePlan;
  outcome: RestoreOutcome;
  signIns: SignInLine[];
  renames: RestoreRename[];
  summary: RestoreSummary;
}

/** An error's words, bounded, for a line a person reads. The messages here name things, never values. */
function said(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * What a restore would do with these choices, without doing any of it: the
 * plan of what the one transaction writes, and the summary a page shows.
 */
export function previewRestore(input: Pick<RestoreRun, 'contents' | 'shape' | 'signIns' | 'choices'>): {
  plan: RestorePlan;
  signIns: SignInLine[];
  summary: RestoreSummary;
} {
  const selection = selectSignIns(input.signIns, input.choices);
  const contents = keepOnlySignIns(input.contents, selection.write);
  const plan = planRestore(contents, input.shape);
  const signIns = signInLines(input.signIns, input.choices);
  return { plan, signIns, summary: summarizeRestore(contents, plan, input.shape.bots, signIns) };
}

export async function runRestore(run: RestoreRun): Promise<RestoreReport> {
  const refusal = refusedChoice(run.signIns, run.choices);
  if (refusal) throw new BackupError(refusal);

  const selection = selectSignIns(run.signIns, run.choices);
  const contents = keepOnlySignIns(run.contents, selection.write);
  const plan = planRestore(contents, run.shape);
  const outcome = await applyRestore(contents, plan, run.target, {
    actor: run.actor,
    ...(run.auditAction ? { auditAction: run.auditAction } : {}),
    ...(run.spending ? { spending: run.spending } : {}),
  });

  const taken = await takeOverSignIns({
    contents: run.contents,
    signIns: selection.takeOver,
    shape: run.shape,
    target: run.target,
    ports: run.takeOver,
    actor: run.actor,
    ...(run.now ? { now: run.now } : {}),
  });
  const signIns = signInLines(run.signIns, run.choices, taken);

  // Everyone holding a sign-in now goes by the name the bridge gives them: the
  // plan's, and each bot whose sign-in was just taken over — its account's
  // handle, or its seat when the account is shared.
  const renames: RestoreRename[] = [];
  if (run.target.rename) {
    const wanted = [...plan.bots.rename];
    const identities = restoredIdentities(run.contents, run.shape);
    for (const result of taken) {
      if (result.state !== 'taken-over') continue;
      // By who the judged sign-in signs in as, as the take-over found it: its
      // key need not be the one these contents would give it.
      const judged = run.signIns.find((one) => one.key === result.key);
      const identity = judged?.provider === 'github' ? restoredIdentityOfSignIn(identities, judged) : undefined;
      if (!identity) continue;
      for (const [index, seat] of identity.seats.entries()) {
        const name = identity.names[index] as string;
        const to = restoredName(identity, seat);
        if (name !== to && !wanted.some((one) => one.name === name)) wanted.push({ name, to });
      }
    }
    for (const bot of wanted) {
      const renamed = await run.target
        .rename({ name: bot.name, to: bot.to, reason: `restored as ${bot.to}` })
        .catch((error: unknown) => ({ state: 'waiting', reason: said(error) }));
      renames.push({ name: bot.name, to: bot.to, ...renamed });
    }
  }

  return { plan, outcome, signIns, renames, summary: summarizeRestore(contents, plan, run.shape.bots, signIns) };
}
