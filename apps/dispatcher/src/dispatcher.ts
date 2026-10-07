import { audit, bots, costs, health, hosts, issues, leases, listEventsOfType, recordEvent, repos, settings, spendingLimits, tasks } from '@fleetadlc/db';
import { fetchJson, maxTasksOf, type CostsConfig, hasIgnoreLabel, hasNextLabel, hasPausedLabel } from '@fleetadlc/shared';
import { DEFAULT_PATH_POLICY, deliveryRulesFrom, dependencyIsSatisfied, missingForRouting, onlyExpectedPathsUnreadable, parseDependencies, UNREADABLE_PATH_LINE, tooManyAttempts, type PathPolicy } from '@fleetadlc/shared';
import { overlapKind, pathsOverlap } from './overlap.js';

export { overlapKind, pathMatches } from './overlap.js';
import { holdFor, type HealthFacts } from './hold.js';
import { builderPool, builderSlots, combinedTasks, missingBuildersReason, ownerCannotBuild } from './pool.js';

export interface DispatcherOptions {
  bridgeUrl: string;
  /**
   * The install's shared secret. `/internal/dispatch/lease` starts a real task,
   * so it is no longer served to whatever reached the port.
   */
  internalSecret: string;
  costs: CostsConfig;
  /** A lease with no pull request expires and the issue returns to the board. */
  leaseHours: number;
  dryRun?: boolean;
  /**
   * The bridge's own pause check (`DispatchGate.paused`), when the dispatcher
   * runs in the bridge: why nothing new may start, across the install or in
   * the repository asked about, or null. With it, a paused repository — or a
   * paused install — is passed over before any lease is taken, rather than
   * taken, refused and released on every pass. Without it (a dispatcher of its own) the stored settings are
   * read instead (`workPaused`, `workPausedRepos`), and one that cannot be
   * read holds everything it covers.
   */
  paused?: (repo?: string) => string | null;
  /**
   * Which overlapping changes may be built side by side in a repository: its
   * `paths:` in `.github/fleetadlc.yml`, as the bridge reads that file. Without
   * it (a dispatcher of its own) the repository's stored rules are read, and
   * the default policy when there are none.
   */
  pathPolicy?: (repo: { id: string; name: string; fullName: string; defaultBranch: string }) => Promise<PathPolicy>;
}

export interface DispatchDecision {
  repo: string;
  issue: number;
  /**
   * The bot the work went to, or null for a decision about an issue itself.
   * A decision about the whole install (the month's cap reached, work paused
   * everywhere) has `'-'` here, with `repo: '-'` and `issue: 0`.
   */
  bot: string | null;
  action: 'leased' | 'skipped' | 'unblocked' | 'triaged' | 'sent_back';
  reason: string;
}

/**
 * The repositories a person paused on their own, by name, as the
 * bridge stores them: `workPausedRepos`, JSON keyed by name. A value that
 * does not read is null, which the dispatcher takes as every repository
 * paused rather than none; an entry is a pause by its key alone. The bridge
 * reads the value the same way (`repoPausesFrom`), so the two agree: both
 * fail closed.
 */
export function pausedRepoNames(stored: string | null): Set<string> | null {
  if (!stored) return new Set();
  try {
    const parsed: unknown = JSON.parse(stored);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? new Set(Object.keys(parsed)) : null;
  } catch {
    return null;
  }
}

/**
 * The seats a person paused from Crew, by bot name, as the bridge stores them:
 * `workPausedSeats`, JSON of `{ by, at, why }` (the bridge's `seat-pause.ts`).
 * A paused seat finishes what it is doing and is leased nothing new. A value
 * that does not read pauses nobody, as the bridge reads it: unlike a
 * repository's pause, it names no one to hold.
 */
export function pausedSeatsFrom(stored: string | null): Map<string, { by: string; why: string | null }> {
  const out = new Map<string, { by: string; why: string | null }>();
  if (!stored) return out;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = (value ?? {}) as { by?: unknown; why?: unknown };
      out.set(name, { by: typeof entry.by === 'string' ? entry.by : 'someone', why: typeof entry.why === 'string' && entry.why ? entry.why : null });
    }
  } catch {
    // Pauses nobody; see above.
  }
  return out;
}

/** What a paused seat is passed over with. */
export function seatPausedReason(seat: string, pause: { by: string; why: string | null }): string {
  return `${seat} is paused by ${pause.by}${pause.why ? `: ${pause.why}` : ''}; nothing is leased to it until it is resumed on the Crew page`;
}

/**
 * Why nothing may start across the install, from the stored `workPaused`
 * setting, or null. Read as the bridge reads it (`pauseFrom`): a pause names
 * who paused it and when, and a value without them pauses nothing. Only a
 * dispatcher of its own reads this; in the bridge the gate answers.
 */
export function installPauseFrom(stored: string | null): string | null {
  if (!stored) return null;
  try {
    const pause = JSON.parse(stored) as { by?: unknown; at?: unknown; reason?: unknown };
    if (typeof pause?.by !== 'string' || typeof pause.at !== 'string') return null;
    const reason = typeof pause.reason === 'string' && pause.reason ? ` (${pause.reason})` : '';
    return `work is paused, by ${pause.by} since ${pause.at}${reason}; resume it in Settings → Pause work`;
  } catch {
    return null;
  }
}

/** What a pass leases nothing with when whether the install is paused could not be read. */
export const INSTALL_PAUSE_UNREAD = 'could not read whether work is paused, so nothing is leased until it can be read';

/** What a repository is passed over with when which ones are paused could not be read. */
export const PAUSES_UNREAD = 'could not read which repositories are paused, so nothing is leased in any repository until the paused list can be read';

/** Another issue in flight, and which of this issue's paths collide with which of its own. */
export interface Collision {
  number: number;
  pairs: Array<{ mine: string; theirs: string }>;
  /** Why it holds this one back: an exclusive path, or the other is being built. */
  kind?: 'exclusive' | 'building';
  /** Whether the other is being built now, rather than waiting in review. */
  building?: boolean;
}

/** Another issue in flight, its paths, and whether a builder is on it now. */
export interface WorkInFlight {
  number: number;
  paths: string[];
  building: boolean;
}

/**
 * The work in flight that holds this issue back, by the repository's path
 * policy: a shared path never; an exclusive path until the other has merged,
 * through its review; any other path only while the other is being built.
 *
 * Every overlap used to hold until merge, review included, and the files
 * nearly every change touches — the Makefile, the README — made a repository
 * build one thing at a time. The merge line brings a branch up to date and
 * runs CI on the head that lands, so a clash a shorter hold lets through is
 * caught there, at the cost of a conflict to resolve rather than a wait.
 */
export function blockingOverlaps(declared: readonly string[], others: readonly WorkInFlight[], policy: PathPolicy): Collision[] {
  const found: Collision[] = [];
  for (const other of others) {
    let exclusive = false;
    const pairs: Array<{ mine: string; theirs: string }> = [];
    for (const mine of declared) {
      for (const theirs of other.paths) {
        if (!pathsOverlap([mine], [theirs])) continue;
        const kind = overlapKind(mine, theirs, policy);
        if (kind === 'shared') continue;
        if (kind === 'ordinary' && !other.building) continue;
        if (kind === 'exclusive') exclusive = true;
        pairs.push({ mine, theirs });
      }
    }
    if (pairs.length === 0) continue;
    const known = found.find((collision) => collision.number === other.number);
    if (known) {
      for (const pair of pairs) {
        if (!known.pairs.some((seen) => seen.mine === pair.mine && seen.theirs === pair.theirs)) known.pairs.push(pair);
      }
      known.building = Boolean(known.building || other.building);
      if (exclusive) known.kind = 'exclusive';
    } else {
      found.push({ number: other.number, pairs, kind: exclusive ? 'exclusive' : 'building', building: other.building });
    }
  }
  return found;
}

/**
 * Why an issue waits for another, as the board shows it.
 *
 * It said "declared paths overlap work already in flight", and nothing about
 * which work or which files. An issue that declared a whole folder waited on
 * almost everything, and the only way to find out what it was waiting for was
 * to compare every open issue's paths by hand.
 */
export function overlapReason(collisions: readonly Collision[]): string {
  const shown = 3;
  const described = collisions.map((collision) => {
    const { number, pairs } = collision;
    const listed = pairs
      .slice(0, shown)
      .map(({ mine, theirs }) => (mine === theirs ? mine : `${mine} against ${theirs}`))
      .join(', ');
    const more = pairs.length > shown ? `, and ${pairs.length - shown} more` : '';
    return `#${number} (${listed}${more})${stateOf(collision)}`;
  });
  return `declared paths overlap work in flight: ${described.join('; ')}`;
}

/** What holds it: an exclusive path in review or being built, or a path that is being built. */
function stateOf(collision: Collision): string {
  if (!collision.kind) return '';
  if (collision.kind === 'exclusive') return collision.building ? ', an exclusive path being built' : ', an exclusive path in review';
  return ', being built';
}

/**
 * The events the waits on overlap are recorded as. The bridge's insights
 * (`apps/bridge/src/insights.ts`) and the store that reads them
 * (`INSIGHT_EVENTS` in `packages/db/src/store/insights.ts`) repeat these
 * literals rather than import them, so a rename here is made there too.
 */
export const OVERLAP_WAITED = 'overlap.waited';
export const OVERLAP_CLEARED = 'overlap.cleared';

/**
 * Leases routable issues to their owner bot and the other builders, as many at
 * once as the repository's concurrency, the seats' tasks at once and the hosts'
 * room allow. An issue whose declared paths can touch another change's waits
 * while that change is being built on an ordinary path, until it merges on an
 * exclusive one, and never on a shared one (`blockingOverlaps`). It leases
 * nothing once the month's spend reaches the cap; running work finishes.
 */
export class Dispatcher {
  constructor(private readonly options: DispatcherOptions) {}

  /** Each issue waiting on overlap: what holds it, and since when; read back from the events once. */
  private waits: Map<string, { signature: string; since: number }> | null = null;

  /** The repository's path policy; the default when nothing can say otherwise. */
  private async policyFor(repo: { id: string; name: string; fullName: string; defaultBranch: string }): Promise<PathPolicy> {
    if (this.options.pathPolicy) return this.options.pathPolicy(repo).catch(() => DEFAULT_PATH_POLICY);
    const stored = await (async () => repos.getDelivery(repo.id))().catch(() => null);
    return deliveryRulesFrom(null, stored?.deliveryRules ?? null).paths;
  }

  /** Waits not yet cleared, from the events, so a restarted bridge measures a wait from when it began. */
  private async knownWaits(): Promise<Map<string, { signature: string; since: number }>> {
    if (this.waits) return this.waits;
    const waits = new Map<string, { signature: string; since: number }>();
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const [waited, cleared] = await Promise.all([
      (async () => listEventsOfType(OVERLAP_WAITED, since))().catch(() => []),
      (async () => listEventsOfType(OVERLAP_CLEARED, since))().catch(() => []),
    ]);
    const clearedAt = new Map<string, number>();
    for (const event of cleared) {
      const payload = event.payload as { repo?: string; issue?: number };
      const key = `${payload.repo}#${payload.issue}`;
      clearedAt.set(key, Math.max(clearedAt.get(key) ?? 0, Date.parse(event.at)));
    }
    // Oldest first, so a wait that changed what held it keeps when it began.
    for (const event of [...waited].reverse()) {
      const payload = event.payload as { repo?: string; issue?: number; on?: number[]; paths?: string[] };
      const key = `${payload.repo}#${payload.issue}`;
      const at = Date.parse(event.at);
      if ((clearedAt.get(key) ?? 0) >= at) continue;
      const held = waits.get(key);
      waits.set(key, { signature: signatureOf(payload.on ?? [], payload.paths ?? []), since: held?.since ?? at });
    }
    this.waits = waits;
    return waits;
  }

  /** Records `overlap.waited` when an issue starts waiting, or what holds it changes. */
  private async noteWait(repo: string, issue: number, collisions: readonly Collision[]): Promise<void> {
    const waits = await this.knownWaits();
    const on = collisions.map((collision) => collision.number);
    const paths = [...new Set(collisions.flatMap((collision) => collision.pairs.map((pair) => pair.theirs)))];
    const signature = signatureOf(on, paths);
    const key = `${repo}#${issue}`;
    const held = waits.get(key);
    if (held?.signature === signature) return;
    const kind = collisions.some((collision) => collision.kind === 'exclusive') ? 'exclusive' : 'building';
    waits.set(key, { signature, since: held?.since ?? Date.now() });
    await (async () =>
      recordEvent({ source: 'platform', type: OVERLAP_WAITED, payload: { repo, issue, on, paths, kind, at: new Date().toISOString() } }))().catch(
      () => undefined,
    );
  }

  /** Records `overlap.cleared` once an issue that waited on overlap no longer does. */
  private async noteClear(repo: string, issue: number): Promise<void> {
    const waits = await this.knownWaits();
    const key = `${repo}#${issue}`;
    const held = waits.get(key);
    if (!held) return;
    waits.delete(key);
    await (async () =>
      recordEvent({ source: 'platform', type: OVERLAP_CLEARED, payload: { repo, issue, waitedMs: Date.now() - held.since } }))().catch(() => undefined);
  }

  /**
   * Hands an issue to intake rather than to a builder.
   *
   * Refusing to lease is only half of it: an issue that is not ready and is not
   * labelled is an issue nobody is looking at, which is worse than one being
   * worked on badly.
   */
  private async sendToTriage(
    repo: { id: string; name: string },
    issueNumber: number,
    reason: string,
  ): Promise<DispatchDecision> {
    try {
      await fetchJson(`${this.options.bridgeUrl}/internal/issues/${repo.name}/${issueNumber}/triage`, {
        method: 'POST',
        headers: { 'x-fleetadlc-internal-secret': this.options.internalSecret },
        body: JSON.stringify({ reason }),
      });
    } catch (error) {
      return {
        repo: repo.name,
        issue: issueNumber,
        bot: null,
        action: 'skipped',
        reason: `could not send to triage: ${error instanceof Error ? error.message.slice(0, 120) : error}`,
      };
    }

    return { repo: repo.name, issue: issueNumber, bot: null, action: 'triaged', reason };
  }

  /**
   * Hands an issue whose Expected paths do not read back to the stage that
   * wrote them, rather than to triage.
   *
   * `needs-triage` is a stop for a person: nothing in the crew picks it up on
   * its own. A line that is not a path is no question for one — the stage that
   * wrote the paths rewrites them from the code. The bridge falls back to
   * triage itself when the issue cannot be sent back.
   */
  private async sendBackForPaths(
    repo: { id: string; name: string },
    issueNumber: number,
    reason: string,
  ): Promise<DispatchDecision> {
    try {
      const answer = await fetchJson<{ outcome?: string; reason?: string }>(
        `${this.options.bridgeUrl}/internal/issues/${repo.name}/${issueNumber}/expected-paths`,
        {
          method: 'POST',
          headers: { 'x-fleetadlc-internal-secret': this.options.internalSecret },
          body: JSON.stringify({ reason }),
        },
      );
      const action = answer.outcome === 'triaged' ? 'triaged' : answer.outcome === 'sent' ? 'sent_back' : 'skipped';
      return { repo: repo.name, issue: issueNumber, bot: null, action, reason: answer.reason ?? reason };
    } catch (error) {
      return {
        repo: repo.name,
        issue: issueNumber,
        bot: null,
        action: 'skipped',
        reason: `could not send it back for its Expected paths: ${error instanceof Error ? error.message.slice(0, 120) : error}`,
      };
    }
  }

  /**
   * Removes `blocked` from an issue whose dependencies have shipped.
   *
   * Nothing did this, so the label was a note: an issue stayed blocked until a
   * person noticed that the thing it waited for had landed. The dependency is
   * read from the issue's own body, which is where the rest of its contract
   * already lives.
   *
   * The dispatcher decides; the bridge acts. Every label the platform writes is
   * written by the automation account through the bridge, and a second component
   * with a GitHub client would be a second place that rule could be broken.
   */
  private async unblockWhatHasShipped(repo: { id: string; name: string }): Promise<DispatchDecision[]> {
    const decisions: DispatchDecision[] = [];

    for (const issue of await issues.listBlockedIssues(repo.id)) {
      // The list leaves these out; a row read before the label arrived is
      // still not the crew's to unblock.
      if (hasIgnoreLabel(issue.labels)) continue;
      const dependencies = parseDependencies(issue.body);
      if (dependencies.length === 0) continue;

      const resolved = await Promise.all(dependencies.map((number) => issues.getIssue(repo.id, number)));
      const outstanding = dependencies.filter((_, index) => !dependencyIsSatisfied(resolved[index] ?? null));
      if (outstanding.length > 0) continue;

      try {
        await fetchJson(`${this.options.bridgeUrl}/internal/issues/${repo.name}/${issue.number}/unblock`, {
          method: 'POST',
          headers: { 'x-fleetadlc-internal-secret': this.options.internalSecret },
          body: JSON.stringify({ dependencies }),
        });
        decisions.push({
          repo: repo.name,
          issue: issue.number,
          bot: null,
          action: 'unblocked',
          reason: `everything it waited for has shipped: ${dependencies.map((n) => `#${n}`).join(', ')}`,
        });
      } catch (error) {
        decisions.push({
          repo: repo.name,
          issue: issue.number,
          bot: null,
          action: 'skipped',
          reason: `could not unblock: ${error instanceof Error ? error.message.slice(0, 120) : error}`,
        });
      }
    }

    return decisions;
  }

  async runOnce(): Promise<DispatchDecision[]> {
    const decisions: DispatchDecision[] = [];

    for (const lease of await leases.expireStaleLeases()) {
      await audit({
        actor: 'dispatcher',
        action: 'lease.expired',
        target: `issue #${lease.issueNumber}`,
        payload: { leaseId: lease.id },
      });
    }

    const period = costs.currentPeriod();
    const budget = await costs.refreshBudget(period, this.options.costs.warningAt);
    if (budget.state === 'stopped' && this.options.costs.onCap.stopLeasing) {
      return [
        {
          repo: '-',
          issue: 0,
          bot: '-',
          action: 'skipped',
          reason: `month-to-date spend is $${budget.spentUsd.toFixed(2)} of $${budget.capUsd.toFixed(2)}; not leasing new work`,
        },
      ];
    }

    // What the bridge's health checks last said: a builder that cannot sign
    // in, is not in the repository, or whose commits it would refuse, is
    // passed over, and every builder while hostd is not answering. A table
    // that cannot be read holds nobody back.
    const checks: HealthFacts[] = await (async () => health.listHealth())().catch(() => []);
    // Paused across the install, or held by a restore: nothing is leased,
    // and nothing is taken to be refused. Without the bridge's gate the stored
    // setting is read, and one that cannot be read holds everything.
    const installPaused = this.options.paused
      ? this.options.paused()
      : await (async () => installPauseFrom(await settings.getSetting('workPaused')))().catch(() => INSTALL_PAUSE_UNREAD);
    if (installPaused) return [{ repo: '-', issue: 0, bot: '-', action: 'skipped', reason: installPaused }];

    // Which repositories a person paused: the bridge's gate when it is here,
    // else the stored setting, where one that cannot be read holds them all.
    const pausedIn: (name: string) => string | null = this.options.paused
      ? (name) => this.options.paused?.(name) ?? null
      : await (async () => {
          const names = await (async () => pausedRepoNames(await settings.getSetting('workPausedRepos')))().catch(() => null);
          return (name: string) => (names === null ? PAUSES_UNREAD : names.has(name) ? `work is paused in ${name}; resume it in Settings → Pause work` : null);
        })();

    // The seats a person paused: read once a pass, as the repositories' are.
    const pausedSeats = await (async () => pausedSeatsFrom(await settings.getSetting('workPausedSeats')))().catch(() => new Map<string, { by: string; why: string | null }>());

    // How many more tasks the hosts can run, across every repository this
    // pass leases in; null while no host has registered.
    let hostRoom = await hosts.taskRoom().catch(() => null);

    for (const repo of await repos.listRepos()) {
      // Removed from OpenADLC: nothing new starts in it. The store leaves such a
      // repository out already; this holds whatever list the loop is handed.
      if (repo.removedAt) continue;
      // Paused by a person: nothing new is leased in it until it is resumed.
      // Its blocked issues are left alone too; unblocking them is the pass
      // after the resume's.
      const paused = pausedIn(repo.name);
      if (paused) {
        decisions.push({ repo: repo.name, issue: 0, bot: null, action: 'skipped', reason: paused });
        continue;
      }
      if (!repo.ownerBotId) continue;
      const owner = await bots.getBotById(repo.ownerBotId);
      if (!owner) continue;
      const cannot = ownerCannotBuild(owner, repo.name);
      if (cannot) {
        decisions.push({ repo: repo.name, issue: 0, bot: owner.name, action: 'skipped', reason: cannot });
        continue;
      }

      // The builders: the owner and every other bot with its role. Each runs
      // as many tasks at once as its tasks-at-once setting (maxTasks) allows,
      // each in a computer of its own, so a second build needs room on a seat,
      // not a second seat.
      const crew = await bots.listBots();
      const scripted = process.env.FLEETADLC_SCRIPTED_ENGINES === '1';
      const pool = builderPool(owner, crew, Number.POSITIVE_INFINITY, { scripted });

      // The repository's concurrency counts its builds that have not finished,
      // paused ones too: a build waiting on a person is still its work in
      // flight. A seat counts a paused task only while its computer is kept.
      const unfinished = await tasks.countUnfinishedImplementTasks(repo.id);
      const room = Math.max(0, repo.concurrency - unfinished);
      const free = new Map<string, number>();
      for (const candidate of pool) {
        if (room === 0) break;
        const left = maxTasksOf(candidate) - (await tasks.countSeatSlotsInUse(candidate.id));
        if (left <= 0) continue;
        const seatPause = pausedSeats.get(candidate.name);
        if (seatPause) {
          decisions.push({ repo: repo.name, issue: 0, bot: candidate.name, action: 'skipped', reason: seatPausedReason(candidate.name, seatPause) });
          continue;
        }
        const held = holdFor(candidate, repo.name, checks, { scripted });
        if (held) {
          decisions.push({ repo: repo.name, issue: 0, bot: candidate.name, action: 'skipped', reason: held });
          continue;
        }
        free.set(candidate.id, left);
      }
      const idle = builderSlots(pool, (seat) => free.get(seat.id) ?? 0, room);
      // And never past what the hosts can run.
      if (hostRoom !== null && idle.length > Math.max(0, hostRoom)) {
        decisions.push({
          repo: repo.name,
          issue: 0,
          bot: owner.name,
          action: 'skipped',
          reason: `every host is running all the tasks it has room for; ${idle.length - Math.max(0, hostRoom)} more start when tasks end, or give a host more with FLEETADLC_HOST_CAPACITY_TASKS`,
        });
        idle.splice(Math.max(0, hostRoom));
      }

      if (idle.length > 0 && combinedTasks(pool) < repo.concurrency) {
        decisions.push({
          repo: repo.name,
          issue: 0,
          bot: owner.name,
          action: 'skipped',
          reason: missingBuildersReason(owner, crew, pool, repo.concurrency, { scripted }),
        });
      }

      // The label kept tidy for people reading GitHub: an issue whose
      // dependencies have shipped loses `blocked`. Whether one may start is
      // decided below from the dependencies themselves, not from the label.
      for (const decision of await this.unblockWhatHasShipped(repo)) decisions.push(decision);

      // The one a person asked for next goes first, ahead of priority order;
      // the rest keep the order they were listed in.
      const listed = await issues.listRoutableIssues(repo.id);
      const candidates = [...listed.filter((issue) => hasNextLabel(issue.labels)), ...listed.filter((issue) => !hasNextLabel(issue.labels))];
      if (candidates.length === 0) continue;

      // What each issue waits on is read from where the board has it now.
      const known = new Map((await issues.listIssues(repo.name)).map((one) => [one.number, one]));
      const activeLeases = await leases.listActiveLeases(repo.id);
      // What is in flight is the work itself: an issue in build or review that
      // a builder has started, with the files it declared and the files its pull
      // request touches. Nothing is claimed by a record that has to be let go —
      // a lease left behind after its work had merged held README.md for twenty
      // minutes, and the next issue to touch it waited for nothing.
      const inFlight = await issues.workInFlight(repo.id);
      // Work started this pass is being built, and holds what being built holds.
      const startedThisPass: WorkInFlight[] = [];
      const claimedBy = (self: number) => [...inFlight, ...startedThisPass].filter((work) => work.number !== self);
      const policy = await this.policyFor(repo);

      for (const issue of candidates) {
        // Already somebody's — first, so an issue being built is never sent to
        // triage for what it said before its builder started.
        const taken =
          activeLeases.some((lease) => lease.issueNumber === issue.number) ||
          inFlight.some((work) => work.number === issue.number && work.building);
        if (taken) continue;

        // Held by a person: nothing new starts on it until the hold comes off.
        if (hasPausedLabel(issue.labels)) {
          decisions.push({ repo: repo.name, issue: issue.number, bot: null, action: 'skipped', reason: 'held by a person (fleetadlc:paused)' });
          continue;
        }

        // Waiting on another issue that has not shipped, whatever its labels say.
        const dependencies = parseDependencies(issue.body);
        // Said, not skipped in silence: an issue read as waiting on one that
        // would never ship — closed as superseded — sat with nothing in the log.
        const waitingOn = dependencies.filter((number) => !dependencyIsSatisfied(known.get(number) ?? null));
        if (waitingOn.length > 0) {
          decisions.push({
            repo: repo.name,
            issue: issue.number,
            bot: null,
            action: 'skipped',
            reason: `waits on ${waitingOn
              .map((number) => {
                const dependency = known.get(number);
                return dependency ? `#${number}, not shipped yet` : `#${number}, which OpenADLC has not seen`;
              })
              .join(', ')}`,
          });
          continue;
        }

        // Does the issue say enough to be worked on? A lease with no declared
        // paths claims nothing, and the overlap check that keeps two changes off
        // the same file then has nothing to compare.
        const missing = missingForRouting(issue);
        const attempts = await leases.attemptsWithoutPullRequest(repo.id, issue.number);
        const exhausted = tooManyAttempts(attempts);

        if (missing.length > 0 || exhausted) {
          // A line that is not a path is quoted after what the issue needs.
          const lines = missing.filter((item) => item.startsWith(UNREADABLE_PATH_LINE));
          const needs = missing.filter((item) => !lines.includes(item));
          const reason = exhausted
            ? `leased ${attempts} times without producing a pull request`
            : `not ready to be worked on: ${[...(needs.length > 0 ? [`needs ${needs.join(', ')}`] : []), ...lines].join('; ')}`;
          // Only a line of Expected paths that is not a path goes back to the
          // stage that wrote it; anything a person has to say goes to triage.
          const forPaths = !exhausted && onlyExpectedPathsUnreadable(missing);
          decisions.push(forPaths ? await this.sendBackForPaths(repo, issue.number, reason) : await this.sendToTriage(repo, issue.number, reason));
          continue;
        }

        // A monthly cap stops new work for that bot here. A task already
        // running finishes up to its own per-task cap; this only refuses the
        // lease. The next idle bot may still be under its own cap.
        let builder = idle.shift();
        while (builder) {
          const blocked = await spendingLimits.refusal({
            monthlyCapUsd: this.options.costs.monthlyCapUsd,
            onCap: this.options.costs.onCap,
            period,
            repoId: repo.id,
            repoLabel: repo.fullName || repo.name,
            botId: builder.id,
            botName: builder.name,
            engine: builder.engine,
          });
          if (!blocked) break;
          decisions.push({
            repo: repo.name,
            issue: issue.number,
            bot: builder.name,
            action: 'skipped',
            reason: blocked,
          });
          builder = idle.shift();
        }
        if (!builder) continue;

        const collisions = issue.declaredPaths.length > 0 ? blockingOverlaps(issue.declaredPaths, claimedBy(issue.number), policy) : [];
        if (collisions.length > 0) {
          await this.noteWait(repo.name, issue.number, collisions);
          idle.unshift(builder);
          decisions.push({
            repo: repo.name,
            issue: issue.number,
            bot: builder.name,
            action: 'skipped',
            // Next still waits for a file another change holds, and says so.
            reason: hasNextLabel(issue.labels) ? `next, but ${overlapReason(collisions)}` : overlapReason(collisions),
          });
          continue;
        }
        await this.noteClear(repo.name, issue.number);

        if (this.options.dryRun) {
          decisions.push({
            repo: repo.name,
            issue: issue.number,
            bot: builder.name,
            action: 'leased',
            reason: 'dry run',
          });
          startedThisPass.push({ number: issue.number, paths: issue.declaredPaths, building: true });
          if (hostRoom !== null) hostRoom -= 1;
          continue;
        }

        const lease = await leases.createLease({
          repoId: repo.id,
          issueNumber: issue.number,
          botId: builder.id,
          declaredPaths: issue.declaredPaths,
          expiresAt: new Date(Date.now() + this.options.leaseHours * 3600 * 1000),
        });

        try {
          await fetchJson(`${this.options.bridgeUrl}/internal/dispatch/lease`, {
            method: 'POST',
            headers: { 'x-fleetadlc-internal-secret': this.options.internalSecret },
            body: JSON.stringify({
              leaseId: lease.id,
              repo: repo.name,
              issue: issue.number,
              bot: builder.name,
              // The name can change under this request: a bot takes its
              // account's handle when one connects. The id does not.
              botId: builder.id,
              declaredPaths: issue.declaredPaths,
              expiresAt: lease.expiresAt,
            }),
          });
          // Work started this pass claims its paths for the rest of it, and
          // its place on a host.
          startedThisPass.push({ number: issue.number, paths: issue.declaredPaths, building: true });
          if (hostRoom !== null) hostRoom -= 1;
          decisions.push({
            repo: repo.name,
            issue: issue.number,
            bot: builder.name,
            action: 'leased',
            reason: `leased to ${builder.name} until ${lease.expiresAt}`,
          });
        } catch (error) {
          // Released with nothing started, so it costs the issue no attempt.
          // The builder is not offered to the next issue: almost every refusal
          // is about the builder, its host or the install, not the issue, and
          // offering it again took and released a lease on every issue in the
          // repository. The next pass, on the next event or within minutes,
          // tries again.
          await leases.setLeaseState(lease.id, 'released');
          decisions.push({
            repo: repo.name,
            issue: issue.number,
            bot: builder.name,
            action: 'skipped',
            reason: `bridge refused the lease: ${error instanceof Error ? error.message : error}`,
          });
        }
      }
    }

    return decisions;
  }
}

/** What holds an issue, to tell one wait from the next. */
function signatureOf(on: readonly number[], paths: readonly string[]): string {
  return `${[...on].sort((a, b) => a - b).join(',')}|${[...paths].sort().join(',')}`;
}
