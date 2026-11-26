/**
 * What the health checks say about a builder, as far as handing it a build.
 *
 * The bridge proves, by their effect, the things a person had to do — and two
 * of them decide whether a build can land at all. A bot GitHub will not let
 * sign in cannot push. A bot whose signing key its account does not know
 * pushes commits GitHub marks Unverified, which a repository that requires
 * signed commits refuses: the builder then fails at its commit, holds the
 * issue for the length of its lease, and the work waits on a person nobody
 * told. So such a builder is passed over, and the decision says why.
 *
 * The bridge also refuses to start a build while the bot is not in the
 * repository or hostd is not answering (`blockersOf`, in
 * apps/bridge/src/health/checks/crew.ts: keep the two in step). A lease taken
 * then was refused and released, every pass, for every issue in the
 * repository; so those hold a builder back here too.
 *
 * And a builder whose model account is at its usage or spend limit is passed
 * over: every build leased to it would end held on the limit (ADR 0096).
 * Seats on other accounts go on as they were.
 */

/** Just the columns of a health row this reads; `HealthRow` from `@openadlc/db` has them. */
export interface HealthFacts {
  id: string;
  state: string;
  facts: Record<string, unknown>;
  /** What the board's card tells a person to do, when the row says. */
  detail?: string | null;
}

/**
 * What a `model-limit` row's kind is called. Kept in step with
 * `limitInWords` in apps/bridge/src/health/checks/model-limit.ts, which the
 * dispatcher, a package of its own, cannot import.
 */
const LIMIT_WORDS: Record<string, string> = { spend: 'spend limit', weekly: 'weekly limit', session: 'usage limit', credit: 'credit limit', quota: 'quota' };

/**
 * Why a builder whose model account is at its usage limit is passed over, or
 * null when it is not: the `model-limit:<accountId>` row the bridge raised
 * when a task on the account ended on the limit (ADR 0096).
 */
export function limitHold(builder: { name: string; modelAccountId?: string | null }, checks: readonly HealthFacts[]): string | null {
  if (!builder.modelAccountId) return null;
  const row = checks.find((one) => one.id === `model-limit:${builder.modelAccountId}` && one.state === 'failing');
  if (!row) return null;
  const account = typeof row.facts.accountName === 'string' ? row.facts.accountName : 'its model account';
  const kind = LIMIT_WORDS[String(row.facts.kind)] ?? 'usage limit';
  const at = typeof row.facts.resetsAt === 'string' ? new Date(row.facts.resetsAt) : null;
  const resets = at && Number.isFinite(at.getTime()) ? ` (it says it resets ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC)` : '';
  return `${builder.name} thinks with ${account}, which is at its ${kind}${resets}; nothing is leased to it until it works again`;
}

/** Where a person reconnects a bot, as the board's card for it says. */
const RECONNECT = 'reconnect it from Settings → GitHub → Connected accounts';

export function holdFor(
  builder: { id: string; name: string; modelAccountId?: string | null },
  repo: string,
  checks: readonly HealthFacts[],
  options: { scripted?: boolean } = {},
): string | null {
  // Before the scripted return: the limit comes from the engine's own output,
  // not from GitHub, and a build leased to a seat on a held account only ends
  // held again.
  const limited = limitHold(builder, checks);
  if (limited) return limited;
  // Scripted engines fabricate the work and push nothing to GitHub, so what
  // GitHub would refuse decides nothing — and the integration suites, which
  // run them with no GitHub account behind any bot, could lease nothing.
  if (options.scripted) return null;
  const row = (check: string) => checks.find((one) => one.id === `${check}:${builder.id}`);
  const said = (one: HealthFacts, otherwise: string) => (one.detail ?? '').trim().replace(/\.$/, '') || otherwise;

  // Install-wide: no build starts anywhere while hostd is not answering.
  const host = checks.find((one) => one.id === 'hostd');
  if (host?.state === 'failing') {
    return `OpenADLC’s host service is not answering, so no build can start; nothing is leased until it answers — ${said(host, 'start OpenADLC again on the machine it runs on')}`;
  }

  const signIn = row('bot-sign-in');
  if (signIn?.state === 'failing') {
    return `${builder.name} cannot sign in to GitHub, so it could not push; nothing is leased to it until it can — ${RECONNECT}`;
  }

  const access = checks.find((one) => one.id === `bot-access:${builder.id}:${repo}`);
  if (access?.state === 'failing') {
    return `${builder.name} cannot work in ${repo}, so the bridge would refuse its build; nothing is leased to it there until it can — ${said(access, 'let the crew in again from the walkthrough')}`;
  }

  const key = row('signing-key');
  const requires = (key?.facts.requiresSignatures ?? {}) as Record<string, unknown>;
  if (key?.state === 'failing' && requires[repo] === true) {
    return (
      `${builder.name}’s signing key is not on its GitHub account and ${repo} requires signed commits, ` +
      `so GitHub would refuse its commits; nothing is leased to it until it is — ${RECONNECT}`
    );
  }
  return null;
}
