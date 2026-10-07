import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which bot the bridge acts as for labels, statuses and reviewer requests.
 * Every one of those used to name `config.automationBot` — `flow` on every
 * install — which is nobody once the automation seat takes its account's
 * handle.
 */

const world = vi.hoisted(() => ({
  crew: [] as { name: string; slot: string; role: string }[],
  settings: {} as Record<string, string>,
}));

vi.mock('@fleetadlc/db', () => ({
  spendingLimits: {
    SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
    GLOBAL_SCOPE: 'global',
    seedGlobal: vi.fn(async () => false),
    effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
    amountOf: vi.fn(async () => null),
    refusal: vi.fn(async () => null),
    listLimits: vi.fn(async () => []),
    setLimit: vi.fn(async () => undefined),
    dollars: (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`),
    botKind: (id: string) => `month_bot:${id}`,
    providerKind: (provider: string) => `month_provider:${provider}`,
    repoScope: (id: string) => `repo:${id}`,
    repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
  },

  bots: { listBots: vi.fn(async () => world.crew) },
  settings: { allSettings: vi.fn(async () => world.settings) },
}));

import { bots } from '@fleetadlc/db';
import { asAutomation, automationBot, automationBotName, findOwnOpenIssue } from './automation-bot.js';

const config = (automationBot: string | null) =>
  ({ automationBot, gitHubClientId: '', webhookSecret: '', humans: [], organization: '', publicUrl: '' }) as never;

beforeEach(() => {
  world.settings = {};
  world.crew = [
    { name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement' },
    { name: 'janedoe-fleetadlc-flow', slot: 'automation', role: 'automation' },
  ];
});

describe('the automation account', () => {
  it('is the bot whose role is automation, by the handle it goes by now', async () => {
    expect(await automationBotName(config(null))).toBe('janedoe-fleetadlc-flow');
  });

  it('is still that bot for the `flow` every install.json was written with', async () => {
    expect(await automationBotName(config('flow'))).toBe('janedoe-fleetadlc-flow');
  });

  it('is the bot an override names by seat, and the console’s setting wins over the environment', async () => {
    expect(await automationBotName(config('builder'))).toBe('fleetadlc-atlas-janedoe');
    world.settings = { automationBot: 'automation' };
    expect(await automationBotName(config('builder'))).toBe('janedoe-fleetadlc-flow');
  });

  it('is the seat named, not an empty string, when the crew cannot be read', async () => {
    const gone = new Error('database gone');
    vi.mocked(bots.listBots).mockRejectedValueOnce(gone).mockRejectedValueOnce(gone);
    expect(await automationBot(config(null))).toBeNull();
    expect(await automationBotName(config(null))).toBe('automation');
  });

  it('is the seat named when no bot has the automation role', async () => {
    world.crew = [];
    expect(await automationBot(config(null))).toBeNull();
    expect(await automationBotName(config(null))).toBe('automation');
  });

  it('is who the bridge acts as', async () => {
    const asBot = vi.fn(async (name: string) => ({ actingAs: name }) as never);
    await asAutomation({ asBot }, config('flow'));
    expect(asBot).toHaveBeenCalledWith('janedoe-fleetadlc-flow');
  });
});

/**
 * What an alert, a job's report and a failed deploy are checked against
 * before they are filed again: an open issue OpenADLC's own account filed
 * that carries the marker. A stranger's issue carrying it kept the notice
 * from ever being filed, and one page of everyone's issues lost OpenADLC's
 * own past the first hundred.
 */
describe('the open issue OpenADLC already filed', () => {
  const MARKER = '<!-- fleetadlc:job:credential-health -->';

  function github(pages: { number: number; body: string; user: { login: string } }[][]) {
    const asked: string[] = [];
    return {
      asked,
      client: {
        request: async <T>(_method: string, path: string): Promise<T> => {
          asked.push(path);
          const page = Number(new URL(path, 'https://api.github.com').searchParams.get('page'));
          return (pages[page - 1] ?? []) as T;
        },
      },
    };
  }
  const own = (number: number, body = '') => ({ number, body, user: { login: 'flowexampleco' } });

  it('is found on the second page of the account’s own open issues', async () => {
    const { client, asked } = github([Array.from({ length: 100 }, (_, index) => own(index + 1)), [own(150, `It failed.\n\n${MARKER}`)]]);

    expect(await findOwnOpenIssue(client, 'exampleco/testbed', 'flowexampleco', 'job', 'credential-health')).toBe(150);
    expect(asked).toEqual([
      '/repos/exampleco/testbed/issues?state=open&creator=flowexampleco&per_page=100&page=1',
      '/repos/exampleco/testbed/issues?state=open&creator=flowexampleco&per_page=100&page=2',
    ]);
  });

  it('is never another login’s, whatever it carries', async () => {
    const { client } = github([[{ number: 5, body: MARKER, user: { login: 'stranger' } }]]);

    expect(await findOwnOpenIssue(client, 'exampleco/testbed', 'flowexampleco', 'job', 'credential-health')).toBeNull();
  });

  it('is nobody’s when the account’s login is unknown, so the notice is filed', async () => {
    const { client, asked } = github([[own(5, MARKER)]]);

    expect(await findOwnOpenIssue(client, 'exampleco/testbed', null, 'job', 'credential-health')).toBeNull();
    expect(asked).toEqual([]);
  });
});
