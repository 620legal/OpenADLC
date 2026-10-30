'use client';

import { useEffect, useState } from 'react';
import { DeviceCode } from '@/components/device-code';

/**
 * "Your GitHub account": the person signing in to the console proves which
 * GitHub account is theirs by approving a device code as it. A pull request's
 * sign-off that only a named reviewer may send (`/approve-pages`) is then
 * offered to them, and only to them (#207).
 *
 * OpenADLC keeps the login and the account id, never a token: the sign-in is
 * revoked once it has said who approved. Each sign-off asks for a code again.
 */

interface Flow {
  flowId: string;
  userCode: string;
  verificationUri: string;
}

const FLOW_READ_MS = 3_000;

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `the console answered ${response.status}`;
}

export function GitHubLinkCard() {
  const [linked, setLinked] = useState<string | null | undefined>(undefined);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const read = () =>
    void fetch('/api/me/github', { cache: 'no-store' })
      .then((response) => response.json())
      .then((body: { github?: { login: string } | null }) => setLinked(body.github?.login ?? null))
      .catch(() => setLinked(null));

  useEffect(read, []);

  useEffect(() => {
    if (!flow) return;
    const timer = setInterval(() => {
      void fetch(`/api/me/github/flows/${encodeURIComponent(flow.flowId)}`, { cache: 'no-store' })
        .then((response) => response.json())
        .then((said: { state: string; login?: string; error?: string }) => {
          if (said.state === 'waiting') return;
          setFlow(null);
          if (said.state === 'done' && said.login) setLinked(said.login);
          else setError(said.error ?? 'The sign-in ended before it linked an account. Try again.');
        })
        .catch(() => undefined);
    }, FLOW_READ_MS);
    return () => clearInterval(timer);
  }, [flow]);

  const link = () => {
    setPending(true);
    setError(null);
    void fetch('/api/me/github', { method: 'POST' })
      .then(async (response) => {
        if (!response.ok) return setError(await errorOf(response));
        setFlow((await response.json()) as Flow);
      })
      .catch(() => setError('The console is not answering.'))
      .finally(() => setPending(false));
  };

  const unlink = () => {
    setPending(true);
    setError(null);
    void fetch('/api/me/github', { method: 'DELETE' })
      .then(async (response) => {
        if (!response.ok) return setError(await errorOf(response));
        setLinked(null);
      })
      .catch(() => setError('The console is not answering.'))
      .finally(() => setPending(false));
  };

  return <GitHubLinkView linked={linked} flow={flow} error={error} pending={pending} onLink={link} onUnlink={unlink} />;
}

/** What the card shows, from its state: what its test renders. */
export function GitHubLinkView({
  linked,
  flow,
  error,
  pending,
  onLink,
  onUnlink,
}: {
  /** The linked login; null for none, undefined until read. */
  linked: string | null | undefined;
  flow: Flow | null;
  error: string | null;
  pending: boolean;
  onLink: () => void;
  onUnlink: () => void;
}) {
  if (linked === undefined) return <p className="text-[12.5px] text-dim">Reading…</p>;
  return (
    <div data-github-link className="flex flex-col gap-2">
      {linked ? (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-body">
          <span>
            Linked to <span className="font-medium">@{linked}</span>. A sign-off that only @{linked} may send is offered to you, and asks you to approve a code each time.
          </span>
          <button type="button" onClick={onUnlink} disabled={pending} className="text-link hover:underline disabled:opacity-60">
            Unlink
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
          <span>Not linked. Link it to send a pull request’s sign-off that only you may send, such as Approve pages.</span>
          {!flow && (
            <button
              type="button"
              onClick={onLink}
              disabled={pending}
              className="h-8 rounded-md border border-edge-strong bg-panel px-2.5 text-[12.5px] text-body hover:border-dim disabled:opacity-60"
            >
              Link your GitHub account
            </button>
          )}
        </div>
      )}
      {flow && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[12px] text-soft">Enter this code on GitHub, signed in as your own account. OpenADLC keeps your login and account id, not the sign-in.</p>
          <DeviceCode code={flow.userCode} url={flow.verificationUri} />
        </div>
      )}
      {error && (
        <p role="status" className="text-[12px] text-alarm">
          {error}
        </p>
      )}
    </div>
  );
}
