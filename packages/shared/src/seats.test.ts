import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { botsFileSchema, loadYamlFile, parseYamlFile } from './config.js';
import { accountHolder, roleLabel } from './onboarding.js';
import {
  automationBotOf,
  builderOf,
  isBotName,
  isGitHubLogin,
  nameForLogin,
  nextSeat,
  resolveBotRef,
  seatForPersona,
} from './seats.js';
import type { BotRole } from './types.js';

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'bots.yaml');

function bot(name: string, slot: string, role: BotRole) {
  return { name, slot, role };
}

describe('the crew configuration', () => {
  const crew = loadYamlFile(CONFIG, botsFileSchema).bots;

  it('names a seat for every role, and no persona', () => {
    // The seats the migration maps the old personas onto have to be the seats
    // the file seeds, or an upgraded install would grow a second crew.
    expect(crew.map((entry) => [entry.slot, entry.role])).toEqual([
      ['intake', 'intake'],
      ['system-engineer', 'spec'],
      ['builder', 'implement'],
      ['lead-reviewer', 'review_lead'],
      ['second-reviewer', 'review_second'],
      ['security-reviewer', 'review_security'],
      ['sre', 'deploy'],
      ['qa', 'qa'],
      ['automation', 'automation'],
    ]);
  });

  it('reserves no account, and says seats rather than personas', () => {
    // `githubLogin: noraexampleco`, left from an earlier install, is what had
    // a fresh one refuse that account for the bot its operator meant it for.
    // Read raw: the schema drops a login and reads `name: atlas` as a seat, so
    // only the file itself can say it no longer has them.
    const raw = (parseYamlFile(CONFIG) as { bots: Record<string, unknown>[] }).bots;
    for (const entry of raw) {
      expect(Object.keys(entry)).not.toContain('githubLogin');
      expect(Object.keys(entry)).not.toContain('name');
      expect(typeof entry.slot).toBe('string');
    }
  });

  it('labels each bot by what it does, the way the console says it', () => {
    for (const entry of crew) {
      expect(entry.displayName.toLowerCase()).toBe(roleLabel(entry.role).toLowerCase());
    }
  });
});

describe('a crew file', () => {
  const one = {
    displayName: 'Builder',
    role: 'implement',
    engine: 'claude',
    model: 'claude-sonnet-5',
  };

  it('reads a file written before seats as the seats its personas were', () => {
    // An operator's edited copy still says `name: atlas-2`. Refusing it would
    // stop `fleetadlc up` seeding anything; guessing wrong would seed a second crew.
    const parsed = botsFileSchema.parse({
      bots: [
        { ...one, name: 'atlas' },
        { ...one, name: 'atlas-2' },
        { ...one, name: 'lens', githubLogin: 'fleetadlc-lens' },
      ],
    });
    expect(parsed.bots.map((entry) => entry.slot)).toEqual(['builder', 'builder-2', 'lens']);
    expect(parsed.bots[2]).not.toHaveProperty('githubLogin');
  });

  it('refuses two entries in one seat, and a seat no bot could be named', () => {
    expect(() => botsFileSchema.parse({ bots: [{ ...one, slot: 'builder' }, { ...one, slot: 'builder' }] })).toThrow(
      /seat of its own/,
    );
    expect(() => botsFileSchema.parse({ bots: [{ ...one, slot: 'Builder Two' }] })).toThrow(/lowercase/);
  });
});

describe('a bot name', () => {
  it('is a GitHub login, lowercased', () => {
    expect(isBotName('fleetadlc-atlas-janedoe')).toBe(true);
    expect(isGitHubLogin('JaneDoe')).toBe(true);
    for (const typed of ['jane doe', 'jane,bob', '@jane', 'jane-', 'a'.repeat(40)]) expect(isGitHubLogin(typed), typed).toBe(false);
    expect(isBotName('irisexampleco')).toBe(true);
    expect(isBotName('lead-reviewer')).toBe(true);
    expect(isBotName('FleetADLC-Atlas')).toBe(false);
    expect(isBotName('-fleetadlc')).toBe(false);
    expect(isBotName('fleetadlc-')).toBe(false);
    expect(isBotName('fleetadlc--atlas')).toBe(false);
    expect(isBotName('fleetadlc__atlas')).toBe(false);
    expect(isBotName('a'.repeat(39))).toBe(true);
    expect(isBotName('a'.repeat(40))).toBe(false);
  });

  it('is taken from the login GitHub answered with, whatever its casing', () => {
    expect(nameForLogin('FleetADLC-Atlas-Janedoe')).toBe('fleetadlc-atlas-janedoe');
  });
});

describe('which bot a reference means', () => {
  const crew = [
    bot('fleetadlc-atlas-janedoe', 'builder', 'implement'),
    bot('lead-reviewer', 'lead-reviewer', 'review_lead'),
    bot('janedoe-fleetadlc-flow', 'automation', 'automation'),
  ];

  it('is the bot of that name, then the bot in that seat', () => {
    expect(resolveBotRef(crew, 'fleetadlc-atlas-janedoe')?.slot).toBe('builder');
    expect(resolveBotRef(crew, 'builder')?.name).toBe('fleetadlc-atlas-janedoe');
    expect(resolveBotRef(crew, 'lead-reviewer')?.name).toBe('lead-reviewer');
  });

  it('reads a persona from older configuration as the seat it was', () => {
    expect(resolveBotRef(crew, 'atlas')?.name).toBe('fleetadlc-atlas-janedoe');
    expect(resolveBotRef(crew, 'sydney')?.name).toBe('lead-reviewer');
    expect(resolveBotRef(crew, 'atlas', { persona: false })).toBeNull();
    expect(resolveBotRef(crew, 'nobody')).toBeNull();
    expect(resolveBotRef(crew, '')).toBeNull();
  });

  it('maps every persona onto the seat of its role', () => {
    expect(
      ['mira', 'nova', 'atlas', 'atlas-3', 'sydney', 'grok', 'cipher', 'harbor', 'vega', 'flow', 'lens'].map(
        seatForPersona,
      ),
    ).toEqual([
      'intake',
      'system-engineer',
      'builder',
      'builder-3',
      'lead-reviewer',
      'second-reviewer',
      'security-reviewer',
      'sre',
      'qa',
      'automation',
      null,
    ]);
  });
});

describe('the automation bot', () => {
  const crew = [
    bot('fleetadlc-atlas-janedoe', 'builder', 'implement'),
    bot('janedoe-fleetadlc-flow', 'automation', 'automation'),
  ];

  it('is the bot whose role is automation, whatever it is called', () => {
    expect(automationBotOf(crew)?.name).toBe('janedoe-fleetadlc-flow');
    expect(automationBotOf(crew, null)?.name).toBe('janedoe-fleetadlc-flow');
  });

  it('is the one an override names, by seat or by name', () => {
    expect(automationBotOf(crew, 'builder')?.name).toBe('fleetadlc-atlas-janedoe');
    expect(automationBotOf(crew, 'fleetadlc-atlas-janedoe')?.name).toBe('fleetadlc-atlas-janedoe');
  });

  it('survives the `flow` every install.json was written with', () => {
    // FLEETADLC_AUTOMATION_BOT=flow is in the environment of every existing
    // install. Obeyed literally after the rename, no label would be written.
    expect(automationBotOf(crew, 'flow')?.name).toBe('janedoe-fleetadlc-flow');
    expect(automationBotOf(crew, 'nobody-here')?.name).toBe('janedoe-fleetadlc-flow');
  });
});

describe('the builder a repository belongs to', () => {
  it('is the bot in the builder seat, never the automation account', () => {
    const crew = [
      bot('janedoe-fleetadlc-flow', 'automation', 'automation'),
      bot('tessexampleco', 'builder-2', 'implement'),
      bot('fleetadlc-atlas-janedoe', 'builder', 'implement'),
    ];

    expect(builderOf(crew)?.name).toBe('fleetadlc-atlas-janedoe');
  });

  it('is the first other builder when the builder seat is gone, and nobody when there is no builder', () => {
    expect(
      builderOf([
        bot('builder-10', 'builder-10', 'implement'),
        bot('tessexampleco', 'builder-2', 'implement'),
        bot('janedoe-fleetadlc-flow', 'automation', 'automation'),
      ])?.name,
    ).toBe('tessexampleco');
    expect(builderOf([bot('janedoe-fleetadlc-flow', 'automation', 'automation')])).toBeNull();
  });
});

describe('the seat after this one', () => {
  it('numbers from two, and fills a gap', () => {
    expect(nextSeat('builder', ['builder'])).toBe('builder-2');
    expect(nextSeat('builder', ['builder', 'builder-2', 'builder-3'])).toBe('builder-4');
    expect(nextSeat('builder-2', ['builder', 'builder-2'])).toBe('builder-3');
    expect(nextSeat('builder', ['builder', 'builder-3'])).toBe('builder-2');
  });
});

describe('whose account an authorization is', () => {
  const crew = [
    { id: 'b-builder', name: 'fleetadlc-atlas-janedoe', role: 'implement' as const, githubLogin: 'fleetadlc-atlas-janedoe', connected: true },
    // An earlier install's row: it names an account and holds nothing.
    { id: 'b-lead', name: 'sydney', role: 'review_lead' as const, githubLogin: 'noraexampleco', connected: false },
    { id: 'b-se', name: 'nova', role: 'spec' as const, githubLogin: null, connected: false },
  ];

  it('is another bot only when that bot is connected as it', () => {
    expect(accountHolder('FleetADLC-Atlas-Janedoe', 'b-se', crew)?.id).toBe('b-builder');
  });

  it('is nobody when the account is only named on an unconnected row', () => {
    // The refusal the owner hit: nova approved as noraexampleco, which
    // sydney's row named from a file an earlier install left behind.
    expect(accountHolder('noraexampleco', 'b-se', crew)).toBeNull();
  });

  it('does not count the bot being connected, or an account nobody has', () => {
    expect(accountHolder('fleetadlc-atlas-janedoe', 'b-builder', crew)).toBeNull();
    expect(accountHolder('someone-new', 'b-se', crew)).toBeNull();
  });
});
