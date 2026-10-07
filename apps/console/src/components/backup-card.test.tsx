import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BackupCard, BackupDialogBody, BackupPanel } from './backup-card';
import { Dialog } from '@/components/ui/dialog';
import {
  WHOLE_INSTALL,
  backupFilename,
  backupRequest,
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

/**
 * Settings' Backup card: what to take, grouped, with each group's names and
 * the two sign-in ticks said honestly; a passphrase twice; a line per group
 * saying what the file will hold; and one button.
 */

const INVENTORY: BackupInventory = {
  install: { settings: ['operatorEmail', 'organization', 'publicUrl'], app: { clientId: true, privateKey: true, webhookSecret: true } },
  repositories: [{ name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' }],
  bots: [
    { seat: 'builder', name: 'fleetadlc-atlas-janedoe', role: 'implement', login: 'fleetadlc-atlas-janedoe', signIn: 'refresh', signingKey: true, modelAccountId: 'max' },
    { seat: 'lead-reviewer', name: 'lead-reviewer', role: 'review_lead', login: null, signIn: null, signingKey: false, modelAccountId: null },
    { seat: 'automation', name: 'janedoe-fleetadlc-flow', role: 'automation', login: 'janedoe-fleetadlc-flow', signIn: 'refresh', signingKey: true, modelAccountId: null },
  ],
  accounts: [
    { id: 'max', label: 'Anthropic — Max', provider: 'anthropic', kind: 'subscription', credential: 'token', stored: true },
    { id: 'pro', label: 'ChatGPT Pro', provider: 'openai', kind: 'subscription', credential: 'sign-in', stored: true },
  ],
  history: { threads: 12, messages: 340, audit: 1200, ledger: 80, requests: 14 },
};

function render(choice: BackupChoice = WHOLE_INSTALL, fields: { passphrase?: string; again?: string } = {}): string {
  return renderToStaticMarkup(
    <BackupPanel
      inventory={INVENTORY}
      choice={choice}
      onChoice={() => undefined}
      passphrase={fields.passphrase ?? ''}
      again={fields.again ?? ''}
      onPassphrase={() => undefined}
      onAgain={() => undefined}
      busy={null}
      error={null}
      downloaded={null}
      onDownload={() => undefined}
    />,
  ).replace(/<!-- -->/g, '');
}

/** Whether the box beside a label is ticked. */
function ticked(html: string, label: string): boolean {
  const at = html.indexOf(`>${label}<`);
  const box = html.lastIndexOf('<input type="checkbox"', at);
  expect(at).toBeGreaterThan(-1);
  return html.slice(box, html.indexOf('/>', box)).includes('checked=""');
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('the Backup card', () => {
  it('groups what can be taken, with every bot and every account by name', () => {
    const said = text(render());

    for (const group of ['Install and GitHub App', 'Repositories', 'Crew', 'All bots', 'Model accounts', 'All accounts', 'History']) {
      expect(said).toContain(group);
    }
    expect(said).toContain('The install’s three settings, and the app’s client id, private key and webhook secret.');
    expect(said).toContain('janedoe/fleetadlc-testbed');
    expect(said).toContain('fleetadlc-atlas-janedoe · Builder');
    expect(said).toContain('Lead reviewer — not connected');
    expect(said).toContain('Anthropic — Max');
    expect(said).toContain('ChatGPT Pro');
  });

  it('says what the GitHub sign-ins are, and that they are on for the whole install', () => {
    const html = render();
    const said = text(html);

    expect(said).toContain('GitHub sign-ins');
    expect(said).toContain('GitHub rotates a sign-in each time it is used, so restoring one moves it to the new install.');
    expect(said).toContain('if it keeps running, one of the two will need reconnecting');
    expect(said).toContain('On by default when you back up everything, off when you choose part of it.');
    expect(said).toContain('Subscription sign-ins');
    expect(ticked(html, 'GitHub sign-ins')).toBe(true);
    expect(ticked(html, 'Subscription sign-ins')).toBe(true);
  });

  it('turns the sign-ins off when only part of the install is chosen', () => {
    const part = toggleSeat(WHOLE_INSTALL, INVENTORY, 'automation');

    expect(part.bots).toEqual(['builder', 'lead-reviewer']);
    expect(signInsOn(part, 'botSignIns')).toBe(false);
    expect(ticked(render(part), 'GitHub sign-ins')).toBe(false);
    expect(ticked(render(part), 'All bots')).toBe(false);
    // Ticked on purpose, it stays on.
    expect(signInsOn({ ...part, botSignIns: true }, 'botSignIns')).toBe(true);
    // And all of them again is the whole crew again.
    expect(toggleSeat(part, INVENTORY, 'automation').bots).toBe('all');
  });

  it('asks for the passphrase twice, hidden, and offers nothing unencrypted', () => {
    const html = render();

    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Passphrase again"');
    expect(html.toLowerCase()).not.toContain('unencrypted');
    expect(text(html)).toContain('nothing can recover the passphrase for you');
  });

  it('says what the file will hold, by name and count, before anything is downloaded', () => {
    const said = text(render());

    expect(said).toContain('The file will hold');
    expect(said).toContain('Every bot, with 2 of their GitHub sign-ins');
    expect(said).toContain('Two model accounts: Anthropic — Max, ChatGPT Pro, with one subscription sign-in');
    expect(said).toContain('Not included: the history.');
  });

  it('will not download without a passphrase typed twice the same', () => {
    expect(render()).toMatch(/<button type="button" disabled=""[^>]*>Download backup<\/button>/);
    expect(text(render())).toContain('Give the backup a passphrase.');
    expect(text(render(WHOLE_INSTALL, { passphrase: 'a', again: 'b' }))).toContain('The two passphrases do not match.');
    expect(render(WHOLE_INSTALL, { passphrase: 'correct horse', again: 'correct horse' })).toMatch(
      /<button type="button"(?! disabled)[^>]*>Download backup<\/button>/,
    );
  });
});

describe('a short passphrase', () => {
  const WARNING = 'Shorter than 12 characters: anyone who gets this file can guess a short passphrase offline';

  it('is warned about under the fields, and the download stays on', () => {
    const html = render(WHOLE_INSTALL, { passphrase: '1234', again: '1234' });
    expect(text(html)).toContain(WARNING);
    expect(html).toMatch(/<button type="button"(?! disabled)[^>]*>Download backup<\/button>/);
    expect(downloadProblem(WHOLE_INSTALL, INVENTORY, '1234', '1234')).toBeNull();
  });

  it('is not warned about before anything is typed, or once it is 12 characters', () => {
    expect(text(render())).not.toContain(WARNING);
    expect(text(render(WHOLE_INSTALL, { passphrase: 'correct horse', again: 'correct horse' }))).not.toContain(WARNING);
  });

  it('is counted the way the backup package counts it', () => {
    expect(passphraseWarning('a'.repeat(11))).toMatch(/^Shorter than 12 characters/);
    expect(passphraseWarning('a'.repeat(12))).toBeNull();
    expect(passphraseWarning('cafe\u0301-au-lai')).not.toBeNull();
  });

  it('has a generated one offered beside it, and says what a good one looks like', () => {
    const said = text(render());
    expect(said).toContain('generate one');
    expect(said).toContain('three or four random words, or a generated one');
    const made = generatePassphrase();
    expect(made).toMatch(/^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){4}$/);
    expect(passphraseWarning(made)).toBeNull();
    expect(generatePassphrase()).not.toBe(made);
  });
});

describe('what the card sends and saves', () => {
  it('sends the choice with each sign-in tick as it stands, and the passphrase twice', () => {
    const part = toggleAccount(WHOLE_INSTALL, INVENTORY, 'pro');

    expect(backupRequest(part, 'p', 'p')).toEqual({
      selection: {
        install: true,
        repositories: true,
        bots: 'all',
        botSignIns: false,
        accounts: ['max'],
        accountSignIns: false,
        history: false,
      },
      passphrase: 'p',
      confirm: 'p',
    });
    expect(backupRequest(WHOLE_INSTALL, 'p', 'p').selection).toMatchObject({ botSignIns: true, accountSignIns: true });
  });

  it('refuses a choice of nothing', () => {
    const nothing: BackupChoice = { ...WHOLE_INSTALL, install: false, repositories: false, bots: [], accounts: [], history: false };
    expect(downloadProblem(nothing, INVENTORY, 'p', 'p')).toBe('Choose something to back up.');
    expect(summaryLines(INVENTORY, nothing).at(-1)).toBe(
      'Not included: the install and its app, the repositories, the crew, the model accounts and the history.',
    );
  });

  it('names the files given to the crew among the history, since the archive carries them in full', () => {
    const history = { ...WHOLE_INSTALL, history: true };
    const withFiles = { ...INVENTORY, history: { ...INVENTORY.history, attachments: 7 } };
    expect(summaryLines(withFiles, history)).toContain(
      'History: twelve threads, 340 messages, 1200 audit lines, 80 costs, 14 requests and seven attachments',
    );
    expect(summaryLines(INVENTORY, history).find((line) => line.startsWith('History:'))).not.toContain('attachment');
  });

  it('saves the file under the bridge’s name for it', () => {
    expect(backupFilename('attachment; filename="fleetadlc-backup-2026-09-24.fleetbak"')).toBe('fleetadlc-backup-2026-09-24.fleetbak');
    expect(backupFilename(null, new Date('2026-09-24T10:00:00Z'))).toBe('fleetadlc-backup-2026-09-24.fleetbak');
    expect(backupFilename('attachment; filename="../../x"', new Date('2026-09-24T10:00:00Z'))).toBe('fleetadlc-backup-2026-09-24.fleetbak');
  });
});

describe('Backup and Restore as two rows', () => {
  it('shows the two rows, and not the forms, until a button opens one', () => {
    const html = renderToStaticMarkup(<BackupCard />).replace(/<!-- -->/g, '');
    const said = text(html);

    expect(said).toContain('An encrypted copy of this install, to set a new one up from — or to put back into this one.');
    expect(said).toContain('Download an encrypted copy of this install.');
    expect(said).toContain('Put a backup back into this install.');
    expect(html).toContain('id="backup"');
    expect(html).toContain('id="restore"');
    expect(html).toMatch(/<button type="button"[^>]*>Backup<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*>Restore<\/button>/);
    expect(html).not.toContain('type="password"');
    expect(said).not.toContain('choose the backup file');
    expect(said).not.toContain('Restore from a backup');
  });

  it('opens Backup onto today’s panel: the choice, the passphrase twice, and Download', () => {
    const html = renderToStaticMarkup(
      <Dialog>
        <BackupDialogBody
          inventory={INVENTORY}
          loadError={null}
          panel={
            <BackupPanel
              inventory={INVENTORY}
              choice={WHOLE_INSTALL}
              onChoice={() => undefined}
              passphrase="correct horse"
              again="correct horse"
              onPassphrase={() => undefined}
              onAgain={() => undefined}
              busy={null}
              error={null}
              downloaded="fleetadlc-backup-2026-09-24.fleetbak"
              onDownload={() => undefined}
            />
          }
        />
      </Dialog>,
    ).replace(/<!-- -->/g, '');
    const said = text(html);

    expect(said).toContain('Backup');
    expect(said).toContain('Download an encrypted copy of this install.');
    expect(html).toContain('aria-label="Passphrase"');
    expect(html).toContain('aria-label="Passphrase again"');
    expect(html).toContain('value="correct horse"');
    expect(said).toContain('Download backup');
    expect(said).toContain('Downloaded fleetadlc-backup-2026-09-24.fleetbak');
    expect(said).toContain('The file will hold');
  });
});
