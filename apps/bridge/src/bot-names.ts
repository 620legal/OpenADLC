import { signInOf, type SignIn } from './sign-in.js';
import { audit, bots, credentials, tasks } from '@fleetadlc/db';
import { BOT_SECRET_REFS, accessTokenRef, credentialKind, getSecretStore, refreshTokenRef, type SecretStore } from '@fleetadlc/github';
import { holdsCredential, isBotName, nameForLogin, roleLabel, type Bot } from '@fleetadlc/shared';

/**
 * What a bot is called, and the one routine that changes it.
 *
 * A bot is its GitHub account. Its name is that account's login, lowercased,
 * and before an account connects it is its seat (`builder`). Everything kept
 * for a bot is named after it — its container, sidecar, network and sessions,
 * its work folder, its secrets, the branches it pushes and the author of its
 * commits — so a new name is a move of all of them, not an update of a
 * column. This is that move, and nothing else renames a bot:
 *
 *   1. hostd renames the computer and moves the folder. It refuses while the
 *      bot has a task queued or running, as this does before it asks.
 *   2. With the token broker held off both names, every secret named after the
 *      bot is copied to the new name; the row, its container, the credential
 *      row's ref and the audit line change in one transaction; the old secrets
 *      are deleted. The row is marked with the old name until they are.
 *
 * Each step can be run again. A bridge that stops after hostd answered finds
 * the row under the old name and asks hostd again, which finds the folder
 * already moved; one that stops after the row changed finds the mark and
 * finishes moving the secrets. Both happen on the next reconcile.
 *
 * A rename that has to wait — the bot is working, hostd is not answering — is
 * reported as waiting, not dropped: the reconcile runs again a minute later
 * for as long as anything is waiting, and at every start of the bridge.
 */

export type RenameState = 'renamed' | 'unchanged' | 'waiting' | 'refused';

export interface RenameOutcome {
  botId: string;
  /** The name before. */
  from: string;
  /** The name asked for. */
  to: string;
  state: RenameState;
  /** Why it waited or was refused, in words for a log line or a page. */
  reason?: string;
}

/** The part of the database a rename touches, so a test can stand in for it. */
export interface NamesDb {
  listBots(): Promise<Bot[]>;
  getBotById(id: string): Promise<Bot | null>;
  countActiveTasksForBot(botId: string): Promise<number>;
  renameBotRow: typeof bots.renameBotRow;
  finishRename(botId: string): Promise<void>;
  unfinishedRenames(): Promise<{ id: string; name: string; renamedFrom: string }[]>;
  setGithubLogin(botId: string, login: string | null): Promise<void>;
  getCredential(botId: string): Promise<{ githubLogin: string; status: string } | null>;
  /**
   * Where the bot's GitHub sign-in is filed and whether other seats share it
   * (see sign-in.ts). Absent in a test that has no identities: the bot's own
   * name, unshared, as it always was.
   */
  signInOf?(bot: Bot): Promise<SignIn>;
  audit(input: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<void>;
}

export interface BotNamesDeps {
  hostd: { renameBot(from: string, to: string): Promise<unknown> };
  /** Holds the token broker off these names while `fn` moves their secrets. */
  exclusive<T>(names: readonly string[], fn: () => Promise<T>): Promise<T>;
  store?: SecretStore;
  db?: NamesDb;
  /** How long to wait before trying a waiting rename again; 0 never retries. */
  retryMs?: number;
  log?: (line: string) => void;
}

function liveDb(): NamesDb {
  return {
    listBots: bots.listBots,
    getBotById: bots.getBotById,
    countActiveTasksForBot: tasks.countActiveTasksForBot,
    renameBotRow: bots.renameBotRow,
    finishRename: bots.finishRename,
    unfinishedRenames: bots.unfinishedRenames,
    setGithubLogin: bots.setGithubLogin,
    getCredential: credentials.getCredential,
    signInOf,
    audit,
  };
}

/**
 * One queue per bot. A rename holds its bot's for the whole move, and opening
 * or resuming a task on that bot takes it too, so no task starts on a
 * container that is half-way to having another name.
 */
class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/**
 * The secrets that move with a renamed bot: all of them, less the GitHub
 * sign-in unless it is the bot's own. A shared account's sign-in belongs to
 * every seat on it.
 */
function refsThatMove(ownSignIn: boolean): typeof BOT_SECRET_REFS {
  const signInRefs = new Set([refreshTokenRef(''), accessTokenRef('')]);
  return BOT_SECRET_REFS.filter((ref) => ownSignIn || !signInRefs.has(ref('')));
}

/** The name a bot should have: its account's handle while connected, else its seat. */
export interface Wanted {
  bot: Bot;
  to: string;
  reason: string;
}

export class BotNames {
  private readonly locks = new KeyedLock();
  private readonly db: NamesDb;
  private readonly store: SecretStore;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<RenameOutcome[]> | null = null;
  private startup: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BotNamesDeps) {
    this.db = deps.db ?? liveDb();
    this.store = deps.store ?? getSecretStore();
  }

  private say(line: string): void {
    (this.deps.log ?? ((text: string) => console.log(text)))(`[bridge] ${line}`);
  }

  /**
   * Runs `fn` with the bot's queue held: nothing renames it meanwhile. What
   * opens or resumes a task wraps the part that reads the bot's name and
   * commits to it, and reads the name again inside — a rename it waited for
   * may have changed it.
   */
  withBot<T>(botId: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(botId, fn);
  }

  /** Renames one bot, when nothing stands in the way; see the module comment. */
  rename(input: { botId: string; to: string; reason: string; actor: string }): Promise<RenameOutcome> {
    return this.locks.run(input.botId, () => this.renameHeld(input));
  }

  private async renameHeld(input: { botId: string; to: string; reason: string; actor: string }): Promise<RenameOutcome> {
    const bot = await this.db.getBotById(input.botId);
    const to = input.to.trim().toLowerCase();
    const outcome = (state: RenameState, reason?: string): RenameOutcome => ({
      botId: input.botId,
      from: bot?.name ?? '',
      to,
      state,
      ...(reason ? { reason } : {}),
    });

    if (!bot) return outcome('refused', 'there is no such bot');
    if (!isBotName(to)) {
      return outcome('refused', `${input.to} cannot be a bot's name: it has to be a GitHub login or a seat`);
    }
    if (bot.name === to) return outcome('unchanged');

    // A name is one bot's, and so is a seat: an account whose handle is `qa`,
    // connected to the builder, must not give it a name the QA seat also
    // answers to. That bot keeps its seat's name, and says why.
    const crew = await this.db.listBots();
    const clash = crew.find((other) => other.id !== bot.id && (other.name === to || other.slot === to));
    if (clash) {
      return outcome(
        'refused',
        clash.name === to
          ? `${to} is already the name of the ${roleLabel(clash.role)}`
          : `${to} is the seat of the ${roleLabel(clash.role)}`,
      );
    }

    if ((await this.db.countActiveTasksForBot(bot.id)) > 0) {
      this.retrySoon();
      return outcome('waiting', `${bot.name} has a task queued or running; it is renamed once that ends`);
    }

    try {
      await this.deps.hostd.renameBot(bot.name, to);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const said = error instanceof Error ? error.message : String(error);
      // A name hostd will never accept is refused; anything else — busy, a
      // folder in the way, hostd not answering — is worth another try.
      if (status === 400) return outcome('refused', said);
      this.retrySoon();
      return outcome('waiting', said);
    }

    // The GitHub sign-in moves with the bot only when it is filed under the
    // bot's own name. A shared account's is filed under the account's name and
    // belongs to every seat on it; moving it would take it from the others.
    // Not just "filed under this name": the seat an account was shared from
    // has it filed under its own name, which is also the account's, and moving
    // it took every other seat's sign-in with it.
    const signIn = await this.signIn(bot);
    const ownSignIn = !signIn.shared && signIn.ns === bot.name;
    const pairs = refsThatMove(ownSignIn).map((ref) => ({
      from: ref(bot.name),
      to: ref(to),
    }));
    // hostd has moved the computer by now. If the rest cannot be done, the row
    // still has the old name, and the next reconcile asks hostd again — which
    // finds its half done — and does this half then.
    const moved = await this.deps.exclusive([bot.name, to], async () => {
      // The old name's secrets are the live ones until the row changes, so
      // they are copied over whatever the new name holds. Anything the new
      // name holds that is not being copied belongs to nobody: the bot that
      // last had that name took its own when it left, so a leftover is a
      // credential this bot must not inherit.
      for (const pair of pairs) {
        const value = await this.store.get(pair.from);
        if (value !== null) await this.store.set(pair.to, value);
        else await this.store.delete(pair.to);
      }

      const row = await this.db.renameBotRow({
        id: bot.id,
        from: bot.name,
        to,
        actor: input.actor,
        reason: input.reason,
        secretRefs: ownSignIn
          ? [
              { from: refreshTokenRef(bot.name), to: refreshTokenRef(to) },
              { from: accessTokenRef(bot.name), to: accessTokenRef(to) },
            ]
          : [],
      });
      if (!row) return null;

      for (const pair of pairs) await this.store.delete(pair.from);
      await this.db.finishRename(bot.id);
      return row;
    }).catch((error: unknown) => {
      this.retrySoon();
      return error instanceof Error ? error : new Error(String(error));
    });

    if (moved instanceof Error) {
      return outcome('waiting', `${bot.name}'s computer is renamed ${to}, and the rest waits: ${moved.message}`);
    }
    if (!moved) {
      this.retrySoon();
      return outcome('waiting', `${bot.name} was renamed by something else while this waited`);
    }
    this.say(`${bot.name} is now ${to}: ${input.reason}`);
    return outcome('renamed');
  }

  /**
   * The secrets of a rename that stopped after the row changed.
   *
   * The row carries the new name, so the broker has been refreshing under it:
   * a secret already there is the live one and stays. One only under the old
   * name is moved across, and the old name then holds nothing.
   *
   * A shared account's sign-in stays where the account files it, as it does
   * in an uninterrupted rename: moving it here took it from every other seat
   * on that account. The row has changed, so an own sign-in is filed under
   * the new name by now and a shared one is still under the account's.
   */
  private async finishSecrets(pending: { id: string; name: string; renamedFrom: string }): Promise<void> {
    const bot = await this.db.getBotById(pending.id);
    const signIn = bot ? await this.signIn(bot) : null;
    const ownSignIn = signIn !== null && !signIn.shared && signIn.ns === pending.name;
    await this.deps.exclusive([pending.renamedFrom, pending.name], async () => {
      for (const ref of refsThatMove(ownSignIn)) {
        const old = await this.store.get(ref(pending.renamedFrom));
        if (old === null) continue;
        if ((await this.store.get(ref(pending.name))) === null) await this.store.set(ref(pending.name), old);
        await this.store.delete(ref(pending.renamedFrom));
      }
      await this.db.finishRename(pending.id);
    });
    this.say(`${pending.name}: finished moving the secrets it had as ${pending.renamedFrom}`);
  }

  /** Where the bot's GitHub sign-in is filed (`ns`) and whether other seats share it (sign-in.ts). */
  private async signIn(bot: Bot): Promise<SignIn> {
    return this.db.signInOf ? this.db.signInOf(bot) : { ns: bot.name, shared: false };
  }

  /**
   * Whether a bot holds a credential, and for which login — the same test
   * onboarding's "connected" uses.
   */
  async connection(bot: Bot): Promise<{ connected: boolean; login: string | null }> {
    const credential = await this.db.getCredential(bot.id);
    const kind = await credentialKind((await this.signIn(bot)).ns, this.store);
    return {
      connected: holdsCredential(kind, credential),
      login: bot.githubLogin ?? credential?.githubLogin ?? null,
    };
  }

  /**
   * The name each bot should have.
   *
   * Connected with a login: the login, lowercased. Not connected and not in
   * its seat — a persona name, or a handle it no longer holds a credential
   * for — its seat, and it lets go of the login it names. A row that names an
   * account it holds nothing for is how a fresh install ended up "setting
   * aside" an account for a bot nobody had connected.
   *
   * A bot already in its seat keeps a login it names: that is a restored
   * install saying which account the seat had, for the walkthrough to suggest.
   * Keeping it blocks no connection: whichever bot does connect as that
   * account takes the login from it then.
   */
  private async wanted(actor: string): Promise<Wanted[]> {
    const wanted: Wanted[] = [];
    for (const bot of await this.db.listBots()) {
      // One bot's row that cannot be read or written is that bot's problem,
      // said and left for the next pass — not a reason to leave the rest of
      // the crew under names they should no longer have.
      try {
        const plan = await this.wantedFor(bot, actor);
        if (plan) wanted.push(plan);
      } catch (error) {
        this.retrySoon();
        this.say(`could not work out what ${bot.name} should be called: ${error instanceof Error ? error.message : error}`);
      }
    }
    return wanted;
  }

  private async wantedFor(bot: Bot, actor: string): Promise<Wanted | null> {
    const { connected, login } = await this.connection(bot);
    if (connected) {
      if (!login) return null;
      if (!bot.githubLogin) await this.db.setGithubLogin(bot.id, login);
      // Seats that share one account keep their seats' names: nine bots all
      // called by one login could not tell each other apart, and none of them
      // is more that account than the rest.
      if ((await this.signIn(bot)).shared) {
        return bot.name !== bot.slot ? { bot, to: bot.slot, reason: `it shares ${login} with other seats` } : null;
      }
      const handle = nameForLogin(login);
      return bot.name !== handle ? { bot, to: handle, reason: `it is connected as ${login}` } : null;
    }
    if (bot.name === bot.slot) return null;
    if (bot.githubLogin) {
      await this.db.setGithubLogin(bot.id, null);
      await this.db.audit({
        actor,
        action: 'bot.login_released',
        target: bot.name,
        payload: { login: bot.githubLogin, reason: 'no credential is stored for it' },
      });
      this.say(`${bot.name} holds no credential, so it no longer names ${bot.githubLogin}`);
    }
    return { bot, to: bot.slot, reason: 'no account is connected to it' };
  }

  /**
   * Brings every bot's name in line with its account: what an install does at
   * start, which is how an existing install moves from persona names to
   * handles, and how an interrupted rename is finished.
   *
   * Bots going back to their seats go first, because a handle is free only
   * once the bot holding it has let go. A rename refused because another bot
   * still had the name is tried once more after everything else has moved.
   * One reconcile at a time: a second caller gets the one already running.
   */
  reconcile(actor = 'bridge'): Promise<RenameOutcome[]> {
    this.running ??= this.reconcileOnce(actor).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async reconcileOnce(actor: string): Promise<RenameOutcome[]> {
    for (const pending of await this.db.unfinishedRenames()) {
      await this.locks.run(pending.id, () => this.finishSecrets(pending));
    }

    const plans = await this.wanted(actor);
    plans.sort((a, b) => Number(a.to !== a.bot.slot) - Number(b.to !== b.bot.slot));

    const outcomes: RenameOutcome[] = [];
    const blocked: Wanted[] = [];
    const attempt = (plan: Wanted): Promise<RenameOutcome> =>
      this.rename({ botId: plan.bot.id, to: plan.to, reason: plan.reason, actor }).catch((error: unknown) => {
        this.retrySoon();
        return {
          botId: plan.bot.id,
          from: plan.bot.name,
          to: plan.to,
          state: 'waiting' as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      });
    for (const plan of plans) {
      const outcome = await attempt(plan);
      if (outcome.state === 'refused' && /already the name of/.test(outcome.reason ?? '')) blocked.push(plan);
      else outcomes.push(outcome);
    }
    for (const plan of blocked) outcomes.push(await attempt(plan));

    for (const outcome of outcomes) {
      if (outcome.state === 'waiting' || outcome.state === 'refused') {
        this.say(`${outcome.from} is not renamed ${outcome.to} yet: ${outcome.reason ?? outcome.state}`);
      }
    }
    return outcomes;
  }

  /**
   * The reconcile the bridge runs when it starts, which is what moves an
   * existing install's crew from persona names to handles. Remembered so work
   * handed out meanwhile can wait for it: see `settled`.
   */
  begin(actor = 'bridge'): Promise<RenameOutcome[]> {
    const run = this.reconcile(actor);
    this.startup = run.catch(() => undefined);
    return run;
  }

  /**
   * Resolves once the start-up reconcile has done what it could, however that
   * went. A lease waits on this, so the dispatcher's first pass after a start
   * does not put a bot to work under a name it is about to lose.
   */
  async settled(): Promise<void> {
    await this.startup;
  }

  /**
   * Tries again in a minute, once, however many renames are waiting. The
   * reconcile it runs schedules the next try itself if anything still waits.
   */
  private retrySoon(): void {
    const delay = this.deps.retryMs ?? 60_000;
    if (delay <= 0 || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.reconcile().catch((error: unknown) => {
        this.say(`renaming the crew failed: ${error instanceof Error ? error.message : error}`);
        this.retrySoon();
      });
    }, delay);
    this.retry.unref?.();
  }

  stop(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }
}
