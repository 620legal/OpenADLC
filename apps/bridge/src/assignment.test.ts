import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelAccount } from '@fleetadlc/db';
import type { Bot } from '@fleetadlc/shared';
import { join } from 'node:path';
import { assignBotModel, defaultAssignmentDeps, registerAssignmentRoutes, type AssignmentDeps } from './assignment.js';
import { Router } from './router.js';

const ACCOUNT = '550e8400-e29b-41d4-a716-446655440000';

function bot(partial: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    name: 'atlas',
    slot: 'builder',
    displayName: 'Builder',
    role: 'implement',
    engine: 'claude',
    model: 'claude-sonnet-5',
    githubLogin: null,
    hostId: null,
    container: 'bot-atlas',
    status: 'stopped',
    skills: [],
    sidecarDb: false,
    modelAccountId: null,
    modelSetAt: null,
    ...partial,
  };
}

function account(partial: Partial<ModelAccount> = {}): ModelAccount {
  return {
    id: ACCOUNT,
    provider: 'anthropic',
    kind: 'key',
    label: 'primary',
    createdAt: '2026-09-23T12:00:00.000Z',
    ...partial,
  };
}

function deps(overrides: Partial<AssignmentDeps> = {}): AssignmentDeps {
  return {
    listBots: vi.fn(async () => [bot()]),
    getAccount: vi.fn(async () => account()),
    setAssignment: vi.fn(async (_id, input) =>
      bot({ engine: input.engine, model: input.model, modelAccountId: input.modelAccountId }),
    ),
    recordAudit: vi.fn(async () => undefined),
    configured: vi.fn(() => null),
    ...overrides,
  };
}

describe('assigning a model from the console', () => {
  it('stores the alias and the account, and audits the choice rather than a secret', async () => {
    const used = deps();

    const result = await assignBotModel(
      { botName: 'atlas', model: 'newest:opus', modelAccountId: ACCOUNT, actor: 'ada' },
      used,
    );

    expect(used.setAssignment).toHaveBeenCalledWith('bot-1', {
      engine: 'claude',
      model: 'newest:opus',
      modelAccountId: ACCOUNT,
    });
    expect(result.bot.model).toBe('newest:opus');
    expect(used.recordAudit).toHaveBeenCalledWith({
      actor: 'ada',
      action: 'bot.model_assigned',
      target: 'atlas',
      payload: { model: 'newest:opus', modelAccountId: ACCOUNT, engine: 'claude' },
    });
    expect(JSON.stringify(vi.mocked(used.recordAudit).mock.calls)).not.toMatch(/sk-/);
  });

  it('keeps the account when only the model changes', async () => {
    const used = deps({
      listBots: vi.fn(async () => [bot({ modelAccountId: ACCOUNT })]),
    });

    await assignBotModel({ botName: 'atlas', model: 'claude-opus-5', actor: 'ada' }, used);

    expect(used.setAssignment).toHaveBeenCalledWith('bot-1', {
      engine: 'claude',
      model: 'claude-opus-5',
      modelAccountId: ACCOUNT,
    });
  });

  it('refuses a family the engine does not have, and writes nothing', async () => {
    const used = deps({ listBots: vi.fn(async () => [bot({ name: 'grok', engine: 'grok', model: 'grok-4' })]) });

    await expect(assignBotModel({ botName: 'grok', model: 'newest:opus', actor: 'ada' }, used)).rejects.toThrow(
      /no opus family/,
    );
    expect(used.setAssignment).not.toHaveBeenCalled();
  });

  it('refuses an account for the automation bot', async () => {
    const used = deps({
      listBots: vi.fn(async () => [bot({ name: 'flow', engine: 'none', model: 'none' })]),
    });

    await expect(
      assignBotModel({ botName: 'flow', modelAccountId: ACCOUNT, actor: 'ada' }, used),
    ).rejects.toThrow(/cannot be assigned an account/);
    expect(used.setAssignment).not.toHaveBeenCalled();
  });

  it('refuses a blank model', async () => {
    const used = deps();
    await expect(assignBotModel({ botName: 'atlas', model: '  ', actor: 'ada' }, used)).rejects.toThrow(/needs a model/);
    expect(used.setAssignment).not.toHaveBeenCalled();
  });

  it('moves the bot to the engine of another provider’s account, and says so in the audit', async () => {
    // The builder on Grok: refused until now as "claude runs on anthropic,
    // and this account is xai".
    const used = deps({ getAccount: vi.fn(async () => account({ provider: 'xai', kind: 'subscription' })) });

    const result = await assignBotModel(
      { botName: 'atlas', model: 'grok-4.7', modelAccountId: ACCOUNT, actor: 'ada' },
      used,
    );

    expect(used.setAssignment).toHaveBeenCalledWith('bot-1', { engine: 'grok', model: 'grok-4.7', modelAccountId: ACCOUNT });
    expect(result.bot.engine).toBe('grok');
    expect(used.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { model: 'grok-4.7', modelAccountId: ACCOUNT, engine: 'grok', previousEngine: 'claude' },
      }),
    );
  });

  it('keeps the bot’s engine when the account is taken away', async () => {
    const used = deps({ listBots: vi.fn(async () => [bot({ name: 'grok', engine: 'grok', model: 'grok-4', modelAccountId: ACCOUNT })]) });

    await assignBotModel({ botName: 'grok', model: 'grok-4', modelAccountId: null, actor: 'ada' }, used);

    expect(used.setAssignment).toHaveBeenCalledWith('bot-1', { engine: 'grok', model: 'grok-4', modelAccountId: null });
    expect(used.getAccount).not.toHaveBeenCalled();
  });

  it('refuses a model the account’s provider does not serve, and writes nothing', async () => {
    const used = deps({ getAccount: vi.fn(async () => account({ provider: 'xai' })) });

    await expect(
      assignBotModel({ botName: 'atlas', model: 'claude-opus-5', modelAccountId: ACCOUNT, actor: 'ada' }, used),
    ).rejects.toMatchObject({
      status: 400,
      message: 'claude-opus-5 is an Anthropic model, and this is an xAI account — grok takes grok-… ids or newest:grok',
    });
    expect(used.setAssignment).not.toHaveBeenCalled();
  });

  it('refuses a family on an OpenAI subscription the bot already has', async () => {
    // Only the model changes, so the account is the one on the row. Nothing
    // lists what a ChatGPT plan can call, so every task would then fail.
    const used = deps({
      listBots: vi.fn(async () => [bot({ name: 'cipher', engine: 'codex', model: 'gpt-5-codex', modelAccountId: ACCOUNT })]),
      getAccount: vi.fn(async () => account({ provider: 'openai', kind: 'subscription' })),
    });

    await expect(assignBotModel({ botName: 'cipher', model: 'newest:codex', actor: 'ada' }, used)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/pin a model id/),
    });
    expect(used.setAssignment).not.toHaveBeenCalled();
  });

  it('floats a family on a Claude subscription, which lists with its token', async () => {
    const used = deps({
      listBots: vi.fn(async () => [bot({ modelAccountId: ACCOUNT })]),
      getAccount: vi.fn(async () => account({ kind: 'subscription' })),
    });

    await assignBotModel({ botName: 'atlas', model: 'newest:opus', actor: 'ada' }, used);

    expect(used.setAssignment).toHaveBeenCalledWith('bot-1', { engine: 'claude', model: 'newest:opus', modelAccountId: ACCOUNT });
  });

  it('puts a bot an account moved back on its configured engine when the account is cleared', async () => {
    // cipher is configured for Codex, and an Anthropic account moved it to
    // Claude. With no account it would keep Claude and present its per-bot
    // key — an OpenAI key — to Anthropic.
    const used = deps({
      listBots: vi.fn(async () => [bot({ name: 'cipher', engine: 'claude', model: 'claude-opus-5', modelAccountId: ACCOUNT })]),
      configured: vi.fn(() => ({ engine: 'codex', model: 'gpt-5-codex' })),
    });

    const result = await assignBotModel({ botName: 'cipher', modelAccountId: null, actor: 'ada' }, used);

    expect(used.setAssignment).toHaveBeenCalledWith('bot-1', { engine: 'codex', model: 'gpt-5-codex', modelAccountId: null });
    expect(result.bot.engine).toBe('codex');
  });

  it('reads what the configuration gives a bot by its seat, not by the handle it goes by', async () => {
    // config/bots.yaml is keyed by seat. The security reviewer is connected as
    // fleetadlc-cipher-janedoe, and a lookup by that name found no entry — so a
    // cleared account left it on the engine the account had moved it to.
    const configured = vi.fn((seat: { slot: string }) =>
      seat.slot === 'security-reviewer' ? { engine: 'codex', model: 'gpt-5-codex' } : null,
    );
    const used = deps({
      listBots: vi.fn(async () => [
        bot({
          name: 'fleetadlc-cipher-janedoe',
          slot: 'security-reviewer',
          engine: 'claude',
          model: 'claude-opus-5',
          modelAccountId: ACCOUNT,
        }),
      ]),
      configured,
    });

    await assignBotModel({ botName: 'fleetadlc-cipher-janedoe', modelAccountId: null, actor: 'ada' }, used);

    expect(configured).toHaveBeenCalledWith({ slot: 'security-reviewer', role: 'implement' });
    expect(used.setAssignment).toHaveBeenCalledWith('bot-1', { engine: 'codex', model: 'gpt-5-codex', modelAccountId: null });
  });

  it('puts a seat added from settings back on its role’s configured engine, which the file gives by the first seat', async () => {
    // builder-2 has no entry of its own in config/bots.yaml, so clearing its
    // account left it on whatever engine the account had moved it to.
    const used = deps({
      listBots: vi.fn(async () => [
        bot({ name: 'builder-2', slot: 'builder-2', engine: 'grok', model: 'grok-4.7', modelAccountId: ACCOUNT }),
      ]),
      configured: defaultAssignmentDeps(join(__dirname, '..', '..', '..', 'config')).configured,
    });

    await assignBotModel({ botName: 'builder-2', modelAccountId: null, actor: 'ada' }, used);

    expect(used.setAssignment).toHaveBeenCalledWith('bot-1', { engine: 'claude', model: 'newest:opus', modelAccountId: null });
  });

  it('refuses a model of the old provider sent with the cleared account', async () => {
    const used = deps({
      listBots: vi.fn(async () => [bot({ name: 'cipher', engine: 'claude', model: 'claude-opus-5', modelAccountId: ACCOUNT })]),
      configured: vi.fn(() => ({ engine: 'codex', model: 'gpt-5-codex' })),
    });

    await expect(
      assignBotModel({ botName: 'cipher', model: 'claude-opus-5', modelAccountId: null, actor: 'ada' }, used),
    ).rejects.toMatchObject({ status: 400 });
    expect(used.setAssignment).not.toHaveBeenCalled();
  });

  it('leaves a bot already on its configured engine where it is when its account is cleared', async () => {
    const used = deps({
      listBots: vi.fn(async () => [bot({ modelAccountId: ACCOUNT })]),
      configured: vi.fn(() => ({ engine: 'claude', model: 'claude-sonnet-5' })),
    });

    await assignBotModel({ botName: 'atlas', model: 'claude-opus-5', modelAccountId: null, actor: 'ada' }, used);

    expect(used.setAssignment).toHaveBeenCalledWith('bot-1', { engine: 'claude', model: 'claude-opus-5', modelAccountId: null });
  });

  it('finds a seat renamed to its account’s handle by its seat, as the walkthrough still calls it', async () => {
    // Assigning an account renames a seat alone on it to the account's
    // handle, and the walkthrough then saves the model under the seat's old
    // name, which used to answer 404 for every seat.
    const used = deps({
      listBots: vi.fn(async () => [bot({ name: 'janedoe-builder', slot: 'builder' }), bot({ id: 'bot-2', name: 'lead-reviewer', slot: 'lead-reviewer' })]),
    });

    await assignBotModel({ botName: 'builder', model: 'newest:opus', actor: 'ada' }, used);

    expect(used.setAssignment).toHaveBeenCalledWith('bot-1', expect.objectContaining({ model: 'newest:opus' }));
    expect(used.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ target: 'janedoe-builder' }));
  });

  it('answers 404 for a name that is neither a bot’s nor a seat’s', async () => {
    const used = deps({ listBots: vi.fn(async () => [bot({ name: 'janedoe-builder', slot: 'builder' })]) });

    await expect(assignBotModel({ botName: 'reviewer', model: 'newest:opus', actor: 'ada' }, used)).rejects.toMatchObject({
      status: 404,
      message: 'no bot named reviewer',
    });
    // Nor a persona name for a seat: the console sends names it read from the crew.
    await expect(assignBotModel({ botName: 'atlas', model: 'newest:opus', actor: 'ada' }, used)).rejects.toMatchObject({ status: 404 });
    expect(used.setAssignment).not.toHaveBeenCalled();
  });

  it('answers 404 for an account that is not there', async () => {
    const used = deps({ getAccount: vi.fn(async () => null) });

    await expect(
      assignBotModel({ botName: 'atlas', modelAccountId: ACCOUNT, actor: 'ada' }, used),
    ).rejects.toMatchObject({ status: 404 });
    expect(used.setAssignment).not.toHaveBeenCalled();
  });
});

describe('the assignment route', () => {
  let server: Server;
  afterEach(
    () =>
      new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      }),
  );

  async function listening(used: AssignmentDeps): Promise<number> {
    const router = new Router();
    registerAssignmentRoutes(router, used);
    server = createServer((req, res) => {
      void router.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  function patch(port: number, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/v1/bots/atlas/assignment`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('takes the write the console sends', async () => {
    const used = deps();
    const port = await listening(used);

    const response = await patch(port, { model: 'newest:opus', modelAccountId: ACCOUNT });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { bot: { model: string } };
    expect(body.bot.model).toBe('newest:opus');
    expect(used.setAssignment).toHaveBeenCalledWith('bot-1', {
      engine: 'claude',
      model: 'newest:opus',
      modelAccountId: ACCOUNT,
    });
  });

  it('answers with the bot on the engine its new account puts it on', async () => {
    const used = deps({ getAccount: vi.fn(async () => account({ provider: 'openai' })) });
    const port = await listening(used);

    const response = await patch(port, { model: 'gpt-5-codex', modelAccountId: ACCOUNT });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { bot: { engine: string; model: string; modelAccountId: string } };
    expect(body.bot).toMatchObject({ engine: 'codex', model: 'gpt-5-codex', modelAccountId: ACCOUNT });
  });

  it('answers 400 with a sentence for a model the account cannot run', async () => {
    const used = deps({ getAccount: vi.fn(async () => account({ provider: 'openai' })) });
    const port = await listening(used);

    const response = await patch(port, { model: 'claude-opus-5', modelAccountId: ACCOUNT });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'claude-opus-5 is an Anthropic model, and this is an OpenAI account — codex takes gpt-…, o… and codex… ids or newest:codex',
    );
    expect(used.setAssignment).not.toHaveBeenCalled();
  });

  it('answers 400, not 500, for fields that are not strings', async () => {
    const used = deps();
    const port = await listening(used);

    for (const body of [{ model: 5 }, { model: ['claude-opus-5'] }, { modelAccountId: 7 }, null, ['claude-opus-5']]) {
      const response = await patch(port, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(used.setAssignment).not.toHaveBeenCalled();
  });
});
