// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupInventory, IntoPreview, RestoreJob, UndoView } from '@/lib/backup';
import { BackupCard } from './backup-card';

/**
 * Settings → Backup in a DOM: the Backup and Restore modals open, close with
 * their own Close (a phone has no backdrop left to tap, and no Esc), forget
 * what was typed into them, and a restore followed from the section is still
 * followed after a status check fails and says how it ended.
 */

const INVENTORY: BackupInventory = {
  install: { settings: ['operatorEmail'], app: { clientId: true, privateKey: true, webhookSecret: true } },
  repositories: [{ name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' }],
  bots: [
    { seat: 'builder', name: 'fleetadlc-atlas-janedoe', role: 'implement', login: 'fleetadlc-atlas-janedoe', signIn: 'refresh', signingKey: true, modelAccountId: null },
  ],
  accounts: [],
  history: { threads: 1, messages: 2, audit: 3, ledger: 4, requests: 5 },
};

const WAITING: RestoreJob = {
  id: 'job-1',
  kind: 'restore',
  state: 'waiting',
  startedAt: '2026-09-25T10:00:00.000Z',
  finishedAt: null,
  waitingFor: ['fleetadlc-atlas-janedoe'],
  error: null,
  result: null,
};
const APPLYING: RestoreJob = { ...WAITING, state: 'applying', waitingFor: [] };
const FAILED: RestoreJob = { ...APPLYING, state: 'failed', finishedAt: '2026-09-25T10:01:00.000Z', error: 'hostd did not answer' };

/** What `GET /api/restore/into` answers, one entry per request; `'fail'` is a request that fails. */
let answers: Array<RestoreJob | null | 'fail'>;
let asked: number;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', '/settings');
  answers = [];
  asked = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/backup') return Response.json({ error: 'the bridge could not seal the file' }, { status: 500 });
      if (url !== '/api/restore/into') throw new Error(`unexpected request to ${url}`);
      asked += 1;
      const next = answers.length > 1 ? answers.shift()! : (answers[0] ?? null);
      if (next === 'fail') return new Response('bridge unreachable', { status: 502 });
      return Response.json({ job: next, undo: null });
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(): Promise<void> {
  await act(async () => root.render(<BackupCard initial={INVENTORY} />));
  await settle();
}

/** The open dialog, which Radix portals into the body rather than the card. */
function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role=dialog]');
}

function button(label: string, within: ParentNode = document.body): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no button says ${label}: ${[...within.querySelectorAll('button')].map((one) => one.textContent).join(', ')}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await settle();
}

/** Types into a controlled input the way a person does: React reads the input event. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function field(label: string): HTMLInputElement {
  const found = dialog()?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`no field ${label}`);
  return found;
}

describe('the Backup modal', () => {
  it('fills both fields with a generated passphrase and shows it to copy', async () => {
    await mount();
    await click(button('Backup', container));
    await click(button('generate one', dialog()!));

    const made = field('Passphrase').value;
    expect(made).toMatch(/^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){4}$/);
    expect(field('Passphrase again').value).toBe(made);
    expect(dialog()?.textContent).toContain('copy it into a password manager now');
    expect(dialog()?.textContent).toContain(made);
    expect(button('Download backup', dialog()!).disabled).toBe(false);

    // Typed over, it is no longer the one shown.
    await type(field('Passphrase'), 'something else entirely');
    expect(dialog()?.textContent).not.toContain(made);
  });

  it('warns about a short passphrase and still lets it download', async () => {
    await mount();
    await click(button('Backup', container));
    await type(field('Passphrase'), '1234');
    await type(field('Passphrase again'), '1234');

    expect(dialog()?.textContent).toContain('Shorter than 12 characters');
    expect(button('Download backup', dialog()!).disabled).toBe(false);
  });

  it('closes with its own Close, and opens again with both passphrase fields empty', async () => {
    await mount();
    await click(button('Backup', container));
    expect(dialog()?.textContent).toContain('Download an encrypted copy of this install.');

    await type(field('Passphrase'), 'correct horse');
    await type(field('Passphrase again'), 'correct horse');
    expect(field('Passphrase').value).toBe('correct horse');

    await click(button('Close', dialog()!));
    expect(dialog()).toBeNull();

    await click(button('Backup', container));
    expect(field('Passphrase').value).toBe('');
    expect(field('Passphrase again').value).toBe('');
  });

  it('opens again without the last download’s error', async () => {
    await mount();
    await click(button('Backup', container));
    await type(field('Passphrase'), 'correct horse battery');
    await type(field('Passphrase again'), 'correct horse battery');
    await click(button('Download backup', dialog()!));
    expect(dialog()?.querySelector('[role=alert]')?.textContent).toBe('the bridge could not seal the file');

    await click(button('Close', dialog()!));
    await click(button('Backup', container));
    expect(dialog()?.querySelector('[role=alert]')).toBeNull();
  });

  it('takes the whole screen on a phone', async () => {
    await mount();
    await click(button('Backup', container));
    const classes = dialog()!.className.split(/\s+/);
    for (const phone of ['max-sm:!inset-0', 'max-sm:!w-auto', 'max-sm:!translate-x-0', 'max-sm:!translate-y-0', 'max-sm:!rounded-none']) {
      expect(classes).toContain(phone);
    }
  });
});

describe('the Backup modal over a read that failed', () => {
  it('asks again when it is opened again, and drops the failure once the read works', async () => {
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/restore/into') return Response.json({ job: null, undo: null });
        reads += 1;
        return reads < 3 ? Response.json({ error: 'the bridge is restarting' }, { status: 502 }) : Response.json(INVENTORY);
      }),
    );
    await act(async () => root.render(<BackupCard initial={null} />));
    await settle();
    expect(reads).toBe(1);

    // Each open asks again while there is nothing to show.
    await click(button('Backup', container));
    await settle();
    expect(reads).toBe(2);
    expect(dialog()?.textContent).toContain('the bridge is restarting');
    await click(button('Close', dialog()!));

    // Opened by setting the state, the handler that asks again never ran:
    // "Reading what there is to back up…" for good, with nothing asked.
    await click(button('Backup', container));
    await settle();
    expect(reads).toBe(3);
    expect(field('Passphrase')).toBeTruthy();
    expect(dialog()?.textContent).not.toContain('the bridge is restarting');
  });

  it('does not say the failed read under Download once a read has worked', async () => {
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/restore/into') return Response.json({ job: null, undo: null });
        reads += 1;
        return reads === 1 ? Response.json({ error: 'the bridge is restarting' }, { status: 502 }) : Response.json(INVENTORY);
      }),
    );
    await act(async () => root.render(<BackupCard initial={null} />));
    await settle();
    await click(button('Backup', container));
    await settle();
    expect(reads).toBe(2);
    expect(field('Passphrase')).toBeTruthy();
    expect(dialog()?.textContent).not.toContain('the bridge is restarting');
  });
});

describe('the Restore modal', () => {
  it('opens from #restore when the page loads, closes with Close, and #restore opens it again afterwards', async () => {
    window.history.replaceState(null, '', '/settings#restore');
    await mount();
    expect(dialog()?.textContent).toContain('Put a backup back into this install.');
    expect(dialog()!.className).toContain('max-sm:!inset-0');

    await click(button('Close', dialog()!));
    expect(dialog()).toBeNull();
    // Left on #restore, a later link to it would change nothing and open nothing.
    expect(window.location.hash).toBe('#backup');

    await act(async () => {
      window.location.hash = '#restore';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await settle();
    expect(dialog()?.textContent).toContain('Put a backup back into this install.');
  });

  it('forgets the chosen file and its passphrase when it is closed with no restore running', async () => {
    await mount();
    await click(button('Restore', container));
    const picker = dialog()!.querySelector<HTMLInputElement>('input[type=file]')!;
    const sealed = new File([new TextEncoder().encode('FLEETBAK sealed bytes')], 'fleetadlc-backup.fleetbak');
    await act(async () => {
      Object.defineProperty(picker, 'files', { value: [sealed], configurable: true });
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    await type(field('The backup’s passphrase'), 'correct horse');
    expect(field('The backup’s passphrase').value).toBe('correct horse');

    await click(button('Close', dialog()!));
    await click(button('Restore', container));
    expect(dialog()?.textContent).not.toContain('fleetadlc-backup.fleetbak');
    expect(dialog()?.querySelector('input[type=password]')).toBeNull();
    expect(button('choose the backup file', dialog()!)).toBeTruthy();
  });

  it('opens when the hash becomes #restore after the page has loaded', async () => {
    await mount();
    expect(dialog()).toBeNull();
    await act(async () => {
      window.location.hash = '#restore';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await settle();
    expect(dialog()?.textContent).toContain('Put a backup back into this install.');
  });

  it('keeps following a restore after a failed check, and says how it ended while the modal was closed', async () => {
    vi.useFakeTimers();
    // The page opens on a restore already running; the first check after that fails.
    answers = [WAITING, 'fail', APPLYING];
    await mount();
    expect(container.textContent).toContain('A restore is running…');

    await settle(2_000); // the failed check
    await settle(2_000); // asked again, and now applying
    expect(asked).toBe(3);
    expect(container.textContent).toContain('A restore is running…');

    // Show opens on the job as it stands now, not as the page first saw it.
    await click(button('Show', container));
    expect(dialog()?.textContent).toContain('Restoring: this install has been backed up first');
    await click(button('Close', dialog()!));
    expect(dialog()).toBeNull();

    answers = [FAILED];
    await settle(2_000);
    expect(container.textContent).not.toContain('A restore is running…');
    expect(container.textContent).toContain('The restore did not finish: hostd did not answer');

    await click(button('Show', container));
    expect(dialog()?.textContent).toContain('The restore did not finish: hostd did not answer');
    await click(button('Close', dialog()!));
    // Seen once in the modal, it is not said again on the section.
    expect(container.textContent).not.toContain('The restore did not finish');
  });
});

const UNDO: UndoView = {
  restoredAt: '2026-09-25T10:00:00.000Z',
  until: '2026-09-26T10:00:00.000Z',
  backupMadeAt: '2026-09-24T12:00:00.000Z',
  actor: 'alex@example.test',
};

/** A comparison of whatever archive was sent, named after it so a test can tell whose it is. */
function previewOf(archive: string, undo: UndoView | null = null): IntoPreview {
  const from = atob(archive);
  return {
    sealed: false,
    holds: {
      version: 2,
      createdAt: '2026-09-24T12:00:00.000Z',
      install: { settings: [], app: [], other: [] },
      repositories: [],
      bots: [],
      botSignIns: true,
      accounts: [],
      accountSignIns: true,
      history: null,
    },
    comparison: {
      groups: [
        {
          group: 'install',
          items: [
            { key: 'setting:engineUpdates', group: 'install', label: `Engine updates from ${from}`, state: 'new', differences: [], takeable: true, take: true, note: null, dependsOn: null },
          ],
        },
      ],
      choices: { 'setting:engineUpdates': true },
    },
    undo,
  } as IntoPreview;
}

/**
 * The bridge as the Restore modal talks to it: each POST is recorded and
 * held until the test answers it, so a second click lands while the first
 * is still in flight.
 */
function restoreBridge(undo: UndoView | null = null) {
  const posts: { url: string; body: Record<string, unknown>; answer: (response: Response) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return Promise.resolve(Response.json({ job: null, undo }));
      return new Promise<Response>((resolve) => posts.push({ url, body: JSON.parse(String(init.body)), answer: resolve }));
    }),
  );
  const sent = (url: string) => posts.filter((post) => post.url === url);
  return { posts, sent };
}

/** Picks a file in the Restore modal, as the file chooser hands it over. */
async function pick(file: File): Promise<void> {
  const picker = dialog()!.querySelector<HTMLInputElement>('input[type=file]')!;
  await act(async () => {
    Object.defineProperty(picker, 'files', { value: [file], configurable: true });
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

async function doubleClick(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    target.click();
  });
  await settle();
}

describe('one click on the Restore modal, one job', () => {
  it('sends one undo for a double-click on Undo, and keeps the button off while it is in flight', async () => {
    const { sent } = restoreBridge(UNDO);
    await mount();
    await click(button('Restore', container));

    await doubleClick(button('Undo the restore', dialog()!));
    expect(sent('/api/restore/undo')).toHaveLength(1);
    expect(button('Undo the restore', dialog()!).disabled).toBe(true);
  });

  it('sends one restore for a double-click on Restore, and keeps Restore and Undo off while it is in flight', async () => {
    const { sent } = restoreBridge(UNDO);
    await mount();
    await click(button('Restore', container));
    await pick(backupFile('backup A', 'a.json'));
    await click(button('Compare it with this install', dialog()!));
    await act(async () => sent('/api/restore/into/preview')[0]!.answer(Response.json(previewOf(sent('/api/restore/into/preview')[0]!.body.archive as string, UNDO))));
    await settle();

    await doubleClick(button('Restore 1 thing', dialog()!));
    expect(sent('/api/restore/into')).toHaveLength(1);
    expect(button('Restore 1 thing', dialog()!).disabled).toBe(true);
    expect(button('Undo the restore', dialog()!).disabled).toBe(true);
  });
});

/** A backup file whose bytes are read at once (happy-dom's own reader takes a timer or two). */
function backupFile(text: string, name: string): File {
  const file = new File([text], name);
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(text).buffer });
  return file;
}

/** A file whose bytes arrive only when the test lets them: a large one, or one in a cloud-synced folder. */
function slowFile(text: string, name: string): { file: File; arrive: () => Promise<void> } {
  const file = new File([text], name);
  let release: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (release = resolve));
  Object.defineProperty(file, 'arrayBuffer', { value: async () => (await ready, new TextEncoder().encode(text).buffer) });
  return {
    file,
    arrive: async () => {
      await act(async () => release());
      await settle();
    },
  };
}

describe('the backup the Restore modal compares, and the one it restores', () => {
  it('shows no Compare for the file before while the next one is still being read', async () => {
    restoreBridge();
    await mount();
    await click(button('Restore', container));
    await pick(backupFile('backup A', 'a.json'));
    expect(button('Compare it with this install', dialog()!).disabled).toBe(false);

    const b = slowFile('backup B', 'b.json');
    await pick(b.file);
    expect(dialog()!.textContent).not.toContain('a.json');
    expect(() => button('Compare it with this install', dialog()!)).toThrow();

    await b.arrive();
    expect(dialog()!.textContent).toContain('b.json');
    expect(button('Compare it with this install', dialog()!).disabled).toBe(false);
  });

  it('drops a comparison of the file before that answers after the next one was chosen, and restores what it compared', async () => {
    const { sent } = restoreBridge();
    await mount();
    await click(button('Restore', container));
    await pick(backupFile('backup A', 'a.json'));
    await click(button('Compare it with this install', dialog()!));
    const ofA = sent('/api/restore/into/preview')[0]!;

    await pick(backupFile('backup B', 'b.json'));
    await act(async () => ofA.answer(Response.json(previewOf(ofA.body.archive as string))));
    await settle();
    expect(dialog()!.textContent).toContain('b.json');
    expect(dialog()!.textContent).not.toContain('Engine updates from backup A');
    expect(() => button('Restore 1 thing', dialog()!)).toThrow();

    await click(button('Compare it with this install', dialog()!));
    const ofB = sent('/api/restore/into/preview')[1]!;
    await act(async () => ofB.answer(Response.json(previewOf(ofB.body.archive as string))));
    await settle();
    expect(dialog()!.textContent).toContain('Engine updates from backup B');
    await click(button('Restore 1 thing', dialog()!));
    expect(atob(sent('/api/restore/into')[0]!.body.archive as string)).toBe('backup B');
  });
});
