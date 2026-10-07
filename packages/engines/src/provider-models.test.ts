import { describe, expect, it, vi } from 'vitest';
import { checkModelAssignment, newestIn, PROVIDER_ENGINE, resolveModel } from './model-choice.js';
import { ProviderKeyRejected, botCanRun, listProviderModels, type ModelProvider } from './provider-models.js';

const KEY = 'sk-ant-test-key-do-not-store';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('refusing a key that cannot list models', () => {
  it('quotes the provider and does not echo the key', async () => {
    const fetchImpl = async () =>
      json(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } });

    await expect(listProviderModels('anthropic', KEY, fetchImpl as typeof fetch)).rejects.toThrow(ProviderKeyRejected);
    await expect(listProviderModels('anthropic', KEY, fetchImpl as typeof fetch)).rejects.toThrow(/invalid x-api-key/);

    try {
      await listProviderModels('anthropic', KEY, fetchImpl as typeof fetch);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderKeyRejected);
      expect((error as Error).message).not.toContain(KEY);
      expect((error as ProviderKeyRejected).status).toBe(400);
    }
  });

  it('refuses a key the provider answers with an empty list', async () => {
    const fetchImpl = async () => json(200, { data: [], has_more: false });

    await expect(listProviderModels('openai', KEY, fetchImpl as typeof fetch)).rejects.toThrow(
      /openai listed no models/,
    );
  });

  it('does not leave part of an echoed key where the message is cut', async () => {
    // A proxy page that echoes the header, with the key straddling the cut.
    const page = `${'x'.repeat(276)} Authorization: ${KEY}`;
    const fetchImpl = async () => new Response(page, { status: 502 });

    const error = await listProviderModels('anthropic', KEY, fetchImpl as typeof fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderKeyRejected);
    expect((error as Error).message).not.toContain(KEY.slice(0, 8));
  });

  it('uses the body when the provider did not send JSON', async () => {
    const fetchImpl = async () => new Response('nope, not a key', { status: 403 });

    await expect(listProviderModels('xai', KEY, fetchImpl as typeof fetch)).rejects.toThrow(/nope, not a key/);
  });
});

describe('what a working key can call', () => {
  it('asks Anthropic /v1/models with the key in a header, and follows the pages', async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe(KEY);
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      expect(url).not.toContain(KEY);

      if (!url.includes('after_id')) {
        return json(200, {
          data: [{ id: 'claude-opus-4-8', display_name: 'Opus 4.8', created_at: '2026-01-15T00:00:00Z', type: 'model' }],
          has_more: true,
          last_id: 'claude-opus-4-8',
        });
      }
      return json(200, {
        data: [{ id: 'claude-opus-5', display_name: 'Opus 5', created_at: '2026-04-01T00:00:00Z', type: 'model' }],
        has_more: false,
        last_id: 'claude-opus-5',
      });
    };

    const models = await listProviderModels('anthropic', KEY, fetchImpl as typeof fetch);

    expect(urls[0]).toBe('https://api.anthropic.com/v1/models?limit=100');
    expect(urls[1]).toContain('after_id=claude-opus-4-8');
    expect(models).toEqual([
      { id: 'claude-opus-4-8', createdAt: '2026-01-15T00:00:00Z' },
      { id: 'claude-opus-5', createdAt: '2026-04-01T00:00:00Z' },
    ]);
  });

  it('reads an OpenAI-shaped list, including xAI, as id and createdAt', async () => {
    const seen: { provider: ModelProvider; authorization: string | null; url: string }[] = [];
    const fetchImpl = (provider: ModelProvider) => async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ provider, authorization: headers.get('authorization'), url: String(input) });
      return json(200, {
        object: 'list',
        data: [{ id: provider === 'openai' ? 'gpt-5' : 'grok-4', object: 'model', created: 1_715_367_049, owned_by: provider }],
      });
    };

    const openai = await listProviderModels('openai', KEY, fetchImpl('openai') as typeof fetch);
    const xai = await listProviderModels('xai', KEY, fetchImpl('xai') as typeof fetch);

    expect(openai).toEqual([{ id: 'gpt-5', createdAt: new Date(1_715_367_049 * 1000).toISOString() }]);
    expect(xai[0]?.id).toBe('grok-4');
    expect(seen.map((call) => call.url)).toEqual(['https://api.openai.com/v1/models', 'https://api.x.ai/v1/models']);
    expect(seen.every((call) => call.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(seen.every((call) => !call.url.includes('after_id'))).toBe(true);
  });
});

describe('what a Claude subscription can call', () => {
  // The token `claude setup-token` prints. Anthropic lists models for it as a
  // bearer token under the OAuth beta, and refuses it as an x-api-key.
  const TOKEN = 'sk-ant-oat01-a-subscription-token-do-not-store';

  it('asks with the token as a bearer, under the OAuth beta, and follows the pages', async () => {
    const urls: string[] = [];
    const seen: Headers[] = [];
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      seen.push(new Headers(init?.headers));
      if (!url.includes('after_id')) {
        return json(200, {
          data: [{ id: 'claude-opus-5-5', created_at: '2026-09-01T00:00:00Z', type: 'model' }],
          has_more: true,
          last_id: 'claude-opus-5-5',
        });
      }
      return json(200, {
        data: [{ id: 'claude-haiku-4-5-20251001', created_at: '2025-10-01T00:00:00Z', type: 'model' }],
        has_more: false,
        last_id: 'claude-haiku-4-5-20251001',
      });
    };

    const models = await listProviderModels('anthropic', TOKEN, fetchImpl as typeof fetch, { auth: 'oauth' });

    expect(models).toEqual([
      { id: 'claude-opus-5-5', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'claude-haiku-4-5-20251001', createdAt: '2025-10-01T00:00:00Z' },
    ]);
    expect(urls).toEqual([
      'https://api.anthropic.com/v1/models?limit=100',
      'https://api.anthropic.com/v1/models?limit=100&after_id=claude-opus-5-5',
    ]);
    for (const headers of seen) {
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20');
      // Presented as a key, the same token is refused.
      expect(headers.get('x-api-key')).toBeNull();
    }
    expect(urls.some((url) => url.includes(TOKEN))).toBe(false);
  });

  it('quotes a refusal of the token without the token', async () => {
    const fetchImpl = async () =>
      json(401, { type: 'error', error: { type: 'authentication_error', message: `OAuth token ${TOKEN} has expired` } });

    const error = await listProviderModels('anthropic', TOKEN, fetchImpl as typeof fetch, { auth: 'oauth' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ProviderKeyRejected);
    expect((error as Error).message).toBe('OAuth token [redacted] has expired');
  });

  it('says a subscription listed nothing in terms of its token, not a key', async () => {
    const fetchImpl = async () => json(200, { data: [], has_more: false });

    await expect(
      listProviderModels('anthropic', TOKEN, fetchImpl as typeof fetch, { auth: 'oauth' }),
    ).rejects.toThrow('anthropic listed no models for this token');
  });

  it('is not how an OpenAI or xAI subscription is asked, and asks nothing', async () => {
    // Their credential is the CLI's own sign-in; there is no token to send.
    const fetchImpl = vi.fn(async () => json(200, { data: [{ id: 'gpt-5' }] }));

    for (const provider of ['openai', 'xai'] as const) {
      await expect(
        listProviderModels(provider, TOKEN, fetchImpl as unknown as typeof fetch, { auth: 'oauth' }),
      ).rejects.toThrow(/has no token to list models with/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('only what a bot can run', () => {
  // No recorded OpenAI /v1/models response is in the repository. This one has
  // its shape, and its ids are the ones a real key's list was seen to
  // hold, plus the chat, reasoning and codex ids that list carried beside them.
  const OPENAI_LIST = {
    object: 'list',
    data: (
      [
        // What a bot can think with.
        ['gpt-5', 1_754_425_777],
        ['gpt-5-2025-08-07', 1_754_425_867],
        ['gpt-5-mini', 1_754_425_928],
        ['gpt-5-nano', 1_754_426_384],
        ['gpt-5-pro', 1_759_469_707],
        ['gpt-5-chat-latest', 1_754_073_306],
        ['gpt-5-codex', 1_757_527_818],
        ['gpt-5.1', 1_762_800_000],
        ['gpt-5.1-codex', 1_762_988_221],
        ['gpt-5.1-codex-mini', 1_763_007_109],
        ['gpt-4.1', 1_744_316_542],
        ['gpt-4o', 1_715_367_049],
        ['gpt-4o-mini', 1_721_172_741],
        ['o3', 1_744_225_308],
        ['o4-mini', 1_744_225_351],
        ['codex-mini-latest', 1_746_673_257],
        ['ft:gpt-4o-mini-2024-07-18:acme::B1x2y3z4', 1_750_000_000],
        // Speech and audio.
        ['tts-1', 1_681_940_951],
        ['whisper-1', 1_677_532_384],
        ['gpt-audio', 1_756_339_249],
        ['gpt-audio-mini', 1_759_512_027],
        ['gpt-realtime', 1_756_271_701],
        ['gpt-realtime-mini', 1_759_517_133],
        ['gpt-4o-transcribe', 1_742_068_463],
        ['gpt-4o-mini-transcribe', 1_742_068_596],
        ['gpt-4o-mini-tts', 1_742_403_959],
        ['gpt-4o-audio-preview', 1_727_460_443],
        ['gpt-4o-realtime-preview', 1_727_659_998],
        // Images and video.
        ['gpt-image-1', 1_745_517_030],
        ['gpt-image-1-mini', 1_758_845_821],
        ['chatgpt-image-latest', 1_760_000_000],
        ['sora-2', 1_759_708_615],
        ['sora-2-pro', 1_759_708_663],
        ['dall-e-3', 1_698_785_189],
        // Embeddings and moderation.
        ['text-embedding-3-large', 1_705_953_180],
        ['text-embedding-3-small', 1_705_948_997],
        ['omni-moderation-latest', 1_731_689_265],
        ['omni-moderation-2024-09-26', 1_732_734_466],
        // Legacy completions.
        ['babbage-002', 1_692_634_615],
        ['davinci-002', 1_692_634_301],
        ['gpt-3.5-turbo-instruct', 1_692_901_427],
        ['gpt-3.5-turbo-instruct-0914', 1_694_122_472],
        // Search previews.
        ['gpt-4o-search-preview', 1_741_388_720],
        ['gpt-4o-mini-search-preview', 1_741_391_161],
        ['gpt-5-search-api', 1_758_000_000],
        ['gpt-5-search-api-2025-10-14', 1_760_400_000],
        // Deep research, which needs a web search tool Codex does not give it.
        ['o3-deep-research', 1_748_907_000],
        // ChatGPT's own chat model, which the assignment check does not give Codex.
        ['chatgpt-4o-latest', 1_723_515_131],
      ] as const
    ).map(([id, created]) => ({ id, object: 'model', created, owned_by: 'system' })),
  };

  const RUNNABLE = [
    'gpt-5',
    'gpt-5-2025-08-07',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-5-pro',
    'gpt-5-chat-latest',
    'gpt-5-codex',
    'gpt-5.1',
    'gpt-5.1-codex',
    'gpt-5.1-codex-mini',
    'gpt-4.1',
    'gpt-4o',
    'gpt-4o-mini',
    'o3',
    'o4-mini',
    'codex-mini-latest',
    'ft:gpt-4o-mini-2024-07-18:acme::B1x2y3z4',
  ];

  it('keeps an OpenAI key’s chat, reasoning and codex models, and nothing else it lists', async () => {
    const fetchImpl = async () => json(200, OPENAI_LIST);

    const models = await listProviderModels('openai', KEY, fetchImpl as typeof fetch);

    expect(models.map((model) => model.id)).toEqual(RUNNABLE);
  });

  it('follows codex to its base model, not the mini dated after it', async () => {
    // gpt-5.1-codex-mini is dated after gpt-5.1-codex, and `newest:codex`,
    // the lead reviewer's default, resolved to it.
    const models = await listProviderModels('openai', KEY, (async () => json(200, OPENAI_LIST)) as typeof fetch);

    expect(resolveModel('newest:codex', models).resolved).toBe('gpt-5.1-codex');
    expect(newestIn('codex-mini', models)).toBe('gpt-5.1-codex-mini');
  });

  it('leaves out a family it has never seen, rather than one it was told about', () => {
    for (const id of ['gpt-video-1', 'gpt-voice', 'sora-3', 'kling-1', 'gpt-next']) {
      expect(botCanRun('openai', id)).toBe(false);
    }
    expect(botCanRun('openai', 'gpt-6')).toBe(true);
    expect(botCanRun('openai', 'gpt-6-codex-max')).toBe(true);
    expect(botCanRun('openai', 'o5-pro')).toBe(true);
  });

  // No recorded xAI list is in the repository either. These are ids xAI's
  // /v1/models has listed: its chat models, and grok-2-image-1212 and the
  // Imagine models beside them.
  const XAI_IDS = [
    'grok-4.7',
    'grok-4.7-build-fast',
    'grok-4-0709',
    'grok-4-fast-reasoning',
    'grok-4-fast-non-reasoning',
    'grok-3-mini',
    'grok-code-fast-1',
    'grok-2-vision-1212',
    'grok-2-image-1212',
    'grok-imagine-image',
    'grok-imagine-video',
  ];
  const xaiList = async () =>
    json(200, { object: 'list', data: XAI_IDS.map((id) => ({ id, object: 'model', created: 1_750_000_000, owned_by: 'xai' })) });

  const ANTHROPIC_IDS = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-3-7-sonnet-latest'];
  const anthropicList = async () =>
    json(200, { data: ANTHROPIC_IDS.map((id) => ({ id, created_at: '2026-01-01T00:00:00Z', type: 'model' })), has_more: false });

  it('does the same to xAI’s list, where image and video models sit beside the chat ones', async () => {
    const models = await listProviderModels('xai', KEY, xaiList as typeof fetch);

    expect(models.map((model) => model.id)).toEqual(XAI_IDS.slice(0, 8));
  });

  it('leaves Anthropic’s list as it is', async () => {
    const models = await listProviderModels('anthropic', KEY, anthropicList as typeof fetch);

    expect(models.map((model) => model.id)).toEqual(ANTHROPIC_IDS);
  });

  it('keeps only what the assignment check then accepts', async () => {
    // The picker offered `chatgpt-4o-latest` for an OpenAI key, and the check
    // that stores a choice refused it: two rules for one question. Every id
    // kept here has to be one a bot on that account may be given.
    const lists: [ModelProvider, typeof fetch][] = [
      ['openai', (async () => json(200, OPENAI_LIST)) as typeof fetch],
      ['xai', xaiList as typeof fetch],
      ['anthropic', anthropicList as typeof fetch],
    ];
    for (const [provider, fetchImpl] of lists) {
      const account = { id: `${provider}-key`, provider, kind: 'key' as const };
      for (const model of await listProviderModels(provider, KEY, fetchImpl)) {
        expect(() => checkModelAssignment(PROVIDER_ENGINE[provider], model.id, account), model.id).not.toThrow();
      }
    }
  });

  it('refuses a key that lists models, none of which a bot can use', async () => {
    const fetchImpl = async () =>
      json(200, { object: 'list', data: [{ id: 'whisper-1', created: 1 }, { id: 'tts-1', created: 2 }] });

    const error = await listProviderModels('openai', KEY, fetchImpl as typeof fetch).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderKeyRejected);
    expect((error as Error).message).toMatch(/openai listed 2 models for this key, and none a bot can use/);
  });
});
