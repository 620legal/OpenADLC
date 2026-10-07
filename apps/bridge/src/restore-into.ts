import {
  BackupError,
  applyUndo,
  chosenArchive,
  compareInstall,
  itemsOf,
  journalOf,
  judgeSignIns,
  planUndo,
  refusedComparisonChoice,
  runRestore,
  taken,
  undoOpen,
  type ArchivedHistory,
  type BackupContents,
  type Comparison,
  type HistoryHere,
  type InstallShape,
  type InstallSnapshot,
  type RestoreSummary,
  type RestoreTarget,
  type SignIn,
  type SignInChecks,
  type SignInFacts,
  type SignInLine,
  type TakeOverPorts,
  type UndoOutcome,
  type UndoStore,
  type UndoTarget,
} from '@fleetadlc/backup';

/**
 * Restoring a backup into an install that is already set up, and undoing it.
 *
 * The archive is laid beside the install item by item (`compareInstall`) and
 * a person chooses; every sign-in in it is checked first, as every restore
 * checks them. Then, because this install is in use:
 *
 *   1. It waits until every bot the restore changes is idle — a bot whose
 *      account, model, keys or sign-in change, or whose model account's
 *      credential does — and then holds them: their queues, so no task starts
 *      on them; their tokens, so none is refreshed while it is being replaced;
 *      and the dispatcher, which leases nothing until it is done.
 *   2. It takes a backup of the whole install, sign-ins and history and all,
 *      and writes down what it is about to touch: that is what Undo puts back,
 *      for a day.
 *   3. It compares again and restores what was chosen — nothing else, and
 *      never removing anything; history is added beside this install's own.
 *   4. It lets go, gives each bot the name its account says, and runs every
 *      health check, so whatever now needs a person is in Needs you.
 *
 * One restore or undo at a time. It runs in the background: the answer to the
 * request that starts it is where it has got to, and the console asks again.
 */

export interface RestoreIntoDeps {
  /** This install, values and all: what an archive is compared with. */
  here(): Promise<InstallSnapshot>;
  shape(): Promise<InstallShape>;
  historyHere(history: ArchivedHistory | null | undefined): Promise<HistoryHere>;
  signInFacts(): SignInFacts;
  checks: SignInChecks;
  /** The GitHub App client id this install refreshes sign-ins with now. */
  clientId(): Promise<string | null>;
  /** The whole install as a backup takes it — sign-ins and history too. What Undo puts back. */
  snapshot(): Promise<BackupContents>;
  /** Where a restore and an undo write. Renames are not done through it: they come after, all at once. */
  target(actor: string): RestoreTarget & UndoTarget;
  takeOver(clientId: string | null, actor: string): TakeOverPorts;
  undo: UndoStore;
  /** The bots in these seats with a task queued or running. */
  busy(seats: readonly string[]): Promise<{ seat: string; name: string }[]>;
  /** Holds these seats' queues and tokens, and the dispatcher, while `fn` runs. */
  hold<T>(seats: readonly string[], fn: () => Promise<T>): Promise<T>;
  /** Every bot takes the name its account says. */
  reconcileNames(actor: string): Promise<void>;
  /** Every health check, now. */
  checkHealth(): void;
  /** Puts the pauses now stored on the dispatch gate, audited as `source`'s (`resyncPause`). */
  resyncPause?(actor: string, source: string): Promise<void>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  newId(): string;
  /** How long to wait for a bot to finish its work before giving up. */
  waitLimitMs?: number;
  log?(line: string): void;
}

export interface IntoResult {
  summary: RestoreSummary;
  signIns: SignInLine[];
  undoUntil: string;
}

export interface UndoResult {
  signIns: UndoOutcome['signIns'];
  keptAccounts: UndoOutcome['keptAccounts'];
  keptSeats: UndoOutcome['keptSeats'];
}

export interface RestoreJobView {
  id: string;
  kind: 'restore' | 'undo';
  state: 'waiting' | 'applying' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  /** The bots whose work it is waiting for, by name. */
  waitingFor: string[];
  error: string | null;
  result: IntoResult | UndoResult | null;
}

/** What the page says about the last restore, while it can be undone. */
export interface UndoView {
  restoredAt: string;
  until: string;
  backupMadeAt: string;
  actor: string;
}

export class RestoreBusy extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'RestoreBusy';
  }
}

/** Undo asked for when there is no restore left to undo: nothing is running, so it is not `RestoreBusy`. */
export class NothingToUndo extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'NothingToUndo';
  }
}

/** A task started in the moment between finding a bot idle and holding it: wait again. */
class StartedMeanwhile extends Error {}

const WAIT_STEP_MS = 3_000;
const WAIT_LIMIT_MS = 30 * 60 * 1000;

function words(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * The seats a restore with these choices changes: each whose account, model,
 * keys or sign-in it takes, and each on a model account whose credential it
 * takes — a bot mid-task on that account would lose it under its feet.
 */
export function affectedSeats(comparison: Comparison, choices: Record<string, boolean>, here: InstallSnapshot): string[] {
  const seats = new Set<string>();
  const accounts = new Set<string>();
  for (const one of itemsOf(comparison)) {
    if (!taken(comparison, choices, one.key) || one.state === 'same') continue;
    if (one.seat) seats.add(one.seat);
    // A shared account's sign-in is every one of its seats'.
    for (const seat of one.seats ?? []) seats.add(seat);
    if (one.key.startsWith('signin:account:')) accounts.add(one.key.slice('signin:account:'.length));
  }
  for (const bot of here.bots) if (bot.modelAccountId && accounts.has(bot.modelAccountId)) seats.add(bot.slot);
  return [...seats].sort();
}

/** The choices a request carries, read as true or false for the items there are and nothing else. */
export function choicesIn(value: unknown, comparison: Comparison): Record<string, boolean> {
  const choices = { ...comparison.choices };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return choices;
  for (const one of itemsOf(comparison)) {
    const said = (value as Record<string, unknown>)[one.key];
    if (typeof said === 'boolean') choices[one.key] = said;
  }
  return choices;
}

export class RestoreInto {
  private job: RestoreJobView | null = null;

  constructor(private readonly deps: RestoreIntoDeps) {}

  get running(): boolean {
    return this.job?.state === 'waiting' || this.job?.state === 'applying';
  }

  view(): RestoreJobView | null {
    return this.job ? { ...this.job, waitingFor: [...this.job.waitingFor] } : null;
  }

  private say(line: string): void {
    (this.deps.log ?? ((text: string) => console.log(text)))(`[bridge] ${line}`);
  }

  /** The last restore, while Undo is on offer. A journal a day old is let go here. */
  async undoState(): Promise<UndoView | null> {
    const journal = await this.deps.undo.journal().catch(() => null);
    if (!journal) return null;
    if (!undoOpen(journal, this.deps.now())) {
      if (!this.running) await this.deps.undo.clear().catch(() => undefined);
      return null;
    }
    return { restoredAt: journal.restoredAt, until: journal.until, backupMadeAt: journal.backupMadeAt, actor: journal.actor };
  }

  /**
   * The archive beside this install, with every sign-in judged. A GitHub
   * sign-in is judged against the app the install will have once restored:
   * the archive's when its app is taken, this install's otherwise.
   */
  async compare(contents: BackupContents, choices?: unknown): Promise<{
    here: InstallSnapshot;
    shape: InstallShape;
    signIns: SignIn[];
    comparison: Comparison;
    choices: Record<string, boolean>;
    clientId: string | null;
  }> {
    const [here, shape, installClientId] = await Promise.all([this.deps.here(), this.deps.shape(), this.deps.clientId()]);
    const archiveClientId = contents.settings.githubClientId?.trim() || null;
    const draft = compareInstall({ contents, here, signIns: [] });
    const appTaken = taken(draft, choicesIn(choices, draft), 'app');
    const clientId = appTaken ? (archiveClientId ?? installClientId) : installClientId;
    const signIns = await judgeSignIns({
      contents,
      shape,
      facts: this.deps.signInFacts(),
      checks: this.deps.checks,
      now: this.deps.now(),
      clientId: { after: clientId, archive: archiveClientId },
    });
    const comparison = compareInstall({ contents, here, signIns, historyHere: await this.deps.historyHere(contents.history) });
    return { here, shape, signIns, comparison, choices: choicesIn(choices, comparison), clientId };
  }

  private refuseIfBusy(): void {
    if (this.running) throw new RestoreBusy('a restore is already running');
  }

  /**
   * Starts a restore with these choices, once they have been checked against
   * the install as it is now: one that takes what cannot be taken is refused
   * here, before anything waits or is written.
   */
  async start(contents: BackupContents, choices: unknown, actor: string): Promise<RestoreJobView> {
    this.refuseIfBusy();
    const now = await this.compare(contents, choices);
    const refusal = refusedComparisonChoice(now.comparison, now.choices);
    if (refusal) throw new BackupError(refusal);
    this.refuseIfBusy();
    const seats = affectedSeats(now.comparison, now.choices, now.here);
    const job = this.begin('restore');
    void this.finish(job, async () => {
      const done = await this.waitThenHold(job, seats, async () => {
        // Everything again, now nothing that it changes is moving: what is
        // written is what is true now, not when the page was read.
        const fresh = await this.compare(contents, now.choices);
        const changed = refusedComparisonChoice(fresh.comparison, now.choices);
        if (changed) throw new BackupError(`this install changed while the restore waited: ${changed}; nothing was changed`);
        const chosen = chosenArchive({ contents, here: fresh.here, comparison: fresh.comparison, choices: now.choices });
        const journal = journalOf({
          id: job.id,
          now: this.deps.now(),
          actor,
          contents,
          chosen: chosen.contents,
          comparison: fresh.comparison,
          choices: now.choices,
          storedSettings: fresh.shape.settingKeys,
          shape: fresh.shape,
        });
        // Before anything is written: what Undo puts back.
        const snapshot = await this.deps.snapshot().catch((error: unknown) => {
          throw new BackupError(
            `this install could not be backed up first (${error instanceof Error ? error.message : 'it could not be read'}), so nothing was changed`,
          );
        });
        await this.deps.undo.begin(snapshot, journal);
        const report = await runRestore({
          contents: chosen.contents,
          shape: fresh.shape,
          signIns: fresh.signIns,
          choices: chosen.signIns,
          target: this.deps.target(actor),
          takeOver: this.deps.takeOver(fresh.clientId, actor),
          actor,
          auditAction: 'install.restored_into',
          // The caps the archive names, over this install's; none deleted.
          spending: 'merge',
        });
        journal.history = report.outcome.history?.ids ?? null;
        await this.deps.undo.update(journal);
        return { report, journal };
      });
      await this.after(actor, 'restore into');
      return { summary: done.report.summary, signIns: done.report.signIns, undoUntil: done.journal.until };
    });
    return this.view() as RestoreJobView;
  }

  /** Starts undoing the last restore, while that can still be done. */
  async startUndo(actor: string): Promise<RestoreJobView> {
    this.refuseIfBusy();
    const record = await this.deps.undo.load();
    if (!record || !undoOpen(record.journal, this.deps.now())) {
      throw new NothingToUndo('there is no restore to undo: it is more than a day old, or has been undone already');
    }
    const here = await this.deps.here();
    const accounts = new Set(record.journal.accountCredentials);
    const seats = [
      ...new Set([
        ...record.journal.seats.map((seat) => seat.seat),
        ...here.bots.filter((bot) => bot.modelAccountId && accounts.has(bot.modelAccountId)).map((bot) => bot.slot),
      ]),
    ].sort();
    // Again, with no await before begin: an undo or a restore started while
    // this one read the record would otherwise run beside it, and its final
    // clear would delete the new restore's undo.
    this.refuseIfBusy();
    const job = this.begin('undo');
    void this.finish(job, async () => {
      const outcome = await this.waitThenHold(job, seats, async () => {
        const shape = await this.deps.shape();
        const plan = planUndo(record.snapshot, record.journal, shape);
        const archiveClientId = record.snapshot.settings.githubClientId?.trim() || null;
        const clientId = record.journal.settings.includes('githubClientId') ? archiveClientId : await this.deps.clientId();
        const signIns = await judgeSignIns({
          contents: plan.signIns,
          shape,
          facts: this.deps.signInFacts(),
          checks: this.deps.checks,
          now: this.deps.now(),
          clientId: { after: clientId, archive: archiveClientId },
        });
        return applyUndo({
          plan,
          signIns,
          shape,
          target: this.deps.target(actor),
          takeOver: this.deps.takeOver(clientId, actor),
          actor,
          journal: record.journal,
        });
      });
      await this.deps.undo.clear();
      await this.after(actor, 'undo of a restore');
      return { signIns: outcome.signIns, keptAccounts: outcome.keptAccounts, keptSeats: outcome.keptSeats };
    });
    return this.view() as RestoreJobView;
  }

  private begin(kind: 'restore' | 'undo'): RestoreJobView {
    this.job = {
      id: this.deps.newId(),
      kind,
      state: 'waiting',
      startedAt: this.deps.now().toISOString(),
      finishedAt: null,
      waitingFor: [],
      error: null,
      result: null,
    };
    return this.job;
  }

  private async finish(job: RestoreJobView, work: () => Promise<IntoResult | UndoResult>): Promise<void> {
    try {
      job.result = await work();
      job.state = 'done';
    } catch (error) {
      job.state = 'failed';
      job.error = error instanceof Error ? error.message.slice(0, 400) : 'the restore did not finish';
      this.say(`a ${job.kind} did not finish: ${job.error}`);
    } finally {
      job.waitingFor = [];
      job.finishedAt = this.deps.now().toISOString();
    }
  }

  /**
   * Waits until no bot in these seats has work queued or running, then holds
   * them and runs `fn`. A task that started in the moment between is found
   * once they are held, and waited for too.
   */
  private async waitThenHold<T>(job: RestoreJobView, seats: readonly string[], fn: () => Promise<T>): Promise<T> {
    const limit = this.deps.waitLimitMs ?? WAIT_LIMIT_MS;
    const started = this.deps.now().getTime();
    for (;;) {
      const busy = await this.deps.busy(seats);
      job.waitingFor = busy.map((bot) => bot.name);
      if (busy.length > 0) {
        if (this.deps.now().getTime() - started >= limit) {
          throw new BackupError(
            `${words(job.waitingFor)} did not finish ${busy.length === 1 ? 'its' : 'their'} work within ${Math.round(limit / 60_000)} minutes, so nothing was changed — try again once ${busy.length === 1 ? 'it is' : 'they are'} idle`,
          );
        }
        await this.deps.sleep(WAIT_STEP_MS);
        continue;
      }
      try {
        return await this.deps.hold(seats, async () => {
          if ((await this.deps.busy(seats)).length > 0) throw new StartedMeanwhile();
          job.state = 'applying';
          job.waitingFor = [];
          return fn();
        });
      } catch (error) {
        if (!(error instanceof StartedMeanwhile)) throw error;
      }
    }
  }

  /**
   * Once it is let go: every bot named for its account, the pauses now stored
   * on the dispatch gate, and every check asked again. The pause is read after
   * the hold is let go, so the stored one is what stays.
   */
  private async after(actor: string, source: string): Promise<void> {
    await this.deps.reconcileNames(actor).catch((error: unknown) => {
      this.say(`could not bring the crew's names up to date after a restore: ${error instanceof Error ? error.message : error}`);
    });
    await this.deps.resyncPause?.(actor, source).catch((error: unknown) => {
      this.say(`could not put the restored pause on the dispatcher: ${error instanceof Error ? error.message : error}`);
    });
    this.deps.checkHealth();
  }
}

const UNDO_SWEEP_MS = 60 * 60 * 1000;

/**
 * Lets go of an undo a day old even when nobody opens the page that would.
 *
 * The undo's backup holds the App key, refresh tokens, sign-in folders and all
 * history. `undoState` was the only thing that removed it, and only Settings
 * calls that, so an install nobody restored into again kept it for good. Run at
 * start and hourly; `undoState` leaves it alone while a restore or undo runs.
 */
export function sweepExpiredUndo(into: Pick<RestoreInto, 'undoState'>, everyMs = UNDO_SWEEP_MS): () => void {
  const sweep = (): void => void into.undoState().catch(() => undefined);
  sweep();
  const timer = setInterval(sweep, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
