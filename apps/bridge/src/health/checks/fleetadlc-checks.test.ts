import type { RuleReport } from '@fleetadlc/github';
import type { Bot, Lease, ModelAccount, SubscriptionLogin, TaskState } from '@fleetadlc/shared';
import { describe, expect, it } from 'vitest';
import { leaseCheck, type LeaseReader } from './leases.js';
import { modelAccountCheck } from './models.js';
import { rulesCheck, skippedByLastApply } from './repository.js';

/**
 * The checks on what OpenADLC keeps for itself: the accounts the crew thinks
 * with, the repository's protection, and the leases that hold issues.
 */

const NOW = new Date('2026-09-25T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function account(partial: Partial<ModelAccount> & Pick<ModelAccount, 'id' | 'label' | 'provider' | 'kind'>): ModelAccount {
  return { createdAt: minutesAgo(600), verifiedAt: null, verifyError: null, ...partial };
}

const GROK_SEAT = account({ id: 'acct-grok', label: 'Grok — SuperGrok', provider: 'xai', kind: 'subscription' });
const OPENAI_KEY = account({ id: 'acct-openai', label: 'OpenAI — team key', provider: 'openai', kind: 'key' });
const CODEX_SEAT = account({ id: 'acct-codex', label: 'ChatGPT — Pro', provider: 'openai', kind: 'subscription' });
const UNUSED = account({ id: 'acct-spare', label: 'Anthropic — spare', provider: 'anthropic', kind: 'key' });

const crew = [
  { id: 'bot-second', name: 'irisexampleco', modelAccountId: 'acct-grok' },
  { id: 'bot-lead', name: 'noraexampleco', modelAccountId: 'acct-openai' },
  { id: 'bot-qa', name: 'qa-bot', modelAccountId: 'acct-codex' },
] as unknown as Bot[];

function models(options: { refuse?: Record<string, string>; login?: SubscriptionLogin['state'] }) {
  return modelAccountCheck({
    accounts: async () => [GROK_SEAT, OPENAI_KEY, CODEX_SEAT, UNUSED],
    crew: async () => crew,
    models: async (one) => {
      const refusal = options.refuse?.[one.id];
      if (refusal) throw new Error(refusal);
      return [];
    },
    login: async () => ({ state: options.login ?? 'signed-in' }) as SubscriptionLogin,
  });
}

describe('each model account a bot thinks with', () => {
  it('asks the ones in use with their own credential, and passes those that answer', async () => {
    const results = await models({}).run(NOW);
    expect(results.map((result) => [result.subject, result.ok])).toEqual([
      ['acct-grok', true],
      ['acct-openai', true],
      ['acct-codex', true],
    ]);
  });

  it('says a signed-out subscription is signed out, names who thinks with it, and sends a person to sign it in', async () => {
    const results = await models({
      refuse: { 'acct-grok': 'You are not authenticated — sign this subscription in again from the accounts step' },
    }).run(NOW);
    expect(results[0]).toMatchObject({
      subject: 'acct-grok',
      ok: false,
      severity: 'blocking',
      title: 'The xAI subscription “Grok — SuperGrok” is signed out',
      action: { label: 'Sign in again', href: '/onboarding?step=models' },
      facts: { accountId: 'acct-grok', botIds: ['bot-second'] },
    });
    expect(results[0] && 'detail' in results[0] ? results[0].detail : '').toContain('irisexampleco thinks with this xAI subscription');
  });

  it('calls a key the provider says is not authenticated refused, never a subscription to sign in', async () => {
    const [, key] = await models({ refuse: { 'acct-openai': 'You are not authenticated' } }).run(NOW);
    expect(key).toMatchObject({ ok: false, title: 'OpenAI refuses the key “OpenAI — team key”', action: { label: 'Replace the key' } });
    expect(JSON.stringify(key)).not.toMatch(/subscription|Sign in again|signed out/);
  });

  it('says a refused key is refused, with replacing it as the fix', async () => {
    const [, key] = await models({ refuse: { 'acct-openai': 'OpenAI answered 401: Incorrect API key provided' } }).run(NOW);
    expect(key).toMatchObject({ ok: false, title: 'OpenAI refuses the key “OpenAI — team key”', action: { label: 'Replace the key' } });
  });

  it('names an account by its provider and kind when its name only repeats them', async () => {
    // The walkthrough names a new account "xAI — subscription"; the titles read
    // "xAI — subscription is signed out" and "OpenAI refuses the key on OpenAI — API key".
    const check = modelAccountCheck({
      accounts: async () => [
        { ...GROK_SEAT, label: 'xAI — subscription' },
        { ...OPENAI_KEY, label: 'OpenAI — API key' },
      ],
      crew: async () => crew,
      models: async (one) => {
        throw new Error(one.id === 'acct-grok' ? 'You are not authenticated' : 'OpenAI answered 401: Incorrect API key provided');
      },
      login: async () => ({ state: 'signed-in' }) as SubscriptionLogin,
    });
    const [grok, key] = await check.run(NOW);
    expect(grok).toMatchObject({ ok: false, title: 'The xAI subscription is signed out' });
    expect(key).toMatchObject({ ok: false, title: 'OpenAI refuses the key' });
  });

  it('has no answer when the provider or hostd could not be asked', async () => {
    const [grok] = await models({ refuse: { 'acct-grok': 'hostd is not answering, so nothing can be signed in or checked.' } }).run(NOW);
    expect(grok).toMatchObject({ ok: null });
  });

  it('has no answer when hostd refuses the bridge itself, rather than calling the account signed out', async () => {
    const hostd = (message: string, status: number) => Object.assign(new Error(message), { status });
    const check = modelAccountCheck({
      accounts: async () => [GROK_SEAT, CODEX_SEAT],
      crew: async () => crew,
      models: async () => {
        throw hostd('unauthorized', 401);
      },
      login: async () => {
        throw hostd('this hostd was started without a sign-in service', 503);
      },
    });
    const [grok, codex] = await check.run(NOW);
    expect(grok).toMatchObject({ ok: null, reason: 'hostd could not be asked: unauthorized' });
    expect(codex).toMatchObject({ ok: null, reason: 'hostd could not be asked: this hostd was started without a sign-in service' });
  });

  it('still calls an OpenAI subscription signed out when hostd says its sign-in failed', async () => {
    const check = modelAccountCheck({
      accounts: async () => [CODEX_SEAT],
      crew: async () => crew,
      models: async () => [],
      login: async () => ({ state: 'failed', message: 'the device code expired' }),
    });
    expect((await check.run(NOW))[0]).toMatchObject({ ok: false, title: 'The OpenAI subscription “ChatGPT — Pro” is signed out' });
  });

  it('asks an OpenAI subscription, which lists nothing, whether it is signed in', async () => {
    const results = await models({ login: 'signed-out' }).run(NOW);
    expect(results.find((result) => result.subject === 'acct-codex')).toMatchObject({ ok: false, title: 'The OpenAI subscription “ChatGPT — Pro” is signed out' });
  });
});

describe('the repository’s protection', () => {
  const report = (name: string, state: RuleReport['state'], detail = ''): RuleReport => ({ name, state, detail });

  it('warns about protection that drifted or is missing, sending a person to apply it again', async () => {
    const [result] = await rulesCheck({
      plan: async () => [
        {
          repository: 'janedoe/fleetadlc-testbed',
          canApply: true,
          rules: [report('fleetadlc: main', 'drifted', 'missing rule required_signatures'), report('CODEOWNERS', 'present')],
        },
      ],
      refused: async () => new Set(),
    }).run(NOW);
    expect(result).toMatchObject({
      subject: 'janedoe/fleetadlc-testbed',
      ok: false,
      severity: 'warning',
      title: 'janedoe/fleetadlc-testbed is not protected the way OpenADLC sets it',
      action: { href: '/onboarding?step=protect' },
    });
    expect(result && 'detail' in result ? result.detail : '').toContain('- **fleetadlc: main:** missing rule required_signatures');
  });

  it('reads only what the last apply skipped, so a plan limit that no longer holds is asked for again', async () => {
    const refused = skippedByLastApply(['skipped fleetadlc: main', 'unsupported environment production', 'set up CODEOWNERS', 42]);
    expect([...refused]).toEqual(['fleetadlc: main']);
    // The repository went public: the plan dropped the stored limit, so production's reviewer is missing again.
    const [result] = await rulesCheck({
      plan: async () => [{ repository: 'janedoe/fleetadlc-testbed', canApply: true, rules: [report('environment production', 'missing')] }],
      refused: async () => refused,
    }).run(NOW);
    expect(result).toMatchObject({ ok: false, title: 'janedoe/fleetadlc-testbed is not protected the way OpenADLC sets it' });
  });

  it('does not take a ruleset the plan refused as refused for good: once the plan can hold it, it is missing', async () => {
    const refused = skippedByLastApply(['skipped fleetadlc: main', 'skipped required status checks'], ['fleetadlc: main']);
    expect([...refused]).toEqual(['required status checks']);
    const [result] = await rulesCheck({
      plan: async () => [{ repository: 'janedoe/fleetadlc-testbed', canApply: true, rules: [report('fleetadlc: main', 'missing')] }],
      refused: async () => refused,
    }).run(NOW);
    expect(result).toMatchObject({ ok: false });
  });

  it('does not ask for what GitHub refused the last time the rules were applied, or what the plan cannot hold', async () => {
    const [result] = await rulesCheck({
      plan: async () => [
        {
          repository: 'janedoe/fleetadlc-testbed',
          canApply: true,
          rules: [report('fleetadlc: main', 'missing'), report('environment production', 'unsupported', 'a private repository…')],
        },
      ],
      refused: async () => new Set(['fleetadlc: main']),
    }).run(NOW);
    expect(result).toMatchObject({ ok: true });
  });

  it('stops everything when nothing can land, and says so first', async () => {
    // A code owner that never reviews, no `ci` to wait for, no auto-merge:
    // every pull request the crew opened waited forever, and the board said
    // nothing, because this was "protection" and a warning at most.
    const [result] = await rulesCheck({
      plan: async () => [
        {
          repository: 'janedoe/fleetadlc-testbed',
          canApply: true,
          rules: [
            report('CODEOWNERS', 'drifted', 'it makes @ottoexampleco the code owner of everything, but the lead reviewer is @noraexampleco'),
            report('required status checks', 'missing', 'nothing in janedoe/fleetadlc-testbed publishes ci or review-gate'),
            report('auto-merge', 'missing', 'every pull request waits for a person to press merge'),
          ],
        },
      ],
      // The last apply recorded the status checks as skipped. That was OpenADLC
      // leaving the rule off, not GitHub refusing it, so it is still asked for.
      refused: async () => new Set(['required status checks']),
    }).run(NOW);

    expect(result).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: 'Nothing the crew builds can land in janedoe/fleetadlc-testbed',
      action: { label: 'Fix the repository', href: '/onboarding?step=protect' },
    });
    const detail = result && 'detail' in result ? result.detail : '';
    expect(detail).toContain('@ottoexampleco');
    expect(detail).toContain('- **required status checks:** nothing in janedoe/fleetadlc-testbed publishes ci');
    expect(detail).toContain('auto-merge');
    // One line a reason: run together with semicolons, three reasons were a paragraph nobody could scan.
    expect(detail.split('\n').filter((line) => line.startsWith('- **'))).toHaveLength(3);
  });

  it('stops everything when the ruleset asks for an approval after the merge line’s own update', async () => {
    const [result] = await rulesCheck({
      plan: async () => [
        {
          repository: 'janedoe/fleetadlc-testbed',
          canApply: true,
          rules: [report('fleetadlc: main', 'drifted', 'pull_request.require_last_push_approval is true, not false')],
        },
      ],
      refused: async () => new Set(),
    }).run(NOW);

    expect(result).toMatchObject({ ok: false, severity: 'blocking', title: 'Nothing the crew builds can land in janedoe/fleetadlc-testbed' });
  });

  it('has no answer without the app’s key', async () => {
    const [result] = await rulesCheck({
      plan: async () => [{ repository: 'janedoe/fleetadlc-testbed', canApply: false, rules: [] }],
      refused: async () => new Set(),
    }).run(NOW);
    expect(result).toMatchObject({ ok: null });
  });

  it('says why the app could not read them, as the plan does, rather than that no key is held', async () => {
    const detail = 'the OpenADLC app is not installed on janedoe/fleetadlc-testbed: install it on this repository';
    const [result] = await rulesCheck({
      plan: async () => [{ repository: 'janedoe/fleetadlc-testbed', canApply: false, rules: [], detail }],
      refused: async () => new Set(),
    }).run(NOW);
    expect(result).toMatchObject({ ok: null, reason: `the repository’s rules could not be read as the app: ${detail}` });
  });
});

describe('a lease with nothing working under it', () => {
  function reader(options: {
    lease?: Partial<Lease>;
    tasks?: { leaseId: string | null; state: TaskState; createdAt: string; endedAt: string | null }[];
    prNumber?: number | null;
    released?: string[];
    /** What the release finds as it writes: false when the lease is no longer idle. */
    stillIdle?: boolean;
  }): LeaseReader {
    const lease: Lease = {
      id: 'lease-1',
      repoId: 'repo-1',
      issueNumber: 12,
      botId: 'bot-builder',
      declaredPaths: ['apps/api/'],
      state: 'in_task',
      expiresAt: minutesAgo(-600),
      prNumber: null,
      updatedAt: minutesAgo(120),
      ...options.lease,
    };
    return {
      leases: async () => [lease],
      repos: async () => [{ id: 'repo-1', name: 'fleetadlc-testbed' }],
      tasksOn: async () => options.tasks ?? [],
      issue: async () => ({ title: 'Add a health endpoint', prNumber: options.prNumber ?? null }),
      botName: async () => 'fleetadlc-atlas-janedoe',
      release: async (one) => {
        if (options.stillIdle === false) return false;
        options.released?.push(one.id);
        return true;
      },
    };
  }

  it('is let go when its task ended a quarter of an hour ago without a pull request, and the board is told once', async () => {
    const released: string[] = [];
    const results = await leaseCheck(
      reader({ released, tasks: [{ leaseId: 'lease-1', state: 'failed', createdAt: minutesAgo(80), endedAt: minutesAgo(60) }] }),
    ).run(NOW);

    expect(released).toEqual(['lease-1']);
    expect(results).toEqual([
      {
        subject: 'lease-1',
        ok: true,
        note: 'Released #12 “Add a health endpoint” in fleetadlc-testbed, which fleetadlc-atlas-janedoe held with nothing working on it',
      },
    ]);
  });

  it('says nothing was released when work started under it between the read and the release', async () => {
    const results = await leaseCheck(
      reader({ stillIdle: false, tasks: [{ leaseId: 'lease-1', state: 'failed', createdAt: minutesAgo(80), endedAt: minutesAgo(60) }] }),
    ).run(NOW);
    expect(results).toEqual([{ subject: 'lease-1', ok: true }]);
  });

  it('is kept while a task runs under it, just after one ended, once there is a pull request, and while it waits on a person', async () => {
    const released: string[] = [];
    await leaseCheck(reader({ released, tasks: [{ leaseId: 'lease-1', state: 'running', createdAt: minutesAgo(80), endedAt: null }] })).run(NOW);
    await leaseCheck(reader({ released, tasks: [{ leaseId: 'lease-1', state: 'failed', createdAt: minutesAgo(20), endedAt: minutesAgo(5) }] })).run(NOW);
    await leaseCheck(reader({ released, prNumber: 31 })).run(NOW);
    await leaseCheck(reader({ released, lease: { state: 'paused' } })).run(NOW);
    expect(released).toEqual([]);
  });

  it('is kept when its build finished: the pull request is on its way, and letting go would hand the issue out twice', async () => {
    const released: string[] = [];
    await leaseCheck(reader({ released, tasks: [{ leaseId: 'lease-1', state: 'done', createdAt: minutesAgo(90), endedAt: minutesAgo(60) }] })).run(NOW);
    expect(released).toEqual([]);
  });

  it('is let go when nothing was ever started under it', async () => {
    const released: string[] = [];
    await leaseCheck(reader({ released, tasks: [] })).run(NOW);
    expect(released).toEqual(['lease-1']);
  });
});
