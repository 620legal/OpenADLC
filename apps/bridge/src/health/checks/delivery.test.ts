import { DEFAULT_DELIVERY_RULES, deliveryRulesSchema, type DeliveryRules } from '@fleetadlc/shared';
import { describe, expect, it } from 'vitest';
import { deliveryCheck, productionEnvironmentOf, type DeliveryReader, type ProductionEnvironment } from './delivery.js';

/**
 * The production environment is the gate, so the check is that it holds the
 * way the rules say — and that no crew account is among those who can open it.
 */

const AUTO = deliveryRulesSchema.parse({ version: 1, production: { approval: 'auto', soakMinutes: 30 } });
/** A person approves production: written out, since the default is automatic now. */
const REVIEWERS = deliveryRulesSchema.parse({ version: 1, production: { approval: 'reviewers', soakMinutes: 0 } });

function reader(
  rules: DeliveryRules,
  environment: ProductionEnvironment | null | undefined,
  planRefused = false,
  crew = ['fleetadlc-sre', 'fleetadlc-builder'],
): DeliveryReader {
  return {
    repos: async () => [{ name: 'app', fullName: 'exampleco/app', defaultBranch: 'main' }],
    rules: async () => rules,
    production: async () => environment,
    planRefused: async () => planRefused,
    crewLogins: async () => crew,
  };
}

const user = (name: string) => ({ kind: 'user' as const, name });
const team = (name: string) => ({ kind: 'team' as const, name });

async function run(source: DeliveryReader) {
  return (await deliveryCheck(source).run(new Date()))[0];
}

describe('production held the way the rules say', () => {
  it('fails, blocking, when a crew account can approve a production deploy', async () => {
    const result = await run(reader(REVIEWERS, { reviewers: [user('janedoe'), user('FleetADLC-SRE')], waitTimer: 0 }));
    expect(result).toMatchObject({ ok: false, severity: 'blocking' });
    expect(result && 'detail' in result ? result.detail : '').toContain('A bot never approves a deploy');
  });

  it('warns when the rules say a person approves and nobody is asked, and sends the person to choose how production ships', async () => {
    const result = await run(reader(REVIEWERS, { reviewers: [], waitTimer: 0 }));
    expect(result).toMatchObject({ ok: false, severity: 'warning', action: { href: '/onboarding?step=protect' } });
    // Not bare `fleetadlc github apply`, which wrote an empty reviewer list again.
    expect(result && 'action' in result ? JSON.stringify(result.action) : '').not.toContain('"command":"fleetadlc github apply"');
    expect(result && 'detail' in result ? result.detail : '').toContain('fleetadlc github apply --production reviewers --reviewer <login>');
  });

  it('reads the default rules as automatic, which needs no reviewer', async () => {
    expect(DEFAULT_DELIVERY_RULES.production.approval).toBe('auto');
    expect(await run(reader(DEFAULT_DELIVERY_RULES, { reviewers: [], waitTimer: 30 }))).toMatchObject({ ok: true });
  });

  it('passes where the plan refused the reviewer, saying OpenADLC holds each promote for a person', async () => {
    expect(await run(reader(REVIEWERS, { reviewers: [], waitTimer: 0 }, true))).toMatchObject({
      ok: true,
      facts: { approval: 'reviewers', heldBy: 'fleetadlc' },
    });
  });

  it('warns when the rules say auto and a person is still asked', async () => {
    expect(await run(reader(AUTO, { reviewers: [user('janedoe')], waitTimer: 30 }))).toMatchObject({ ok: false, severity: 'warning' });
  });

  it('passes a person approving, and an auto environment with no reviewer', async () => {
    expect(await run(reader(REVIEWERS, { reviewers: [user('janedoe')], waitTimer: 0 }))).toMatchObject({ ok: true });
    expect(await run(reader(AUTO, { reviewers: [], waitTimer: 30 }))).toMatchObject({ ok: true });
  });

  it('asks a person to confirm no crew account is in a team reviewer, naming it, rather than passing', async () => {
    const result = await run(reader(REVIEWERS, { reviewers: [team('engineering')], waitTimer: 0 }, false, ['builder-acct', 'engineering-bot']));
    expect(result).toMatchObject({ ok: null, reason: expect.stringContaining('@exampleco/engineering is a team among its production reviewers') });
    expect(result && 'reason' in result ? result.reason : '').toContain('a person should confirm no crew account is a member');
  });

  it('does not take a team whose slug is a crew login for that crew account', async () => {
    const result = await run(reader(REVIEWERS, { reviewers: [user('janedoe'), team('fleetadlc-sre')], waitTimer: 0 }));
    expect(result).toMatchObject({ ok: null });
  });

  it('counts a team as a reviewer when comparing with the rules', async () => {
    expect(await run(reader(AUTO, { reviewers: [team('ops')], waitTimer: 30 }))).toMatchObject({ ok: false, severity: 'warning' });
  });

  it('says nothing when GitHub could not be asked, or there is no environment yet', async () => {
    expect(await run(reader(REVIEWERS, undefined))).toMatchObject({ ok: null });
    expect(await run(reader(REVIEWERS, null))).toMatchObject({ ok: null });
  });
});

describe('production held to the default branch', () => {
  const held = { reviewers: [user('janedoe')], waitTimer: 0 };

  it('passes a production that only the default branch may deploy to', async () => {
    expect(await run(reader(REVIEWERS, { ...held, branches: ['main'] }))).toMatchObject({ ok: true });
  });

  it('warns when its branch policy admits anything else, even with a reviewer', async () => {
    for (const branches of ['protected', null, ['main', 'agent/*'], ['trunk'], []] as const) {
      const result = await run(reader(REVIEWERS, { ...held, branches: branches as never }));
      expect(result, JSON.stringify(branches)).toMatchObject({ ok: false, severity: 'warning' });
      expect(result && 'detail' in result ? result.detail : '').toContain('fleetadlc github apply');
    }
  });

  it('says nothing of the branches when they could not be read, or the plan refused the environment’s rules', async () => {
    expect(await run(reader(REVIEWERS, held))).toMatchObject({ ok: true });
    expect(await run(reader(REVIEWERS, { reviewers: [], waitTimer: 0, branches: null }, true))).toMatchObject({ ok: true });
  });
});

describe('GitHub’s environment, read', () => {
  it('is its reviewers, each a person or a team, and its wait timer', () => {
    expect(
      productionEnvironmentOf({
        protection_rules: [
          { type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'janedoe' } }, { type: 'Team', reviewer: { slug: 'ops' } }] },
          { type: 'wait_timer', wait_timer: 30 },
        ],
      }),
    ).toEqual({ reviewers: [user('janedoe'), team('ops')], waitTimer: 30, branches: null });
  });

  it('is the branches its policy admits', () => {
    expect(productionEnvironmentOf({ deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }).branches).toBe(
      'protected',
    );
    expect(
      productionEnvironmentOf({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }, [
        { name: 'main', type: 'branch' },
        { name: 'v*', type: 'tag' },
      ]).branches,
    ).toEqual(['main', 'tag v*']);
    expect(productionEnvironmentOf({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }).branches).toBeUndefined();
  });
});
