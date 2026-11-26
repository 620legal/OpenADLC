import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CrewOffice } from './crew-office';
import type { CrewMember, TaskSummary } from '@/lib/api';
import { BUBBLE_MAX } from '@/lib/crew-office';

const NOW = '2026-09-24T12:00:00.000Z';

function member(partial: Partial<CrewMember> & Pick<CrewMember, 'name'>): CrewMember {
  return {
    slot: 'builder',
    displayName: partial.name,
    role: 'implement',
    engine: 'claude',
    model: 'newest:opus',
    status: 'stopped',
    container: `bot-${partial.name}`,
    githubLogin: partial.name,
    authorization: 'active',
    tokenExpiresAt: null,
    now: 'nothing running',
    paused: false,
    sessions: [],
    task: null,
    lastTask: null,
    ...partial,
  };
}

function task(partial: Partial<TaskSummary> & Pick<TaskSummary, 'kind' | 'state'>): TaskSummary {
  return { subjectRef: 'o/r#16', issue: null, startedAt: null, endedAt: null, round: null, waitingOnYou: false, ...partial };
}

const LONG = 'Let the board filter by label, by repository, and by who is working on each item';

// Out of pipeline order on purpose: the office puts them back in it.
const CREW = [
  member({ name: 'quinn', slot: 'qa', role: 'qa' }),
  member({ name: 'atlas', task: task({ kind: 'implement', state: 'running', issue: { repo: 'o/r', number: 16, title: LONG } }) }),
  member({ name: 'flow', slot: 'automation', role: 'automation', engine: 'none', model: 'none' }),
  member({ name: 'otto', slot: 'intake', role: 'intake', task: task({ kind: 'intake', state: 'running', waitingOnYou: true, subjectRef: 'o/r#15' }) }),
  member({ name: 'iris', slot: 'second-reviewer', role: 'review_second', lastTask: task({ kind: 'review', state: 'failed', subjectRef: 'o/r#12' }) }),
  member({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: null, authorization: 'unauthorized' }),
];

const render = (admin = false) =>
  renderToStaticMarkup(<CrewOffice crew={CREW} now={NOW} admin={admin} onOpenItem={() => {}} onOpenSeat={() => {}} />);

function desks(html: string): { name: string; pose: string }[] {
  return [...html.matchAll(/data-desk="([^"]+)" data-pose="([^"]+)"/g)].map((match) => ({ name: match[1]!, pose: match[2]! }));
}

describe('the crew office', () => {
  it('draws one desk per bot, in pipeline order, each in its state’s pose', () => {
    expect(desks(render())).toEqual([
      { name: 'otto', pose: 'hand-up' },
      { name: 'atlas', pose: 'busy' },
      { name: 'lead-reviewer', pose: 'empty' },
      { name: 'iris', pose: 'stopped' },
      { name: 'quinn', pose: 'rest' },
      { name: 'flow', pose: 'rest' },
    ]);
  });

  it('cuts a long title in the bubble and keeps it whole in the desk’s name and the bubble’s title', () => {
    const html = render();
    const bubble = /<p data-bubble="true" title="([^"]+)"[^>]*>([^<]+)<\/p>/.exec(html)!;
    expect(bubble[1]).toBe(`#16 ${LONG}`);
    expect(bubble[2]!.endsWith('…')).toBe(true);
    expect(bubble[2]!.length).toBeLessThanOrEqual(BUBBLE_MAX + 1);
    expect(html).toContain(`aria-label="atlas, Builder: working — #16 ${LONG}"`);
  });

  it('hides the drawing from screen readers, with no title of its own', () => {
    const html = render();
    const svgs = html.match(/<svg[^>]*>/g)!;
    expect(svgs).toHaveLength(CREW.length);
    for (const svg of svgs) expect(svg).toContain('aria-hidden="true"');
    expect(html).not.toContain('<title>');
  });

  it('draws no figure at an empty desk, and an octagon at a stopped one', () => {
    const html = render();
    const empty = html.slice(html.indexOf('data-desk="lead-reviewer"'), html.indexOf('data-desk="iris"'));
    expect(empty).not.toContain('data-figure');
    const stopped = html.slice(html.indexOf('data-desk="iris"'), html.indexOf('data-desk="quinn"'));
    expect(stopped).toContain('data-mark="stop"');
  });

  it('says “needs attention”, never a cap', () => {
    const html = render();
    expect(html).toContain('needs attention');
    expect(html).not.toMatch(/\bcap\b/i);
  });

  it('offers to connect an empty desk’s account to an admin only', () => {
    expect(render(true)).toContain('Connect its account');
    expect(render(false)).not.toContain('Connect its account');
  });

  it('holds no literal colour: every colour is a theme token', () => {
    const source = readFileSync(new URL('./crew-office.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i);
  });
});
