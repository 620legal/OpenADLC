import type { BotRole } from './types.js';

/**
 * Who a bot is, and where it sits.
 *
 * A bot's identity is the GitHub account connected to it. That is what signs
 * its commits, posts its reviews and appears in every history anybody reads,
 * so its name is that account's login, lowercased — and its container, its
 * work folder, its secrets and its tmux sessions are all named after it.
 *
 * Before an account connects there is no login to use, so a bot is named after
 * its seat: the entry in `config/bots.yaml` it was seeded from, which says what
 * it does (`builder`, `lead-reviewer`). The seat never changes; the name moves
 * from the seat to the handle when an account connects, and back if it stops
 * being connected.
 *
 * The crew used to have persona names — mira, nova, atlas and the rest — and
 * `config/bots.yaml` suggested an account for each. A fresh install then
 * "reserved" accounts nobody had connected, and refused a real one because a
 * previous install had once set it aside for another bot. The file names no
 * account any more, and nothing is keyed by a persona.
 */

/**
 * What a bot name may be: a GitHub login as GitHub allows it — letters, digits
 * and single hyphens, never at either end, at most 39 characters — lowercased.
 *
 * A seat is held to the same shape, because it is a bot's name until an
 * account connects. That is also what keeps a name safe everywhere it is used:
 * a Docker container and network, a secret file, a directory, a tmux session
 * (which cannot hold `:` or `.`), and the local driver's `fleetadlc__<bot>__`
 * prefix, whose double underscore no name can contain.
 */
export const BOT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

export function isBotName(value: string): boolean {
  return BOT_NAME_PATTERN.test(value);
}

/**
 * Whether a person's name is a GitHub login at all, in any case. What is
 * not — `jane doe`, `jane, bob`, `@jane` — was written into AGENTS.md and
 * CODEOWNERS as it was typed, which broke CODEOWNERS or named a second person.
 */
export function isGitHubLogin(value: string): boolean {
  return BOT_NAME_PATTERN.test(value.toLowerCase());
}

/**
 * The name a bot takes once an account connects: that account's login, as
 * GitHub would match it. GitHub answers with the canonical casing
 * (`FleetADLC-Atlas`), and treats every casing as the same account, so the name is
 * the one spelling that does not depend on which answer came back.
 */
export function nameForLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * The persona names earlier installs gave the crew, and the seat each one was.
 *
 * Read by the migration that gave every existing row its seat; a restore from
 * an archive written before seats existed (`packages/backup/src/plan.ts`); an
 * old `config/bots.yaml` (`seatFromName` in `config.ts`); `resolveBotRef`,
 * which falls back to a persona for any reference unless told not to — a
 * `config/review.yaml` seat, `--bot`, and `automationBotName: flow`, which
 * every `install.json` written by `fleet init` holds and which reaches the
 * bridge as `FLEETADLC_AUTOMATION_BOT`; and the console's account-name hints
 * (`github-accounts-step.tsx`).
 */
export const PERSONA_SEATS: Readonly<Record<string, string>> = {
  mira: 'intake',
  nova: 'system-engineer',
  atlas: 'builder',
  sydney: 'lead-reviewer',
  grok: 'second-reviewer',
  cipher: 'security-reviewer',
  harbor: 'sre',
  vega: 'qa',
  flow: 'automation',
};

/**
 * The seat a persona name was, or null. Extra builders were `atlas-2`,
 * `atlas-3`; they are `builder-2`, `builder-3`.
 */
export function seatForPersona(name: string): string | null {
  const seat = PERSONA_SEATS[name];
  if (seat) return seat;
  const extra = /^atlas-(\d+)$/.exec(name);
  return extra ? `builder-${extra[1]}` : null;
}

/** What a reference can be matched against. */
export interface NamedSeat {
  name: string;
  slot: string;
}

/**
 * Which bot a reference means.
 *
 * Configuration names seats, because a seat is what a person writes down and
 * a name moves when an account connects: `config/review.yaml` says the lead
 * reviewer is `lead-reviewer`, not whoever that is this week. A caller may also
 * pass a name it read from the crew. So the name is tried first, then the
 * seat, and — unless the caller asks for exact matches — the seat a persona
 * name used to be, for configuration written before seats existed.
 *
 * A name can never be another bot's seat (renaming refuses that), so the three
 * cannot point at two different bots.
 */
export function resolveBotRef<T extends NamedSeat>(
  crew: readonly T[],
  ref: string | null | undefined,
  options: { persona?: boolean } = {},
): T | null {
  const wanted = (ref ?? '').trim();
  if (!wanted) return null;
  const byName = crew.find((bot) => bot.name === wanted);
  if (byName) return byName;
  const bySlot = crew.find((bot) => bot.slot === wanted);
  if (bySlot) return bySlot;
  if (options.persona === false) return null;
  const seat = seatForPersona(wanted);
  return seat ? (crew.find((bot) => bot.slot === seat) ?? null) : null;
}

/**
 * The bot whose account writes labels, assignments, reviewer requests and the
 * review-gate status.
 *
 * The one whose role is `automation`. An install may name another — a seat or
 * a name, in the console's settings or `FLEETADLC_AUTOMATION_BOT` — and that wins
 * when it names a bot this install has. One that names nobody is ignored
 * rather than obeyed: `flow` was the default written into every install, and
 * an override pointing at a bot that no longer exists would silence every
 * label the platform writes.
 */
export function automationBotOf<T extends NamedSeat & { role: BotRole }>(
  crew: readonly T[],
  override?: string | null,
): T | null {
  return resolveBotRef(crew, override) ?? crew.find((bot) => bot.role === 'automation') ?? null;
}

/**
 * The bot a repository's work belongs to: its builder.
 *
 * A repository's owner is the bot the dispatcher hands its building to — it,
 * and every other bot with its role, make the pool a task is leased from. So
 * it is the bot in the `builder` seat, or else the first other bot whose role
 * is `implement`. The walkthrough used to make the automation account the
 * owner, as the one bot every install is sure to have, and the dispatcher then
 * handed implementation to an account that thinks with no model.
 */
export function builderOf<T extends NamedSeat & { role: BotRole }>(crew: readonly T[]): T | null {
  const builders = crew
    .filter((bot) => bot.role === 'implement')
    .sort((a, b) => a.slot.localeCompare(b.slot, 'en', { numeric: true }));
  return builders.find((bot) => bot.slot === 'builder') ?? builders[0] ?? null;
}

/**
 * The seat to add for one more bot like this one: `builder` → `builder-2`,
 * then `builder-3`. The first number not already taken, so a gap left by a
 * retired seat is filled rather than skipped.
 */
export function nextSeat(slot: string, taken: readonly string[]): string {
  const base = slot.replace(/-\d+$/, '');
  const used = new Set(taken);
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * The roles a running install may add seats of from settings.
 *
 * Only the builder's. A repository's work is staffed from every bot with its
 * owner's role (`builderPool` in the dispatcher), so a second builder is a
 * second task at once. Every other seat is found by name — the review
 * configuration names `lead-reviewer`, intake is whichever bot has the role —
 * so a second one of those would sit idle, or split work nothing expects to be
 * split.
 */
export const ADDABLE_SEAT_ROLES: readonly BotRole[] = ['implement'];

export function canAddSeatOf(role: string): role is BotRole {
  return (ADDABLE_SEAT_ROLES as readonly string[]).includes(role);
}
