'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { couldNotAsk, useGitHubLookup } from '@/components/github-lookup';
import { cn } from '@/lib/cn';
import { isGitHubLogin } from '../../../../packages/shared/src/seats';

/**
 * The last step, as a list of what will change rather than two commands.
 *
 * It ended the walkthrough by asking somebody to paste `fleetadlc github sync-labels`
 * and `fleetadlc github apply` into a shell, because both act on the repository and
 * should not happen without being asked for. The first half of that is right and
 * is kept — nothing here runs on its own, and each half is agreed to separately.
 * The second half was a mistake: a terminal is not what consent requires. Seeing
 * the change is.
 *
 * So both are still explicit, and now both are also visible beforehand.
 *
 * Visible beforehand then became the problem. Every repository printed every
 * one of its labels, its rules, its templates and the same paragraph about
 * GitHub's plans, one after another — a wall, and a wall somebody had to click
 * through twice per repository. What they are agreeing to is the same for every
 * repository, so it is said once at the top in plain words, one button does it
 * everywhere, and the per-repository listing is still there, folded, for anybody
 * who wants to read it before they press.
 */

interface LabelChange {
  name: string;
  action: 'create' | 'update' | 'unchanged';
  detail: string;
}

interface RuleReport {
  name: string;
  state: 'present' | 'drifted' | 'missing' | 'unsupported';
  detail: string;
}

interface ApplyOutcome {
  name: string;
  /** `unsupported`: GitHub's plan will not hold it — a fact about the plan, never something to attend to. */
  action: 'created' | 'updated' | 'unchanged' | 'skipped' | 'unsupported';
  detail: string;
}

export interface RepoPlan {
  repository: string;
  labels: LabelChange[];
  rules: RuleReport[];
  templates: RuleReport[];
  labelChanges: number;
  ruleChanges: number;
  canApply: boolean;
  detail: string;
  /** Who AGENTS.md names as approving its human-review paths. */
  approvers?: string[];
  /** Nobody known to name there: the step asks. */
  needsApprovers?: boolean;
  /** How production ships, as the bridge reads it; absent from an older bridge. */
  production?: ProductionPlan;
  /** Production's rules say a person approves and nobody can be named: nothing is applied until somebody is. */
  needsProductionReviewer?: boolean;
}

export interface ProductionPlan {
  approval: 'reviewers' | 'auto';
  soakMinutes: number;
  /** Who would be named as production's reviewers, by GitHub login. */
  reviewers: string[];
  /** `.github/fleetadlc.yml` sets the approval itself, so only an edit of the file changes it. */
  governedByFile: boolean;
}

/** What a person chose for a repository's production, as the bridge records it. */
export interface ProductionChoice {
  approval: 'reviewers' | 'auto';
  soakMinutes: number;
  reviewers: string[];
}

/** One line in the list somebody is agreeing to. */
function Change({ mark, name, detail }: { mark: string; name: string; detail?: string }) {
  return (
    <li className="flex gap-2 text-[12.5px] leading-relaxed">
      <span
        className={cn(
          'w-4 shrink-0 text-center font-mono',
          mark === '+' && 'text-signal',
          mark === '~' && 'text-attention',
          mark === '·' && 'text-dim',
          mark === '—' && 'text-dim',
        )}
      >
        {mark}
      </span>
      <span className={cn('font-mono text-[12px]', mark === '·' || mark === '—' ? 'text-dim' : 'text-body')}>
        {name}
      </span>
      {detail && <span className="text-[11.5px] text-muted">{detail}</span>}
    </li>
  );
}

/** How many lines are worth showing before the list becomes a wall. */
const PREVIEW_LINES = 6;

/**
 * A group showing enough of itself to be understood at a glance.
 *
 * Showing everything was the first attempt, and on a fresh repository that is
 * dozens of labels before the rules section is even on screen — the wall this
 * walkthrough exists to avoid. Showing nothing is worse: the whole point is that
 * you see what you are agreeing to. So it shows the shape and offers the rest.
 */
function Section({
  title,
  changes,
  settled,
  items,
  action,
}: {
  title: string;
  changes: number;
  settled: string;
  items: React.ReactNode[];
  /** Only when there is something to do: a disabled "nothing to write" read as a step not taken. */
  action?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, items.length - PREVIEW_LINES);
  const shown = expanded ? items : items.slice(0, PREVIEW_LINES);

  return (
    <section className="rounded-lg border border-edge bg-surface p-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium text-body">{title}</h3>
        <span className="text-[11.5px] text-muted">{changes === 0 ? settled : `${changes} to change`}</span>
      </div>

      <ul className="mt-2.5 space-y-1">{shown}</ul>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((was) => !was)}
          className="mt-1.5 text-[11.5px] text-link hover:underline"
        >
          {expanded ? 'show fewer' : `and ${hidden} more`}
        </button>
      )}

      {action && <div className="mt-3">{action}</div>}
    </section>
  );
}

/** Where one repository is in a run of the button, or what came of it. */
export type RepoRun =
  | { state: 'running' }
  | { state: 'ok'; written: number }
  | { state: 'attention'; written: number; reasons: string[] };

/**
 * Something GitHub will not hold, said once however many repositories it
 * applies to.
 *
 * These are facts about a plan — a private repository on the free plan has no
 * environment protection, whoever asks — so the same sentence came back under
 * every repository and every environment: eighteen lines on nine repositories.
 * Grouped by what it says, with every rule it says it of, and the repositories
 * counted rather than listed; the list is behind an expand.
 */
export interface SharedLimit {
  names: string[];
  detail: string;
  repositories: string[];
}

/**
 * What tells two limits apart: the sentence and the rules it is said of. The
 * same sentence comes back in a mixed install, so it alone is not a key.
 */
export function limitKey(limit: Pick<SharedLimit, 'names' | 'detail'>): string {
  return `${limit.detail}\u0000${[...limit.names].sort().join('\u0000')}`;
}

export function sharedLimits(plans: RepoPlan[]): SharedLimit[] {
  // By the sentence and by which rules a repository says it of: grouping by
  // the sentence alone said a rule was unavailable on a repository where only
  // another one was — a GitHub Pro repository counted with free-plan ones.
  const byKey = new Map<string, SharedLimit>();
  for (const plan of plans) {
    const mine = new Map<string, string[]>();
    for (const report of [...plan.rules, ...plan.templates]) {
      if (report.state !== 'unsupported') continue;
      mine.set(report.detail, [...(mine.get(report.detail) ?? []), report.name]);
    }
    for (const [detail, names] of mine) {
      const key = limitKey({ names, detail });
      const found = byKey.get(key);
      if (found) found.repositories.push(plan.repository);
      else byKey.set(key, { names, detail, repositories: [plan.repository] });
    }
  }
  return [...byKey.values()];
}

/** Whether GitHub's plan refused a repository's environments, so "Apply again" has something to ask. */
function planLimited(plan: RepoPlan): boolean {
  return plan.rules.some((report) => report.state === 'unsupported' && report.name.startsWith('environment '));
}

/** How much of a repository a click would change. */
function pending(plan: RepoPlan): number {
  return plan.labelChanges + plan.ruleChanges;
}

/**
 * Whether the step is done: a repository to protect, and nothing left to
 * change in any of them. What GitHub's plan will not hold is not left to
 * change — no click makes it so. The walkthrough used to count this step done
 * never, and offered "skip for now" under a repository already set up.
 */
export function repositoriesReady(plans: readonly RepoPlan[]): boolean {
  return plans.length > 0 && plans.every((plan) => plan.canApply && pending(plan) === 0 && !plan.needsApprovers && !plan.needsProductionReviewer);
}

/** The logins typed into a field, as the bridge takes them: comma- or space-separated, `@` or not. */
export function loginsIn(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((one) => one.trim().replace(/^@/, '')).filter(Boolean))];
}

/**
 * How a repository's production ships, asked for each one: automatically
 * after testing (a soak, the smoke, and an automatic rollback), which is
 * chosen unless the repository already ships another way, or after a named
 * person approves. That choice cannot be saved without a login: production
 * written for nobody is a promote that runs unseen. Where the repository's
 * own `.github/fleetadlc.yml` says it, the file governs, and this says so.
 */
export function ProductionShips({
  plan,
  onSave,
}: {
  plan: RepoPlan;
  onSave?: (choice: ProductionChoice) => Promise<void>;
}) {
  const production = plan.production;
  const [approval, setApproval] = useState<'reviewers' | 'auto'>(production?.approval ?? 'auto');
  const [soak, setSoak] = useState(String(production && production.approval === 'auto' ? production.soakMinutes : 30));
  const [logins, setLogins] = useState(
    (production && production.reviewers.length > 0 ? production.reviewers : (plan.approvers ?? [])).join(', '),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!production) return null;

  const id = plan.repository.replace(/[^a-z0-9]+/gi, '-');
  if (production.governedByFile) {
    return (
      <p className="text-[12px] leading-relaxed text-muted">
        <span className="text-body">How production ships:</span>{' '}
        {production.approval === 'auto'
          ? `automatically after testing, after ${production.soakMinutes} minutes on testing`
          : `after ${production.reviewers.length > 0 ? production.reviewers.map((one) => `@${one}`).join(', ') : 'a person'} approves`}
        . Its <code className="font-mono text-[11.5px]">.github/fleetadlc.yml</code> sets this, and the file governs it: change
        it there.
      </p>
    );
  }

  const named = loginsIn(logins);
  const minutes = Number(soak);
  const soakOk = Number.isInteger(minutes) && minutes >= 0 && minutes <= 43_200;
  const ready = approval === 'reviewers' ? named.length > 0 : soakOk;

  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || !onSave) return;
        setSaving(true);
        setError(null);
        onSave({ approval, soakMinutes: approval === 'auto' ? minutes : 0, reviewers: approval === 'reviewers' ? named : [] })
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'not saved'))
          .finally(() => setSaving(false));
      }}
    >
      <fieldset className="flex flex-col gap-1.5" disabled={saving || !onSave}>
        <legend className="text-[12.5px] font-medium text-body">How production ships</legend>
        <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-body">
          <input type="radio" name={`production-${id}`} value="auto" checked={approval === 'auto'} onChange={() => setApproval('auto')} />
          Automatically after testing
          <span className="flex items-center gap-1 text-muted">
            after
            <input
              aria-label="Minutes on testing before production"
              inputMode="numeric"
              value={soak}
              disabled={approval !== 'auto'}
              onChange={(event) => setSoak(event.target.value)}
              className="h-7 w-14 rounded-md border border-edge-strong bg-surface px-1.5 text-[12px] text-body"
            />
            minutes on testing, the smoke, and a rollback if production fails
          </span>
        </label>
        <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-body">
          <input
            type="radio"
            name={`production-${id}`}
            value="reviewers"
            checked={approval === 'reviewers'}
            onChange={() => setApproval('reviewers')}
          />
          After a person approves
          <input
            aria-label="GitHub logins who approve production"
            value={logins}
            disabled={approval !== 'reviewers'}
            onChange={(event) => setLogins(event.target.value)}
            placeholder="github-username"
            autoComplete="off"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded-md border border-edge-strong bg-surface px-2 font-mono text-[12px] text-body"
          />
        </label>
      </fieldset>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!ready || saving || !onSave}>
          {saving ? 'saving…' : 'Save'}
        </Button>
        {approval === 'reviewers' && named.length === 0 && (
          <span className="text-[11.5px] text-muted">name at least one person who approves production</span>
        )}
        {error && <span className="text-[11.5px] text-alarm">{error}</span>}
      </div>
    </form>
  );
}

/**
 * Who approves the paths a person has to: asked only when OpenADLC cannot
 * tell. The app cannot see an organization's owners, and AGENTS.md was
 * committed with the template's `@owner` in it — which the first page of a
 * new install then showed as a blocking card.
 *
 * Checked on GitHub while it is typed, the way the owner step is: a typo here
 * names a reviewer nobody can be, and every change to those paths waits on
 * them. Only a person: an organization cannot approve a pull request.
 *
 * The answer is the install's `humans`, and it replaces it: the people who
 * answer gates from GitHub, approve plan changes, and are production's
 * required reviewers, in every repository the install works in. The hint says
 * so, or naming somebody to review one repository's infra gave them all that
 * everywhere without a word.
 */
function Approvers({ onSave }: { onSave: (logins: string) => Promise<void> }) {
  const [people, setPeople] = useState<{ login: string; avatarUrl: string; checked: boolean }[]>([]);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { lookup, looking } = useGitHubLookup(value);

  const term = value.trim().replace(/^@/, '');
  const found = !looking && lookup?.exact?.login.toLowerCase() === term.toLowerCase() ? lookup.exact : null;
  const person = found?.type === 'User' ? found : null;
  // GitHub would not say: taken as typed, and said to be unchecked — but only
  // a login, never "jane doe" or "jane, bob", which went into AGENTS.md and
  // CODEOWNERS as typed.
  const unchecked = !looking && couldNotAsk(lookup) && !found && isGitHubLogin(term);
  const has = (login: string) => people.some((one) => one.login.toLowerCase() === login.toLowerCase());

  const add = (login: string, avatarUrl: string, checked: boolean): void => {
    if (!has(login)) setPeople((was) => [...was, { login, avatarUrl, checked }]);
    setValue('');
  };
  const addTyped = (): void => {
    if (person) add(person.login, person.avatarUrl, true);
    else if (unchecked) add(term, '', false);
  };
  // What Save would name: the people added, and the one typed if it is a person.
  const named = [...people.map((one) => one.login), ...(person && !has(person.login) ? [person.login] : [])];

  return (
    <form
      className="rounded-lg border border-edge-strong bg-panel px-3.5 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (named.length === 0) return;
        setSaving(true);
        setError(null);
        onSave(named.join(','))
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'not saved'))
          .finally(() => setSaving(false));
      }}
    >
      <label htmlFor="approvers" className="text-[13px] font-medium text-body">
        Who approves changes to <code className="font-mono text-[12px]">config/</code>,{' '}
        <code className="font-mono text-[12px]">infra/</code> and <code className="font-mono text-[12px]">.github/</code>?
      </label>
      <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
        Your GitHub username, usually — add more than one if you like. The crew can’t merge a change to those paths
        without one of them. The people named here also answer the crew’s questions and gates, approve plan changes and
        are the required reviewers for production deploys, in every repository OpenADLC works in on this install.
      </p>

      {people.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {people.map((one) => (
            <li
              key={one.login}
              className="flex items-center gap-1.5 rounded-full border border-edge-strong bg-surface py-0.5 pl-1 pr-1.5 text-[12px] text-body"
            >
              {one.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={one.avatarUrl} alt="" className="size-4 rounded-full" />
              ) : null}
              <span className="font-mono">{one.login}</span>
              {!one.checked && <span className="text-[10.5px] text-dim">unchecked</span>}
              <button
                type="button"
                aria-label={`Remove ${one.login}`}
                onClick={() => setPeople((was) => was.filter((other) => other.login !== one.login))}
                className="text-dim hover:text-body"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex items-center gap-2">
        <input
          id="approvers"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the person typed once someone is listed; with nobody
            // listed yet it submits, saving the typed person as Save would.
            if (event.key === 'Enter' && (person || unchecked) && people.length > 0) {
              event.preventDefault();
              addTyped();
            }
          }}
          placeholder={people.length > 0 ? 'add another' : 'your-github-username'}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          className="h-8 min-w-0 flex-1 rounded-md border border-edge-strong bg-surface px-2.5 font-mono text-[12.5px] text-body"
        />
        <Button type="submit" size="sm" variant="primary" disabled={named.length === 0 || saving || looking}>
          {saving ? 'saving…' : 'Save'}
        </Button>
      </div>

      <div className="mt-1.5 min-h-[1.25rem] text-[11.5px]">
        {looking && term.length >= 2 && <p className="text-dim">looking on GitHub…</p>}

        {person && (
          <div className="flex items-center gap-2">
            {person.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={person.avatarUrl} alt="" className="size-5 rounded-full" />
            )}
            <a href={person.htmlUrl} target="_blank" rel="noreferrer" className="text-[12.5px] text-body hover:underline">
              {person.login}
            </a>
            <Chip tone="signal">✓ on GitHub</Chip>
            {!has(person.login) && (
              <button type="button" onClick={addTyped} className="text-link hover:underline">
                add another person
              </button>
            )}
          </div>
        )}

        {found?.type === 'Organization' && (
          <p className="text-attention">
            {found.login} is an organization, and only a person can approve a pull request. Name someone in it.
          </p>
        )}

        {!looking && lookup && !found && lookup.suggestions.some((one) => one.type === 'User') && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-dim">no exact match — did you mean:</span>
            {lookup.suggestions
              .filter((one) => one.type === 'User')
              .map((one) => (
                <button
                  key={one.login}
                  type="button"
                  onClick={() => setValue(one.login)}
                  className="rounded-md border border-edge-strong px-1.5 py-0.5 text-soft hover:text-body"
                >
                  {one.login}
                </button>
              ))}
          </div>
        )}

        {!looking && lookup && !found && !couldNotAsk(lookup) && !lookup.suggestions.some((one) => one.type === 'User') && (
          <p className="text-attention">nobody on GitHub is called “{term}”</p>
        )}

        {!looking && couldNotAsk(lookup) && !found && term.length > 0 && !isGitHubLogin(term) && (
          <p className="text-attention">“{term}” is not a GitHub username: letters, digits and single hyphens</p>
        )}

        {unchecked && (
          <p className="text-dim">
            {lookup?.rateLimited ? 'GitHub is rate-limiting the check.' : 'GitHub did not answer the check.'}{' '}
            <button type="button" onClick={addTyped} className="text-link hover:underline">
              add “{term}” unchecked
            </button>
          </p>
        )}
      </div>

      {error && <p className="mt-1 text-[11.5px] text-attention">{error}</p>}
    </form>
  );
}

/** The bridge says why it refused as `{ error }`; anything else is shown as it came. */
function refusal(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Not JSON, so the text is the reason.
  }
  return text.slice(0, 300) || `the bridge answered ${status}`;
}

/** Records how a repository's production ships (`POST /v1/repo-setup/production`). */
export async function saveProduction(repo: string, choice: ProductionChoice): Promise<void> {
  const response = await fetch('/api/repo-setup?what=production', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo, ...choice }),
  });
  if (!response.ok) throw new Error(refusal(await response.text(), response.status));
}

/** Saves who approves (`humans`). Throws with the bridge's own reason, not the JSON it came in. */
export async function saveApprovers(logins: string): Promise<void> {
  const response = await fetch('/api/install', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ humans: logins }),
  });
  if (!response.ok) throw new Error(refusal(await response.text(), response.status));
}

/** One half of the doing, for one repository. Throws with the bridge's own reason. */
async function post(
  repo: string,
  what: 'labels' | 'rules',
  options: { force?: boolean } = {},
): Promise<{ changes?: LabelChange[]; outcomes?: ApplyOutcome[] }> {
  const response = await fetch(`/api/repo-setup?what=${what}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options.force ? { repo, force: true } : { repo }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(refusal(text, response.status));
  return JSON.parse(text) as { changes?: LabelChange[]; outcomes?: ApplyOutcome[] };
}

/** The rules half for one repository, as its row's buttons ask; `force` is "Apply again". */
export function applyRules(repo: string, options: { force?: boolean } = {}): Promise<{ outcomes?: ApplyOutcome[] }> {
  return post(repo, 'rules', options);
}

/**
 * Both halves for one repository, and a verdict a person can read in a line.
 *
 * "Needs attention" means something OpenADLC meant to do did not happen: a label
 * GitHub refused, a request the bridge turned down, an outcome skipped for a
 * reason nobody was told about beforehand. A skip that is one of the plan
 * limits already said at the top is not news, so it does not count against the
 * repository a second time.
 */
export async function setUpRepository(plan: RepoPlan): Promise<RepoRun> {
  const expected = new Set(
    [...plan.rules, ...plan.templates].filter((report) => report.state === 'unsupported').map((report) => report.name),
  );
  const reasons: string[] = [];
  let written = 0;

  if (plan.labelChanges > 0) {
    try {
      const changes = (await post(plan.repository, 'labels')).changes ?? [];
      for (const change of changes) {
        if (change.detail.startsWith('failed:')) reasons.push(`label ${change.name} — ${change.detail}`);
        else if (change.action !== 'unchanged') written += 1;
      }
    } catch (cause) {
      reasons.push(`labels — ${cause instanceof Error ? cause.message : 'not written'}`);
    }
  }

  if (plan.ruleChanges > 0) {
    try {
      const outcomes = (await post(plan.repository, 'rules')).outcomes ?? [];
      for (const outcome of outcomes) {
        if (outcome.action === 'created' || outcome.action === 'updated') written += 1;
        // The plan's limit is said once at the top, never counted against a
        // repository — whether or not the plan knew of it beforehand.
        else if (outcome.action === 'skipped' && !expected.has(outcome.name)) {
          reasons.push(`${outcome.name} — ${outcome.detail}`);
        }
      }
    } catch (cause) {
      reasons.push(`protection — ${cause instanceof Error ? cause.message : 'not applied'}`);
    }
  }

  return reasons.length === 0 ? { state: 'ok', written } : { state: 'attention', written, reasons };
}

/**
 * What one half's answer did, counted as `setUpRepository` counts it: a label
 * is written when it was created or updated without failing, a rule when it
 * was created or updated. A refused ruleset is `skipped`, and a label GitHub
 * refused says `failed:`. The plan's limit (`unsupported`) is neither: it is
 * said once at the top. This counted every outcome but `unchanged` as
 * written, so a refused ruleset read "1 written · 0 refused".
 */
export function outcomeCounts(outcomes: readonly (ApplyOutcome | LabelChange)[]): { written: number; refused: number } {
  let written = 0;
  let refused = 0;
  for (const one of outcomes) {
    if (one.detail.startsWith('failed:') || one.action === 'skipped') refused += 1;
    else if (one.action === 'created' || one.action === 'updated' || one.action === 'create' || one.action === 'update') written += 1;
  }
  return { written, refused };
}

/** The end of a repository's row: where it stands, before the button or after it. */
function Status({ plan, run }: { plan: RepoPlan; run?: RepoRun }) {
  if (run?.state === 'running') return <Chip tone="link">setting up…</Chip>;
  if (run?.state === 'attention') return <Chip tone="attention">needs attention</Chip>;
  if (run?.state === 'ok') return <Chip tone="signal">✓ ready</Chip>;
  if (!plan.canApply) return <Chip>report only</Chip>;
  if (plan.needsApprovers) return <Chip>needs an approver</Chip>;
  if (plan.needsProductionReviewer) return <Chip>needs who approves production</Chip>;
  const count = pending(plan);
  return count === 0 ? <Chip tone="signal">✓ ready</Chip> : <Chip>{count} to change</Chip>;
}

/**
 * One repository: a row that shows where it stands, and under it — folded until
 * somebody opens it — everything it would get, with the two halves still
 * separately doable for whoever wants to agree to one and not the other.
 */
function RepoRow({
  plan,
  run,
  busy,
  done,
  onApply,
  onProduction,
}: {
  plan: RepoPlan;
  run?: RepoRun;
  busy: string | null;
  done: Record<string, ApplyOutcome[] | LabelChange[]>;
  onApply: (repo: string, what: 'labels' | 'rules', options?: { force?: boolean }) => void;
  onProduction?: (repo: string, choice: ProductionChoice) => Promise<void>;
}) {
  // Said once at the top, so not here.
  const reports = [...plan.rules, ...plan.templates].filter((report) => report.state !== 'unsupported');

  return (
    <li className="rounded-lg border border-edge bg-surface">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="w-3 shrink-0 text-[10px] text-dim transition-transform group-open:rotate-90">
            ▶
          </span>
          <span className="min-w-0 flex-1 break-all font-mono text-[12px] text-body">{plan.repository}</span>
          <Status plan={plan} run={run} />
        </summary>

        <div className="space-y-2.5 border-t border-edge px-3 py-3">
          <Section
            title="The board’s columns"
            changes={plan.labelChanges}
            settled="all present"
            action={
              plan.labelChanges > 0 && (
                <Button
                  size="sm"
                  disabled={!plan.canApply || busy !== null}
                  onClick={() => onApply(plan.repository, 'labels')}
                >
                  {busy === `${plan.repository}:labels`
                    ? 'writing…'
                    : `write ${plan.labelChanges} label${plan.labelChanges === 1 ? '' : 's'} only`}
                </Button>
              )
            }
            items={plan.labels.map((label) => (
              <Change
                key={label.name}
                mark={label.action === 'create' ? '+' : label.action === 'update' ? '~' : '·'}
                name={label.name}
                detail={label.action === 'unchanged' ? undefined : label.detail}
              />
            ))}
          />

          <Section
            title="Protecting the repository"
            changes={plan.ruleChanges}
            settled="nothing outstanding"
            action={
              (plan.ruleChanges > 0 || planLimited(plan)) && (
                <div className="flex flex-wrap items-center gap-2">
                  {plan.ruleChanges > 0 && (
                    <Button
                      size="sm"
                      // As the step's button: not before somebody is named to approve.
                      disabled={!plan.canApply || busy !== null || Boolean(plan.needsApprovers) || Boolean(plan.needsProductionReviewer)}
                      onClick={() => onApply(plan.repository, 'rules')}
                    >
                      {busy === `${plan.repository}:rules`
                        ? 'applying…'
                        : `apply ${plan.ruleChanges} change${plan.ruleChanges === 1 ? '' : 's'} only`}
                    </Button>
                  )}
                  {/* The plan's limit is remembered so it is not asked for on every click; this asks GitHub again, after an upgrade. */}
                  {planLimited(plan) && (
                    <Button
                      size="sm"
                      disabled={!plan.canApply || busy !== null}
                      onClick={() => onApply(plan.repository, 'rules', { force: true })}
                    >
                      {busy === `${plan.repository}:rules!` ? 'asking GitHub…' : 'Check GitHub again after an upgrade'}
                    </Button>
                  )}
                </div>
              )
            }
            items={reports.map((report) => (
              <Change
                key={report.name}
                mark={report.state === 'present' ? '·' : report.state === 'drifted' ? '~' : '+'}
                name={report.name}
                detail={report.state === 'present' ? undefined : report.detail || report.state}
              />
            ))}
          />

          {Object.entries(done)
            .filter(([key]) => key.startsWith(`${plan.repository}:`))
            .map(([key, outcomes]) => {
              const { written, refused } = outcomeCounts(outcomes);
              return (
                <p key={key} className="text-[11.5px] text-muted">
                  {written} written · {refused} refused
                </p>
              );
            })}
        </div>
      </details>

      {/* Outside the fold too: a choice to make for each repository, not a detail to read. */}
      {plan.canApply && plan.production && (
        <div className="border-t border-edge px-3 py-2.5">
          <ProductionShips plan={plan} onSave={onProduction ? (choice) => onProduction(plan.repository, choice) : undefined} />
        </div>
      )}

      {/* Outside the fold: why a repository needs attention is the one thing nobody should have to open. */}
      {run?.state === 'attention' && (
        <ul className="space-y-1 border-t border-attention/30 bg-attention/5 px-3 py-2">
          {run.reasons.map((reason) => (
            <li key={reason} className="break-words text-[11.5px] leading-relaxed text-body">
              {reason}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The step itself, without the fetching, so a test can render every state.
 *
 * Read top to bottom it is: what this does, the button that does it, anything
 * GitHub will not hold whatever is pressed, and then one row per repository —
 * which is also where the button's progress shows, so there is no second list.
 */
export function RepoSetupView({
  plans,
  runs,
  running,
  busy,
  done,
  error,
  onSetUpAll,
  onApply,
  onApprovers,
  onProduction,
}: {
  plans: RepoPlan[];
  runs: Record<string, RepoRun>;
  running: boolean;
  busy: string | null;
  done: Record<string, ApplyOutcome[] | LabelChange[]>;
  error: string | null;
  onSetUpAll: () => void;
  onApply: (repo: string, what: 'labels' | 'rules', options?: { force?: boolean }) => void;
  onApprovers?: (logins: string) => Promise<void>;
  onProduction?: (repo: string, choice: ProductionChoice) => Promise<void>;
}) {
  const count = plans.length;
  const askApprovers = plans.some((plan) => plan.canApply && plan.needsApprovers);
  // Production's rules say a person approves and nobody is named: as with the
  // approvers, nothing is applied until somebody is, or it ships automatically.
  const askProduction = plans.some((plan) => plan.canApply && plan.needsProductionReviewer);
  const noun = count === 1 ? 'repository' : 'repositories';
  const canApply = plans.some((plan) => plan.canApply);
  const unreadable = plans.filter((plan) => !plan.canApply);
  const outstanding = plans.filter((plan) => plan.canApply && pending(plan) > 0).length;
  const labelCount = Math.max(0, ...plans.map((plan) => plan.labels.length));
  const limits = sharedLimits(plans);
  // GitHub cannot hold a reviewer on production here, so OpenADLC's review and
  // merge rules do not cover it: OpenADLC holds each promote instead.
  const productionLimited = limits.some((limit) => limit.names.includes('environment production'));
  const finished = Object.values(runs).filter((run) => run.state !== 'running').length;

  if (count === 0) {
    return (
      <p className="max-w-lg text-[13px] leading-relaxed text-muted">
        OpenADLC is not working in any repository yet, so there is nothing to set up. Add one on the repositories
        step and it appears here.
      </p>
    );
  }

  // Done is done: every repository has nothing left to change, as
  // `repositoriesReady` counts it. It was a greyed-out "All 1 repository set
  // up" button above a box headed "Not available", and a row marked "set up"
  // in the green of a button — three things that read as still to do, or as
  // failed. And a repository the app could not read at all was left out, so
  // the step said protection was in place there.
  const settled = plans.every((plan) => plan.canApply && pending(plan) === 0) && !running && !askApprovers && !askProduction;
  const what = (
    <ul className="list-disc space-y-1 pl-5">
      <li>
        <span className="text-body">Labels</span> — the {labelCount > 0 ? `${labelCount} ` : ''}labels the board
        uses as its columns, added or recolored.
      </li>
      <li>
        <span className="text-body">Protection</span> — a ruleset on the default branch (pull requests with a code
        owner’s review, signed commits, the <code className="font-mono text-[12px]">ci</code> check), one on{' '}
        <code className="font-mono text-[12px]">agent/</code> and <code className="font-mono text-[12px]">system/</code>{' '}
        branches, <em>testing</em> and <em>production</em> environments, and auto-merge allowed.
      </li>
      <li>
        <span className="text-body">Files</span> — whichever of CODEOWNERS, AGENTS.md, a Makefile, a{' '}
        <code className="font-mono text-[12px]">ci</code> workflow, the issue and pull request templates and the
        docs folders are missing, committed straight to the default branch. A file already there is left as it
        is; in CODEOWNERS only the line naming the lead reviewer is kept current.
      </li>
    </ul>
  );

  return (
    <div className="max-w-lg space-y-4">
      {settled ? (
        <div className="rounded-lg border border-signal/40 bg-signal/10 px-3.5 py-3">
          <p className="text-[13.5px] font-medium text-body">
            ✓ {count === 1 ? <span className="font-mono text-[12.5px]">{plans[0]!.repository}</span> : `All ${count} repositories`}{' '}
            {count === 1 ? 'is' : 'are'} ready for the crew.
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            {productionLimited
              ? 'Labels and files are in place. GitHub can’t hold a reviewer on production on your plan, so OpenADLC holds each production promote for a person in Needs you, or holds its soak where the repository ships automatically. The rest is below.'
              : limits.length > 0
                ? 'Labels and files are in place. Some of GitHub’s protections aren’t on your plan; OpenADLC’s own review and merge rules cover them, as below. Nothing more to do here.'
                : 'Labels, protection and files are in place. Nothing more to do here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2 text-[13px] leading-relaxed text-muted">
          <p>
            Before the crew can work in a repository, OpenADLC puts three things in place there. Nothing happens until
            you press the button, and nothing is ever deleted.
          </p>
          {what}
        </div>
      )}

      {!canApply && unreadable.every((plan) => !plan.detail || plan.detail.includes('no app key')) ? (
        <p className="rounded-lg border border-attention/40 bg-attention/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-body">
          OpenADLC holds no app key for this install, so it can only report. Add the key on the <strong>Create the app</strong>{' '}
          step and this becomes one click.
        </p>
      ) : (
        // By name, whichever others can be set up: the reason is the bridge's,
        // and a repository the app cannot reach is not missing a key.
        unreadable.length > 0 && (
          <div className="rounded-lg border border-attention/40 bg-attention/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-body">
            <p>OpenADLC cannot set up {unreadable.length === 1 ? 'this repository' : 'these repositories'}:</p>
            <ul className="mt-1 space-y-0.5">
              {unreadable.map((plan) => (
                <li key={plan.repository}>
                  <span className="break-all font-mono text-[12px]">{plan.repository}</span>
                  {plan.detail ? <span className="text-muted"> — {plan.detail}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )
      )}

      {askApprovers && onApprovers && <Approvers onSave={onApprovers} />}

      {!settled && (outstanding > 0 || running || !canApply) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* Not before the question is answered: pressed first, it wrote AGENTS.md
              with the template's @owner and no CODEOWNERS — the card a new install
              opened on. */}
          <Button
            variant="primary"
            disabled={!canApply || running || busy !== null || outstanding === 0 || askApprovers || askProduction}
            onClick={onSetUpAll}
          >
            {running ? `Setting up… ${finished} of ${count}` : `Set up all ${count} ${noun}`}
          </Button>
          {askApprovers ? (
            <span className="text-[11.5px] text-muted">after saying who approves, above</span>
          ) : askProduction ? (
            <span className="text-[11.5px] text-muted">after saying who approves production, below</span>
          ) : (
            !running &&
            canApply &&
            outstanding > 0 &&
            outstanding < count && <span className="text-[11.5px] text-muted">{count - outstanding} already in place</span>
          )}
        </div>
      )}

      {settled && (
        <details className="text-[12.5px] leading-relaxed text-muted">
          <summary className="cursor-pointer text-soft hover:text-body">What this step put in place</summary>
          <div className="mt-2">{what}</div>
        </details>
      )}

      {limits.length > 0 && (
        <details className="rounded-lg border border-edge bg-well/40 px-3.5 py-2.5">
          <summary className="cursor-pointer text-[12.5px] text-body">
            What GitHub doesn’t enforce on your plan{' '}
            <span className="text-muted">
              {productionLimited ? '— and what OpenADLC holds instead' : '— OpenADLC’s own rules cover it'}
            </span>
          </summary>
          <ul className="mt-2 space-y-2">
            {limits.map((limit) => (
              <li key={limitKey(limit)} className="text-[11.5px] leading-relaxed text-muted">
                <span className="font-mono text-soft">{limit.names.join(', ')}</span> — {limit.detail}
                <details className="mt-0.5">
                  <summary className="cursor-pointer text-dim hover:text-muted">
                    {limit.repositories.length === count
                      ? `all ${count} ${noun}`
                      : `${limit.repositories.length} of ${count} ${noun}`}
                  </summary>
                  <ul className="mt-1 space-y-0.5 pl-3">
                    {limit.repositories.map((repository) => (
                      <li key={repository} className="break-all font-mono text-[11px] text-dim">
                        {repository}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-dim">
            On a private repository, rulesets and CODEOWNERS need GitHub Pro (a person’s account), Team or
            Enterprise, environment protection needs Pro or Team, and a required environment reviewer needs Enterprise — or
            make the repository public. Until then the crew’s work still waits for the lead reviewer’s approval and a green{' '}
            <code className="font-mono">ci</code>, held by OpenADLC rather than by GitHub, and so does production: OpenADLC
            holds each promote for a person in Needs you, or for its soak on automatic delivery.
          </p>
        </details>
      )}

      <ul className="space-y-2">
        {plans.map((plan) => (
          <RepoRow
            key={plan.repository}
            plan={plan}
            run={runs[plan.repository]}
            // A half of one repository while the button is running would race it.
            busy={running ? 'all' : busy}
            done={done}
            onApply={onApply}
            onProduction={onProduction}
          />
        ))}
      </ul>

      {error && <p className="text-[12px] text-attention">{error}</p>}
    </div>
  );
}

export function RepoSetupStep({ onPlans }: { onPlans?: (plans: RepoPlan[]) => void } = {}) {
  const [plans, setPlans] = useState<RepoPlan[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<Record<string, RepoRun>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, ApplyOutcome[] | LabelChange[]>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/repo-setup', { cache: 'no-store' });
      if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
      const read = ((await response.json()) as { repositories: RepoPlan[] }).repositories;
      setPlans(read);
      onPlans?.(read);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not read the repository');
    }
    // Told once per read, not on every new callback from the page above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * One repository after another, not all at once: each is a burst of calls to
   * GitHub as the same app, and a row turning over at a time is also what lets
   * somebody watch it happen. A repository with nothing to change is marked
   * without a call, and one refusing does not stop the rest.
   */
  async function setUpAll(): Promise<void> {
    if (!plans) return;
    setRunning(true);
    setError(null);
    setRuns({});
    try {
      for (const plan of plans) {
        if (!plan.canApply) continue;
        if (pending(plan) === 0) {
          setRuns((was) => ({ ...was, [plan.repository]: { state: 'ok', written: 0 } }));
          continue;
        }
        setRuns((was) => ({ ...was, [plan.repository]: { state: 'running' } }));
        const run = await setUpRepository(plan);
        setRuns((was) => ({ ...was, [plan.repository]: run }));
      }
      await load();
    } finally {
      setRunning(false);
    }
  }

  /** Half of one repository, from inside its row — how this step used to work, still there. */
  async function apply(repo: string, what: 'labels' | 'rules', options: { force?: boolean } = {}): Promise<void> {
    setBusy(`${repo}:${what}${options.force ? '!' : ''}`);
    setError(null);
    try {
      const body = await post(repo, what, options);
      setDone((was) => ({ ...was, [`${repo}:${what}`]: body.changes ?? body.outcomes ?? [] }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'that did not work');
    } finally {
      setBusy(null);
    }
  }

  if (!plans) {
    return <p className="text-[13px] text-muted">{error ?? 'reading the repositories…'}</p>;
  }

  return (
    <RepoSetupView
      plans={plans}
      runs={runs}
      running={running}
      busy={busy}
      done={done}
      error={error}
      onSetUpAll={() => void setUpAll()}
      onApply={(repo, what, options) => void apply(repo, what, options)}
      onApprovers={async (logins) => {
        await saveApprovers(logins);
        await load();
      }}
      onProduction={async (repo, choice) => {
        await saveProduction(repo, choice);
        await load();
      }}
    />
  );
}

