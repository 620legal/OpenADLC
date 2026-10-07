import { audit as auditEntry, repos, settings, withAdvisoryLock } from '@fleetadlc/db';
import type { DispatchGate } from './dispatch-gate.js';
import { HttpFailure, type Router } from './router.js';

/**
 * Pausing work across the install, from Settings.
 *
 * A pause is a hold on the bridge's dispatch gate, and everything that starts
 * new work asks the gate first: the dispatcher's leases, a console request's
 * triage (the request waits in the queue instead), "Try again" on a task or a
 * triage, the request queue's drain, and staffing an issue's stage from its
 * GitHub delivery or the stage sweep (the issue stays in intake, and the resume
 * starts it: `StageHandoff.resumed`). Each is refused, in words that say
 * who paused it and where to resume, until someone does. Work already running
 * finishes, and so do its later stages and the merge line: to stop a pull
 * request landing, hold it (`needs-human`), which the merge line does not
 * land, and turn GitHub's auto-merge off on it too (Hold this PR does both).
 * `bridgeMergeOff` leaves merges to auto-merge and the branch rules, so it
 * does not stop one (docs/troubleshooting.md).
 * The pause is a stored setting (`workPaused`), written only through these
 * routes, so a bridge that restarts is still paused, and each pause and
 * resume is audited. A bridge that cannot read the setting as it starts stays
 * paused until it can. Without it, the only way to stop new work was to
 * restart the bridge with `FLEETADLC_DISPATCH_IN_BRIDGE=0`, by hand.
 *
 * A pause can also be of some repositories and not the rest: stored
 * beside it as `workPausedRepos`, by repository name, and held on the gate per
 * repository. Everything above asks the gate about the repository it would
 * start work in, so a paused repository's issues are not leased, staffed or
 * run again, and its requests wait in the queue while the rest of the line
 * drains. A request with no repository is triaged, since intake is what picks
 * one; the issue it files in a paused repository waits there, unleased, until
 * that repository is resumed. Resuming one repository starts what it held.
 * `workPaused` stays what it was, and means every repository.
 *
 * The pause is not the only thing that stops builds: a bridge started without
 * the dispatcher leases nothing, paused or not, and this said nothing about it
 * while Settings read "Work runs" for a day. So the answer also says
 * whether anything dispatches, and Pause and Resume do not change that.
 */

export interface WorkPause {
  by: string;
  at: string;
  reason: string | null;
}

export interface PauseDeps {
  gate: DispatchGate;
  /**
   * What starts what waited through the pause: the request queue's drain, the
   * deferred intake. Given the repositories a resume named, or none when
   * everything was resumed.
   */
  resumed?: (repos?: string[]) => void;
  /**
   * Whether anything leases an issue to a builder: the bridge's dispatcher, or
   * the integration suites beside scripted engines. Taken as so when not given.
   */
  dispatching?: boolean;
  read(): Promise<string | null>;
  write(value: string, by: string): Promise<void>;
  /** Each paused repository's pause, as JSON keyed by repository name. */
  readRepos(): Promise<string | null>;
  writeRepos(value: string, by: string): Promise<void>;
  /** The repositories OpenADLC works in, which are the ones a pause may name. */
  repositories(): Promise<{ name: string; fullName: string }[]>;
  /** Runs a pause or a resume alone across bridges; the database's advisory lock. */
  exclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
  audit(entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<void>;
}

const LIVE: Omit<PauseDeps, 'gate'> = {
  read: () => settings.getSetting('workPaused'),
  write: (value, by) => settings.setSetting('workPaused', value, by),
  readRepos: () => settings.getSetting('workPausedRepos'),
  writeRepos: (value, by) => settings.setSetting('workPausedRepos', value, by),
  repositories: () => repos.listRepos(),
  exclusive: (key, fn) => withAdvisoryLock(key, fn),
  audit: auditEntry,
};

/**
 * Held while the pauses are read, changed and written back. The repositories'
 * pauses are one stored value: two people pausing different repositories at
 * once each read it without the other's, and the second write lost the first
 * pause while its gate still held it — until the next restart let it go.
 */
export const WORK_PAUSE_LOCK = 'bridge:work-pause';

export function pauseFrom(stored: string | null): WorkPause | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<WorkPause>;
    return typeof parsed.by === 'string' && typeof parsed.at === 'string'
      ? { by: parsed.by, at: parsed.at, reason: typeof parsed.reason === 'string' ? parsed.reason : null }
      : null;
  } catch {
    return null;
  }
}

/**
 * Each paused repository's pause, by name, from the stored setting; null when
 * the value is not a map of them at all. The dispatcher run on its own reads
 * the same value by its keys (`pausedRepoNames`), so both fail closed alike:
 * a value that does not read holds everything (see `restorePause`), and an
 * entry that does not read is still a pause, said as one whose details were
 * lost, rather than a repository quietly let go.
 */
export function repoPausesFrom(stored: string | null): Record<string, WorkPause> | null {
  if (!stored) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: Record<string, WorkPause> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    out[name] = pauseFrom(JSON.stringify(value)) ?? { by: 'someone', at: new Date(0).toISOString(), reason: 'its stored pause could not be read in full' };
  }
  return out;
}

/** What a start in a paused repository is refused with: whose pause, and where to resume it. */
export function repoPausedWords(name: string, pause: WorkPause): string {
  return `work is paused in ${name}, by ${pause.by} since ${pause.at}${pause.reason ? ` (${pause.reason})` : ''}; resume it in Settings → Pause work`;
}

/** What a refused lease says while work is paused. */
export function pausedWords(pause: WorkPause): string {
  return `work is paused, by ${pause.by} since ${pause.at}${pause.reason ? ` (${pause.reason})` : ''}; resume it in Settings → Pause work`;
}

/** What a start is refused with while the setting could not be read. */
export const UNREAD_WORDS =
  'work is paused: the bridge could not read whether a person paused it, so it stays paused until it can; resume it in Settings → Pause work';

/** How long a bridge that could not read the pause waits before it reads again. */
export const REREAD_MS = 15_000;

/**
 * Holds the gate for a stored pause, so a bridge that restarts is still
 * paused. A read that fails is a pause, not the lack of one: a bridge that
 * restarted during a database hiccup would otherwise quietly resume a pause a
 * person set for an incident. It says so, reads again every `REREAD_MS`, and
 * holds what it then reads. A person's Resume ends it at once.
 */
export async function restorePause(
  deps: Pick<PauseDeps, 'gate' | 'read'> & Partial<Pick<PauseDeps, 'readRepos'>>,
  options: { log?: (line: string) => void; rereadMs?: number; schedule?: (fn: () => void, ms: number) => void } = {},
): Promise<WorkPause | null> {
  const log = options.log ?? ((line: string) => console.error(`[bridge] ${line}`));
  const schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.());
  const rereadMs = options.rereadMs ?? REREAD_MS;
  let stored: string | null;
  let storedRepos: string | null;
  try {
    stored = await deps.read();
    // Read with it, and failing the same way: a repository a person paused is
    // not quietly resumed by a restart either.
    storedRepos = deps.readRepos ? await deps.readRepos() : null;
    if (repoPausesFrom(storedRepos) === null) throw new Error('the repositories’ pauses are stored in a form that does not read');
  } catch (error) {
    // Unless a person resumed meanwhile, which says what they want.
    if (deps.gate.pausedByAPerson() === null || deps.gate.pausedByAPerson() === UNREAD_WORDS) {
      deps.gate.pauseWork(UNREAD_WORDS);
    }
    log(`could not read whether work is paused, so it stays paused and is read again in ${Math.round(rereadMs / 1000)}s: ${error instanceof Error ? error.message : error}`);
    schedule(() => {
      if (deps.gate.pausedByAPerson() !== UNREAD_WORDS) return;
      void restorePause(deps, options);
    }, rereadMs);
    return null;
  }
  const pause = pauseFrom(stored);
  deps.gate.pauseWork(pause ? pausedWords(pause) : null);
  holdRepos(deps.gate, repoPausesFrom(storedRepos) ?? {});
  return pause;
}

/**
 * Puts on the gate the pauses a restore left in the settings, and audits each
 * one it changed as the restore's. An archive carries `workPaused` and
 * `workPausedRepos`, and a restore writes them as stored settings; the gate was
 * read only at start, so Settings said "paused by jane" while the dispatcher
 * kept leasing, until the next restart paused it by surprise. A restore's own
 * hold is separate from these and is let go on its own.
 */
export async function resyncPause(
  deps: Pick<PauseDeps, 'gate' | 'read' | 'readRepos' | 'audit'>,
  input: { actor: string; source: string },
): Promise<void> {
  const before = { work: deps.gate.pausedByAPerson(), repos: new Set(deps.gate.pausedRepos()) };
  await restorePause(deps);
  const after = { work: deps.gate.pausedByAPerson(), repos: new Set(deps.gate.pausedRepos()) };
  const changes: { action: string; target: string; payload: Record<string, unknown> }[] = [];
  if (after.work !== before.work) {
    changes.push({ action: after.work ? 'work.paused' : 'work.resumed', target: 'dispatch', payload: { source: input.source, ...(after.work ? { words: after.work } : {}) } });
  }
  for (const name of after.repos) if (!before.repos.has(name)) changes.push({ action: 'work.paused', target: `repo:${name}`, payload: { source: input.source } });
  for (const name of before.repos) if (!after.repos.has(name)) changes.push({ action: 'work.resumed', target: `repo:${name}`, payload: { source: input.source } });
  for (const change of changes) await deps.audit({ actor: input.actor, ...change }).catch(() => undefined);
}

/** Holds the gate for exactly these repositories' pauses. */
function holdRepos(gate: DispatchGate, pauses: Record<string, WorkPause>): void {
  for (const name of gate.pausedRepos()) if (!pauses[name]) gate.pauseRepo(name, null);
  for (const [name, pause] of Object.entries(pauses)) gate.pauseRepo(name, repoPausedWords(name, pause));
}

/**
 * Refuses to start new work while it is paused: a person's pause, a restore
 * into the install, or a pause that could not be read. What every start that
 * is not the dispatcher's lease asks — a triage, a retry — about the
 * repository it would start work in, when it has one.
 */
export function refuseWhilePaused(gate: Pick<DispatchGate, 'paused'> | undefined, repo?: string | null): void {
  const why = gate?.paused(repo);
  if (why) throw new HttpFailure(409, `nothing new starts: ${why}`);
}

export function registerPauseRoutes(router: Router, gate: DispatchGate, overrides: Partial<Omit<PauseDeps, 'gate'>> = {}): void {
  const deps: PauseDeps = { gate, ...LIVE, ...overrides };

  /**
   * The repositories a pause or resume names, each as its name: a name or
   * `owner/name` of a repository OpenADLC works in. A resume may also name one
   * that is paused and has since been taken out of OpenADLC, or its pause could
   * never be let go. An unknown name refuses the whole call, so a typo does
   * not leave a person believing a repository is paused.
   */
  async function named(value: unknown, paused: Record<string, WorkPause> = {}): Promise<string[]> {
    if (!Array.isArray(value) || value.length === 0 || value.some((one) => typeof one !== 'string' || !one.trim())) {
      throw new HttpFailure(400, 'repos is a list of repository names; leave it out to mean every repository');
    }
    const known = await deps.repositories();
    const names: string[] = [];
    const unknown: string[] = [];
    for (const wanted of (value as string[]).map((one) => one.trim())) {
      const repo = known.find((one) => one.name === wanted || one.fullName === wanted);
      if (repo) names.push(repo.name);
      else if (paused[wanted]) names.push(wanted);
      else unknown.push(wanted);
    }
    if (unknown.length > 0) {
      throw new HttpFailure(400, `OpenADLC does not work in ${unknown.join(', ')}; name a repository listed in Settings → Repositories`);
    }
    return [...new Set(names)];
  }

  const writeRepos = (pauses: Record<string, WorkPause>, by: string) =>
    deps.writeRepos(Object.keys(pauses).length > 0 ? JSON.stringify(pauses) : '', by);

  const dispatching = deps.dispatching !== false;

  router.get('/v1/work/pause', async () => {
    const paused = pauseFrom(await deps.read());
    const repoPauses = repoPausesFrom(await deps.readRepos()) ?? {};
    // Held because the setting could not be read as the bridge started: said
    // as a pause, so the board and Settings show it and offer Resume.
    if (!paused && deps.gate.pausedByAPerson() === UNREAD_WORDS) {
      return {
        paused: { by: 'the bridge', at: new Date().toISOString(), reason: 'it could not read whether work was paused as it started' },
        repos: repoPauses,
        dispatching,
      };
    }
    return { paused, repos: repoPauses, dispatching };
  });

  router.post('/v1/work/pause', async ({ body, identity }) => {
    const input = await body<{ reason?: unknown; repos?: unknown }>().catch(() => ({}) as { reason?: unknown; repos?: unknown });
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 200) : null;
    const pause: WorkPause = { by: identity, at: new Date().toISOString(), reason };
    return deps.exclusive(WORK_PAUSE_LOCK, async () => {
      if (input.repos === undefined || input.repos === null) {
        await deps.write(JSON.stringify(pause), identity);
        deps.gate.pauseWork(pausedWords(pause));
        await deps.audit({ actor: identity, action: 'work.paused', target: 'dispatch', payload: { reason } });
        // Onto the gate as well as into the answer. Paused in the window after
        // a start that could not read them, the repositories were said to be
        // paused but never held, and a later keepRepos resume let them all go.
        const repoPauses = repoPausesFrom(await deps.readRepos());
        if (repoPauses) holdRepos(deps.gate, repoPauses);
        return { paused: pause, repos: repoPauses ?? {} };
      }

      const repoPauses = repoPausesFrom(await deps.readRepos()) ?? {};
      // A repository paused already keeps the pause it has. Paused again from
      // a page that had not seen it, its author, time and reason were
      // replaced, and an incident's note with an empty one.
      const names = (await named(input.repos)).filter((name) => !repoPauses[name]);
      for (const name of names) repoPauses[name] = pause;
      await writeRepos(repoPauses, identity);
      // One row per repository, so the audit log answers "who paused this one"
      // by its own target, as the board's line does.
      for (const name of names) {
        deps.gate.pauseRepo(name, repoPausedWords(name, pause));
        await deps.audit({ actor: identity, action: 'work.paused', target: `repo:${name}`, payload: { reason } });
      }
      return { paused: pauseFrom(await deps.read()), repos: repoPauses };
    });
  });

  router.post('/v1/work/resume', async ({ body, identity }) => {
    const input = await body<{ repos?: unknown; keepRepos?: unknown }>().catch(() => ({}) as { repos?: unknown; keepRepos?: unknown });
    return deps.exclusive(WORK_PAUSE_LOCK, async () => {
      const storedRepos = await deps.readRepos();
      const readable = repoPausesFrom(storedRepos);
      const repoPauses = readable ?? {};

      // The install's pause alone: each repository a person paused on its own
      // stays paused. Settings offers it beside resuming everything, so lifting
      // the install's pause does not quietly lift theirs too.
      if (input.keepRepos === true) {
        if (input.repos !== undefined && input.repos !== null) throw new HttpFailure(400, 'keepRepos resumes the install alone; name no repositories with it');
        const was = pauseFrom(await deps.read());
        const held = deps.gate.pausedByAPerson();
        if (!was && !held) throw new HttpFailure(409, 'work is not paused across the install');
        // Which repositories to keep paused is what could not be read: lifting
        // the install's pause alone would let them all go.
        if (readable === null) {
          throw new HttpFailure(409, 'the repositories’ own pauses could not be read, so none can be kept paused; resume everything, then pause them again');
        }
        await deps.write('', identity);
        // The repositories kept paused are held before the install's pause
        // lifts. Only a start's read put them on the gate, and a resume before
        // that read succeeded said they were kept while dispatch leased them.
        holdRepos(deps.gate, readable);
        deps.gate.pauseWork(null);
        deps.resumed?.();
        await deps.audit({
          actor: identity,
          action: 'work.resumed',
          target: 'dispatch',
          payload: { ...(was ? { pausedBy: was.by, pausedAt: was.at } : { pausedBy: 'the bridge', why: held }), keptPaused: Object.keys(repoPauses) },
        });
        return { paused: null, repos: repoPauses };
      }

      if (input.repos === undefined || input.repos === null) {
        // Everything: the install's pause and every repository's.
        const was = pauseFrom(await deps.read());
        const held = deps.gate.pausedByAPerson();
        const repoNames = [...new Set([...Object.keys(repoPauses), ...deps.gate.pausedRepos()])];
        if (!was && !held && repoNames.length === 0) throw new HttpFailure(409, 'work is not paused');
        if (was || held) {
          await deps.write('', identity);
          deps.gate.pauseWork(null);
        }
        // A value that did not read is cleared too, or the next start would hold everything again.
        if (repoNames.length > 0 || storedRepos) await deps.writeRepos('', identity);
        for (const name of repoNames) deps.gate.pauseRepo(name, null);
        deps.resumed?.();
        if (was || held) {
          await deps.audit({
            actor: identity,
            action: 'work.resumed',
            target: 'dispatch',
            payload: was ? { pausedBy: was.by, pausedAt: was.at } : { pausedBy: 'the bridge', why: held },
          });
        }
        for (const name of repoNames) {
          const one = repoPauses[name];
          await deps.audit({ actor: identity, action: 'work.resumed', target: `repo:${name}`, payload: one ? { pausedBy: one.by, pausedAt: one.at } : {} });
        }
        return { paused: null, repos: {} };
      }

      const names = await named(input.repos, repoPauses);
      const resumed = names.filter((name) => repoPauses[name] || deps.gate.pausedRepos().includes(name));
      if (resumed.length === 0) {
        throw new HttpFailure(409, `${names.join(', ')} ${names.length > 1 ? 'are not paused on their own' : 'is not paused on its own'}${deps.gate.pausedByAPerson() ? '; work is paused across the install, which Resume work lets go' : ''}`);
      }
      const was = Object.fromEntries(resumed.map((name) => [name, repoPauses[name]]));
      for (const name of resumed) delete repoPauses[name];
      await writeRepos(repoPauses, identity);
      for (const name of resumed) deps.gate.pauseRepo(name, null);
      deps.resumed?.(resumed);
      for (const name of resumed) {
        const one = was[name];
        await deps.audit({ actor: identity, action: 'work.resumed', target: `repo:${name}`, payload: one ? { pausedBy: one.by, pausedAt: one.at } : {} });
      }
      return { paused: pauseFrom(await deps.read()), repos: repoPauses };
    });
  });
}
