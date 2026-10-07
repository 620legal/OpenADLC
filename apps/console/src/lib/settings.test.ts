import { describe, expect, it } from 'vitest';
import { STAGE_MODES } from './stages';
import { accountState, buildersOf, hashSection, modeOf, repoSettingsPath, sectionBeingRead, SETTINGS_SECTIONS, stageChoices, stageLine, tasksAtOnceLine } from './settings';

describe('what a stage may do without asking', () => {
  it('is said in words, and offers only modes the bridge has', () => {
    // Only Design has a choice; "Waits for you" did nothing on any stage.
    expect(stageChoices('intake', 'autonomous')).toEqual([{ mode: 'autonomous', label: 'On its own' }]);
    expect(stageChoices('spec', 'conditional')).toEqual([
      { mode: 'autonomous', label: 'Always' },
      { mode: 'conditional', label: 'When it matters' },
    ]);
    for (const stage of ['intake', 'spec', 'build', 'review', 'merged'] as const) {
      for (const choice of stageChoices(stage, 'autonomous')) expect(STAGE_MODES).toContain(choice.mode);
    }
  });

  it('offers “When it matters” on Design alone: it is the one stage a change can skip', () => {
    for (const stage of ['intake', 'build', 'review', 'merged'] as const) {
      expect(stageChoices(stage, 'autonomous').map((choice) => choice.mode)).not.toContain('conditional');
    }
  });

  it('shows an Intake or Design nobody staffs as it is, and never offers that to one that is staffed', () => {
    expect(stageChoices('spec', 'untouched').at(-1)).toEqual({ mode: 'untouched', label: 'Never' });
    expect(stageChoices('intake', 'untouched').at(-1)).toEqual({ mode: 'untouched', label: 'No bot' });
    expect(stageChoices('spec', 'autonomous').map((choice) => choice.mode)).not.toContain('untouched');
  });

  it('never offers untouched for a later stage, where no bot reads it', () => {
    for (const stage of ['build', 'review', 'merged'] as const) {
      expect(stageChoices(stage, 'untouched').map((choice) => choice.mode), stage).not.toContain('untouched');
    }
  });

  it('reads a stage with nothing stored as the bridge does', () => {
    expect(modeOf({}, 'spec')).toBe('conditional');
    expect(modeOf({}, 'merged')).toBe('autonomous');
    // An older bridge may still send assist, which is what autonomous is.
    expect(modeOf({ merged: 'assist' }, 'merged')).toBe('autonomous');
  });

  it('says what Review does from the crew and the round limit', () => {
    expect(stageLine('review', { reviewers: 3, maxReviewRounds: 3 })).toBe(
      'Three reviewers on different models, the lead last; stops after 3 rounds that do not agree',
    );
    expect(stageLine('review', { reviewers: 0, maxReviewRounds: null })).toBe('Reviewers on different models, the lead last; stops when they cannot agree');
  });
});

describe('tasks at once', () => {
  it('is what the builders run at once between them, each by its own tasks at once, and says how to run more', () => {
    // One task per builder held a repository at one build per seat; a seat
    // runs as many as its tasks at once now, each in a computer of its own.
    const crew = [{ role: 'implement', maxTasks: 3 }, { role: 'review_lead', maxTasks: 2 }, { role: 'implement' }];
    expect(buildersOf({ role: 'implement' }, crew)).toBe(4);
    expect(tasksAtOnceLine(1)).toBe('Its builder runs one task at a time. Raise its tasks at once on the Crew page, or add a builder, to run two.');
    expect(tasksAtOnceLine(4)).toBe('Its builders can run four tasks at once between them, each in a computer of its own.');
  });
});

describe('a bot’s GitHub account', () => {
  it('is connected, needs connecting again, or is not connected', () => {
    expect(accountState({ name: 'irisexampleco', slot: 'second-reviewer', authorization: 'active' })).toEqual({
      text: 'Connected',
      tone: 'signal',
      action: 'Reconnect',
    });
    expect(accountState({ name: 'irisexampleco', slot: 'second-reviewer', authorization: 'expired' }).text).toBe('Needs reconnecting');
    expect(accountState({ name: 'irisexampleco', slot: 'second-reviewer', authorization: 'revoked' }).action).toBe('Reconnect');
    expect(accountState({ name: 'lead-reviewer', slot: 'lead-reviewer', authorization: 'unauthorized' })).toEqual({
      text: 'Not connected',
      tone: 'muted',
      action: 'Connect',
    });
  });
});

describe('the sections of settings', () => {
  it('have the ids a link lands on, System among them', () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      'repository',
      'github',
      'models',
      'crew',
      'system',
      'spending-limits',
      'backup',
      'pause',
      'users',
      'appearance',
    ]);
    expect(hashSection('engine-updates')).toBe('system');
    expect(hashSection('system')).toBe('system');
  });
});

describe('where a repository’s settings are', () => {
  it('is a page of its own, named after it', () => {
    expect(repoSettingsPath('fleetadlc-testbed')).toBe('/settings/repositories/fleetadlc-testbed');
    expect(repoSettingsPath('a b')).toBe('/settings/repositories/a%20b');
  });
});

describe('the section being read', () => {
  const tops = (...values: number[]) => ['repository', 'crew', 'system', 'appearance'].map((id, index) => ({ id, top: values[index]! }));

  it('is the last to have scrolled up to the reading line', () => {
    expect(sectionBeingRead({ tops: tops(-900, -200, 80, 700), atBottom: false, named: null, viewportHeight: 900 })).toBe('system');
    expect(sectionBeingRead({ tops: tops(40, 600, 1400, 2000), atBottom: false, named: null, viewportHeight: 900 })).toBe('repository');
  });

  it('at the end of the page, is the one a link named while it is on screen, else the last', () => {
    // /settings#system, which cannot scroll up to the line: it is still the one being read.
    expect(sectionBeingRead({ tops: tops(-1500, -700, 160, 620), atBottom: true, named: 'system', viewportHeight: 900 })).toBe('system');
    expect(sectionBeingRead({ tops: tops(-1500, -700, 160, 620), atBottom: true, named: null, viewportHeight: 900 })).toBe('appearance');
    expect(sectionBeingRead({ tops: tops(-2500, -1700, -900, 620), atBottom: true, named: 'system', viewportHeight: 900 })).toBe('appearance');
  });
});

describe('a seat on a shared account', () => {
  it('is connected by its account, though it keeps its seat’s name', () => {
    expect(
      accountState({ name: 'builder', slot: 'builder', githubLogin: 'fleetadlc-example', authorization: 'active' }).text,
    ).toBe('Connected');
  });
});
