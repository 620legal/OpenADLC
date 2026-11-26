'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { DeviceCode } from '@/components/device-code';
import { cn } from '@/lib/cn';
import { DURATIONS, badgeOrder, badgeText, handsOffViewOf, timeLeft, type HandsOffDuration, type HandsOffView } from '@/lib/hands-off';

/** How often the badge's time left is said again. */
export const TICK_MS = 30_000;
/** How often a waiting sign-in is asked how it went. */
const FLOW_READ_MS = 3_000;

interface Flow {
  flowId: string;
  userCode: string;
  verificationUri: string;
}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `The bridge answered ${response.status}.`;
}

/**
 * Hands-off mode in the header (#383, ADR 0093).
 *
 * While a window is open on any repository the badge says so, in amber, with
 * the soonest one's time left and how many more; opening it lists each with
 * who set it and a one-click Turn off, which anyone may press. With none open,
 * a person who may turn one on (Approves, a linked account) sees a quiet
 * button whose dialog says what it answers and what it never does, and
 * turns it on only after a fresh GitHub sign-in, as a release cut does.
 *
 * `initial` is what the page read: undefined when it read nothing, and the
 * badge reads it itself then; null when the read failed, and the header is
 * drawn without it.
 */
export function HandsOffBadge({ initial, compact = false }: { initial: HandsOffView | null | undefined; compact?: boolean }) {
  const [view, setView] = useState<HandsOffView | null | undefined>(initial);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const panel = useId();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => setView(initial), [initial]);

  // Read again after a turn-on or a turn-off. The badge keeps what it shows,
  // so it needs no page refresh, and the header renders without a router in
  // its static tests.
  const refresh = () => {
    void fetch('/api/hands-off', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((read: unknown) => setView(handsOffViewOf(read)))
      .catch(() => setView(null));
  };

  // A page that read nothing for it: read it here, once.
  useEffect(() => {
    if (initial !== undefined) return;
    void fetch('/api/hands-off', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((read: unknown) => setView(handsOffViewOf(read)))
      .catch(() => setView(null));
  }, [initial]);

  // The time left is said again every 30 s, and a window whose time has
  // passed is dropped at once (`badgeOrder`).
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const listed = view ? badgeOrder(view.windows, now) : [];

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (!view) return null;
  const said = badgeText(view.windows, now);

  const turnOff = (repo: string) => {
    setPending(true);
    setError(null);
    void fetch(`/api/hands-off/${encodeURIComponent(repo)}`, { method: 'DELETE' })
      .then(async (response) => {
        if (!response.ok && response.status !== 404) return setError(await errorOf(response));
        setOpen(false);
        refresh();
      })
      .catch(() => setError('The console is not answering.'))
      .finally(() => setPending(false));
  };

  if (said) {
    return (
      <div ref={root} className="relative" data-hands-off>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((was) => !was)}
          data-hands-off-badge
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border border-attention/50 bg-attention/10 px-2.5 text-[12.5px] font-medium text-attention hover:border-attention focus-visible:outline-2 focus-visible:outline-link',
            compact ? 'h-11' : 'h-8',
          )}
        >
          {said.label}
          {said.more > 0 && <span data-hands-off-more>+{said.more}</span>}
        </button>
        <div
          id={panel}
          hidden={!open}
          data-hands-off-panel
          className="absolute right-0 top-full z-40 mt-1 flex w-[22rem] max-w-[calc(100vw-1rem)] flex-col gap-1 whitespace-normal rounded-lg border border-edge-strong bg-panel p-2 shadow-xl"
        >
          <p className="px-1 pb-1 text-[12px] text-muted">
            OpenADLC answers routine gates in these repositories as they are asked, in the name of whoever turned it on.
          </p>
          <ul aria-label="Hands-off windows" className="flex flex-col gap-1">
            {listed.map((window) => (
              <li key={window.repo} data-hands-off-window className="flex items-center gap-2 rounded-md bg-well px-2.5 py-2 text-[12.5px]">
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-body">{window.repo}</span>
                  <span className="block text-muted">
                    set by {window.setByLogin} at {window.setAt.slice(0, 16).replace('T', ' ')} UTC · {timeLeft(window.endsAt, now)}
                    {window.endsAt ? ' left' : ''}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => turnOff(window.repo)}
                  data-hands-off-turn-off
                  className="h-8 shrink-0 rounded-md border border-edge-strong px-2.5 text-[12.5px] font-medium text-body hover:border-dim disabled:opacity-50"
                >
                  Turn off
                </button>
              </li>
            ))}
          </ul>
          {error && (
            <p role="alert" className="px-1 text-[12.5px] text-alarm">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (!view.mayTurnOn) return null;
  return (
    <div className="relative" data-hands-off>
      <button
        type="button"
        onClick={() => setDialog(true)}
        data-hands-off-start
        className={cn('inline-flex items-center rounded-md px-2 text-[12.5px] text-muted hover:text-body focus-visible:outline-2 focus-visible:outline-link', compact ? 'h-11' : 'h-8')}
      >
        Hands-off
      </button>
      {dialog && <TurnOnDialog repos={view.repos} onClose={() => setDialog(false)} onOn={() => (setDialog(false), refresh())} />}
    </div>
  );
}

/** Choosing a repository and a duration, then the sign-in that turns it on. */
function TurnOnDialog({ repos, onClose, onOn }: { repos: string[]; onClose: () => void; onOn: () => void }) {
  const [repo, setRepo] = useState(repos[0] ?? '');
  const [duration, setDuration] = useState<HandsOffDuration>('8h');
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const title = useId();

  useEffect(() => {
    if (!flow) return;
    const timer = setInterval(() => {
      void fetch(`/api/hands-off/${encodeURIComponent(repo)}/flows/${encodeURIComponent(flow.flowId)}`, { cache: 'no-store' })
        .then((response) => response.json())
        .then((said: { state: string; error?: string }) => {
          if (said.state === 'waiting') return;
          setFlow(null);
          if (said.state === 'done') onOn();
          else setError(said.error ?? 'The sign-in ended before hands-off mode was turned on. Try again.');
        })
        .catch(() => undefined);
    }, FLOW_READ_MS);
    return () => clearInterval(timer);
  }, [flow, repo, onOn]);

  const start = () => {
    setPending(true);
    setError(null);
    void fetch(`/api/hands-off/${encodeURIComponent(repo)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ duration }) })
      .then(async (response) => {
        if (!response.ok) return setError(await errorOf(response));
        setFlow(((await response.json()) as { flow: Flow }).flow);
      })
      .catch(() => setError('The console is not answering.'))
      .finally(() => setPending(false));
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={title} data-hands-off-dialog className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-[30rem] max-w-full flex-col gap-3 whitespace-normal rounded-lg border border-edge-strong bg-panel p-4 shadow-xl">
        <h2 id={title} className="text-[15px] font-semibold text-body">
          Turn on hands-off mode
        </h2>
        <div className="text-[12.5px] text-soft">
          <p>While it is on, OpenADLC answers in your name, as they are asked:</p>
          <ul className="ml-4 list-disc">
            <li>a plan change with no path under Human review;</li>
            <li>a question the bot recommended an answer to, from intake, design or build.</li>
          </ul>
          <p className="mt-1">
            It never answers a path under Human review, a merge, a release, deploy or promote, a host check, scope:cross-cutting, raising a cap, or a question on a
            pull request. Those still ask a person. It turns itself off when its time is up or a monthly cap is reached.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-[12.5px] text-muted">
          Repository
          <select value={repo} onChange={(event) => setRepo(event.target.value)} disabled={flow !== null} className="h-9 rounded-md border border-edge-strong bg-panel px-2 text-[13px] text-body">
            {repos.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex flex-wrap gap-2 text-[12.5px]">
          <legend className="mb-1 text-muted">For</legend>
          {DURATIONS.map((choice) => (
            <label key={choice.value} className="inline-flex items-center gap-1.5 text-body">
              <input type="radio" name="hands-off-duration" value={choice.value} checked={duration === choice.value} disabled={flow !== null} onChange={() => setDuration(choice.value)} />
              {choice.label}
            </label>
          ))}
        </fieldset>
        {flow ? (
          <div className="flex flex-col gap-2 text-[12.5px] text-soft">
            <p>Approve this code on GitHub as the account linked to you. Nothing is on until you do.</p>
            <DeviceCode code={flow.userCode} url={flow.verificationUri} />
          </div>
        ) : null}
        {error && (
          <p role="alert" className="text-[12.5px] text-alarm">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-md border border-edge-strong px-3 text-[13px] text-body hover:border-dim">
            {flow ? 'Close' : 'Cancel'}
          </button>
          {!flow && (
            <button
              type="button"
              disabled={pending || !repo}
              onClick={start}
              data-hands-off-sign-in
              className="h-8 rounded-md bg-body px-3 text-[13px] font-medium text-surface hover:bg-soft disabled:opacity-50"
            >
              Sign in to turn on
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
