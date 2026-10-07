'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { BRIDGE_NOT_ANSWERING, reach } from '@/lib/reach';

export interface AppChecks {
  deviceFlow: 'enabled' | 'disabled' | 'unknown';
  tokenExpiry: 'enabled' | 'disabled' | 'unverified';
  installed: 'yes' | 'no' | 'unknown';
  /** The account from the walkthrough's first step, and whether the app is installed there. */
  account?: string | null;
  installedOnAccount?: 'yes' | 'no' | 'unknown';
  repository: string | null;
  settingsUrl: string | null;
  installUrl: string | null;
  /** Which app the stored credentials belong to, once there are any. */
  app: { slug: string; id: number; installations: number } | null;
  /** Whether OpenADLC holds the app's private key: without it, where the app is installed cannot be asked. Absent from an older bridge. */
  privateKeyHeld?: boolean;
  detail: string;
  /**
   * What to do about the first repository the app cannot reach, when installing
   * alone would not do it — a private app belonging to another account has to
   * be moved or made public first. Null when installing is the whole answer.
   */
  fix?: {
    need: string;
    title: string;
    detail: string;
    action: { label: string; url: string };
    steps: { text: string; action: { label: string; url: string } }[];
  } | null;
}

/** How often the panel asks again while something is still to be done on GitHub. */
const RECHECK_MS = 15_000;

/**
 * Whether the panel asks GitHub again every `RECHECK_MS`: on the install step
 * while installing is still to do or not yet known, and in settings while
 * device flow is not on. Once neither holds it stops, rather than asking
 * GitHub forever.
 */
export function keepsAsking(checks: AppChecks | null, variant: 'settings' | 'install'): boolean {
  if (!checks) return true;
  if (variant === 'install') return installHeld(checks) || installUndecided(checks);
  return checks.deviceFlow !== 'enabled';
}

const NO_KEY = 'OpenADLC does not hold the app’s private key, so it cannot see where the app is installed — add it under Create the app.';
const NO_ANSWER = 'GitHub did not answer, so where the app is installed is not known yet. It is asked again in a moment.';

export interface InstallRow {
  label: string;
  chip: { tone: 'signal' | 'attention'; text: string } | null;
  text: string;
  button: { label: string; url: string } | null;
}

/**
 * The checklist's last line, which asked about "the repository" before there
 * was one. A fresh app has none chosen yet — the walkthrough asks for them in
 * the next step, from the list of what the app can reach — so the line said
 * "not checked" under a step that was otherwise done, and offered nothing to
 * press. Until a repository is chosen, what matters is whether the app is
 * installed anywhere, and the way to install it.
 */
export function installRow(checks: AppChecks | null): InstallRow {
  if (checks && !checks.repository && checks.account && checks.installedOnAccount && checks.installedOnAccount !== 'unknown') {
    const account = checks.account;
    return checks.installedOnAccount === 'yes'
      ? {
          label: `Install it on ${account}`,
          chip: { tone: 'signal', text: 'installed' },
          text: 'The next step lists the repositories it can reach there, to choose from. Give it more on GitHub any time.',
          button: null,
        }
      : {
          label: `Install it on ${account}`,
          chip: { tone: 'attention', text: 'not installed yet' },
          text:
            `Install it on ${account} and choose only the repositories the crew will work in. The next step lists ` +
            'what it can reach there, so it has nothing to show until this is done.',
          button: checks.installUrl ? { label: `Install on ${account}`, url: checks.installUrl } : null,
        };
  }
  // Not asked, or not answered, is neither installed nor not: "not installed
  // yet" sent people to install an app that was, and with no button to press.
  // Installed on some account, with the install's own account unknown, is not
  // an answer for this step either.
  if (checks && !checks.repository && (!checks.app || (checks.account && checks.installedOnAccount === 'unknown'))) {
    return {
      label: checks.account ? `Install it on ${checks.account}` : 'Install it where the crew will work',
      chip: null,
      text: !checks.app && checks.privateKeyHeld === false ? NO_KEY : checks.detail || NO_ANSWER,
      button: null,
    };
  }
  if (checks && !checks.repository) {
    const count = checks.app?.installations ?? 0;
    return count > 0
      ? {
          label: 'Install it where the crew will work',
          chip: { tone: 'signal', text: `installed on ${count} ${count === 1 ? 'account' : 'accounts'}` },
          text: 'The next step lists the repositories it can reach, to choose from. Give it more on GitHub any time.',
          button: null,
        }
      : {
          label: 'Install it where the crew will work',
          chip: { tone: 'attention', text: 'not installed yet' },
          text:
            'Install it on your organization and choose only the repositories the crew will work in. The next step ' +
            'lists what it can reach, so it has nothing to show until this is done.',
          button: checks.installUrl ? { label: 'Install the app', url: checks.installUrl } : null,
        };
  }
  const repository = checks?.repository ?? 'the repository';
  // What GitHub says to do comes first: a suspended installation still
  // answers "installed", and its steps to unsuspend it were hidden.
  if (checks?.fix) {
    return {
      label: `Install it on ${repository}`,
      chip: {
        tone: 'attention',
        text: checks.fix.need === 'unsuspend' ? 'suspended' : checks.fix.need === 'install' || checks.fix.need === 'add-repository' ? 'not installed' : 'not reachable',
      },
      text: checks.fix.title,
      button: null,
    };
  }
  if (checks?.installed === 'yes') {
    return {
      label: `Install it on ${repository}`,
      chip: { tone: 'signal', text: 'installed' },
      text: 'What gives the app, and every bot’s token, access to the repository.',
      button: null,
    };
  }
  if (checks?.installed === 'no') {
    return {
      label: `Install it on ${repository}`,
      chip: { tone: 'attention', text: 'not installed' },
      text:
        checks.fix?.title ??
        'Until it is, OpenADLC cannot invite the crew or read the repository — the later steps have nothing to act on.',
      button: !checks.fix && checks.installUrl ? { label: `Install it on ${repository}`, url: checks.installUrl } : null,
    };
  }
  // Only while the first answer is on its way, or GitHub did not give one.
  const text = !checks ? 'Checking with GitHub…' : checks.privateKeyHeld === false ? NO_KEY : checks.detail || NO_ANSWER;
  return { label: `Install it on ${repository}`, chip: null, text, button: null };
}

/** What the walkthrough draws from the answer; a change in any of it is worth reading the walkthrough again for. */
function signature(checks: AppChecks): string {
  return [
    checks.deviceFlow,
    checks.installed,
    checks.installedOnAccount,
    checks.repository,
    checks.app?.id,
    checks.app?.installations,
    checks.fix?.need,
  ].join('|');
}

/**
 * Whether where the app is installed is still not known, and can be: asked
 * again while the key is held. Without it nothing can answer, and every ask
 * is a device-code request to GitHub.
 */
export function installUndecided(checks: AppChecks): boolean {
  const unknown = checks.repository
    ? checks.installed === 'unknown'
    : !checks.app || (Boolean(checks.account) && checks.installedOnAccount === 'unknown');
  return unknown && (checks.app !== null || checks.privateKeyHeld === true);
}

/**
 * GitHub has said the app is installed. Unknown is not a yes: a clean install
 * has no answer yet, and `installHeld` treats that as not holding the step,
 * which ticked Install before the app existed.
 */
export function installKnown(checks: AppChecks | null | undefined): boolean {
  return checks?.installed === 'yes' || checks?.installedOnAccount === 'yes';
}

/**
 * Installing is outstanding. Unknown is not: a check that has not answered yet
 * must not hold the step, and a network failure must not either. Not holding
 * it is not the same as it being done; see `installKnown`.
 */
export function installHeld(checks: AppChecks | null | undefined): boolean {
  if (!checks) return false;
  // Suspended, or out of the app's reach: GitHub's steps are still to do.
  if (checks.fix) return true;
  if (checks.installed === 'no') return true;
  if (checks.repository) return false;
  if (checks.installedOnAccount === 'no') return true;
  return Boolean(checks.app && checks.app.installations === 0 && checks.installedOnAccount !== 'yes');
}

/**
 * Confirming the two settings GitHub's manifest cannot set.
 *
 * Both fail late and quietly, which is why they are checked rather than
 * described. Device flow off shows up as a connect button that errors, and
 * somebody who read past the instruction discovers it on the account they
 * already spent five minutes creating.
 *
 * Device flow is asked of GitHub directly — it either issues a device code or
 * refuses. Token expiry cannot be asked at all: nothing in the app's API reports
 * it, and it is visible only in what a real authorization returns. So it stays
 * unverified until a bot connects and is answered honestly then, rather than
 * being claimed either way.
 */
export function AppChecksPanel({
  onChecked,
  onMoved,
  variant = 'settings',
}: {
  onChecked?: (checks: AppChecks) => void;
  /**
   * The answer moved: the walkthrough reads what it is drawn from again.
   * `router.refresh()` did nothing for it — the page keeps what it was drawn
   * from in the browser's state — so a stale "not installed" stayed after
   * installing, and the refresh asked GitHub once more for nothing.
   */
  onMoved?: () => void;
  /**
   * Device Flow and token expiry stay on Create the app. Installing the app
   * is its own step, so the two are not one checklist.
   */
  variant?: 'settings' | 'install';
}) {
  const [checks, setChecks] = useState<AppChecks | null>(null);
  const [busy, setBusy] = useState(false);
  /** Why the last ask got no answer, said under whatever answer is on screen. */
  const [failed, setFailed] = useState<string | null>(null);
  const last = useRef<string | null>(null);
  // Read through a ref, as `AccountsStep` reads its callbacks: a `run` that
  // followed a parent's new `onChecked` on every render would be run again
  // by the effect below each time, without end under a parent that
  // re-renders on every answer.
  const told = useRef(onChecked);
  told.current = onChecked;
  const moved = useRef(onMoved);
  moved.current = onMoved;

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const response = await reach('/api/app-checks', { cache: 'no-store' }, BRIDGE_NOT_ANSWERING);
      if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
      const body = (await response.json()) as AppChecks;
      setChecks(body);
      setFailed(null);
      told.current?.(body);
      // The step's done mark follows `onChecked`; the cards above it and the
      // footer's trouble line are the walkthrough's own data, which it reads
      // again when the answer moves.
      const now = signature(body);
      if (last.current !== null && last.current !== now) moved.current?.();
      last.current = now;
    } catch (cause) {
      // The previous answer stays on screen, with a line saying this ask got none.
      setFailed(cause instanceof Error ? cause.message : 'could not ask GitHub');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  // Everything left here is done in another tab, on GitHub. Asked again when
  // the person comes back to this one, and every little while until it is all
  // done, so nobody has to know to press "check again" or reload.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [run]);

  useEffect(() => {
    if (!keepsAsking(checks, variant)) return;
    const timer = setInterval(() => void run(), RECHECK_MS);
    return () => clearInterval(timer);
  }, [checks, run, variant]);

  const flow = checks?.deviceFlow;

  return (
    <div className="rounded-md border border-edge bg-panel/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] uppercase tracking-wider text-dim">what still has to be done on GitHub</p>
        <span className="ml-auto">
          <Button size="sm" onClick={() => void run()} disabled={busy}>
            {busy ? 'checking…' : 'check again'}
          </Button>
        </span>
      </div>

      {variant === 'settings' && (
      <div className="mt-2.5 space-y-2.5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-body">Enable Device Flow</span>
            {flow === 'enabled' && <Chip tone="signal">on</Chip>}
            {flow === 'disabled' && <Chip tone="attention">off</Chip>}
            {(flow === 'unknown' || !checks) && <Chip>not checked</Chip>}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-dim">
            {flow === 'disabled'
              ? 'Do this before the next step. No bot can authorize until it is on, so connect fails on every account.'
              : 'How a bot authorizes its own account.'}
          </p>
          {flow === 'disabled' && checks?.settingsUrl && (
            <a href={checks.settingsUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-block">
              <Button size="sm" variant="primary">
                open the app’s settings
              </Button>
            </a>
          )}
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-body">Expire user authorization tokens</span>
            {checks?.tokenExpiry === 'enabled' && <Chip tone="signal">on</Chip>}
            {checks?.tokenExpiry === 'disabled' && <Chip tone="attention">off</Chip>}
            {checks?.tokenExpiry === 'unverified' && <Chip>checked when a bot connects</Chip>}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-dim">
            {checks?.tokenExpiry === 'disabled'
              ? 'A bot connected without a refresh token, so this is off: its credential never rotates.'
              : 'Nothing in GitHub’s API reports this. It is answered by what the first authorization returns.'}
          </p>
        </div>
      </div>
      )}

        {variant === 'install' && (() => {
          const row = installRow(checks);
          return (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] text-body">{row.label}</span>
                {row.chip && <Chip tone={row.chip.tone}>{row.chip.text}</Chip>}
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-dim">{row.text}</p>
              {checks?.fix && checks.fix.steps.length > 0 && (
                <ol className="mt-1.5 flex list-decimal flex-col gap-1.5 pl-4 text-[11.5px] leading-relaxed text-body">
                  {checks.fix.steps.map((step) => (
                    <li key={step.text}>
                      <span>{step.text}</span>{' '}
                      <a href={step.action.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                        {step.action.label} ↗
                      </a>
                    </li>
                  ))}
                </ol>
              )}
              {row.button && (
                <a href={row.button.url} target="_blank" rel="noreferrer" className="mt-1.5 inline-block">
                  <Button size="sm" variant="primary">
                    {row.button.label}
                  </Button>
                </a>
              )}
            </div>
          );
        })()}

      {variant === 'settings' && checks?.detail && flow !== 'enabled' && (
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-attention">{checks.detail}</p>
      )}
      {failed && (
        <p role="status" className="mt-2.5 text-[11.5px] leading-relaxed text-attention">
          {checks ? `Could not ask again: ${failed}` : `Could not ask GitHub: ${failed}`}
        </p>
      )}
    </div>
  );
}
