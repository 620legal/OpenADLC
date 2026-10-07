import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountInUse, type ModelAccount } from '@fleetadlc/db';
import { modelAccountRef, type SecretStore } from '@fleetadlc/github';
import { ProviderKeyRejected, modelListCache } from '@fleetadlc/engines';
import {
  addModelAccount,
  listAccountModels,
  registerModelAccountRoutes,
  removeModelAccount,
  replaceModelAccountKey,
  type ModelAccountDeps,
  type ModelAccountLogins,
} from './model-accounts.js';
import { Router } from './router.js';

const ACCOUNT_ID = '550e8400-e29b-41d4-a716-446655440000';
const KEY = 'sk-ant-pasted-key';
const NINE = ['atlas', 'bramble', 'cedar', 'dune', 'ember', 'finch', 'grove', 'harbor', 'iris'];

function account(partial: Partial<ModelAccount> = {}): ModelAccount {
  return {
    id: ACCOUNT_ID,
    provider: 'anthropic',
    kind: 'key',
    label: 'primary',
    createdAt: '2026-09-23T12:00:00.000Z',
    ...partial,
  };
}

function memory(): SecretStore & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    async get(ref) {
      return saved.get(ref) ?? null;
    },
    async set(ref, value) {
      saved.set(ref, value);
    },
    async delete(ref) {
      saved.delete(ref);
    },
    async list(prefix = '') {
      return [...saved.keys()].filter((ref) => ref.startsWith(prefix)).sort();
    },
  };
}

type Overrides = Partial<Omit<ModelAccountDeps, 'secrets' | 'accounts'>> & {
  accounts?: Partial<ModelAccountDeps['accounts']>;
};

function deps(overrides: Overrides = {}, secrets = memory()) {
  const { accounts: accountOverrides, ...rest } = overrides;
  return {
    listModels: vi.fn(async () => [{ id: 'claude-opus-5', createdAt: '2026-04-01T00:00:00Z' }]),
    recordAudit: vi.fn(async () => undefined),
    ...rest,
    accounts: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => account()),
      create: vi.fn(async () => account()),
      remove: vi.fn(async () => undefined),
      recordVerification: vi.fn(async (_id: string, check: { checkedAt: string; error: string | null }) =>
        account({ verifiedAt: check.checkedAt, verifyError: check.error }),
      ),
      clearVerification: vi.fn(async () => undefined),
      ...accountOverrides,
    },
    secrets,
  };
}

function mentionsKey(value: unknown, key = KEY): boolean {
  return JSON.stringify(value).includes(key);
}

describe('adding an account', () => {
  it('refuses a key that cannot list models and stores nothing', async () => {
    const used = deps({
      listModels: vi.fn(async () => {
        throw new ProviderKeyRejected('invalid x-api-key');
      }),
    });

    await expect(
      addModelAccount({ provider: 'anthropic', kind: 'key', label: 'primary', key: KEY, actor: 'ada' }, used),
    ).rejects.toThrow(/invalid x-api-key/);

    expect(used.accounts.create).not.toHaveBeenCalled();
    expect(used.secrets.saved.size).toBe(0);
    expect(used.recordAudit).not.toHaveBeenCalled();
  });

  it('stores a verified key once, under the account ref, and audits no value', async () => {
    const used = deps();
    const added = await addModelAccount(
      { provider: 'anthropic', kind: 'key', label: 'primary', key: KEY, actor: 'ada' },
      used,
    );

    expect(added.models.map((model) => model.id)).toEqual(['claude-opus-5']);
    expect(used.secrets.saved.get(modelAccountRef(ACCOUNT_ID))).toBe(KEY);
    expect(used.secrets.saved.size).toBe(1);

    const audited = vi.mocked(used.recordAudit).mock.calls[0]?.[0];
    expect(audited).toMatchObject({ action: 'model_account.added', target: ACCOUNT_ID });
    expect(mentionsKey(audited)).toBe(false);
    expect(mentionsKey(added.account)).toBe(false);
  });

  it('stores no secret for a subscription that came with none', async () => {
    const used = deps({
      accounts: {
        get: vi.fn(async () => account({ kind: 'subscription' })),
        create: vi.fn(async () => account({ kind: 'subscription', label: 'Claude Max' })),
      },
    });

    const added = await addModelAccount(
      { provider: 'anthropic', kind: 'subscription', label: 'Claude Max', actor: 'ada' },
      used,
    );

    expect(added.account.kind).toBe('subscription');
    expect(added.models).toEqual([]);
    expect(used.listModels).not.toHaveBeenCalled();
    expect(used.secrets.saved.size).toBe(0);
    expect(mentionsKey(vi.mocked(used.recordAudit).mock.calls)).toBe(false);
  });

  it('refuses a key pasted onto an OpenAI or xAI subscription, whose credential is its sign-in', async () => {
    const used = deps({ accounts: { create: vi.fn(async () => account({ provider: 'openai', kind: 'subscription' })) } });

    for (const provider of ['openai', 'xai']) {
      await expect(
        addModelAccount({ provider, kind: 'subscription', label: 'seat', key: 'sk-proj-pasted', actor: 'ada' }, used),
      ).rejects.toThrow(/stores no key — its credential is the sign-in/);
    }
    expect(used.accounts.create).not.toHaveBeenCalled();
    expect(used.secrets.saved.size).toBe(0);
  });

  it('does not replace a working key when the new one cannot list models', async () => {
    const secrets = memory();
    await secrets.set(modelAccountRef(ACCOUNT_ID), 'sk-still-good');
    const used = deps(
      {
        listModels: vi.fn(async () => {
          throw new ProviderKeyRejected('invalid x-api-key');
        }),
      },
      secrets,
    );

    await expect(replaceModelAccountKey({ id: ACCOUNT_ID, key: KEY, actor: 'ada' }, used)).rejects.toThrow(
      /invalid x-api-key/,
    );
    expect(secrets.saved.get(modelAccountRef(ACCOUNT_ID))).toBe('sk-still-good');
    expect(used.recordAudit).not.toHaveBeenCalled();
  });
});

describe('deleting an account', () => {
  it('refuses while bots use it, names them, and leaves the secret', async () => {
    const secrets = memory();
    await secrets.set(modelAccountRef(ACCOUNT_ID), KEY);
    const used = deps(
      {
        accounts: {
          list: vi.fn(async () => []),
          get: vi.fn(async () => account()),
          create: vi.fn(async () => account()),
          remove: vi.fn(async () => {
            throw new AccountInUse(NINE);
          }),
        },
      },
      secrets,
    );

    await expect(removeModelAccount({ id: ACCOUNT_ID, actor: 'ada' }, used)).rejects.toThrow(/atlas/);
    await expect(removeModelAccount({ id: ACCOUNT_ID, actor: 'ada' }, used)).rejects.toThrow(/iris/);
    expect(secrets.saved.get(modelAccountRef(ACCOUNT_ID))).toBe(KEY);
    expect(used.recordAudit).not.toHaveBeenCalled();
  });
});

describe('the paste, over HTTP', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  });

  async function start(used: ModelAccountDeps): Promise<string> {
    const router = new Router();
    registerModelAccountRoutes(router, used);
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  it('returns the provider’s words and writes no secret', async () => {
    const used = deps({
      listModels: vi.fn(async () => {
        throw new ProviderKeyRejected(`invalid x-api-key`);
      }),
    });
    const base = await start(used);

    const response = await fetch(`${base}/v1/model-accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', kind: 'key', label: 'primary', key: KEY }),
    });
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain('invalid x-api-key');
    expect(body.error).not.toContain(KEY);
    expect(used.secrets.saved.size).toBe(0);
  });

  it('refuses a delete that names the bots still using the account', async () => {
    const used = deps({
      accounts: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => account()),
        create: vi.fn(async () => account()),
        remove: vi.fn(async () => {
          throw new AccountInUse(['atlas', 'nova']);
        }),
      },
    });
    const base = await start(used);

    const response = await fetch(`${base}/v1/model-accounts/${ACCOUNT_ID}/remove`, { method: 'POST' });
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(body.error).toContain('atlas');
    expect(body.error).toContain('nova');
  });

  it('lists the models a stored key can call, and not the key', async () => {
    const secrets = memory();
    await secrets.set(modelAccountRef(ACCOUNT_ID), KEY);
    const used = deps({}, secrets);
    const base = await start(used);

    const response = await fetch(`${base}/v1/model-accounts/${ACCOUNT_ID}/models`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      models: [{ id: 'claude-opus-5', createdAt: '2026-04-01T00:00:00Z', isDefault: false }],
      // Only the families the list has a model in: newest:haiku on an
      // account that lists no Haiku would fail every task it was given.
      aliases: ['newest:opus'],
    });
    expect(mentionsKey(body)).toBe(false);
  });

  it('lists nothing for an OpenAI subscription, floats nothing, and asks nobody', async () => {
    const logins = hostd();
    const used = deps({ logins, accounts: { get: vi.fn(async () => CODEX_SEAT) } });
    const base = await start(used);

    const response = await fetch(`${base}/v1/model-accounts/${ACCOUNT_ID}/models`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: [], aliases: [] });
    expect(used.listModels).not.toHaveBeenCalled();
    expect(logins.accountModels).not.toHaveBeenCalled();
  });

  it('answers a listing that failed with a 502 in the provider’s words, not an empty list', async () => {
    const secrets = memory();
    await secrets.set(modelAccountRef(ACCOUNT_ID), KEY);
    const used = deps(
      {
        listModels: vi.fn(async () => {
          throw new ProviderKeyRejected(`invalid x-api-key ${KEY}`);
        }),
      },
      secrets,
    );
    const base = await start(used);

    const response = await fetch(`${base}/v1/model-accounts/${ACCOUNT_ID}/models`);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'invalid x-api-key [redacted]' });
  });

  it('answers a malformed body or id with a 4xx, not a 500', async () => {
    const used = deps();
    const base = await start(used);

    const wrongType = await fetch(`${base}/v1/model-accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 7, kind: 'key', label: 'primary', key: KEY }),
    });
    expect(wrongType.status).toBe(400);

    const notAnId = await fetch(`${base}/v1/model-accounts/not-a-uuid/remove`, { method: 'POST' });
    expect(notAnId.status).toBe(404);
    // Refused before the database is asked, which is where the 500 came from.
    expect(used.accounts.get).not.toHaveBeenCalled();
  });
});

describe('listing models for a picker', () => {
  it('refuses a key account with nothing stored, without asking the provider', async () => {
    // A 409, not an empty list: an empty list would read as "this key can
    // call nothing", and the picker would offer only what was already stored.
    const used = deps();

    await expect(listAccountModels(ACCOUNT_ID, used)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/no key stored/),
    });
    expect(used.listModels).not.toHaveBeenCalled();
  });

  it('quotes a provider refusal without the key', async () => {
    const used = deps({
      listModels: vi.fn(async () => {
        throw new Error(`rejected ${KEY}`);
      }),
    });
    await used.secrets.set(modelAccountRef(ACCOUNT_ID), KEY);

    await expect(listAccountModels(ACCOUNT_ID, used)).rejects.toMatchObject({ status: 502, message: 'rejected [redacted]' });
  });

  it('puts the newest first, by the provider’s dates, and names the families the key can float', async () => {
    const used = deps({
      accounts: { get: vi.fn(async () => account({ provider: 'openai' })) },
      listModels: vi.fn(async () => [
        { id: 'gpt-5', createdAt: '2025-08-07T00:00:00.000Z' },
        { id: 'gpt-5-codex', createdAt: '2026-05-01T00:00:00.000Z' },
      ]),
    });
    await used.secrets.set(modelAccountRef(ACCOUNT_ID), 'sk-proj-a-key');

    expect(await listAccountModels(ACCOUNT_ID, used)).toEqual({
      models: [
        { id: 'gpt-5-codex', createdAt: '2026-05-01T00:00:00.000Z', isDefault: false },
        { id: 'gpt-5', createdAt: '2025-08-07T00:00:00.000Z', isDefault: false },
      ],
      aliases: ['newest:codex'],
    });
  });

  it('remembers a list for a few minutes, so a picker opened twice asks once', async () => {
    const used = deps({ cache: modelListCache() });
    await used.secrets.set(modelAccountRef(ACCOUNT_ID), KEY);

    await listAccountModels(ACCOUNT_ID, used);
    await listAccountModels(ACCOUNT_ID, used);

    expect(used.listModels).toHaveBeenCalledTimes(1);
  });

  it('asks again once the key is rotated, rather than offering the old key’s models', async () => {
    const used = deps({ cache: modelListCache() });
    await used.secrets.set(modelAccountRef(ACCOUNT_ID), KEY);
    await listAccountModels(ACCOUNT_ID, used);

    await replaceModelAccountKey({ id: ACCOUNT_ID, key: 'sk-ant-api03-another-key', actor: 'ada' }, used);
    vi.mocked(used.listModels).mockClear();
    await listAccountModels(ACCOUNT_ID, used);

    expect(used.listModels).toHaveBeenCalledTimes(1);
    expect(vi.mocked(used.listModels).mock.calls[0]?.[1]).toBe('sk-ant-api03-another-key');
  });

  it('answers 404 for an id that is not an account id, before the database is asked', async () => {
    const used = deps();

    await expect(listAccountModels('not-a-uuid', used)).rejects.toMatchObject({ status: 404 });
    expect(used.accounts.get).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ subscriptions

const TOKEN = 'sk-ant-oat01-Zm9vYmFyYmF6cXV4LXRoZS10b2tlbg';
const SEAT = account({ kind: 'subscription', label: 'Claude Max' });
const CODEX_SEAT = account({ provider: 'openai', kind: 'subscription', label: 'ChatGPT Pro' });

function hostd(overrides: Partial<ModelAccountLogins> = {}): ModelAccountLogins & Record<string, ReturnType<typeof vi.fn>> {
  return {
    startLogin: vi.fn(async () => ({
      state: 'waiting' as const,
      url: 'https://auth.openai.com/codex/device',
      code: 'URPK-DI1GG',
      startedAt: '2026-09-24T08:00:00.000Z',
    })),
    loginStatus: vi.fn(async () => ({ state: 'signed-in' as const })),
    forgetLogin: vi.fn(async () => undefined),
    verifyAccount: vi.fn(async () => ({ ok: true, message: 'answered: OK', checkedAt: '2026-09-24T08:00:00.000Z' })),
    accountModels: vi.fn(async () => ({
      models: [
        { id: 'grok-4.6', createdAt: null, isDefault: false },
        { id: 'grok-4.7', createdAt: null, isDefault: true },
        { id: 'grok-4.7-build-fast', createdAt: null, isDefault: false },
      ],
    })),
    ...overrides,
  } as ModelAccountLogins & Record<string, ReturnType<typeof vi.fn>>;
}

describe('a Claude subscription’s token', () => {
  it('is stored as the account’s secret when it comes with the account, and audited only as a fact', async () => {
    const used = deps({ accounts: { create: vi.fn(async () => SEAT) } });

    const added = await addModelAccount(
      { provider: 'anthropic', kind: 'subscription', label: 'Claude Max', key: `${TOKEN}\n`, actor: 'ada' },
      used,
    );

    expect(used.secrets.saved.get(modelAccountRef(ACCOUNT_ID))).toBe(TOKEN);
    expect(used.listModels).not.toHaveBeenCalled();
    const audited = vi.mocked(used.recordAudit).mock.calls[0]?.[0];
    expect(audited?.payload).toMatchObject({ tokenStored: true });
    expect(mentionsKey(audited, TOKEN)).toBe(false);
    expect(mentionsKey(added, TOKEN)).toBe(false);
  });

  it('is refused, naming what was expected, when it is not what `claude setup-token` prints', async () => {
    const used = deps({ accounts: { create: vi.fn(async () => SEAT) } });
    const wrapped = `${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)}`;

    for (const paste of ['sk-ant-api03-an-api-key-instead', wrapped, 'sk-ant-oat01 with spaces']) {
      await expect(
        addModelAccount({ provider: 'anthropic', kind: 'subscription', label: 'Claude Max', key: paste, actor: 'ada' }, used),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('claude setup-token') });
    }
    // Refused before the row, so a bad paste leaves nothing behind.
    expect(used.accounts.create).not.toHaveBeenCalled();
    expect(used.secrets.saved.size).toBe(0);
  });

  it('is replaced at the same ref, and the last check is forgotten with the old one', async () => {
    const secrets = memory();
    await secrets.set(modelAccountRef(ACCOUNT_ID), 'sk-ant-oat01-the-old-one');
    const used = deps({ accounts: { get: vi.fn(async () => ({ ...SEAT, verifiedAt: '2026-09-20T00:00:00Z', verifyError: null })) } }, secrets);

    const replaced = await replaceModelAccountKey({ id: ACCOUNT_ID, key: TOKEN, actor: 'ada' }, used);

    expect(secrets.saved.get(modelAccountRef(ACCOUNT_ID))).toBe(TOKEN);
    expect(used.accounts.clearVerification).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(replaced.account).toMatchObject({ verifiedAt: null, verifyError: null });
    const audited = vi.mocked(used.recordAudit).mock.calls[0]?.[0];
    expect(audited).toMatchObject({ action: 'model_account.token_set', target: ACCOUNT_ID });
    expect(mentionsKey(audited, TOKEN)).toBe(false);
  });

  it('keeps the old one when the replacement is not a token', async () => {
    const secrets = memory();
    await secrets.set(modelAccountRef(ACCOUNT_ID), TOKEN);
    const used = deps({ accounts: { get: vi.fn(async () => SEAT) } }, secrets);

    await expect(replaceModelAccountKey({ id: ACCOUNT_ID, key: '  ', actor: 'ada' }, used)).rejects.toMatchObject({
      status: 400,
    });
    expect(secrets.saved.get(modelAccountRef(ACCOUNT_ID))).toBe(TOKEN);
    expect(used.accounts.clearVerification).not.toHaveBeenCalled();
  });

  it('is not something an OpenAI or xAI seat takes', async () => {
    const used = deps({ accounts: { get: vi.fn(async () => CODEX_SEAT) } });

    await expect(replaceModelAccountKey({ id: ACCOUNT_ID, key: 'sk-proj-x', actor: 'ada' }, used)).rejects.toThrow(
      /stores no key — its credential is the sign-in/,
    );
    expect(used.secrets.saved.size).toBe(0);
  });
});

describe('removing a subscription', () => {
  it('tells hostd to forget an OpenAI seat’s login once the row is gone', async () => {
    const order: string[] = [];
    const logins = hostd({ forgetLogin: vi.fn(async () => void order.push('forget')) });
    const used = deps({
      logins,
      accounts: { get: vi.fn(async () => CODEX_SEAT), remove: vi.fn(async () => void order.push('row')) },
    });

    await removeModelAccount({ id: ACCOUNT_ID, actor: 'ada' }, used);

    expect(logins.forgetLogin).toHaveBeenCalledWith(ACCOUNT_ID, 'ada');
    expect(order).toEqual(['row', 'forget']);
  });

  it('leaves the login alone when the removal is refused', async () => {
    const logins = hostd();
    const used = deps({
      logins,
      accounts: {
        get: vi.fn(async () => CODEX_SEAT),
        remove: vi.fn(async () => {
          throw new AccountInUse(['quill']);
        }),
      },
    });

    await expect(removeModelAccount({ id: ACCOUNT_ID, actor: 'ada' }, used)).rejects.toThrow(/quill/);
    expect(logins.forgetLogin).not.toHaveBeenCalled();
  });

  it('is still removed when hostd cannot forget the login right now', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logins = hostd({ forgetLogin: vi.fn(async () => Promise.reject(new Error('hostd is not answering'))) });
    const used = deps({ logins, accounts: { get: vi.fn(async () => CODEX_SEAT) } });

    await expect(removeModelAccount({ id: ACCOUNT_ID, actor: 'ada' }, used)).resolves.toEqual({ id: ACCOUNT_ID });
  });

  it('deletes a Claude seat’s token, which is its only credential', async () => {
    const secrets = memory();
    await secrets.set(modelAccountRef(ACCOUNT_ID), TOKEN);
    const logins = hostd();
    const used = deps({ logins, accounts: { get: vi.fn(async () => SEAT) } }, secrets);

    await removeModelAccount({ id: ACCOUNT_ID, actor: 'ada' }, used);

    expect(secrets.saved.size).toBe(0);
    expect(logins.forgetLogin).not.toHaveBeenCalled();
  });
});

describe('signing in and checking, over HTTP', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  });

  async function start(used: ModelAccountDeps): Promise<string> {
    const router = new Router();
    registerModelAccountRoutes(router, used);
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  it('starts an OpenAI seat’s sign-in on hostd, for the person asking, and hands back the link and code', async () => {
    const logins = hostd();
    const base = await start(deps({ logins, accounts: { get: vi.fn(async () => CODEX_SEAT) } }));

    const response = await fetch(`${base}/v1/model-accounts/${ACCOUNT_ID}/login`, {
      method: 'POST',
      headers: { 'x-fleetadlc-identity': 'ada' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'waiting', code: 'URPK-DI1GG' });
    expect(logins.startLogin).toHaveBeenCalledWith(ACCOUNT_ID, 'ada');
  });

  it('says where a sign-in stands', async () => {
    const logins = hostd();
    const base = await start(deps({ logins, accounts: { get: vi.fn(async () => CODEX_SEAT) } }));

    const response = await fetch(`${base}/v1/model-accounts/${ACCOUNT_ID}/login`);

    expect(await response.json()).toEqual({ state: 'signed-in' });
  });

  it('refuses to sign in a key account or a Claude seat, and says what those take instead', async () => {
    const logins = hostd();
    const keyBase = await start(deps({ logins }));
    const keyAnswer = await fetch(`${keyBase}/v1/model-accounts/${ACCOUNT_ID}/login`, { method: 'POST' });
    expect(keyAnswer.status).toBe(400);
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    const seatBase = await start(deps({ logins, accounts: { get: vi.fn(async () => SEAT) } }));
    const seatAnswer = await fetch(`${seatBase}/v1/model-accounts/${ACCOUNT_ID}/login`, { method: 'POST' });
    expect(seatAnswer.status).toBe(400);
    expect(((await seatAnswer.json()) as { error: string }).error).toContain('claude setup-token');
    expect(logins.startLogin).not.toHaveBeenCalled();
  });

  it('answers 404 for an id that is not an account id, before the database or hostd is asked', async () => {
    const logins = hostd();
    const used = deps({ logins });
    const base = await start(used);

    for (const [method, path] of [
      ['POST', 'login'],
      ['GET', 'login'],
      ['POST', 'verify'],
    ] as const) {
      const response = await fetch(`${base}/v1/model-accounts/not-a-uuid/${path}`, { method });
      expect(response.status).toBe(404);
    }
    expect(used.accounts.get).not.toHaveBeenCalled();
    expect(logins.startLogin).not.toHaveBeenCalled();
    expect(logins.verifyAccount).not.toHaveBeenCalled();
  });

  it('says so when there is no hostd to ask', async () => {
    const base = await start(deps({ accounts: { get: vi.fn(async () => CODEX_SEAT) } }));

    const response = await fetch(`${base}/v1/model-accounts/${ACCOUNT_ID}/login`, { method: 'POST' });

    expect(response.status).toBe(503);
  });

  it('records a passing check on the row and answers with the account', async () => {
    const logins = hostd();
    const used = deps({ logins, accounts: { get: vi.fn(async () => CODEX_SEAT) } });
    const base = await start(used);

    const response = await fetch(`${base}/v1/model-accounts/${ACCOUNT_ID}/verify`, { method: 'POST' });
    const body = (await response.json()) as { ok: boolean; account: ModelAccount };

    expect(body.ok).toBe(true);
    expect(used.accounts.recordVerification).toHaveBeenCalledWith(ACCOUNT_ID, {
      checkedAt: '2026-09-24T08:00:00.000Z',
      error: null,
    });
    expect(body.account).toMatchObject({ verifiedAt: '2026-09-24T08:00:00.000Z', verifyError: null });
  });

  it('records a failing one in the CLI’s words, with the stored secret taken out once more', async () => {
    const secrets = memory();
    await secrets.set(modelAccountRef(ACCOUNT_ID), TOKEN);
    const logins = hostd({
      verifyAccount: vi.fn(async () => ({
        ok: false,
        message: `OAuth token ${TOKEN} is invalid.`,
        checkedAt: '2026-09-24T08:00:00.000Z',
      })),
    });
    const used = deps({ logins, accounts: { get: vi.fn(async () => SEAT) } }, secrets);
    const base = await start(used);

    const response = await fetch(`${base}/v1/model-accounts/${ACCOUNT_ID}/verify`, { method: 'POST' });
    const body = (await response.json()) as { ok: boolean; message: string };

    expect(body).toMatchObject({ ok: false, message: 'OAuth token [redacted] is invalid.' });
    expect(used.accounts.recordVerification).toHaveBeenCalledWith(ACCOUNT_ID, {
      checkedAt: '2026-09-24T08:00:00.000Z',
      error: 'OAuth token [redacted] is invalid.',
    });
    expect(mentionsKey(body, TOKEN)).toBe(false);
  });

  it('takes a Claude seat’s token on /key and answers without it', async () => {
    const used = deps({ accounts: { get: vi.fn(async () => SEAT) } });
    const base = await start(used);

    const response = await fetch(`${base}/v1/model-accounts/${ACCOUNT_ID}/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: TOKEN }),
    });

    expect(response.status).toBe(200);
    expect(mentionsKey(await response.json(), TOKEN)).toBe(false);
    expect(used.secrets.saved.get(modelAccountRef(ACCOUNT_ID))).toBe(TOKEN);

    const wrongType = await fetch(`${base}/v1/model-accounts/${ACCOUNT_ID}/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 7 }),
    });
    expect(wrongType.status).toBe(400);
  });
});

describe('what a subscription can call, for a picker', () => {
  const GROK_SEAT = account({ provider: 'xai', kind: 'subscription', label: 'SuperGrok' });

  it('lists a Claude seat’s models with its token, the way Anthropic lists a subscription’s', async () => {
    const secrets = memory();
    await secrets.set(modelAccountRef(ACCOUNT_ID), TOKEN);
    const listModels = vi.fn(async () => [
      { id: 'claude-haiku-4-5-20251001', createdAt: '2025-10-01T00:00:00Z' },
      { id: 'claude-opus-5-5', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'claude-sonnet-5', createdAt: '2026-03-01T00:00:00Z' },
    ]);
    const used = deps({ listModels, accounts: { get: vi.fn(async () => SEAT) } }, secrets);

    const listed = await listAccountModels(ACCOUNT_ID, used);

    expect(listModels).toHaveBeenCalledWith('anthropic', TOKEN, undefined, { auth: 'oauth' });
    expect(listed).toEqual({
      models: [
        { id: 'claude-opus-5-5', createdAt: '2026-09-01T00:00:00Z', isDefault: false },
        { id: 'claude-sonnet-5', createdAt: '2026-03-01T00:00:00Z', isDefault: false },
        { id: 'claude-haiku-4-5-20251001', createdAt: '2025-10-01T00:00:00Z', isDefault: false },
      ],
      aliases: ['newest:opus', 'newest:sonnet', 'newest:haiku'],
    });
    expect(mentionsKey(listed, TOKEN)).toBe(false);
  });

  it('answers a refused token with a 502, without the token', async () => {
    const secrets = memory();
    await secrets.set(modelAccountRef(ACCOUNT_ID), TOKEN);
    const used = deps(
      {
        listModels: vi.fn(async () => {
          throw new ProviderKeyRejected(`OAuth token ${TOKEN} has expired`);
        }),
        accounts: { get: vi.fn(async () => SEAT) },
      },
      secrets,
    );

    await expect(listAccountModels(ACCOUNT_ID, used)).rejects.toMatchObject({
      status: 502,
      message: 'OAuth token [redacted] has expired',
    });
  });

  it('says a Claude seat with no token stored has nothing to list with', async () => {
    const used = deps({ accounts: { get: vi.fn(async () => SEAT) } });

    await expect(listAccountModels(ACCOUNT_ID, used)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('claude setup-token'),
    });
    expect(used.listModels).not.toHaveBeenCalled();
  });

  it('asks hostd for an xAI seat’s models, and puts grok’s default first', async () => {
    const logins = hostd();
    const used = deps({ logins, accounts: { get: vi.fn(async () => GROK_SEAT) } });

    const listed = await listAccountModels(ACCOUNT_ID, used);

    expect(logins.accountModels).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(used.listModels).not.toHaveBeenCalled();
    expect(listed).toEqual({
      models: [
        { id: 'grok-4.7', createdAt: null, isDefault: true },
        { id: 'grok-4.7-build-fast', createdAt: null, isDefault: false },
        { id: 'grok-4.6', createdAt: null, isDefault: false },
      ],
      aliases: ['newest:grok'],
    });
  });

  it('passes on hostd’s failure to list an xAI seat, with its status', async () => {
    const logins = hostd({
      accountModels: vi.fn(async () =>
        Promise.reject(
          Object.assign(new Error('You are not authenticated — sign this subscription in again from the accounts step'), {
            status: 502,
          }),
        ),
      ),
    });
    const used = deps({ logins, accounts: { get: vi.fn(async () => GROK_SEAT) } });

    await expect(listAccountModels(ACCOUNT_ID, used)).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/^You are not authenticated/),
    });
  });

  it('says there is no hostd to ask, rather than listing nothing', async () => {
    const used = deps({ accounts: { get: vi.fn(async () => GROK_SEAT) } });

    await expect(listAccountModels(ACCOUNT_ID, used)).rejects.toMatchObject({ status: 503 });
  });
});
