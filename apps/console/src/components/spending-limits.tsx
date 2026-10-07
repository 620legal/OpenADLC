'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { SettingsCard } from '@/components/settings-sections';
import { Button } from '@/components/ui/button';
import type { SpendingChange, SpendingLimitsView, SpendingScope, SpendingUpdate } from '@/lib/api';
import { cn } from '@/lib/cn';
import { spendLevel } from '@/lib/header';
import { readBridgeError } from '@/lib/model-onboarding';
import { money } from '@/lib/when';

/**
 * Spending caps.
 *
 * Settings shows the global month total and the per-task cap, and links here
 * to change them. `config/costs.yaml` only seeds those two global amounts the
 * first time OpenADLC starts. A field left blank on a repository uses the global
 * cap of that kind. A blank bot or provider does too when that global amount
 * is set, and is no cap only when the global amount is blank. The monthly
 * total and the per-task cap always have an amount.
 */

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
};

const INPUT =
  'w-28 rounded-md border border-edge-strong bg-surface px-2.5 py-1.5 text-[13px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link';

export function limitKey(scope: string, kind: string): string {
  return `${scope}\0${kind}`;
}

function shown(amount: number | null): string {
  return amount == null ? '' : String(amount);
}

function draftsOf(view: SpendingLimitsView): Record<string, string> {
  const drafts: Record<string, string> = {};
  const take = (scope: string, figures: SpendingScope) => {
    drafts[limitKey(scope, 'month_total')] = shown(figures.monthTotal.amountUsd);
    drafts[limitKey(scope, 'task')] = shown(figures.task.amountUsd);
    for (const bot of figures.bots) drafts[limitKey(scope, `month_bot:${bot.botId}`)] = shown(bot.amountUsd);
    for (const provider of figures.providers) drafts[limitKey(scope, `month_provider:${provider.provider}`)] = shown(provider.amountUsd);
  };
  take('global', view.global);
  for (const repo of view.repos) take(`repo:${repo.repoId}`, repo);
  return drafts;
}

function amountsOf(view: SpendingLimitsView): Map<string, number | null> {
  const amounts = new Map<string, number | null>();
  const take = (scope: string, figures: SpendingScope) => {
    amounts.set(limitKey(scope, 'month_total'), figures.monthTotal.amountUsd);
    amounts.set(limitKey(scope, 'task'), figures.task.amountUsd);
    for (const bot of figures.bots) amounts.set(limitKey(scope, `month_bot:${bot.botId}`), bot.amountUsd);
    for (const provider of figures.providers) amounts.set(limitKey(scope, `month_provider:${provider.provider}`), provider.amountUsd);
  };
  take('global', view.global);
  for (const repo of view.repos) take(`repo:${repo.repoId}`, repo);
  return amounts;
}

/** What each field is called on the page, for a line that says which one is wrong. */
function labelsOf(view: SpendingLimitsView): Map<string, string> {
  const labels = new Map<string, string>();
  const take = (scope: string, figures: SpendingScope, where: string) => {
    labels.set(limitKey(scope, 'month_total'), `${where}Each month`);
    labels.set(limitKey(scope, 'task'), `${where}Each task`);
    for (const bot of figures.bots) labels.set(limitKey(scope, `month_bot:${bot.botId}`), `${where}${bot.name}`);
    for (const provider of figures.providers)
      labels.set(limitKey(scope, `month_provider:${provider.provider}`), `${where}${PROVIDER_LABEL[provider.provider] ?? provider.provider}`);
  };
  take('global', view.global, '');
  for (const repo of view.repos) take(`repo:${repo.repoId}`, repo, `${repo.fullName}, `);
  return labels;
}

/**
 * The fields that differ from what is saved, as the bridge's put expects them,
 * and the ones that are not an amount. Those were skipped without a word: a
 * bot's "$500" was not saved, and the field went back to blank — no cap.
 */
export function changesOf(
  view: SpendingLimitsView,
  drafts: Record<string, string>,
): { changes: SpendingChange[]; invalid: { id: string; text: string }[] } {
  const current = amountsOf(view);
  const changes: SpendingChange[] = [];
  const invalid: { id: string; text: string }[] = [];
  for (const [id, text] of Object.entries(drafts)) {
    const [scope, kind] = id.split('\0');
    if (!scope || !kind || !current.has(id)) continue;
    const trimmed = text.trim();
    const amountUsd = trimmed === '' ? null : Number(trimmed);
    if (trimmed !== '' && !Number.isFinite(amountUsd)) {
      invalid.push({ id, text: trimmed });
      continue;
    }
    const before = current.get(id) ?? null;
    if (before === amountUsd) continue;
    changes.push({ scope, kind, amountUsd });
  }
  return { changes, invalid };
}

/** Why a field is not an amount, and what to write instead. */
export function notAnAmount(label: string, text: string): string {
  const digits = text.replace(/[^0-9.]/g, '');
  const instead = digits && Number.isFinite(Number(digits)) ? digits : 'a number of dollars, such as 500';
  return `${label}: ${text} is not an amount in dollars; write ${instead}`;
}

/** When the limits could not be read: what happened, and what to do about it. */
export const LIMITS_UNREAD =
  'OpenADLC could not read the spending limits from the bridge. Reload the page; if it keeps happening, run fleetadlc doctor.';

function dollars(amount: number | null): string {
  return amount == null ? 'no cap' : money(amount, { whole: Number.isInteger(amount) });
}

/**
 * How much of a cap is spent. A per-task cap is not a month's spend, so it
 * has no bar — only a figure that has both an amount and a spend does.
 */
function SpendBar({ spent, cap }: { spent: number; cap: number }) {
  const { width, tone } = spendLevel({ spentUsd: spent, capUsd: cap });
  return (
    <span
      role="meter"
      aria-label="Spent this month"
      aria-valuemin={0}
      aria-valuemax={cap}
      aria-valuenow={spent}
      className="mt-1.5 block h-1 w-40 overflow-hidden rounded-full bg-well"
    >
      <span
        className={cn('block h-full rounded-full', tone === 'alarm' ? 'bg-alarm' : tone === 'attention' ? 'bg-attention' : 'bg-signal')}
        // Never narrower than a sliver once anything is spent, or $7 of $1,500
        // draws as nothing at all.
        style={{ width: spent > 0 ? `max(2px, ${width}%)` : '0' }}
      />
    </span>
  );
}

function SummaryLine({
  label,
  amount,
  spent,
  hint,
}: {
  label: string;
  amount: number | null;
  spent?: number | null;
  hint?: string;
}) {
  return (
    <div className="flex flex-col border-t border-well py-2.5">
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="w-[140px] text-[13px] font-semibold text-body">{label}</span>
        <span className="text-[13px] text-body">{dollars(amount)}</span>
        {spent != null && <span className="text-[12px] text-muted">{money(spent, { whole: spent === 0 })} spent this month</span>}
      </span>
      {hint && <span className="text-[12px] text-muted">{hint}</span>}
      {amount != null && spent != null && <SpendBar spent={spent} cap={amount} />}
    </div>
  );
}

/** The Settings section: the two global caps, how the month is going, and the link to change them. */
export function SpendingSummary({ initial }: { initial: SpendingLimitsView | null }) {
  const edit = (
    <Link href="/settings/spending" className="text-[12.5px] text-link hover:underline">
      Edit limits
    </Link>
  );
  if (!initial) {
    return (
      <SettingsCard id="spending-limits" title="Spending limits" action={edit}>
        <p className="text-[12.5px] text-muted">{LIMITS_UNREAD}</p>
      </SettingsCard>
    );
  }
  return (
    <SettingsCard id="spending-limits" title="Spending limits" action={edit}>
      <SummaryLine label="Each month" amount={initial.global.monthTotal.amountUsd} spent={initial.global.monthTotal.spentUsd} />
      <SummaryLine label="Each task" amount={initial.global.task.amountUsd} hint="A task stops when it has cost this much." />
    </SettingsCard>
  );
}

function Field({
  label,
  hint,
  value,
  placeholder,
  invalid = false,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-well py-2.5">
      <span className="w-[140px] text-[13px] font-semibold text-body">{label}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <input
          inputMode="decimal"
          aria-label={label}
          value={value}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
          className={cn(INPUT, invalid && 'border-alarm')}
        />
        {hint && <span className="text-[12px] text-muted">{hint}</span>}
      </span>
    </label>
  );
}

function CapTable({
  title,
  rows,
  onChange,
}: {
  title: string;
  rows: { key: string; label: string; value: string; placeholder?: string; spent: string; invalid: boolean }[];
  onChange: (key: string, value: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3">
      <h3 className="text-[12.5px] font-semibold text-muted">{title}</h3>
      <table className="mt-1 w-full border-collapse text-left">
        <thead>
          <tr className="text-[12px] text-muted">
            <th className="py-1 pr-3 font-medium">Name</th>
            <th className="py-1 pr-3 font-medium">Cap</th>
            <th className="py-1 font-medium">This month</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-well">
              <th scope="row" className="py-2 pr-3 text-[13px] font-semibold text-body">
                {row.label}
              </th>
              <td className="py-2 pr-3">
                <input
                  inputMode="decimal"
                  aria-label={row.label}
                  value={row.value}
                  placeholder={row.placeholder}
                  aria-invalid={row.invalid || undefined}
                  onChange={(event) => onChange(row.key, event.target.value)}
                  className={cn(INPUT, row.invalid && 'border-alarm')}
                />
              </td>
              <td className="py-2 text-[12px] text-muted">{row.spent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScopeFields({
  scope,
  figures,
  drafts,
  globalScope,
  invalid,
  onChange,
}: {
  scope: string;
  figures: SpendingScope;
  drafts: Record<string, string>;
  /** The fields that are not an amount, marked until they are. */
  invalid: ReadonlySet<string>;
  /** A repository field left blank uses this. Absent on the global scope. */
  globalScope?: SpendingScope;
  onChange: (key: string, value: string) => void;
}) {
  const read = (kind: string) => drafts[limitKey(scope, kind)] ?? '';
  const placeholder = (global: number | null | undefined) =>
    globalScope && global != null ? `uses ${money(global, { whole: Number.isInteger(global) })}` : undefined;
  // A blank bot or provider on a repository uses the global cap when one is
  // set. "no cap" is only true when that global amount is blank too.
  const inherited = (global: number | null | undefined) => (globalScope ? (placeholder(global) ?? 'no cap') : 'no cap');
  const spent = (amount: number | null) => `${money(amount ?? 0, { whole: (amount ?? 0) === 0 })} this month`;
  return (
    <div className="flex flex-col">
      <Field
        label="Each month"
        value={read('month_total')}
        invalid={invalid.has(limitKey(scope, 'month_total'))}
        placeholder={placeholder(globalScope?.monthTotal.amountUsd)}
        hint={
          figures.monthTotal.spentUsd == null
            ? undefined
            : `${money(figures.monthTotal.spentUsd, { whole: figures.monthTotal.spentUsd === 0 })} spent this month`
        }
        onChange={(value) => onChange(limitKey(scope, 'month_total'), value)}
      />
      <Field
        label="Each task"
        value={read('task')}
        invalid={invalid.has(limitKey(scope, 'task'))}
        placeholder={placeholder(globalScope?.task.amountUsd)}
        hint="A task stops when it has cost this much."
        onChange={(value) => onChange(limitKey(scope, 'task'), value)}
      />
      <CapTable
        title="Each bot"
        onChange={onChange}
        rows={figures.bots.map((bot) => ({
          key: limitKey(scope, `month_bot:${bot.botId}`),
          label: bot.name,
          value: read(`month_bot:${bot.botId}`),
          placeholder: inherited(globalScope?.bots.find((one) => one.botId === bot.botId)?.amountUsd),
          spent: spent(bot.spentUsd),
          invalid: invalid.has(limitKey(scope, `month_bot:${bot.botId}`)),
        }))}
      />
      <CapTable
        title="Each provider"
        onChange={onChange}
        rows={figures.providers.map((provider) => ({
          key: limitKey(scope, `month_provider:${provider.provider}`),
          label: PROVIDER_LABEL[provider.provider] ?? provider.provider,
          value: read(`month_provider:${provider.provider}`),
          placeholder: inherited(globalScope?.providers.find((one) => one.provider === provider.provider)?.amountUsd),
          spent: spent(provider.spentUsd),
          invalid: invalid.has(limitKey(scope, `month_provider:${provider.provider}`)),
        }))}
      />
    </div>
  );
}

function Tab({
  selected,
  controls,
  onSelect,
  children,
}: {
  selected: boolean;
  controls: string;
  onSelect: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`${controls}-tab`}
      aria-selected={selected}
      aria-controls={controls}
      onClick={onSelect}
      className={cn(
        '-mb-px inline-flex h-10 items-center border-b-2 text-[13px]',
        selected ? 'border-body font-medium text-body' : 'border-transparent text-muted',
      )}
    >
      {children}
    </button>
  );
}

export function SpendingLimitsPanel({
  view,
  busy,
  notice,
  error,
  onSave,
}: {
  view: SpendingLimitsView;
  busy: boolean;
  notice: string | null;
  error: string | null;
  onSave: (changes: SpendingChange[]) => void;
}) {
  const [drafts, setDrafts] = useState(() => draftsOf(view));
  const [seen, setSeen] = useState(view);
  const [tab, setTab] = useState<'global' | 'repositories'>('global');
  if (seen !== view) {
    setSeen(view);
    setDrafts(draftsOf(view));
  }
  const { changes, invalid } = useMemo(() => changesOf(view, drafts), [view, drafts]);
  const wrong = useMemo(() => new Set(invalid.map((one) => one.id)), [invalid]);
  const labels = useMemo(() => labelsOf(view), [view]);
  const set = (key: string, value: string) => setDrafts((current) => ({ ...current, [key]: value }));

  return (
    <SettingsCard
      title="Spending limits"
      line="Saved here. config/costs.yaml sets the two global amounts only the first time OpenADLC starts; after that, change them here."
    >
      {notice && <p className="mb-2 text-[12.5px] text-body">{notice}</p>}
      {error && <p className="mb-2 text-[12.5px] text-alarm">{error}</p>}
      <div role="tablist" aria-label="Which limits" className="flex items-center gap-[18px] border-b border-edge">
        <Tab selected={tab === 'global'} controls="spending-global" onSelect={() => setTab('global')}>
          Global
        </Tab>
        <Tab selected={tab === 'repositories'} controls="spending-repositories" onSelect={() => setTab('repositories')}>
          Repositories
        </Tab>
      </div>
      {/* Both panels stay mounted: a cap edited on the other tab is still in the save. */}
      <div role="tabpanel" id="spending-global" aria-labelledby="spending-global-tab" hidden={tab !== 'global'}>
        <ScopeFields scope="global" figures={view.global} drafts={drafts} invalid={wrong} onChange={set} />
      </div>
      <div role="tabpanel" id="spending-repositories" aria-labelledby="spending-repositories-tab" hidden={tab !== 'repositories'}>
        {view.repos.length === 0 ? (
          <p className="mt-3 text-[12.5px] text-muted">No repository yet. A repository’s cap can be lower than the global one, or left blank to use it.</p>
        ) : (
          view.repos.map((repo) => (
            <div key={repo.repoId} className="mt-3">
              <h3 className="text-[13px] font-semibold text-body">{repo.fullName}</h3>
              <p className="text-[12px] text-muted">Blank uses the global cap, and a cap here can only be lower.</p>
              <ScopeFields scope={`repo:${repo.repoId}`} figures={repo} drafts={drafts} globalScope={view.global} invalid={wrong} onChange={set} />
            </div>
          ))
        )}
      </div>
      {/* Nothing is saved while a field is not an amount: saved without it, the
          field went back to what was stored, and said nothing. */}
      {invalid.length > 0 && (
        <ul role="alert" className="mt-3 flex flex-col gap-0.5 text-[12.5px] text-alarm">
          {invalid.map((one) => (
            <li key={one.id}>{notAnAmount(labels.get(one.id) ?? 'A cap', one.text)}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={busy || changes.length === 0 || invalid.length > 0}
          onClick={() => onSave(changes)}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {changes.length === 0 && invalid.length === 0 && <span className="text-[12px] text-muted">Nothing to save.</span>}
      </div>
    </SettingsCard>
  );
}

export function SpendingLimits({ initial }: { initial: SpendingLimitsView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!view) {
    return (
      <SettingsCard title="Spending limits">
        <p className="text-[12.5px] text-muted">{LIMITS_UNREAD}</p>
      </SettingsCard>
    );
  }

  return (
    <SpendingLimitsPanel
      view={view}
      busy={busy}
      notice={notice}
      error={error}
      onSave={(changes) => {
        const missing = changes.find(
          (change) => change.scope === 'global' && (change.kind === 'month_total' || change.kind === 'task') && change.amountUsd == null,
        );
        if (missing) {
          setError('The monthly total and the per-task cap need an amount.');
          return;
        }
        setBusy(true);
        setError(null);
        void fetch('/api/spending/limits', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ changes }),
        })
          .then(async (response) => {
            // The answer is read as JSON only once it is a success: a proxy's
            // HTML page while the bridge restarted was shown as a SyntaxError.
            if (!response.ok) throw new Error(await readBridgeError(response));
            const body = (await response.json()) as SpendingUpdate;
            setView(body.limits);
            setNotice(body.notice);
          })
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'could not save the limits'))
          .finally(() => setBusy(false));
      }}
    />
  );
}
