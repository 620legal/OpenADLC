import { describe, expect, it } from 'vitest';
import { changesIn, familyAlias, modelOptions, planCrew, summarisePlan } from './crew-step';
import { loginNamesSeat, prefillGitHubAccounts } from './github-accounts-step';
import type { GitHubAccountsView } from '@/lib/api';
import type { AccountRef, CrewBot } from '@/lib/model-onboarding';

const seat = (slot: string, role: string, roleLabel: string, group: 'crew' | 'reviewers') => ({
  name: slot,
  slot,
  role,
  roleLabel,
  group,
  login: null,
  choices: [],
});

const GITHUB: GitHubAccountsView = {
  accounts: [
    { login: 'fleetadlc-builder-acme', url: '', group: null, signIn: 'signed-in', seats: [] },
    { login: 'fleetadlc-lead-reviewer-acme', url: '', group: null, signIn: 'signed-in', seats: [] },
  ],
  bots: [
    seat('automation', 'automation', 'automation', 'crew'),
    seat('lead-reviewer', 'review_lead', 'lead reviewer', 'reviewers'),
    seat('builder', 'implement', 'builder', 'crew'),
    seat('intake', 'intake', 'intake', 'crew'),
    seat('second-reviewer', 'review_second', 'second reviewer', 'reviewers'),
  ],
};

const MAX: AccountRef = { id: 'max', provider: 'anthropic', kind: 'subscription', label: 'Max', verifiedAt: '2026-10-01T00:00:00Z', verifyError: null };
const XAI: AccountRef = { id: 'xai', provider: 'xai', kind: 'key', label: 'xAI key', verifiedAt: '2026-10-01T00:00:00Z', verifyError: null };
const bot = (name: string, role: string, roleLabel: string, engine: CrewBot['engine'], model: string, account: string | null): CrewBot => ({
  bot: name,
  slot: name,
  role,
  roleLabel,
  engine,
  model,
  modelAccountId: account,
  readiness: null,
});

describe('the crew, said in a few lines', () => {
  it('says which account does the work and which approves it, from the accounts named for those seats', () => {
    const { github, unchosen } = summarisePlan(planCrew(GITHUB, null, null, null), GITHUB);
    expect(github).toEqual([
      { what: 'fleetadlc-builder-acme', part: 'Does the work', seats: ['intake', 'builder', 'automation'] },
      { what: 'fleetadlc-lead-reviewer-acme', part: 'Approves it', seats: ['lead reviewer', 'second reviewer'] },
    ]);
    expect(unchosen).toEqual([]);
  });

  it('groups the seats by what they think with, the most first, and leaves out a seat that thinks with nothing', () => {
    const crew = [
      bot('intake', 'intake', 'intake', 'claude', 'claude-sonnet-5', 'max'),
      bot('builder', 'implement', 'builder', 'claude', 'claude-sonnet-5', 'max'),
      bot('second-reviewer', 'review_second', 'second reviewer', 'grok', 'grok-4.7', 'xai'),
      bot('automation', 'automation', 'automation', 'none', 'none', null),
    ];
    const { models, unchosen } = summarisePlan(planCrew(null, crew, [MAX, XAI], {}), null);
    expect(models).toEqual([
      { what: 'Claude Sonnet 5 · Max', part: null, seats: ['intake', 'builder'] },
      { what: 'Grok 4.7 · xAI key', part: null, seats: ['second reviewer'] },
    ]);
    expect(unchosen).toEqual([]);
  });

  it('names a seat nothing could be chosen for, so the step can say so rather than save it empty', () => {
    const lone: GitHubAccountsView = { ...GITHUB, accounts: [GITHUB.accounts[0]!, { ...GITHUB.accounts[0]!, login: 'someone-else' }, { ...GITHUB.accounts[0]!, login: 'a-third' }] };
    const { unchosen } = summarisePlan(planCrew(lone, null, null, null), lone);
    expect(unchosen).toContain('lead reviewer');
    expect(unchosen).not.toContain('builder');
  });
});

describe('a seat that cannot run, or whose models could not be listed', () => {
  it('is named with its reason, and the crew is not called ready', () => {
    const crew = [{ ...bot('builder', 'implement', 'builder', 'claude', 'claude-sonnet-5', 'max'), readiness: { ready: false, detail: 'the `claude` command is not on this host' } }];
    const listings = { max: { models: [], aliases: ['newest:sonnet'], error: null } } as never;
    const { problems, unchosen } = summarisePlan(planCrew(null, crew as never, [MAX], listings), null);
    expect(problems).toEqual([{ seat: 'builder', note: 'the `claude` command is not on this host' }]);
    expect(unchosen).toEqual([]);
  });

  it('says the account’s listing failed, rather than asking for an account it already has', () => {
    const crew = [bot('lead-reviewer', 'review_lead', 'lead reviewer', 'claude', 'claude-opus-5', null)];
    const listings = { max: { models: [], aliases: [], error: 'save its token first' } } as never;
    const plan = planCrew(null, crew, [MAX], listings);
    expect(plan[0]!.listingError).toBe('Could not list its models: save its token first');
    const { problems, unchosen } = summarisePlan(plan, null);
    expect(unchosen).toEqual([]);
    expect(problems).toEqual([{ seat: 'lead reviewer', note: 'Could not list its models: save its token first' }]);
  });
});

describe('an account named for a seat', () => {
  it('is that seat’s, by whole words, and not the numbered seat’s after it', () => {
    expect(loginNamesSeat('fleetadlc-lead-reviewer-acme', 'lead-reviewer')).toBe(true);
    expect(loginNamesSeat('fleetadlc-builder', 'builder')).toBe(true);
    expect(loginNamesSeat('fleetadlc-builder-2-acme', 'builder')).toBe(false);
    expect(loginNamesSeat('fleetadlc-builder-2-acme', 'builder-2')).toBe(true);
    expect(loginNamesSeat('fleetadlc-second-reviewer', 'reviewer')).toBe(true);
    expect(loginNamesSeat('reviewer-tools', 'lead-reviewer')).toBe(false);
  });

  it('puts every seat on its own account when there is one per seat, with nothing to choose', () => {
    const onePerSeat = GITHUB.bots.map((one) => ({ login: `fleetadlc-${one.slot}-acme`, signIn: 'signed-in', group: null }));
    const { byBot } = prefillGitHubAccounts(GITHUB.bots, onePerSeat);
    expect(byBot).toEqual(Object.fromEntries(GITHUB.bots.map((one) => [one.name, `fleetadlc-${one.slot}-acme`])));
  });

  it('reads an account named for a persona the crew once had as that persona’s seat', () => {
    // Accounts made when the crew had persona names: atlas was the builder,
    // cipher the security reviewer, flow the automation account. Nothing was
    // filled in for any seat.
    const bots = [...GITHUB.bots, seat('security-reviewer', 'review_security', 'security reviewer', 'reviewers')];
    const accounts = [
      { login: 'fleet-atlas-janedoe', signIn: 'signed-in', group: null, connectedAt: '2026-10-01T19:20:00Z' },
      { login: 'fleet-cipher-janedoe', signIn: 'signed-in', group: null, connectedAt: '2026-10-01T19:22:00Z' },
      { login: 'janedoe-fleet-flow', signIn: 'signed-in', group: null, connectedAt: '2026-10-01T19:17:00Z' },
    ];
    const { byBot, crewLogin, reviewLogin } = prefillGitHubAccounts(bots, accounts);
    expect(crewLogin).toBe('fleet-atlas-janedoe');
    expect(reviewLogin).toBe('fleet-cipher-janedoe');
    expect(byBot).toEqual({
      automation: 'janedoe-fleet-flow',
      builder: 'fleet-atlas-janedoe',
      intake: 'fleet-atlas-janedoe',
      'lead-reviewer': 'fleet-cipher-janedoe',
      'second-reviewer': 'fleet-cipher-janedoe',
      'security-reviewer': 'fleet-cipher-janedoe',
    });
  });

  it('takes accounts that name no seat in the order the accounts step asked for them', () => {
    const accounts = [
      { login: 'zed', signIn: 'signed-in', group: null, connectedAt: '2026-10-01T10:00:00Z' },
      { login: 'amy', signIn: 'signed-in', group: null, connectedAt: '2026-10-01T10:05:00Z' },
      { login: 'kim', signIn: 'signed-in', group: null, connectedAt: '2026-10-01T10:09:00Z' },
    ];
    const { byBot, crewLogin, reviewLogin } = prefillGitHubAccounts(GITHUB.bots, accounts);
    // Not by name: zed was connected first, as the account that does the work.
    expect(crewLogin).toBe('zed');
    expect(reviewLogin).toBe('amy');
    expect(byBot.intake).toBe('kim');
    expect(byBot.builder).toBe('zed');
    expect(byBot['second-reviewer']).toBe('amy');
  });
});

describe('the table behind the summary', () => {
  const crew = [
    bot('builder', 'implement', 'builder', 'claude', 'claude-sonnet-5', 'max'),
    bot('lead-reviewer', 'review_lead', 'lead reviewer', 'claude', 'claude-opus-5', null),
    bot('automation', 'automation', 'automation', 'none', 'none', null),
  ];
  const listings = {
    max: { models: [{ id: 'claude-opus-5', createdAt: null }, { id: 'claude-sonnet-5', createdAt: null }], aliases: ['newest:opus', 'newest:sonnet'] },
  } as never;

  it('lists the seats in the order work moves through them, each with its account and its model', () => {
    const plan = planCrew(GITHUB, crew, [MAX], listings);
    expect(plan.map((seat) => seat.seat)).toEqual(['intake', 'builder', 'lead-reviewer', 'second-reviewer', 'automation']);
    const builder = plan.find((seat) => seat.seat === 'builder')!;
    expect(builder.login).toBe('fleetadlc-builder-acme');
    expect(builder.model).toBe('max|claude-sonnet-5');
    expect(plan.find((seat) => seat.seat === 'automation')!.thinks).toBe(false);
  });

  it('offers the newest of each family an account follows, and a seat’s exact version when it is pinned to one', () => {
    const fable = { max: { models: [], aliases: ['newest:fable', 'newest:opus', 'newest:sonnet', 'newest:haiku'] } } as never;
    expect(modelOptions(crew[0]!, [MAX], fable).map((option) => option.label)).toEqual([
      'Newest Fable · Max',
      'Newest Opus · Max',
      'Newest Sonnet · Max',
      'Newest Haiku · Max',
      'Claude Sonnet 5, exactly · Max',
    ]);
    // Nothing pinned: the families alone, never every id the account lists.
    expect(modelOptions(crew[1]!, [MAX], listings).map((option) => option.model)).toEqual(['newest:opus', 'newest:sonnet']);
  });

  it('starts a seat with nothing saved on the newest of its proposed model’s family', () => {
    const lead = planCrew(GITHUB, crew, [MAX], listings).find((seat) => seat.seat === 'lead-reviewer')!;
    expect(lead.model).toBe('max|newest:opus');
    expect(familyAlias('claude-opus-5-5')).toBe('newest:opus');
    expect(familyAlias('claude-fable-5-1')).toBe('newest:fable');
    expect(familyAlias('grok-4.7')).toBe('newest:grok');
    expect(familyAlias('gpt-5-codex')).toBe('newest:codex');
    expect(familyAlias('gpt-5.5')).toBeNull();
  });

  it('saves only what differs from what is stored: the seats a person changed, and those it filled in', () => {
    const plan = planCrew(GITHUB, crew, [MAX], listings, {
      logins: {},
      models: { builder: 'max|claude-sonnet-5' },
    });
    const { logins, models } = changesIn(plan);
    // Every seat with no account stored gets the one worked out for it.
    expect(logins.map((change) => change.seat)).toEqual(['intake', 'builder', 'lead-reviewer', 'second-reviewer', 'automation']);
    // The builder already thinks with Sonnet on Max: nothing to send for it.
    expect(models.find((change) => change.seat === 'builder')).toBeUndefined();
    expect(models.find((change) => change.seat === 'lead-reviewer')).toMatchObject({ accountId: 'max' });
  });
});

