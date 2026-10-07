import type { HealthRow } from '@fleetadlc/db';
import { MANUAL_STEPS } from '@fleetadlc/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultChecks } from './index.js';
import { HealthRegistry, type HealthNotice, type HealthStore } from './registry.js';
import type { CheckResult, HealthCheck } from './types.js';

/**
 * The registry: runs the checks, remembers what each said, and says what
 * changed — a card while one fails, a notification when a blocking one lasts,
 * and once when it is fixed.
 */

const START = new Date('2026-09-25T12:00:00.000Z');

function memory(): { rows: Map<string, HealthRow>; store: HealthStore } {
  const rows = new Map<string, HealthRow>();
  return {
    rows,
    store: {
      list: async () => [...rows.values()],
      save: async (row) => {
        rows.set(row.id, row);
      },
      remove: async (ids) => {
        for (const id of ids) rows.delete(id);
      },
      dismiss: async (id) => {
        const row = rows.get(id);
        if (!row?.fixedAt || row.fixedDismissedAt) return false;
        rows.set(id, { ...row, fixedDismissedAt: new Date().toISOString() });
        return true;
      },
    },
  };
}

/** A check whose answer the test sets. */
function scripted(id: string, everyMinutes = 5): HealthCheck & { answer: CheckResult[] | Error; runs: number } {
  const check = {
    id,
    proves: `${id} works`,
    how: 'by asking',
    everyMinutes,
    steps: [] as const,
    answer: [{ ok: true }] as CheckResult[] | Error,
    runs: 0,
    async run() {
      check.runs += 1;
      if (check.answer instanceof Error) throw check.answer;
      return check.answer;
    },
  };
  return check;
}

const WEBHOOK_SILENT: CheckResult = {
  ok: false,
  severity: 'blocking',
  title: 'GitHub is not sending events to OpenADLC',
  detail: 'Open the app’s settings and turn on **Active** under Webhook.',
  action: { label: 'Open the app’s settings', url: 'https://github.com/settings/apps/fleetadlc-janedoe' },
};

function registry(checks: HealthCheck[], extra: { settingUp?: boolean; onFixed?: (ids: readonly string[]) => Promise<unknown>; log?: (line: string) => void } = {}) {
  const { rows, store } = memory();
  const sent: HealthNotice[] = [];
  let now = START;
  const subject = new HealthRegistry({
    checks,
    store,
    notify: async (notice) => {
      sent.push(notice);
    },
    settingUp: async () => extra.settingUp ?? false,
    consoleUrl: 'http://127.0.0.1:47300',
    botNames: async () => new Map([['bot-builder', 'fleetadlc-atlas-janedoe']]),
    now: () => now,
    log: extra.log ?? (() => undefined),
    onFixed: extra.onFixed,
  });
  return {
    subject,
    rows,
    sent,
    advance(minutes: number) {
      now = new Date(now.getTime() + minutes * 60_000);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('what a check said, remembered', () => {
  it('knows a failure is new, then still there, then fixed — and keeps when it started', async () => {
    const webhook = scripted('webhook');
    const { subject, rows, advance } = registry([webhook]);

    webhook.answer = [WEBHOOK_SILENT];
    await subject.run({ force: true });
    expect(rows.get('webhook')).toMatchObject({ state: 'failing', failingSince: START.toISOString() });

    advance(5);
    await subject.run({ force: true });
    expect(rows.get('webhook')).toMatchObject({ state: 'failing', failingSince: START.toISOString() });

    advance(5);
    webhook.answer = [{ ok: true, fixed: 'GitHub is delivering again' }];
    await subject.run({ force: true });
    expect(rows.get('webhook')).toMatchObject({ state: 'ok', failingSince: null, fixedTitle: 'GitHub is delivering again' });
  });

  it('changes nothing when a check cannot run', async () => {
    const webhook = scripted('webhook');
    const { subject, rows } = registry([webhook]);
    webhook.answer = [WEBHOOK_SILENT];
    await subject.run({ force: true });

    webhook.answer = new Error('GitHub did not answer');
    await subject.run({ force: true });

    expect(rows.get('webhook')?.state).toBe('failing');
  });

  it('forgets the rows of a subject a check no longer mentions', async () => {
    const keys = scripted('signing-key');
    const { subject, rows } = registry([keys]);
    keys.answer = [
      { subject: 'bot-builder', ok: true },
      { subject: 'bot-gone', ...WEBHOOK_SILENT },
    ];
    await subject.run({ force: true });
    expect([...rows.keys()].sort()).toEqual(['signing-key:bot-builder', 'signing-key:bot-gone']);

    keys.answer = [{ subject: 'bot-builder', ok: true }];
    await subject.run({ force: true });
    expect([...rows.keys()]).toEqual(['signing-key:bot-builder']);
  });

  it('runs each check at start, and after that only when its own interval has passed', async () => {
    const often = scripted('hostd', 2);
    const rarely = scripted('device-flow', 60);
    const { subject, advance } = registry([often, rarely]);

    await subject.run();
    advance(3);
    await subject.run();
    expect([often.runs, rarely.runs]).toEqual([2, 1]);

    advance(60);
    await subject.run();
    expect([often.runs, rarely.runs]).toEqual([3, 2]);
  });

  it('asks a check again soon after something it is about happened, several asks being one run', async () => {
    vi.useFakeTimers();
    const signIn = scripted('bot-sign-in');
    const { subject } = registry([signIn]);

    subject.runSoon(['bot-sign-in']);
    subject.runSoon(['bot-sign-in', 'no-such-check']);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(signIn.runs).toBe(1);
  });

  it('asks the webhook again on a delivery only while it is failing', async () => {
    vi.useFakeTimers();
    const webhook = scripted('webhook');
    const { subject } = registry([webhook]);

    await subject.run({ force: true });
    subject.heard();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(webhook.runs).toBe(1);

    webhook.answer = [WEBHOOK_SILENT];
    await subject.run({ force: true });
    subject.heard();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(webhook.runs).toBe(3);
  });

  it('names the bot a row is about as it is called now, and what it is waiting for', async () => {
    const permissions = scripted('app-permissions');
    const keys = scripted('signing-key');
    const { subject } = registry([permissions, keys]);
    permissions.answer = [{ subject: 'git_signing_ssh_public_keys', ...WEBHOOK_SILENT, title: 'The OpenADLC app does not have “SSH signing keys”' }];
    keys.answer = [
      {
        subject: 'bot-builder',
        ...WEBHOOK_SILENT,
        title: 'fleetadlc-atlas-janedoe’s signing key is not on its GitHub account',
        waitingFor: ['app-permissions:git_signing_ssh_public_keys'],
        facts: { botId: 'bot-builder' },
      },
    ];

    const views = await subject.views(await subject.run({ force: true }));
    expect(views.find((view) => view.id === 'signing-key:bot-builder')).toMatchObject({
      bot: 'fleetadlc-atlas-janedoe',
      state: 'failing',
      proves: 'signing-key works',
      waitingFor: ['app-permissions:git_signing_ssh_public_keys'],
    });
  });
});

describe('a blocking failure that lasts', () => {
  it('is sent once after five minutes, again a day later, and its fix is sent to whoever was told', async () => {
    const webhook = scripted('webhook');
    const { subject, rows, sent, advance } = registry([webhook]);
    webhook.answer = [WEBHOOK_SILENT];

    await subject.run({ force: true });
    expect(sent).toEqual([]);

    advance(6);
    await subject.run({ force: true });
    expect(sent).toEqual([
      {
        event: 'check_failing',
        text: 'GitHub is not sending events to OpenADLC — Open the app’s settings and turn on **Active** under Webhook.',
        link: 'https://github.com/settings/apps/fleetadlc-janedoe',
      },
    ]);
    expect(rows.get('webhook')?.notifiedAt).toBe(new Date(START.getTime() + 6 * 60_000).toISOString());

    advance(60);
    await subject.run({ force: true });
    expect(sent).toHaveLength(1);

    advance(24 * 60);
    await subject.run({ force: true });
    expect(sent.map((notice) => notice.event)).toEqual(['check_failing', 'check_failing']);

    webhook.answer = [{ ok: true, fixed: 'GitHub is delivering again' }];
    advance(5);
    await subject.run({ force: true });
    expect(sent.at(-1)).toEqual({ event: 'check_fixed', text: 'GitHub is delivering again', link: 'http://127.0.0.1:47300/?board=1#needs' });
  });

  it('sends nobody an all-clear for something they were never told about', async () => {
    const webhook = scripted('webhook');
    const { subject, sent, advance } = registry([webhook]);
    webhook.answer = [WEBHOOK_SILENT];
    await subject.run({ force: true });
    advance(2);
    webhook.answer = [{ ok: true }];
    await subject.run({ force: true });
    expect(sent).toEqual([]);
  });

  it('is sent nowhere while the install is still being set up, when the walkthrough is where the person is', async () => {
    const webhook = scripted('webhook');
    const { subject, sent, advance } = registry([webhook], { settingUp: true });
    webhook.answer = [WEBHOOK_SILENT];
    await subject.run({ force: true });
    advance(30);
    await subject.run({ force: true });
    expect(sent).toEqual([]);
  });

  it('links a console page by its address on this install', async () => {
    const hostd = scripted('bot-sign-in');
    const { subject, sent, advance } = registry([hostd]);
    hostd.answer = [{ ...WEBHOOK_SILENT, title: 'fleetadlc-atlas-janedoe cannot sign in to GitHub', action: { label: 'Reconnect fleetadlc-atlas-janedoe', href: '/settings#github-accounts' } }];
    await subject.run({ force: true });
    advance(6);
    await subject.run({ force: true });
    expect(sent[0]?.link).toBe('http://127.0.0.1:47300/settings#github-accounts');
  });
});

describe('what waits on a check that is fixed', () => {
  it('is told the row once, in the run that saw it pass, and never again while it stays green', async () => {
    const signIn = scripted('bot-sign-in');
    const onFixed = vi.fn(async () => undefined);
    const { subject, rows } = registry([signIn], { onFixed });
    signIn.answer = [{ ...WEBHOOK_SILENT, subject: 'bot-builder' }];

    await subject.run({ force: true });
    await subject.run({ force: true });
    expect(onFixed).not.toHaveBeenCalled();

    signIn.answer = [{ ok: true, subject: 'bot-builder', fixed: 'fleetadlc-atlas-janedoe can sign in again' }];
    await subject.run({ force: true });
    expect(onFixed).toHaveBeenCalledTimes(1);
    expect(onFixed).toHaveBeenCalledWith(['bot-sign-in:bot-builder']);
    expect(rows.get('bot-sign-in:bot-builder')).toMatchObject({ state: 'ok' });

    await subject.run({ force: true });
    await subject.run({ force: true });
    expect(onFixed).toHaveBeenCalledTimes(1);
  });

  it('is not told of a check that was never failing', async () => {
    const webhook = scripted('webhook');
    const onFixed = vi.fn(async () => undefined);
    const { subject } = registry([webhook], { onFixed });

    await subject.run({ force: true });
    await subject.run({ force: true });

    expect(onFixed).not.toHaveBeenCalled();
  });

  it('cannot break the run that found the fix: the row is saved, the failure is logged', async () => {
    const webhook = scripted('webhook');
    const log = vi.fn();
    const onFixed = vi.fn(async () => {
      throw new Error('database is restarting');
    });
    const { subject, rows } = registry([webhook], { onFixed, log });
    webhook.answer = [WEBHOOK_SILENT];
    await subject.run({ force: true });

    webhook.answer = [{ ok: true, fixed: 'GitHub is delivering again' }];
    await expect(subject.run({ force: true })).resolves.toBeDefined();

    expect(rows.get('webhook')).toMatchObject({ state: 'ok' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not act on webhook passing: database is restarting'));
  });
});

/**
 * The rule in AGENTS.md: a step OpenADLC cannot do for itself comes with a check
 * that proves it was done. A walkthrough step a person does is listed in
 * `MANUAL_STEPS`; one that no registered check answers is a step the system
 * would never tell anybody had come undone.
 */
describe('every step a person does has a check', () => {
  it('is answered by a check the bridge registers', () => {
    const checks = defaultChecks({
      config: { automationBot: null } as never,
      actors: {} as never,
      hostd: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
    });
    const claimed = new Set(checks.flatMap((check) => check.steps));
    const unanswered = Object.keys(MANUAL_STEPS).filter((step) => !claimed.has(step as never));

    expect(unanswered).toEqual([]);
  });

  it('names each check once, and says what it proves and how', () => {
    const checks = defaultChecks({
      config: { automationBot: null } as never,
      actors: {} as never,
      hostd: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
    });
    const ids = checks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const check of checks) {
      expect(check.proves.length).toBeGreaterThan(10);
      expect(check.how.length).toBeGreaterThan(10);
      expect(check.everyMinutes).toBeGreaterThan(0);
    }
  });

  it('includes the warning while hostd runs tasks on this machine under the local driver', () => {
    const checks = defaultChecks({
      config: { automationBot: null } as never,
      actors: {} as never,
      hostd: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
    });
    expect(checks.map((check) => check.id)).toContain('hostd-driver');
  });

  it('includes the check that GitHub keeps each crew account’s email private on the commits it writes', () => {
    const checks = defaultChecks({
      config: { automationBot: null } as never,
      actors: {} as never,
      hostd: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
    });
    expect(checks.find((check) => check.id === 'commit-email')?.steps).toEqual(['github-accounts']);
  });
});

describe('a check about history', () => {
  it('marks its failing rows as history, which is what gives their cards Dismiss and not Check again', async () => {
    const unsigned = Object.assign(scripted('unattributed-post'), { history: true });
    unsigned.answer = [{ ok: false, severity: 'warning', title: 'A post is not signed by OpenADLC', detail: 'It counted.', action: { label: 'Open the post', url: 'https://github.com/x' }, facts: { occurrence: 'post:1' } }];
    const plain = scripted('webhook');
    plain.answer = [{ ok: false, severity: 'blocking', title: 'GitHub is not delivering', detail: 'Fix it.', action: { label: 'Open', href: '/settings' } }];
    const { subject, rows } = registry([unsigned, plain]);
    await subject.run({ force: true });
    expect(rows.get('unattributed-post')?.facts).toEqual({ occurrence: 'post:1', history: true });
    expect(rows.get('webhook')?.facts.history).toBeUndefined();
  });
});

describe('a check’s time limit', () => {
  it('is its own when it declares one, and the registry’s otherwise', async () => {
    const slowly = (id: string, timeoutMs?: number): HealthCheck => ({
      ...scripted(id),
      timeoutMs,
      run: () => new Promise<CheckResult[]>((resolve) => setTimeout(() => resolve([{ ok: false, severity: 'warning', title: `${id} fails`, detail: 'Fix it.', action: { label: 'Open', href: '/settings' } }]), 50)),
    });
    const { store, rows } = memory();
    const said: string[] = [];
    const subject = new HealthRegistry({
      checks: [slowly('per-repository', 1_000), slowly('one-call')],
      store,
      consoleUrl: 'http://127.0.0.1:47300',
      timeoutMs: 20,
      log: (line) => said.push(line),
    });
    await subject.run({ force: true });
    expect(rows.get('per-repository')?.state).toBe('failing');
    expect(rows.has('one-call')).toBe(false);
    expect(said.some((line) => line.startsWith('one-call could not run: no answer within its time limit'))).toBe(true);
  });
});

describe('dismissing a fixed notice', () => {
  it('holds when it is pressed while a run is going', async () => {
    const webhook = scripted('webhook');
    const { subject, rows } = registry([webhook]);
    webhook.answer = [WEBHOOK_SILENT];
    await subject.run({ force: true });
    webhook.answer = [{ ok: true, fixed: 'GitHub is delivering again' }];
    await subject.run({ force: true });
    expect(rows.get('webhook')?.fixedAt).toBeTruthy();

    // A run that reads every row, then takes a moment to answer.
    let answer!: () => void;
    webhook.run = () => new Promise<CheckResult[]>((resolve) => (answer = () => resolve([{ ok: true }])));
    const running = subject.run({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dismissed = subject.dismiss('webhook');
    answer();
    await running;
    expect(await dismissed).toBe(true);
    expect(rows.get('webhook')?.fixedDismissedAt).toBeTruthy();
  });
});

describe('the rows of a check no longer registered', () => {
  it('are never drawn or notified, and are removed when every check runs', async () => {
    const webhook = scripted('webhook');
    const { subject, rows, sent, advance } = registry([webhook]);
    // Left by a check an upgrade renamed: failing, blocking, and old enough to notify.
    rows.set('old-check', {
      ...(await (async () => {
        webhook.answer = [WEBHOOK_SILENT];
        await subject.run({ force: true });
        return rows.get('webhook')!;
      })()),
      id: 'old-check',
      checkId: 'old-check',
    });
    webhook.answer = [{ ok: true }];
    advance(10);

    await subject.run({ ids: ['webhook'] });
    expect(sent).toEqual([]);
    expect((await subject.views()).map((view) => view.id)).toEqual(['webhook']);
    expect((await subject.rows()).map((row) => row.id)).toEqual(['webhook']);
    expect(rows.has('old-check')).toBe(true);

    await subject.run({ force: true });
    expect(rows.has('old-check')).toBe(false);
  });
});
