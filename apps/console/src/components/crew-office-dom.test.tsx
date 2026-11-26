// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrewOffice } from './crew-office';
import type { CrewMember, TaskSummary } from '@/lib/api';

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

const CREW = [
  member({ name: 'otto', slot: 'intake', role: 'intake', task: task({ kind: 'intake', state: 'running', waitingOnYou: true, subjectRef: 'o/r#15' }) }),
  member({ name: 'atlas', task: task({ kind: 'implement', state: 'running', issue: { repo: 'o/r', number: 16, title: 'Filter by label' } }) }),
  member({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: null, authorization: 'unauthorized' }),
  member({ name: 'iris', slot: 'second-reviewer', role: 'review_second', lastTask: task({ kind: 'review', state: 'failed', subjectRef: 'o/r#12' }) }),
  member({ name: 'vera', slot: 'security-reviewer', role: 'review_security', checks: [{ id: 'signing-key', title: 'Its signing key is gone', severity: 'blocking' }] }),
  member({ name: 'quinn', slot: 'qa', role: 'qa' }),
];

let host: HTMLDivElement;
let root: Root;
const onOpenItem = vi.fn();
const onOpenSeat = vi.fn();

async function mount(admin = true) {
  await act(async () => {
    root.render(<CrewOffice crew={CREW} now={NOW} admin={admin} onOpenItem={onOpenItem} onOpenSeat={onOpenSeat} />);
  });
}

const desk = (name: string) => host.querySelector(`[data-desk="${name}"]`)!;
const labelled = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const click = async (element: Element) => act(async () => void (element as HTMLElement).click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onOpenItem.mockClear();
  onOpenSeat.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a desk in the office', () => {
  it('shows each state’s character', async () => {
    await mount();
    expect(['otto', 'atlas', 'lead-reviewer', 'iris', 'vera', 'quinn'].map((name) => desk(name).getAttribute('data-pose'))).toEqual([
      'hand-up',
      'busy',
      'empty',
      'stopped',
      'stopped',
      'rest',
    ]);
    expect(desk('atlas').querySelector('[data-bubble]')?.textContent).toBe('#16 Filter by label');
  });

  it('opens the question a waiting bot asked when its raised hand is pressed', async () => {
    await mount();
    const hand = labelled("Answer otto's question")!;
    expect(hand.tagName).toBe('BUTTON');
    expect(hand.tabIndex).toBe(0);
    await click(hand);
    expect(onOpenItem).toHaveBeenCalledWith('o/r#15', 'intake');
  });

  it('opens the item a failed task was on when the stopped character is pressed', async () => {
    await mount();
    await click(labelled('Open what iris needs attention for')!);
    expect(onOpenItem).toHaveBeenCalledWith('o/r#12', 'review_second');
  });

  it('opens the seat for a bot that needs attention for a check alone', async () => {
    await mount();
    await click(labelled('Open what vera needs attention for')!);
    expect(onOpenItem).not.toHaveBeenCalled();
    expect(onOpenSeat).toHaveBeenCalledWith('vera', 'chat');
  });

  it('has no character button at rest or while working', async () => {
    await mount();
    for (const name of ['atlas', 'quinn', 'lead-reviewer']) expect(desk(name).querySelectorAll('button')).toHaveLength(1);
  });

  it('opens the seat from its name, the keyboard’s way into every desk', async () => {
    await mount();
    const name = [...desk('quinn').querySelectorAll('button')].find((one) => one.textContent === 'quinn')!;
    await click(name);
    expect(onOpenSeat).toHaveBeenCalledWith('quinn');
  });

  it('names each desk with the bot, its state and its task', async () => {
    await mount();
    const group = (name: string) => desk(name).querySelector('[role="group"]')!.getAttribute('aria-label');
    expect(group('atlas')).toBe('atlas, Builder: working — #16 Filter by label');
    expect(group('vera')).toMatch(/^vera, .+: needs attention — Its signing key is gone$/);
  });

  it('offers an admin the link that connects an empty desk’s account', async () => {
    await mount(true);
    const link = desk('lead-reviewer').querySelector('a');
    expect(link?.textContent).toBe('Connect its account');
    expect(link?.getAttribute('href')).toBe('/onboarding?step=github-accounts');
  });
});
