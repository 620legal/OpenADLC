import { describe, expect, it } from 'vitest';
import { accessLine, type BotAccess, type RepoAccess } from './crew-access';

const bot = (name: string, state: BotAccess['state'], detail = ''): BotAccess => ({ bot: name, login: name, state, changed: false, detail });
const access = (partial: Partial<RepoAccess>): RepoAccess => ({
  repository: 'acme/api',
  running: false,
  trigger: 'reconcile',
  checkedAt: '2026-09-25T09:00:00.000Z',
  error: null,
  bots: [],
  ...partial,
});
const NINE = Array.from({ length: 9 }, (_, index) => bot(`bot-${index}`, 'in'));

describe('whether the crew can work in a repository', () => {
  it('says how many of the crew can, when all of them can', () => {
    expect(accessLine(access({ bots: NINE }))).toEqual({ tone: 'signal', text: '9 of 9 bots can work here', reason: null, action: null, busy: false });
  });

  it('says it is letting them in while a run somebody started is going', () => {
    expect(accessLine(access({ running: true, trigger: 'added', checkedAt: null }))).toMatchObject({ text: 'Inviting the crew…', busy: true, action: null });
    expect(accessLine(access({ running: true, trigger: 'retry', bots: NINE }))).toMatchObject({ text: 'Inviting the crew…' });
  });

  it('keeps saying what it found while the clock checks again, rather than flickering', () => {
    expect(accessLine(access({ running: true, trigger: 'reconcile', bots: NINE }))).toMatchObject({ text: '9 of 9 bots can work here' });
  });

  it('names the first bot that cannot, why, and how many more, with a way to try again', () => {
    const line = accessLine(
      access({
        bots: [
          ...NINE.slice(0, 6),
          bot('irisexampleco', 'refused', 'the OpenADLC app needs `Administration: read and write` to invite anybody'),
          bot('noraexampleco', 'invited'),
          bot('qa', 'no-account'),
        ],
      }),
      (name) => (name === 'qa' ? 'the QA bot' : name),
    );
    expect(line).toEqual({
      tone: 'attention',
      text: '6 of 9 bots can work here',
      reason: 'irisexampleco: the OpenADLC app needs `Administration: read and write` to invite anybody, and 2 more',
      action: 'Try again',
      busy: false,
    });
    expect(accessLine(access({ bots: [...NINE.slice(0, 8), bot('noraexampleco', 'invited')] })).reason).toBe(
      'noraexampleco is invited, and accepts once it is connected',
    );
    expect(accessLine(access({ bots: [bot('qa', 'no-account')] }), () => 'the QA bot').reason).toBe('the QA bot has no GitHub account yet');
  });

  it('says why it could not look at all, with a way to try again', () => {
    expect(accessLine(access({ error: 'no GitHub App private key is stored, so OpenADLC cannot invite anybody', bots: NINE }))).toEqual({
      tone: 'alarm',
      text: 'The crew could not be let in',
      reason: 'no GitHub App private key is stored, so OpenADLC cannot invite anybody',
      action: 'Try again',
      busy: false,
    });
  });

  it('offers to look for a repository nothing has looked at', () => {
    expect(accessLine(null)).toMatchObject({ text: 'Not checked yet', action: 'Check now' });
  });
});

describe('a repository the app cannot reach', () => {
  const NEEDS = {
    need: 'make-public' as const,
    title: 'The OpenADLC app is private to janedoe',
    detail: 'GitHub installs a private app only on the account that owns it, so it cannot go on exampleco yet.',
    action: { label: 'Make the app public', url: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced' },
    steps: [],
  };

  it('says what to do, in the bridge’s words, with the page on GitHub where it is done instead of Try again', () => {
    expect(accessLine(access({ error: NEEDS.title, needs: NEEDS }))).toEqual({
      tone: 'attention',
      text: 'The OpenADLC app is private to janedoe',
      reason: 'GitHub installs a private app only on the account that owns it, so it cannot go on exampleco yet.',
      action: null,
      link: { label: 'Make the app public', url: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced' },
      busy: false,
    });
  });

  it('keeps saying it while the clock checks again, and says the crew is going in once it can', () => {
    expect(accessLine(access({ running: true, trigger: 'reconcile', error: NEEDS.title, needs: NEEDS }))).toMatchObject({ text: NEEDS.title });
    expect(accessLine(access({ bots: NINE, needs: null }))).toMatchObject({ text: '9 of 9 bots can work here' });
  });
});
