'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Copyable } from '@/components/copyable';
import { RestoreDialogBody, RestoreIntoSection, RestoreOutsideModal, closeButton } from '@/components/restore-into';
import { SettingsCard } from '@/components/settings-sections';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  SIGN_IN_DEFAULT,
  SIGN_IN_WHY,
  WHOLE_INSTALL,
  backupBotLabel,
  backupFilename,
  backupRequest,
  chosenAccounts,
  chosenSeats,
  downloadProblem,
  generatePassphrase,
  passphraseWarning,
  signInsOn,
  summaryLines,
  toggleAccount,
  toggleSeat,
  type BackupChoice,
  type BackupInventory,
} from '@/lib/backup';
import { cn } from '@/lib/cn';
import { countWords, inPipelineOrder, roleTitle } from '@/lib/crew';

/**
 * Settings' Backup card: two rows, Backup and Restore, each opening a modal.
 * Backup is what to take, a passphrase, and the download. Restore is
 * `restore-into.tsx`.
 *
 * What goes in a backup is the bridge's to decide — the same code `fleetadlc
 * backup` runs — and the card only ever sees names. It says, before the
 * download, what the file will hold and what it leaves out, and it says what
 * the two sign-in ticks mean, because they are the part of a backup that
 * behaves differently once it is copied. The archive is always sealed: the
 * unencrypted form is a deliberate `fleetadlc backup --unencrypted` and nothing
 * here offers it.
 */

/**
 * DialogContent is `min(37rem, 100vw - 2rem)` for every dialog. On a phone
 * that leaves a margin these two forms do not need, so they take the screen
 * below `sm`. The `!` wins over that width there only; `dialog.tsx` is
 * unchanged. With no backdrop left to tap, each modal has a Close of its own.
 */
const BACKUP_MODAL_CLASS =
  'max-sm:!inset-0 max-sm:!w-auto max-sm:!max-w-none max-sm:!translate-x-0 max-sm:!translate-y-0 max-sm:!rounded-none max-sm:!max-h-none';

/**
 * `/settings#restore` opens Restore. Anything after `#` is the whole id, so
 * `#backup?open=restore` matches no element and the page lands nowhere.
 */
const RESTORE_HASH = '#restore';

const rowButton =
  'inline-flex h-8 shrink-0 items-center rounded-md border border-edge-strong px-3 text-[12.5px] text-body hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link';

/** The Backup modal's title and Close, then the panel — or, until the bridge answers, why it has not. */
export function BackupDialogBody({
  inventory,
  loadError,
  panel,
}: {
  inventory: BackupInventory | null;
  loadError: string | null;
  panel: ReactNode;
}) {
  return (
    <>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <DialogTitle>Backup</DialogTitle>
          <DialogDescription>Download an encrypted copy of this install.</DialogDescription>
        </div>
        <DialogClose className={closeButton}>Close</DialogClose>
      </div>
      <div className="mt-3">
        {inventory ? panel : <p className="text-[12.5px] text-muted">{loadError ?? 'Reading what there is to back up…'}</p>}
      </div>
    </>
  );
}

type Busy = 'downloading' | null;

function Check({
  checked,
  onChange,
  disabled,
  children,
  line,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  line?: ReactNode;
}) {
  return (
    <label className={cn('flex items-start gap-2.5', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-[3px] size-4 shrink-0 accent-link"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] text-body">{children}</span>
        {line && <span className="text-[12px] leading-snug text-muted">{line}</span>}
      </span>
    </label>
  );
}

/** One group of the choice, under a hairline, the way every section of settings draws its rows. */
function Group({ title, line, children }: { title: ReactNode; line?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 border-t border-well py-3">
      {title}
      {line && <p className="-mt-1.5 pl-[26px] text-[12px] leading-snug text-muted">{line}</p>}
      {children && <div className="flex flex-col gap-2 pl-[26px]">{children}</div>}
    </div>
  );
}

/** The panel, drawn from what the bridge offers. `BackupCard` below reads it and does the download. */
export function BackupPanel({
  inventory,
  choice,
  onChoice,
  passphrase,
  again,
  onPassphrase,
  onAgain,
  busy,
  error,
  downloaded,
  onDownload,
}: {
  inventory: BackupInventory;
  choice: BackupChoice;
  onChoice: (choice: BackupChoice) => void;
  passphrase: string;
  again: string;
  onPassphrase: (value: string) => void;
  onAgain: (value: string) => void;
  busy: Busy;
  error: string | null;
  downloaded: string | null;
  onDownload: () => void;
}) {
  const seats = chosenSeats(choice, inventory);
  const accounts = chosenAccounts(choice, inventory);
  const folders = inventory.accounts.filter((account) => account.credential === 'sign-in');
  const problem = downloadProblem(choice, inventory, passphrase, again);
  // Warned, never refused: the button stays on for a short matching pair.
  const short = passphrase.length > 0 ? passphraseWarning(passphrase) : null;
  /** A passphrase "generate one" made, shown to copy while it is still the one in the fields. */
  const [generated, setGenerated] = useState<string | null>(null);
  const app = [
    inventory.install.app.clientId && 'client id',
    inventory.install.app.privateKey && 'private key',
    inventory.install.app.webhookSecret && 'webhook secret',
  ].filter((part): part is string => Boolean(part));
  const appWords = app.length > 1 ? `${app.slice(0, -1).join(', ')} and ${app[app.length - 1]}` : (app[0] ?? '');

  return (
    <div className="flex flex-col">
      <fieldset disabled={busy !== null} className="flex flex-col">
        <legend className="sr-only">What to include</legend>

        <Group
          title={
            <Check checked={choice.install} onChange={(install) => onChoice({ ...choice, install })}>
              Install and GitHub App
            </Check>
          }
          line={`The install’s ${countWords(inventory.install.settings.length, 'setting').toLowerCase()}${app.length > 0 ? `, and the app’s ${appWords}` : ''}.`}
        />

        <Group
          title={
            <Check
              checked={choice.repositories}
              onChange={(repositories) => onChoice({ ...choice, repositories })}
              disabled={inventory.repositories.length === 0}
            >
              Repositories
            </Check>
          }
          line={
            inventory.repositories.length === 0
              ? 'None yet.'
              : `${inventory.repositories.map((repo) => repo.fullName).join(', ')} — and what each stage may do without asking.`
          }
        />

        <Group
          title={<span className="text-[13px] font-semibold text-body">Crew</span>}
          line="Each bot’s seat, the GitHub account it is, its signing key and its model."
        >
          <Check checked={choice.bots === 'all'} onChange={(all) => onChoice({ ...choice, bots: all ? 'all' : [] })}>
            All bots
          </Check>
          <div className="flex flex-col gap-1.5 pl-[26px]">
            {inPipelineOrder(inventory.bots).map((bot) => {
              const label = backupBotLabel(bot);
              return (
                <Check key={bot.seat} checked={seats.includes(bot.seat)} onChange={() => onChoice(toggleSeat(choice, inventory, bot.seat))}>
                  {label.handle ? (
                    <>
                      {label.handle}
                      <span className="text-muted"> · {roleTitle({ name: bot.name, slot: bot.seat, role: bot.role })}</span>
                    </>
                  ) : (
                    <>
                      {roleTitle({ name: bot.name, slot: bot.seat, role: bot.role }) || bot.seat}
                      <span className="text-muted"> — {bot.login ? `${bot.login}, not signed in` : 'not connected'}</span>
                    </>
                  )}
                </Check>
              );
            })}
          </div>
          <div className="rounded-md bg-surface px-3 py-2.5">
            <Check
              checked={signInsOn(choice, 'botSignIns')}
              disabled={seats.length === 0}
              onChange={(botSignIns) => onChoice({ ...choice, botSignIns })}
              line={
                <>
                  {SIGN_IN_WHY} {SIGN_IN_DEFAULT}
                </>
              }
            >
              GitHub sign-ins
            </Check>
          </div>
        </Group>

        <Group
          title={<span className="text-[13px] font-semibold text-body">Model accounts</span>}
          line={inventory.accounts.length === 0 ? 'None yet.' : 'Each account’s key or subscription token.'}
        >
          {inventory.accounts.length > 0 && (
            <>
              <Check checked={choice.accounts === 'all'} onChange={(all) => onChoice({ ...choice, accounts: all ? 'all' : [] })}>
                All accounts
              </Check>
              <div className="flex flex-col gap-1.5 pl-[26px]">
                {inventory.accounts.map((account) => (
                  <Check
                    key={account.id}
                    checked={accounts.includes(account.id)}
                    onChange={() => onChoice(toggleAccount(choice, inventory, account.id))}
                  >
                    {account.label}
                    {account.credential === 'sign-in' && account.stored === false && (
                      <span className="text-muted"> — not signed in</span>
                    )}
                  </Check>
                ))}
              </div>
            </>
          )}
          {folders.length > 0 && (
            <div className="rounded-md bg-surface px-3 py-2.5">
              <Check
                checked={signInsOn(choice, 'accountSignIns')}
                disabled={!folders.some((account) => accounts.includes(account.id))}
                onChange={(accountSignIns) => onChoice({ ...choice, accountSignIns })}
                line={
                  <>
                    An OpenAI or xAI subscription’s sign-in rotates the same way: restoring it moves it to the new
                    install. {SIGN_IN_DEFAULT}
                  </>
                }
              >
                Subscription sign-ins
              </Check>
            </div>
          )}
        </Group>

        <Group
          title={
            <Check checked={choice.history} onChange={(history) => onChoice({ ...choice, history })}>
              History
            </Check>
          }
          line={`Threads, the audit log, the cost ledger, requests and the files given to the crew: ${countWords(inventory.history.threads, 'thread').toLowerCase()} and ${countWords(inventory.history.audit, 'audit line').toLowerCase()} so far. Off unless you want it.`}
        />
      </fieldset>

      <div className="flex flex-col gap-2.5 border-t border-well py-3">
        <span className="text-[13px] font-semibold text-body">Passphrase</span>
        <div className="flex flex-wrap gap-2.5">
          <input
            type="password"
            aria-label="Passphrase"
            autoComplete="new-password"
            value={passphrase}
            placeholder="passphrase"
            disabled={busy !== null}
            onChange={(event) => onPassphrase(event.target.value)}
            className="h-9 min-w-0 flex-1 rounded-md border border-edge-strong bg-surface px-3 text-[13px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link"
          />
          <input
            type="password"
            aria-label="Passphrase again"
            autoComplete="new-password"
            value={again}
            placeholder="again"
            disabled={busy !== null}
            onChange={(event) => onAgain(event.target.value)}
            className="h-9 min-w-0 flex-1 rounded-md border border-edge-strong bg-surface px-3 text-[13px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link"
          />
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              const made = generatePassphrase();
              onPassphrase(made);
              onAgain(made);
              setGenerated(made);
            }}
            className="h-9 shrink-0 rounded-md border border-edge bg-panel px-3 text-[12.5px] text-soft transition-colors hover:border-edge-strong hover:text-body focus-visible:outline-2 focus-visible:outline-link disabled:opacity-50"
          >
            generate one
          </button>
        </div>
        {generated && generated === passphrase && (
          <Copyable value={generated} label="Your passphrase — copy it into a password manager now" />
        )}
        <p className="text-[12px] leading-snug text-muted">
          The file is encrypted with it. Nothing else opens the file, and nothing can recover the passphrase for you. A good
          one is three or four random words, or a generated one.
        </p>
        {short && <p className="text-[12px] leading-snug text-attention">{short}</p>}
      </div>

      <div className="flex flex-col gap-2.5 border-t border-well pb-0.5 pt-3">
        <span className="text-[13px] font-semibold text-body">The file will hold</span>
        <ul aria-label="The file will hold" className="flex flex-col gap-1 text-[12.5px] leading-snug text-soft">
          {summaryLines(inventory, choice).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onDownload}
            disabled={problem !== null || busy !== null}
            className="inline-flex h-9 items-center rounded-md bg-body px-3.5 text-[13px] font-medium text-surface transition-colors hover:bg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:pointer-events-none disabled:opacity-50"
          >
            {busy === 'downloading' ? 'Preparing the file…' : 'Download backup'}
          </button>
          {problem && busy === null && <span className="text-[12px] text-muted">{problem}</span>}
        </div>
        {downloaded && (
          <p role="status" className="text-[12.5px] leading-snug text-signal">
            Downloaded {downloaded}. Keep it, and the passphrase, somewhere that is not this machine.
          </p>
        )}
        {error && (
          <p role="alert" className="text-[12.5px] leading-snug text-alarm">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

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

export function BackupCard({ initial = null }: { initial?: BackupInventory | null }) {
  const [inventory, setInventory] = useState<BackupInventory | null>(initial);
  const [choice, setChoice] = useState<BackupChoice>(WHOLE_INSTALL);
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/backup', { cache: 'no-store' });
      if (!response.ok) throw new Error(await bridgeError(response));
      setInventory((await response.json()) as BackupInventory);
      // A read that worked: the last one's failure is not a download's.
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not read what there is to back up');
    }
  }, []);

  useEffect(() => {
    // The page read it for the first paint. Asking again would only replace
    // what the modal can already show.
    if (initial) return;
    void load();
  }, [initial, load]);

  // `#restore` on load, and again whenever the hash becomes that.
  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash === RESTORE_HASH) setRestoreOpen(true);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  // The passphrase is typed for the download in front of the person, and a
  // line saying the last download worked, or failed, belongs to that visit:
  // none of it is waiting in the modal the next time Backup opens.
  function onBackupOpenChange(open: boolean): void {
    setBackupOpen(open);
    if (open) {
      // Its error was cleared when it closed; a failed read is asked again.
      if (!inventory) void load();
      return;
    }
    setPassphrase('');
    setAgain('');
    setDownloaded(null);
    setError(null);
  }

  // The hash is still `#restore` after the modal it opened is closed, and a
  // link to `#restore` then changes nothing, so no `hashchange` opens it.
  function onRestoreOpenChange(open: boolean): void {
    setRestoreOpen(open);
    if (!open && window.location.hash === RESTORE_HASH) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#backup`);
    }
  }

  async function download(): Promise<void> {
    setBusy('downloading');
    setError(null);
    setDownloaded(null);
    try {
      const response = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(backupRequest(choice, passphrase, again)),
      });
      if (!response.ok) throw new Error(await bridgeError(response));
      const name = backupFilename(response.headers.get('content-disposition'));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDownloaded(name);
      // Not kept on the page once it has done its job.
      setPassphrase('');
      setAgain('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the backup could not be made');
    } finally {
      setBusy(null);
    }
  }

  const panel = inventory ? (
    <BackupPanel
      inventory={inventory}
      choice={choice}
      onChoice={(next) => {
        setChoice(next);
        setDownloaded(null);
      }}
      passphrase={passphrase}
      again={again}
      onPassphrase={setPassphrase}
      onAgain={setAgain}
      busy={busy}
      error={error}
      downloaded={downloaded}
      onDownload={() => void download()}
    />
  ) : null;

  return (
    <SettingsCard id="backup" title="Backup" line="An encrypted copy of this install, to set a new one up from — or to put back into this one.">
      <div className="flex flex-wrap items-center gap-3 border-t border-well py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-semibold text-body">Backup</span>
          <span className="text-[12px] leading-snug text-muted">Download an encrypted copy of this install.</span>
        </div>
        {/* Through the handler: Radix calls it only for its own close, so a
            failed read was never asked again and the modal said "Reading…" for good. */}
        <button type="button" onClick={() => onBackupOpenChange(true)} className={rowButton}>
          Backup
        </button>
      </div>

      <RestoreIntoSection open={restoreOpen}>
        {(restore) => (
          <>
            <div id="restore" className="flex scroll-mt-7 flex-col gap-2 border-t border-well pb-0.5 pt-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px] font-semibold text-body">Restore</span>
                  <span className="text-[12px] leading-snug text-muted">Put a backup back into this install.</span>
                </div>
                <button type="button" onClick={() => setRestoreOpen(true)} className={rowButton}>
                  Restore
                </button>
              </div>
              <RestoreOutsideModal
                running={restore.running}
                runningKind={restore.runningKind}
                outcome={restore.outcome}
                open={restoreOpen}
                undo={restore.undo}
                error={restore.undoError}
                busy={restore.undoing}
                onShow={() => setRestoreOpen(true)}
                onUndo={restore.onUndo}
              />
            </div>
            <Dialog open={restoreOpen} onOpenChange={onRestoreOpenChange}>
              <DialogContent className={BACKUP_MODAL_CLASS}>
                <RestoreDialogBody>{restore.form}</RestoreDialogBody>
              </DialogContent>
            </Dialog>
          </>
        )}
      </RestoreIntoSection>

      <Dialog open={backupOpen} onOpenChange={onBackupOpenChange}>
        <DialogContent className={BACKUP_MODAL_CLASS}>
          <BackupDialogBody inventory={inventory} loadError={error} panel={panel} />
        </DialogContent>
      </Dialog>
    </SettingsCard>
  );
}
