'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Copyable } from '@/components/copyable';
import { atStart, botLabel, labelIn, listed, type BotLabel } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { STEP_TITLES } from '../../../../packages/shared/src/onboarding';

interface Bot {
  bot: string;
  slot?: string | null;
  displayName: string;
  role?: string;
  roleLabel?: string;
  /** The account's login once connected; before that, only a suggestion. */
  login: string;
  connected: boolean;
  /** In every repository OpenADLC works in. */
  inRepository: boolean | null;
  /** The same, one repository at a time. Absent from an older bridge. */
  access?: { repository: string; inRepository: boolean | null }[];
  repositoryRole: 'triage' | 'write';
  accessReason: string;
  accountExists: boolean | null;
}

interface CrewAccess {
  bot: string;
  login: string | null;
  state: 'in' | 'invited' | 'no-account' | 'refused';
  /** Whether this run changed it, as opposed to finding it already so. */
  changed: boolean;
  detail: string;
}

/** What `/v1/invitations/accept` answers for each invitation pasted: not a bot's access, an invitation's fate. */
interface AcceptResult {
  bot: string | null;
  invitee: string;
  id: number;
  outcome: { action: 'accepted' | 'none' | 'refused'; detail?: string };
}

/** An invitation that was not one of the crew's to accept, and why. */
export interface Skipped {
  invitee: string;
  detail: string;
}

/**
 * Both routes' answers as the cards read them. The paste path answers each
 * invitation's outcome, which has no `state`: read as access, a bot that got
 * in was "Nothing changed this time", and an expired invitation's reason was
 * never said.
 */
export function readResults(results: readonly (CrewAccess | AcceptResult)[]): { access: CrewAccess[]; skipped: Skipped[] } {
  const access: CrewAccess[] = [];
  const skipped: Skipped[] = [];
  for (const one of results) {
    if (!('outcome' in one)) {
      access.push(one);
      continue;
    }
    const detail = one.outcome.detail ?? '';
    if (one.outcome.action === 'accepted') access.push({ bot: one.bot ?? one.invitee, login: one.invitee, state: 'in', changed: true, detail: '' });
    else if (one.outcome.action === 'refused') access.push({ bot: one.bot ?? one.invitee, login: one.invitee, state: 'refused', changed: false, detail });
    else skipped.push({ invitee: one.invitee, detail });
  }
  return { access, skipped };
}

/** The bridge's own words for a refusal, rather than its JSON. */
async function refusalOf(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Not JSON: say what came back.
  }
  return text.slice(0, 220) || `the bridge answered ${response.status}`;
}

interface Discovery {
  repository: string | null;
  pending: { id: number; invitee: string }[];
  reason: string | null;
  /** What is waiting in each repository. Absent from an older bridge. */
  repositories?: { repository: string; pending: { id: number; invitee: string }[]; reason: string | null }[];
}

/**
 * Getting the crew into the repository.
 *
 * This step showed every bot twice — once in the result of the last invite, once
 * in a standing roster below it — and included bots whose GitHub account had
 * never been created, which this step can do nothing about and which made "0 of
 * 9" the headline number on an install where four were fine.
 *
 * So: one card per bot, and only the bots this step can act on. A bot with no
 * account is not a failure here, it is unfinished business from the step that
 * creates accounts, and it is summarised in one line rather than listed.
 *
 * It is every repository OpenADLC works in, not the first: the button lets the
 * crew into all of them, and with more than one each card says where its bot
 * is in and where it is not yet.
 */
export function Invitations({
  bots,
  repositories = [],
  isOrganization,
  inviteUrl,
  canInvite,
  onChanged,
  onGoToCrew,
}: {
  bots: Bot[];
  /** Every repository OpenADLC works in, as `owner/name`. */
  repositories?: readonly string[];
  isOrganization: boolean | null;
  inviteUrl: string | null;
  /** Whether the app's private key is stored, so OpenADLC can invite for itself. */
  canInvite: boolean;
  onChanged?: () => void;
  /** Somewhere to send a bot that cannot get in until it is connected. */
  onGoToCrew?: (bot: string) => void;
}) {
  const [results, setResults] = useState<Map<string, CrewAccess>>(new Map());
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** What the last run actually did. Null until something has been run. */
  const [ran, setRan] = useState<CrewAccess[] | null>(null);
  /** Invitations in the last paste that were not the crew's to accept. */
  const [skipped, setSkipped] = useState<Skipped[]>([]);

  const find = useCallback(async () => {
    try {
      const response = await fetch('/api/invitations', { cache: 'no-store' });
      if (response.ok) setDiscovery((await response.json()) as Discovery);
    } catch {
      // A nicety. The button does not depend on it.
    }
  }, []);

  useEffect(() => {
    void find();
  }, [find]);

  async function run(body: Record<string, unknown>, path: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await refusalOf(response));
      const body_ = (await response.json()) as { results?: (CrewAccess | AcceptResult)[] };
      if (body_.results) {
        const { access, skipped: notOurs } = readResults(body_.results);
        setResults(new Map(access.map((one) => [one.bot, one])));
        setRan(access);
        setSkipped(notOurs);
      }
      setPasted('');
      await find();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'that did not work');
    } finally {
      setBusy(false);
    }
  }

  // Only bots this step can do something about.
  //
  // A bot that is not connected cannot accept its own invitation, and nothing
  // here can connect it — so it belongs to the step that does, and listing it
  // here made "2 of 4" the headline on an install where both connected bots
  // were fine. It is let in the moment it connects, so it never needs to come
  // back to this page at all.
  const actionable = bots.filter((bot) => bot.connected);
  const unconnected = bots.filter((bot) => !bot.connected && bot.accountExists !== false);
  const missing = bots.filter((bot) => bot.accountExists === false);
  const inside = actionable.filter((bot) => bot.inRepository === true).length;
  const several = repositories.length > 1;
  // Where to run `gh` for what is waiting: each repository, not only the first.
  const targets = discovery?.repositories?.map((one) => one.repository) ?? (discovery?.repository ? [discovery.repository] : []);

  return (
    <div className="space-y-5">
      <p className="max-w-lg text-[13px] leading-relaxed text-muted">
        {isOrganization === true
          ? 'Each account is invited as a collaborator. GitHub adds one that is already a member of the organization directly; any other is invited, and accepts once it is connected.'
          : 'Each account is invited, and accepts its own invitation once it is connected. A connected bot that has not accepted holds a valid token and still cannot see the repository.'}
        {several && ' That is done for each repository OpenADLC works in.'}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={actionable.length > 0 && inside === actionable.length ? 'signal' : 'attention'}>
          {inside} of {actionable.length} in {several ? 'every repository' : 'the repository'}
        </Chip>
        {canInvite ? (
          // No repository named: the bridge lets the crew into every one.
          <Button variant="primary" disabled={busy} onClick={() => void run({}, '/api/invitations/invite')}>
            {busy ? 'working…' : inside === actionable.length ? 'check again' : 'invite them and let them in'}
          </Button>
        ) : (
          inviteUrl && (
            <a href={inviteUrl} target="_blank" rel="noreferrer">
              <Button>{isOrganization ? 'open organization members' : 'open repository access'}</Button>
            </a>
          )
        )}
        {error && <span className="text-[11px] text-attention">{error}</span>}
      </div>

      {ran && (
        <Outcome
          results={ran}
          skipped={skipped}
          waiting={ran.filter((one) => one.state === 'invited')}
          connected={(name) => bots.some((bot) => bot.bot === name && bot.connected)}
          several={several}
          labelOf={(name) => labelIn(bots, name)}
          onGoToCrew={onGoToCrew}
        />
      )}

      <div className="grid gap-2.5 sm:grid-cols-2">
        {actionable.map((bot) => {
          const result = results.get(bot.bot);
          const isIn = bot.inRepository === true || result?.state === 'in';
          const invited = result?.state === 'invited' || discovery?.pending.some((one) => one.invitee === bot.login);
          const refused = result?.state === 'refused';
          const label = botLabel(bot);

          return (
            <div
              key={bot.bot}
              className={cn(
                'rounded-md border p-3',
                isIn ? 'border-signal/40 bg-signal/5' : refused ? 'border-attention/40 bg-attention/5' : 'border-edge bg-panel',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] font-medium text-body">{label.name}</span>
                {label.handle && label.role && <span className="text-[11px] text-dim">{label.role}</span>}
                <Chip tone={bot.repositoryRole === 'write' ? 'link' : 'neutral'}>{bot.repositoryRole}</Chip>
                <span className="ml-auto">
                  {isIn ? (
                    <Chip tone="signal">in</Chip>
                  ) : invited ? (
                    <Chip tone="attention">invited</Chip>
                  ) : refused ? (
                    <Chip tone="attention">refused</Chip>
                  ) : (
                    <Chip>not yet</Chip>
                  )}
                </span>
              </div>

              {several && bot.access && (
                <ul aria-label={`Where ${label.said} is in`} className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                  {bot.access.map((one) => (
                    <li key={one.repository} className={one.inRepository ? 'text-signal' : 'text-muted'}>
                      {one.repository}: {one.inRepository === true ? 'in' : one.inRepository === false ? 'not yet' : 'unknown'}
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-1.5 text-[11px] leading-relaxed text-dim">
                {isIn
                  ? bot.accessReason
                  : refused
                    ? result.detail
                    : invited
                      ? bot.connected
                        ? // Connected and invited, and still outside: only the
                          // invitee can accept, and it does that when this step
                          // is run — not on its own. Without the app's key
                          // there is no button: it is the paste below. A run
                          // that tried and could not accept says why.
                          result?.state === 'invited' && result.detail
                          ? result.detail
                          : canInvite
                          ? 'invited, and connected. Press the button to let it in.'
                          : 'invited, and connected. Paste what gh prints below to let it in.'
                        : `invited. ${atStart(label.said)} accepts it once it is connected \u2014 that is the previous step.`
                      : bot.accessReason}
              </p>
            </div>
          );
        })}
      </div>

      {actionable.length === 0 && (
        <p className="max-w-lg text-[12.5px] leading-relaxed text-muted">
          Nothing to do here yet — no bot is connected. Each one is let into the repository the moment it connects,
          so this step usually takes care of itself.
        </p>
      )}

      {(unconnected.length > 0 || missing.length > 0) && (
        <div className="max-w-lg space-y-1.5 text-[11.5px] leading-relaxed text-muted">
          {unconnected.length > 0 && (
            <p>
              {atStart(listed(unconnected.map((bot) => botLabel(bot).said)))}{' '}
              {unconnected.length === 1 ? 'is not connected' : 'are not connected'} yet.{' '}
              {unconnected.length === 1 ? 'It is' : 'They are'} let in automatically on connecting, in{' '}
              <span className="text-soft">{STEP_TITLES.crew}</span>.
            </p>
          )}
          {missing.length > 0 && (
            <p>
              {atStart(listed(missing.map((bot) => botLabel(bot).said)))} {missing.length === 1 ? 'has' : 'have'} no
              GitHub account yet. The pipeline runs without them.
            </p>
          )}
        </div>
      )}

      {!canInvite && (
        <details className="max-w-md rounded-md border border-edge bg-panel/40 p-3">
          <summary className="cursor-pointer text-[12px] text-soft">accept invitations you sent by hand</summary>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
            OpenADLC has no private key for the app, so it cannot invite anybody itself. Run this where you are signed in
            to GitHub and paste what it prints:
          </p>
          <div className="mt-2 space-y-1.5">
            {(targets.length > 0 ? targets : ['OWNER/REPO']).map((target) => (
              <Copyable key={target} value={`gh api repos/${target}/invitations --paginate`} />
            ))}
          </div>
          <textarea
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            rows={4}
            placeholder="paste the JSON here"
            className="mt-2 w-full rounded-md border border-edge-strong bg-surface px-3 py-2 font-mono text-[11.5px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link"
          />
          <div className="mt-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || pasted.trim().length === 0}
              onClick={() => void run({ json: pasted, repo: discovery?.repository }, '/api/invitations')}
            >
              accept what is in there
            </Button>
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * What pressing the button actually did.
 *
 * Without it, a run that invited two bots and got neither of them in looked
 * identical to a run that failed silently — the cards said the same thing before
 * and after, and the only honest reading was "nothing happened". The counts are
 * of the run, not of the world, so "nothing changed" is itself an answer.
 */
function Outcome({
  results,
  skipped = [],
  waiting: invited,
  connected = () => false,
  several = false,
  labelOf,
  onGoToCrew,
}: {
  results: CrewAccess[];
  /** Invitations pasted that were not the crew's to accept. */
  skipped?: readonly Skipped[];
  waiting: CrewAccess[];
  /**
   * Whether a bot is connected. The bridge says `invited` whenever accepting
   * did not succeed, a connected bot's failed acceptance included, so only a
   * bot that is not connected is told to connect.
   */
  connected?: (bot: string) => boolean;
  /** Whether it was run over more than one repository. */
  several?: boolean;
  /** A bot the bridge answered about by name, as a person reads it. */
  labelOf: (name: string) => BotLabel;
  onGoToCrew?: (bot: string) => void;
}) {
  const accepted = results.filter((one) => one.state === 'in' && one.changed).length;
  const already = results.filter((one) => one.state === 'in' && !one.changed).length;
  const refused = results.filter((one) => one.state === 'refused');
  const waiting = invited.filter((one) => !connected(one.bot));
  const notAccepted = invited.filter((one) => connected(one.bot));

  return (
    <div className="rounded-md border border-edge bg-panel/40 p-3">
      <p className="text-[12.5px] text-body">
        {accepted > 0
          ? `${accepted} ${accepted === 1 ? 'bot is' : 'bots are'} now in ${several ? 'the repositories' : 'the repository'}.`
          : 'Nothing changed this time.'}
      </p>

      <ul className="mt-1.5 space-y-1 text-[11.5px] leading-relaxed text-muted">
        {already > 0 && <li>{already} {already === 1 ? 'was' : 'were'} already in.</li>}
        {waiting.length > 0 && (
          <li>
            {atStart(listed(waiting.map((one) => labelOf(one.bot).said)))} {waiting.length === 1 ? 'is' : 'are'}{' '}
            invited but not connected, so{' '}
            {waiting.length === 1 ? 'it' : 'they'} cannot accept yet — only the invited account can accept its own
            invitation.
          </li>
        )}
        {[...notAccepted, ...refused].map((one) => (
          <li key={one.bot} className="text-attention">
            {labelOf(one.bot).name}: {one.detail || 'invited, and its invitation could not be accepted'}
          </li>
        ))}
        {skipped.map((one) => (
          <li key={`${one.invitee}:${one.detail}`}>
            {one.invitee}: {one.detail}
          </li>
        ))}
      </ul>

      {waiting.length > 0 && onGoToCrew && waiting[0] && (
        <div className="mt-2.5">
          {/* Straight to the bot that is blocked, not just to the step. */}
          <Button size="sm" variant="primary" onClick={() => onGoToCrew(waiting[0]!.bot)}>
            connect {labelOf(waiting[0].bot).said}
          </Button>
        </div>
      )}
    </div>
  );
}
