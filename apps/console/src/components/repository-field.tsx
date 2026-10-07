'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, ExternalIcon } from '@/components/icons';
import { Numbered } from '@/components/numbered';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { accountLine, moreRepositories, ownerOf, type AccountView, type InstallationsView, type Reach, type ReachFix } from '@/lib/app-reach';
import { cn } from '@/lib/cn';
import { poll } from '@/lib/reach';

/**
 * Which repositories the crew works in, chosen from the ones the app can reach.
 *
 * It used to come only from `config/repos.yaml`, committed into the repository,
 * so a clone of OpenADLC arrived pointed at whatever that file said and nobody was
 * asked. The first fix asked — with an empty `owner/name` box, which is a worse
 * question than it looks: it wants exact spelling, it cannot tell you what you
 * have, and it is asked before anything has been set up.
 *
 * So it is asked after the app is installed, because that is the moment GitHub
 * already holds the answer. `GET /installation/repositories` is exactly the set
 * the app can act on, private ones included, and picking from it cannot be
 * misspelled. The text field stays for the case the list cannot be fetched.
 *
 * It took one repository and replaced it with the next one picked. Now each
 * one picked is added beside the others, in the walkthrough and in settings
 * alike, and the ones OpenADLC already works in say so.
 *
 * The list is by account, since the app is installed on each account on its
 * own. A repository typed in that the app cannot reach is not added: it used
 * to be, and then its line in settings could only fail. The bridge says what
 * to do first — install the app on that account, make it public before that —
 * and this waits, adding it as soon as GitHub says the app reaches it.
 */

export interface Available {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

/** A repository typed in that the app cannot reach yet, and what to do about it. */
interface Waiting {
  fullName: string;
  fix: ReachFix;
}

/**
 * `owner/name` as the bridge reads what was typed, in one case: the field
 * takes a GitHub address too, so what was typed and what the bridge says it
 * added are compared through this.
 */
function repositoryKey(text: string): string {
  return text.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
}

function sameRepository(a: string, b: string): boolean {
  return repositoryKey(a) === repositoryKey(b);
}

/** How often a field waiting on an installation asks whether it is done. */
const ASK_EVERY_MS = 5_000;

export function RepositoryField({
  added,
  account = null,
  installUrl,
  onAdded,
  initial,
}: {
  /** The repositories OpenADLC works in now, as `owner/name`. */
  added: readonly string[];
  /** The account the install is for, when the page knows it: where more repositories are got. */
  account?: string | null;
  /**
   * Where to give the app another repository, when the one wanted is absent.
   * Asked of the bridge when not given.
   */
  installUrl?: string | null;
  onAdded: (fullName: string) => void;
  /** What the app can reach, and where it is installed, when already known; asked of GitHub otherwise. */
  initial?: { repositories: Available[]; reason?: string; unknownAccounts?: string[]; installations?: InstallationsView | null };
}) {
  const [available, setAvailable] = useState<Available[] | null>(initial?.repositories ?? null);
  const [reason, setReason] = useState(initial?.reason ?? '');
  // Accounts the app is installed on that the install does not work in: a
  // public app can be installed by anyone, so their repositories are never
  // offered, and an admin allows one first.
  const [unknownAccounts, setUnknownAccounts] = useState<readonly string[]>(initial?.unknownAccounts ?? []);
  const [installations, setInstallations] = useState<InstallationsView | null>(initial?.installations ?? null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  // Each repository typed in that waits on the app. One at a time, adding any
  // other repository dropped the one this had promised to add.
  const [waiting, setWaiting] = useState<readonly Waiting[]>([]);
  // Which of the listed repositories are ticked, to add together. Adding them
  // one button at a time was nine clicks for an organization of nine.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const app = installations?.app ?? null;
  const install = installUrl === undefined ? (app?.installUrl ?? null) : installUrl;
  const more = installations ? moreRepositories(installations, account, install) : null;
  // The page hands a new `onAdded` each time it reads itself again; the
  // repository waiting on the app keeps being asked about all the same.
  const told = useRef(onAdded);
  useEffect(() => {
    told.current = onAdded;
  });

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/onboarding/repositories', { cache: 'no-store' });
      if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
      const body = (await response.json()) as { repositories: Available[]; reason: string; unknownAccounts?: string[] };
      setAvailable(body.repositories);
      setReason(body.reason);
      setUnknownAccounts(body.unknownAccounts ?? []);
    } catch (cause) {
      setAvailable([]);
      setReason(cause instanceof Error ? cause.message : 'could not ask GitHub');
    }
  }, []);

  useEffect(() => {
    if (!initial) void load();
  }, [load, initial]);

  // Where the app is installed: what each account's heading says, and where
  // to install it on another. Nothing is lost without it but the headings.
  useEffect(() => {
    if (initial?.installations !== undefined) return;
    void poll<InstallationsView>('/api/github/installations').then((view) => setInstallations(view));
  }, [initial?.installations]);

  const isAdded = (fullName: string): boolean => added.some((one) => one.toLowerCase() === fullName.toLowerCase());

  const choose = useCallback(
    async (fullName: string): Promise<boolean> => {
      setBusy(fullName);
      setError(null);
      try {
        const response = await fetch('/api/onboarding/repository', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fullName }),
        });
        const text = await response.text();
        const body = (() => {
          try {
            return JSON.parse(text) as { repository?: string; error?: string; needs?: ReachFix };
          } catch {
            return { error: text } as { repository?: string; error?: string; needs?: ReachFix };
          }
        })();
        if (response.status === 409 && body.needs) {
          // Not added: the app goes on first. What to do, and then this waits.
          const fix = body.needs;
          setWaiting((current) => [...current.filter((one) => !sameRepository(one.fullName, fullName)), { fullName, fix }]);
          return false;
        }
        if (!response.ok) throw new Error((body.error ?? text).slice(0, 300));
        const added = body.repository ?? fullName;
        // Only what was added stops waiting, and leaves the box.
        const isIt = (other: string) => sameRepository(other, added) || sameRepository(other, fullName);
        setWaiting((current) => current.filter((one) => !isIt(one.fullName)));
        setTyped((current) => (isIt(current) ? '' : current));
        setLastAdded(added);
        told.current(added);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'could not add the repository');
        return false;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  /**
   * Adds every ticked repository, one after another — the bridge lets the crew
   * into each as it is added, and doing them together would race those
   * invitations. Stops at the first that is not added, with its reason shown,
   * and keeps the rest ticked for another try.
   */
  const addSelected = useCallback(
    async (names: readonly string[]): Promise<void> => {
      setProgress({ done: 0, of: names.length });
      for (const [index, fullName] of names.entries()) {
        const added = await choose(fullName);
        if (!added) break;
        setSelected((current) => {
          const next = new Set(current);
          next.delete(fullName);
          return next;
        });
        setProgress({ done: index + 1, of: names.length });
      }
      setProgress(null);
    },
    [choose],
  );

  // While a repository waits on the app, ask whether it can reach it yet —
  // only while the page is on screen — and add it the moment it can: the
  // person already asked for it. A step done moves the list on to the next.
  useEffect(() => {
    if (waiting.length === 0) return;
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      for (const one of waiting) {
        const answer = await poll<Reach>(`/api/github/reach?repo=${encodeURIComponent(one.fullName)}`);
        if (!answer) continue;
        if (answer.state === 'reachable') {
          setWaiting((current) => current.filter((other) => other !== one));
          void choose(one.fullName);
        } else if (answer.state === 'blocked' && answer.need !== one.fix.need) {
          const { need, title, detail, action, steps } = answer;
          setWaiting((current) =>
            current.map((other) => (other === one ? { fullName: one.fullName, fix: { need, title, detail, action, steps } } : other)),
          );
        }
      }
    }, ASK_EVERY_MS);
    return () => clearInterval(timer);
  }, [waiting, choose]);

  if (available === null) {
    return <p className="text-[13px] text-muted">asking GitHub which repositories the app can reach…</p>;
  }

  const row = (repository: Available) => {
    const already = isAdded(repository.fullName);
    const shape = 'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left';
    return (
      <li key={repository.fullName}>
        {already ? (
          <div className={cn(shape, 'border-signal/40 bg-signal/5')}>
            <span className="min-w-0 truncate font-mono text-[12.5px] text-body">{repository.fullName}</span>
            {repository.private && <Chip>private</Chip>}
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-signal">
              <CheckIcon size={12} />
              OpenADLC works here
            </span>
          </div>
        ) : (
          <label
            className={cn(
              shape,
              'cursor-pointer border-edge-strong bg-surface transition-colors hover:bg-well',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-link',
              selected.has(repository.fullName) && 'border-link/50 bg-link/5',
              progress && 'pointer-events-none opacity-60',
            )}
          >
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-link"
              checked={selected.has(repository.fullName)}
              disabled={progress !== null}
              onChange={(event) => {
                const on = event.target.checked;
                setSelected((current) => {
                  const next = new Set(current);
                  if (on) next.add(repository.fullName);
                  else next.delete(repository.fullName);
                  return next;
                });
              }}
            />
            <span className="min-w-0 truncate font-mono text-[12.5px] text-body">{repository.fullName}</span>
            {repository.private && <Chip>private</Chip>}
            {busy === repository.fullName && <span className="ml-auto shrink-0 text-[11.5px] font-medium text-link">adding…</span>}
          </label>
        )}
      </li>
    );
  };

  return (
    <div className="max-w-lg">
      {available.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-[11px] uppercase tracking-wider text-dim">the app can reach these</p>
            {available.some((repository) => !isAdded(repository.fullName)) && (
              <span className="ml-auto flex items-center gap-3 text-[11.5px]">
                <button
                  type="button"
                  disabled={progress !== null}
                  className="text-link hover:underline disabled:opacity-60"
                  onClick={() => setSelected(new Set(available.filter((one) => !isAdded(one.fullName)).map((one) => one.fullName)))}
                >
                  Select all
                </button>
                <button
                  type="button"
                  disabled={progress !== null || selected.size === 0}
                  className="text-link hover:underline disabled:opacity-60"
                  onClick={() => setSelected(new Set())}
                >
                  Select none
                </button>
              </span>
            )}
          </div>
          {installations?.app ? (
            byAccount(available, installations.accounts).map(({ owner, account, repositories }) => (
              <div key={owner} className="mt-2.5">
                <AccountHeading owner={owner} account={account} />
                <ul className="mt-1.5 space-y-1.5">{repositories.map(row)}</ul>
              </div>
            ))
          ) : (
            <ul className="mt-2 space-y-1.5">{available.map(row)}</ul>
          )}

          {(() => {
            const ticked = available.filter((one) => selected.has(one.fullName) && !isAdded(one.fullName)).map((one) => one.fullName);
            if (ticked.length === 0 && !progress) return null;
            return (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button size="sm" variant="primary" disabled={progress !== null || ticked.length === 0} onClick={() => void addSelected(ticked)}>
                  {progress
                    ? `adding ${Math.min(progress.done + 1, progress.of)} of ${progress.of}…`
                    : `Add ${ticked.length} ${ticked.length === 1 ? 'repository' : 'repositories'}`}
                </Button>
                <span className="text-[11.5px] text-muted">The crew is let into each as it is added.</span>
              </div>
            );
          })()}

          {install && (
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted">
              {installations?.app && more ? (
                <>
                  Not listed?{' '}
                  {more.account ? (
                    <a href={more.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                      {more.kind === 'choose' ? `Choose more of ${more.account}’s repositories ↗` : `Install the app on ${more.account} ↗`}
                    </a>
                  ) : (
                    <>
                      Choose more of an account’s repositories above, or{' '}
                      <a href={more.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                        install the app on another account ↗
                      </a>
                    </>
                  )}
                  {more.account && more.elsewhere && (
                    <>
                      , or{' '}
                      <a href={more.elsewhere} target="_blank" rel="noreferrer" className="text-link hover:underline">
                        install it on another account ↗
                      </a>
                      ,
                    </>
                  )}{' '}
                  and come back — this list is whatever it can reach.
                  {more.account && (
                    // A browser signed in to the crew's accounts opened GitHub as
                    // one of them, and asked for that bot's password: only an
                    // owner of the account can change what the app reaches.
                    <> Open it signed in to GitHub as an owner of {more.account}, not as one of the crew’s accounts.</>
                  )}
                  {more.makePublic && more.account && (
                    <>
                      {' '}
                      It is private to {installations.app.owner.login}, and GitHub installs a private app only on the
                      account that owns it:{' '}
                      <a href={installations.app.advancedUrl} target="_blank" rel="noreferrer" className="text-link hover:underline">
                        make it public ↗
                      </a>{' '}
                      before installing it on {more.account}.
                    </>
                  )}
                </>
              ) : (
                <>
                  Not the one you wanted?{' '}
                  <a href={install} target="_blank" rel="noreferrer" className="text-link hover:underline">
                    give the app another repository ↗
                  </a>{' '}
                  and come back — this list is whatever it can reach.
                </>
              )}
            </p>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-attention/40 bg-attention/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-body">
          Nothing to choose from yet — {reason || 'the app can reach no repositories'}.
          {install && (
            <>
              {' '}
              <a href={more?.url ?? install} target="_blank" rel="noreferrer" className="text-link hover:underline">
                {more?.account && more.kind === 'choose' ? `give the app a repository on ${more.account} ↗` : 'install the app on a repository ↗'}
              </a>{' '}
              and come back.
            </>
          )}
        </div>
      )}

      {unknownAccounts.length > 0 && (
        <div className="mt-3 text-[11.5px] leading-relaxed text-muted">
          <p>
            The app is also installed on {unknownAccounts.join(', ')}, which this install does not work in, so{' '}
            {unknownAccounts.length === 1 ? 'its' : 'their'} repositories are not offered. Anyone can install a public app; allow an
            account only once you have checked it is one you work in.
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {unknownAccounts.map((login) => (
              <AllowAccount key={login} account={login} onAllowed={() => void load()} />
            ))}
          </div>
        </div>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-[11.5px] text-muted hover:text-body">
          or type it, if it is not in that list
        </summary>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && typed.trim()) void choose(typed.trim());
            }}
            aria-label="Repository, as owner/name"
            placeholder="owner/name"
            className="min-w-0 flex-1 rounded-md border border-edge-strong bg-surface px-2.5 py-1.5 text-[12.5px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link"
          />
          <Button size="sm" disabled={!typed.trim() || busy !== null} onClick={() => void choose(typed.trim())}>
            add it
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-dim">
          If the app cannot reach it yet, this says what to do first, and adds it once it can. A full GitHub URL is fine.
        </p>
        {waiting.map((one) => (
          <WaitingForApp
            key={repositoryKey(one.fullName)}
            fullName={one.fullName}
            fix={one.fix}
            onStop={() => setWaiting((current) => current.filter((other) => other !== one))}
          />
        ))}
      </details>

      {lastAdded && !error && (
        <p role="status" className="mt-2 text-[12px] text-signal">
          Added {lastAdded}.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-attention">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The repositories the app reaches, by the account they belong to, in the
 * order the bridge lists accounts: the app's own first. An account the bridge
 * did not name still gets its heading, from the repositories' own names.
 */
export function byAccount(
  available: readonly Available[],
  accounts: readonly AccountView[],
): { owner: string; account: AccountView | null; repositories: Available[] }[] {
  const groups = new Map<string, { owner: string; account: AccountView | null; repositories: Available[] }>();
  for (const account of accounts) {
    groups.set(account.login.toLowerCase(), { owner: account.login, account, repositories: [] });
  }
  for (const repository of available) {
    const owner = ownerOf(repository.fullName);
    const key = owner.toLowerCase();
    const group = groups.get(key) ?? { owner, account: null, repositories: [] };
    group.repositories.push(repository);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.repositories.length > 0);
}

function AccountHeading({ owner, account }: { owner: string; account: AccountView | null }) {
  const settings = account?.installation?.settingsUrl ?? null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
      <span className="font-medium text-body">{owner}</span>
      {account && <span className="text-muted">{accountLine(account)}</span>}
      {settings && (
        <a href={settings} target="_blank" rel="noreferrer" className="ml-auto text-[11.5px] text-link hover:underline">
          Choose repositories ↗
        </a>
      )}
    </div>
  );
}

/**
 * A repository the app cannot reach yet: what to do, in order, each with the
 * page on GitHub where it is done, while the field asks whether it is done.
 */
export function WaitingForApp({ fullName, fix, onStop }: { fullName: string; fix: ReachFix; onStop: () => void }) {
  return (
    <div role="status" className="mt-3 rounded-lg border border-attention/40 bg-attention/5 px-3.5 py-3">
      <p className="text-[12.5px] font-medium text-body">
        The app cannot reach {fullName} yet. {fix.title}.
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">{fix.detail}</p>
      {fix.need === 'allow-account' && <AllowAccount account={ownerOf(fullName)} className="mt-3" />}
      <ol className="mt-3 space-y-3">
        {fix.steps.map((step, index) => (
          <Numbered key={step.text} n={index + 1} title={step.text}>
            <a
              href={step.action.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-strong bg-panel px-2.5 text-[12.5px] text-body hover:border-dim"
            >
              {step.action.label}
              <ExternalIcon size={11} />
            </a>
          </Numbered>
        ))}
      </ol>
      <p className="mt-3 flex flex-wrap items-center gap-x-3 text-[11.5px] text-muted">
        Waiting for GitHub… it is added as soon as the app can reach it.
        <button type="button" onClick={onStop} className="text-link hover:underline">
          Stop waiting
        </button>
      </p>
    </div>
  );
}

/** What allowing an account means, said before it is done. */
export function allowWarning(account: string): string {
  return (
    `Allow ${account}? OpenADLC will work in repositories there: the crew is invited to them, and whoever can write there ` +
    'can answer the crew’s questions. Anyone can install a public app, so check this is an account you work in, not a look-alike.'
  );
}

/**
 * Allows an account the app is installed on beyond those the install works
 * in, after saying what that means. An admin's; the bridge refuses anyone else.
 */
export function AllowAccount({ account, onAllowed, className }: { account: string; onAllowed?: () => void; className?: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | string>('idle');
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-2', className)}>
      <Button
        size="sm"
        disabled={state === 'busy' || state === 'done'}
        onClick={async () => {
          if (!window.confirm(allowWarning(account))) return;
          setState('busy');
          const response = await fetch('/api/github/allowed-accounts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ account, understood: true }),
          }).catch(() => null);
          if (response?.ok) {
            setState('done');
            onAllowed?.();
          } else {
            const body = response ? ((await response.json().catch(() => ({}))) as { error?: string }) : {};
            setState(body.error ?? 'could not ask the bridge');
          }
        }}
      >
        {state === 'done' ? `${account} allowed` : `Allow ${account}`}
      </Button>
      {state !== 'idle' && state !== 'busy' && state !== 'done' && <span className="text-[11.5px] text-attention">{state}</span>}
    </span>
  );
}
