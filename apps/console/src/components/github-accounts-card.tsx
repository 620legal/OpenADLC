'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DeviceCode } from '@/components/device-code';
import { ExternalIcon } from '@/components/icons';
import { SettingsPart } from '@/components/settings-sections';
import { Chip } from '@/components/ui/chip';
import type { GitHubAccountsView, GitHubSignIn } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ACCOUNT_GROUP_TEXT, roleTitle } from '@/lib/crew';
import { poll } from '@/lib/reach';

/** Where GitHub takes the code, when the bridge does not say. */
const DEVICE_URL = 'https://github.com/login/device';

type Account = GitHubAccountsView['accounts'][number];

/** A device flow under way, for no bot, which the bridge answers to by `flowId` until it ends. */
export interface Connecting {
  /** Which control started it: an account's Reconnect, or Connect a GitHub account. */
  key: string;
  /** Who to sign in to GitHub as, in words. */
  who: string;
  /**
   * The account a Reconnect is for; absent for Connect a GitHub account, where
   * any account is the one meant.
   */
  expected?: string;
  /** `mismatch`: GitHub approved the code as another account than `expected`, which the bridge now holds. */
  state: 'starting' | 'waiting' | 'connected' | 'mismatch' | 'failed';
  flowId?: string;
  userCode?: string;
  verificationUri?: string;
  login?: string;
  error?: string;
}

/** Disconnecting one account: under way, or refused in the bridge's words. */
export interface Disconnecting {
  login: string;
  working: boolean;
  error?: string;
}

export const SIGN_IN: Record<GitHubSignIn, { text: string; dot: string; tone: string }> = {
  'signed-in': { text: 'Signed in', dot: 'bg-signal', tone: 'text-signal' },
  'needs-reconnecting': { text: 'Needs reconnecting', dot: 'bg-attention', tone: 'text-attention' },
  'not-signed-in': { text: 'Not signed in', dot: 'border border-dim', tone: 'text-muted' },
};

/** Which group an account serves, as its chip says it. */
export function accountGroupText(group: Account['group']): string {
  if (group === 'crew' || group === 'reviewers') return ACCOUNT_GROUP_TEXT[group].label;
  return group === 'mixed' ? 'Crew and reviewers' : 'Not used by any bot';
}

/** Which bots use an account, in words, or that none does. */
export function usedByText(account: Pick<Account, 'seats'>): string {
  return account.seats.length > 0 ? `Used by ${account.seats.map((seat) => roleTitle(seat)).join(', ')}` : 'Not used by any bot';
}

/**
 * Settings' connected accounts: every GitHub account OpenADLC signs in as, and
 * managing the connection to each — nothing about which bot uses which, which
 * is the crew's to say, row by row.
 *
 * Connecting an account is not tied to a bot: whichever account approves the
 * code is the one OpenADLC holds afterwards, used by nobody until the crew puts
 * a bot on it. Reconnecting is the same flow, and replaces that account's
 * sign-in. An account a bot leaves stays connected; Disconnect is the only way
 * one goes, and the bridge refuses it — and the page does not offer it — while
 * any bot still uses it.
 */
export function GitHubAccountsCard({ view }: { view: GitHubAccountsView | null }) {
  const router = useRouter();
  const [connecting, setConnecting] = useState<Connecting | null>(null);
  const [disconnecting, setDisconnecting] = useState<Disconnecting | null>(null);

  // While a code is outstanding, ask the bridge how it went. It polls GitHub;
  // the browser only asks it for the answer.
  useEffect(() => {
    if (!connecting || connecting.state !== 'waiting' || !connecting.flowId) return;
    const timer = setInterval(async () => {
      // No answer this time is not an answer; the next tick asks again.
      const answer = await poll<{ state: string; login?: string; error?: string }>(
        `/api/github/accounts/connect/${encodeURIComponent(connecting.flowId ?? '')}`,
      );
      if (!answer) return;
      if (answer.state === 'connected') {
        // The bridge stores whichever account approved the code, and a browser
        // still signed in as the admin approves it as the admin. Said as
        // "Connected as" under the row being reconnected, that read as done
        // while the row's account still needed reconnecting.
        const login = answer.login ?? connecting.login;
        const meant = !connecting.expected || login?.toLowerCase() === connecting.expected.toLowerCase();
        setConnecting({ ...connecting, state: meant ? 'connected' : 'mismatch', login });
        router.refresh();
      } else if (answer.state === 'failed') {
        setConnecting({ ...connecting, state: 'failed', error: answer.error });
      } else if (answer.state === 'none') {
        // The bridge restarted, or never had it: a code nobody is waiting on.
        setConnecting({ ...connecting, state: 'failed', error: 'The bridge is no longer waiting on this code.' });
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [connecting, router]);

  const connect = async (key: string, who: string): Promise<void> => {
    const expected = key.startsWith('account:') ? key.slice('account:'.length) : undefined;
    const started = { key, who, ...(expected ? { expected } : {}) };
    setConnecting({ ...started, state: 'starting' });
    try {
      const response = await fetch('/api/github/accounts/connect', { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as { flowId?: string; userCode?: string; verificationUri?: string; error?: string };
      if (!response.ok || !body.flowId) {
        setConnecting({ ...started, state: 'failed', error: body.error ?? 'GitHub did not give a code.' });
        return;
      }
      setConnecting({ ...started, state: 'waiting', flowId: body.flowId, userCode: body.userCode, verificationUri: body.verificationUri });
    } catch {
      setConnecting({ ...started, state: 'failed', error: 'The console is not answering. Try again in a moment.' });
    }
  };

  const disconnect = async (login: string): Promise<void> => {
    if (typeof window !== 'undefined' && !window.confirm(`Disconnect ${login}? OpenADLC forgets its sign-in; using it again means connecting it again.`)) return;
    setDisconnecting({ login, working: true });
    try {
      const response = await fetch('/api/github/accounts/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'The bridge did not disconnect it.');
      setDisconnecting(null);
      router.refresh();
    } catch (cause) {
      setDisconnecting({ login, working: false, error: cause instanceof Error ? cause.message : 'That did not work.' });
    }
  };

  return (
    <SettingsPart id="github-accounts" title="Connected accounts" line="The GitHub accounts OpenADLC signs in as. Which bot uses which is set under Crew.">
      {view ? (
        <GitHubAccountsPanel
          view={view}
          connecting={connecting}
          disconnecting={disconnecting}
          onConnect={(key, who) => void connect(key, who)}
          onDisconnect={(login) => void disconnect(login)}
          onCloseFlow={() => setConnecting(null)}
        />
      ) : (
        <p className="text-[12.5px] text-muted">The bridge did not say which accounts OpenADLC holds just now. Reload to try again.</p>
      )}
    </SettingsPart>
  );
}

/** The part's contents, drawn from what the bridge said; `GitHubAccountsCard` holds the state. */
export function GitHubAccountsPanel({
  view,
  connecting = null,
  disconnecting = null,
  onConnect = () => undefined,
  onDisconnect = () => undefined,
  onCloseFlow = () => undefined,
}: {
  view: GitHubAccountsView;
  connecting?: Connecting | null;
  disconnecting?: Disconnecting | null;
  onConnect?: (key: string, who: string) => void;
  onDisconnect?: (login: string) => void;
  onCloseFlow?: () => void;
}) {
  const busy = connecting?.state === 'starting' || connecting?.state === 'waiting';

  return (
    <div className="flex flex-col">
      {view.accounts.length === 0 ? (
        <p className="border-t border-well py-3 text-[12.5px] text-muted">OpenADLC holds no GitHub account yet. Connect one below.</p>
      ) : (
        <ul aria-label="GitHub accounts OpenADLC holds" className="flex flex-col">
          {view.accounts.map((account) => {
            const sign = SIGN_IN[account.signIn];
            const key = `account:${account.login}`;
            const unused = account.seats.length === 0;
            const mine = disconnecting?.login === account.login ? disconnecting : null;
            return (
              <li key={account.login} className="flex flex-col border-t border-well py-2.5">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                      <a
                        href={account.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-mono font-medium text-body hover:underline"
                      >
                        {account.login}
                        <ExternalIcon size={10} />
                      </a>
                      <span className={cn('inline-flex items-center gap-1.5 text-[12.5px]', sign.tone)}>
                        <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', sign.dot)} />
                        {sign.text}
                      </span>
                      {!unused && <Chip tone={account.group === 'mixed' ? 'alarm' : 'neutral'}>{accountGroupText(account.group)}</Chip>}
                    </span>
                    <span className="text-[12px] text-muted">{usedByText(account)}</span>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => onConnect(key, account.login)}
                      disabled={busy}
                      className={cn(
                        'h-11 flex-1 rounded-md px-3 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-link disabled:opacity-50 md:h-7 md:flex-none md:px-2.5',
                        account.signIn === 'signed-in'
                          ? 'border border-edge bg-panel text-soft hover:border-edge-strong hover:text-body'
                          : 'bg-body font-medium text-surface hover:bg-soft',
                      )}
                    >
                      Reconnect
                    </button>
                    {unused && (
                      <button
                        type="button"
                        onClick={() => onDisconnect(account.login)}
                        disabled={mine?.working}
                        className="h-11 flex-1 rounded-md border border-edge bg-panel px-3 text-[12.5px] text-alarm transition-colors hover:border-alarm/60 focus-visible:outline-2 focus-visible:outline-link disabled:opacity-50 md:h-7 md:flex-none md:px-2.5"
                      >
                        {mine?.working ? 'Disconnecting…' : 'Disconnect'}
                      </button>
                    )}
                  </div>
                </div>
                {!unused && (
                  <p className="mt-1 text-[11.5px] leading-normal text-dim">
                    To disconnect it, move {account.seats.length > 1 ? 'these bots' : 'this bot'} to another account under Crew first.
                  </p>
                )}
                {mine?.error && <p className="mt-1.5 text-[12px] text-alarm">{mine.error}</p>}
                {connecting?.key === key && (
                  <DeviceFlow
                    connecting={connecting}
                    spare={spareLogin(view, connecting.login)}
                    onClose={onCloseFlow}
                    onRetry={() => onConnect(key, connecting.who)}
                    onDisconnect={onDisconnect}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-2 border-t border-well pt-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-2.5">
          <span className="text-[13px] font-medium text-body md:flex-1">Connect a GitHub account</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => onConnect('new', 'the account you want OpenADLC to hold')}
            className="h-11 shrink-0 rounded-md bg-body px-3 text-[12.5px] font-medium text-surface transition-colors hover:bg-soft disabled:opacity-50 md:h-7 md:px-2.5"
          >
            Connect
          </button>
        </div>
        <p className="text-[12px] leading-normal text-muted">
          Sign in to GitHub as the account, not as yourself, and enter the code. It is connected for no bot; put bots on it under Crew.
        </p>
        {connecting?.key === 'new' && (
          <DeviceFlow connecting={connecting} onClose={onCloseFlow} onRetry={() => onConnect('new', connecting.who)} />
        )}
      </div>
    </div>
  );
}

/**
 * The account a mismatched reconnect stored, as the refreshed view lists it,
 * when no bot uses it, so it can be disconnected there. Null for one with
 * bots, which the bridge refuses to disconnect.
 */
function spareLogin(view: GitHubAccountsView, login: string | undefined): string | null {
  if (!login) return null;
  const held = view.accounts.find((account) => account.login.toLowerCase() === login.toLowerCase());
  return held && held.seats.length === 0 ? held.login : null;
}

function DeviceFlow({
  connecting,
  spare = null,
  onClose,
  onRetry,
  onDisconnect = () => undefined,
}: {
  connecting: Connecting;
  spare?: string | null;
  onClose: () => void;
  onRetry: () => void;
  onDisconnect?: (login: string) => void;
}) {
  return (
    <div
      role="status"
      className={cn(
        'mt-2.5 flex flex-col gap-2 rounded-md border px-3 py-2.5 text-[12.5px] leading-normal',
        connecting.state === 'connected'
          ? 'border-signal/40 bg-signal/10'
          : connecting.state === 'failed'
            ? 'border-alarm/40 bg-alarm/10'
            : 'border-attention/40 bg-attention/5',
      )}
    >
      {connecting.state === 'starting' && <p className="text-soft">Asking GitHub for a code…</p>}

      {connecting.state === 'waiting' && (
        <>
          <p className="text-body">
            Sign in to GitHub as <span className="font-medium">{connecting.who}</span> — not as yourself — then enter this code.
            OpenADLC records whichever account approves it.
          </p>
          <DeviceCode code={connecting.userCode ?? ''} url={connecting.verificationUri ?? DEVICE_URL} />
          <p className="flex flex-wrap items-center gap-x-3 text-[12px] text-muted">
            Waiting for you to approve it.
            <button type="button" onClick={onClose} className="text-link hover:underline">
              Hide
            </button>
          </p>
        </>
      )}

      {connecting.state === 'connected' &&
        (connecting.expected ? (
          <p className="text-signal">Reconnected as {connecting.login ?? connecting.expected}.</p>
        ) : (
          <p className="text-signal">Connected{connecting.login ? ` as ${connecting.login}` : ''}. Put a bot on it under Crew.</p>
        ))}

      {connecting.state === 'mismatch' && (
        <p className="flex flex-wrap items-center gap-x-3 text-attention">
          <span>
            {connecting.login
              ? `GitHub approved the code as ${connecting.login}, not ${connecting.expected}.`
              : 'GitHub approved the code without saying which account approved it.'}{' '}
            {connecting.expected} still needs reconnecting: sign in to GitHub as {connecting.expected} and try again.
          </span>
          <button type="button" onClick={onRetry} className="text-link hover:underline">
            Try again
          </button>
          {spare && (
            <button type="button" onClick={() => onDisconnect(spare)} className="text-alarm hover:underline">
              Disconnect {spare}
            </button>
          )}
        </p>
      )}

      {connecting.state === 'failed' && (
        <p className="flex flex-wrap items-center gap-x-3 text-alarm">
          {connecting.error ?? 'That did not work.'}
          <button type="button" onClick={onRetry} className="text-link hover:underline">
            Try again
          </button>
        </p>
      )}
    </div>
  );
}
