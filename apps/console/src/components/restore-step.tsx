'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { listed } from '@/lib/bot-label';
import { countWords } from '@/lib/crew';
import {
  GITHUB_TAKE_OVER,
  SUBSCRIPTION_TAKE_OVER,
  base64Of,
  choicesOf,
  choosable,
  historyLine,
  holdsLines,
  looksSealed,
  madeOn,
  outcomeLine,
  restoreBotLine,
  signInName,
  verdictLine,
  type RestorePreview,
  type RestoreResult,
  type RestoreState,
  type RestoreSummary,
  type SignInLine,
  setUpSentence,
} from '@/lib/backup';
import { cn } from '@/lib/cn';

/**
 * The walkthrough's first step: start fresh, or restore from a backup.
 *
 * Offered only on a clean install — no GitHub App, no repository, no
 * connected bot, no model account; an install that is set up restores from
 * Settings → Backup instead. The file is read here and sent to the bridge,
 * which opens it and says what it holds, what it would set up, and what each
 * sign-in in it is — same, working, expired or refused, or only to be checked
 * by using it — before anything is written. A sign-in that cannot be restored
 * cannot be ticked. Restore then does it, and says what came back and what is
 * left: the walkthrough carries on from the first thing still to do — the
 * bots whose sign-ins did not come back, say.
 */

export type RestorePhase =
  | { at: 'choosing' }
  | { at: 'reading' }
  /** With the archive the preview was read from, which Restore sends rather than the file chosen since. */
  | { at: 'read'; preview: RestorePreview; archive: string; sealed: boolean }
  | { at: 'restoring'; preview: RestorePreview }
  | { at: 'restored'; result: RestoreResult };

async function bridgeError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Not JSON: say what came back.
  }
  return text.slice(0, 300) || `the bridge answered ${response.status}`;
}

function List({ title, lines, tone }: { title: string; lines: string[]; tone?: 'attention' }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className={cn('text-[11px] uppercase tracking-wider', tone === 'attention' ? 'text-attention' : 'text-dim')}>{title}</p>
      <ul className="flex flex-col gap-0.5 text-[12.5px] leading-snug text-soft">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** What a restore sets up, as lines: the install, the repositories, the accounts, then the crew seat by seat. */
export function setsUpLines(summary: RestoreSummary): string[] {
  const lines: string[] = [];
  const settings = summary.settings.length > 0 ? `the install’s ${countWords(summary.settings.length, 'setting').toLowerCase()}` : '';
  const app = summary.app.length > 0 ? `the app’s ${listed(summary.app)}` : '';
  const install = [settings, app].filter(Boolean);
  if (install.length > 0) lines.push(atStart(install.join(', and ')));
  for (const repo of summary.repositories) lines.push(`The repository ${repo}`);
  for (const account of summary.accounts) {
    const how =
      account.signIn === 'take-over'
        ? 'if its sign-in still works'
        : account.signIn === 'blocked' || account.signIn === 'refused'
          ? 'without a credential that works'
          : account.signIn === 'left-out'
            ? 'without its credential, which was left out'
            : { key: 'with its key', token: 'with its token', 'sign-in': 'signed in', none: 'to sign in to again' }[account.credential];
    lines.push(`The model account ${account.label}, ${how}`);
  }
  // The seats an account belongs to; the rest are as a fresh install has them.
  for (const bot of summary.bots.filter((one) => one.login)) lines.push(restoreBotLine(bot));
  if (summary.history) lines.push(historyLine(summary.history));
  return lines;
}

/** "the install’s …" at the start of a line. */
function atStart(line: string): string {
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * The backup's sign-ins, each with its verdict and a tick. One that cannot be
 * restored — the same as here already, or expired or refused — has its box
 * off and disabled, and says why; one that can only be checked by using it
 * says what checking it does.
 */
export function SignInChoices({
  lines,
  choices,
  onToggle,
  disabled = false,
}: {
  lines: SignInLine[];
  choices: Record<string, boolean>;
  onToggle: (key: string) => void;
  disabled?: boolean;
}) {
  if (lines.length === 0) return null;
  const byUse = lines.filter((line) => line.verdict.state === 'check-by-use');
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="text-[11px] uppercase tracking-wider text-dim">Sign-ins</legend>
      {byUse.some((line) => line.provider === 'github') && <p className="text-[12.5px] leading-snug text-attention">{GITHUB_TAKE_OVER}</p>}
      {byUse.some((line) => line.provider !== 'github') && <p className="text-[12.5px] leading-snug text-attention">{SUBSCRIPTION_TAKE_OVER}</p>}
      <ul className="flex flex-col gap-1.5">
        {lines.map((line) => {
          const can = choosable(line);
          return (
            <li key={line.key}>
              <label className={cn('flex items-start gap-2.5', can ? 'cursor-pointer' : 'opacity-60')}>
                <input
                  type="checkbox"
                  checked={can && choices[line.key] === true}
                  disabled={!can}
                  onChange={() => onToggle(line.key)}
                  className="mt-[3px] size-4 shrink-0 accent-link"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] text-body">{signInName(line)}</span>
                  <span
                    className={cn(
                      'text-[12px] leading-snug',
                      line.verdict.state === 'blocked' ? 'text-alarm' : 'text-muted',
                    )}
                  >
                    {verdictLine(line)}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/** The step, drawn from where it is. `RestoreStep` below does the reading and the restoring. */
export function RestoreChoice({
  restore,
  phase,
  fileName,
  sealed,
  passphrase,
  error,
  onPick,
  onPassphrase,
  onRead,
  onRestore,
  onAgain,
  choices = {},
  onToggle = () => undefined,
  next = null,
  onContinue = () => undefined,
}: {
  restore: RestoreState | null;
  phase: RestorePhase;
  fileName: string | null;
  sealed: boolean;
  passphrase: string;
  error: string | null;
  onPick: () => void;
  onPassphrase: (value: string) => void;
  onRead: () => void;
  onRestore: () => void;
  onAgain: () => void;
  /** Which of the backup's sign-ins are ticked, by key. */
  choices?: Record<string, boolean>;
  onToggle?: (key: string) => void;
  /** The first step still to do, once a restore has done the rest. */
  next?: string | null;
  onContinue?: () => void;
}) {
  if (phase.at === 'restored') {
    const { result } = phase;
    const renamed = result.renames.filter((rename) => rename.state === 'renamed');
    const waiting = result.renames.filter((rename) => rename.state !== 'renamed');
    return (
      <div className="max-w-lg space-y-4">
        <p role="status" className="rounded-md border border-signal/40 bg-signal/5 p-3 text-[13px] leading-relaxed text-body">
          Restored. The steps it set up are ticked; the walkthrough goes on from the first thing still to do.
        </p>
        <List title="Set up" lines={setsUpLines(result.restored)} />
        <List title="Sign-ins" lines={result.signIns.map(outcomeLine)} />
        <List title="Took their account’s name" lines={renamed.map((rename) => `${rename.name} is now ${rename.to}`)} />
        <List
          title="Still to do"
          tone="attention"
          lines={[
            ...result.restored.next,
            ...waiting.map((rename) => `${rename.name} takes the name ${rename.to} when it can: ${rename.reason ?? rename.state}`),
          ]}
        />
        {next && (
          <Button variant="primary" onClick={onContinue}>
            Go on to {next.charAt(0).toLowerCase()}
            {next.slice(1)}
          </Button>
        )}
      </div>
    );
  }

  if (restore && !restore.clean) {
    return (
      <div className="max-w-lg space-y-3 text-[13px] leading-relaxed text-muted">
        <p>
          This install is already set up — {setUpSentence(restore)} — so the walkthrough carries on from where it
          is. To restore a backup into it, use Restore in{' '}
          <a href="/settings#restore" className="text-link underline-offset-2 hover:underline">
            Settings → Backup
          </a>
          , which compares the backup with this install thing by thing first.
        </p>
      </div>
    );
  }

  const preview = phase.at === 'read' || phase.at === 'restoring' ? phase.preview : null;

  return (
    <div className="max-w-lg space-y-5">
      <p className="text-[13px] leading-relaxed text-muted">
        A new install starts fresh: the next steps create the GitHub App, choose the repository and connect the crew.
        If you have a backup of another install, restore it here instead — OpenADLC sets up everything the backup holds,
        and the walkthrough carries on from whatever it could not.
      </p>

      <section aria-labelledby="restore-title" className="space-y-3 rounded-md border border-edge bg-panel/40 p-4">
        <h3 id="restore-title" className="text-[13px] font-semibold text-body">
          Restore from a backup
        </h3>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onPick} disabled={phase.at === 'reading' || phase.at === 'restoring'}>
            {fileName ? 'choose another file' : 'choose the backup file'}
          </Button>
          {fileName && <span className="font-mono text-[12px] text-soft">{fileName}</span>}
        </div>

        {fileName && sealed && !preview && (
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-dim">its passphrase</span>
            <input
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(event) => onPassphrase(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && passphrase) onRead();
              }}
              className="mt-1.5 w-full rounded-md border border-edge-strong bg-surface px-3 py-2 text-[13px] text-body focus-visible:outline-2 focus-visible:outline-link"
            />
          </label>
        )}

        {fileName && !sealed && !preview && (
          <p className="text-[12px] text-attention">
            This file is not encrypted: anyone who has had it has had the credentials in it.
          </p>
        )}

        {fileName && !preview && (
          <Button size="sm" variant="primary" onClick={onRead} disabled={phase.at === 'reading' || (sealed && !passphrase)}>
            {phase.at === 'reading' ? 'reading…' : 'read the backup'}
          </Button>
        )}

        {preview && (
          <div className="space-y-4">
            <p className="text-[12.5px] text-muted">
              Made {madeOn(preview.holds.createdAt)}
              {preview.sealed ? '' : ', and not encrypted'}.
            </p>
            <List title="It holds" lines={holdsLines(preview.holds)} />
            <SignInChoices lines={preview.signIns} choices={choices} onToggle={onToggle} disabled={phase.at === 'restoring'} />
            <List title="Restoring it sets up" lines={setsUpLines(preview.restores)} />
            <List title="It leaves out" lines={preview.restores.skipped} />
            <List title="Then still to do" tone="attention" lines={preview.restores.next} />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={onRestore} disabled={phase.at === 'restoring'}>
                {phase.at === 'restoring' ? 'restoring…' : 'Restore'}
              </Button>
              <Button variant="ghost" size="sm" onClick={onAgain} disabled={phase.at === 'restoring'}>
                choose another file
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-[12.5px] text-alarm">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

export function RestoreStep({
  restore,
  onRestored,
  next,
  onContinue,
}: {
  restore: RestoreState | null;
  /** Everything the steps read from, read again, so each step the restore did is ticked. */
  onRestored: () => Promise<void> | void;
  /** The first step still to do, which the restored summary offers to go on to. */
  next: string | null;
  onContinue: () => void;
}) {
  const [phase, setPhase] = useState<RestorePhase>({ at: 'choosing' });
  const [file, setFile] = useState<{ name: string; archive: string; sealed: boolean } | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // Bumped by each new pick, so a file or a reading of one that answers after
  // it is dropped: what Restore sends is always what was read, as in Settings.
  const session = useRef(0);

  async function choose(chosen: File | undefined): Promise<void> {
    if (!chosen) return;
    const started = (session.current += 1);
    setFile(null);
    setError(null);
    setPhase({ at: 'choosing' });
    try {
      const bytes = await chosen.arrayBuffer();
      if (session.current !== started) return;
      setFile({ name: chosen.name, archive: base64Of(bytes), sealed: looksSealed(bytes) });
    } catch {
      if (session.current === started) setError(`could not read ${chosen.name}`);
    }
  }

  async function send(path: string, archive: { archive: string; sealed: boolean } | null, signIns?: Record<string, boolean>): Promise<Response> {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archive: archive?.archive ?? '', ...(archive?.sealed ? { passphrase } : {}), ...(signIns ? { signIns } : {}) }),
    });
  }

  async function read(): Promise<void> {
    const started = session.current;
    const reading = file;
    if (!reading) return;
    setPhase({ at: 'reading' });
    setError(null);
    try {
      const response = await send('/api/restore/preview', reading);
      if (!response.ok) throw new Error(await bridgeError(response));
      const preview = (await response.json()) as RestorePreview;
      if (session.current !== started) return;
      setChoices(choicesOf(preview.signIns));
      setPhase({ at: 'read', preview, archive: reading.archive, sealed: reading.sealed });
    } catch (cause) {
      if (session.current !== started) return;
      setPhase({ at: 'choosing' });
      setError(cause instanceof Error ? cause.message : 'the backup could not be read');
    }
  }

  async function restoreIt(read: Extract<RestorePhase, { at: 'read' }>): Promise<void> {
    const { preview } = read;
    setPhase({ at: 'restoring', preview });
    setError(null);
    try {
      const response = await send('/api/restore', read, choices);
      if (!response.ok) throw new Error(await bridgeError(response));
      const result = (await response.json()) as RestoreResult;
      setPhase({ at: 'restored', result });
      // The passphrase and the file are done with.
      setPassphrase('');
      setFile(null);
      await onRestored();
    } catch (cause) {
      setPhase(read);
      setError(cause instanceof Error ? cause.message : 'the restore did not finish');
    }
  }

  return (
    <>
      <input
        ref={picker}
        type="file"
        accept=".fleetbak,.json,application/octet-stream,application/json"
        aria-label="The backup file"
        className="hidden"
        onChange={(event) => {
          void choose(event.target.files?.[0]);
          // Cleared so choosing the same file again fires again.
          event.target.value = '';
        }}
      />
      <RestoreChoice
        restore={restore}
        phase={phase}
        fileName={file?.name ?? null}
        sealed={file?.sealed ?? true}
        passphrase={passphrase}
        error={error}
        onPick={() => picker.current?.click()}
        onPassphrase={setPassphrase}
        onRead={() => void read()}
        onRestore={() => {
          if (phase.at === 'read') void restoreIt(phase);
        }}
        onAgain={() => {
          session.current += 1;
          setPhase({ at: 'choosing' });
          setFile(null);
          setPassphrase('');
          setChoices({});
          picker.current?.click();
        }}
        choices={choices}
        onToggle={(key) => setChoices((current) => ({ ...current, [key]: !current[key] }))}
        next={next}
        onContinue={onContinue}
      />
    </>
  );
}
