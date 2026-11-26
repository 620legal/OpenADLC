'use client';

import Link from 'next/link';
import { useState } from 'react';
import { IntakeDialog, type RequestPrefill } from '@/components/intake-dialog';
import { ExternalIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import type { AlertSeverity, AlertType, AlertTypeState, SecurityAlert, SecurityAlertsView } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  ALERT_TYPES,
  SEVERITIES,
  SEVERITY_LABELS,
  TYPE_LABELS,
  severityPhrase,
  alertCount,
  filterAlerts,
  securityHref,
  securityRequest,
  type SecurityFilters,
} from '@/lib/security';

/**
 * Each managed repository's open security alerts, by type, read from GitHub
 * as the app when the page opens (#377, docs/adr/0086). Everything GitHub
 * wrote is drawn as text. A secret-scanning alert is the secret type's name
 * and its link: the bridge never sends the value, and a user is never sent
 * secret scanning at all.
 */
export function SecurityBody({ view, repos, filters }: { view: SecurityAlertsView; repos: readonly string[]; filters: SecurityFilters }) {
  const shown = filterAlerts(view, filters);
  const [prefill, setPrefill] = useState<RequestPrefill | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const file = (alert: SecurityAlert): void => {
    setPrefill(securityRequest(alert));
    setOpen(true);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2" data-security-filters>
        <Filter label="Repository">
          <Choice href={securityHref({ ...filters, repo: null })} on={!filters.repo}>
            All
          </Choice>
          {repos.map((name) => (
            <Choice key={name} href={securityHref({ ...filters, repo: name })} on={filters.repo === name}>
              {name}
            </Choice>
          ))}
        </Filter>
        <Filter label="Severity">
          <Choice href={securityHref({ ...filters, severity: null })} on={!filters.severity}>
            All
          </Choice>
          {SEVERITIES.map((severity) => (
            <Choice key={severity} href={securityHref({ ...filters, severity })} on={filters.severity === severity}>
              {SEVERITY_LABELS[severity]}
            </Choice>
          ))}
        </Filter>
      </div>

      <p className="text-[12px] text-muted" role="status">
        {alertCount(shown)} open {alertCount(shown) === 1 ? 'alert' : 'alerts'}
        {filters.severity ? ` ${severityPhrase(filters.severity)}` : ''}, read from GitHub at{' '}
        {new Date(view.readAt).toLocaleTimeString()}.
      </p>

      {shown.repos.length === 0 && <p className="text-[12.5px] text-soft">No repository to show.</p>}

      {shown.repos.map((repo) => (
        <section key={repo.fullName} aria-label={repo.repo} className="rounded-lg border border-edge bg-panel/40">
          <h2 className="border-b border-edge px-3.5 py-2 text-[13px] font-semibold text-body">{repo.repo}</h2>
          <div className="flex flex-col divide-y divide-edge">
            {ALERT_TYPES.map((type) => (
              <TypeBlock key={type} type={type} state={repo.types[type]} severity={filters.severity} onFile={file} />
            ))}
          </div>
        </section>
      ))}

      <IntakeDialog repos={[...repos]} open={open} onOpenChange={setOpen} prefill={prefill} />
    </div>
  );
}

/** One type on one repository: its alerts, or one line saying why there are none. */
function TypeBlock({
  type,
  state,
  severity,
  onFile,
}: {
  type: AlertType;
  state: AlertTypeState | undefined;
  severity: AlertSeverity | null;
  onFile: (alert: SecurityAlert) => void;
}) {
  return (
    <div className="px-3.5 py-2.5" data-alert-type={type}>
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted">{TYPE_LABELS[type]}</h3>
      {state?.state === 'read' && state.alerts.length > 0 ? (
        <>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {state.alerts.map((alert) => (
              <AlertRow key={`${alert.type}:${alert.number}`} alert={alert} onFile={onFile} />
            ))}
          </ul>
          {state.truncated && <p className="mt-1.5 text-[11.5px] text-muted">Only the first 1,000 are shown; GitHub lists the rest.</p>}
        </>
      ) : (
        <p className="mt-1 text-[12px] text-soft">{stateLine(state, severity)}</p>
      )}
    </div>
  );
}

/** What a type with no alert to list says instead. */
export function stateLine(state: AlertTypeState | undefined, severity: AlertSeverity | null = null): React.ReactNode {
  switch (state?.state) {
    case 'read':
      return severity ? `No open alerts ${severityPhrase(severity)}` : 'No open alerts';
    case 'off':
      return 'Not switched on for this repository';
    case 'unreadable':
      return (
        <>
          Not readable: the app needs “{state.permission}” (Read-only).{' '}
          <Link href="/needs-you" className="text-link underline-offset-2 hover:underline">
            See the health card
          </Link>
        </>
      );
    case 'failed':
      return `Could not be read: ${state.reason}`;
    case 'admins-only':
      return 'Shown to admins';
    case 'not-installed':
      return 'The app is not installed here';
    default:
      return 'Not read';
  }
}

function AlertRow({ alert, onFile }: { alert: SecurityAlert; onFile: (alert: SecurityAlert) => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]" data-alert={`${alert.type}:${alert.number}`}>
      <SeverityBadge severity={alert.severity} />
      <span className="min-w-0 flex-1 text-body">{alert.title}</span>
      {alert.where && <span className="text-[11.5px] text-muted">{alert.where}</span>}
      {alert.note && <span className="text-[11.5px] text-muted">rule: {alert.note}</span>}
      <a href={alert.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] text-link hover:underline">
        On GitHub <ExternalIcon size={11} />
      </a>
      <Button type="button" size="sm" variant="ghost" onClick={() => onFile(alert)}>
        File as task
      </Button>
    </li>
  );
}

function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  return (
    <span
      data-severity={severity}
      className={cn(
        'rounded px-1.5 py-px text-[10.5px] font-medium',
        severity === 'critical' || severity === 'high'
          ? 'bg-alarm/15 text-alarm'
          : severity === 'medium'
            ? 'bg-attention/15 text-attention'
            : 'bg-edge text-soft',
      )}
    >
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1 rounded-md border border-edge bg-panel p-0.5">
      {children}
    </div>
  );
}

function Choice({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={on ? 'true' : undefined}
      className={cn('rounded px-2 py-0.5 text-[12px]', on ? 'bg-body font-medium text-panel' : 'text-soft hover:text-body')}
    >
      {children}
    </Link>
  );
}
