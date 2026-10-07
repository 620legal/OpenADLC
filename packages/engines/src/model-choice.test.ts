import { describe, expect, it } from 'vitest';
import {
  aliasesFor,
  aliasFamily,
  checkModelAssignment,
  isAlias,
  ledgerModel,
  ModelAssignmentError,
  modelForSession,
  ModelUnavailable,
  newestIn,
  resolveModel,
  sortNewestFirst,
  type AvailableModel,
} from './model-choice.js';

/**
 * "Use the newest Opus" cannot be a model id: Anthropic's identifiers do not
 * float — `claude-opus-5` is Opus 5 and stays Opus 5 when Opus 6 ships. It is a
 * choice OpenADLC resolves against what the account can actually call.
 */
const ANTHROPIC: AvailableModel[] = [
  { id: 'claude-opus-5', createdAt: '2026-04-01' },
  { id: 'claude-opus-4-8', createdAt: '2026-01-15' },
  { id: 'claude-sonnet-5', createdAt: '2026-03-01' },
  { id: 'claude-haiku-4-5', createdAt: '2025-10-01' },
];

describe('telling an alias from an id', () => {
  it('reads the family out of one', () => {
    expect(isAlias('newest:opus')).toBe(true);
    expect(aliasFamily('newest:opus')).toBe('opus');
  });

  it('leaves a model id alone', () => {
    expect(isAlias('claude-opus-5')).toBe(false);
    expect(aliasFamily('claude-opus-5')).toBeNull();
  });
});

describe('resolving the newest in a family', () => {
  it('picks by the provider’s release date, not by reading version numbers', () => {
    // Parsing `4-8` against `5` would be wrong the first time a vendor shipped
    // something shaped differently, and the numbering is theirs to change.
    expect(newestIn('opus', ANTHROPIC)).toBe('claude-opus-5');
  });

  it('follows the family, not the whole list', () => {
    expect(newestIn('sonnet', ANTHROPIC)).toBe('claude-sonnet-5');
    expect(newestIn('haiku', ANTHROPIC)).toBe('claude-haiku-4-5');
  });

  it('moves when the provider adds a newer one', () => {
    // The whole point: nobody edits anything and the bot follows.
    const withSix = [...ANTHROPIC, { id: 'claude-opus-6', createdAt: '2026-11-01' }];

    expect(newestIn('opus', withSix)).toBe('claude-opus-6');
  });

  it('falls back to the id when a provider reports no dates', () => {
    const undated = [
      { id: 'grok-4', createdAt: null },
      { id: 'grok-3', createdAt: null },
    ];

    expect(newestIn('grok', undated)).toBe('grok-4');
  });

  it('takes the model an undated list calls its default, over the ids', () => {
    // What `grok models` lists for a SuperGrok seat. By id, the build-fast
    // variant sorts ahead of the model it is a variant of; grok's own default
    // is what `newest:grok` means on a seat.
    const seat: AvailableModel[] = [
      { id: 'grok-4.7', createdAt: null, isDefault: true },
      { id: 'grok-4.7-build-fast', createdAt: null, isDefault: false },
      { id: 'grok-4.6', createdAt: null, isDefault: false },
      { id: 'grok-4.5', createdAt: null, isDefault: false },
    ];

    expect(newestIn('grok', seat)).toBe('grok-4.7');
    expect(sortNewestFirst(seat).map((model) => model.id)).toEqual([
      'grok-4.7',
      'grok-4.7-build-fast',
      'grok-4.6',
      'grok-4.5',
    ]);
    // A date still outranks a mark: an API's list is ordered by release.
    expect(newestIn('grok', [...seat, { id: 'grok-5', createdAt: '2026-12-01' }])).toBe('grok-5');
  });
});

describe('a family and its cheaper variants', () => {
  it('follows the base model when a variant is dated after it', () => {
    const fast = [
      { id: 'grok-4.7', createdAt: '2026-08-01' },
      { id: 'grok-4.7-fast-non-reasoning', createdAt: '2026-09-01' },
    ];
    expect(newestIn('grok', fast)).toBe('grok-4.7');

    const code = [
      { id: 'grok-4.7', createdAt: '2026-08-01' },
      { id: 'grok-code-fast-2', createdAt: '2026-09-01' },
    ];
    expect(newestIn('grok', code)).toBe('grok-4.7');
  });

  it('takes the variant when the family names it, or lists nothing else', () => {
    const codex = [
      { id: 'gpt-5.1-codex', createdAt: '2026-08-01' },
      { id: 'gpt-5.1-codex-mini', createdAt: '2026-09-01' },
    ];
    expect(newestIn('codex', codex)).toBe('gpt-5.1-codex');
    expect(newestIn('codex-mini', codex)).toBe('gpt-5.1-codex-mini');
    expect(newestIn('codex', [{ id: 'gpt-5.1-codex-mini', createdAt: '2026-09-01' }])).toBe('gpt-5.1-codex-mini');
  });

  it('reads whole parts of the id, so codex is not code and a preview or nano is a variant', () => {
    const listed = [
      { id: 'gpt-6-codex', createdAt: '2026-08-01' },
      { id: 'gpt-6-codex-preview', createdAt: '2026-09-01' },
      { id: 'gpt-6-codex-nano', createdAt: '2026-09-02' },
      { id: 'gpt-6-codex-lite', createdAt: '2026-09-03' },
    ];
    expect(newestIn('codex', listed)).toBe('gpt-6-codex');
    expect(newestIn('code', [{ id: 'gpt-6-codex', createdAt: '2026-08-01' }])).toBe('gpt-6-codex');
  });
});

describe('what a task is actually told to call', () => {
  it('resolves an alias and keeps both halves', () => {
    const choice = resolveModel('newest:opus', ANTHROPIC);

    expect(choice.resolved).toBe('claude-opus-5');
    // Both, because the ledger needs the resolved id and the page needs to show
    // what was chosen. Writing the alias into the ledger would make a month of
    // spend unattributable the moment the alias moved.
    expect(choice.configured).toBe('newest:opus');
    expect(choice.alias).toBe('opus');
  });

  it('passes a pinned id straight through', () => {
    const choice = resolveModel('claude-sonnet-5', ANTHROPIC);

    expect(choice).toEqual({ configured: 'claude-sonnet-5', resolved: 'claude-sonnet-5', alias: null });
  });

  it('refuses a model the account cannot call, rather than substituting one', () => {
    // Quietly running a different model than the one somebody chose is the same
    // fault as a scripted engine standing in for a missing one — and it would
    // appear in the ledger as a model nobody selected.
    expect(() => resolveModel('claude-opus-4-6', ANTHROPIC)).toThrow(ModelUnavailable);
    expect(() => resolveModel('claude-opus-4-6', ANTHROPIC)).toThrow(/cannot call/);
  });

  it('names what the account does offer, so the refusal is actionable', () => {
    expect(() => resolveModel('gpt-5-codex', ANTHROPIC)).toThrow(/claude-opus-5/);
  });

  it('names the models in the same family, so a long catalogue is not cut before them', () => {
    // An OpenAI catalogue is dozens of ids. The message is cut at 400
    // characters on its way to the thread, which used to cut off the ones
    // that mattered.
    const catalogue: AvailableModel[] = [
      ...Array.from({ length: 60 }, (_, index) => ({ id: `gpt-4o-mini-2024-${index}`, createdAt: '2025-01-01' })),
      { id: 'gpt-5-codex', createdAt: '2026-05-01' },
      { id: 'gpt-5-codex-mini', createdAt: '2026-06-01' },
    ];

    let message = '';
    try {
      resolveModel('gpt-4-codex', catalogue);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe('this account cannot call gpt-4-codex — its codex models are gpt-5-codex-mini, gpt-5-codex');
  });

  it('names only the newest few when no family can be told', () => {
    const catalogue = Array.from({ length: 30 }, (_, index) => ({
      id: `model-${String(index).padStart(2, '0')}`,
      createdAt: null,
    }));

    expect(() => resolveModel('something-else', catalogue)).toThrow(/model-29, .*model-22, and 22 more$/);
  });

  it('refuses an alias with nothing to resolve to', () => {
    expect(() => resolveModel('newest:opus', [{ id: 'grok-4', createdAt: null }])).toThrow(
      /offers no opus model/,
    );
  });

  it('trusts a configured id when the account reports no list at all', () => {
    // A provider OpenADLC cannot enumerate must not become a provider OpenADLC
    // refuses to use.
    expect(resolveModel('gpt-5-codex', []).resolved).toBe('gpt-5-codex');
  });
});

describe('what may be stored, and what may be recorded', () => {
  const anthropicKey = { id: 'account-1', provider: 'anthropic', kind: 'key' } as const;
  const anthropicSeat = { id: 'account-2', provider: 'anthropic', kind: 'subscription' } as const;
  const openaiKey = { id: 'account-3', provider: 'openai', kind: 'key' } as const;
  const openaiSeat = { id: 'account-4', provider: 'openai', kind: 'subscription' } as const;
  const xaiSeat = { id: 'account-5', provider: 'xai', kind: 'subscription' } as const;
  const xaiKey = { id: 'account-6', provider: 'xai', kind: 'key' } as const;

  it('keeps a pinned id and a floating family the engine has', () => {
    expect(checkModelAssignment('claude', 'newest:opus', anthropicKey)).toEqual({
      engine: 'claude',
      model: 'newest:opus',
      modelAccountId: 'account-1',
    });
    expect(checkModelAssignment('claude', '  claude-sonnet-5  ', null)).toEqual({
      engine: 'claude',
      model: 'claude-sonnet-5',
      modelAccountId: null,
    });
  });

  it('refuses an empty model, because the engine would be handed nothing', () => {
    expect(() => checkModelAssignment('claude', '   ', null)).toThrow(ModelAssignmentError);
    expect(() => checkModelAssignment('claude', '   ', null)).toThrow(/needs a model/);
  });

  it('refuses a model id that is not shaped like one', () => {
    expect(() => checkModelAssignment('claude', 'claude-opus-5; rm -rf /', null)).toThrow(ModelAssignmentError);
    expect(() => checkModelAssignment('claude', `claude-${'x'.repeat(200)}`, null)).toThrow(/at most 128/);
    expect(checkModelAssignment('codex', 'ft:gpt-5-codex:org:1', null).model).toBe('ft:gpt-5-codex:org:1');
  });

  it('does not offer the automation bot an account or a model', () => {
    expect(checkModelAssignment('none', 'none', null)).toEqual({ engine: 'none', model: 'none', modelAccountId: null });
    expect(() => checkModelAssignment('none', 'none', anthropicKey)).toThrow(/cannot be assigned an account/);
    expect(() => checkModelAssignment('none', 'claude-opus-5', null)).toThrow(/does not run a model/);
    expect(() => checkModelAssignment('none', 'grok-4.7', xaiSeat)).toThrow(/cannot be assigned an account/);
  });

  it('refuses a family the engine does not have', () => {
    expect(() => checkModelAssignment('grok', 'newest:opus', null)).toThrow(/no opus family/);
    expect(() => checkModelAssignment('grok', 'newest:opus', null)).toThrow(/newest:grok/);
    // The family is checked against the engine the account puts the bot on.
    expect(() => checkModelAssignment('claude', 'newest:opus', xaiSeat)).toThrow('grok has no opus family — it offers newest:grok');
  });

  it('moves the bot to the engine of the account it is given', () => {
    // The builder on Grok, the second reviewer on Claude, the security
    // reviewer on Claude when the install has no OpenAI account: each used to
    // be refused as "claude runs on anthropic, and this account is xai".
    expect(checkModelAssignment('claude', 'grok-4.7', xaiSeat)).toEqual({
      engine: 'grok',
      model: 'grok-4.7',
      modelAccountId: 'account-5',
    });
    expect(checkModelAssignment('grok', 'claude-opus-5', anthropicKey)).toEqual({
      engine: 'claude',
      model: 'claude-opus-5',
      modelAccountId: 'account-1',
    });
    expect(checkModelAssignment('codex', 'claude-opus-5-5', anthropicSeat).engine).toBe('claude');
    expect(checkModelAssignment('claude', 'gpt-5-codex', openaiKey).engine).toBe('codex');
    expect(checkModelAssignment('claude', 'o4-mini', openaiKey).engine).toBe('codex');
  });

  it('keeps the bot’s engine when it is given no account', () => {
    expect(checkModelAssignment('grok', 'grok-4.7', null)).toEqual({ engine: 'grok', model: 'grok-4.7', modelAccountId: null });
    expect(checkModelAssignment('codex', 'newest:codex', null).engine).toBe('codex');
  });

  it('refuses a model the account’s provider does not serve, saying what it does take', () => {
    // claude-opus-5 handed to grok fails the task on its first call.
    expect(() => checkModelAssignment('claude', 'claude-opus-5', xaiSeat)).toThrow(ModelAssignmentError);
    expect(() => checkModelAssignment('claude', 'claude-opus-5', xaiSeat)).toThrow(
      'claude-opus-5 is an Anthropic model, and this is an xAI account — grok takes grok-… ids or newest:grok',
    );
    expect(() => checkModelAssignment('grok', 'grok-4', anthropicKey)).toThrow(
      'grok-4 is an xAI model, and this is an Anthropic account — claude takes claude-… ids or newest:fable, newest:opus, newest:sonnet or newest:haiku',
    );
    expect(() => checkModelAssignment('claude', 'grok-4.7', openaiSeat)).toThrow(
      // No family on an OpenAI seat, so none is offered.
      'grok-4.7 is an xAI model, and this is an OpenAI account — codex takes gpt-…, o… and codex… ids',
    );
    expect(() => checkModelAssignment('claude', 'llama-4', anthropicKey)).toThrow(/^llama-4 is not an Anthropic model/);
  });

  it('says which account would run a model from another provider, when none is given', () => {
    expect(() => checkModelAssignment('claude', 'grok-4.7', null)).toThrow(
      'grok-4.7 is an xAI model, and claude calls Anthropic — choose an xAI account to run it on grok',
    );
  });

  it('floats a family on a Claude or an xAI subscription, which can list, and not on an OpenAI one', () => {
    expect(checkModelAssignment('claude', 'newest:opus', anthropicSeat)).toEqual({
      engine: 'claude',
      model: 'newest:opus',
      modelAccountId: 'account-2',
    });
    expect(checkModelAssignment('claude', 'newest:grok', xaiSeat)).toEqual({
      engine: 'grok',
      model: 'newest:grok',
      modelAccountId: 'account-5',
    });
    expect(() => checkModelAssignment('codex', 'newest:codex', openaiSeat)).toThrow(
      'an OpenAI subscription cannot list models, so newest:codex would have nothing to resolve against — pin a model id',
    );
    expect(checkModelAssignment('codex', 'gpt-5-codex', openaiSeat)).toEqual({
      engine: 'codex',
      model: 'gpt-5-codex',
      modelAccountId: 'account-4',
    });
    expect(checkModelAssignment('grok', 'newest:grok', xaiKey).modelAccountId).toBe('account-6');
  });

  it('names the families each account can resolve', () => {
    expect(aliasesFor(anthropicKey)).toEqual(['newest:fable', 'newest:opus', 'newest:sonnet', 'newest:haiku']);
    expect(aliasesFor(anthropicSeat)).toEqual(['newest:fable', 'newest:opus', 'newest:sonnet', 'newest:haiku']);
    expect(aliasesFor(openaiKey)).toEqual(['newest:codex']);
    expect(aliasesFor(openaiSeat)).toEqual([]);
    expect(aliasesFor(xaiSeat)).toEqual(['newest:grok']);
    expect(aliasesFor(xaiKey)).toEqual(['newest:grok']);
  });

  it('hands the session the resolved id and keeps the alias beside it', () => {
    const session = modelForSession(resolveModel('newest:opus', ANTHROPIC));

    expect(session.model).toBe('claude-opus-5');
    expect(session.modelAlias).toBe('newest:opus');
    expect(session.model.startsWith('newest:')).toBe(false);
  });

  it('refuses to record an alias as the model that was called', () => {
    expect(ledgerModel('claude-opus-5', 'newest:opus')).toEqual({
      model: 'claude-opus-5',
      modelAlias: 'newest:opus',
    });
    expect(ledgerModel('claude-sonnet-5', null)).toEqual({ model: 'claude-sonnet-5', modelAlias: null });
    expect(() => ledgerModel('newest:opus', null)).toThrow(ModelUnavailable);
    expect(() => ledgerModel('newest:opus', null)).toThrow(/resolved model id/);
  });
});

describe('an undated name for a dated listing', () => {
  const listed = [{ id: 'claude-haiku-4-5-20251001', createdAt: '2025-10-15T00:00:00Z' }];

  it('calls the undated name when the account lists its dated snapshot', () => {
    // A Claude account lists Haiku only by its date; the configuration, the
    // API and the CLI all use the undated name.
    expect(resolveModel('claude-haiku-4-5', listed)).toEqual({
      configured: 'claude-haiku-4-5',
      resolved: 'claude-haiku-4-5',
      alias: null,
    });
  });

  it('does not take a shorter name for a snapshot of a longer one', () => {
    expect(() => resolveModel('claude-haiku-4', listed)).toThrow(/cannot call claude-haiku-4/);
  });
});
