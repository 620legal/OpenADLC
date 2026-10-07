'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { readBridgeError } from '@/lib/model-onboarding';
import { BRIDGE_NOT_ANSWERING, reach } from '@/lib/reach';

/**
 * The step that used to be the worst one.
 *
 * It was a public-URL field, two copy boxes, and a secret to generate and paste
 * somewhere else — four manual operations, each of which fails silently, to
 * configure something OpenADLC could configure itself. It holds the app's private
 * key, so it can write the hook onto GitHub; it runs on the machine, so it can
 * raise the tunnel.
 *
 * So one question is asked, because it is the only one whose answer OpenADLC cannot
 * know: is this bridge on your machine, or does it already have an address? The
 * rest happens on a click, and what is reported afterwards is what GitHub
 * actually believes rather than what was saved here.
 */

/**
 * How cloudflared is installed, said for every system OpenADLC runs on: the
 * Homebrew command alone told a Linux self-hoster to run what they lack.
 */
export const CLOUDFLARED_INSTALL = 'macOS: brew install cloudflared; on Linux, Cloudflare’s package';

export interface WebhookStatus {
  /** GitHub delivering here: everything set, and GitHub has delivered. */
  ready: boolean;
  /** Everything OpenADLC can set is right. Absent from an older bridge. */
  configured?: boolean;
  /**
   * Whether GitHub sends at all, which no setting says: `heard` once it lists a
   * delivery, `never` before, `silent` when something happened that it would
   * have sent and did not. Absent from an older bridge.
   */
  hearing?: 'heard' | 'never' | 'silent' | 'unknown';
  /** What happened that nothing was delivered for, newest find first. */
  unheard?: Unheard[];
  /** The app's settings page on GitHub, where the webhook's Active switch is. */
  settingsUrl?: string | null;
  /**
   * GitHub's hook still has the placeholder an app created without an address
   * gets: GitHub made that app's webhook switched off.
   */
  placeholderHook?: boolean;
  publicUrl: string;
  webhookUrl: string;
  secretStored: boolean;
  tunnel: { running: boolean; url: string; since: string | null; detail: string };
  github: { url: string; secretSet: boolean } | null;
  stale: boolean;
  canAutomate: boolean;
  tunnelAvailable: boolean;
  detail: string;
  /** What GitHub last delivered to the app's hook, and what the bridge answered. */
  lastDelivery?: LastDelivery | null;
}

/** Something on GitHub that nothing was delivered for; see the bridge's `unheard.ts`. */
export interface Unheard {
  subject: string;
  what: 'imported' | 'opened';
  title: string;
  url: string | null;
  happenedAt: string;
  foundAt: string;
}

export interface LastDelivery {
  event: string;
  action: string | null;
  /** 0 when GitHub got no answer at all. */
  statusCode: number;
  deliveredAt: string;
  redelivery: boolean;
}

function ago(when: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(when)) / 1000));
  if (!Number.isFinite(seconds)) return 'at some point';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `on ${new Date(when).toISOString().slice(0, 10)}`;
}

/**
 * What GitHub's own record of its last delivery says, as a sentence and a tone.
 *
 * The evidence the whole path works — GitHub, the tunnel, the bridge, the
 * signature — rather than that a setting was saved. A hook pointed at the right
 * address that every delivery fails at looks, from the settings, exactly like
 * one that works.
 */
export function deliverySentence(
  delivery: LastDelivery | null | undefined,
  now = Date.now(),
): { text: string; tone: 'good' | 'warn' | 'plain' } {
  if (!delivery) {
    return {
      text: 'GitHub has not delivered anything yet. The first comment, review or push in the repository is the first delivery.',
      tone: 'plain',
    };
  }
  const what = `${delivery.event}${delivery.action ? ` (${delivery.action})` : ''}, ${ago(delivery.deliveredAt, now)}`;
  const code = delivery.statusCode;
  if (code >= 200 && code < 300) return { text: `GitHub’s last delivery — ${what} — was accepted (${code}).`, tone: 'good' };
  if (code === 0) {
    return { text: `GitHub’s last delivery — ${what} — got no answer: nothing was listening at the address.`, tone: 'warn' };
  }
  if (code === 401) {
    return {
      text: `GitHub’s last delivery — ${what} — was refused (401): its signature did not match this bridge’s secret. A new address rewrites both.`,
      tone: 'warn',
    };
  }
  return { text: `GitHub’s last delivery — ${what} — failed (${code}).`, tone: 'warn' };
}

/**
 * Done: said in terms of what happens rather than what was saved, and with
 * nothing to copy — OpenADLC wrote the address and the secret onto the app
 * itself, and moves them when the tunnel does. The address is shown so it can
 * be recognised, not so it can be pasted anywhere.
 */
export function WebhookReady({
  status,
  busy,
  error,
  onNewAddress,
  onStop,
  now,
}: {
  status: WebhookStatus;
  busy: 'configuring' | 'stopping' | null;
  error: string | null;
  onNewAddress: () => void;
  onStop: () => void;
  now?: number;
}) {
  const delivery = deliverySentence(status.lastDelivery, now);
  return (
    <div className="max-w-lg space-y-3">
      <Row tone="good">
        <span className="font-medium">GitHub delivers to this bridge.</span>{' '}
        {status.tunnel.running
          ? 'Through a tunnel OpenADLC is running for you — it stays up while the bridge does.'
          : 'Straight to the address you gave.'}
      </Row>
      <p className="text-[12.5px] leading-relaxed text-muted">
        Nothing to copy: OpenADLC wrote this address and its secret onto your GitHub app itself
        {status.tunnel.running ? ', and moves them whenever the tunnel’s address changes.' : '.'}
        <span className="mt-1 block break-all font-mono text-[11.5px] text-dim">{status.webhookUrl}</span>
      </p>
      <Row tone={delivery.tone}>{delivery.text}</Row>
      {status.tunnel.running && <TunnelControls busy={busy} onNewAddress={onNewAddress} onStop={onStop} />}
      {error && <p className="text-[12px] text-attention">{error}</p>}
    </div>
  );
}

/**
 * A new address, and taking the tunnel down: shown wherever a tunnel is up,
 * since setting it up promised it can be taken down from here at any time.
 */
function TunnelControls({
  busy,
  onNewAddress,
  onStop,
}: {
  busy: 'configuring' | 'stopping' | null;
  onNewAddress: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
      <button
        type="button"
        className="text-muted underline underline-offset-2 hover:text-body disabled:opacity-50"
        onClick={onNewAddress}
        disabled={busy !== null}
      >
        {busy === 'configuring' ? 'starting…' : 'new address'}
      </button>
      <button
        type="button"
        className="text-muted underline underline-offset-2 hover:text-body disabled:opacity-50"
        onClick={onStop}
        disabled={busy !== null}
      >
        {busy === 'stopping' ? 'stopping…' : 'take it off the internet'}
      </button>
    </div>
  );
}

/** What OpenADLC saw that GitHub did not send, as a sentence. */
function unheardSentence(entry: Unheard): string {
  return entry.what === 'imported'
    ? `OpenADLC found ${entry.subject} by reading the repository; GitHub never delivered it.`
    : `${entry.subject} was opened and GitHub delivered nothing; OpenADLC saw it only by reading the repository.`;
}

/**
 * Set up, and GitHub has sent nothing.
 *
 * Everything OpenADLC can write is right, and it is not enough: an app's webhook
 * has an Active switch that no API can turn on. An app created before this
 * install had an address — the manifest has nowhere to point its webhook, so
 * GitHub makes it switched off — takes the address and the secret and still
 * sends nothing, and nothing anywhere says so. That went unnoticed on a real
 * install while this step said "GitHub delivers to this bridge".
 *
 * So switching it on is a numbered step, with the link to the one page that
 * can, and the step is ticked by GitHub's first delivery rather than by
 * anything saved. When reconcile has found something GitHub should have sent,
 * it is said plainly: GitHub is not sending.
 */
export function WebhookNotHeard({
  status,
  checking,
  onCheck,
  busy = null,
  error = null,
  onNewAddress,
  onStop,
}: {
  status: WebhookStatus;
  checking: boolean;
  onCheck: () => void;
  busy?: 'configuring' | 'stopping' | null;
  error?: string | null;
  onNewAddress?: () => void;
  onStop?: () => void;
}) {
  const newest = status.unheard?.[0];
  return (
    <div className="max-w-lg space-y-3">
      {status.hearing === 'silent' ? (
        <Row tone="warn">
          <span className="font-medium">GitHub is not sending events to OpenADLC.</span> Open the app’s settings and turn
          on Active under Webhook.
          {newest && <span className="mt-1 block text-[12px] text-muted">{unheardSentence(newest)}</span>}
        </Row>
      ) : status.hearing === 'unknown' ? (
        <Row tone="plain">
          The address and the secret are on your app, but GitHub could not be asked what it has delivered.
        </Row>
      ) : (
        <Row tone="plain">
          The address and the secret are on your app, and GitHub has not delivered anything yet. An app created before
          OpenADLC had an address has its webhook switched off, and only the app’s settings page can switch it on.
        </Row>
      )}
      <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-body">
        <li>
          {status.settingsUrl ? (
            <a href={status.settingsUrl} target="_blank" rel="noreferrer" className="text-link underline underline-offset-2">
              Open the app’s settings on GitHub ↗
            </a>
          ) : (
            'Open your app’s settings on GitHub.'
          )}
        </li>
        <li>
          Under <span className="font-medium">Webhook</span>, tick <span className="font-medium">Active</span>.
        </li>
        <li>
          Press <span className="font-medium">Save changes</span>.
        </li>
      </ol>
      <p className="text-[12px] leading-relaxed text-muted">
        OpenADLC ticks this step when GitHub’s first delivery arrives — a comment on any issue in the repository sends one.
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="ghost" onClick={onCheck} disabled={checking}>
          {checking ? 'asking GitHub…' : 'check again'}
        </Button>
        <span className="break-all font-mono text-[11.5px] text-dim">{status.webhookUrl}</span>
      </div>
      {status.tunnel.running && onNewAddress && onStop && <TunnelControls busy={busy} onNewAddress={onNewAddress} onStop={onStop} />}
      {error && <p className="text-[12px] text-attention">{error}</p>}
    </div>
  );
}

type Choice = 'tunnel' | 'address' | null;

function Row({ tone, children }: { tone: 'good' | 'warn' | 'plain'; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3.5 py-3 text-[13px] leading-relaxed',
        tone === 'good' && 'border-signal/40 bg-signal/10 text-body',
        tone === 'warn' && 'border-attention/40 bg-attention/10 text-body',
        tone === 'plain' && 'border-edge bg-surface text-muted',
      )}
    >
      {children}
    </div>
  );
}

/** One of the two answers, as something to click rather than a form to read. */
function ChoiceCard({
  title,
  body,
  note,
  selected,
  disabled,
  onSelect,
}: {
  title: string;
  body: string;
  note?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        'w-full rounded-lg border p-3.5 text-left transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link',
        selected ? 'border-link bg-link/10' : 'border-edge-strong bg-surface hover:bg-well',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span className="block text-[13px] font-medium text-body">{title}</span>
      <span className="mt-1 block text-[12.5px] leading-relaxed text-muted">{body}</span>
      {note && <span className="mt-1.5 block text-[11.5px] leading-relaxed text-dim">{note}</span>}
    </button>
  );
}

export function WebhookStep({
  onChanged,
  onStatus,
}: {
  onChanged?: () => void;
  /** So the step list can tick on GitHub delivering, not on a secret existing. */
  onStatus?: (status: WebhookStatus) => void;
}) {
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [choice, setChoice] = useState<Choice>(null);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState<'configuring' | 'stopping' | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read through a ref: the walkthrough passes a new `onStatus` on every
  // render, and a `record` that followed it made a new `load`, which the
  // effect below ran again — without end under a parent that re-renders on
  // every status.
  const told = useRef(onStatus);
  told.current = onStatus;
  const record = useCallback((next: WebhookStatus) => {
    setStatus(next);
    told.current?.(next);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/webhook', { cache: 'no-store' });
      if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
      record((await response.json()) as WebhookStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not read the webhook state');
    }
  }, [record]);

  useEffect(() => {
    void load();
  }, [load]);

  async function configure(mode: 'tunnel' | 'address'): Promise<void> {
    setBusy('configuring');
    setError(null);
    try {
      const response = await fetch('/api/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, url: mode === 'address' ? address.trim() : undefined }),
      });
      if (!response.ok) throw new Error(await readBridgeError(response));
      record((await response.json()) as WebhookStatus);
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not set it up');
    } finally {
      setBusy(null);
    }
  }

  // A refusal said, and a request that got no answer too: this failed in
  // silence, and the person who asked to come off the internet was not told
  // they had not. The status is read again either way, so the step shows
  // whether the tunnel is still up.
  async function stopTunnel(): Promise<void> {
    setBusy('stopping');
    setError(null);
    try {
      const response = await reach('/api/webhook?stop=1', { method: 'POST' }, BRIDGE_NOT_ANSWERING);
      if (!response.ok) throw new Error(await readBridgeError(response));
      record((await response.json()) as WebhookStatus);
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not take it off the internet');
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!status) {
    return <p className="text-[13px] text-muted">{error ?? 'reading what GitHub is pointed at…'}</p>;
  }

  if (status.ready) {
    return (
      <WebhookReady
        status={status}
        busy={busy}
        error={error}
        onNewAddress={() => void configure('tunnel')}
        onStop={() => void stopTunnel()}
      />
    );
  }

  // Everything OpenADLC can set is right and GitHub has sent nothing: what is
  // left is a switch only the app's settings page has.
  if (status.configured && status.hearing && status.hearing !== 'heard') {
    return (
      <WebhookNotHeard
        status={status}
        checking={checking}
        onCheck={() => {
          setChecking(true);
          void load().finally(() => setChecking(false));
        }}
        busy={busy}
        error={error}
        onNewAddress={() => void configure('tunnel')}
        onStop={() => void stopTunnel()}
      />
    );
  }

  // The address outlived the tunnel behind it. One click, because there is only
  // one thing to do and OpenADLC knows what it is.
  if (status.stale) {
    return (
      <div className="max-w-lg space-y-3">
        <Row tone="warn">
          The tunnel that served <span className="font-mono text-[12px]">{status.publicUrl}</span> is no longer
          running, so nothing is reaching this bridge. That address was temporary — a new one takes a moment.
        </Row>
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => void configure('tunnel')} disabled={busy !== null}>
            {busy === 'configuring' ? 'starting a tunnel…' : 'start one again'}
          </Button>
          <Button variant="ghost" onClick={() => setChoice('address')} disabled={busy !== null}>
            use a fixed address instead
          </Button>
        </div>
        {choice === 'address' && <AddressField value={address} onChange={setAddress} onSubmit={() => void configure('address')} busy={busy !== null} />}
        {error && <p className="text-[12px] text-attention">{error}</p>}
      </div>
    );
  }

  return (
    <div className="max-w-lg space-y-4">
      <p className="text-[13px] leading-relaxed text-muted">
        GitHub has to be able to reach this bridge, or OpenADLC only learns about a comment or a failed check when
        something happens to ask. One question, and OpenADLC does the rest — including the secret, which it generates
        and writes to your app itself.
      </p>

      {status.placeholderHook && (
        <Row tone="plain">
          Your app was created before this bridge had an address, so GitHub made its webhook switched off, and
          pointing it here will not switch it on. After this, one box on the app’s settings page does — this step
          shows you where.
        </Row>
      )}

      <div className="space-y-2">
        <ChoiceCard
          title="This bridge runs on my machine"
          body="OpenADLC raises a tunnel and points your app at it. Nothing to copy, nothing to paste."
          note={
            status.tunnelAvailable
              ? undefined
              : `Needs cloudflared (${CLOUDFLARED_INSTALL}), then come back to this step.`
          }
          selected={choice === 'tunnel'}
          disabled={!status.tunnelAvailable}
          onSelect={() => setChoice('tunnel')}
        />
        <ChoiceCard
          title="It already has a public address"
          body="A deployed install behind a domain. Give OpenADLC the address and it points your app at it."
          selected={choice === 'address'}
          onSelect={() => setChoice('address')}
        />
      </div>

      {choice === 'tunnel' && (
        <div className="space-y-2">
          <Button variant="primary" onClick={() => void configure('tunnel')} disabled={busy !== null}>
            {busy === 'configuring' ? 'raising a tunnel…' : 'set it up for me'}
          </Button>
          <p className="text-[11.5px] leading-relaxed text-dim">
            This puts one route on the internet — the one GitHub posts to, and nothing else. Every delivery is
            checked against the secret OpenADLC just generated, and you can take it down from here at any time.
          </p>
        </div>
      )}

      {choice === 'address' && (
        <AddressField value={address} onChange={setAddress} onSubmit={() => void configure('address')} busy={busy !== null} />
      )}

      {!status.canAutomate && (
        <Row tone="warn">
          OpenADLC does not hold your app’s private key, so it cannot write the webhook for you. Add the key on the
          app step, and this becomes one click with nothing to copy.
        </Row>
      )}

      {error && <p className="text-[12px] text-attention">{error}</p>}
      {!error && status.detail && <p className="text-[11.5px] text-dim">{status.detail}</p>}
    </div>
  );
}

function AddressField({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-2">
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-dim">the address this bridge answers on</span>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && value.trim()) onSubmit();
          }}
          placeholder="https://fleetadlc.example.com"
          className="mt-1.5 w-full rounded-md border border-edge-strong bg-surface px-3 py-2 text-[13px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link"
        />
      </label>
      <Button variant="primary" onClick={onSubmit} disabled={busy || !value.trim()}>
        {busy ? 'pointing GitHub at it…' : 'use this address'}
      </Button>
      <p className="text-[11.5px] text-dim">
        OpenADLC adds the path and the secret. Give it the root — not the webhook URL.
      </p>
    </div>
  );
}
