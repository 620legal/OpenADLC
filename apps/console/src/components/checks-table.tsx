'use client';

import { useState } from 'react';
import { IntakeDialog, type RequestPrefill } from '@/components/intake-dialog';
import { Button } from '@/components/ui/button';
import type { CheckResult, CheckRow } from '@/lib/api';

/**
 * A repository's checks, one row each (#372): where it runs, whether
 * `make ci` covers it, its last result on the default branch, and, for a
 * flaky job, how often and on which heads, with File as task. File as task
 * only opens the New request form, filled in; a person still sends it.
 */

const RESULT: Record<CheckResult, string> = {
  pass: 'Passed',
  fail: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  'none yet': 'None yet',
};

const short = (sha: string): string => sha.slice(0, 7);

/** The New request a flaky job's File as task opens: kind defect, its repository, its count and heads. */
export function flakyJobRequest(repo: string, row: CheckRow): RequestPrefill {
  const heads = row.flaky?.heads ?? [];
  const count = row.flaky?.count ?? heads.length;
  return {
    repo,
    kind: 'defect',
    text: `Flaky CI job: ${row.name}`,
    details: [
      `${row.name} in ci failed and then passed on the same head ${count} ${count === 1 ? 'time' : 'times'} in the last 30 runs:`,
      ...heads.map((head) => `- ${short(head.sha)}: ${head.runUrl}`),
    ].join('\n'),
    replaceLabel: 'Replace it with this flaky job’s request',
  };
}

export function ChecksTable({ repo, rows, repos }: { repo: string; rows: readonly CheckRow[]; repos: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<RequestPrefill | undefined>(undefined);
  return (
    <>
      <table data-checks className="w-full text-left text-[12.5px]">
        <thead className="text-[11.5px] text-soft">
          <tr>
            <th className="py-1 pr-3 font-medium">Check</th>
            <th className="py-1 pr-3 font-medium">Runs on</th>
            <th className="py-1 pr-3 font-medium">make ci</th>
            <th className="py-1 pr-3 font-medium">Last on the default branch</th>
            <th className="py-1 font-medium">Flaky</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-check={row.key} className="border-t border-edge align-top">
              <td className="py-1.5 pr-3 text-body">
                <span className="font-medium">{row.name}</span>
                {row.command && <code className="ml-1.5 text-[11.5px] text-soft">{row.command}</code>}
              </td>
              <td className="py-1.5 pr-3 text-soft">{row.runsOn === 'github' ? 'GitHub' : 'this machine'}</td>
              <td className="py-1.5 pr-3">
                {row.covered === false && (
                  <span data-differs className="rounded bg-attention/10 px-1 text-[11px] text-attention">
                    differs from GitHub
                  </span>
                )}
                {row.covered === 'unknown' && (
                  <span data-covered-unknown className="text-[11.5px] text-soft">
                    cannot tell: workflow not read
                  </span>
                )}
                {row.covered === true && <span className="text-[11.5px] text-soft">covered</span>}
              </td>
              <td className="py-1.5 pr-3" data-result={row.last.result}>
                {row.last.url ? (
                  <a href={row.last.url} target={row.last.url.startsWith('/') ? undefined : '_blank'} rel="noreferrer" className="text-link hover:underline">
                    {RESULT[row.last.result]}
                  </a>
                ) : (
                  <span className="text-soft">{RESULT[row.last.result]}</span>
                )}
                {row.last.detail && <span className="ml-1.5 text-[11.5px] text-soft">({row.last.detail})</span>}
              </td>
              <td className="py-1.5">
                {row.flaky && row.flaky.count > 0 && (
                  <div className="flex flex-col gap-1">
                    <span data-flaky>
                      {row.flaky.count} {row.flaky.count === 1 ? 'head' : 'heads'}:{' '}
                      {row.flaky.heads.map((head, index) => (
                        <span key={head.sha}>
                          {index > 0 && ', '}
                          <a href={head.runUrl} target="_blank" rel="noreferrer" className="font-mono text-link hover:underline">
                            {short(head.sha)}
                          </a>
                        </span>
                      ))}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-file-task
                      onClick={() => {
                        setPrefill(flakyJobRequest(repo, row));
                        setOpen(true);
                      }}
                    >
                      File as task
                    </Button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <IntakeDialog repos={[...repos]} open={open} onOpenChange={setOpen} {...(prefill ? { prefill } : {})} />
    </>
  );
}
