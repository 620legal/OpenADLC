'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Copyable } from '@/components/copyable';
import { Numbered } from '@/components/numbered';
import { cn } from '@/lib/cn';
import {
  KEY_LINKS,
  NOT_VERIFIED_COPY,
  PROVIDERS,
  PROVIDER_LABEL,
  SETUP_TOKEN_COMMAND,
  SETUP_TOKEN_HOW,
  SIGN_IN_COPY,
  SIGN_IN_WAITING_COPY,
  SUBSCRIPTION_SEAT,
  SUBSCRIPTION_TERMS,
  TOKEN_SAVE_COPY,
  accountKindLine,
  accountRemovePath,
  accountStanding,
  accountTags,
  accountsFrom,
  addAccount,
  asSentence,
  checkedWhen,
  credentialOf,
  crewFromEngines,
  defaultAccountLabel,
  followSignIn,
  keyLinkFor,
  listModelsFor,
  offeredLine,
  readBridgeError,
  readSignIn,
  saveCredential,
  saveTokenAndVerify,
  setupTokenProblem,
  startSignIn,
  verifyAccount,
  type AccountCredential,
  type AccountKind,
  type AccountListing,
  type AccountRef,
  type AccountStanding,
  type CheckOutcome,
  type CrewBot,
  type LoginState,
  type Provider,
} from '@/lib/model-onboarding';

/**
 * The credential, added once, and then out of the way.
 *
 * The step this replaces took a key per bot, so nine bots on one Anthropic
 * account meant pasting the same secret nine times, and a subscription could
 * not be said at all. A key is verified by listing models before it is stored.
 * A Claude seat takes the token `claude setup-token` prints, and an OpenAI or
 * xAI seat is signed in from here: hostd runs the CLI's own device sign-in and
 * this shows the link and the code. One sign-in serves every bot on the
 * account.
 *
 * It is laid out the way the crew step is. An account still being set up is
 * on the left, as numbered steps — the command to copy and the token it
 * printed, or Sign in and the code — and saving the token, or finishing the
 * sign-in, is the check: one tiny prompt through the seat. An account that
 * passes moves to the verified panel on the right, where it asks for nothing.
 * It used to stay where it was, with its token field and a Verify button, and
 * nothing said it was done, so people pressed Verify again and again. Checking
 * again is still there, as a quiet link, for when something changed.
 *
 * Settings' AI models section is this same step (`place="settings"`), so an
 * account is added, signed in, checked and removed one way wherever it is
 * done. There, each verified account also says which models it offers, and
 * nothing speaks of continuing to a next step.
 */

export function AccountsStep({
  accounts,
  crew,
  onAccounts,
  onCrew,
  place = 'walkthrough',
}: {
  accounts: AccountRef[] | null;
  crew: CrewBot[] | null;
  onAccounts: (accounts: AccountRef[]) => void;
  onCrew: (crew: CrewBot[]) => void;
  place?: 'walkthrough' | 'settings';
}) {
  /** Null until somebody chooses: the form starts open only when there is nothing yet. */
  const [adding, setAdding] = useState<boolean | null>(null);
  /** A verified account whose credential is being given again, from its quiet link. */
  const [again, setAgain] = useState<string | null>(null);
  /**
   * Per account, what a check could not say — the bridge refusing to ask, not
   * a verdict. Kept here because an account being added gets its first check
   * from the form, which is gone by the time the answer is worth showing.
   */
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  /** What each verified account offers, by id: asked in settings only, where the list is the point. */
  const [listings, setListings] = useState<Record<string, AccountListing>>({});

  // The parent's callbacks are read through a ref, so a parent that passes a
  // new function on every render does not make a new `load`. When `load`
  // followed their identity, each read re-rendered the parent, which made a
  // new `load`, which read again: the settings page asked the bridge, and
  // through it hostd, for the accounts and the engines without end.
  const callbacks = useRef({ onAccounts, onCrew });
  callbacks.current = { onAccounts, onCrew };

  const load = useCallback(async () => {
    try {
      const [accountsResponse, enginesResponse] = await Promise.all([
        fetch('/api/model-accounts', { cache: 'no-store' }),
        fetch('/api/engines', { cache: 'no-store' }),
      ]);
      if (!accountsResponse.ok) throw new Error(await readBridgeError(accountsResponse));
      callbacks.current.onAccounts(accountsFrom(await accountsResponse.json()));
      if (enginesResponse.ok) {
        const body = (await enginesResponse.json()) as { reachable?: boolean };
        setReachable(body.reachable !== false);
        callbacks.current.onCrew(crewFromEngines(body));
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not load accounts');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Asked again whenever the verified accounts change: one added or removed,
  // and one signed in again, given a new token or checked, which moves its
  // `verifiedAt` — an account whose listing failed would otherwise keep
  // saying so until the page was reloaded.
  const listed = place === 'settings' && accounts && crew
    ? accounts
        .filter((account) => accountStanding(account, crew).verified)
        .map((account) => `${account.id}@${account.verifiedAt ?? ''}`)
        .join(',')
    : '';
  useEffect(() => {
    if (!listed || !accounts) return;
    let current = true;
    const ids = new Set(listed.split(',').map((entry) => entry.split('@')[0]));
    void listModelsFor(accounts.filter((account) => ids.has(account.id))).then((found) => {
      if (current) setListings(found);
    });
    return () => {
      current = false;
    };
    // `accounts` is read for the ids `listed` names; a new array with the same ones asks nothing.
  }, [listed]);

  if (!accounts) {
    return <p className="text-[13px] text-muted">{error ?? 'asking which accounts are stored…'}</p>;
  }

  const bots = crew ?? [];
  const placed = accounts.map((account) => ({ account, standing: accountStanding(account, bots) }));
  const verified = placed.filter((one) => one.standing.verified);
  const unfinished = placed.filter((one) => !one.standing.verified || one.account.id === again);
  const showForm = adding ?? accounts.length === 0;

  function note(id: string, message: string | null): void {
    setNotes((current) => {
      const next = { ...current };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });
  }

  return (
    // The crew step's grid: the panel sits beside the steps on a wide screen
    // and below them on a narrow one.
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="min-w-0 max-w-xl space-y-4">
        <p className="text-[13px] leading-relaxed text-muted">
          One account is one credential. Every bot you put on it uses that same credential — a key pasted once, or a
          subscription signed in once — and changing it later is one edit.
        </p>

        {place === 'settings' && accounts.length === 0 && (
          <p className="text-[12.5px] leading-relaxed text-body">
            No model account yet. Add the first one below: an Anthropic, OpenAI or xAI API key, or, where the
            provider’s terms allow it, a Claude subscription’s token or an OpenAI or xAI subscription signed in from
            here. Then choose which bot uses it under Crew.
          </p>
        )}

        <p className="rounded-lg border border-attention/40 bg-attention/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-body">
          {SUBSCRIPTION_SEAT} {SUBSCRIPTION_TERMS}
        </p>

        {reachable === false && (
          <p className="text-[12px] leading-relaxed text-attention">
            OpenADLC’s host service (hostd), which runs the bots, is not answering, so nothing can be signed in or checked. Run{' '}
            <code className="font-mono">fleetadlc up</code> on the machine OpenADLC runs on (
            <code className="font-mono">fleetadlc doctor</code> says why it stopped), then reload this page.
          </p>
        )}

        {unfinished.map(({ account, standing }) => (
          <AccountSetup
            key={account.id}
            account={account}
            standing={standing}
            again={account.id === again}
            crew={bots}
            note={notes[account.id] ?? null}
            onNote={(message) => note(account.id, message)}
            onDone={() => {
              // Only this account's: another may be having its token replaced.
              setAgain((current) => (current === account.id ? null : current));
              void load();
            }}
            onCancel={() => setAgain(null)}
            onChanged={() => void load()}
          />
        ))}

        {showForm ? (
          <AddAccount
            crew={bots}
            onCancel={() => setAdding(false)}
            onAdded={(id, message) => {
              setAdding(false);
              note(id, message);
              void load();
            }}
          />
        ) : (
          <div className="space-y-2">
            {accounts.length > 0 && unfinished.length === 0 && (
              <p className="text-[12.5px] leading-relaxed text-muted">
                {place === 'settings'
                  ? 'Every account here is verified. Add another, and choose which bot uses which under Crew.'
                  : 'Every account here is verified. Add another, or continue.'}
              </p>
            )}
            <Button size="sm" variant={accounts.length === 0 ? 'primary' : 'secondary'} onClick={() => setAdding(true)}>
              {accounts.length === 0 ? 'Add account' : 'Add another account'}
            </Button>
          </div>
        )}

        {error && <p className="text-[12px] text-attention">{error}</p>}
      </div>

      <VerifiedAccounts
        entries={verified}
        crew={bots}
        again={again}
        listings={place === 'settings' ? listings : null}
        onAgain={setAgain}
        onChanged={() => void load()}
      />
    </div>
  );
}

function Mark({ mark }: { mark: '✓' | '~' | '×' }) {
  return (
    <span
      className={cn(
        'mr-1.5 font-mono',
        mark === '✓' && 'text-signal',
        mark === '~' && 'text-attention',
        mark === '×' && 'text-alarm',
      )}
    >
      {mark}
    </span>
  );
}

/** The crew step's quiet link: there when needed, and nothing that asks to be pressed. */
function Quiet({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-[11px] text-soft underline hover:text-body disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** What giving a verified account its credential again is called, by how it is given. */
const AGAIN: Record<AccountCredential, { link: string; doing: string }> = {
  token: { link: 'replace token', doing: 'replacing the token' },
  'sign-in': { link: 'sign in again', doing: 'signing in again' },
  key: { link: 'replace key', doing: 'replacing the key' },
};

async function removeAccount(id: string): Promise<string | null> {
  try {
    const response = await fetch(accountRemovePath(id), { method: 'POST' });
    return response.ok ? null : await readBridgeError(response);
  } catch (cause) {
    return cause instanceof Error ? cause.message : 'could not remove that';
  }
}

/**
 * An account still being set up: its next step, numbered, and — when a check
 * said no — the cross and the CLI's own words just above it.
 */
function AccountSetup({
  account,
  standing,
  again,
  crew,
  note,
  onNote,
  onDone,
  onCancel,
  onChanged,
}: {
  account: AccountRef;
  standing: AccountStanding;
  /** A verified account whose credential is being given again. */
  again: boolean;
  crew: CrewBot[];
  note: string | null;
  onNote: (message: string | null) => void;
  /**
   * The credential was given or a check ran, whatever it said: this is no
   * longer being given again, and the account is read afresh — it may have
   * moved to the verified side.
   */
  onDone: () => void;
  onCancel: () => void;
  onChanged: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = again ? credentialOf(account) : standing.next;
  const failed = !again && standing.mark === '×';

  function checked(outcome: CheckOutcome): void {
    onNote(outcome.error);
    onDone();
  }

  async function check(): Promise<void> {
    setChecking(true);
    onNote(null);
    const outcome = await verifyAccount(account.id);
    setChecking(false);
    checked(outcome);
  }

  async function remove(): Promise<void> {
    setRemoving(true);
    setError(null);
    const refused = await removeAccount(account.id);
    setRemoving(false);
    if (refused) setError(refused);
    else onChanged();
  }

  return (
    <section className="rounded-lg border border-edge bg-surface p-3.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-[13px] font-medium text-body">{account.label}</h3>
        <span className="text-[11.5px] text-dim">{accountKindLine(account)}</span>
        <span className="ml-auto text-[11px] text-muted">
          {again ? (
            AGAIN[credentialOf(account)].doing
          ) : failed ? (
            account.verifiedAt ? `checked ${checkedWhen(account.verifiedAt)}` : null
          ) : (
            <>
              <Mark mark={standing.mark} />
              {NOT_VERIFIED_COPY}
            </>
          )}
        </span>
      </div>

      {failed && (
        <p className="mt-2 text-[12px] leading-relaxed text-alarm">
          <Mark mark="×" />
          {asSentence(standing.detail ?? 'the last check failed')}
        </p>
      )}

      <div className="mt-3">
        {next === 'token' && <TokenSteps account={account} onChecked={checked} />}
        {next === 'sign-in' && <SignInSteps account={account} onChecked={checked} />}
        {next === 'key' && (
          <KeySteps
            account={account}
            crew={crew}
            onSaved={() => {
              onNote(null);
              onDone();
            }}
          />
        )}
        {next === 'command' && (
          <ol className="space-y-4">
            <Numbered n={1} title="Put the command where the bots run">
              <p className="max-w-lg text-[11px] leading-relaxed text-dim">
                The credential was proved already; it is the command that is missing. Install it where the bots run.
              </p>
            </Numbered>
            <Numbered n={2} title="Check it again">
              <Button size="sm" variant="primary" disabled={checking} onClick={() => void check()}>
                {checking ? 'checking…' : 'Check again'}
              </Button>
            </Numbered>
          </ol>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        {!again && next !== 'command' && (
          <Quiet onClick={() => void check()} disabled={checking || removing}>
            {checking ? 'checking…' : account.verifiedAt ? 'check again' : 'check it'}
          </Quiet>
        )}
        {again ? (
          <Quiet onClick={onCancel}>cancel</Quiet>
        ) : (
          <Quiet onClick={() => void remove()} disabled={checking || removing}>
            {removing ? 'removing…' : 'remove'}
          </Quiet>
        )}
      </div>
      {checking && next !== 'command' && (
        <p className="mt-1.5 text-[11px] text-muted">checking — one tiny prompt through the account…</p>
      )}
      {(note ?? error) && <p className="mt-1.5 text-[11px] text-attention">{note ?? error}</p>}
    </section>
  );
}

/**
 * A Claude seat's two steps: the command to copy, and the token it printed.
 * Numbered from `first`, so the form that adds an account can put its own
 * three before them. The field is a password field, never written anywhere
 * but the request that stores it.
 */
function SetupTokenSteps({
  first,
  token,
  onToken,
  problem,
  disabled,
  children,
}: {
  first: number;
  token: string;
  onToken: (token: string) => void;
  problem: string | null;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <Numbered n={first} title="Copy the command">
        <Copyable value={SETUP_TOKEN_COMMAND} className="max-w-xs" />
        <p className="mt-1.5 max-w-lg text-[11px] leading-relaxed text-dim">{SETUP_TOKEN_HOW}</p>
      </Numbered>
      <Numbered n={first + 1} title="Paste the token it printed">
        <input
          type="password"
          aria-label="Token"
          value={token}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onToken(event.target.value)}
          placeholder="sk-ant-oat…"
          className="w-full rounded-md border border-edge-strong bg-panel px-2.5 py-1.5 font-mono text-[11.5px] text-body placeholder:text-dim"
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-dim">{TOKEN_SAVE_COPY}</p>
        {problem && <p className="mt-1 text-[11px] text-attention">{problem}</p>}
        <div className="mt-2">{children}</div>
      </Numbered>
    </>
  );
}

/** A Claude seat's token, pasted on the account: saved, and checked straight away. */
function TokenSteps({ account, onChecked }: { account: AccountRef; onChecked: (outcome: CheckOutcome) => void }) {
  const [token, setToken] = useState('');
  const [phase, setPhase] = useState<'idle' | 'saving' | 'checking'>('idle');
  const [refused, setRefused] = useState<string | null>(null);
  const problem = setupTokenProblem(token);

  async function save(): Promise<void> {
    setPhase('saving');
    setRefused(null);
    const outcome = await saveTokenAndVerify(account.id, token, {
      saved: () => {
        setToken('');
        setPhase('checking');
      },
    });
    setPhase('idle');
    if (outcome.refused) setRefused(outcome.refused);
    else onChecked(outcome);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (phase === 'idle' && token.trim() && !problem) void save();
      }}
    >
      <ol className="space-y-4">
        <SetupTokenSteps first={1} token={token} onToken={setToken} problem={problem} disabled={phase !== 'idle'}>
          <Button type="submit" size="sm" variant="primary" disabled={phase !== 'idle' || !token.trim() || Boolean(problem)}>
            {phase === 'saving' ? 'saving…' : phase === 'checking' ? 'verifying…' : 'Save and verify'}
          </Button>
          {phase === 'checking' && (
            <p className="mt-1.5 text-[11px] text-muted">verifying — one tiny prompt through the subscription…</p>
          )}
          {refused && <p className="mt-1.5 text-[11px] text-attention">{refused}</p>}
        </SetupTokenSteps>
      </ol>
    </form>
  );
}

/**
 * An OpenAI or xAI seat, signed in from here, as two steps.
 *
 * hostd runs the CLI's device sign-in against the account's own directory
 * and answers with a link and a one-time code. They are shown until the
 * operator has finished in their browser, then the account is checked. A
 * sign-in already under way — the page was reloaded — is picked up again.
 */
function SignInSteps({ account, onChecked }: { account: AccountRef; onChecked: (outcome: CheckOutcome) => void }) {
  const [state, setState] = useState<LoginState | null>(null);
  const [starting, setStarting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const following = useRef<AbortController | null>(null);
  // The parent hands a new function every render; the sign-in being followed
  // must not be dropped and picked up again each time it does.
  const checked = useRef(onChecked);
  checked.current = onChecked;

  const follow = useCallback(
    (from: LoginState, controller: AbortController = new AbortController()) => {
      if (following.current !== controller) following.current?.abort();
      following.current = controller;
      void followSignIn(
        account.id,
        from,
        {
          state: (next) => {
            if (controller.signal.aborted) return;
            setState(next);
            if (next.state === 'signed-in') setVerifying(true);
          },
          check: (outcome) => {
            if (controller.signal.aborted) return;
            setVerifying(false);
            checked.current(outcome);
          },
        },
        { signal: controller.signal },
      );
    },
    [account.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void readSignIn(account.id).then((current) => {
      if (controller.signal.aborted || !current) return;
      if (current.state === 'waiting') follow(current);
      else setState(current);
    });
    return () => {
      controller.abort();
      following.current?.abort();
    };
  }, [account.id, follow]);

  async function signIn(): Promise<void> {
    // Registered before hostd is asked, which can take seconds: a step that
    // went in that time made its controller afterwards, which nothing then
    // aborted, and the sign-in was polled for sixteen minutes and then checked.
    const controller = new AbortController();
    following.current?.abort();
    following.current = controller;
    setStarting(true);
    const started = await startSignIn(account.id);
    if (controller.signal.aborted) return;
    setStarting(false);
    follow(started, controller);
  }

  const waiting = state?.state === 'waiting' ? state : null;
  const provider = PROVIDER_LABEL[account.provider];

  return (
    <ol className="space-y-4">
      <Numbered n={1} title="Press Sign in">
        <Button
          size="sm"
          variant="primary"
          disabled={starting || verifying || waiting !== null}
          onClick={() => void signIn()}
        >
          {starting
            ? 'starting the sign-in…'
            : state?.state === 'failed' || state?.state === 'signed-in'
              ? 'Sign in again'
              : 'Sign in'}
        </Button>
        <p className="mt-1.5 max-w-lg text-[11px] leading-relaxed text-dim">{SIGN_IN_COPY}</p>
      </Numbered>
      <Numbered n={2} title="Open the link and enter the code">
        {waiting ? (
          <div className="rounded-md border border-attention/40 bg-attention/5 px-3 py-2.5">
            <p className="text-[11.5px] text-body">
              Open{' '}
              <a href={waiting.url} target="_blank" rel="noreferrer noopener" className="text-link hover:underline">
                {waiting.url} ↗
              </a>{' '}
              and sign in to the {provider} subscription, then enter this code:
            </p>
            <div className="my-2">
              <SignInCode code={waiting.code} />
            </div>
            <p className="text-[11px] text-muted">{SIGN_IN_WAITING_COPY}</p>
          </div>
        ) : verifying ? (
          <p className="text-[11px] text-muted">Signed in — verifying with one tiny prompt…</p>
        ) : state?.state === 'signed-in' ? (
          <p className="max-w-lg text-[11px] leading-relaxed text-dim">
            It is signed in here already. Sign in again for a new login; it is checked as soon as that finishes.
          </p>
        ) : (
          <p className="max-w-lg text-[11px] leading-relaxed text-dim">
            A link and a one-time code appear here once you press Sign in. Sign in to the {provider} subscription
            there, and enter the code; the account is checked as soon as you have.
          </p>
        )}
        {state?.state === 'failed' && <p className="mt-1.5 text-[11px] text-alarm">{asSentence(state.message)}</p>}
      </Numbered>
    </ol>
  );
}

/** The one-time code, large enough to read across a room and a button to copy. */
function SignInCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard permission can be refused; the text is selectable regardless.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title="click to copy"
      className={cn(
        'rounded-md border px-3 py-1.5 font-mono text-2xl tracking-[0.25em] text-attention transition-colors',
        copied ? 'border-signal/60 bg-signal/10' : 'border-attention/40 bg-attention/5 hover:border-attention/70',
      )}
    >
      <span className="select-all">{code}</span>
      <span className="ml-3 align-middle font-sans text-[10.5px] tracking-normal text-dim">{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}

/**
 * A key account's new key. The bridge lists models with it before it replaces
 * the old one, so a paste that cannot is refused in the provider's words and
 * the key the bots are using is left alone. That listing is the proof a key
 * gets, here as when it was added.
 */
function KeySteps({ account, crew, onSaved }: { account: AccountRef; crew: CrewBot[]; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const link = keyLinkFor(account.provider, crew);

  async function save(): Promise<void> {
    setBusy(true);
    setRefused(null);
    const refusal = await saveCredential(account.id, key);
    setBusy(false);
    if (refusal) {
      setRefused(refusal);
      return;
    }
    setKey('');
    onSaved();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && key.trim()) void save();
      }}
    >
      <ol className="space-y-4">
        <Numbered n={1} title="Get a new key">
          <a href={link.url} target="_blank" rel="noreferrer" className="text-[11.5px] text-link hover:underline">
            get a key from {link.label} ↗
          </a>
        </Numbered>
        <Numbered n={2} title="Paste it">
          <input
            type="password"
            aria-label="API key"
            value={key}
            autoComplete="new-password"
            onChange={(event) => setKey(event.target.value)}
            placeholder={KEY_LINKS[account.provider].envVar}
            className="w-full rounded-md border border-edge-strong bg-panel px-2.5 py-1.5 font-mono text-[11.5px] text-body placeholder:text-dim"
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-dim">
            It is checked against the provider before it replaces the old one.
          </p>
          {refused && <p className="mt-1 text-[11px] text-attention">{refused}</p>}
          <div className="mt-2">
            <Button type="submit" size="sm" variant="primary" disabled={busy || !key.trim()}>
              {busy ? 'checking…' : 'Save the key'}
            </Button>
          </div>
        </Numbered>
      </ol>
    </form>
  );
}

/**
 * The accounts that are done, beside the ones that are not.
 *
 * The crew step's "connected so far", for the same reason: with everything
 * in one column, an account that was finished looked like one that was not —
 * the same token field, the same Verify — and the only way to tell was to read
 * each row's small print. Here, being in the panel is the answer. What an
 * entry offers is quiet, so checking again is possible and not invited.
 */
function VerifiedAccounts({
  entries,
  crew,
  again,
  listings = null,
  onAgain,
  onChanged,
}: {
  entries: { account: AccountRef; standing: AccountStanding }[];
  crew: CrewBot[];
  again: string | null;
  /** What each offers, by id, where that is shown; null where it is not. */
  listings?: Record<string, AccountListing> | null;
  onAgain: (id: string) => void;
  onChanged: () => void;
}) {
  return (
    <aside className="self-start rounded-lg border border-edge bg-panel/40 p-3">
      <div className="flex items-center gap-2">
        <p className="text-[11px] uppercase tracking-wider text-dim">verified</p>
        {entries.length > 0 && <Chip tone="signal">{entries.length}</Chip>}
      </div>

      {entries.length === 0 ? (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
          None yet. Each account appears here once it has answered a check, so you can see at a glance which are done.
        </p>
      ) : (
        <div className="mt-2.5 space-y-2">
          {entries.map(({ account, standing }) => (
            <VerifiedEntry
              key={account.id}
              account={account}
              detail={standing.detail}
              crew={crew}
              current={account.id === again}
              offered={listings ? (offeredLine(listings[account.id]) ?? { text: 'asking what it offers…', tone: 'plain' }) : null}
              onAgain={() => onAgain(account.id)}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      <p className="mt-2.5 text-[10.5px] leading-relaxed text-dim">
        A check sends one tiny prompt through the account and keeps what happened. A key is checked by the provider
        before it is stored.
      </p>
    </aside>
  );
}

export function VerifiedEntry({
  account,
  detail,
  crew,
  current,
  offered = null,
  onAgain,
  onChanged,
}: {
  account: AccountRef;
  detail: string | null;
  crew: CrewBot[];
  /** Having its credential given again, on the left. */
  current: boolean;
  /** The models it offers, in a line, where that is shown. */
  offered?: { text: string; tone: 'plain' | 'error' } | null;
  onAgain: () => void;
  onChanged: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check(): Promise<void> {
    setChecking(true);
    setError(null);
    const outcome = await verifyAccount(account.id);
    setChecking(false);
    // A check that ran is on the account now, and a failure moves it back to
    // the left with the CLI's words. One that could not run is said here.
    if (outcome.error) setError(outcome.error);
    onChanged();
  }

  async function remove(): Promise<void> {
    setRemoving(true);
    setError(null);
    const refused = await removeAccount(account.id);
    setRemoving(false);
    if (refused) setError(refused);
    else onChanged();
  }

  return (
    <div className={cn('rounded-md border p-2.5', current ? 'border-signal/50 bg-signal/10' : 'border-edge bg-surface')}>
      <div className="flex items-center gap-0.5">
        <Mark mark="✓" />
        <span className="truncate text-[12px] font-medium text-body">{account.label}</span>
      </div>
      <p className="mt-0.5 text-[11px] text-muted">{accountKindLine(account)}</p>
      <p className="mt-1 text-[10.5px] text-dim">{checking ? 'checking — one tiny prompt…' : detail}</p>
      {offered && (
        <p className={cn('mt-1 break-words text-[11px] leading-snug', offered.tone === 'error' ? 'text-attention' : 'text-soft')}>
          {offered.text}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {accountTags(account, crew).map((tag) => (
          <Chip key={tag.label} tone={tag.tone} title={tag.names}>
            {tag.label}
          </Chip>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        <Quiet onClick={() => void check()} disabled={checking || removing}>
          {checking ? 'checking…' : 'check again'}
        </Quiet>
        {!current && (
          <Quiet onClick={onAgain} disabled={checking || removing}>
            {AGAIN[credentialOf(account)].link}
          </Quiet>
        )}
        <Quiet onClick={() => void remove()} disabled={checking || removing}>
          {removing ? 'removing…' : 'remove'}
        </Quiet>
      </div>
      {error && <p className="mt-1.5 text-[11px] text-attention">{error}</p>}
    </div>
  );
}

/**
 * Adding one, as numbered steps: the provider, how you pay and a label, then
 * what that kind of account needs. A Claude seat's two steps are the same
 * ones it gets on the account later, and the token is checked as it is added.
 */
function AddAccount({
  crew,
  onCancel,
  onAdded,
}: {
  crew: CrewBot[];
  onCancel: () => void;
  /** The new account, and what its first check could not say, if anything. */
  onAdded: (id: string, note: string | null) => void;
}) {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [kind, setKind] = useState<AccountKind>('key');
  const [label, setLabel] = useState(defaultAccountLabel('anthropic', 'key'));
  const [labelEdited, setLabelEdited] = useState(false);
  const [key, setKey] = useState('');
  const [token, setToken] = useState('');
  const [phase, setPhase] = useState<'idle' | 'adding' | 'checking'>('idle');
  const [error, setError] = useState<string | null>(null);

  function chooseProvider(next: Provider): void {
    setProvider(next);
    if (!labelEdited) setLabel(defaultAccountLabel(next, kind));
    if (next !== 'anthropic') setToken('');
  }

  function chooseKind(next: AccountKind): void {
    setKind(next);
    if (!labelEdited) setLabel(defaultAccountLabel(provider, next));
    if (next === 'subscription') setKey('');
    else setToken('');
  }

  const link = keyLinkFor(provider, crew);
  const seatToken = kind === 'subscription' && provider === 'anthropic';
  const tokenProblem = seatToken ? setupTokenProblem(token) : null;
  const incomplete =
    label.trim().length === 0 ||
    (kind === 'key' && key.trim().length === 0) ||
    (seatToken && (token.trim().length === 0 || tokenProblem !== null));

  async function submit(): Promise<void> {
    setPhase('adding');
    setError(null);
    const added = await addAccount(
      { provider, kind, label, key, token },
      {
        added: () => {
          if (seatToken) setPhase('checking');
        },
      },
    );
    setPhase('idle');
    if (added.refused || !added.id) {
      setError(added.refused ?? 'the bridge did not say which account it added');
      return;
    }
    setKey('');
    setToken('');
    onAdded(added.id, added.checked?.error ?? null);
  }

  const actions = (
    <>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={phase !== 'idle' || incomplete}>
          {phase === 'adding'
            ? kind === 'key'
              ? 'checking the key…'
              : 'adding…'
            : phase === 'checking'
              ? 'verifying…'
              : kind === 'key'
                ? 'Verify and add'
                : seatToken
                  ? 'Add and verify'
                  : 'Add account'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={phase !== 'idle'} onClick={onCancel}>
          cancel
        </Button>
      </div>
      {phase === 'checking' && (
        <p className="mt-1.5 text-[11px] text-muted">verifying — one tiny prompt through the subscription…</p>
      )}
    </>
  );

  const field =
    'w-full rounded-md border border-edge-strong bg-panel px-2.5 py-1.5 text-[12.5px] text-body placeholder:text-dim';

  return (
    <form
      className="rounded-lg border border-edge bg-surface p-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (phase === 'idle' && !incomplete) void submit();
      }}
    >
      <h3 className="text-[13px] font-medium text-body">Add an account</h3>
      <ol className="mt-3 space-y-4">
        <Numbered n={1} title="Choose the provider">
          <select
            aria-label="Provider"
            value={provider}
            disabled={phase !== 'idle'}
            onChange={(event) => chooseProvider(event.target.value as Provider)}
            className={field}
          >
            {PROVIDERS.map((one) => (
              <option key={one} value={one}>
                {PROVIDER_LABEL[one]}
              </option>
            ))}
          </select>
        </Numbered>

        <Numbered n={2} title="Choose how you pay">
          <fieldset className="flex flex-col gap-1.5" disabled={phase !== 'idle'}>
            <legend className="sr-only">How you pay</legend>
            <label className="flex items-center gap-2 text-[12.5px] text-body">
              <input type="radio" name="account-kind" checked={kind === 'key'} onChange={() => chooseKind('key')} />
              an API key (recommended)
            </label>
            <label className="flex items-center gap-2 text-[12.5px] text-body">
              <input
                type="radio"
                name="account-kind"
                checked={kind === 'subscription'}
                onChange={() => chooseKind('subscription')}
              />
              a subscription, if the provider’s terms allow it
            </label>
          </fieldset>
        </Numbered>

        <Numbered n={3} title="Give it a label">
          <input
            aria-label="A label"
            value={label}
            disabled={phase !== 'idle'}
            onChange={(event) => {
              setLabelEdited(true);
              setLabel(event.target.value);
            }}
            className={field}
          />
        </Numbered>

        {kind === 'key' ? (
          <Numbered n={4} title="Paste the API key">
            <input
              type="password"
              aria-label="API key"
              value={key}
              disabled={phase !== 'idle'}
              autoComplete="new-password"
              onChange={(event) => setKey(event.target.value)}
              placeholder={KEY_LINKS[provider].envVar}
              className={cn(field, 'font-mono text-[11.5px]')}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-dim">
              <a href={link.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                get a key from {link.label} ↗
              </a>{' '}
              — it is checked against the provider before it is stored. A key that cannot list models is refused,
              in the provider’s own words.
            </p>
            <div className="mt-2">{actions}</div>
          </Numbered>
        ) : seatToken ? (
          <SetupTokenSteps first={4} token={token} onToken={setToken} problem={tokenProblem} disabled={phase !== 'idle'}>
            {actions}
          </SetupTokenSteps>
        ) : (
          <Numbered n={4} title="Add it, then sign it in">
            <p className="max-w-lg text-[11px] leading-relaxed text-dim">
              {SIGN_IN_COPY} Once it is added it waits here with Sign in, which shows a link and a one-time code to
              enter in your browser.
            </p>
            <div className="mt-2">{actions}</div>
          </Numbered>
        )}
      </ol>

      {error && <p className="mt-3 text-[12px] text-attention">{error}</p>}
    </form>
  );
}
