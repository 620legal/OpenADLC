import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { botCanRun as engineCanRun, type ModelProvider } from '../../../../packages/engines/src/provider-models';
import {
  ENGINES_WAIT_MS,
  KEY_LINKS,
  LOGIN_POLL_MS,
  NOT_VERIFIED_COPY,
  NO_MODEL_COPY,
  SETUP_TOKEN_COMMAND,
  SETUP_TOKEN_HOW,
  SIGN_IN_COPY,
  SIGN_IN_WAITING_COPY,
  SIGN_IN_WINDOW_MS,
  SUBSCRIPTION_SEAT,
  SUBSCRIPTION_TERMS,
  TOKEN_SAVE_COPY,
  accountKindLine,
  accountLoginPath,
  accountMark,
  accountModelsPath,
  accountRemovePath,
  accountRequestBody,
  accountStanding,
  accountTags,
  accountTokenPath,
  accountVerifyPath,
  addAccount,
  addedAccountId,
  asSentence,
  checkedWhen,
  credentialOf,
  followSignIn,
  keyAcceptedCopy,
  loginStateFrom,
  saveCredential,
  saveTokenAndVerify,
  setupTokenProblem,
  startSignIn,
  subscriptionCredential,
  verifyAccount,
  type AccountCheck,
  type LoginState,
  accountsFrom,
  accountsStepDone,
  assignmentPath,
  assignmentStepDone,
  crewFromEngines,
  defaultAccountLabel,
  draftFor,
  forwardLabel,
  isVerified,
  jsonWithin,
  listingFrom,
  listModelsFor,
  modelChoices,
  botCanRun,
  modelFor,
  modelName,
  newestId,
  offeredAs,
  offeredLine,
  offers,
  propose,
  proposable,
  saveAssignment,
  tierOf,
  type AccountListing,
  type AccountRef,
  type CrewBot,
  type ListedModel,
  type Proposal,
  type ProposalAssignment,
  type Readiness,
} from './model-onboarding';
import { ROLES } from './bot-label';

/**
 * The decisions the two steps make. Rendered copy is asserted here as strings
 * the components put on the page unchanged: a test that regexes the server
 * HTML for interpolated text does not see it, because React splits that with
 * comment markers.
 */

const ANTHROPIC: ListedModel[] = [
  { id: 'claude-opus-5', createdAt: '2026-04-01' },
  { id: 'claude-opus-4-8', createdAt: '2026-01-15' },
  { id: 'claude-sonnet-5', createdAt: '2026-03-01' },
  { id: 'claude-haiku-4-5', createdAt: '2025-10-01' },
];

const CLAUDE_FAMILIES = ['newest:opus', 'newest:sonnet', 'newest:haiku'];

/** When a seat's check answered, for the accounts the proposal may use. */
const VERIFIED_AT = '2026-09-24T08:05:00.000Z';

function listing(models: ListedModel[], aliases: string[] = [], error: string | null = null): AccountListing {
  return { models, aliases, error };
}

function account(partial: Partial<AccountRef> = {}): AccountRef {
  return {
    id: 'acct-anthropic',
    provider: 'anthropic',
    kind: 'key',
    label: 'Anthropic — Max',
    ...partial,
  };
}

/**
 * A bot as `/v1/engines` reports it. One named for a seat — `builder`,
 * `builder-2` — has not connected an account yet, and gets its role's words.
 */
function bot(partial: Partial<CrewBot> & Pick<CrewBot, 'bot'>): CrewBot {
  const seat = Object.values(ROLES).find((one) => one.seat === partial.bot.replace(/-\d+$/, ''));
  return {
    roleLabel: seat?.label ?? 'builder',
    engine: 'claude',
    model: 'claude-sonnet-5',
    modelAccountId: null,
    readiness: null,
    ...partial,
  };
}

/**
 * The crew as the bridge holds it once each row is saved as proposed: on
 * another provider's account, the bot runs that provider's engine.
 */
function saved(bots: readonly CrewBot[], proposal: Proposal): CrewBot[] {
  const byBot = new Map(proposal.assignments.map((assignment) => [assignment.bot, assignment]));
  return bots.map((one) => {
    const next = byBot.get(one.bot);
    return next ? { ...one, engine: next.engine, model: next.model, modelAccountId: next.accountId } : one;
  });
}

const NINE = ['intake', 'system-engineer', 'builder', 'lead-reviewer', 'sre', 'qa', 'builder-2', 'builder-3', 'builder-4'];

describe('one account, entered once', () => {
  it('puts nine thinking bots on the one Anthropic account', () => {
    const anthropic = account();
    const crew = NINE.map((name) => bot({ bot: name }));
    const proposal = propose([anthropic], crew);

    expect(proposal?.assignments).toHaveLength(9);
    expect(new Set(proposal?.assignments.map((one) => one.accountId))).toEqual(new Set([anthropic.id]));
    expect(proposal?.sentence).toBe('Put all nine thinking bots on Anthropic — Max.');
  });

  it('does not send a key for a subscription, even one left in the field', () => {
    expect(
      accountRequestBody({
        provider: 'anthropic',
        kind: 'subscription',
        label: 'Anthropic — Max',
        key: 'sk-ant-should-not-travel',
      }),
    ).toEqual({ provider: 'anthropic', kind: 'subscription', label: 'Anthropic — Max' });
  });

  it('defaults a subscription label to the seat a person would recognise', () => {
    expect(defaultAccountLabel('anthropic', 'subscription')).toBe('Anthropic — Max');
    expect(defaultAccountLabel('openai', 'key')).toBe('OpenAI — API key');
  });
});

describe('what the screen has to say', () => {
  it('states that bots sharing a subscription run at once, on one allowance, and never that they queue', () => {
    expect(SUBSCRIPTION_SEAT).toContain('run at the same time');
    expect(SUBSCRIPTION_SEAT).toContain('one usage allowance and rate limit');
    expect(SUBSCRIPTION_SEAT).not.toMatch(/queue|one seat|do not run in parallel/);
  });

  it('sends a subscriber to the provider’s terms, and a shared install to API keys', () => {
    expect(SUBSCRIPTION_TERMS).toContain('provider’s current terms');
    expect(SUBSCRIPTION_TERMS).toContain('API keys');
  });

  it('keeps the links to where a key is issued', () => {
    expect(KEY_LINKS.anthropic.url).toBe('https://console.anthropic.com/settings/keys');
    expect(KEY_LINKS.openai.url).toBe('https://platform.openai.com/api-keys');
    expect(KEY_LINKS.xai.url).toBe('https://console.x.ai/');
  });
});

describe('the proposal', () => {
  it('can be accepted without touching a row, and that finishes the step', () => {
    const anthropic = account({ kind: 'subscription', verifiedAt: VERIFIED_AT });
    const crew = [
      ...NINE.slice(0, 7).map((name) => bot({ bot: name, model: 'claude-opus-5' })),
      bot({ bot: 'automation', engine: 'none', model: 'none', roleLabel: 'automation' }),
    ];
    const proposal = propose([anthropic], crew);
    expect(proposal?.sentence).toBe(
      'Put all seven thinking bots on Anthropic — Max, and leave the automation bot without a model.',
    );

    const applied = saved(crew, proposal!);
    expect(assignmentStepDone([anthropic], crew)).toBe(false);
    expect(assignmentStepDone([anthropic], applied)).toBe(true);
    expect(applied.find((one) => one.bot === 'automation')).toMatchObject({ model: 'none', modelAccountId: null });
  });

  it('names a bot with no model as correct, not as unconfigured', () => {
    expect(NO_MODEL_COPY).toBe('no model, and that is correct');
    expect(NO_MODEL_COPY.toLowerCase()).not.toContain('unconfigured');

    const proposal = propose(
      [account()],
      [bot({ bot: 'builder' }), bot({ bot: 'automation', engine: 'none', model: 'none', roleLabel: 'automation' })],
    );
    expect(proposal?.sentence).toBe(
      'Put the one thinking bot on Anthropic — Max, and leave the automation bot without a model.',
    );
    expect(proposal?.assignments.map((one) => one.bot)).toEqual(['builder']);
  });

  it('puts a bot whose provider has no account on another provider’s, at the same depth, and says so', () => {
    // It used to be left out, "no account for that engine yet", with an
    // Anthropic account right there that could have thought for it.
    const proposal = propose(
      [account()],
      [
        bot({ bot: 'builder' }),
        bot({ bot: 'second-reviewer', role: 'review_second', engine: 'grok', model: 'grok-4', roleLabel: 'second reviewer' }),
        bot({ bot: 'automation', engine: 'none', model: 'none', roleLabel: 'automation' }),
      ],
    );

    expect(proposal?.assignments).toEqual([
      { bot: 'builder', accountId: 'acct-anthropic', model: 'claude-sonnet-5', engine: 'claude' },
      {
        bot: 'second-reviewer',
        accountId: 'acct-anthropic',
        model: 'claude-opus-5',
        engine: 'claude',
        substitution: { kind: 'provider', from: 'xai', why: 'none', lead: null },
      },
    ]);
    expect(proposal?.sentence).toBe(
      'Put the builder on Anthropic — Max. The second reviewer has no xAI account — proposed Claude Opus 5 on Anthropic — Max. The automation bot has no model, and that is correct.',
    );
  });

  it('does not propose an account nothing has verified', () => {
    const unchecked = account({ id: 'acct-seat', kind: 'subscription', label: 'Anthropic — Max' });
    const key = account({ id: 'acct-key', kind: 'key', label: 'Anthropic — API key' });
    const refused = account({ id: 'acct-refused', kind: 'key', label: 'old key', verifyError: 'invalid x-api-key' });
    const crew = [bot({ bot: 'builder' }), bot({ bot: 'automation', engine: 'none', model: 'none' })];

    expect(isVerified(unchecked)).toBe(false);
    expect(isVerified(refused)).toBe(false);
    expect(isVerified(key)).toBe(true);
    expect(propose([unchecked, refused, key], crew)?.assignments).toEqual([
      { bot: 'builder', accountId: 'acct-key', model: 'claude-sonnet-5', engine: 'claude' },
    ]);
    expect(propose([unchecked], crew)).toEqual({
      sentence:
        'No account is verified yet, so there is nothing to propose — verify one on the previous step. The automation bot has no model, and that is correct.',
      assignments: [],
    });
  });

  it('says the account of a bot’s own provider is there but not verified, when it is', () => {
    const proposal = propose(
      [account(), account({ id: 'acct-openai', provider: 'openai', kind: 'subscription', label: 'ChatGPT Pro' })],
      [bot({ bot: 'security-reviewer', role: 'review_security', engine: 'codex', model: 'gpt-5-codex' })],
    );

    expect(proposal?.sentence).toBe(
      'The security reviewer has no verified OpenAI account — proposed Claude Opus 5 on Anthropic — Max.',
    );
  });
});

describe('a crew with an Anthropic seat and a SuperGrok one', () => {
  // What such accounts list. The Claude seat lists real ids, the
  // families it can follow, and Haiku only with its release date; the
  // SuperGrok seat lists no dates and marks its default.
  const MAX = account({ id: 'acct-max', kind: 'subscription', label: 'Anthropic — Max', verifiedAt: VERIFIED_AT });
  const SUPERGROK = account({
    id: 'acct-supergrok',
    provider: 'xai',
    kind: 'subscription',
    label: 'xAI — subscription',
    verifiedAt: VERIFIED_AT,
  });
  const LISTINGS: Record<string, AccountListing> = {
    'acct-max': listing(
      [
        { id: 'claude-opus-5-5', createdAt: '2026-08-20', isDefault: false },
        { id: 'claude-fable-5-1', createdAt: '2026-08-06', isDefault: false },
        { id: 'claude-opus-5', createdAt: '2026-04-01', isDefault: false },
        { id: 'claude-sonnet-5', createdAt: '2026-03-01', isDefault: false },
        { id: 'claude-fable-5', createdAt: '2026-02-10', isDefault: false },
        { id: 'claude-opus-4-8', createdAt: '2026-01-15', isDefault: false },
        { id: 'claude-haiku-4-5-20251001', createdAt: '2025-10-01', isDefault: false },
      ],
      CLAUDE_FAMILIES,
    ),
    'acct-supergrok': listing(
      [
        { id: 'grok-4.7', createdAt: null, isDefault: true },
        { id: 'grok-4.7-build-fast', createdAt: null, isDefault: false },
        { id: 'grok-4.6', createdAt: null, isDefault: false },
        { id: 'grok-4.5', createdAt: null, isDefault: false },
      ],
      ['newest:grok'],
    ),
  };
  // config/bots.yaml, as `/v1/engines` reports it before anything is assigned —
  // with one account connected, the second reviewer's, whose handle it now goes by.
  const CREW = [
    bot({ bot: 'intake', role: 'intake', roleLabel: 'intake', model: 'claude-haiku-4-5' }),
    bot({ bot: 'system-engineer', role: 'spec', roleLabel: 'system engineer', model: 'claude-opus-5' }),
    bot({ bot: 'builder', role: 'implement', roleLabel: 'builder', model: 'claude-sonnet-5' }),
    bot({ bot: 'lead-reviewer', role: 'review_lead', roleLabel: 'lead reviewer', model: 'claude-opus-5' }),
    bot({
      bot: 'irisexampleco',
      slot: 'second-reviewer',
      role: 'review_second',
      roleLabel: 'second reviewer',
      engine: 'grok',
      model: 'grok-4',
    }),
    bot({ bot: 'security-reviewer', role: 'review_security', roleLabel: 'security reviewer', engine: 'codex', model: 'gpt-5-codex' }),
    bot({ bot: 'sre', role: 'deploy', roleLabel: 'SRE', model: 'claude-sonnet-5' }),
    bot({ bot: 'qa', role: 'qa', roleLabel: 'QA', model: 'claude-sonnet-5' }),
    bot({ bot: 'automation', role: 'automation', roleLabel: 'automation', engine: 'none', model: 'none' }),
  ];
  const proposal = propose([MAX, SUPERGROK], CREW, LISTINGS)!;
  const of = (name: string) => proposal.assignments.find((one) => one.bot === name);

  it('proposes the second reviewer the SuperGrok seat’s default, grok-4.7, not the grok-4 it does not offer', () => {
    expect(of('irisexampleco')).toEqual({
      bot: 'irisexampleco',
      accountId: 'acct-supergrok',
      model: 'grok-4.7',
      engine: 'grok',
      substitution: { kind: 'model', configured: 'grok-4' },
    });
  });

  it('keeps the Claude bots on the Claude seat with the models they were set to, as the seat lists them', () => {
    for (const name of ['builder', 'system-engineer', 'lead-reviewer', 'sre', 'qa']) {
      const configured = CREW.find((one) => one.bot === name)!.model;
      expect(of(name)).toEqual({ bot: name, accountId: 'acct-max', model: configured, engine: 'claude' });
    }
    // The seat lists Haiku 4.5 only with its release date. The undated name
    // the configuration uses is the same model, and the one kept.
    expect(of('intake')).toEqual({ bot: 'intake', accountId: 'acct-max', model: 'claude-haiku-4-5', engine: 'claude' });
  });

  it('proposes from the configuration, not from a choice already saved', () => {
    // The builder was moved to the SuperGrok seat. Its proposal is still the one
    // config/bots.yaml recommends, never the choice saved before it.
    const moved = CREW.map((one) =>
      one.bot === 'builder'
        ? {
            ...one,
            engine: 'grok' as const,
            model: 'grok-4.7',
            modelAccountId: 'acct-supergrok',
            configuredEngine: 'claude' as const,
            configuredModel: 'claude-sonnet-5',
          }
        : one,
    );
    const again = propose([MAX, SUPERGROK], moved, LISTINGS)!;
    expect(again.assignments.find((one) => one.bot === 'builder')).toEqual({
      bot: 'builder',
      accountId: 'acct-max',
      model: 'claude-sonnet-5',
      engine: 'claude',
    });
  });

  it('puts the security reviewer on Claude, since the free provider is the second reviewer’s, and says it shares the lead reviewer’s', () => {
    expect(of('security-reviewer')).toEqual({
      bot: 'security-reviewer',
      accountId: 'acct-max',
      model: 'claude-opus-5',
      engine: 'claude',
      substitution: { kind: 'provider', from: 'openai', why: 'none', lead: 'same' },
    });
    expect(proposal.sentence).toContain(
      'The security reviewer has no OpenAI account — proposed Claude Opus 5 on Anthropic — Max; its second opinion then comes from the same provider as the lead reviewer',
    );
  });

  it('says every substitution, and nothing else, in one paragraph', () => {
    expect(proposal.sentence).toBe(
      'Put the intake bot, the system engineer, the builder, the lead reviewer, the SRE and the QA bot on Anthropic — Max. ' +
        'The second reviewer (irisexampleco) is proposed Grok 4.7 on xAI — subscription, which does not offer grok-4. ' +
        'The security reviewer has no OpenAI account — proposed Claude Opus 5 on Anthropic — Max; its second opinion then comes from the same provider as the lead reviewer. ' +
        'The automation bot has no model, and that is correct.',
    );
    expect(proposal.assignments.map((one) => one.bot)).not.toContain('automation');
  });

  it('switches the security reviewer to Claude when accepted, leaves the second reviewer on Grok, and that finishes the step', () => {
    const applied = saved(CREW, proposal);

    expect(applied.find((one) => one.bot === 'security-reviewer')).toMatchObject({ engine: 'claude', model: 'claude-opus-5' });
    expect(applied.find((one) => one.bot === 'irisexampleco')).toMatchObject({
      engine: 'grok',
      model: 'grok-4.7',
      modelAccountId: 'acct-supergrok',
    });
    expect(assignmentStepDone([MAX, SUPERGROK], applied)).toBe(true);
  });

  it('proposes no Fable, though the seat lists it', () => {
    const proposed = proposal.assignments.map((one) => one.model);

    expect(proposed.some((model) => model.startsWith('claude-fable'))).toBe(false);
    // A bot set to an Opus the seat does not have gets the Opus the proposal names.
    const older = propose([MAX], [bot({ bot: 'system-engineer', model: 'claude-opus-4-1' })], LISTINGS);
    expect(older?.assignments[0]).toMatchObject({ model: 'claude-opus-5', substitution: { kind: 'model' } });
    // Chosen on purpose, they stay chosen.
    const chosen = propose([MAX], [bot({ bot: 'system-engineer', model: 'claude-fable-5' })], LISTINGS);
    expect(chosen?.assignments[0]).toEqual({ bot: 'system-engineer', accountId: 'acct-max', model: 'claude-fable-5', engine: 'claude' });
  });
});

describe('what the proposal picks, account by account', () => {
  const SUPERGROK_MODELS: ListedModel[] = [
    { id: 'grok-4.7', createdAt: null, isDefault: true },
    { id: 'grok-4.7-build-fast', createdAt: null, isDefault: false },
    { id: 'grok-4.6', createdAt: null, isDefault: false },
  ];

  it('counts an id listed with its release date after it as offered, under the name it was given, and nothing looser', () => {
    const dated = listing([{ id: 'claude-haiku-4-5-20251001', createdAt: null }]);

    // The undated name the configuration uses, not a date the operator never chose.
    expect(offeredAs(dated, 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(offeredAs(listing([{ id: 'claude-haiku-4-5', createdAt: null }, ...dated.models]), 'claude-haiku-4-5')).toBe(
      'claude-haiku-4-5',
    );
    expect(offeredAs(listing([]), 'gpt-5-codex')).toBe('gpt-5-codex');
    expect(offers(dated, 'claude-haiku-4-5')).toBe(true);
    expect(offers(dated, 'claude-haiku-4')).toBe(false);
    expect(offers(listing([{ id: 'claude-opus-5-5', createdAt: null }]), 'claude-opus-5')).toBe(false);
    expect(offers(listing(SUPERGROK_MODELS), 'grok-4')).toBe(false);
    // Nothing listed is nothing to refuse against: the bridge asks the CLI for the id.
    expect(offers(listing([]), 'gpt-5-codex')).toBe(true);
  });

  it('keeps a family only on an account that says it can follow it', () => {
    expect(offers(listing(ANTHROPIC, CLAUDE_FAMILIES), 'newest:opus')).toBe(true);
    expect(offers(listing(ANTHROPIC), 'newest:opus')).toBe(false);
    expect(offers(listing([]), 'newest:codex')).toBe(false);
  });

  it('reads how deep a bot thinks from the model it was set to, and from a second opinion’s role', () => {
    expect(tierOf({ model: 'claude-opus-5' })).toBe('deep');
    expect(tierOf({ model: 'newest:opus' })).toBe('deep');
    expect(tierOf({ model: 'claude-sonnet-5' })).toBe('standard');
    expect(tierOf({ model: 'claude-haiku-4-5' })).toBe('fast');
    expect(tierOf({ model: 'grok-4.7-build-fast' })).toBe('fast');
    expect(tierOf({ model: 'gpt-5-codex', role: 'review_security' })).toBe('deep');
    expect(tierOf({ model: 'grok-4', role: 'review_second' })).toBe('deep');
    expect(tierOf({ model: 'gpt-5-codex', role: 'implement' })).toBe('standard');
  });

  it('names a model for each depth on each provider, from what the account offers', () => {
    const grok = listing(SUPERGROK_MODELS);

    expect(modelFor('anthropic', 'deep', listing(ANTHROPIC))).toBe('claude-opus-5');
    expect(modelFor('anthropic', 'fast', listing([{ id: 'claude-haiku-4-5-20251001', createdAt: null }]))).toBe(
      'claude-haiku-4-5',
    );
    // An account without the Opus the proposal names: its newest Opus.
    expect(
      modelFor(
        'anthropic',
        'deep',
        listing([
          { id: 'claude-opus-5-5', createdAt: '2026-08-20' },
          { id: 'claude-opus-4-8', createdAt: '2026-01-15' },
        ]),
      ),
    ).toBe('claude-opus-5-5');
    expect(modelFor('openai', 'fast', listing([]))).toBe('gpt-5-codex');
    expect(modelFor('xai', 'deep', grok)).toBe('grok-4.7');
    expect(modelFor('xai', 'standard', grok)).toBe('grok-4.7');
    expect(modelFor('xai', 'fast', grok)).toBe('grok-4.7-build-fast');
    expect(modelFor('xai', 'fast', listing([{ id: 'grok-4.7', createdAt: null, isDefault: true }]))).toBe('grok-4.7');
    // The seat's own default, even when it lists something newer.
    const olderDefault = listing([
      { id: 'grok-4.7', createdAt: null, isDefault: false },
      { id: 'grok-4.6', createdAt: null, isDefault: true },
    ]);
    expect(modelFor('xai', 'deep', olderDefault)).toBe('grok-4.6');
    // A grok id is not guessed for a seat that listed nothing.
    expect(modelFor('xai', 'deep', listing([]))).toBeNull();
  });

  it('proposes Opus 5.5 to a deep bot on an account without Opus 5, and never Fable', () => {
    // Opus 5.5 is priced below Opus 5 (packages/engines/src/pricing.ts); passing
    // it over sent such an account to an older, dearer Opus.
    const seat = account({ verifiedAt: VERIFIED_AT });
    const listed = listing([
      { id: 'claude-opus-5-5-20260820', createdAt: '2026-08-20' },
      { id: 'claude-fable-5-1', createdAt: '2026-08-06' },
      { id: 'claude-opus-4-8', createdAt: '2026-01-15' },
    ]);

    expect(modelFor('anthropic', 'deep', listed)).toBe('claude-opus-5-5-20260820');
    const proposal = propose([seat], [bot({ bot: 'system-engineer', model: 'claude-opus-5' })], { [seat.id]: listed });
    expect(proposal?.assignments[0]).toMatchObject({ model: 'claude-opus-5-5-20260820' });
    expect(proposable('claude-opus-5-5')).toBe(true);
    expect(proposable('claude-opus-5-5-20260820')).toBe(true);
    expect(proposable('claude-fable-5')).toBe(false);
    expect(proposable('claude-fable-5-1')).toBe(false);
  });

  it('keeps a second opinion off the lead reviewer’s provider when a provider is free', () => {
    const anthropic = account();
    const xai = account({ id: 'acct-xai', provider: 'xai', kind: 'key', label: 'xAI — API key' });
    const proposal = propose(
      [anthropic, xai],
      [
        bot({ bot: 'lead-reviewer', role: 'review_lead', model: 'claude-opus-5' }),
        bot({ bot: 'second-reviewer', role: 'review_second', model: 'claude-opus-5' }),
        bot({ bot: 'security-reviewer', role: 'review_security', engine: 'codex', model: 'gpt-5-codex' }),
      ],
      { 'acct-xai': listing(SUPERGROK_MODELS, ['newest:grok']) },
    );

    expect(proposal?.assignments.find((one) => one.bot === 'security-reviewer')).toMatchObject({
      accountId: 'acct-xai',
      model: 'grok-4.7',
      engine: 'grok',
      substitution: { lead: 'moved' },
    });
    expect(proposal?.sentence).toContain(
      'The security reviewer has no OpenAI account — proposed Grok 4.7 on xAI — API key, so its opinion is independent of the lead reviewer’s.',
    );
  });

  it('otherwise prefers Anthropic, then OpenAI, then xAI', () => {
    const openai = account({ id: 'acct-openai', provider: 'openai', kind: 'key', label: 'OpenAI — API key' });
    const xai = account({ id: 'acct-xai', provider: 'xai', kind: 'key', label: 'xAI — API key' });
    const listings = { 'acct-xai': listing(SUPERGROK_MODELS, ['newest:grok']) };
    const crew = [bot({ bot: 'intake', model: 'claude-haiku-4-5' }), bot({ bot: 'builder', model: 'claude-sonnet-5' })];

    expect(propose([xai, openai], crew, listings)?.assignments.map((one) => [one.bot, one.model, one.engine])).toEqual([
      ['intake', 'gpt-5-codex', 'codex'],
      ['builder', 'gpt-5-codex', 'codex'],
    ]);
    expect(propose([xai], crew, listings)?.assignments.map((one) => [one.bot, one.model, one.engine])).toEqual([
      ['intake', 'grok-4.7-build-fast', 'grok'],
      ['builder', 'grok-4.7', 'grok'],
    ]);
    expect(propose([xai], crew, listings)?.sentence).toBe(
      'The intake bot has no Anthropic account — proposed Grok 4.7 build-fast on xAI — API key. The builder has no Anthropic account — proposed Grok 4.7 on xAI — API key.',
    );
  });

  it('proposes an OpenAI seat that lists nothing the id it was set to, and gpt-5-codex for a family', () => {
    const seat = account({ id: 'acct-pro', provider: 'openai', kind: 'subscription', label: 'ChatGPT Pro', verifiedAt: VERIFIED_AT });
    const listings = { 'acct-pro': listing([]) };

    expect(
      propose([seat], [bot({ bot: 'security-reviewer', role: 'review_security', engine: 'codex', model: 'gpt-5-codex' })], listings)
        ?.assignments,
    ).toEqual([{ bot: 'security-reviewer', accountId: 'acct-pro', model: 'gpt-5-codex', engine: 'codex' }]);
    expect(
      propose([seat], [bot({ bot: 'security-reviewer', role: 'review_security', engine: 'codex', model: 'newest:codex' })], listings)
        ?.sentence,
    ).toBe('The security reviewer is proposed GPT-5 Codex on ChatGPT Pro, which cannot follow Newest Codex.');
  });

  it('proposes nothing on an account that could not be listed, and says which bots wait for it', () => {
    // Proposed unchecked, grok-4 was accepted and then refused at the first task:
    // the seat's list, had it answered, does not have it.
    const seat = account({ id: 'acct-xai', provider: 'xai', kind: 'subscription', label: 'xAI — subscription', verifiedAt: VERIFIED_AT });
    const failed = { 'acct-xai': listing([], [], 'grok models: connection reset') };

    const proposal = propose([seat], [bot({ bot: 'second-reviewer', role: 'review_second', engine: 'grok', model: 'grok-4' })], failed);
    expect(proposal?.assignments).toEqual([]);
    expect(proposal?.sentence).toBe(
      'xAI — subscription could not list its models, so nothing is proposed for the second reviewer yet.',
    );

    const stranded = propose([seat], [bot({ bot: 'builder', model: 'claude-sonnet-5' })], failed);
    expect(stranded?.assignments).toEqual([]);
    expect(stranded?.sentence).toBe(
      'xAI — subscription could not list its models, so nothing is proposed on it yet. Nothing verified can take the builder yet.',
    );
  });

  it('keeps a bot waiting for its own provider’s listing, rather than moving it elsewhere', () => {
    const anthropic = account();
    const seat = account({ id: 'acct-xai', provider: 'xai', kind: 'subscription', label: 'xAI — subscription', verifiedAt: VERIFIED_AT });
    const proposal = propose(
      [anthropic, seat],
      [
        bot({ bot: 'lead-reviewer', role: 'review_lead', model: 'claude-opus-5' }),
        bot({ bot: 'second-reviewer', role: 'review_second', engine: 'grok', model: 'grok-4' }),
        bot({ bot: 'security-reviewer', role: 'review_security', engine: 'codex', model: 'gpt-5-codex' }),
      ],
      { 'acct-xai': listing([], [], 'grok models: connection reset') },
    );

    expect(proposal?.assignments.map((one) => [one.bot, one.accountId, one.model])).toEqual([
      ['lead-reviewer', 'acct-anthropic', 'claude-opus-5'],
      ['security-reviewer', 'acct-anthropic', 'claude-opus-5'],
    ]);
    expect(proposal?.sentence).toBe(
      'Put the lead reviewer on Anthropic — Max. ' +
        'The security reviewer has no OpenAI account — proposed Claude Opus 5 on Anthropic — Max; its second opinion then comes from the same provider as the lead reviewer. ' +
        'xAI — subscription could not list its models, so nothing is proposed for the second reviewer yet.',
    );
  });
});

describe('a bot’s row', () => {
  const LISTINGS = {
    'acct-max': listing(ANTHROPIC, CLAUDE_FAMILIES),
    'acct-supergrok': listing(
      [
        { id: 'grok-4.7', createdAt: null, isDefault: true },
        { id: 'grok-4.7-build-fast', createdAt: null, isDefault: false },
        { id: 'grok-4.6', createdAt: null, isDefault: false },
      ],
      ['newest:grok'],
    ),
    'acct-pro': listing([]),
  };

  it('marks the account’s default and the proposal, after the families it can follow', () => {
    expect(modelChoices(LISTINGS['acct-supergrok'], 'grok-4', 'grok-4.7').map((one) => one.label)).toEqual([
      'Newest Grok',
      'grok-4.7 · default · proposed',
      'grok-4.7-build-fast',
      'grok-4.6',
      'grok-4',
    ]);
    expect(modelChoices(LISTINGS['acct-max'], 'claude-haiku-4-5', 'claude-haiku-4-5').at(-1)?.label).toBe(
      'claude-haiku-4-5 · proposed',
    );
  });

  it('says a model the way a person does', () => {
    expect(modelName('claude-opus-5')).toBe('Claude Opus 5');
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5');
    expect(modelName('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelName('grok-4.7')).toBe('Grok 4.7');
    expect(modelName('grok-4.7-build-fast')).toBe('Grok 4.7 build-fast');
    expect(modelName('gpt-5-codex')).toBe('GPT-5 Codex');
    expect(modelName('newest:opus')).toBe('Newest Opus');
    expect(modelName('o3-pro')).toBe('o3-pro');
  });
});

describe('the model picker', () => {
  it('offers Newest Opus and says what that is today', () => {
    const options = modelChoices(listing(ANTHROPIC, CLAUDE_FAMILIES), 'claude-sonnet-5');
    expect(options.find((option) => option.value === 'newest:opus')).toEqual({
      value: 'newest:opus',
      label: 'Newest Opus · claude-opus-5 right now',
      resolvesTo: 'claude-opus-5',
    });
    expect(options.find((option) => option.value === 'newest:sonnet')?.label).toBe(
      'Newest Sonnet · claude-sonnet-5 right now',
    );
    expect(options.find((option) => option.value === 'newest:haiku')?.resolvesTo).toBe('claude-haiku-4-5');
  });

  it('lists the concrete ids newest first', () => {
    const concrete = modelChoices(listing(ANTHROPIC, CLAUDE_FAMILIES), 'claude-sonnet-5')
      .map((option) => option.value)
      .filter((value) => !value.startsWith('newest:'));
    expect(concrete).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5']);
    expect(newestId('opus', ANTHROPIC)).toBe('claude-opus-5');
  });

  it('says the family follows its base model, as the runtime does, not the mini dated after it', () => {
    // `newestIn` in the engines package skips the variants; a 'right now'
    // that named the mini would show a model the runtime does not call.
    const codex = [
      { id: 'gpt-5.1-codex', createdAt: '2026-08-01' },
      { id: 'gpt-5.1-codex-mini', createdAt: '2026-09-01' },
    ];
    expect(newestId('codex', codex)).toBe('gpt-5.1-codex');
    expect(newestId('codex-mini', codex)).toBe('gpt-5.1-codex-mini');
    expect(newestId('codex', codex.slice(1))).toBe('gpt-5.1-codex-mini');
    expect(
      newestId('grok', [
        { id: 'grok-4.7', createdAt: '2026-08-01' },
        { id: 'grok-4.7-fast-non-reasoning', createdAt: '2026-09-01' },
        { id: 'grok-code-fast-2', createdAt: '2026-09-02' },
      ]),
    ).toBe('grok-4.7');
  });

  it('keeps an undated list in the order the account gave it, rather than by id', () => {
    const undated = listing(
      ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'].map((id) => ({
        id,
        createdAt: null,
      })),
    );

    expect(modelChoices(undated, 'claude-opus-5').map((option) => option.value)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('keeps a stored choice visible when the catalogue cannot list it', () => {
    const options = modelChoices(listing([], CLAUDE_FAMILIES), 'claude-opus-5');
    expect(options.map((option) => option.value)).toContain('newest:opus');
    expect(options.find((option) => option.value === 'newest:opus')?.resolvesTo).toBeNull();
    expect(options.map((option) => option.value)).toContain('claude-opus-5');
  });

  it('says what a family is today only from a dated list', () => {
    // By id alone the newest grok would be grok-4.7-build-fast, which is not what the seat runs.
    const undated = listing(
      [
        { id: 'grok-4.7', createdAt: null, isDefault: true },
        { id: 'grok-4.7-build-fast', createdAt: null },
      ],
      ['newest:grok'],
    );
    expect(modelChoices(undated, 'grok-4.7')[0]).toEqual({ value: 'newest:grok', label: 'Newest Grok', resolvesTo: null });
  });

  it('keeps what a bot is on in view when the account lists it with its release date, and marks the listed one', () => {
    const dated = listing([{ id: 'claude-haiku-4-5-20251001', createdAt: '2025-10-01' }], ['newest:haiku']);
    const options = modelChoices(dated, 'claude-haiku-4-5', 'claude-haiku-4-5-20251001');

    expect(options).toEqual([
      { value: 'newest:haiku', label: 'Newest Haiku · claude-haiku-4-5-20251001 right now', resolvesTo: 'claude-haiku-4-5-20251001' },
      { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001 · proposed', resolvesTo: null },
      { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5', resolvesTo: null },
    ]);
  });

  it('puts a dated snapshot after the name it pins, and Newest Codex before them all', () => {
    // As OpenAI dates them: the snapshot a minute after its name.
    const openai = listing(
      [
        { id: 'gpt-5-2025-08-07', createdAt: '2025-08-05T20:31:07.000Z' },
        { id: 'gpt-5', createdAt: '2025-08-05T20:29:37.000Z' },
        { id: 'gpt-5-mini', createdAt: '2025-08-05T20:32:08.000Z' },
        { id: 'gpt-5-codex', createdAt: '2025-09-10T18:10:18.000Z' },
        { id: 'gpt-4o', createdAt: '2024-05-10T20:10:49.000Z' },
        { id: 'gpt-4o-2024-08-06', createdAt: '2024-08-04T00:00:00.000Z' },
      ],
      ['newest:codex'],
    );

    expect(modelChoices(openai, 'newest:codex').map((option) => option.value)).toEqual([
      'newest:codex',
      'gpt-5-codex',
      'gpt-5-mini',
      'gpt-5',
      'gpt-5-2025-08-07',
      'gpt-4o',
      'gpt-4o-2024-08-06',
    ]);
  });

  it('leaves a snapshot by its date when its name is not listed', () => {
    const dated = listing([
      { id: 'claude-sonnet-5', createdAt: '2026-03-01' },
      { id: 'claude-haiku-4-5-20251001', createdAt: '2025-10-01' },
    ]);
    expect(modelChoices(dated, 'claude-sonnet-5').map((option) => option.value)).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('keeps a model a bot cannot run in view, and says so, rather than switching it', () => {
    const openai = listing([{ id: 'gpt-5-codex', createdAt: '2025-09-10T18:10:18.000Z' }], ['newest:codex']);

    expect(modelChoices(openai, 'tts-1').at(-1)).toEqual({
      value: 'tts-1',
      label: 'tts-1 · not offered for bots',
      resolvesTo: null,
    });
    // Not listed, and still a model a bot can run: said as it is, as before.
    expect(modelChoices(openai, 'gpt-5.1-codex').at(-1)?.label).toBe('gpt-5.1-codex');
  });

  it('tells a model a bot can run from one it cannot, by family', () => {
    for (const id of ['gpt-5-codex', 'gpt-5', 'o3', 'codex-mini-latest', 'grok-4.7', 'claude-opus-5']) {
      expect(botCanRun(id)).toBe(true);
    }
    for (const id of ['tts-1', 'gpt-image-1', 'gpt-4o-mini-tts', 'gpt-5-search-api', 'sora-2', 'grok-2-image-1212', 'davinci-002', 'chatgpt-4o-latest']) {
      expect(botCanRun(id)).toBe(false);
    }
  });

  it('matches the engines allowlist on the same ids', () => {
    // The console cannot import @fleetadlc/engines: that barrel pulls the CLIs into
    // the client bundle, so this rule is copied. A model the engines copy drops
    // then stays unlabelled in the picker. One list through both copies fails
    // when only one of them changes.
    const ids: { provider: ModelProvider; id: string }[] = [
      { provider: 'openai', id: 'gpt-5' },
      { provider: 'openai', id: 'gpt-5-mini' },
      { provider: 'openai', id: 'gpt-5-2025-08-07' },
      { provider: 'openai', id: 'gpt-4o' },
      { provider: 'openai', id: 'gpt-4o-mini' },
      { provider: 'openai', id: 'gpt-3.5-turbo' },
      { provider: 'openai', id: 'chatgpt-4o-latest' },
      { provider: 'openai', id: 'o3' },
      { provider: 'openai', id: 'o3-pro' },
      { provider: 'openai', id: 'o4-mini' },
      { provider: 'openai', id: 'gpt-5-codex' },
      { provider: 'openai', id: 'codex-mini-latest' },
      { provider: 'openai', id: 'ft:gpt-4o:acme:support:abc' },
      { provider: 'openai', id: 'ft:gpt-4o-mini:org::id' },
      { provider: 'openai', id: 'gpt-4o-audio' },
      { provider: 'openai', id: 'gpt-4o-realtime' },
      { provider: 'openai', id: 'gpt-4o-transcribe' },
      { provider: 'openai', id: 'gpt-4o-mini-tts' },
      { provider: 'openai', id: 'gpt-4o-image' },
      { provider: 'openai', id: 'gpt-4o-search-preview' },
      { provider: 'openai', id: 'gpt-5-search-api' },
      { provider: 'openai', id: 'gpt-3.5-turbo-instruct' },
      { provider: 'openai', id: 'gpt-4o-embedding' },
      { provider: 'openai', id: 'gpt-4o-moderation' },
      { provider: 'openai', id: 'o3-deep-research' },
      { provider: 'openai', id: 'tts-1' },
      { provider: 'openai', id: 'gpt-image-1' },
      { provider: 'openai', id: 'sora-2' },
      { provider: 'openai', id: 'davinci-002' },
      { provider: 'xai', id: 'grok-4' },
      { provider: 'xai', id: 'grok-4.7' },
      { provider: 'xai', id: 'grok-4-fast-non-reasoning' },
      { provider: 'xai', id: 'grok-code' },
      { provider: 'xai', id: 'grok-2-image-1212' },
      { provider: 'xai', id: 'grok-2-imagine' },
      { provider: 'xai', id: 'grok-2-video' },
      { provider: 'xai', id: 'grok-imagine-video' },
      { provider: 'xai', id: 'grok-codex' },
      { provider: 'xai', id: 'grok-2-image-codex' },
      { provider: 'anthropic', id: 'claude-opus-5' },
      { provider: 'anthropic', id: 'claude-sonnet-4-5' },
    ];
    const drifted = ids.filter(({ provider, id }) => botCanRun(id) !== engineCanRun(provider, id)).map((one) => one.id);
    expect(drifted).toEqual([]);
  });
});

describe('coming back', () => {
  const CHECKED = '2026-09-24T08:05:00.000Z';

  it('treats the accounts step as done once one account is verified, not once one is stored', () => {
    const seat = account({ kind: 'subscription' });

    expect(accountsStepDone([])).toBe(false);
    // Stored and never checked: this used to count, and the walkthrough moved on from it.
    expect(accountsStepDone([seat])).toBe(false);
    expect(accountsStepDone([{ ...seat, verifiedAt: CHECKED, verifyError: 'Invalid bearer token' }])).toBe(false);
    expect(accountsStepDone([seat, { ...seat, id: 'acct-two', verifiedAt: CHECKED, verifyError: null }])).toBe(true);
    // A key was proved on the way in, by listing models.
    expect(accountsStepDone([account({ kind: 'key' })])).toBe(true);
  });

  it('agrees with the panel about a seat whose command is missing where the bots run', () => {
    const seat = account({ kind: 'subscription', verifiedAt: CHECKED, verifyError: null });
    const crew = [bot({ bot: 'builder', readiness: NO_CLAUDE })];

    expect(accountStanding(seat, crew).verified).toBe(false);
    expect(accountsStepDone([seat], crew)).toBe(false);
    expect(accountsStepDone([seat], [])).toBe(true);
  });

  it('leaves the assignment step to its own fact: bots on a seat not verified yet are still assigned', () => {
    const seat = account({ kind: 'subscription' });
    const crew = [bot({ bot: 'builder', modelAccountId: seat.id })];

    expect(accountsStepDone([seat])).toBe(false);
    expect(assignmentStepDone([seat], crew)).toBe(true);
    expect(assignmentStepDone([], crew)).toBe(false);
  });

  it('reads the assignment off the bots, so the form is not blank', () => {
    const anthropic = account();
    const crew = [
      bot({ bot: 'builder', model: 'newest:opus', modelAccountId: anthropic.id }),
      bot({ bot: 'automation', engine: 'none', model: 'none', roleLabel: 'automation' }),
    ];
    expect(assignmentStepDone([anthropic], crew)).toBe(true);
    expect(draftFor(crew[0]!, undefined, null)).toEqual({ accountId: anthropic.id, model: 'newest:opus' });
    const again = modelChoices(listing(ANTHROPIC, CLAUDE_FAMILIES), 'newest:opus');
    expect(again.find((option) => option.value === 'newest:opus')?.label).toContain('claude-opus-5 right now');
  });
});

function readiness(partial: Partial<Readiness> = {}): Readiness {
  return {
    ready: true,
    confidence: 'certain',
    detail: '`claude` is here and has a key',
    remedy: '',
    keySource: null,
    hasKey: true,
    needsCommand: 'claude',
    hasCommand: true,
    ...partial,
  };
}

const NO_CLAUDE = readiness({
  ready: false,
  detail: 'the `claude` command is not on this host',
  remedy: 'install claude on the host — a key alone will not do, this engine runs as a command',
  hasCommand: false,
});

describe('a floating family, and an account that can follow it', () => {
  it('offers a family only where the account lists it', () => {
    // An OpenAI seat lists nothing: a family there would be saved and then fail every task.
    const values = modelChoices(listing([]), 'gpt-5-codex').map((option) => option.value);

    expect(values).toEqual(['gpt-5-codex']);
    expect(modelChoices(listing(ANTHROPIC, CLAUDE_FAMILIES), 'claude-opus-5').map((option) => option.value)).toContain(
      'newest:opus',
    );
  });

  it('keeps a family on a Claude seat that lists it', () => {
    // A seat used to be refused every family, and the bot was left out of the proposal.
    const seat = account({ id: 'acct-seat', kind: 'subscription', label: 'Anthropic — Max', verifiedAt: VERIFIED_AT });
    const proposal = propose([seat], [bot({ bot: 'builder', model: 'newest:opus' }), bot({ bot: 'system-engineer' })], {
      'acct-seat': listing(ANTHROPIC, CLAUDE_FAMILIES),
    });

    expect(proposal?.assignments).toEqual([
      { bot: 'builder', accountId: 'acct-seat', model: 'newest:opus', engine: 'claude' },
      { bot: 'system-engineer', accountId: 'acct-seat', model: 'claude-sonnet-5', engine: 'claude' },
    ]);
    expect(proposal?.sentence).toBe('Put all two thinking bots on Anthropic — Max.');
  });

  it('puts a bot that follows a family on the account of its provider that can follow it', () => {
    const seat = account({ id: 'acct-seat', kind: 'subscription', label: 'Anthropic — Max', verifiedAt: VERIFIED_AT });
    const key = account({ id: 'acct-key', kind: 'key', label: 'Anthropic — API key' });
    const proposal = propose([seat, key], [bot({ bot: 'builder', model: 'newest:opus' }), bot({ bot: 'system-engineer' })], {
      'acct-seat': listing(ANTHROPIC),
      'acct-key': listing(ANTHROPIC, CLAUDE_FAMILIES),
    });

    expect(proposal?.assignments).toEqual([
      { bot: 'builder', accountId: 'acct-key', model: 'newest:opus', engine: 'claude' },
      { bot: 'system-engineer', accountId: 'acct-seat', model: 'claude-sonnet-5', engine: 'claude' },
    ]);
  });

  it('pins what the family means where it cannot be followed, and says so', () => {
    const seat = account({ kind: 'subscription', label: 'Anthropic — Max', verifiedAt: VERIFIED_AT });
    const proposal = propose([seat], [bot({ bot: 'builder', model: 'newest:opus' }), bot({ bot: 'system-engineer' })], {
      [seat.id]: listing(ANTHROPIC),
    });

    expect(proposal?.assignments).toEqual([
      {
        bot: 'builder',
        accountId: seat.id,
        model: 'claude-opus-5',
        engine: 'claude',
        substitution: { kind: 'model', configured: 'newest:opus' },
      },
      { bot: 'system-engineer', accountId: seat.id, model: 'claude-sonnet-5', engine: 'claude' },
    ]);
    expect(proposal?.sentence).toBe(
      'Put the system engineer on Anthropic — Max. The builder is proposed Claude Opus 5 on Anthropic — Max, which cannot follow Newest Opus.',
    );
  });
});

describe('what the probe says, on the assignment step', () => {
  it('is not done while an assigned bot cannot run', () => {
    // The engines step this replaced held the walkthrough here. A tick over a
    // bot whose command is missing says the crew can think when it cannot.
    const anthropic = account();
    const stuck = [bot({ bot: 'builder', modelAccountId: anthropic.id, readiness: NO_CLAUDE })];
    const fine = [bot({ bot: 'builder', modelAccountId: anthropic.id, readiness: readiness() })];
    const unasked = [bot({ bot: 'builder', modelAccountId: anthropic.id, readiness: null })];

    expect(assignmentStepDone([anthropic], stuck)).toBe(false);
    expect(assignmentStepDone([anthropic], fine)).toBe(true);
    expect(assignmentStepDone([anthropic], unasked)).toBe(true);
  });
});

describe('what an account step says about a subscription', () => {
  const seat = account({ id: 'acct-seat', kind: 'subscription' });

  it('is a tilde until something has checked it, whatever a bot on another account shows', () => {
    // The system engineer's tick comes from its own key account and proves nothing here.
    const crew = [bot({ bot: 'system-engineer', modelAccountId: 'acct-key', readiness: readiness() })];

    expect(accountMark(seat, crew)).toEqual({ mark: '~', detail: null });
    expect(accountMark({ ...seat, verifiedAt: null, verifyError: null }, [])).toEqual({ mark: '~', detail: null });
  });

  it('is a tick with when, once the CLI answered through it', () => {
    expect(accountMark({ ...seat, verifiedAt: '2026-09-24T08:05:00.000Z', verifyError: null }, [])).toEqual({
      mark: '✓',
      detail: 'verified 24 Sep 2026, 08:05 UTC',
    });
  });

  it('is a cross in the CLI’s own words when it did not', () => {
    expect(
      accountMark({ ...seat, verifiedAt: '2026-09-24T08:05:00.000Z', verifyError: 'Not logged in · Please run /login' }, []),
    ).toEqual({ mark: '×', detail: 'Not logged in · Please run /login' });
  });

  it('is a cross when the command it thinks with is not on the host, whatever a check once said', () => {
    const crew = [bot({ bot: 'system-engineer', modelAccountId: 'acct-key', readiness: NO_CLAUDE })];

    expect(accountMark({ ...seat, verifiedAt: '2026-09-24T08:05:00.000Z' }, crew)).toEqual({
      mark: '×',
      detail: 'the `claude` command is not on this host',
    });
    expect(accountMark(account({ provider: 'openai', kind: 'subscription' }), crew).mark).toBe('~');
  });

  it('says when in the same words on the server and in the browser', () => {
    expect(checkedWhen('2026-01-02T03:04:05.000Z')).toBe('2 Jan 2026, 03:04 UTC');
    expect(checkedWhen('not a date')).toBe('');
  });

  it('ends a line as a sentence once, whatever the CLI ended it with', () => {
    expect(asSentence('the `claude` command is not on this host')).toBe('the `claude` command is not on this host.');
    expect(asSentence('OAuth access token is invalid.')).toBe('OAuth access token is invalid.');
  });
});

describe('a subscription’s credential', () => {
  const TOKEN = 'sk-ant-oat01-Zm9vYmFyYmF6cXV4LXRoZS10b2tlbg';

  it('is a token for a Claude seat and a sign-in for an OpenAI or xAI one', () => {
    expect(subscriptionCredential({ provider: 'anthropic', kind: 'subscription' })).toBe('token');
    expect(subscriptionCredential({ provider: 'openai', kind: 'subscription' })).toBe('sign-in');
    expect(subscriptionCredential({ provider: 'xai', kind: 'subscription' })).toBe('sign-in');
    expect(subscriptionCredential({ provider: 'openai', kind: 'key' })).toBeNull();
  });

  it('sends a Claude seat’s token with the account, from its own field and nothing else', () => {
    expect(
      accountRequestBody({ provider: 'anthropic', kind: 'subscription', label: 'Max', key: 'sk-stale', token: ` ${TOKEN}\n` }),
    ).toEqual({ provider: 'anthropic', kind: 'subscription', label: 'Max', key: TOKEN });
    expect(accountRequestBody({ provider: 'openai', kind: 'subscription', label: 'Pro', token: TOKEN })).toEqual({
      provider: 'openai',
      kind: 'subscription',
      label: 'Pro',
    });
    expect(accountRequestBody({ provider: 'anthropic', kind: 'key', label: 'API', key: 'sk-ant-api03-x', token: TOKEN })).toEqual({
      provider: 'anthropic',
      kind: 'key',
      label: 'API',
      key: 'sk-ant-api03-x',
    });
  });

  it('names the mistakes worth naming before a token is sent', () => {
    expect(setupTokenProblem('')).toBeNull();
    expect(setupTokenProblem(TOKEN)).toBeNull();
    expect(setupTokenProblem(`${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)}`)).toMatch(/line break/);
    expect(setupTokenProblem('sk-ant-api03-an-api-key')).toMatch(/start with sk-ant-oat/);
  });

  it('says what to run, where, and what saving does, in the words the step shows', () => {
    expect(SETUP_TOKEN_COMMAND).toBe('claude setup-token');
    expect(SETUP_TOKEN_HOW).toBe(
      'Run it in a terminal on a machine signed in to this Claude subscription. It opens the browser to approve, then prints a token.',
    );
    expect(TOKEN_SAVE_COPY).toContain('checks it straight away');
    expect(TOKEN_SAVE_COPY).toContain('one tiny prompt');
    expect(SIGN_IN_COPY).toContain('every bot on this account uses that login');
    expect(SIGN_IN_WAITING_COPY).toBe('waiting for you to finish in the browser…');
    expect(NOT_VERIFIED_COPY).toBe('not verified yet');
  });

  it('is given again the way it was given: a token, a sign-in, or a key', () => {
    expect(credentialOf({ provider: 'anthropic', kind: 'subscription' })).toBe('token');
    expect(credentialOf({ provider: 'xai', kind: 'subscription' })).toBe('sign-in');
    expect(credentialOf({ provider: 'anthropic', kind: 'key' })).toBe('key');
  });
});

describe('which side of the accounts step an account is on', () => {
  const CHECKED = '2026-09-24T08:05:00.000Z';
  const claude = account({ id: 'acct-claude', kind: 'subscription' });
  const grok = account({ id: 'acct-grok', provider: 'xai', kind: 'subscription', label: 'SuperGrok' });
  const key = account({ id: 'acct-key', kind: 'key', label: 'Anthropic — API key' });

  it('keeps a seat nothing has checked on the left, with its own next step and a tilde', () => {
    expect(accountStanding(claude, [])).toEqual({ verified: false, mark: '~', detail: null, next: 'token' });
    expect(accountStanding(grok, [])).toEqual({ verified: false, mark: '~', detail: null, next: 'sign-in' });
  });

  it('moves a seat the CLI answered through to the verified side, with when, and asks nothing more of it', () => {
    expect(accountStanding({ ...claude, verifiedAt: CHECKED, verifyError: null }, [])).toEqual({
      verified: true,
      mark: '✓',
      detail: 'verified 24 Sep 2026, 08:05 UTC',
      next: null,
    });
  });

  it('keeps a failed check on the left, with a cross, the CLI’s own words and the same next step', () => {
    expect(accountStanding({ ...claude, verifiedAt: CHECKED, verifyError: 'Invalid bearer token' }, [])).toEqual({
      verified: false,
      mark: '×',
      detail: 'Invalid bearer token',
      next: 'token',
    });
    expect(accountStanding({ ...grok, verifiedAt: CHECKED, verifyError: 'Not logged in' }, []).next).toBe('sign-in');
  });

  it('counts a key as verified on the way in, and says by whom, until a check says otherwise', () => {
    expect(accountStanding(key, [])).toEqual({
      verified: true,
      mark: '✓',
      detail: 'accepted by Anthropic when it was saved',
      next: null,
    });
    expect(keyAcceptedCopy('xai')).toBe('accepted by xAI when it was saved');
    expect(accountStanding({ ...key, verifiedAt: CHECKED, verifyError: null }, []).detail).toBe(
      'verified 24 Sep 2026, 08:05 UTC',
    );
    expect(accountStanding({ ...key, verifiedAt: CHECKED, verifyError: 'invalid x-api-key' }, [])).toMatchObject({
      verified: false,
      mark: '×',
      next: 'key',
    });
  });

  it('asks for the command, not the credential, when that is all a proved seat is missing', () => {
    const crew = [bot({ bot: 'builder', readiness: NO_CLAUDE })];

    expect(accountStanding({ ...claude, verifiedAt: CHECKED, verifyError: null }, crew)).toEqual({
      verified: false,
      mark: '×',
      detail: 'the `claude` command is not on this host',
      next: 'command',
    });
    expect(accountStanding(claude, crew).next).toBe('token');
    expect(accountStanding(grok, crew)).toMatchObject({ verified: false, mark: '~' });
  });

  it('says what an account is under its label', () => {
    expect(accountKindLine(claude)).toBe('Anthropic · subscription');
    expect(accountKindLine({ provider: 'openai', kind: 'key' })).toBe('OpenAI · API key');
  });

  it('tags a verified account with the bots on it, by handle or by role, and what OpenADLC holds for it', () => {
    const crew = [
      bot({ bot: 'janedoe-fleetadlc-builder', slot: 'builder', modelAccountId: 'acct-claude' }),
      bot({ bot: 'system-engineer', modelAccountId: 'acct-claude' }),
      bot({ bot: 'intake', modelAccountId: 'acct-key' }),
    ];

    expect(accountTags(claude, crew)).toEqual([
      {
        label: '2 bots on it',
        tone: 'signal',
        names: 'builder (janedoe-fleetadlc-builder), system engineer — not connected yet',
      },
      { label: 'token stored', tone: 'neutral' },
    ]);
    expect(accountTags(key, crew)).toEqual([
      { label: '1 bot on it', tone: 'signal', names: 'intake — not connected yet' },
      { label: 'key stored', tone: 'neutral' },
    ]);
    expect(accountTags(grok, crew)).toEqual([{ label: 'signed in', tone: 'neutral' }]);
  });
});

describe('a sign-in, from the console', () => {
  const WAITING: LoginState = {
    state: 'waiting',
    url: 'https://auth.openai.com/codex/device',
    code: 'URPK-DI1GG',
    startedAt: '2026-09-24T08:00:00.000Z',
  };

  function answer(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  /** A bridge that answers each status poll from `polls`, in turn, and a check with `check`. */
  function bridge(polls: (Response | Error)[], check: Response = answer(200, { ok: true, message: 'answered: OK', checkedAt: 'now' })) {
    const asked: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      asked.push(`${method} ${String(url)}`);
      if (method === 'POST' && String(url).endsWith('/verify')) return check;
      const next = polls.shift();
      if (!next) throw new Error('asked more often than the test said');
      if (next instanceof Error) throw next;
      return next;
    });
    return { asked, fetcher: fetcher as unknown as typeof fetch };
  }

  it('reads a waiting sign-in only when its link is an https link', () => {
    expect(loginStateFrom({ ...WAITING })).toEqual(WAITING);
    expect(loginStateFrom({ ...WAITING, url: 'javascript:alert(1)' })).toBeNull();
    expect(loginStateFrom({ ...WAITING, url: 'http://auth.openai.com/codex/device' })).toBeNull();
    expect(loginStateFrom({ ...WAITING, code: '' })).toBeNull();
    expect(loginStateFrom({ state: 'failed', message: 'declined' })).toEqual({ state: 'failed', message: 'declined' });
    expect(loginStateFrom({ state: 'signed-in' })).toEqual({ state: 'signed-in' });
    expect(loginStateFrom({ state: 'sure' })).toBeNull();
    expect(loginStateFrom(null)).toBeNull();
  });

  it('asks every three seconds until it is signed in, then verifies straight away', async () => {
    const { asked, fetcher } = bridge([answer(200, WAITING), answer(200, WAITING), answer(200, { state: 'signed-in' })]);
    const pause = vi.fn(async () => undefined);
    const states: string[] = [];
    const checks: { check: AccountCheck | null; error: string | null }[] = [];

    const last = await followSignIn(
      'acct-seat',
      WAITING,
      { state: (state) => states.push(state.state), check: (outcome) => checks.push(outcome) },
      { fetcher, pause },
    );

    expect(last).toEqual({ state: 'signed-in' });
    expect(states).toEqual(['waiting', 'waiting', 'waiting', 'signed-in']);
    expect(pause).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledWith(LOGIN_POLL_MS, undefined);
    expect(LOGIN_POLL_MS).toBe(3_000);
    expect(asked.filter((line) => line.startsWith('POST'))).toEqual(['POST /api/model-accounts/acct-seat/verify']);
    expect(checks).toEqual([{ check: { ok: true, message: 'answered: OK', checkedAt: 'now' }, error: null }]);
  });

  it('stops at a failure, in hostd’s words, and verifies nothing', async () => {
    const { asked, fetcher } = bridge([answer(200, { state: 'failed', message: 'the code was declined' })]);
    const check = vi.fn();

    const last = await followSignIn('acct-seat', WAITING, { state: () => undefined, check }, { fetcher, pause: async () => undefined });

    expect(last).toEqual({ state: 'failed', message: 'the code was declined' });
    expect(check).not.toHaveBeenCalled();
    expect(asked.some((line) => line.endsWith('/verify'))).toBe(false);
  });

  it('skips a poll nothing answered, rather than calling the sign-in failed', async () => {
    const { fetcher } = bridge([new TypeError('Failed to fetch'), answer(502, { error: 'bridge restarting' }), answer(200, { state: 'signed-in' })]);
    const states: string[] = [];

    const last = await followSignIn(
      'acct-seat',
      WAITING,
      { state: (state) => states.push(state.state), check: () => undefined },
      { fetcher, pause: async () => undefined },
    );

    expect(last.state).toBe('signed-in');
    expect(states).toEqual(['waiting', 'signed-in']);
  });

  it('ends on a refusal, in the bridge’s words, rather than waiting it out', async () => {
    const { fetcher } = bridge([answer(404, { error: 'no model account acct-seat' })]);
    const states: string[] = [];
    // Bounded, so a follow that kept waiting ends the test rather than hanging it.
    const controller = new AbortController();
    let paused = 0;

    const last = await followSignIn(
      'acct-seat',
      WAITING,
      { state: (state) => states.push(state.state), check: () => undefined },
      {
        fetcher,
        signal: controller.signal,
        pause: async () => {
          if (++paused > 3) controller.abort();
        },
      },
    );

    expect(last).toEqual({ state: 'failed', message: 'no model account acct-seat' });
    expect(states).toEqual(['waiting', 'failed']);
  });

  it('leaves no listener on the page’s signal behind a pause, and does not wait once it is aborted', async () => {
    vi.useFakeTimers();
    try {
      const { fetcher } = bridge([answer(200, WAITING), answer(200, WAITING), answer(200, { state: 'failed', message: 'declined' })]);
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, 'addEventListener');
      const removed = vi.spyOn(controller.signal, 'removeEventListener');

      const following = followSignIn('acct-seat', WAITING, { state: () => undefined, check: () => undefined }, { fetcher, signal: controller.signal });
      await vi.advanceTimersByTimeAsync(3 * 3_000);
      await following;
      expect(added).toHaveBeenCalledTimes(3);
      expect(removed).toHaveBeenCalledTimes(3);

      controller.abort();
      let returned = false;
      void followSignIn('acct-seat', WAITING, { state: () => undefined, check: () => undefined }, { fetcher, signal: controller.signal }).then(() => {
        returned = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(returned).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops asking when the page goes', async () => {
    const { asked, fetcher } = bridge([answer(200, WAITING)]);
    const controller = new AbortController();
    const check = vi.fn();

    await followSignIn(
      'acct-seat',
      WAITING,
      { state: () => undefined, check },
      {
        fetcher,
        signal: controller.signal,
        pause: async () => {
          controller.abort();
        },
      },
    );

    expect(asked).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });

  it('gives up on a sign-in nobody finished in time', async () => {
    const { fetcher } = bridge([answer(200, WAITING)]);
    let clock = 0;

    const last = await followSignIn(
      'acct-seat',
      WAITING,
      { state: () => undefined, check: () => undefined },
      {
        fetcher,
        now: () => clock,
        pause: async () => {
          clock += SIGN_IN_WINDOW_MS + 1;
        },
      },
    );

    expect(last).toMatchObject({ state: 'failed', message: expect.stringMatching(/not finished in time/) });
  });

  it('starts one on the account’s own route, and reports a refusal in the bridge’s words', async () => {
    const refused = vi.fn(async () => answer(400, { error: 'an API key account has nothing to sign in to' }));
    const started = vi.fn(async () => answer(200, WAITING));

    expect(await startSignIn('acct-key', refused as unknown as typeof fetch)).toEqual({
      state: 'failed',
      message: 'an API key account has nothing to sign in to',
    });
    expect(await startSignIn('acct-seat', started as unknown as typeof fetch)).toEqual(WAITING);
    expect(started).toHaveBeenCalledWith('/api/model-accounts/acct-seat/login', { method: 'POST' });
  });

  it('reports a check the bridge refused as an error to show, not a verdict', async () => {
    const refused = vi.fn(async () => answer(502, { error: 'hostd is not answering' }));

    expect(await verifyAccount('acct-seat', refused as unknown as typeof fetch)).toEqual({
      check: null,
      error: 'hostd is not answering',
    });
  });
});

describe('saving a Claude seat’s token', () => {
  const TOKEN = 'sk-ant-oat01-Zm9vYmFyYmF6cXV4LXRoZS10b2tlbg';
  const PASSED = { ok: true, message: 'answered: OK', checkedAt: '2026-09-24T08:05:00.000Z' };

  function answer(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  /** A bridge that answers each route from `routes`, and says which it was asked, in order. */
  function bridge(routes: Record<string, () => Response>) {
    const asked: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const line = `${init?.method ?? 'GET'} ${String(url)}`;
      asked.push(line);
      const route = routes[line];
      if (!route) throw new Error(`the test did not expect ${line}`);
      return route();
    });
    return { asked, fetcher: fetcher as unknown as typeof fetch };
  }

  it('posts it, trimmed, to the account’s key route and nowhere else', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));

    expect(await saveCredential('acct-seat', `${TOKEN}\n`, fetcher as unknown as typeof fetch)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/model-accounts/acct-seat/key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: TOKEN }),
    });
  });

  it('returns the bridge’s refusal, which says what a token looks like', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'a Claude subscription takes the token `claude setup-token` prints' }), {
          status: 400,
        }),
    );

    expect(await saveCredential('acct-seat', 'sk-ant-api03-x', fetcher as unknown as typeof fetch)).toContain(
      'claude setup-token',
    );
  });

  it('checks it straight away once it is saved, so there is no Verify to press', async () => {
    const { asked, fetcher } = bridge({
      'POST /api/model-accounts/acct-seat/key': () => answer(200, {}),
      'POST /api/model-accounts/acct-seat/verify': () => answer(200, PASSED),
    });
    const saved = vi.fn(() => asked.length);

    const outcome = await saveTokenAndVerify('acct-seat', TOKEN, { fetcher, saved });

    expect(asked).toEqual(['POST /api/model-accounts/acct-seat/key', 'POST /api/model-accounts/acct-seat/verify']);
    // Between the two, so the page can say it is verifying rather than saving.
    expect(saved).toHaveReturnedWith(1);
    expect(outcome).toEqual({ refused: null, check: PASSED, error: null });
  });

  it('checks nothing when the token is refused, and says why in the bridge’s words', async () => {
    const { asked, fetcher } = bridge({
      'POST /api/model-accounts/acct-seat/key': () => answer(400, { error: 'one line starting with sk-ant-oat' }),
    });

    expect(await saveTokenAndVerify('acct-seat', 'sk-ant-api03-x', { fetcher })).toEqual({
      refused: 'one line starting with sk-ant-oat',
      check: null,
      error: null,
    });
    expect(asked).toEqual(['POST /api/model-accounts/acct-seat/key']);
  });

  it('passes on a failed check as the check it was, for the step to show in the CLI’s words', async () => {
    const failed = { ok: false, message: 'Invalid bearer token', checkedAt: '2026-09-24T08:05:00.000Z' };
    const { fetcher } = bridge({
      'POST /api/model-accounts/acct-seat/key': () => answer(200, {}),
      'POST /api/model-accounts/acct-seat/verify': () => answer(200, failed),
    });

    expect(await saveTokenAndVerify('acct-seat', TOKEN, { fetcher })).toEqual({ refused: null, check: failed, error: null });
  });
});

describe('adding an account', () => {
  const TOKEN = 'sk-ant-oat01-Zm9vYmFyYmF6cXV4LXRoZS10b2tlbg';
  const PASSED = { ok: true, message: 'answered: OK', checkedAt: '2026-09-24T08:05:00.000Z' };

  function answer(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  function bridge(added: Response) {
    const asked: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      asked.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return String(url).endsWith('/verify') ? answer(200, PASSED) : added;
    });
    return { asked, fetcher: fetcher as unknown as typeof fetch };
  }

  it('reads the new account’s id from what the bridge answered', () => {
    expect(addedAccountId({ account: { id: 'acct-new', provider: 'anthropic' }, models: [] })).toBe('acct-new');
    expect(addedAccountId({ account: { id: '' } })).toBeNull();
    expect(addedAccountId({ models: [] })).toBeNull();
    expect(addedAccountId(null)).toBeNull();
  });

  it('checks a Claude seat’s token as part of adding it', async () => {
    const { asked, fetcher } = bridge(answer(200, { account: { id: 'acct-new' }, models: [] }));
    const added = vi.fn();

    const outcome = await addAccount(
      { provider: 'anthropic', kind: 'subscription', label: 'Anthropic — Max', token: TOKEN },
      { fetcher, added },
    );

    expect(asked).toEqual(['POST /api/model-accounts', 'POST /api/model-accounts/acct-new/verify']);
    expect(added).toHaveBeenCalledWith('acct-new');
    expect(outcome).toEqual({ refused: null, id: 'acct-new', checked: { check: PASSED, error: null } });
  });

  it('does not check a key, which the provider already listed models with, or a seat not signed in yet', async () => {
    for (const input of [
      { provider: 'anthropic', kind: 'key', label: 'Anthropic — API key', key: 'sk-ant-api03-x' },
      { provider: 'openai', kind: 'subscription', label: 'ChatGPT Pro' },
    ] as const) {
      const { asked, fetcher } = bridge(answer(200, { account: { id: 'acct-new' }, models: [] }));

      expect(await addAccount(input, { fetcher })).toEqual({ refused: null, id: 'acct-new', checked: null });
      expect(asked).toEqual(['POST /api/model-accounts']);
    }
  });

  it('adds nothing and checks nothing when the bridge refuses, and says why in its words', async () => {
    const { asked, fetcher } = bridge(answer(400, { error: 'a Claude subscription takes the token `claude setup-token` prints' }));

    const outcome = await addAccount(
      { provider: 'anthropic', kind: 'subscription', label: 'Max', token: 'sk-ant-api03-x' },
      { fetcher },
    );

    expect(outcome).toEqual({
      refused: 'a Claude subscription takes the token `claude setup-token` prints',
      id: null,
      checked: null,
    });
    expect(asked).toEqual(['POST /api/model-accounts']);
  });
});

describe('reading the bridge', () => {
  it('reads the crew, its account and what the probe says', () => {
    const crew = crewFromEngines({
      reachable: true,
      bots: [
        {
          bot: 'builder',
          role: 'implement',
          roleLabel: 'builder',
          engine: 'claude',
          model: 'newest:opus',
          modelAccountId: 'acct-anthropic',
          readiness: { ...NO_CLAUDE, keySource: { envVar: 'ANTHROPIC_API_KEY', url: 'https://example.test' } },
        },
        { bot: 'automation', role: 7, roleLabel: 'automation', engine: 'none', model: 'none', modelAccountId: null, readiness: null },
        { bot: 'ghost', engine: 'gemini', model: 'x' },
        { engine: 'claude', model: 'claude-opus-5' },
        'not a bot',
      ],
    });

    expect(crew).toEqual([
      {
        bot: 'builder',
        role: 'implement',
        roleLabel: 'builder',
        engine: 'claude',
        model: 'newest:opus',
        modelAccountId: 'acct-anthropic',
        readiness: {
          ...NO_CLAUDE,
          keySource: { envVar: 'ANTHROPIC_API_KEY', url: 'https://example.test', label: 'the provider' },
        },
      },
      { bot: 'automation', roleLabel: 'automation', engine: 'none', model: 'none', modelAccountId: null, readiness: null },
    ]);
    expect(crew[1]).not.toHaveProperty('role');
    expect(crewFromEngines(null)).toEqual([]);
    expect(crewFromEngines({ bots: 'nine' })).toEqual([]);
  });

  it('reads the seat a bot fills and whether an account is connected, so it can be named', () => {
    const [connected, waiting, older] = crewFromEngines({
      bots: [
        { bot: 'irisexampleco', slot: 'second-reviewer', connected: true, roleLabel: 'second reviewer', engine: 'grok', model: 'grok-4' },
        { bot: 'lead-reviewer', slot: 'lead-reviewer', roleLabel: 'lead reviewer', engine: 'claude', model: 'claude-opus-5' },
        // A bridge older than seats sends neither.
        { bot: 'builder', slot: '', connected: 'yes', roleLabel: 'builder', engine: 'claude', model: 'claude-sonnet-5' },
      ],
    });

    expect(connected).toMatchObject({ bot: 'irisexampleco', slot: 'second-reviewer', connected: true });
    expect(waiting).toMatchObject({ bot: 'lead-reviewer', slot: 'lead-reviewer' });
    expect(waiting).not.toHaveProperty('connected');
    expect(older).not.toHaveProperty('slot');
    expect(older).not.toHaveProperty('connected');
  });

  it('reads what the configuration gives each bot, beside what is saved', () => {
    const [builder, securityReviewer] = crewFromEngines({
      bots: [
        {
          bot: 'builder',
          engine: 'grok',
          model: 'grok-4.7',
          modelAccountId: 'acct-supergrok',
          configuredEngine: 'claude',
          configuredModel: 'claude-sonnet-5',
        },
        { bot: 'security-reviewer', engine: 'codex', model: 'gpt-5-codex', modelAccountId: null, configuredEngine: 'gemini' },
      ],
    });
    expect(builder).toMatchObject({ engine: 'grok', configuredEngine: 'claude', configuredModel: 'claude-sonnet-5' });
    // An engine the console does not know is no recommendation.
    expect(securityReviewer).not.toHaveProperty('configuredEngine');
    expect(securityReviewer).not.toHaveProperty('configuredModel');
  });

  it('keeps only accounts it can name, and never a key', () => {
    const accounts = accountsFrom({
      accounts: [
        { id: 'a1', provider: 'anthropic', kind: 'key', label: 'primary', key: 'sk-should-not-travel' },
        { id: 'a2', provider: 'xai', kind: 'subscription' },
        { id: 'a3', provider: 'google', kind: 'key', label: 'not ours' },
        { id: 'a4', provider: 'openai', kind: 'seat', label: 'not a kind' },
        { provider: 'openai', kind: 'key', label: 'no id' },
      ],
    });

    expect(accounts).toEqual([
      { id: 'a1', provider: 'anthropic', kind: 'key', label: 'primary', verifiedAt: null, verifyError: null },
      { id: 'a2', provider: 'xai', kind: 'subscription', label: '', verifiedAt: null, verifyError: null },
    ]);
    expect(accountsFrom(undefined)).toEqual([]);
  });

  it('keeps when an account was last checked, and what the CLI said', () => {
    const [checked] = accountsFrom({
      accounts: [
        {
          id: 'a1',
          provider: 'openai',
          kind: 'subscription',
          label: 'ChatGPT Pro',
          verifiedAt: '2026-09-24T08:00:00.000Z',
          verifyError: 'unexpected status 401 Unauthorized',
        },
      ],
    });

    expect(checked).toMatchObject({ verifiedAt: '2026-09-24T08:00:00.000Z', verifyError: 'unexpected status 401 Unauthorized' });
  });
});

describe('talking to the console’s own routes', () => {
  function answer(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('puts a bot name or an account id in a path as one segment', () => {
    expect(assignmentPath('builder')).toBe('/api/bots/builder/assignment');
    expect(assignmentPath('a/b?c')).toBe('/api/bots/a%2Fb%3Fc/assignment');
    expect(accountModelsPath('x/../y')).toBe('/api/model-accounts/x%2F..%2Fy/models');
    expect(accountRemovePath('a b')).toBe('/api/model-accounts/a%20b/remove');
    expect(accountTokenPath('x/../y')).toBe('/api/model-accounts/x%2F..%2Fy/key');
    expect(accountLoginPath('a?b')).toBe('/api/model-accounts/a%3Fb/login');
    expect(accountVerifyPath('a#b')).toBe('/api/model-accounts/a%23b/verify');
  });

  it('applies two saves to the crew as each answer arrives, so neither undoes the other', async () => {
    let state: CrewBot[] | null = [bot({ bot: 'builder' }), bot({ bot: 'system-engineer' })];
    const setCrew = (update: (current: CrewBot[] | null) => CrewBot[] | null) => {
      state = update(state);
    };
    const fetcher = vi.fn(async () => answer(200, {}));

    await Promise.all([
      saveAssignment('builder', { model: 'claude-opus-5' }, setCrew, fetcher),
      saveAssignment('system-engineer', { modelAccountId: 'acct-anthropic' }, setCrew, fetcher),
    ]);

    expect(state).toMatchObject([
      { bot: 'builder', model: 'claude-opus-5', modelAccountId: null },
      { bot: 'system-engineer', model: 'claude-sonnet-5', modelAccountId: 'acct-anthropic' },
    ]);
    expect(fetcher).toHaveBeenCalledWith('/api/bots/builder/assignment', expect.objectContaining({ method: 'PATCH' }));
  });

  it('returns the bridge’s refusal and leaves the crew alone', async () => {
    const setCrew = vi.fn();
    const refused = await saveAssignment(
      'builder',
      { model: 'newest:opus' },
      setCrew,
      vi.fn(async () => answer(400, { error: 'a subscription cannot list models' })),
    );

    expect(refused).toBe('a subscription cannot list models');
    expect(setCrew).not.toHaveBeenCalled();
  });

  it('reports a model listing that failed instead of showing an empty one', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('acct-ok')
        ? answer(200, { models: [{ id: 'claude-opus-5', createdAt: null }], aliases: ['newest:opus'] })
        : answer(502, { error: 'xAI answered 503: upstream unavailable' }),
    );

    const listed = await listModelsFor([{ id: 'acct-ok' }, { id: 'acct-down' }], fetcher as typeof fetch);

    expect(listed).toEqual({
      'acct-ok': { models: [{ id: 'claude-opus-5', createdAt: null, isDefault: false }], aliases: ['newest:opus'], error: null },
      'acct-down': { models: [], aliases: [], error: 'xAI answered 503: upstream unavailable' },
    });
  });

  it('asks for an account’s token or key before its models, rather than calling the listing failed', async () => {
    const fetcher = vi.fn(async () =>
      answer(409, {
        error: 'this subscription has no token stored, so its models cannot be listed — paste the one `claude setup-token` prints',
      }),
    );

    const listed = await listModelsFor(
      [{ id: 'acct-seat', kind: 'subscription' }, { id: 'acct-key', kind: 'key' }],
      fetcher as typeof fetch,
    );

    expect(listed).toEqual({
      'acct-seat': { models: [], aliases: [], error: 'save its token first' },
      'acct-key': { models: [], aliases: [], error: 'save its key first' },
    });
  });

  it('gives up on a listing that never answers, as that account’s error, so the proposal is not held', async () => {
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const started = Date.now();
    const listed = await listModelsFor([{ id: 'acct-stuck' }], fetcher as typeof fetch, 30);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(listed).toEqual({
      'acct-stuck': { models: [], aliases: [], error: 'the account did not say what it offers in time' },
    });
  });

  it('reads which model is the account’s default, and only families as families', () => {
    expect(
      listingFrom({
        models: [
          { id: 'grok-4.7', createdAt: null, isDefault: true },
          { id: 'grok-4.6', createdAt: null, isDefault: 'yes' },
          { id: '', createdAt: null },
        ],
        aliases: ['newest:grok', 'newest:grok', 'grok-4.7', 3, 'newest:'],
      }),
    ).toEqual({
      models: [
        { id: 'grok-4.7', createdAt: null, isDefault: true },
        { id: 'grok-4.6', createdAt: null, isDefault: false },
      ],
      aliases: ['newest:grok'],
      error: null,
    });
    // A bridge from before families were listed: nothing to follow, rather than a failure.
    expect(listingFrom({ models: [] })).toEqual({ models: [], aliases: [], error: null });
  });

  it('shows the engine the bridge switched a bot to when it moved to another provider’s account', async () => {
    let state: CrewBot[] | null = [bot({ bot: 'builder' })];
    const setCrew = (update: (current: CrewBot[] | null) => CrewBot[] | null) => {
      state = update(state);
    };
    const fetcher = vi.fn(async () =>
      answer(200, { bot: { name: 'builder', engine: 'grok', model: 'grok-4.7', modelAccountId: 'acct-supergrok' } }),
    );

    expect(await saveAssignment('builder', { modelAccountId: 'acct-supergrok', model: 'grok-4.7' }, setCrew, fetcher)).toBeNull();
    expect(state).toMatchObject([{ bot: 'builder', engine: 'grok', model: 'grok-4.7', modelAccountId: 'acct-supergrok' }]);
    expect(fetcher).toHaveBeenCalledWith('/api/bots/builder/assignment', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelAccountId: 'acct-supergrok', model: 'grok-4.7' }),
    });
  });
});

describe('the onboarding page and a hostd that does not answer', () => {
  it('stops waiting for the engines and renders without them', async () => {
    // Never answers, like a stuck readiness probe that once held the page.
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const started = Date.now();
    await expect(jsonWithin('http://bridge/v1/engines', {}, 30, fetcher as typeof fetch)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('passes an answer through, and a refusal as nothing', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ bots: [] }), { status: 200 }));
    const refused = vi.fn(async () => new Response('{}', { status: 502 }));

    await expect(jsonWithin('http://bridge/v1/engines', {}, 1_000, ok)).resolves.toEqual({ bots: [] });
    await expect(jsonWithin('http://bridge/v1/engines', {}, 1_000, refused)).resolves.toBeNull();
  });

  it('is how the page asks for the engines', () => {
    const page = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'onboarding', 'page.tsx'),
      'utf8',
    );
    expect(page).toMatch(/jsonWithin\(`\$\{BRIDGE_URL\}\/v1\/engines`, [^)]*ENGINES_WAIT_MS\)/);
    expect(ENGINES_WAIT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('what an account offers, in a line', () => {
  it('names its models newest first and counts the rest', () => {
    const listing = {
      models: ['a-1', 'a-2', 'a-3', 'a-4', 'a-5', 'a-6'].map((id, index) => ({ id, createdAt: `2026-0${index + 1}-01T00:00:00Z` })),
      aliases: [],
      error: null,
    };
    expect(offeredLine(listing)).toEqual({ text: 'Offers a-6, a-5, a-4, a-3, and 2 more', tone: 'plain' });
  });

  it('says why it could not list them, and nothing before it was asked', () => {
    expect(offeredLine({ models: [], aliases: [], error: 'signed out' })).toEqual({ text: 'Could not list its models: signed out', tone: 'error' });
    expect(offeredLine({ models: [], aliases: [], error: null })).toEqual({ text: 'It did not list any models.', tone: 'plain' });
    expect(offeredLine(undefined)).toBeNull();
  });
});

describe('a row’s assignment, and the walkthrough’s forward button', () => {
  const proposed: ProposalAssignment = { bot: 'qa', accountId: 'acct-max', model: 'claude-sonnet-5', engine: 'claude' };

  it('starts a row at what somebody chose, else a bot on no account at its proposal, else where it is', () => {
    const qa = bot({ bot: 'qa' });
    const builder = bot({ bot: 'builder', modelAccountId: 'acct-max', model: 'claude-sonnet-5' });

    expect(draftFor(qa, { accountId: 'acct-key', model: 'claude-opus-5' }, proposed)).toEqual({
      accountId: 'acct-key',
      model: 'claude-opus-5',
    });
    expect(draftFor(qa, undefined, proposed)).toEqual({ accountId: 'acct-max', model: 'claude-sonnet-5' });
    expect(draftFor(builder, undefined, { ...proposed, model: 'claude-opus-5' })).toEqual({
      accountId: 'acct-max',
      model: 'claude-sonnet-5',
    });
  });

  it('says continue on a done step, and what skipping means on one that is not', () => {
    expect(forwardLabel({ done: true, blocked: false })).toBe('continue');
    expect(forwardLabel({ done: false, blocked: true })).toBe('continue anyway');
    expect(forwardLabel({ done: false, blocked: false })).toBe('skip for now');
  });
});
