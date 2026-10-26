'use client';

import { useState, useTransition } from 'react';
import { saveEgressHosts } from '@/app/actions';
import type { EgressHostsView } from '@/lib/api';

/**
 * The listed name that lets `host` through, or null: each name is itself and
 * every name under it, as the proxy is given it (`egressListAllows` in
 * packages/shared, which the console does not depend on).
 */
function listedAs(hosts: readonly string[], host: string): string | null {
  return hosts.find((name) => host === name || host.endsWith(`.${name}`)) ?? null;
}

/**
 * Settings → Egress: the names a cloud host's tasks may reach beyond the
 * proxy's own list, each removed on its row and one added below.
 *
 * A host the `testing-egress` card names arrives as `offered`, from its
 * button, and is only put in the field: it goes on the list when a person
 * presses Allow, since every name here is a way out of the host. The bridge
 * checks each name, audits what changed, and has hostd put the list on the
 * proxy at once (`egress-routes.ts`).
 *
 * The card also comes here for a host the list already lets through and the
 * proxy still refuses: the list did not reach the proxy. The field kept
 * nothing then and the card's words were nowhere on the page, so the host
 * stays in the field, and Allow saves the list as it is, which the bridge
 * has hostd put on the proxy again.
 */
export function EgressHosts({ initial, offered = null }: { initial: EgressHostsView; offered?: string | null }) {
  const [hosts, setHosts] = useState(initial.hosts);
  const [draft, setDraft] = useState(offered ?? '');
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const blocked = initial.settingsList !== true;

  const save = (next: string[], done: string) => {
    setError(null);
    setSaid(null);
    start(async () => {
      const result = await saveEgressHosts(next);
      if (result.hosts) setHosts(result.hosts);
      if (!result.ok) {
        setError(result.error ?? 'the list was not saved');
        return;
      }
      setDraft('');
      setSaid(done);
    });
  };

  const add = () => {
    // A second save while one is out would be made from the list before it.
    if (pending) return;
    const name = draft.trim().toLowerCase();
    if (!name) return;
    const already = listedAs(hosts, name);
    if (already) {
      save(hosts, `The list is saved again, and hostd put ${already} on the egress proxy`);
      return;
    }
    save([...hosts, name], `${name} is allowed, and on the egress proxy now`);
  };
  const offeredListedAs = offered && draft === offered ? listedAs(hosts, offered) : null;

  return (
    <div data-egress-hosts className="flex flex-col gap-2.5 text-[12.5px]">
      <p className="text-muted">
        Each name lets tasks reach it and every name under it, so give the host itself, such as a testing environment’s, not a domain above it.
        hostd puts the list on the egress proxy as soon as it is saved, with no restart, and each change is in the audit trail with who made it.
        The operator’s <code>extra_allowed_domains</code>, in the install’s cloud settings, is a fixed list beside this one. A repository’s own
        files never add a name.
      </p>
      {blocked && initial.reason && (
        <p role="status" className="text-attention">
          {initial.reason}
        </p>
      )}
      {hosts.length === 0 ? (
        <p className="text-dim">No names beyond the host’s own list.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-edge rounded-md border border-edge">
          {hosts.map((host) => (
            <li key={host} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <code className="truncate text-body">{host}</code>
              <button
                type="button"
                disabled={pending || blocked}
                aria-label={`Remove ${host}`}
                onClick={() => save(hosts.filter((one) => one !== host), `${host} is removed, and off the egress proxy now`)}
                className="rounded-md border border-edge bg-panel px-2.5 py-1 text-[12px] text-body hover:bg-well disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {offered && draft === offered && !offeredListedAs && (
        <p className="text-soft">
          A check found {offered} refused, where a repository’s testing is served. Allow it if that is the environment you meant.
        </p>
      )}
      {offeredListedAs && (
        <p className="text-attention">
          This list has {offeredListedAs}, and a check found the egress proxy still refuses {offered}: the list did not reach the proxy. Allow saves
          the list again, and hostd puts it there.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Host name to allow"
          placeholder="testing.example.com"
          value={draft}
          disabled={blocked || pending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !pending) add();
          }}
          className="w-72 max-w-full rounded-md border border-edge bg-panel px-2 py-1 text-body"
        />
        <button
          type="button"
          disabled={pending || blocked || !draft.trim()}
          onClick={add}
          className="rounded-md border border-edge bg-panel px-2.5 py-1 text-[12px] font-medium text-body hover:bg-well disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Allow'}
        </button>
      </div>
      {error && (
        <p role="status" className="text-alarm">
          {error}
        </p>
      )}
      {said && (
        <p role="status" className="text-signal">
          {said}
        </p>
      )}
    </div>
  );
}
