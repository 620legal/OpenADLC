/**
 * What a person reads a bot as.
 *
 * A bot is a role and the GitHub account it acts as. The account's handle is
 * what is on its commits, its reviews and its comments, and the role is what
 * it does here, so a sentence names both — "the second reviewer
 * (irisexampleco)" — as the bridge's own sentences do (`botInWords` in
 * `@fleetadlc/shared`; `bot-label.test.ts` fails if the two disagree). A handle
 * alone said which account but not which bot. Where there is room for one
 * word, a connected bot is its handle.
 *
 * Before an account is connected there is no handle. The bridge calls the bot by
 * the seat it fills, `second-reviewer` or `builder-2`, which is a slug for
 * addresses and container names rather than something to read, so an
 * unconnected bot is shown by its role: `second reviewer — not connected yet`.
 * The persona names the crew used to carry (`atlas`, `sydney`…) named nobody on
 * GitHub, and nothing here can produce one.
 *
 * Every place the console names a bot goes through this, so no two screens can
 * disagree about what a bot is called. Addresses and API calls go on using the
 * bot's `name`, which is the same handle once it is connected.
 */

/**
 * Each role, the seat a bot in it fills, and what the role is called.
 *
 * The words are `roleLabel` in `@fleetadlc/shared`, which the bridge sends with the
 * onboarding and engines views. The crew and thread views carry only the role,
 * so the words are copied here — the console does not depend on that package,
 * for the reason `stages.ts` gives — and `bot-label.test.ts` fails if the two
 * disagree.
 */
export const ROLES = {
  intake: { seat: 'intake', label: 'intake' },
  spec: { seat: 'system-engineer', label: 'system engineer' },
  implement: { seat: 'builder', label: 'builder' },
  review_lead: { seat: 'lead-reviewer', label: 'lead reviewer' },
  review_second: { seat: 'second-reviewer', label: 'second reviewer' },
  review_security: { seat: 'security-reviewer', label: 'security reviewer' },
  deploy: { seat: 'sre', label: 'SRE' },
  qa: { seat: 'qa', label: 'QA' },
  automation: { seat: 'automation', label: 'automation' },
} as const satisfies Record<string, { seat: string; label: string }>;

const BY_ROLE: Readonly<Record<string, { seat: string; label: string }>> = ROLES;

/**
 * Roles whose words are not a noun on their own. "Connected as the intake" and
 * "leave the automation without a model" read as unfinished, so a sentence
 * says "the intake bot". A label, where the role stands alone, does not.
 */
const NEEDS_A_NOUN = new Set(['intake', 'automation', 'QA']);

const SEAT_WORDS = new Map<string, string>(Object.values(ROLES).map((role) => [role.seat, role.label]));

/** A seat, and its number when it is the second of its kind or later: `builder-2`. */
const SEAT = new RegExp(`^(${[...SEAT_WORDS.keys()].join('|')})(?:-([2-9]|[1-9][0-9]+))?$`);

/** What a view knows about a bot. Only its name is needed; the rest is read when it is there. */
export interface BotFacts {
  /** The bot's name, as the board, the crew and the threads carry it. */
  name?: string | null;
  /** The same, as onboarding and the engines carry it. */
  bot?: string | null;
  /** The seat it fills, `second-reviewer`. Its name leaves the seat when an account connects. */
  slot?: string | null;
  /** `review_second`. */
  role?: string | null;
  /** `second reviewer`, when the bridge says it in words. */
  roleLabel?: string | null;
  /** Onboarding's: whether a credential is stored for it. */
  connected?: boolean | null;
  /** The crew's: `active`, `expired`, `revoked` or `unauthorized`. */
  authorization?: string | null;
  githubLogin?: string | null;
  /** Onboarding's login, which is the account's own only once it is connected. */
  login?: string | null;
  profile?: { login?: string | null } | null;
}

export interface BotLabel {
  /** The handle once connected, the role until then: a row's title, a chip, an `aria-label`. */
  name: string;
  /** In the middle of a sentence: `the second reviewer (irisexampleco)`, or `the second reviewer`. */
  said: string;
  /** Where there is room: `second reviewer (irisexampleco)`, or `second reviewer — not connected yet`. */
  text: string;
  /** The role in words, numbered when a seat is the second of its kind: `builder 2`. */
  role: string;
  /** The role in a sentence: "connected as the second reviewer". */
  asRole: string;
  /** The account's handle. Null until one is connected. */
  handle: string | null;
}

function idOf(bot: BotFacts): string {
  return (bot.name ?? bot.bot ?? '').trim();
}

function seatOf(name: string | null | undefined): { words: string; number: number | null } | null {
  const match = SEAT.exec((name ?? '').trim().toLowerCase());
  if (!match) return null;
  return { words: SEAT_WORDS.get(match[1]!) ?? '', number: match[2] ? Number(match[2]) : null };
}

/** Whether a name is a seat — `builder`, `lead-reviewer`, `builder-2` — rather than a handle. */
export function isSeat(name: string | null | undefined): boolean {
  return seatOf(name) !== null;
}

/**
 * Whether the bot has an account, from whatever the view says.
 *
 * Onboarding says so outright, and the crew's `unauthorized` says it has none.
 * Otherwise the seat beside the name says it — the name leaves the seat for the
 * handle when an account connects — and an expired or revoked credential is
 * still an account, one that needs connecting again. A bare name says it by not
 * being a seat.
 */
function connectedOf(bot: BotFacts, id: string): boolean {
  if (typeof bot.connected === 'boolean') return bot.connected;
  if (bot.authorization === 'unauthorized') return false;
  // Said outright before the name is asked: seats sharing one account keep
  // their seats' names, so a seat name says nothing about whether it has one.
  if (bot.authorization) return true;
  if (bot.slot) return id.toLowerCase() !== bot.slot.toLowerCase();
  return !isSeat(id);
}

/**
 * The handle. The name is it once the bot has left its seat; before the bridge
 * has renamed it, the account's own login is — never a name the bot had before.
 */
function handleOf(bot: BotFacts, id: string): string {
  if (bot.slot && id.toLowerCase() !== bot.slot.toLowerCase()) return id;
  return bot.profile?.login || bot.githubLogin || bot.login || id;
}

function roleOf(bot: BotFacts, id: string): { words: string; number: number | null } {
  const seat = seatOf(bot.slot) ?? (bot.slot ? null : seatOf(id));
  const words =
    bot.roleLabel?.trim() || (bot.role ? BY_ROLE[bot.role]?.label : undefined) || seat?.words || '';
  return { words, number: seat?.number ?? null };
}

export function botLabel(bot: BotFacts): BotLabel {
  const id = idOf(bot);
  const { words, number } = roleOf(bot, id);
  const role = number && words && !/\d$/.test(words) ? `${words} ${number}` : words;
  // A numbered seat is a name of sorts, and reads as one: "builder 2", not "the builder 2".
  const asRole = !role ? 'a bot' : number ? role : `the ${role}${NEEDS_A_NOUN.has(role) ? ' bot' : ''}`;

  if (connectedOf(bot, id)) {
    const handle = handleOf(bot, id);
    return {
      name: handle,
      said: role ? `${asRole} (${handle})` : handle,
      text: role ? `${role} (${handle})` : handle,
      role,
      asRole,
      handle,
    };
  }

  const name = role || id;
  return { name, said: role ? asRole : id, text: `${name} — not connected yet`, role, asRole, handle: null };
}

/** Several bots in a sentence: "irisexampleco, the builder and the SRE". */
export function listed(said: readonly string[]): string {
  if (said.length <= 1) return said[0] ?? '';
  return `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`;
}

/**
 * A sentence that starts with a bot: "The second reviewer (irisexampleco) has…",
 * "Builder 2 has…". A handle on its own is left as it is written.
 */
export function atStart(sentence: string): string {
  if (sentence.startsWith('the ')) return `The ${sentence.slice(4)}`;
  const seat = /^([a-z][a-z ]*? \d+)\b/.exec(sentence);
  return seat && SEAT_WORDS_SET.has(seat[1]!.replace(/ \d+$/, '')) ? sentence.charAt(0).toUpperCase() + sentence.slice(1) : sentence;
}

const SEAT_WORDS_SET = new Set<string>(Object.values(ROLES).map((role) => role.label));

/**
 * The bot a name means, from the crew.
 *
 * By its name first. Then by its seat, because a link made before a bot
 * connected carries the seat it has since left; then by its account.
 */
export function findBot<T extends BotFacts>(crew: readonly T[], name: string | null | undefined): T | undefined {
  const key = (name ?? '').trim().toLowerCase();
  if (!key) return undefined;
  return (
    crew.find((bot) => idOf(bot).toLowerCase() === key) ??
    crew.find((bot) => bot.slot?.toLowerCase() === key) ??
    crew.find((bot) => bot.githubLogin?.toLowerCase() === key)
  );
}

/**
 * The label for a bot that arrives as a name alone — a card's assignees, a
 * column's staff, a row of the ledger — from the crew, which knows the rest.
 */
export function labelIn(crew: readonly BotFacts[], name: string): BotLabel {
  return botLabel(findBot(crew, name) ?? { name });
}

/**
 * The seat a bot fills, which is what its account's username is made from.
 *
 * The role, never what the bot is called: its name becomes a handle when it
 * connects, and before the crew was named by seat it was a persona — a
 * username suggested from `atlas` put a name on GitHub that meant nothing there.
 */
export function seatFor(bot: BotFacts): string {
  if (bot.slot) return bot.slot;
  const id = idOf(bot);
  if (isSeat(id)) return id.toLowerCase();
  const byRole = bot.role ? BY_ROLE[bot.role]?.seat : undefined;
  if (byRole) return byRole;
  const words = (bot.roleLabel ?? '').trim().toLowerCase();
  const byWords = Object.values(ROLES).find((role) => role.label.toLowerCase() === words)?.seat;
  return byWords ?? (words.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || id);
}
