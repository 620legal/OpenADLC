import { describe, expect, it } from 'vitest';
import { REPO_DEFAULTS } from '../../../../packages/shared/src/config';
import { STAGE_MODES, STAGES } from './stages';
import {
  accountState,
  buildersOf,
  designChoiceLabel,
  hashSection,
  modeOf,
  navOmit,
  repoSettingsPath,
  repoStagesPath,
  sectionBeingRead,
  SETTINGS_SECTIONS,
  settingsNav,
  stageChoices,
  stageLine,
  stagesSectionId,
  tasksAtOnceLine,
} from './settings';

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
    // Design included: `conditional` here said "When it matters" of a row the
    // bridge sends every issue to Design for (ADR 0004).
    expect(modeOf({}, 'spec')).toBe('autonomous');
    expect(modeOf({}, 'merged')).toBe('autonomous');
    expect(modeOf({ spec: 'conditional' }, 'spec')).toBe('conditional');
    // An older bridge may still send assist, which is what autonomous is.
    expect(modeOf({ merged: 'assist' }, 'merged')).toBe('autonomous');
    expect(modeOf({ spec: 'assist' }, 'spec')).toBe('autonomous');
  });

  it('assumes, for a stage with nothing stored, what a new repository starts with on the bridge', () => {
    // The console cannot import the bridge's defaults, so its copy is held to them here.
    for (const { key } of STAGES) expect(modeOf({}, key), key).toBe(REPO_DEFAULTS.stageModes[key]);
  });

  it('names Design’s choice in the words the repository page draws it with', () => {
    expect(designChoiceLabel({})).toBe('Always');
    expect(designChoiceLabel({ spec: 'autonomous' })).toBe('Always');
    expect(designChoiceLabel({ spec: 'conditional' })).toBe('When it matters');
    expect(designChoiceLabel({ spec: 'untouched' })).toBe('Never');
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
      'hosts',
      'notifications',
      'egress',
      'spending-limits',
      'backup',
      'pause',
      'people',
      'roles',
      'appearance',
    ]);
    expect(hashSection('users')).toBe('people');
    expect(hashSection('engine-updates')).toBe('system');
    expect(hashSection('keep-awake')).toBe('system');
    expect(hashSection('system')).toBe('system');
  });
});

describe('Settings’ navigation (ADR 0053)', () => {
  it('lists Hosts right after System and Notifications right after Hosts, each a page of its own', () => {
    const nav = settingsNav({ admin: true, on: 'sections' });
    const ids = nav.map((entry) => entry.id);
    expect(ids.indexOf('hosts')).toBe(ids.indexOf('system') + 1);
    expect(ids.indexOf('notifications')).toBe(ids.indexOf('hosts') + 1);
    expect(nav.find((entry) => entry.id === 'hosts')).toMatchObject({ label: 'Hosts', href: '/settings/hosts', section: false });
    expect(nav.find((entry) => entry.id === 'notifications')).toMatchObject({ label: 'Notifications', href: '/settings/notifications', section: false });
    expect(nav.find((entry) => entry.id === 'system')).toMatchObject({ href: '#system', section: true });
    // On /settings scrolling marks the section being read; no entry is the page.
    expect(nav.filter((entry) => entry.current)).toEqual([]);
  });

  it('marks the page open, and sends a section’s link to /settings from a page of its own', () => {
    for (const on of ['hosts', 'notifications'] as const) {
      const nav = settingsNav({ admin: true, on });
      expect(nav.filter((entry) => entry.current).map((entry) => entry.id), on).toEqual([on]);
      for (const entry of nav.filter((one) => one.section)) expect(entry.href, on).toBe(`/settings#${entry.id}`);
    }
  });

  it('leaves out what the install does not have', () => {
    const ids = settingsNav({ admin: true, omit: ['egress', 'roles'], on: 'hosts' }).map((entry) => entry.id);
    expect(ids).not.toContain('egress');
    expect(ids).not.toContain('roles');
    expect(ids).toContain('hosts');
  });

  it('is Notifications alone for someone who is not an admin, whatever the page and whatever is left out', () => {
    for (const on of ['sections', 'hosts', 'notifications'] as const) {
      for (const omit of [[], ['egress'], ['notifications']]) {
        expect(settingsNav({ admin: false, omit, on }).map((entry) => [entry.id, entry.href]), `${on} ${omit.join()}`).toEqual([['notifications', '/settings/notifications']]);
      }
    }
  });

  it('leaves out Egress where tasks leave through no proxy, and Roles the bridge could not answer, one rule for every page', () => {
    expect(navOmit({ egress: { proxied: false }, personRoles: null })).toEqual(['egress', 'roles']);
    expect(navOmit({ egress: null, personRoles: { roles: [] } })).toEqual(['egress']);
    // hostd could not be asked: the section stays, with why.
    expect(navOmit({ egress: { proxied: null }, personRoles: { roles: [] } })).toEqual([]);
    expect(navOmit({ egress: { proxied: true }, personRoles: null })).toEqual(['roles']);
  });
});

describe('where a repository’s settings are', () => {
  it('is a page of its own, named after it', () => {
    expect(repoSettingsPath('openadlc-testbed')).toBe('/settings/repositories/openadlc-testbed');
    expect(repoSettingsPath('a b')).toBe('/settings/repositories/a%20b');
  });

  it('has its stages under an anchor the settings list links to', () => {
    expect(stagesSectionId('api')).toBe('api-stages');
    expect(repoStagesPath('api')).toBe('/settings/repositories/api#api-stages');
    expect(repoStagesPath('my repo')).toBe('/settings/repositories/my%20repo#my%20repo-stages');
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
      accountState({ name: 'builder', slot: 'builder', githubLogin: 'openadlc-example', authorization: 'active' }).text,
    ).toBe('Connected');
  });
});
