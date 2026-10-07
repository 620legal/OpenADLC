import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { CiMinutes } from '@/components/ci-minutes';
import { DayBars } from '@/components/day-bars';
import { Chip } from '@/components/ui/chip';
import { api } from '@/lib/api';
import { labelIn, type BotLabel } from '@/lib/bot-label';
import { spendLevel } from '@/lib/header';
import { readHeader } from '@/lib/read-header';

export const dynamic = 'force-dynamic';

/** A row's bot: its handle, or its role before it connects, with the rest on hover. */
function BotName({ label }: { label: BotLabel }) {
  return (
    <span className="w-40 shrink-0 truncate text-soft" title={label.text}>
      {label.name}
    </span>
  );
}

export default async function CostsPage() {
  // The crew is what says who a row's bot is. Without it a row still reads,
  // by its name alone. Without the costs there is no page, and it says so the
  // way every other page does rather than as Next's "Application error".
  const read = await Promise.all([api.costs(), api.crew().then((body) => body.bots).catch(() => [])]).catch(
    (error: unknown) => (error instanceof Error ? error : new Error('unknown error')),
  );
  if (read instanceof Error) return <BridgeDown error={read} />;
  const [costs, crew] = read;
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
          <p className="mt-0.5 text-[12px] text-muted">
            {costs.period} · every engine invocation is on the ledger before its output is acted on
          </p>
        </div>
      </div>

      <section className="mt-5 rounded-lg border border-edge bg-panel/40 p-4">
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

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-edge bg-panel/40 p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">By bot</h2>
          <div className="mt-2 space-y-1">
            {costs.byBot.map((row) => (
              <div key={row.bot} className="flex items-center gap-2 text-[12px]">
                <BotName label={labelIn(crew, row.bot)} />
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-well">
                  <div
                    className="h-full bg-link"
                    style={{
                      width: `${Math.min(100, (row.costUsd / Math.max(...costs.byBot.map((entry) => entry.costUsd), 0.01)) * 100)}%`,
                    }}
                  />
                </div>
                <span className="w-16 text-right tabular-nums text-body">${row.costUsd.toFixed(2)}</span>
                <span className="w-14 text-right text-[10.5px] text-dim">
                  {row.tasks} {row.tasks === 1 ? 'task' : 'tasks'}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-edge bg-panel/40 p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">By day</h2>
          {/* Every day so far is a row, a quiet one a 0. */}
          {costs.byDay.every((day) => day.costUsd === 0) ? (
            <p className="mt-2 text-[11px] text-dim">nothing spent this period</p>
          ) : (
            <DayBars days={costs.byDay} />
          )}
        </section>
      </div>

      {costs.ci && <CiMinutes ci={costs.ci} />}

      <section className="mt-4 rounded-lg border border-edge bg-panel/40 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Recent invocations</h2>
        {costs.ledger.length === 0 ? (
          <p className="mt-2 text-[11px] text-dim">the ledger is empty</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-[11.5px]">
              <thead className="text-dim">
                <tr>
                  <th className="py-1 pr-3 font-medium">when</th>
                  <th className="py-1 pr-3 font-medium">engine</th>
                  <th className="py-1 pr-3 font-medium">model</th>
                  <th className="py-1 pr-3 text-right font-medium">in</th>
                  <th className="py-1 pr-3 text-right font-medium">out</th>
                  <th className="py-1 text-right font-medium">cost</th>
                </tr>
              </thead>
              <tbody className="text-soft">
                {costs.ledger.slice(0, 12).map((row) => (
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
                    <td className="py-1 pr-3 text-right tabular-nums">{row.tokensOut.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums text-body">${row.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
    </main>
    </AppShell>
  );
}
