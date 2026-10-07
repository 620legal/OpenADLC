import { describe, expect, it, vi } from 'vitest';
import { ledgerModel, modelListCache, MODEL_LIST_TTL_MS } from '@fleetadlc/engines';
import type { AvailableModel } from '@fleetadlc/engines';
import { ModelUnavailable } from '@fleetadlc/engines';
import {
  resolveTaskModel,
  subscriptionModels,
  type ResolveTaskModelDeps,
  type TaskModelAccount,
  type TaskModelBot,
} from './model-resolution.js';

const ACCOUNT = '550e8400-e29b-41d4-a716-446655440000';

const ANTHROPIC: AvailableModel[] = [
  { id: 'claude-opus-5', createdAt: '2026-04-01' },
  { id: 'claude-opus-4-8', createdAt: '2026-01-15' },
  { id: 'claude-sonnet-5', createdAt: '2026-03-01' },
];

function bot(partial: Partial<TaskModelBot> = {}): TaskModelBot {
  return {
    name: 'atlas',
    engine: 'claude',
    model: 'newest:opus',
    modelAccountId: ACCOUNT,
    ...partial,
  };
}

function deps(overrides: Partial<ResolveTaskModelDeps> = {}): ResolveTaskModelDeps {
  return {
    account: async () => ({ id: ACCOUNT, provider: 'anthropic', kind: 'key' }),
    keyForAccount: async () => 'sk-test',
    listModels: async () => ANTHROPIC,
    cache: modelListCache(),
    ...overrides,
  };
}

describe('resolving a bot’s model when a task starts', () => {
  it('runs the newest Opus the account offers, and remembers the alias separately', async () => {
    const choice = await resolveTaskModel(bot(), deps());

    expect(choice.model).toBe('claude-opus-5');
    expect(choice.modelAlias).toBe('newest:opus');
    expect(choice.model).not.toMatch(/^newest:/);
    // What the minter will take the key from, so it is the same account.
    expect(choice.account).toEqual({ id: ACCOUNT, provider: 'anthropic', kind: 'key' });
  });

  it('under the suites’ scripted engines, starts a seat with no account on a newest: family, and asks no provider', async () => {
    const listModels = vi.fn(async () => ANTHROPIC);
    const choice = await resolveTaskModel(bot({ modelAccountId: null }), deps({ scripted: true, listModels }));

    expect(choice).toEqual({ model: 'scripted', modelAlias: 'newest:opus', account: null });
    expect(listModels).not.toHaveBeenCalled();
    // Without them, the same seat is refused, as an install's must be.
    await expect(resolveTaskModel(bot({ modelAccountId: null }), deps())).rejects.toThrow(/no model account to list models from/);
  });

  it('follows a newer Opus on the next ask, without anyone editing the bot', async () => {
    let clock = 0;
    const catalogue = [...ANTHROPIC];
    // A copy each time. The cache holds the array it was given, and mutating
    // that array would look like the provider had been asked again.
    const listModels = vi.fn(async () => catalogue.map((model) => ({ ...model })));
    const used = deps({
      listModels,
      cache: modelListCache({ ttlMs: MODEL_LIST_TTL_MS, now: () => clock }),
    });

    expect((await resolveTaskModel(bot(), used)).model).toBe('claude-opus-5');

    catalogue.push({ id: 'claude-opus-6', createdAt: '2026-12-01' });
    // Still inside the window: the new model is not a reason to ask again.
    expect((await resolveTaskModel(bot(), used)).model).toBe('claude-opus-5');
    expect(listModels).toHaveBeenCalledTimes(1);

    clock += MODEL_LIST_TTL_MS;
    expect((await resolveTaskModel(bot(), used)).model).toBe('claude-opus-6');
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('uses the model on the bot, so a console change is what the next task runs', async () => {
    const listModels = vi.fn(async () => ANTHROPIC);
    const used = deps({ listModels });

    const floating = await resolveTaskModel(bot({ model: 'newest:opus' }), used);
    const pinned = await resolveTaskModel(bot({ model: 'claude-sonnet-5' }), used);

    expect(floating.model).toBe('claude-opus-5');
    expect(floating.modelAlias).toBe('newest:opus');
    expect(pinned).toMatchObject({ model: 'claude-sonnet-5', modelAlias: null });
    // The catalogue was already known. Changing the assignment did not ask again.
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('lists once per account, not once per bot', async () => {
    const listModels = vi.fn(async () => ANTHROPIC);
    const used = deps({ listModels });

    await resolveTaskModel(bot({ name: 'atlas' }), used);
    await resolveTaskModel(bot({ name: 'nova', model: 'claude-sonnet-5' }), used);

    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('lists again under a rotated key, rather than resolving from the old key’s models', async () => {
    let key = 'sk-old';
    const listModels = vi.fn(async () => ANTHROPIC);
    const used = deps({ listModels, keyForAccount: async () => key });

    await resolveTaskModel(bot(), used);
    key = 'sk-new';
    await resolveTaskModel(bot(), used);

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(listModels).toHaveBeenLastCalledWith('anthropic', 'sk-new');
  });

  it('fails a model the account cannot call, and names the ones in its family', async () => {
    const start = resolveTaskModel(bot({ model: 'claude-opus-4-6' }), deps());

    await expect(start).rejects.toBeInstanceOf(ModelUnavailable);
    await expect(start).rejects.toThrow(/cannot call claude-opus-4-6/);
    await expect(start).rejects.toThrow(/claude-opus-5, claude-opus-4-8$/);
  });

  it('does not substitute a different model when the alias matches nothing', async () => {
    await expect(
      resolveTaskModel(bot({ model: 'newest:haiku' }), deps({ listModels: async () => ANTHROPIC })),
    ).rejects.toThrow(/offers no haiku model/);
  });

  it('trusts a pinned id on a subscription, which has no key to list with', async () => {
    const listModels = vi.fn(async () => ANTHROPIC);
    const choice = await resolveTaskModel(
      bot({ model: 'claude-opus-5' }),
      deps({
        listModels,
        account: async () => ({ id: ACCOUNT, provider: 'anthropic', kind: 'subscription' }),
      }),
    );

    expect(choice).toEqual({
      model: 'claude-opus-5',
      modelAlias: null,
      account: { id: ACCOUNT, provider: 'anthropic', kind: 'subscription' },
    });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('does not send an alias through when a subscription cannot be asked', async () => {
    await expect(
      resolveTaskModel(
        bot({ model: 'newest:opus' }),
        deps({ account: async () => ({ id: ACCOUNT, provider: 'anthropic', kind: 'subscription' }) }),
      ),
    ).rejects.toThrow(/cannot be resolved/);
  });

  it('uses what a subscription’s CLI reports, when something can ask it', async () => {
    const choice = await resolveTaskModel(
      bot({ model: 'newest:opus' }),
      deps({
        account: async () => ({ id: ACCOUNT, provider: 'anthropic', kind: 'subscription' }),
        subscriptionModels: async () => [{ id: 'claude-opus-6', createdAt: '2026-12-01' }, ...ANTHROPIC],
      }),
    );

    expect(choice.model).toBe('claude-opus-6');
    expect(choice.modelAlias).toBe('newest:opus');
  });

  it('does not list models for the automation bot, and refuses it an account', async () => {
    const listModels = vi.fn(async () => ANTHROPIC);

    const choice = await resolveTaskModel(
      bot({ name: 'flow', engine: 'none', model: 'none', modelAccountId: null }),
      deps({ listModels }),
    );
    expect(choice).toEqual({ model: 'none', modelAlias: null, account: null });
    expect(listModels).not.toHaveBeenCalled();

    await expect(
      resolveTaskModel(bot({ name: 'flow', engine: 'none', model: 'none' }), deps({ listModels })),
    ).rejects.toThrow(/cannot be assigned an account/);
  });
});

// ------------------------------------------------------------ subscriptions

/** What `grok models` lists for a SuperGrok seat: no dates, one default. */
const GROK_SEAT: AvailableModel[] = [
  { id: 'grok-4.7', createdAt: null, isDefault: true },
  { id: 'grok-4.7-build-fast', createdAt: null, isDefault: false },
  { id: 'grok-4.6', createdAt: null, isDefault: false },
  { id: 'grok-4.5', createdAt: null, isDefault: false },
];

/** What Anthropic lists for a Claude seat's token: every model dated. */
const CLAUDE_SEAT: AvailableModel[] = [
  { id: 'claude-opus-5-5', createdAt: '2026-09-01T00:00:00Z' },
  { id: 'claude-fable-5-1', createdAt: '2026-08-01T00:00:00Z' },
  { id: 'claude-opus-5', createdAt: '2026-04-01T00:00:00Z' },
  { id: 'claude-sonnet-5', createdAt: '2026-03-01T00:00:00Z' },
];

const XAI_SEAT: TaskModelAccount = { id: ACCOUNT, provider: 'xai', kind: 'subscription' };
const CLAUDE_SEAT_ACCOUNT: TaskModelAccount = { id: ACCOUNT, provider: 'anthropic', kind: 'subscription' };
const CODEX_SEAT: TaskModelAccount = { id: ACCOUNT, provider: 'openai', kind: 'subscription' };

describe('what a subscription can call', () => {
  it('asks Anthropic with a Claude seat’s token, once per account inside the window', async () => {
    const listWithToken = vi.fn(async () => CLAUDE_SEAT);
    const list = subscriptionModels({
      tokenFor: async () => 'sk-ant-oat01-the-seat-token',
      listWithToken,
      cache: modelListCache(),
    });

    expect(await list(CLAUDE_SEAT_ACCOUNT)).toEqual(CLAUDE_SEAT);
    await list(CLAUDE_SEAT_ACCOUNT);

    expect(listWithToken).toHaveBeenCalledTimes(1);
    expect(listWithToken).toHaveBeenCalledWith('sk-ant-oat01-the-seat-token');
  });

  it('asks again once a Claude seat’s token is replaced', async () => {
    let token = 'sk-ant-oat01-the-old-token';
    const listWithToken = vi.fn(async () => CLAUDE_SEAT);
    const list = subscriptionModels({ tokenFor: async () => token, listWithToken, cache: modelListCache() });

    await list(CLAUDE_SEAT_ACCOUNT);
    token = 'sk-ant-oat01-the-new-token';
    await list(CLAUDE_SEAT_ACCOUNT);

    expect(listWithToken).toHaveBeenCalledTimes(2);
    expect(listWithToken).toHaveBeenLastCalledWith('sk-ant-oat01-the-new-token');
  });

  it('says a Claude seat with no token stored has nothing to list with', async () => {
    const listWithToken = vi.fn(async () => CLAUDE_SEAT);
    const list = subscriptionModels({ tokenFor: async () => null, listWithToken, cache: modelListCache() });

    await expect(list(CLAUDE_SEAT_ACCOUNT)).rejects.toThrow(/has no token stored/);
    expect(listWithToken).not.toHaveBeenCalled();
  });

  it('asks grok for an xAI seat, whose sign-in service remembers the answer itself', async () => {
    const cliModels = vi.fn(async () => GROK_SEAT);
    const list = subscriptionModels({
      tokenFor: async () => null,
      listWithToken: async () => [],
      cliModels,
      cache: modelListCache(),
    });

    expect(await list(XAI_SEAT)).toEqual(GROK_SEAT);
    await list(XAI_SEAT);

    // Not remembered here as well: a second cache would let a list outlive
    // the window by as long again.
    expect(cliModels).toHaveBeenCalledTimes(2);
    expect(cliModels).toHaveBeenCalledWith(ACCOUNT);
  });

  it('lists nothing for an OpenAI seat, and asks nothing', async () => {
    const listWithToken = vi.fn(async () => CLAUDE_SEAT);
    const cliModels = vi.fn(async () => GROK_SEAT);
    const list = subscriptionModels({ tokenFor: async () => 'unused', listWithToken, cliModels, cache: modelListCache() });

    expect(await list(CODEX_SEAT)).toEqual([]);
    expect(listWithToken).not.toHaveBeenCalled();
    expect(cliModels).not.toHaveBeenCalled();
  });
});

describe('resolving a bot on a subscription', () => {
  function onSeat(account: TaskModelAccount, listing: () => Promise<AvailableModel[]>) {
    return deps({ account: async () => account, subscriptionModels: listing });
  }

  it('runs grok’s default for newest:grok on an xAI seat, and records the alias beside it', async () => {
    const choice = await resolveTaskModel(
      bot({ name: 'grok', engine: 'grok', model: 'newest:grok' }),
      onSeat(XAI_SEAT, async () => GROK_SEAT),
    );

    expect(choice).toEqual({ model: 'grok-4.7', modelAlias: 'newest:grok', account: XAI_SEAT });
    // What the ledger's check constraint holds it to: the id called, the
    // alias beside it.
    expect(ledgerModel(choice.model, choice.modelAlias)).toEqual({ model: 'grok-4.7', modelAlias: 'newest:grok' });
  });

  it('runs the newest Opus a Claude seat lists, by Anthropic’s dates', async () => {
    const choice = await resolveTaskModel(bot({ model: 'newest:opus' }), onSeat(CLAUDE_SEAT_ACCOUNT, async () => CLAUDE_SEAT));

    expect(choice).toMatchObject({ model: 'claude-opus-5-5', modelAlias: 'newest:opus' });
  });

  it('fails a pinned id the seat does not offer, and names what it does', async () => {
    await expect(
      resolveTaskModel(bot({ name: 'grok', engine: 'grok', model: 'grok-4' }), onSeat(XAI_SEAT, async () => GROK_SEAT)),
    ).rejects.toThrow('this account cannot call grok-4 — its grok models are grok-4.7, grok-4.7-build-fast, grok-4.6, grok-4.5');
  });

  it('trusts a pinned id when the seat’s list cannot be had', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const choice = await resolveTaskModel(
      bot({ name: 'grok', engine: 'grok', model: 'grok-4.7' }),
      onSeat(XAI_SEAT, async () => {
        throw new Error('grok did not list models within 30 s');
      }),
    );

    // A seat that could not be asked is not a seat that is refused.
    expect(choice).toEqual({ model: 'grok-4.7', modelAlias: null, account: XAI_SEAT });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('using the configured id unverified'));
    warn.mockRestore();
  });

  it('fails an alias when the seat’s list cannot be had, in the lister’s words', async () => {
    await expect(
      resolveTaskModel(
        bot({ name: 'grok', engine: 'grok', model: 'newest:grok' }),
        onSeat(XAI_SEAT, async () => {
          throw new Error('You are not authenticated — sign this subscription in again from the accounts step');
        }),
      ),
    ).rejects.toThrow(/You are not authenticated/);
  });

  it('says an OpenAI seat cannot list models when a family reaches it', async () => {
    await expect(
      resolveTaskModel(bot({ name: 'cipher', engine: 'codex', model: 'newest:codex' }), onSeat(CODEX_SEAT, async () => [])),
    ).rejects.toThrow('an OpenAI subscription cannot list models, so newest:codex cannot be resolved — pin a model id');
  });
});
