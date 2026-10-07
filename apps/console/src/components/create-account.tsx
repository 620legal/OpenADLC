'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Chip } from '@/components/ui/chip';
import { Copyable } from '@/components/copyable';
import { ExternalIcon } from '@/components/icons';
import { Numbered } from '@/components/numbered';
import { seatFor, type BotFacts } from '@/lib/bot-label';

interface Suggestion {
  suggestion: string | null;
  /** False when nothing could be checked, or every candidate is taken. */
  confirmedFree: boolean;
  /** True when GitHub answered for everything and all of it was taken. */
  allTaken: boolean;
  checked: { login: string; available: boolean | null }[];
}

/**
 * Where the username for a bot's account is asked for.
 *
 * From its seat — the role, and the bridge adds the owner's handle — never from
 * what the bot is called. A connected bot's name is its account's handle, so
 * there is nothing to suggest; and before bots were named by seat, a name was a
 * persona, which put `fleet-atlas` on GitHub (before FleetADLC was renamed): a
 * name that told nobody there what the account was for.
 */
export function suggestionPath(bot: BotFacts | string): string {
  const seat = typeof bot === 'string' ? bot : seatFor(bot);
  return `/api/suggest-login?bot=${encodeURIComponent(seat)}`;
}

/**
 * A password for a new account, made here and never sent anywhere. OpenADLC
 * has no use for it — bots authorize through the device flow — so the only
 * place it belongs is the person's password manager.
 */
export function generatePassword(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';
  const bytes = new Uint32Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

/** A seat as the account table needs it. */
export interface SeatAccount {
  /** The seat, `lead-reviewer`: what the username is suggested from. */
  seat: string;
  /** What a person calls it: "lead reviewer". */
  label: string;
  /** The bridge's suggestion before GitHub has been asked. */
  suggestedLogin: string;
  /** `you+fleetadlc-<seat>@…`, or null until the person's own address is known. */
  suggestedEmail: string | null;
  /** The login of the account connected for this seat, when there is one. */
  connectedLogin: string | null;
}

/** A private-browsing mark: a hat and glasses, drawn here rather than any browser's own icon. */
export function PrivateIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0">
      <path d="M3 11h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M6 11l1.6-5.2a1 1 0 0 1 1.3-.66L12 6.2l3.1-1.06a1 1 0 0 1 1.3.66L18 11" fill="currentColor" />
      <circle cx="7.5" cy="16" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16.5" cy="16" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.1 15.6c1.2-.7 2.6-.7 3.8 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Whether a click is the plain one that opens a link here, rather than one asking for a tab or a window. */
export function isPlainClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * A link that has to be opened in a private window.
 *
 * In a browser signed in to GitHub as yourself, the sign-up, and the sign-in
 * that connects the bot, would happen as you. Written beside the link, the
 * advice was read past, and a drawing of the right-click menu was more than the step needed. So a plain click asks first,
 * in a small box at the button: open it privately, by right-click or by
 * copying it into a private window, or open it here anyway — somebody signed
 * out of GitHub in this browser has no reason to bother. A right-click, a
 * middle click or a modified click is somebody who already knows, and goes
 * straight through.
 */
export function PrivateLink({ href, children }: { href: string; children: ReactNode }) {
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mac, setMac] = useState(true);
  const [firefox, setFirefox] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent));
    setFirefox(/Firefox\//.test(typeof navigator === 'undefined' ? '' : navigator.userAgent));
  }, []);

  useEffect(() => {
    if (!asking) return;
    const close = (event: MouseEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) setAsking(false);
    };
    // Leaving this window is the one sign of the link being opened that a
    // page can see: a private window, or GitHub in another, takes the focus.
    // The box has done its job by then, and should not be waiting on return.
    const left = (): void => setAsking(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('blur', left);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('blur', left);
    };
  }, [asking]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(href);
    } catch {
      // Refused by the browser: the address is on screen to select.
    }
    setCopied(true);
  };

  // Firefox's private window is ⇧P: its ⇧N reopens a closed window, and the
  // account would then be made signed in as yourself, which this step prevents.
  const keys = firefox ? (mac ? '⌘⇧P' : 'Ctrl+Shift+P') : mac ? '⌘⇧N' : 'Ctrl+Shift+N';

  return (
    <div ref={box} className="relative w-fit">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          setCopied(false);
          setAsking(true);
        }}
        // A right-click is the way the box asks for: it can go.
        onContextMenu={() => setAsking(false)}
        className="inline-flex h-9 w-fit items-center gap-1.5 rounded-md border border-edge-strong bg-panel px-3 text-[13px] font-medium text-body hover:border-dim"
      >
        {children}
        <ExternalIcon size={11} />
      </a>
      <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted">
        <PrivateIcon size={14} />
        Right-click → open the link in a private window
      </p>

      {asking && (
        <div
          role="dialog"
          aria-label="Open it in a private window"
          className="absolute left-0 top-11 z-20 w-80 rounded-md border border-edge-strong bg-panel p-3.5 shadow-lg"
        >
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setAsking(false)}
            className="absolute right-2 top-2 flex size-6 items-center justify-center rounded text-[15px] leading-none text-dim hover:bg-surface hover:text-body"
          >
            ×
          </button>
          <div className="flex items-start gap-2.5 pr-5">
            <span className="text-body">
              <PrivateIcon size={26} />
            </span>
            <div>
              <p className="text-[13px] font-medium text-body">Open it in a private window</p>
              <p className="mt-0.5 text-[12px] leading-snug text-muted">
                If you are signed in to GitHub as yourself in this browser, the sign-up, and the sign-in that connects the bot, would happen as you.
              </p>
            </div>
          </div>
          <p className="mt-2.5 text-[12px] leading-relaxed text-muted">
            {copied ? (
              <>
                Copied. Press{' '}
                <kbd className="rounded border border-edge-strong bg-surface px-1 font-mono text-[11px] text-body">{keys}</kbd>{' '}
                for a private window and paste it.
              </>
            ) : (
              <>Right-click the button and choose the private window, or copy the link into one.</>
            )}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded-md bg-body px-2.5 py-1.5 text-[12px] font-medium text-panel hover:opacity-90"
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                window.open(href, '_blank', 'noreferrer');
              }}
              className="rounded-md px-2.5 py-1.5 text-[12px] text-soft hover:text-body"
            >
              Open here anyway
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function signupPasswordKey(seat: string): string {
  return `fleetadlc.signup-password.${seat}`;
}

/** Removes the password generated for a seat's sign-up, which belongs in a password manager, not in the browser. */
export function forgetSignupPassword(seat: string): void {
  try {
    sessionStorage.removeItem(signupPasswordKey(seat));
  } catch {
    // Private windows and blocked site data throw here; nothing was kept there either.
  }
}

/**
 * Signing one seat's account up, in the order GitHub's form asks: the sign-up
 * page first, as a button of its own, with how to open it privately; then the
 * email, the password and the username, each on its own line with its label,
 * so nothing is cut off — the username is checked against GitHub, because a
 * suggested name was taken by a stranger and an install ran pointed at their
 * account for a day; then verifying and connecting.
 *
 * It was a table row: four values side by side, truncated, the password and
 * the address cut short, and the page to sign up on a link inside a sentence
 * above it.
 */
export function SeatSignup({
  account,
  signupUrl,
  emailSettingsUrl,
  connect,
}: {
  account: SeatAccount;
  signupUrl: string;
  /** GitHub's email settings (`GITHUB_EMAIL_SETTINGS_URL`, as the bridge gives it). */
  emailSettingsUrl: string;
  connect: ReactNode;
}) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  /**
   * Kept per seat while its account is being made: the point is that you
   * leave for GitHub and come back, and a password that does not survive the
   * trip is worse than none. `sessionStorage` does not die with the tab, though
   * — the browser may restore it with the tab, from disk — so it is removed
   * once an account connects and when the walkthrough leaves the step
   * (`forgetSignupPassword`).
   */
  const [password, setPassword] = useState<string | null>(null);
  const passwordKey = signupPasswordKey(account.seat);
  const path = suggestionPath(account.seat);

  useEffect(() => {
    try {
      setPassword(sessionStorage.getItem(passwordKey));
    } catch {
      // Private windows and blocked site data throw here. Losing the
      // convenience is fine; failing to render the step is not.
    }
  }, [passwordKey]);

  const suggest = useCallback(async () => {
    try {
      const response = await fetch(path, { cache: 'no-store' });
      if (response.ok) setSuggestion((await response.json()) as Suggestion);
    } catch {
      // The bridge's own suggestion stands, marked unchecked.
    }
  }, [path]);

  useEffect(() => {
    void suggest();
  }, [suggest]);

  const generate = (): void => {
    const made = generatePassword();
    setPassword(made);
    try {
      sessionStorage.setItem(passwordKey, made);
    } catch {
      // On screen is enough; the line says to keep it.
    }
  };

  const login = suggestion?.suggestion ?? account.suggestedLogin;
  const field = 'grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3';

  return (
    <ol className="flex max-w-2xl flex-col gap-5">
      <Numbered n={1} title="Open GitHub's sign-up page in a private window">
        <PrivateLink href={signupUrl}>github.com/signup</PrivateLink>
      </Numbered>

      <Numbered n={2} title={`Sign up with these, for the ${account.label}`}>
        <div className="flex flex-col gap-2">
          <div className={field}>
            <span className="text-[12px] text-muted">Email</span>
            {account.suggestedEmail ? (
              <Copyable value={account.suggestedEmail} />
            ) : (
              <span className="text-[12px] text-dim">give your email above first</span>
            )}
          </div>
          <div className={field}>
            <span className="text-[12px] text-muted">Password</span>
            {password ? (
              <Copyable value={password} />
            ) : (
              <button type="button" onClick={generate} className="w-fit text-[12px] text-link hover:underline">
                generate one
              </button>
            )}
          </div>
          <div className={field}>
            <span className="text-[12px] text-muted">Username</span>
            <div className="flex min-w-0 items-center gap-2">
              <Copyable value={login} className="flex-1" />
              {suggestion?.confirmedFree ? (
                <Chip tone="signal">free</Chip>
              ) : suggestion?.allTaken ? (
                <Chip tone="attention">taken: pick your own</Chip>
              ) : suggestion ? (
                <Chip tone="attention">unchecked</Chip>
              ) : null}
            </div>
          </div>
          {password && (
            <p className="pl-[6.25rem] text-[11px] text-dim">
              Keep the password in your password manager: OpenADLC does not keep it, and does not need it.
            </p>
          )}
        </div>
      </Numbered>

      <Numbered n={3} title="Verify the email, turn on two-factor, keep the email private, then connect it">
        <div className="flex flex-col gap-3">
          {/* GitHub writes the crew's squash merges with the account's own
              email, so without this every merged pull request in a public
              repository publishes the address above. */}
          <p className="text-[12.5px] leading-relaxed text-muted">
            In the private window, signed in as the new account, open its email settings and tick “Keep my email
            addresses private” and “Block command line pushes that expose my email”. Otherwise the commits GitHub
            writes for the crew’s merged pull requests publish this address.
          </p>
          <PrivateLink href={emailSettingsUrl}>github.com/settings/emails</PrivateLink>
          {connect}
        </div>
      </Numbered>
    </ol>
  );
}
