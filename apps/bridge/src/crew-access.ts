import { audit, repos } from '@fleetadlc/db';
import type { Reach, ReachFix } from './app-reach.js';
import type { CrewAccess, InvitationService } from './invitation-service.js';

/**
 * Keeping the crew able to work in every repository OpenADLC works in.
 *
 * A bot works in a repository only once GitHub lets it: a collaborator on a
 * repository a person owns, which takes an invitation the bot then accepts
 * with its own token, and on one an organization owns either that or a team.
 * The walkthrough did this for the first repository and nothing did it for
 * any other, so a repository added later was one the crew could see on the
 * board and not push to.
 *
 * So it is done for each repository when it is added, for every one when the
 * bridge starts and each time it reconciles, and for a bot when it connects.
 * Each run asks GitHub first and leaves a bot that can already work there
 * alone (`InvitationService.inviteAndAccept`), which is what makes running it
 * that often harmless. What each run found is kept for settings to show, and
 * only what changed is audited: a refusal repeated every quarter hour is not
 * news.
 */

/** What started a run, which is what settings' line says while it is going. */
export type AccessTrigger = 'added' | 'retry' | 'start' | 'reconcile' | 'connected' | 'invite';

/** A repository's crew, as the last run found it. */
export interface RepoAccess {
  repository: string;
  /** Whether a run is going now, and what started the newest one. */
  running: boolean;
  trigger: AccessTrigger | null;
  /** When the last run finished; null before one has. */
  checkedAt: string | null;
  /**
   * Why the last run could not look at all — no key for the app, the app not
   * installed there. Its bots are then what the run before it found.
   */
  error: string | null;
  /**
   * What a person does so the app can reach the repository at all, when it
   * cannot — install it on the account, make it public first, give it the
   * repository — with the button to where that is done. `error` is its title.
   */
  needs: ReachFix | null;
  /** Each bot of the crew, as the last run found it. */
  bots: CrewAccess[];
}

type Inviting = Pick<InvitationService, 'inviteAndAccept'>;

const key = (repository: string): string => repository.toLowerCase();

/** A person's words for a bot's state, for the log and the reconcile's report. */
function sentence(repository: string, bot: CrewAccess): string {
  switch (bot.state) {
    case 'in':
      return `${bot.bot} can work in ${repository}`;
    case 'invited':
      return `${bot.bot} is invited to ${repository}: ${bot.detail}`;
    case 'no-account':
      return `${bot.bot} cannot work in ${repository}: ${bot.detail}`;
    case 'refused':
      return `could not let ${bot.bot} into ${repository}: ${bot.detail}`;
  }
}

/**
 * Whether what a run found about a bot is worth saying: GitHub changed —
 * somebody was invited or let in — or something is wrong that was not before.
 * A bot found able to work, as it was, is not; nor, on a first look, is one
 * that simply can.
 */
export function isNews(before: CrewAccess | undefined, now: CrewAccess): boolean {
  if (now.changed) return true;
  if (!before) return now.state !== 'in';
  if (before.state !== now.state) return true;
  return now.state !== 'in' && before.detail !== now.detail;
}

export class CrewAccessKeeper {
  private readonly state = new Map<string, RepoAccess>();
  /** Told when a run changed who can work where. */
  private readonly listeners: (() => void)[] = [];
  /** The run going for each repository, and whether it is for the whole crew. */
  private readonly inFlight = new Map<string, { run: Promise<RepoAccess>; whole: boolean }>();

  constructor(
    private readonly invitations: Inviting,
    private readonly now: () => Date = () => new Date(),
    /** Whether the app can reach a repository; see `app-reach.ts`. Without it, every run tries. */
    private readonly reach: ((repository: string) => Promise<Reach>) | null = null,
  ) {}

  /**
   * Something to tell when a run changed who can work where: the health check
   * that asks each bot what it may do looks again, rather than saying for half
   * an hour that a bot let in a minute ago cannot push.
   */
  whenChanged(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** What the last run found, or null for a repository no run has looked at. */
  view(repository: string): RepoAccess | null {
    const found = this.state.get(key(repository));
    return found ? { ...found, bots: [...found.bots] } : null;
  }

  /**
   * Lets the crew into one repository, or one bot of it, and says how that
   * went. Never throws: a run that cannot look is recorded with why.
   *
   * A run already going for the whole crew is joined rather than repeated. One
   * for a single bot — it has just connected — waits for it and then runs, so
   * the answer is about the bot as it is now, connected.
   */
  ensure(repository: string, trigger: AccessTrigger, options: { actor?: string; onlyBot?: string } = {}): Promise<RepoAccess> {
    const going = this.inFlight.get(key(repository));
    if (going?.whole && !options.onlyBot) return going.run;

    // Marked before anything is awaited, so a page read straight after an add
    // says the crew is being let in rather than that nobody has looked.
    const before = this.state.get(key(repository));
    this.state.set(key(repository), {
      repository,
      running: true,
      trigger,
      checkedAt: before?.checkedAt ?? null,
      error: before?.error ?? null,
      needs: before?.needs ?? null,
      bots: before?.bots ?? [],
    });

    const run: Promise<RepoAccess> = (going?.run ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => this.run(repository, trigger, options))
      .finally(() => {
        if (this.inFlight.get(key(repository))?.run === run) this.inFlight.delete(key(repository));
      });
    this.inFlight.set(key(repository), { run, whole: !options.onlyBot });
    return run;
  }

  private async run(
    repository: string,
    trigger: AccessTrigger,
    options: { actor?: string; onlyBot?: string },
  ): Promise<RepoAccess> {
    const before = this.state.get(key(repository));
    const previous = new Map((before?.bots ?? []).map((bot) => [bot.bot, bot]));

    let bots = before?.bots ?? [];
    let error: string | null = null;
    let needs: ReachFix | null = null;
    // Asked before inviting anybody: no invitation can be sent where the app
    // is not installed, and trying left GitHub's answer — its 404, as JSON —
    // for settings to show beside a "Try again" that could never work. No
    // answer is not a refusal: the invitations say what they find.
    const reached = this.reach ? await this.reach(repository).catch(() => null) : null;
    if (reached?.state === 'blocked') {
      const { need, title, detail, action, steps } = reached;
      needs = { need, title, detail, action, steps };
      error = title;
    } else {
      try {
        const { results } = await this.invitations.inviteAndAccept(repository, options.onlyBot);
        bots = options.onlyBot
          ? [...bots.filter((bot) => !results.some((result) => result.bot === bot.bot)), ...results]
          : results;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }

    const after: RepoAccess = {
      repository,
      running: false,
      trigger,
      checkedAt: this.now().toISOString(),
      error,
      needs,
      bots,
    };
    // A repository removed while this ran is not brought back by it.
    const current = this.state.get(key(repository));
    if (current) this.state.set(key(repository), after);

    const changes = error ? [] : bots.filter((bot) => isNews(previous.get(bot.bot), bot));
    if (changes.length > 0 || (error && error !== before?.error)) {
      await audit({
        actor: options.actor ?? 'fleetadlc',
        action: 'repo.crew_access',
        target: repository,
        payload: {
          trigger,
          ...(error ? { error } : {}),
          changes: changes.map(({ bot, login, state, detail }) => ({ bot, login, state, detail })),
        },
      }).catch(() => undefined);
      for (const bot of changes) console.log(`[bridge] ${sentence(repository, bot)}`);
      if (error) console.warn(`[bridge] could not let the crew into ${repository}: ${error}`);
    }
    if (changes.some((bot) => bot.changed)) {
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          // Somebody else's to say; this run is done either way.
        }
      }
    }
    return after;
  }

  /**
   * Every repository OpenADLC works in, one after another. What changed, and what
   * is newly wrong, as a line each for whoever started it; nothing when all of
   * it is as it was.
   */
  async ensureAll(trigger: AccessTrigger, options: { actor?: string } = {}): Promise<string[]> {
    const managed = await repos.listRepos();
    const kept = new Set(managed.map((repo) => key(repo.fullName)));
    for (const known of [...this.state.keys()]) if (!kept.has(known)) this.state.delete(known);

    const lines: string[] = [];
    for (const repo of managed) {
      const before = this.view(repo.fullName);
      const previous = new Map((before?.bots ?? []).map((bot) => [bot.bot, bot]));
      const after = await this.ensure(repo.fullName, trigger, options);
      if (after.error) {
        if (after.error !== before?.error) lines.push(`could not let the crew into ${repo.fullName}: ${after.error}`);
        continue;
      }
      for (const bot of after.bots) if (isNews(previous.get(bot.bot), bot)) lines.push(sentence(repo.fullName, bot));
    }
    return lines;
  }

  /** Forgets a repository OpenADLC no longer works in. */
  forget(repository: string): void {
    this.state.delete(key(repository));
  }
}

/**
 * One line per bot for a run over several repositories: the worst any of them
 * found — an account that does not exist is that everywhere, a refusal is
 * worse than an invitation still to accept — naming the repository when it is
 * not in them all.
 */
export function acrossRepositories(perRepository: readonly { repository: string; bots: readonly CrewAccess[] }[]): CrewAccess[] {
  const rank: Record<CrewAccess['state'], number> = { in: 0, invited: 1, refused: 2, 'no-account': 3 };
  const merged = new Map<string, CrewAccess>();
  for (const { repository, bots } of perRepository) {
    for (const bot of bots) {
      const named = perRepository.length > 1 && bot.state !== 'in' ? { ...bot, detail: `${repository}: ${bot.detail}` } : bot;
      const seen = merged.get(bot.bot);
      if (!seen) merged.set(bot.bot, named);
      else {
        const worse = rank[named.state] > rank[seen.state] ? named : seen;
        merged.set(bot.bot, { ...worse, changed: seen.changed || named.changed });
      }
    }
  }
  return [...merged.values()];
}
