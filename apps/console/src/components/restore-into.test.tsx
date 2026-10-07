import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RestoreDialogBody, RestoreIntoPanel, RestoreOutsideModal, undoOnOffer, type IntoPhase } from './restore-into';
import { Dialog } from '@/components/ui/dialog';
import { takenCount, type Comparison, type IntoPreview, type RestoreJob, type RestoreSummary, type UndoView } from '@/lib/backup';

/**
 * Settings → Backup's restore into an install that is set up: the backup laid
 * beside this install, a choice beside each thing that has one, every sign-in
 * checked; then where the restore has got to, what came back, and Undo.
 */

const COMPARISON: Comparison = {
  groups: [
    {
      group: 'install',
      items: [
        { key: 'setting:engineUpdates', group: 'install', label: 'Weekly engine updates', state: 'new', differences: [], takeable: true, take: true, note: null, dependsOn: null },
        {
          key: 'setting:operatorEmail',
          group: 'install',
          label: 'The operator’s email',
          state: 'different',
          differences: ['ops@b.example.test here, alex@example.test in the backup'],
          takeable: true,
          take: false,
          note: null,
          dependsOn: null,
        },
        { key: 'setting:organization', group: 'install', label: 'The organization', state: 'same', differences: [], takeable: false, take: false, note: null, dependsOn: null },
        { key: 'setting:publicUrl', group: 'install', label: 'The public address', state: 'only-here', differences: [], takeable: false, take: false, note: null, dependsOn: null },
      ],
    },
    {
      group: 'crew',
      items: [
        {
          key: 'seat:lead-reviewer:account',
          group: 'crew',
          label: 'Lead reviewer’s GitHub account',
          state: 'different',
          differences: ['fleetadlc-other here, fleetadlc-sydney-janedoe in the backup'],
          takeable: true,
          take: false,
          note: 'Taking the backup’s makes Lead reviewer fleetadlc-sydney-janedoe; this install’s sign-in for fleetadlc-other is let go.',
          dependsOn: null,
          seat: 'lead-reviewer',
          accounts: { here: 'fleetadlc-other', backup: 'fleetadlc-sydney-janedoe' },
        },
      ],
    },
    {
      group: 'sign-ins',
      items: [
        {
          key: 'signin:bot:lead-reviewer',
          group: 'sign-ins',
          label: 'Lead reviewer as fleetadlc-sydney-janedoe',
          state: 'different',
          differences: [],
          takeable: true,
          take: false,
          note: 'Checking a GitHub sign-in uses it — if it works, this install takes it over from wherever else it is in use.',
          dependsOn: 'seat:lead-reviewer:account',
          seat: 'lead-reviewer',
          verdict: { state: 'check-by-use' },
          rotates: true,
        },
        {
          key: 'signin:account:c',
          group: 'sign-ins',
          label: 'Claude Max',
          state: 'new',
          differences: [],
          takeable: false,
          take: false,
          note: 'Anthropic did not accept it: invalid x-api-key',
          dependsOn: null,
          verdict: { state: 'blocked', reason: 'Anthropic did not accept it: invalid x-api-key' },
          rotates: false,
        },
        {
          key: 'signin:account:x',
          group: 'sign-ins',
          label: 'ChatGPT Pro',
          state: 'new',
          differences: [],
          takeable: true,
          take: false,
          note: 'Checking a subscription’s sign-in uses it — if it works, this install takes it over from wherever else it is in use.',
          dependsOn: null,
          verdict: { state: 'check-by-use' },
          rotates: true,
        },
      ],
    },
  ],
  choices: { 'setting:engineUpdates': true, 'setting:operatorEmail': false, 'seat:lead-reviewer:account': false, 'signin:bot:lead-reviewer': false, 'signin:account:x': false },
};

const PREVIEW: IntoPreview = {
  sealed: true,
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
  comparison: COMPARISON,
  undo: null,
};

/** The archive a `read` phase was compared from, which Restore sends. */
const ARCHIVE = { archive: 'RkxFRVRCQUs=', sealed: true };

const UNDO: UndoView = {
  restoredAt: '2026-09-25T10:00:00.000Z',
  until: '2026-09-26T10:00:00.000Z',
  backupMadeAt: '2026-09-24T12:00:00.000Z',
  actor: 'alex@example.test',
};

function render(
  phase: IntoPhase,
  choices: Record<string, boolean> = COMPARISON.choices,
  undo: UndoView | null = null,
  inFlight: { undoing?: boolean; starting?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <RestoreIntoPanel
      {...inFlight}
      phase={phase}
      fileName={phase.at === 'read' ? 'fleetadlc-backup-2026-09-24.fleetbak' : null}
      sealed
      passphrase=""
      choices={choices}
      undo={undo}
      error={null}
      onPick={() => undefined}
      onPassphrase={() => undefined}
      onRead={() => undefined}
      onChoice={() => undefined}
      onRestore={() => undefined}
      onUndo={() => undefined}
    />,
  ).replace(/<!-- -->/g, '');
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

/** The input a label of this item carries. */
function control(html: string, label: string): string {
  const at = html.indexOf(`aria-label="${label}`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<input', at);
  return html.slice(start, html.indexOf('/>', start));
}

describe('restoring a backup into an install that is set up', () => {
  it('offers to choose a file, and says the last restore can be undone and until when', () => {
    const said = text(render({ at: 'choosing' }, {}, UNDO));

    expect(said).toContain('Restore from a backup');
    expect(said).toContain('choose the backup file');
    expect(said).toContain('Undo puts back what it changed, until');
    expect(render({ at: 'choosing' }, {}, UNDO)).toMatch(/<button[^>]*>Undo the restore<\/button>/);
  });

  it('lays the backup beside this install, group by group, saying what each thing is', () => {
    const html = render({ at: 'read', preview: PREVIEW, ...ARCHIVE });
    const said = text(html);

    for (const title of ['Install and GitHub App', 'Crew', 'Sign-ins']) expect(said).toContain(title);
    expect(said).toContain('Weekly engine updates new here');
    expect(said).toContain('The operator’s email different ops@b.example.test here, alex@example.test in the backup');
    expect(said).toContain('The organization same');
    expect(said).toContain('The public address only here');
  });

  it('ticks what is new, keeps this install’s where it differs, and asks which account a seat is — this install’s unless changed', () => {
    const html = render({ at: 'read', preview: PREVIEW, ...ARCHIVE });

    expect(control(html, 'Weekly engine updates: add it')).toContain('checked=""');
    expect(control(html, 'The operator’s email: take the backup’s')).not.toContain('checked=""');
    expect(html).toMatch(/<input type="radio"[^>]*name="seat:lead-reviewer:account"[^>]*checked=""[^>]*\/>this install’s — fleetadlc-other/);
    expect(html).toMatch(/<input type="radio"(?![^>]*checked)[^>]*name="seat:lead-reviewer:account"[^>]*\/>the backup’s — fleetadlc-sydney-janedoe/);
  });

  it('never lets an expired or refused sign-in be ticked, and says what taking a rotating one over means', () => {
    const html = render({ at: 'read', preview: PREVIEW, ...ARCHIVE });
    const said = text(html);

    expect(control(html, 'Claude Max: add it')).toContain('disabled=""');
    expect(said).toContain('Cannot be restored — Anthropic did not accept it: invalid x-api-key');
    expect(control(html, 'ChatGPT Pro: add it')).not.toContain('checked=""');
    expect(control(html, 'ChatGPT Pro: add it')).not.toContain('disabled=""');
    expect(said).toContain('Checking a subscription’s sign-in uses it — if it works, this install takes it over from wherever else it is in use.');
    // The reviewer's sign-in is for the backup's account: it goes with that choice.
    expect(control(html, 'Lead reviewer as fleetadlc-sydney-janedoe: take the backup’s')).toContain('disabled=""');
    expect(said).toContain('Goes with lead reviewer’s GitHub account, which is not taken.');
    const switched = render({ at: 'read', preview: PREVIEW, ...ARCHIVE }, { ...COMPARISON.choices, 'seat:lead-reviewer:account': true });
    expect(control(switched, 'Lead reviewer as fleetadlc-sydney-janedoe: take the backup’s')).not.toContain('disabled=""');
  });

  it('says what Restore will do first, and counts what is chosen', () => {
    const said = text(render({ at: 'read', preview: PREVIEW, ...ARCHIVE }));

    expect(said).toContain('Restore waits for the bots it changes to finish their work and pauses the dispatcher while it writes.');
    expect(said).toContain('This install is backed up first; Undo puts it back for 24 hours.');
    expect(said).toContain('anything that needs a person lands in Needs you');
    expect(takenCount(COMPARISON, COMPARISON.choices)).toBe(1);
    expect(render({ at: 'read', preview: PREVIEW, ...ARCHIVE })).toMatch(/<button[^>]*>Restore 1 thing<\/button>/);
    expect(render({ at: 'read', preview: PREVIEW, ...ARCHIVE }, {})).toMatch(/<button[^>]*>Restore 1 thing<\/button>/);
    expect(render({ at: 'read', preview: PREVIEW, ...ARCHIVE }, { 'setting:engineUpdates': false })).toMatch(
      /<button[^>]*disabled=""[^>]*>Nothing chosen to restore<\/button>/,
    );
  });
});

const JOB: RestoreJob = {
  id: 'job-1',
  kind: 'restore',
  state: 'waiting',
  startedAt: '2026-09-25T10:00:00.000Z',
  finishedAt: null,
  waitingFor: ['fleetadlc-other'],
  error: null,
  result: null,
};

const SUMMARY: RestoreSummary = {
  settings: ['engineUpdates'],
  app: [],
  repositories: ['janedoe/fleetadlc-testbed'],
  accounts: [],
  bots: [],
  signIns: [],
  history: null,
  skipped: [],
  next: ['Connect fleetadlc-sydney-janedoe to GitHub again: GitHub did not accept it: The refresh token passed is incorrect or expired.'],
};

describe('a restore into this install, running and done', () => {
  it('says whom it is waiting for, and that nothing has changed yet', () => {
    expect(text(render({ at: 'running', job: JOB, preview: null }))).toContain(
      'Waiting for fleetadlc-other to finish its work — nothing has been changed yet.',
    );
    expect(text(render({ at: 'running', job: { ...JOB, state: 'applying', waitingFor: [] }, preview: null }))).toContain(
      'this install has been backed up first',
    );
  });

  it('says what came back, what is left, and offers Undo', () => {
    const done: RestoreJob = {
      ...JOB,
      state: 'done',
      waitingFor: [],
      result: {
        summary: SUMMARY,
        signIns: [
          {
            key: 'bot:lead-reviewer',
            kind: 'github-refresh',
            provider: 'github',
            seat: 'lead-reviewer',
            accountId: null,
            who: 'fleetadlc-sydney-janedoe',
            rotates: true,
            replaces: true,
            verdict: { state: 'check-by-use' },
            chosen: true,
            state: 'refused',
            reason: 'GitHub did not accept it: The refresh token passed is incorrect or expired.',
          },
        ],
        undoUntil: UNDO.until,
      },
    };
    const said = text(render({ at: 'running', job: done, preview: null }, {}, UNDO));

    expect(said).toContain('Restored.');
    expect(said).toContain('The repository janedoe/fleetadlc-testbed');
    expect(said).toContain('Lead reviewer as fleetadlc-sydney-janedoe: not restored — GitHub did not accept it');
    expect(said).toContain('Still to do Connect fleetadlc-sydney-janedoe to GitHub again');
    expect(said).toContain('Anything else that needs a person is on the board, in Needs you.');
    expect(said).toContain('Undo the restore');
  });

  it('says why one did not finish', () => {
    const failed: RestoreJob = { ...JOB, state: 'failed', error: 'this install could not be backed up first (hostd did not answer), so nothing was changed' };

    expect(text(render({ at: 'running', job: failed, preview: null }))).toContain(
      'The restore did not finish: this install could not be backed up first (hostd did not answer), so nothing was changed',
    );
  });

  it('says what an undo put back, and what it kept', () => {
    const undone: RestoreJob = {
      ...JOB,
      kind: 'undo',
      state: 'done',
      result: {
        signIns: [
          { key: 'bot:lead-reviewer', who: 'fleetadlc-other', state: 'taken-over' },
          { key: 'account:k', who: 'Anthropic API', state: 'kept', reason: 'Anthropic did not accept it: invalid x-api-key' },
        ],
        keptAccounts: [{ id: 'x', usedBy: ['builder'] }],
        keptSeats: [{ seat: 'lead-reviewer', login: 'fleetadlc-sydney-janedoe', reason: 'GitHub did not accept it: The refresh token passed is incorrect or expired.' }],
      },
    };
    const said = text(render({ at: 'running', job: undone, preview: null }));
    expect(said).toContain(
      'Lead reviewer stays fleetadlc-sydney-janedoe: the sign-in it had before was not accepted (GitHub did not accept it: The refresh token passed is incorrect or expired), and the one it has works',
    );

    expect(said).toContain('Undone: what the restore changed is as it was before.');
    expect(said).toContain('fleetadlc-other: taken back by using it');
    expect(said).toContain('Anthropic API: this install’s is kept — the one it had before was not accepted: Anthropic did not accept it: invalid x-api-key');
    expect(said).toContain('still used by builder, so it stays');
  });
});

function outside(running: boolean, open: boolean, undo: UndoView | null = null): string {
  return renderToStaticMarkup(
    <RestoreOutsideModal running={running} open={open} undo={undo} onShow={() => undefined} onUndo={() => undefined} />,
  ).replace(/<!-- -->/g, '');
}

describe('Restore on the section, and in its modal', () => {
  it('opens onto the restore form: the file, and once read, the comparison and the choice', () => {
    const choosing = text(
      renderToStaticMarkup(
        <Dialog>
          <RestoreDialogBody>
            <RestoreIntoPanel
              phase={{ at: 'choosing' }}
              fileName={null}
              sealed
              passphrase=""
              choices={{}}
              undo={null}
              error={null}
              onPick={() => undefined}
              onPassphrase={() => undefined}
              onRead={() => undefined}
              onChoice={() => undefined}
              onRestore={() => undefined}
              onUndo={() => undefined}
            />
          </RestoreDialogBody>
        </Dialog>,
      ),
    );
    expect(choosing).toContain('Restore');
    expect(choosing).toContain('Put a backup back into this install.');
    expect(choosing).toContain('Restore from a backup');
    expect(choosing).toContain('choose the backup file');

    const read = text(
      renderToStaticMarkup(
        <Dialog>
          <RestoreDialogBody>
            <RestoreIntoPanel
              phase={{ at: 'read', preview: PREVIEW, ...ARCHIVE }}
              fileName="fleetadlc-backup-2026-09-24.fleetbak"
              sealed
              passphrase=""
              choices={COMPARISON.choices}
              undo={UNDO}
              error={null}
              onPick={() => undefined}
              onPassphrase={() => undefined}
              onRead={() => undefined}
              onChoice={() => undefined}
              onRestore={() => undefined}
              onUndo={() => undefined}
            />
          </RestoreDialogBody>
        </Dialog>,
      ),
    );
    expect(read).toContain('Weekly engine updates');
    expect(read).toContain('Restore 1 thing');
    expect(read).toContain('Undo the restore');
  });

  it('says a restore is running on the section, with Show, once the modal is closed', () => {
    const closed = outside(true, false);
    expect(text(closed)).toContain('A restore is running…');
    expect(closed).toMatch(/<button[^>]*>Show<\/button>/);
    // Open, the modal itself is where the job is, so the section does not repeat it.
    expect(outside(true, true)).not.toContain('A restore is running');
  });

  it('says how a job ended while the modal was closed, with Show, and not while it is open', () => {
    const undone: RestoreJob = { ...JOB, kind: 'undo', state: 'done', waitingFor: [], result: null };
    const draw = (open: boolean) =>
      renderToStaticMarkup(
        <RestoreOutsideModal running={false} outcome={undone} open={open} undo={null} onShow={() => undefined} onUndo={() => undefined} />,
      ).replace(/<!-- -->/g, '');
    expect(text(draw(false))).toContain('Undone: what the restore changed is as it was before.');
    expect(draw(false)).toMatch(/<button[^>]*>Show<\/button>/);
    expect(draw(true)).not.toContain('Undone');
  });

  it('says an undo is running, rather than a restore, while that job is the one', () => {
    const html = renderToStaticMarkup(
      <RestoreOutsideModal
        running
        runningKind="undo"
        open={false}
        undo={null}
        onShow={() => undefined}
        onUndo={() => undefined}
      />,
    );
    expect(text(html)).toContain('An undo is running…');
    expect(html).not.toContain('A restore is running');
  });

  it('shows a failed Undo beside the section button, which can be pressed again', () => {
    const html = renderToStaticMarkup(
      <RestoreOutsideModal
        running={false}
        open={false}
        undo={UNDO}
        error="the undo window has passed"
        busy={false}
        onShow={() => undefined}
        onUndo={() => undefined}
      />,
    );
    expect(text(html)).toContain('the undo window has passed');
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>Undo the last restore<\/button>/);
  });

  it('disables the section’s Undo while that request is in flight', () => {
    const html = renderToStaticMarkup(
      <RestoreOutsideModal running={false} open={false} undo={UNDO} busy onShow={() => undefined} onUndo={() => undefined} />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Undoing…<\/button>/);
  });

  it('keeps Undo the last restore on the section when one can be undone', () => {
    const html = outside(false, false, UNDO);
    expect(text(html)).toContain('Undo puts back what it changed, until');
    expect(html).toMatch(/<button[^>]*>Undo the last restore<\/button>/);
    // And not instead of the one in the form.
    expect(render({ at: 'choosing' }, {}, UNDO)).toMatch(/<button[^>]*>Undo the restore<\/button>/);
  });

  it('offers Undo after a restore or an undo that failed, while the bridge still has one', () => {
    // A restore that failed after its first rows were written leaves a
    // journal, and so does a failed undo: the install is half put back, and
    // Undo is what it needs.
    const failed: RestoreJob = { ...JOB, state: 'failed', error: 'the secret store did not answer' };
    for (const job of [failed, { ...failed, kind: 'undo' as const }]) {
      expect(undoOnOffer({ at: 'running', job, preview: null }, UNDO)).toBe(UNDO);
      expect(render({ at: 'running', job, preview: null }, {}, UNDO)).toMatch(/<button[^>]*>Undo the restore<\/button>/);
    }
    expect(undoOnOffer({ at: 'running', job: { ...JOB, state: 'applying' }, preview: null }, UNDO)).toBeNull();
    expect(undoOnOffer({ at: 'running', job: failed, preview: null }, null)).toBeNull();
  });

  it('keeps Undo and Restore off while an undo or a restore is being started', () => {
    // A double-click sent two undos: the second re-applied the snapshot with
    // refresh tokens the first had spent.
    const failed: RestoreJob = { ...JOB, state: 'failed', error: 'the secret store did not answer' };
    expect(render({ at: 'choosing' }, {}, UNDO, { undoing: true })).toMatch(/<button[^>]*disabled=""[^>]*>Undo the restore<\/button>/);
    expect(render({ at: 'running', job: failed, preview: null }, {}, UNDO, { undoing: true })).toMatch(
      /<button[^>]*disabled=""[^>]*>Undo the restore<\/button>/,
    );
    const starting = render({ at: 'read', preview: PREVIEW, ...ARCHIVE }, COMPARISON.choices, UNDO, { starting: true });
    expect(starting).toMatch(/<button[^>]*disabled=""[^>]*>Restore 1 thing<\/button>/);
    expect(starting).toMatch(/<button[^>]*disabled=""[^>]*>Undo the restore<\/button>/);
  });

  it('does not offer that undo while the restore is still running', () => {
    const html = outside(true, false, UNDO);
    expect(html).not.toContain('Undo the last restore');
    expect(html).toContain('Show');
  });

  it('can show where a running restore has got to, which is what Show opens on', () => {
    const html = renderToStaticMarkup(
      <>
        <RestoreOutsideModal running open={false} undo={null} onShow={() => undefined} onUndo={() => undefined} />
        <Dialog>
          <RestoreDialogBody>
            <RestoreIntoPanel
              phase={{ at: 'running', job: JOB, preview: null }}
              fileName={null}
              sealed
              passphrase=""
              choices={{}}
              undo={null}
              error={null}
              onPick={() => undefined}
              onPassphrase={() => undefined}
              onRead={() => undefined}
              onChoice={() => undefined}
              onRestore={() => undefined}
              onUndo={() => undefined}
            />
          </RestoreDialogBody>
        </Dialog>
      </>,
    );
    const said = text(html);
    expect(said).toContain('A restore is running…');
    expect(said).toContain('Waiting for fleetadlc-other to finish its work — nothing has been changed yet.');
  });
});
