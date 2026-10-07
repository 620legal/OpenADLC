import { describe, expect, it } from 'vitest';
import { botInWords } from '../../../../packages/shared/src/bot-words';
import { roleLabel } from '../../../../packages/shared/src/onboarding';
import { BOT_ROLES } from '../../../../packages/shared/src/types';
import { ROLES, atStart, botLabel, findBot, isSeat, labelIn, seatFor, type BotFacts } from './bot-label';

/** The names the crew used to carry. None of them is anybody's account. */
const PERSONAS = ['mira', 'nova', 'atlas', 'sydney', 'grok', 'cipher', 'harbor', 'vega', 'flow'];

/** One bot, the second reviewer, as each view the console reads describes it. */
const UNCONNECTED: Record<string, BotFacts> = {
  onboarding: {
    bot: 'second-reviewer',
    slot: 'second-reviewer',
    role: 'review_second',
    roleLabel: 'second reviewer',
    connected: false,
    // What the bridge would suggest. It is nobody's account yet.
    login: 'fleetadlc-second-reviewer',
    profile: null,
  },
  engines: { bot: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', roleLabel: 'second reviewer' },
  crew: {
    name: 'second-reviewer',
    slot: 'second-reviewer',
    role: 'review_second',
    authorization: 'unauthorized',
    githubLogin: null,
  },
};

const CONNECTED: Record<string, BotFacts> = {
  onboarding: {
    bot: 'irisexampleco',
    slot: 'second-reviewer',
    role: 'review_second',
    roleLabel: 'second reviewer',
    connected: true,
    login: 'irisexampleco',
    profile: { login: 'irisexampleco' },
  },
  engines: { bot: 'irisexampleco', slot: 'second-reviewer', role: 'review_second', roleLabel: 'second reviewer' },
  crew: {
    name: 'irisexampleco',
    slot: 'second-reviewer',
    role: 'review_second',
    authorization: 'active',
    githubLogin: 'irisexampleco',
  },
};

describe('what a bot is called', () => {
  it('is its role and the handle of its account once one is connected', () => {
    for (const facts of Object.values(CONNECTED)) {
      expect(botLabel(facts)).toEqual({
        name: 'irisexampleco',
        said: 'the second reviewer (irisexampleco)',
        text: 'second reviewer (irisexampleco)',
        role: 'second reviewer',
        asRole: 'the second reviewer',
        handle: 'irisexampleco',
      });
    }
  });

  it('is its role before that — not its seat, and not the username suggested for it', () => {
    for (const facts of Object.values(UNCONNECTED)) {
      const label = botLabel(facts);
      expect(label).toEqual({
        name: 'second reviewer',
        said: 'the second reviewer',
        text: 'second reviewer — not connected yet',
        role: 'second reviewer',
        asRole: 'the second reviewer',
        handle: null,
      });
      expect(JSON.stringify(label)).not.toContain('second-reviewer');
    }
  });

  it('keeps the handle while the credential has expired, since the account is still the bot’s', () => {
    expect(botLabel({ ...CONNECTED.crew, authorization: 'expired' }).text).toBe('second reviewer (irisexampleco)');
    expect(botLabel({ ...CONNECTED.onboarding }).handle).toBe('irisexampleco');
  });

  it('names a bot the bridge has not renamed yet by the account that connected, not by its seat', () => {
    const label = botLabel({ bot: 'builder', slot: 'builder', role: 'implement', connected: true, login: 'janedoe-fleetadlc-builder' });
    expect(label.text).toBe('builder (janedoe-fleetadlc-builder)');
  });

  it('never shows a persona name, whatever an older bridge still calls the bot', () => {
    const older: BotFacts[] = [
      // Unconnected, with the login config/bots.yaml set aside for it.
      { bot: 'atlas', role: 'implement', roleLabel: 'builder', connected: false, login: 'fleetadlc-atlas' },
      { name: 'grok', role: 'review_second', authorization: 'unauthorized', githubLogin: 'fleetadlc-grok' },
      { name: 'flow', role: 'automation', authorization: 'unauthorized', githubLogin: 'fleetadlc-flow-janedoe' },
      // Connected: the account that authorized is who it is.
      { bot: 'sydney', role: 'review_lead', roleLabel: 'lead reviewer', connected: true, login: 'noraexampleco' },
      { name: 'cipher', role: 'review_security', authorization: 'active', githubLogin: 'janedoe-fleetadlc-cipher' },
    ];
    const labels = older.map(botLabel);

    expect(labels.map((label) => label.text)).toEqual([
      'builder — not connected yet',
      'second reviewer — not connected yet',
      'automation — not connected yet',
      'lead reviewer (noraexampleco)',
      'security reviewer (janedoe-fleetadlc-cipher)',
    ]);
    for (const label of labels) {
      for (const persona of PERSONAS) {
        expect([label.name, label.said, label.text, label.role, label.asRole]).not.toContain(persona);
        expect(label.text.split(/[ ·—()]+/)).not.toContain(persona);
      }
    }
  });

  it('numbers the second seat of a role, so two builders are not one', () => {
    expect(botLabel({ name: 'builder-2', slot: 'builder-2', role: 'implement', authorization: 'unauthorized' })).toMatchObject({
      text: 'builder 2 — not connected yet',
      said: 'builder 2',
    });
    expect(botLabel({ name: 'janedoe-fleetadlc-builder-2', slot: 'builder-2', role: 'implement' }).text).toBe(
      'builder 2 (janedoe-fleetadlc-builder-2)',
    );
    expect(atStart(botLabel({ name: 'builder-2', slot: 'builder-2', role: 'implement', authorization: 'unauthorized' }).said)).toBe(
      'Builder 2',
    );
    expect(botLabel({ name: 'builder', slot: 'builder', role: 'implement', authorization: 'unauthorized' }).text).toBe(
      'builder — not connected yet',
    );
  });

  it('reads a name that arrives alone as a seat when it is one, and as a handle when it is not', () => {
    expect(botLabel({ name: 'lead-reviewer' }).text).toBe('lead reviewer — not connected yet');
    expect(botLabel({ name: 'sre' }).text).toBe('SRE — not connected yet');
    expect(botLabel({ name: 'irisexampleco' })).toMatchObject({ name: 'irisexampleco', text: 'irisexampleco', handle: 'irisexampleco' });
    expect(isSeat('builder-2')).toBe(true);
    expect(isSeat('builder-1')).toBe(false);
    expect(isSeat('janedoe-fleetadlc-builder')).toBe(false);
  });

  it('says a role in a sentence the way a person would', () => {
    expect(botLabel({ name: 'intake', role: 'intake', authorization: 'unauthorized' }).said).toBe('the intake bot');
    expect(botLabel({ name: 'qa', role: 'qa', authorization: 'unauthorized' }).said).toBe('the QA bot');
    expect(botLabel({ name: 'sre', role: 'deploy', authorization: 'unauthorized' }).said).toBe('the SRE');
    // The label itself is the role alone.
    expect(botLabel({ name: 'automation', role: 'automation', authorization: 'unauthorized' }).name).toBe('automation');
    expect(atStart('the lead reviewer has no OpenAI account.')).toBe('The lead reviewer has no OpenAI account.');
    expect(atStart('irisexampleco has no OpenAI account.')).toBe('irisexampleco has no OpenAI account.');
  });
});

describe('finding a bot that arrives as a name', () => {
  const crew = [CONNECTED.crew, { name: 'builder', slot: 'builder', role: 'implement', authorization: 'unauthorized' }];

  it('finds it by its name, by the seat it has left, and by its account', () => {
    expect(findBot(crew, 'irisexampleco')).toBe(crew[0]);
    // A notification written before it connected links to the seat.
    expect(findBot(crew, 'second-reviewer')).toBe(crew[0]);
    expect(findBot(crew, 'IRISEXAMPLECO')).toBe(crew[0]);
    expect(findBot(crew, 'builder')).toBe(crew[1]);
    expect(findBot(crew, 'nobody')).toBeUndefined();
  });

  it('labels it from the crew, and from the name alone when the crew does not know it', () => {
    expect(labelIn(crew, 'second-reviewer').text).toBe('second reviewer (irisexampleco)');
    expect(labelIn(crew, 'builder').text).toBe('builder — not connected yet');
    expect(labelIn([], 'qa').text).toBe('QA — not connected yet');
    expect(labelIn([], 'somebody').text).toBe('somebody');
  });
});

describe('the seat a username is made from', () => {
  it('is the role’s seat, never the bot’s name', () => {
    expect(seatFor(UNCONNECTED.onboarding)).toBe('second-reviewer');
    expect(seatFor(CONNECTED.onboarding)).toBe('second-reviewer');
    expect(seatFor({ bot: 'builder-2' })).toBe('builder-2');
    // An older bridge's persona, read by its role.
    expect(seatFor({ bot: 'atlas', role: 'implement', roleLabel: 'builder' })).toBe('builder');
    expect(seatFor({ bot: 'sydney', roleLabel: 'lead reviewer' })).toBe('lead-reviewer');
  });
});

describe('the console’s copy of the roles', () => {
  it('words every role the way the bridge does', () => {
    expect(Object.keys(ROLES).sort()).toEqual([...BOT_ROLES].sort());
    for (const role of BOT_ROLES) expect(ROLES[role].label).toBe(roleLabel(role));
  });

  it('gives every role a seat of its own', () => {
    const seats = Object.values(ROLES).map((role) => role.seat);
    expect(new Set(seats).size).toBe(seats.length);
    for (const seat of seats) expect(isSeat(seat)).toBe(true);
  });
});

describe('a seat on an account other seats share', () => {
  it('is connected, by its account, though it keeps its seat’s name', () => {
    const label = botLabel({ name: 'builder', slot: 'builder', role: 'implement', githubLogin: 'irisexampleco', authorization: 'active' });
    expect(label.handle).toBe('irisexampleco');
    expect(label.text).toBe('builder (irisexampleco)');
  });

  it('is still not connected when the crew says it has no account', () => {
    expect(botLabel({ name: 'builder', slot: 'builder', role: 'implement', githubLogin: null, authorization: 'unauthorized' }).handle).toBeNull();
  });
});

describe('the console’s words and the bridge’s', () => {
  it('say a bot the same way in a sentence, so a card and the page it opens agree', () => {
    const bots = [
      { name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second', githubLogin: 'irisexampleco', authorization: 'active' },
      { name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: null, authorization: 'unauthorized' },
      { name: 'intake', slot: 'intake', role: 'intake', githubLogin: null, authorization: 'unauthorized' },
      { name: 'janedoe-qa', slot: 'qa', role: 'qa', githubLogin: 'janedoe-qa', authorization: 'active' },
      { name: 'builder-2', slot: 'builder-2', role: 'implement', githubLogin: null, authorization: 'unauthorized' },
      { name: 'janedoe-b2', slot: 'builder-2', role: 'implement', githubLogin: 'janedoe-b2', authorization: 'active' },
    ];
    for (const bot of bots) expect(botLabel(bot).said).toBe(botInWords(bot));
  });
});
