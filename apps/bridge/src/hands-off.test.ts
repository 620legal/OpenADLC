import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openadlc/db', () => ({}));

import type { HandsOffWindow } from '@openadlc/db';
import { parseHumanReviewPaths } from '@openadlc/shared';
import { HandsOff, type HandsOffAsk, type HandsOffDeps } from './hands-off.js';
import type { AudienceFacts } from './needs-you-audience.js';

/**
 * What a hands-off window answers, and what it leaves for a person (#383).
 * The cover is an allow-list: a plan change with no Human-review path, and a
 * question whose recommended answer is one of its options, from the crew
 * working an issue or a request, that the person who opened the window could
 * have answered. Everything else asks a person, and leaves the window on.
 */

const AGENTS = ['# Agents', '', '## Human review', '', '- `apps/bridge/src/gates.ts` @orzelig', '- `config/` @orzelig', ''].join('\n');

const WINDOW: HandsOffWindow = {
  id: 'window-1',
  repoId: 'repo-1',
  setBy: 'jane@example.com',
  setByLogin: 'janedoe',
  setByGithubId: 4242,
  duration: '8h',
  setAt: '2026-11-25T10:00:00.000Z',
  endsAt: '2026-11-25T18:00:00.000Z',
  endedAt: null,
  endedBy: null,
  endedWhy: null,
  endedNote: null,
};

const REPO = { id: 'repo-1', name: 'openadlc', fullName: 'acme/openadlc', defaultBranch: 'main' };

let open: HandsOffWindow | null;
let ended: { repoId: string; by: string; why: string; note: string | null }[];
let issue: { labels: string[]; declaredPaths: string[] };
let agents: string | null;
let monthRefusal: string | null;
let repoRefusal: string | null;
let audits: { actor: string; action: string; target: string; payload: Record<string, unknown> }[];

function deps(): HandsOffDeps {
  return {
    store: {
      openFor: vi.fn(async () => open),
      listOpen: vi.fn(async () => (open ? [open] : [])),
      turnOn: vi.fn(async (input) => {
        if (open) return { window: open, created: false };
        open = { ...WINDOW, setBy: input.setBy, setByLogin: input.setByLogin, setByGithubId: input.setByGithubId, duration: input.duration };
        return { window: open, created: true };
      }),
      end: vi.fn(async (input) => {
        if (!open) return null;
        ended.push({ repoId: input.repoId, by: input.by, why: input.why, note: input.note ?? null });
        const was = { ...open, endedAt: '2026-11-25T12:00:00.000Z', endedBy: input.by, endedWhy: input.why, endedNote: input.note ?? null };
        open = null;
        return was;
      }),
      endExpired: vi.fn(async () => {
        if (!open?.endsAt || Date.parse(open.endsAt) > Date.parse('2026-11-25T12:00:00.000Z')) return [];
        const was = { ...open, endedAt: '2026-11-25T12:00:00.000Z', endedBy: 'openadlc', endedWhy: 'expired' as const };
        open = null;
        return [was];
      }),
    },
    audit: vi.fn(async (entry) => {
      audits.push(entry);
    }),
    repoById: vi.fn(async () => REPO),
    repositoryRefusal: vi.fn(async () => repoRefusal),
    taskRefusal: vi.fn(async () => monthRefusal),
    humanReviewRules: vi.fn(async () => {
      const rules = parseHumanReviewPaths(agents);
      return rules ? { rules, unread: null } : { rules: null, unread: { cause: 'no-section' as const } };
    }) as never,
    issueFacts: vi.fn(async () => issue),
    warn: () => undefined,
  };
}

function ask(overrides: Partial<HandsOffAsk> = {}): HandsOffAsk {
  return {
    task: { id: 'task-1', kind: 'implement', subjectType: 'issue', subjectRef: 'openadlc#78', botId: 'bot-builder', repoId: 'repo-1' },
    repo: REPO,
    issueNumber: 78,
    planChange: null,
    options: ['A', 'B'],
    recommended: 'B',
    role: null,
    audience: null,
    facts: null,
    local: true,
    addressedTo: null,
    ignored: false,
    ...overrides,
  };
}

const FACTS: AudienceFacts = {
  people: [
    { id: 'p-jane', email: 'jane@example.com', githubLogin: 'janedoe', consoleRole: 'user', approves: true },
    { id: 'p-sam', email: 'sam@example.com', githubLogin: 'sam', consoleRole: 'user', approves: false },
  ],
  roles: [
    { id: 'role-legal', name: 'Legal', members: ['p-sam'] },
    { id: 'role-eng', name: 'Engineering', members: ['p-jane'] },
  ],
};

let handsOff: HandsOff;

beforeEach(() => {
  open = { ...WINDOW };
  ended = [];
  issue = { labels: [], declaredPaths: ['apps/bridge/src/hands-off.ts'] };
  agents = AGENTS;
  monthRefusal = null;
  repoRefusal = null;
  audits = [];
  handsOff = new HandsOff(deps());
});

describe('the cover', () => {
  it('answers nothing when no window is open', async () => {
    open = null;
    expect(await handsOff.cover()(ask())).toBeNull();
  });

  it('answers a question from intake, spec, implement or a request with the option it recommended', async () => {
    for (const kind of ['intake', 'spec', 'implement', 'request'] as const) {
      expect(await handsOff.cover()(ask({ task: { ...ask().task, kind } }))).toEqual({ covers: true, window: open, reply: 'B' });
    }
    // A console request has no issue to read.
    expect(await handsOff.cover()(ask({ task: { ...ask().task, kind: 'request', subjectType: 'request', subjectRef: 'request:ab12cd34' }, issueNumber: 0 }))).toMatchObject({ covers: true });
  });

  it('approves a plan change none of whose paths is under Human review', async () => {
    expect(await handsOff.cover()(ask({ planChange: { paths: ['apps/hostd/src/skill-runner.ts'], reason: 'r' }, options: ['Approve', 'Refuse'], recommended: null }))).toEqual({
      covers: true,
      window: open,
      reply: 'Approve',
    });
  });

  const asksAPerson: [string, () => HandsOffAsk, RegExp][] = [
    ['a question with no recommended answer', () => ask({ recommended: null }), /recommended no answer/],
    ['a recommended answer that is none of its options', () => ask({ recommended: 'C' }), /not one of its options/],
    ['a recommended answer that differs from its option in case', () => ask({ recommended: 'b' }), /not one of its options/],
    ['an open question', () => ask({ options: [], recommended: 'B' }), /open question/],
    ['a plan change with a path under Human review', () => ask({ planChange: { paths: ['apps/hostd/src/x.ts', 'config/labels.json'], reason: 'r' }, options: ['Approve', 'Refuse'] }), /`config\/labels.json` is under Human review/],
    ['the cost-cap question, even with a recommended answer', () => ask({ options: ['continue for another $15', 'hand to a person', 'abandon this task'], recommended: 'continue for another $15' }), /raises a cost cap/],
    ['a review seat’s question on a pull request', () => ask({ task: { ...ask().task, kind: 'review', subjectType: 'pr' } }), /review task's question/],
    ['a patch round’s question', () => ask({ task: { ...ask().task, kind: 'patch', subjectType: 'pr' } }), /patch task's question/],
    ['a deploy’s question', () => ask({ task: { ...ask().task, kind: 'deploy', subjectType: 'merge' } }), /deploy task's question/],
    ['an implement question on a pull request', () => ask({ task: { ...ask().task, subjectType: 'pr' } }), /on a pull request/],
    ['a question addressed to another login', () => ask({ addressedTo: 'sam' }), /addressed to @sam/],
    ['a question on an issue labelled openadlc:ignore', () => ask({ ignored: true }), /openadlc:ignore/],
  ];
  it.each(asksAPerson)('asks a person for %s, and leaves the window on', async (_what, make, why) => {
    const verdict = await handsOff.cover()(make());
    expect(verdict).toMatchObject({ covers: false, window: open });
    expect(verdict && !verdict.covers ? verdict.why : '').toMatch(why);
    expect(open).not.toBeNull();
    expect(ended).toEqual([]);
  });

  it('asks a person for a question on an issue whose Expected paths name a path under Human review', async () => {
    issue.declaredPaths = ['apps/bridge/src/hands-off.ts', 'apps/bridge/src/gates.ts'];
    expect(await handsOff.cover()(ask())).toMatchObject({ covers: false, why: expect.stringContaining('`apps/bridge/src/gates.ts`, under Human review') });
  });

  it('asks a person for a question on an issue labelled scope:cross-cutting', async () => {
    issue.labels = ['scope:cross-cutting'];
    expect(await handsOff.cover()(ask())).toMatchObject({ covers: false, why: 'the issue is labelled scope:cross-cutting' });
  });

  it('asks a person when the Human-review rules cannot be read, for a plan change and for a question alike', async () => {
    agents = null;
    expect(await handsOff.cover()(ask({ planChange: { paths: ['apps/hostd/src/x.ts'], reason: 'r' }, options: ['Approve', 'Refuse'] }))).toMatchObject({ covers: false });
    expect(await handsOff.cover()(ask())).toMatchObject({ covers: false });
  });

  it('asks a person when the issue cannot be read', async () => {
    const failing = deps();
    failing.issueFacts = vi.fn(async () => {
      throw new Error('openadlc#78 is not known to OpenADLC yet');
    });
    expect(await new HandsOff(failing).cover()(ask())).toMatchObject({ covers: false, why: expect.stringContaining('could not be read') });
  });

  describe('a question for a person role', () => {
    const routed = (role: string, audience: HandsOffAsk['audience']) => ask({ local: false, role, facts: FACTS, audience });

    it('is answered when the window’s setter holds the role', async () => {
      expect(await handsOff.cover()(routed('Engineering', { for: 'role', name: 'Engineering', people: ['p-jane'] }))).toMatchObject({ covers: true });
    });

    it('asks a person when the setter does not hold it', async () => {
      expect(await handsOff.cover()(routed('Legal', { for: 'role', name: 'Legal', people: ['p-sam'] }))).toMatchObject({
        covers: false,
        why: 'it is for Legal, which @janedoe does not hold',
      });
    });

    it('is answered when nobody holds the role, since Needs you then shows it to everyone', async () => {
      expect(await handsOff.cover()(routed('Product', { for: 'everyone', name: 'everyone', people: [], why: 'no role here is called Product' }))).toMatchObject({ covers: true });
    });

    it('asks a person when who holds it could not be read', async () => {
      expect(await handsOff.cover()(routed('Legal', { for: 'role', name: 'Legal', people: ['p-sam'], unread: true }))).toMatchObject({ covers: false });
      expect(await handsOff.cover()(ask({ local: false, role: 'Legal', audience: null }))).toMatchObject({ covers: false });
    });

    it('is answered on a local install, which routes nothing', async () => {
      expect(await handsOff.cover()(ask({ local: true, role: 'Legal' }))).toMatchObject({ covers: true });
    });
  });

  it('never answers once the window’s time has passed, even before the sweep, and ends it as expired', async () => {
    open = { ...WINDOW, endsAt: '2026-11-25T11:00:00.000Z' };
    expect(await handsOff.cover()(ask())).toBeNull();
    expect(audits).toEqual([expect.objectContaining({ action: 'hands_off.off', actor: 'openadlc', payload: expect.objectContaining({ why: 'expired' }) })]);
  });

  it('turns itself off and asks a person when the asking bot is at a monthly cap', async () => {
    monthRefusal = "this month's spend is $1500 of the $1500 monthly cap";
    expect(await handsOff.cover()(ask())).toMatchObject({ covers: false, why: expect.stringContaining('turned itself off') });
    expect(ended).toEqual([{ repoId: 'repo-1', by: 'openadlc', why: 'cap', note: "this month's spend is $1500 of the $1500 monthly cap" }]);
    expect(audits).toEqual([
      expect.objectContaining({ action: 'hands_off.off', payload: expect.objectContaining({ why: 'cap', note: "this month's spend is $1500 of the $1500 monthly cap", setByLogin: 'janedoe' }) }),
    ]);
  });

  it('does not turn itself off at a task’s own cost cap', async () => {
    monthRefusal = 'should not be asked';
    await handsOff.cover()(ask({ options: ['continue for another $15', 'hand to a person', 'abandon this task'], recommended: 'hand to a person' }));
    expect(ended).toEqual([]);
  });

  it('does not cover when the cap cannot be read', async () => {
    const failing = deps();
    failing.taskRefusal = vi.fn(async () => {
      throw new Error('the database is down');
    });
    expect(await new HandsOff(failing).cover()(ask())).toMatchObject({ covers: false });
  });
});

describe('the window', () => {
  it('is turned on once, audited with who set it, when, and when it ends', async () => {
    open = null;
    const opened = await handsOff.turnOn({ repo: REPO, setBy: 'jane@example.com', setByLogin: 'janedoe', setByGithubId: 4242, duration: '8h' });
    expect(opened.created).toBe(true);
    expect(audits).toEqual([
      {
        actor: 'jane@example.com',
        action: 'hands_off.on',
        target: 'acme/openadlc:hands-off',
        payload: {
          windowId: 'window-1',
          repo: 'acme/openadlc',
          setBy: 'jane@example.com',
          setByLogin: 'janedoe',
          setByGithubId: 4242,
          setAt: WINDOW.setAt,
          endsAt: WINDOW.endsAt,
          duration: '8h',
        },
      },
    ]);
    const again = await handsOff.turnOn({ repo: REPO, setBy: 'sam@example.com', setByLogin: 'sam', setByGithubId: 7, duration: '1h' });
    expect(again).toMatchObject({ created: false, window: { setByLogin: 'janedoe' } });
    expect(audits).toHaveLength(1);
  });

  it('is turned off at once, recording who did, and a second turn-off records nothing', async () => {
    expect(await handsOff.turnOff(REPO, 'sam@example.com')).toMatchObject({ endedBy: 'sam@example.com', endedWhy: 'turned_off' });
    expect(audits).toEqual([
      expect.objectContaining({ actor: 'sam@example.com', action: 'hands_off.off', payload: expect.objectContaining({ by: 'sam@example.com', why: 'turned_off', setByLogin: 'janedoe' }) }),
    ]);
    expect(await handsOff.turnOff(REPO, 'sam@example.com')).toBeNull();
    expect(audits).toHaveLength(1);
  });

  it('is ended by the sweep when its time has passed', async () => {
    open = { ...WINDOW, endsAt: '2026-11-25T11:00:00.000Z' };
    await handsOff.sweep();
    expect(open).toBeNull();
    expect(audits).toEqual([expect.objectContaining({ action: 'hands_off.off', payload: expect.objectContaining({ by: 'openadlc', why: 'expired' }) })]);
  });

  it('is ended by the sweep when its repository or the month is at a cap, with the cap’s words', async () => {
    repoRefusal = 'acme/openadlc has spent $200 of its $200 this month';
    await handsOff.sweep();
    expect(ended).toEqual([{ repoId: 'repo-1', by: 'openadlc', why: 'cap', note: 'acme/openadlc has spent $200 of its $200 this month' }]);
  });

  it('is left on by the sweep while no cap is reached', async () => {
    await handsOff.sweep();
    expect(open).not.toBeNull();
    expect(ended).toEqual([]);
  });
});
