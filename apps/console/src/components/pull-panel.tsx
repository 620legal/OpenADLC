'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { DeviceCode } from '@/components/device-code';
import { ExternalIcon } from '@/components/icons';
import type { PullCommandSent, PullCommandView, PullOutputView, PullView } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * A pull request's commands and what its repository's workflows posted, on
 * its work item and on a Needs-you card about it (#207): www's "Preview" and
 * "Approve pages", the preview's address and the before and after
 * screenshots, without opening GitHub.
 *
 * The bridge decides which buttons this person gets and in what order: a
 * reviewer's own sign-off is offered only to the person whose linked GitHub
 * account is that reviewer, and a command whose check is red comes first. A
 * screenshot is read through the console's own server, never from GitHub.
 */

/** How often the panel reads again while a command waits for its workflow, or a sign-in for its approval. */
const WAITING_READ_MS = 10_000;
const FLOW_READ_MS = 3_000;
/** How long a press holds its button when the read after it never comes back. */
const RELEASE_AFTER_MS = 15_000;

/** The console's address of a pull request's route for an item. */
export function pullPath(subject: string, rest = ''): string {
  return `/api/item/${encodeURIComponent(subject)}/pull${rest}`;
}

/** A sign-off waiting for its GitHub sign-in, or what it ended with. */
interface Flow {
  name: string;
  flowId: string;
  userCode: string;
  verificationUri: string;
  error?: string;
}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `the console answered ${response.status}`;
}

/** The pull request's view, read again while something waits on GitHub; null until read, or when the item has no pull request. */
export function usePull(subject: string): { view: PullView | null; reload: () => void; error: string | null } {
  const [view, setView] = useState<PullView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((one) => one + 1), []);
  useEffect(() => {
    let live = true;
    void fetch(pullPath(subject), { cache: 'no-store' })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 404) return setView(null);
        if (!response.ok) return setError(await errorOf(response));
        setError(null);
        // An older bridge has no such route, and a page's own answer is not a view.
        const body = (await response.json().catch(() => null)) as PullView | null;
        setView(body && Array.isArray(body.commands) && Array.isArray(body.outputs) ? body : null);
      })
      .catch(() => live && setError('The console is not answering.'));
    return () => {
      live = false;
    };
  }, [subject, tick]);
  const waiting = view?.commands.some((one) => one.state === 'sent') ?? false;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(reload, WAITING_READ_MS);
    return () => clearInterval(timer);
  }, [waiting, reload]);
  return { view, reload, error };
}

/** Presses a command and follows its sign-in, when it has one. */
function usePress(subject: string, view: PullView | null, reload: () => void) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const pressing = useRef(false);

  useEffect(() => {
    if (!flow || flow.error) return;
    const timer = setInterval(() => {
      void fetch(pullPath(subject, `/flows/${encodeURIComponent(flow.flowId)}`), { cache: 'no-store' })
        .then((response) => response.json())
        .then((said: { state: string; error?: string }) => {
          if (said.state === 'waiting') return;
          if (said.state === 'failed') {
            setFlow({ ...flow, error: said.error ?? 'The sign-in ended before anything was posted. Press it again.' });
          } else if (said.state === 'none') {
            // Not a failure: the bridge forgot the flow (it restarted, or the
            // code expired), and the comment may have been posted before it did.
            setFlow({ ...flow, error: 'OpenADLC no longer knows how this sign-in went. Look at the pull request before you press it again.' });
          } else setFlow(null);
          reload();
        })
        .catch(() => undefined);
    }, FLOW_READ_MS);
    return () => clearInterval(timer);
  }, [flow, subject, reload]);

  // A press holds the button until the view read after it comes back, which
  // shows the command as sent: releasing it when the POST answered left a
  // moment in which a second press posted the comment again.
  const pressedOn = useRef<PullView | null>(null);
  const release = useCallback(() => {
    pressedOn.current = null;
    pressing.current = false;
    setPending(null);
  }, []);
  useEffect(() => {
    if (pressedOn.current && view !== pressedOn.current) release();
  }, [view, release]);

  const press = (command: PullCommandView) => {
    if (pressing.current || !view || (flow && !flow.error)) return;
    pressing.current = true;
    setPending(command.name);
    setError(null);
    void fetch(pullPath(subject, `/commands/${encodeURIComponent(command.name)}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ head: view.head }),
    })
      .then(async (response) => {
        if (!response.ok) {
          setError(await errorOf(response));
          return release();
        }
        const sent = (await response.json()) as PullCommandSent;
        if ('flow' in sent) setFlow({ name: command.name, ...sent.flow });
        pressedOn.current = view;
        // A read that fails leaves the view as it was; the bridge refuses a
        // second send while the first waits, so the button comes back anyway.
        setTimeout(() => pressedOn.current === view && release(), RELEASE_AFTER_MS);
        reload();
      })
      .catch(() => {
        setError('The console is not answering.');
        release();
      });
  };
  return { press, pending, error, flow, dismissFlow: () => setFlow(null) };
}

/** What a command's button says, for its state. */
export function commandWords(command: PullCommandView): string {
  if (command.state === 'sent') return `${command.label}: sent`;
  return command.label;
}

/**
 * One command: its button, offered or not, and what its workflow answered.
 * A command this person may not press says why, with where it can be sent.
 */
export function CommandButton({
  command,
  url,
  primary,
  pending,
  onPress,
  showWhy = true,
}: {
  command: PullCommandView;
  url: string;
  primary: boolean;
  pending: boolean;
  onPress: (command: PullCommandView) => void;
  showWhy?: boolean;
}) {
  if (!command.offered) {
    if (!showWhy || !command.why) return null;
    return (
      <p data-pull-why={command.name} className="w-full text-[12px] text-muted">
        {command.why}{' '}
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
          Open it on GitHub
          <ExternalIcon size={10} />
        </a>
      </p>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        data-pull-command={command.name}
        disabled={pending || command.state === 'sent'}
        onClick={() => onPress(command)}
        className={cn(
          'h-8 rounded-md border px-2.5 text-[12.5px] disabled:opacity-60',
          primary ? 'border-attention/60 bg-attention/10 text-body hover:border-attention' : 'border-edge-strong bg-panel text-body hover:border-dim',
        )}
      >
        {pending ? `${command.label}…` : commandWords(command)}
      </button>
      {command.state === 'answered' && command.answer && <span className="text-[12px] text-soft">{command.answer}</span>}
      {command.state === 'quiet' && <span className="text-[12px] text-dim">No answer after half an hour; press it again?</span>}
    </span>
  );
}

/** The device code a sign-off waits on, or why it ended. */
function FlowLine({ flow, label, onDismiss }: { flow: Flow; label: string; onDismiss: () => void }) {
  if (flow.error) {
    return (
      <p role="status" className="w-full text-[12px] text-alarm">
        {flow.error}{' '}
        <button type="button" onClick={onDismiss} className="text-link hover:underline">
          Close
        </button>
      </p>
    );
  }
  return (
    <div data-pull-flow className="flex w-full flex-col gap-1.5 rounded-md border border-edge bg-surface px-2.5 py-2">
      <p className="text-[12px] text-soft">
        To send {label} as your own GitHub account, enter this code on GitHub. OpenADLC uses that sign-in for this one comment and then revokes it.
      </p>
      <DeviceCode code={flow.userCode} url={flow.verificationUri} />
    </div>
  );
}

/**
 * The buttons alone, for a Needs-you card: the pull request's commands, in
 * the bridge's order, before the card's own. A reviewer-only command the
 * person may not press says why only when it unblocks a red check, since that
 * is what the card waits on.
 */
export function PullActions({ subject }: { subject: string }) {
  const { view, reload } = usePull(subject);
  const { press, pending, error, flow, dismissFlow } = usePress(subject, view, reload);
  if (!view || view.commands.length === 0) return <span data-pull-actions={view ? 'none' : 'loading'} hidden />;
  return (
    <PullActionsView
      view={view}
      pending={pending}
      onPress={press}
      after={
        <>
          {flow && <FlowLine flow={flow} label={view.commands.find((one) => one.name === flow.name)?.label ?? flow.name} onDismiss={dismissFlow} />}
          {error && (
            <p role="status" className="w-full text-[12px] text-alarm">
              {error}
            </p>
          )}
        </>
      }
    />
  );
}

/** The buttons, from a view: what `PullActions` draws, and what its test renders. */
export function PullActionsView({ view, pending, onPress, after }: { view: PullView; pending: string | null; onPress: (command: PullCommandView) => void; after?: ReactNode }) {
  const red = (command: PullCommandView) => command.unblocks !== null && !['success', 'neutral', 'skipped'].includes(view.checks[command.unblocks] ?? '');
  const offered = view.commands.filter((one) => one.offered);
  return (
    <span data-pull-actions="ready" className="contents">
      {view.commands.map((command) => (
        <CommandButton
          key={command.name}
          command={command}
          url={view.url}
          primary={offered[0] === command}
          pending={pending === command.name}
          onPress={onPress}
          showWhy={red(command)}
        />
      ))}
      {after}
    </span>
  );
}

/** What the workflows posted: the preview's address and the screenshots, each marked older when it is for an older head. */
export function PullOutputs({ subject, outputs }: { subject: string; outputs: readonly PullOutputView[] }) {
  const found = outputs.filter((one) => one.found);
  if (found.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {found.map((output) => {
        const one = output.found!;
        const older = !one.current && (
          <span data-pull-older className="rounded bg-attention/10 px-1 text-[11px] text-attention">
            older{one.sha ? `: built from ${one.sha.slice(0, 7)}` : ''}
          </span>
        );
        if (output.kind === 'link' && one.url) {
          return (
            <p key={output.name} data-pull-output={output.name} className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
              <span className="text-dim">{capital(output.name)}</span>
              <a href={one.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
                {one.url.replace(/^https:\/\//, '')}
                <ExternalIcon size={10} />
              </a>
              {one.sha && one.current && <span className="font-mono text-[11px] text-dim">{one.sha.slice(0, 7)}</span>}
              {older}
            </p>
          );
        }
        return (
          <div key={output.name} data-pull-output={output.name} className="flex flex-col gap-1">
            <p className="flex items-center gap-1.5 text-[12.5px]">
              <span className="text-dim">{capital(output.name)}</span>
              <a href={one.commentUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
                comment
                <ExternalIcon size={10} />
              </a>
              {older}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(one.images ?? []).map((image) => (
                <figure key={image.index} className="flex flex-col gap-0.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={pullPath(subject, `/images/${one.commentId}/${image.index}`)}
                    alt={image.alt ?? `${output.name} ${image.index + 1}`}
                    loading="lazy"
                    className="w-full rounded border border-edge"
                  />
                  {image.alt && <figcaption className="text-[11px] text-dim">{image.alt}</figcaption>}
                </figure>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The panel on a work item: the buttons, what the workflows posted, and what the repository's declaration got wrong. */
export function PullPanel({ subject }: { subject: string }) {
  const { view, reload, error: readError } = usePull(subject);
  const { press, pending, error, flow, dismissFlow } = usePress(subject, view, reload);
  if (!view) return readError ? <p className="text-[12px] text-alarm">{readError}</p> : null;
  return <PullPanelView subject={subject} view={view} pending={pending} onPress={press} flow={flow} onDismissFlow={dismissFlow} error={error} />;
}

export function PullPanelView({
  subject,
  view,
  pending,
  onPress,
  flow = null,
  onDismissFlow = () => undefined,
  error = null,
}: {
  subject: string;
  view: PullView;
  pending: string | null;
  onPress: (command: PullCommandView) => void;
  flow?: Flow | null;
  onDismissFlow?: () => void;
  error?: string | null;
}) {
  if (view.commands.length === 0 && view.outputs.every((one) => !one.found) && view.errors.length === 0) return null;
  const offered = view.commands.filter((one) => one.offered);
  return (
    <section data-pull-panel className="flex flex-col gap-2 rounded-lg border border-edge bg-surface px-3 py-2.5">
      <p className="text-[11px] font-medium text-dim">Pull request #{view.number}{view.head ? ` at ${view.head.slice(0, 7)}` : ''}</p>
      {view.commands.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {view.commands.map((command) => (
            <CommandButton key={command.name} command={command} url={view.url} primary={offered[0] === command} pending={pending === command.name} onPress={onPress} />
          ))}
          {flow && <FlowLine flow={flow} label={view.commands.find((one) => one.name === flow.name)?.label ?? flow.name} onDismiss={onDismissFlow} />}
        </div>
      )}
      {error && (
        <p role="status" className="text-[12px] text-alarm">
          {error}
        </p>
      )}
      <PullOutputs subject={subject} outputs={view.outputs} />
      {view.errors.length > 0 && (
        <ul data-pull-errors className="list-disc pl-4 text-[11.5px] text-muted">
          {view.errors.map((one) => (
            <li key={one}>.github/openadlc.yml: {one}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
