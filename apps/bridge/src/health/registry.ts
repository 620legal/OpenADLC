import { health as rows, type HealthRow } from '@fleetadlc/db';
import type { HealthView } from '@fleetadlc/shared';
import { failingIds, forgotten, isWaiting, nextRow, notificationsDue, rowId, type Transition } from './state.js';
import type { CheckResult, HealthCheck } from './types.js';

/** Where the answers are kept. The database in the bridge; a map in a test. */
export interface HealthStore {
  list(): Promise<HealthRow[]>;
  save(row: HealthRow): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  dismiss(id: string): Promise<boolean>;
}

export const DATABASE_STORE: HealthStore = {
  list: () => rows.listHealth(),
  save: (row) => rows.saveHealth(row),
  remove: (ids) => rows.deleteHealth(ids),
  dismiss: (id) => rows.dismissFixed(id),
};

/** What the registry asks OpenADLC's notifier to send. */
export interface HealthNotice {
  event: 'check_failing' | 'check_fixed';
  text: string;
  link: string;
}

export interface HealthRegistryDeps {
  checks: readonly HealthCheck[];
  store?: HealthStore;
  notify?: (notice: HealthNotice) => Promise<unknown>;
  /**
   * True while the install has never run a task. Everything is still being set
   * up then, most checks fail because the walkthrough has not reached them, and
   * the walkthrough is where the person already is — so nothing is sent.
   */
  settingUp?: () => Promise<boolean>;
  /** Where a console path in an action is opened from, for a notification's link. */
  consoleUrl: string;
  /** Each bot's name by its id, so a view names the bot it is about as it is called now. */
  botNames?: () => Promise<Map<string, string>>;
  now?: () => Date;
  /**
   * Told the ids of the rows that went from failing to passing in one run, once
   * each: what was blocked on them can go on. It runs after the rows are saved
   * and the notices sent, and a failure of its own is logged, never thrown into
   * the run that found the fix.
   */
  onFixed?: (ids: readonly string[]) => Promise<unknown>;
  /** How long one check may take before its answer is given up on for this run. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

/** Checks that asked for "soon" are run together, this long after the first asked. */
const SOON_MS = 2_000;
/** How often the registry looks for checks that are due. */
const TICK_MS = 60_000;

/**
 * The health checks: one registry that runs them, remembers what each said,
 * and says what changed.
 *
 * A check runs at start, every few minutes after that — its own interval — and
 * soon after something happens that it is about: a delivery for the webhook, a
 * bot connecting for its sign-in and its key. Runs are one at a time, so two
 * answers about the same subject never race each other into the table.
 *
 * What is remembered is what lets it say what changed: a failure that is new,
 * one that is still there, and one that has just been fixed, which clears its
 * card and says so once. A blocking failure that lasts five minutes is sent
 * through the notifier, and again a day later if it is still there.
 */
export class HealthRegistry {
  private readonly lastRun = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private soon: { timer: ReturnType<typeof setTimeout>; ids: Set<string> } | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Which checks failed at the last run, so a delivery asks again only when the webhook was failing. */
  private failingChecks = new Set<string>();

  constructor(private readonly deps: HealthRegistryDeps) {}

  get checks(): readonly HealthCheck[] {
    return this.deps.checks;
  }

  private get store(): HealthStore {
    return this.deps.store ?? DATABASE_STORE;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * Runs the checks that are due, or exactly `ids`, or every one with `force`,
   * after any run already going. Resolves to every row as it stands afterwards.
   */
  run(options: { ids?: readonly string[]; force?: boolean } = {}): Promise<HealthRow[]> {
    const next = this.chain.then(() => this.runNow(options));
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Every check now, at start. Then whichever are due, every minute. */
  start(): void {
    void this.run({ force: true }).catch((error: unknown) => this.say(`health checks could not run: ${messageOf(error)}`));
    this.ticker = setInterval(() => {
      void this.run().catch((error: unknown) => this.say(`health checks could not run: ${messageOf(error)}`));
    }, TICK_MS);
    this.ticker.unref?.();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    if (this.soon) clearTimeout(this.soon.timer);
    this.soon = null;
  }

  /**
   * Asks these checks again shortly: something happened that they are about.
   * Several asks within a moment are one run.
   */
  runSoon(ids: readonly string[]): void {
    const known = ids.filter((id) => this.knows(id));
    if (known.length === 0) return;
    if (this.soon) {
      for (const id of known) this.soon.ids.add(id);
      return;
    }
    const pending = new Set(known);
    const timer = setTimeout(() => {
      this.soon = null;
      void this.run({ ids: [...pending] }).catch((error: unknown) =>
        this.say(`health checks could not run: ${messageOf(error)}`),
      );
    }, SOON_MS);
    timer.unref?.();
    this.soon = { timer, ids: pending };
  }

  /**
   * GitHub delivered something. That is the webhook's check passing, and a
   * failing one is asked again so its card clears now rather than in minutes.
   */
  heard(): void {
    if (this.failingChecks.has('webhook')) this.runSoon(['webhook']);
  }

  /** Whether a check by this id is one this registry runs. */
  knows(checkId: string): boolean {
    return this.deps.checks.some((check) => check.id === checkId);
  }

  /**
   * Stops the board saying a fixed check was fixed. After any run already
   * going, as runs are: a run rewrites every row it read before, so a
   * dismissal that landed in between was written over and the notice came
   * back for a day.
   */
  dismiss(id: string): Promise<boolean> {
    const next = this.chain.then(() => this.store.dismiss(id));
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** What every check this registry runs last said, as it is kept. */
  rows(): Promise<HealthRow[]> {
    return this.current();
  }

  /** The kept rows of the checks this registry runs: a check no longer registered says nothing. */
  private async current(): Promise<HealthRow[]> {
    return (await this.store.list()).filter((row) => this.knows(row.checkId));
  }

  private due(check: HealthCheck, now: Date): boolean {
    const last = this.lastRun.get(check.id);
    // A few seconds' slack, so a check due on the minute is not a minute late.
    return last === undefined || now.getTime() - last >= check.everyMinutes * 60_000 - 5_000;
  }

  private async runNow(options: { ids?: readonly string[]; force?: boolean }): Promise<HealthRow[]> {
    const now = this.now();
    const wanted = this.deps.checks.filter((check) =>
      options.ids ? options.ids.includes(check.id) : options.force || this.due(check, now),
    );
    if (wanted.length === 0) return this.current();

    for (const check of wanted) this.lastRun.set(check.id, now.getTime());
    const listed = await this.store.list();
    // A check renamed or removed by an upgrade runs no more, so nothing ever
    // forgot its rows: a failing one stayed on the board and was notified
    // every day. Removed when every check runs; never shown before that.
    const stale = listed.filter((row) => !this.knows(row.checkId));
    if (options.force && stale.length > 0) await this.store.remove(stale.map((row) => row.id));
    const before = listed.filter((row) => this.knows(row.checkId));
    // Independent of each other, so asked together; each is bounded, so one
    // GitHub that does not answer cannot hold up the rest.
    const answers = await Promise.all(wanted.map(async (check) => ({ check, results: await this.answer(check, now) })));

    const changes: { row: HealthRow; previous: HealthRow | null; transition: Transition }[] = [];
    for (const { check, results } of answers) {
      // A check that could not run says nothing, and nothing it said before changes.
      if (results === null) continue;
      const mine = before.filter((row) => row.checkId === check.id);
      const byId = new Map(mine.map((row) => [row.id, row]));
      const returned = new Set<string>();

      for (const result of results) {
        const id = rowId(check.id, result.subject);
        if (returned.has(id)) continue;
        returned.add(id);
        const previous = byId.get(id) ?? null;
        const next = nextRow(previous, check.id, result, now);
        // Said on the row, which is all a card is drawn from.
        if (check.history && next.row.state === 'failing') next.row.facts = { ...next.row.facts, history: true };
        if (next.write) await this.store.save(next.row);
        changes.push({ row: next.row, previous, transition: next.transition });
        if (next.transition === 'new') this.say(`${check.id}: ${next.row.title}`);
        if (next.transition === 'fixed') this.say(`${check.id}: ${next.row.fixedTitle}`);
      }

      const gone = forgotten(mine, returned, now);
      if (gone.length > 0) await this.store.remove(gone);
    }

    let after = await this.current();
    this.failingChecks = new Set(after.filter((row) => row.state === 'failing').map((row) => row.checkId));
    if (await this.tell(after, changes, now)) after = await this.current();

    const fixed = changes.filter((change) => change.transition === 'fixed').map((change) => change.row.id);
    if (fixed.length > 0 && this.deps.onFixed) {
      await this.deps.onFixed(fixed).catch((error: unknown) => this.say(`could not act on ${fixed.join(', ')} passing: ${messageOf(error)}`));
    }
    return after;
  }

  private async answer(check: HealthCheck, now: Date): Promise<CheckResult[] | null> {
    const limit = check.timeoutMs ?? this.deps.timeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        check.run(now),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer within its time limit of ${Math.round(limit / 1000)}s, so what it said before stands`)),
            limit,
          );
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      this.say(`${check.id} could not run: ${messageOf(error)}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Sends what is due. True when a row was changed by it. */
  private async tell(
    after: readonly HealthRow[],
    changes: readonly { row: HealthRow; previous: HealthRow | null; transition: Transition }[],
    now: Date,
  ): Promise<boolean> {
    const notify = this.deps.notify;
    if (!notify) return false;
    if (this.deps.settingUp && (await this.deps.settingUp().catch(() => false))) return false;

    let changed = false;
    for (const row of notificationsDue(after, now)) {
      await notify({
        event: 'check_failing',
        text: [row.title, row.detail].filter(Boolean).join(' — '),
        link: this.link(row),
      }).catch((error: unknown) => this.say(`could not notify about ${row.id}: ${messageOf(error)}`));
      // Recorded whatever the transport did: the notifier logs what it could
      // not send, and trying every minute is how a notification stops meaning anything.
      await this.store.save({ ...row, notifiedAt: now.toISOString() });
      changed = true;
    }

    // Somebody who was told it was broken is told it is fixed; nobody else is.
    for (const change of changes) {
      if (change.transition !== 'fixed' || !change.previous?.notifiedAt || !change.row.fixedTitle) continue;
      await notify({ event: 'check_fixed', text: change.row.fixedTitle, link: this.boardLink() }).catch(
        (error: unknown) => this.say(`could not notify about ${change.row.id}: ${messageOf(error)}`),
      );
    }
    return changed;
  }

  private boardLink(): string {
    return `${this.deps.consoleUrl.replace(/\/+$/, '')}/?board=1#needs`;
  }

  /** Where a notification opens: the page the action is on, or the board's "needs you" for a command. */
  private link(row: HealthRow): string {
    const action = row.action;
    if (!action || 'command' in action) return this.boardLink();
    if ('url' in action) return action.url;
    return `${this.deps.consoleUrl.replace(/\/+$/, '')}${action.href}`;
  }

  /** Every row, as the console and `fleetadlc doctor` read it. */
  async views(current?: readonly HealthRow[]): Promise<HealthView[]> {
    const all = (current ?? (await this.store.list())).filter((row) => this.knows(row.checkId));
    const names = this.deps.botNames ? await this.deps.botNames().catch(() => new Map<string, string>()) : new Map<string, string>();
    const failing = failingIds(all);
    return all.map((row) => {
      const check = this.deps.checks.find((one) => one.id === row.checkId);
      const botId = typeof row.facts.botId === 'string' ? row.facts.botId : null;
      return {
        id: row.id,
        check: row.checkId,
        subject: row.subject,
        proves: check?.proves ?? row.checkId,
        state: row.state,
        severity: row.severity,
        title: row.title,
        detail: row.detail,
        action: row.action,
        since: row.failingSince,
        checkedAt: row.checkedAt,
        bot: botId ? (names.get(botId) ?? null) : null,
        steps: [...(check?.steps ?? [])],
        waitingFor: isWaiting(row, failing) ? row.waitingFor.filter((id) => failing.has(id)) : [],
      } satisfies HealthView;
    });
  }

  private say(line: string): void {
    (this.deps.log ?? ((text: string) => console.log(`[bridge] health: ${text}`)))(line);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

