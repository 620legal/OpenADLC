import type { HealthRow } from '@fleetadlc/db';
import { describe, expect, it } from 'vitest';
import { unconfirmedOf, forgotten, nextRow, notificationsDue, showsNotice, stepVerdicts } from './state.js';
import type { CheckResult } from './types.js';

/**
 * How a check's answers become what the board, the notifications and the
 * walkthrough say: a failure that is new, one that is still there, one just
 * fixed — and no answer, which changes nothing.
 */

const NOW = new Date('2026-09-25T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const later = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

const FAILING: CheckResult = {
  ok: false,
  severity: 'blocking',
  title: 'The OpenADLC app does not have “SSH signing keys”',
  detail: 'Add it on the app’s permissions page.',
  action: { label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions' },
};

function row(partial: Partial<HealthRow> & Pick<HealthRow, 'id' | 'state'>): HealthRow {
  return {
    checkId: partial.id.split(':')[0]!,
    subject: null,
    severity: partial.state === 'failing' ? 'blocking' : null,
    title: partial.state === 'failing' ? 'Something is wrong' : null,
    detail: null,
    action: null,
    facts: {},
    waitingFor: [],
    failingSince: partial.state === 'failing' ? minutesAgo(10) : null,
    checkedAt: minutesAgo(1),
    notifiedAt: null,
    fixedAt: null,
    fixedTitle: null,
    fixedDismissedAt: null,
    ...partial,
  };
}

describe('a check’s answer, against what it said before', () => {
  it('is new the first time it fails, and starts the clock on how long a person has been waited on', () => {
    const next = nextRow(null, 'app-permissions', { ...FAILING, subject: 'git_signing_ssh_public_keys' }, NOW);

    expect(next.transition).toBe('new');
    expect(next.write).toBe(true);
    expect(next.row).toMatchObject({
      id: 'app-permissions:git_signing_ssh_public_keys',
      state: 'failing',
      severity: 'blocking',
      title: 'The OpenADLC app does not have “SSH signing keys”',
      failingSince: NOW.toISOString(),
      notifiedAt: null,
    });
  });

  it('is still failing the next time, keeping when it started and whether anybody was told', () => {
    const before = row({ id: 'webhook', state: 'failing', failingSince: minutesAgo(40), notifiedAt: minutesAgo(30) });
    const next = nextRow(before, 'webhook', { ...FAILING, title: 'GitHub is not sending events to OpenADLC' }, NOW);

    expect(next.transition).toBe('still');
    expect(next.row.failingSince).toBe(minutesAgo(40));
    expect(next.row.notifiedAt).toBe(minutesAgo(30));
    // What it says is the newest answer's.
    expect(next.row.title).toBe('GitHub is not sending events to OpenADLC');
  });

  it('is fixed when a failing check passes, and says so in its own words', () => {
    const before = row({ id: 'webhook', state: 'failing', notifiedAt: minutesAgo(5) });
    const next = nextRow(before, 'webhook', { ok: true, fixed: 'GitHub is delivering again' }, NOW);

    expect(next.transition).toBe('fixed');
    expect(next.row).toMatchObject({
      state: 'ok',
      failingSince: null,
      notifiedAt: null,
      fixedAt: NOW.toISOString(),
      fixedTitle: 'GitHub is delivering again',
      fixedDismissedAt: null,
    });
  });

  it('keeps saying it was fixed across later passes, until it is dismissed or old', () => {
    const fixed = row({ id: 'webhook', state: 'ok', fixedAt: minutesAgo(20), fixedTitle: 'GitHub is delivering again' });
    const next = nextRow(fixed, 'webhook', { ok: true, fixed: 'GitHub is delivering again' }, NOW);

    expect(next.transition).toBe('passing');
    expect(next.row.fixedTitle).toBe('GitHub is delivering again');
    expect(showsNotice(next.row, NOW)).toBe(true);
    expect(showsNotice({ ...next.row, fixedDismissedAt: NOW.toISOString() }, NOW)).toBe(false);
    expect(showsNotice(next.row, later(24 * 60))).toBe(false);
  });

  it('says once what OpenADLC did on its own, without anything having failed', () => {
    const next = nextRow(null, 'idle-lease', { ok: true, subject: 'lease-1', note: 'Released #12, which nothing was working on' }, NOW);

    expect(next.transition).toBe('passing');
    expect(next.row.fixedTitle).toBe('Released #12, which nothing was working on');
    expect(showsNotice(next.row, NOW)).toBe(true);
  });

  it('neither clears nor raises a card when there is no answer about something already known', () => {
    const passing = row({ id: 'webhook', state: 'ok' });
    const quiet = nextRow(passing, 'webhook', { ok: null, reason: 'GitHub could not be asked' }, NOW);
    expect(quiet).toEqual({ row: passing, transition: 'unknown', write: false });

    const failing = row({ id: 'webhook', state: 'failing', checkedAt: minutesAgo(30) });
    const next = nextRow(failing, 'webhook', { ok: null, reason: 'GitHub could not be asked' }, NOW);
    expect(next.transition).toBe('unknown');
    expect(next.row.state).toBe('failing');
    // The last real answer stays when it was given.
    expect(next.row.checkedAt).toBe(failing.checkedAt);
  });

  it('says on a failing card that it could not be confirmed, once, until a real answer replaces it', () => {
    // A CODEOWNERS already fixed kept its card: every run after asked GitHub
    // something it would not answer, and the card did not say so.
    const failing = row({ id: 'repo-config:acme/api', state: 'failing' });
    const first = nextRow(failing, 'repo-config', { subject: 'acme/api', ok: null, reason: 'GitHub did not say whether janedoe can review' }, NOW);
    expect(first.write).toBe(true);
    expect(unconfirmedOf(first.row)).toEqual({ since: NOW.toISOString(), reason: 'GitHub did not say whether janedoe can review' });

    const again = nextRow(first.row, 'repo-config', { subject: 'acme/api', ok: null, reason: 'GitHub did not say whether janedoe can review' }, later(30));
    expect(again.write).toBe(false);

    const answered = nextRow(first.row, 'repo-config', { ...FAILING, subject: 'acme/api' }, later(60));
    expect(unconfirmedOf(answered.row)).toBeNull();
  });

  it('remembers why there is no answer when there is nothing else to remember', () => {
    const next = nextRow(null, 'webhook', { ok: null, reason: 'nothing has happened on GitHub yet' }, NOW);

    expect(next.write).toBe(true);
    expect(next.row).toMatchObject({ state: 'unknown', detail: 'nothing has happened on GitHub yet' });
  });

  it('forgets a subject that is gone, but not while it still has something to say', () => {
    const gone = row({ id: 'signing-key:bot-removed', state: 'failing' });
    const saying = row({ id: 'idle-lease:lease-1', state: 'ok', fixedAt: minutesAgo(5), fixedTitle: 'Released #12' });
    const kept = row({ id: 'signing-key:bot-builder', state: 'ok' });

    expect(forgotten([gone, saying, kept], new Set(['signing-key:bot-builder']), NOW)).toEqual(['signing-key:bot-removed']);
  });
});

describe('who is interrupted, and when', () => {
  it('is nobody for the first five minutes of a failure', () => {
    expect(notificationsDue([row({ id: 'webhook', state: 'failing', failingSince: minutesAgo(4) })], NOW)).toEqual([]);
    expect(notificationsDue([row({ id: 'webhook', state: 'failing', failingSince: minutesAgo(6) })], NOW)).toHaveLength(1);
  });

  it('is once, and again only a day later if it is still failing', () => {
    const told = row({ id: 'webhook', state: 'failing', failingSince: minutesAgo(60 * 30), notifiedAt: minutesAgo(60 * 23) });
    expect(notificationsDue([told], NOW)).toEqual([]);
    expect(notificationsDue([told], later(61))).toHaveLength(1);
  });

  it('is never for a warning, and not for a failure waiting on another’s fix', () => {
    const warning = row({ id: 'token-expiry', state: 'failing', severity: 'warning', failingSince: minutesAgo(60) });
    const permission = row({ id: 'app-permissions:git_signing_ssh_public_keys', state: 'failing', failingSince: minutesAgo(60) });
    const key = row({
      id: 'signing-key:bot-builder',
      state: 'failing',
      failingSince: minutesAgo(60),
      waitingFor: ['app-permissions:git_signing_ssh_public_keys'],
    });

    expect(notificationsDue([warning, permission, key], NOW).map((one) => one.id)).toEqual([
      'app-permissions:git_signing_ssh_public_keys',
    ]);
  });
});

describe('what a walkthrough step is, by its checks', () => {
  const CHECKS = [
    { id: 'app-permissions', steps: ['app'] as const },
    { id: 'token-expiry', steps: ['app'] as const },
    { id: 'webhook', steps: ['webhook'] as const },
  ];

  it('is not done while a blocking check on it fails, and says what fails', () => {
    const verdicts = stepVerdicts(
      [row({ id: 'app-permissions:contents', state: 'ok' }), row({ id: 'app-permissions:git_signing_ssh_public_keys', state: 'failing' })],
      CHECKS,
      ['app', 'webhook'],
    );
    expect(verdicts.app.done).toBe(false);
    expect(verdicts.app.failing.map((one) => one.id)).toEqual(['app-permissions:git_signing_ssh_public_keys']);
  });

  it('yields a crew verdict from a seat that cannot sign in', () => {
    const verdicts = stepVerdicts(
      [row({ id: 'bot-sign-in:builder', state: 'failing', title: 'the builder has no GitHub account connected' })],
      [{ id: 'bot-sign-in', steps: ['crew'] }],
      ['app', 'crew'],
    );
    expect(verdicts.crew.done).toBe(false);
    expect(verdicts.crew.failing.map((one) => one.id)).toEqual(['bot-sign-in:builder']);
    expect(verdicts.app).toEqual({ done: null, failing: [] });
  });

  it('is done when its checks pass, a warning notwithstanding, and unknown when none has an answer', () => {
    const verdicts = stepVerdicts(
      [row({ id: 'app-permissions:contents', state: 'ok' }), row({ id: 'token-expiry', state: 'failing', severity: 'warning' })],
      CHECKS,
      ['app', 'webhook'],
    );
    expect(verdicts.app.done).toBe(true);
    expect(verdicts.app.failing.map((one) => one.id)).toEqual(['token-expiry']);
    expect(verdicts.webhook).toEqual({ done: null, failing: [] });
  });
});
