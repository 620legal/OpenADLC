import Link from 'next/link';
import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { CiMinutes } from '@/components/ci-minutes';
import { HOW_THIS_WORKS, HowThisWorks } from '@/components/how-this-works';
import { Chip } from '@/components/ui/chip';
import { tokenCount, UsageChart, type UsageChartMode } from '@/components/usage-chart';
import { api, USAGE_RANGES, type CostUsageView, type UsageFigures, type UsageRange, type UsageShare } from '@/lib/api';
import { labelIn, type BotLabel } from '@/lib/bot-label';
import { spendLevel } from '@/lib/header';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/** How each range is named on its link. */
const RANGE_LABELS: Record<UsageRange, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  all: 'All time',
};

/** What the cache's savings are, said wherever they are shown: always an estimate. */
const SAVINGS_NOTE = "cache-read tokens priced at the input rate less the cache-read rate, at today's prices";

type Params = { range?: string | string[]; show?: string | string[] };

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The range and chart mode a URL names; a range or mode it does not know is the default, not an error page. */
function costsQuery(params: Params): { range: UsageRange; show: UsageChartMode } {
  const range = one(params.range);
  return {
    range: (USAGE_RANGES as readonly string[]).includes(range ?? '') ? (range as UsageRange) : '30d',
    show: one(params.show) === 'tokens' ? 'tokens' : 'cost',
  };
}

/** A link to the page in another state, keeping whichever of the two it does not change. */
function costsHref(state: { range: UsageRange; show: UsageChartMode }): string {
  return `/costs?range=${state.range}&show=${state.show}`;
}

function usd(value: number, places = 2): string {
  return `$${value.toFixed(places)}`;
}

function percent(share: number): string {
  return `${(share * 100).toFixed(share > 0 && share < 0.1 ? 1 : 0)}%`;
}

/** A row's bot: its handle, or its role before it connects, with the rest on hover. */
function BotName({ label }: { label: BotLabel }) {
  return (
    <span className="w-40 shrink-0 truncate text-soft" title={label.text}>
      {label.name}
    </span>
  );
}

function Toggle({ href, current, children }: { href: string; current: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={current ? 'true' : undefined}
      className={
        current
          ? 'rounded-md bg-well px-2.5 py-1 text-[12px] font-medium text-body'
          : 'rounded-md px-2.5 py-1 text-[12px] text-muted hover:text-body'
      }
    >
      {children}
    </Link>
  );
}

function Figure({ label, value, note, title }: { label: string; value: string; note?: string; title?: string }) {
  return (
    <div title={title}>
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {note && <p className="text-[10.5px] text-dim">{note}</p>}
    </div>
  );
}

/**
 * By model or by engine: billed and its share of billed, estimated and its
 * share of estimated. Never one column of both (docs/adr/0050).
 */
function Breakdown({ title, rows }: { title: string; rows: { name: string; detail?: string; usage: UsageFigures; share: UsageShare }[] }) {
  return (
    <section data-breakdown={title} className="rounded-lg border border-edge bg-panel/40 p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-[11px] text-dim">nothing in this range</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-[11.5px]">
            <thead className="text-dim">
              <tr>
                <th className="py-1 pr-3 font-medium">{title === 'By model' ? 'model' : 'engine'}</th>
                <th className="py-1 pr-3 text-right font-medium">billed</th>
                <th className="py-1 pr-3 text-right font-medium">share</th>
                <th className="py-1 pr-3 text-right font-medium">estimated</th>
                <th className="py-1 text-right font-medium">share</th>
              </tr>
            </thead>
            <tbody className="text-soft">
              {rows.map((row) => (
                <tr key={row.name} className="border-t border-edge/70">
                  <td className="py-1 pr-3 font-mono text-[10.5px]">
                    {row.name}
                    {row.detail ? <span className="text-dim"> · {row.detail}</span> : null}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums text-body">{usd(row.usage.billedUsd)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{percent(row.share.billed)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{usd(row.usage.estimateUsd)} est.</td>
                  <td className="py-1 text-right tabular-nums">{percent(row.share.estimate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Everything under the picker, from `/v1/costs/usage` for the range. */
function RangeBody({ usage, show, crew }: { usage: CostUsageView; show: UsageChartMode; crew: Parameters<typeof labelIn>[0] }) {
  const { totals } = usage;
  const botPeak = Math.max(...usage.byBot.map((row) => Math.max(row.billedUsd, row.estimateUsd)), 0.01);
  return (
    <>
      <section data-range-totals className="mt-4 grid grid-cols-2 gap-4 rounded-lg border border-edge bg-panel/40 p-4 sm:grid-cols-3">
        <Figure label="billed" value={usd(totals.billedUsd)} note="runs on an API key" />
        <Figure label="estimated" value={`${usd(totals.estimateUsd)} est.`} note="runs on subscriptions, not billed" />
        <Figure label="invocations" value={totals.invocations.toLocaleString()} />
      </section>

      <section data-tokens className="mt-4 grid grid-cols-2 gap-4 rounded-lg border border-edge bg-panel/40 p-4 sm:grid-cols-4">
        <Figure label="input (uncached)" value={tokenCount(totals.tokens.input)} />
        <Figure label="output" value={tokenCount(totals.tokens.output)} />
        <Figure label="cache read" value={tokenCount(totals.tokens.cacheRead)} />
        <Figure label="cache write" value={tokenCount(totals.tokens.cacheWrite)} />
      </section>

      <section data-cache-savings className="mt-4 rounded-lg border border-edge bg-panel/40 p-4" title={SAVINGS_NOTE}>
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Cache savings (estimate)</h2>
        <p className="mt-1 text-lg font-semibold tabular-nums">
          {usd(totals.cacheSavings.billedUsd)} <span className="text-sm font-normal text-muted">on billed</span>
          <span className="mx-2 text-dim">·</span>
          {usd(totals.cacheSavings.estimateUsd)} est. <span className="text-sm font-normal text-muted">on subscriptions</span>
        </p>
        <p className="mt-1 text-[11px] text-dim">An estimate: {SAVINGS_NOTE}.</p>
      </section>

      <section className="mt-4 rounded-lg border border-edge bg-panel/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            By {usage.bucket === 'hour' ? 'hour' : 'day'} (UTC)
          </h2>
          <nav aria-label="Chart" data-show-toggle className="flex gap-1">
            <Toggle href={costsHref({ range: usage.range, show: 'cost' })} current={show === 'cost'}>
              Cost
            </Toggle>
            <Toggle href={costsHref({ range: usage.range, show: 'tokens' })} current={show === 'tokens'}>
              Tokens
            </Toggle>
          </nav>
        </div>
        <UsageChart usage={usage} mode={show} />
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Breakdown
          title="By model"
          rows={usage.byModel.map((row) => ({ name: row.model, detail: row.engines.join(', '), usage: row, share: row.share }))}
        />
        <Breakdown title="By engine" rows={usage.byEngine.map((row) => ({ name: row.engine, usage: row, share: row.share }))} />
      </div>

      <section className="mt-4 rounded-lg border border-edge bg-panel/40 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">By bot</h2>
        <div className="mt-2 space-y-1">
          {usage.byBot.map((row) => (
            <div key={row.bot} className="flex items-center gap-2 text-[12px]">
              <BotName label={labelIn(crew, row.bot)} />
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-well">
                <div className="h-full bg-link" style={{ width: `${Math.min(100, (row.billedUsd / botPeak) * 100)}%` }} />
              </div>
              <span className="w-16 text-right tabular-nums text-body">{usd(row.billedUsd)}</span>
              <span className="w-20 text-right tabular-nums text-muted">{usd(row.estimateUsd)} est.</span>
              <span className="w-14 text-right text-[10.5px] text-dim">
                {row.tasks} {row.tasks === 1 ? 'task' : 'tasks'}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-edge bg-panel/40 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Recent invocations</h2>
        {usage.ledger.length === 0 ? (
          <p className="mt-2 text-[11px] text-dim">nothing on the ledger in this range</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table data-ledger className="w-full text-left text-[11.5px]">
              <thead className="text-dim">
                <tr>
                  <th className="py-1 pr-3 font-medium">when</th>
                  <th className="py-1 pr-3 font-medium">engine</th>
                  <th className="py-1 pr-3 font-medium">model</th>
                  <th className="py-1 pr-3 text-right font-medium">in</th>
                  <th className="py-1 pr-3 text-right font-medium">cache read</th>
                  <th className="py-1 pr-3 text-right font-medium">cache write</th>
                  <th className="py-1 pr-3 text-right font-medium">out</th>
                  <th className="py-1 text-right font-medium">cost</th>
                </tr>
              </thead>
              <tbody className="text-soft">
                {usage.ledger.slice(0, 12).map((row) => (
                  <tr key={row.id} className="border-t border-edge/70">
                    <td className="py-1 pr-3 font-mono text-[10.5px] text-muted">
                      {new Date(row.at).toISOString().slice(5, 16).replace('T', ' ')}
                    </td>
                    <td className="py-1 pr-3">{row.engine}</td>
                    <td className="py-1 pr-3 font-mono text-[10.5px]">
                      {row.model}
                      {row.modelAlias ? <span className="text-dim"> · {row.modelAlias}</span> : null}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">{row.tokensIn.toLocaleString()}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{(row.cacheRead ?? 0).toLocaleString()}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{(row.cacheWrite ?? 0).toLocaleString()}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{row.tokensOut.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums text-body">
                      ${row.costUsd.toFixed(4)}
                      {row.billed === false ? <span className="text-dim"> est.</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

export default async function CostsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { range, show } = costsQuery(await searchParams);
  // The crew is what says who a row's bot is. Without it a row still reads,
  // by its name alone. Without the month's costs there is no page, and it says
  // so the way every other page does rather than as Next's "Application error".
  const read = await Promise.all([api.costs(), api.crew().then((body) => body.bots).catch(() => [])]).catch(
    (error: unknown) => (error instanceof Error ? error : new Error('unknown error')),
  );
  if (read instanceof Error) return <BridgeDown error={read} />;
  const [costs, crew] = read;
  // The range's figures are read apart: a bridge from before #368 has no
  // /v1/costs/usage, and the month above the picker still reads.
  const usage = await api.costUsage(range).catch((error: unknown) => (error instanceof Error ? error : new Error('unknown error')));
  // Coloured by the budget's state, as the chip is: the bridge warns at
  // whatever `warningAt` is set to, which the page is not told.
  const { percent: used, tone } = spendLevel(costs.budget);
  const header = await readHeader({ crew, costs });

  return (
    <AppShell page="costs" data={header}>
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Costs</h1>
          <p className="mt-0.5 text-[12px] text-muted">every engine invocation is on the ledger before its output is acted on</p>
        </div>
      </div>

      <HowThisWorks {...HOW_THIS_WORKS.costs} className="mt-5" />

      {/* The cap is monthly, so what is held to it does not follow the range below. */}
      <h2 data-this-month className="mt-6 text-[12px] font-semibold uppercase tracking-wider text-soft">
        This month <span className="font-normal normal-case tracking-normal text-muted">· {costs.period}</span>
      </h2>
      <section className="mt-2 rounded-lg border border-edge bg-panel/40 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted">month to date</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              ${costs.budget.spentUsd.toFixed(2)}
              <span className="ml-1.5 text-sm font-normal text-muted">of ${costs.budget.capUsd.toFixed(0)}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Chip tone={costs.budget.state === 'ok' ? 'signal' : costs.budget.state === 'warning' ? 'attention' : 'alarm'}>
              {costs.budget.state}
            </Chip>
            <Chip>per task cap ${costs.perTaskCapUsd}</Chip>
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-well">
          <div
            className={tone === 'alarm' ? 'h-full bg-alarm' : tone === 'attention' ? 'h-full bg-attention' : 'h-full bg-signal'}
            style={{ width: `${used}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted">
          At the monthly cap the dispatcher stops leasing new work; running tasks finish.
        </p>
      </section>

      {costs.ci && <CiMinutes ci={costs.ci} />}

      {costs.stoppedAtCap.length > 0 && (
        <section className="mt-4 rounded-lg border border-attention/40 bg-attention/5 p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-attention">Stopped at the cap</h2>
          <ul className="mt-2 space-y-1 text-[12px] text-soft">
            {costs.stoppedAtCap.map((task) => (
              <li key={task.id} className="flex justify-between gap-3">
                <span className="font-mono">{task.subjectRef}</span>
                <span className="tabular-nums">${task.costUsd.toFixed(2)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted">
            Each of these asked a question in its thread rather than spending more.
          </p>
        </section>
      )}

      <div className="mt-8 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-soft">Usage</h2>
        <nav aria-label="Range" data-range-picker className="flex flex-wrap gap-1">
          {USAGE_RANGES.map((each) => (
            <Toggle key={each} href={costsHref({ range: each, show })} current={each === range}>
              {RANGE_LABELS[each]}
            </Toggle>
          ))}
        </nav>
      </div>

      {usage instanceof Error ? (
        <p data-usage-unread className="mt-3 rounded-lg border border-edge bg-panel/40 p-4 text-[12px] text-muted">
          The usage for this range could not be read: {usage.message}
        </p>
      ) : (
        <RangeBody usage={usage} show={show} crew={crew} />
      )}
    </main>
    </AppShell>
  );
}
