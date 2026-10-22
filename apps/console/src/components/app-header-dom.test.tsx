// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CrewMember } from '@/lib/api';
import { headerData } from '@/lib/header';
import { AppHeader } from './app-header';

/**
 * The header in a narrow window. At 800px the badge of what needs you broke
 * into four lines inside its pill, "New request" into two, and the row ran
 * 16px past the window; at 1024px both still took two lines. happy-dom lays
 * nothing out, so this holds the rules that keep it on one line from 768px
 * (`md:`), each part on one line at its own width with the repository's name
 * giving way, and the phone's second line wrapping between its parts. The
 * widths themselves were checked in a browser at 768, 800, 1024 and 1280px,
 * and at 320, 375 and 767px for the phone's two rows.
 */

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
    ...partial,
  };
}

const DATA = {
  ...headerData({
    repos: ['api', 'openadlc-testbed', 'website'],
    repoColors: { api: 'amber', 'openadlc-testbed': 'blue', website: 'pink' },
    crew: [member({ name: 'openadlc-atlas-janedoe' }), member({ name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second' })],
    budget: { spentUsd: 7.51, capUsd: 1500 },
    needsYou: 13,
  }),
  needsSplit: { work: 3, system: 10 },
};

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<AppHeader page="crew" repo="all" data={DATA} />));
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

const classes = (element: Element | null | undefined): string[] => (element?.getAttribute('class') ?? '').split(/\s+/);

describe('the header from 768px up', () => {
  it('is one row in which nothing wraps', () => {
    const wide = container.querySelector('[data-wide-header]')!;
    expect(classes(wide)).toEqual(expect.arrayContaining(['hidden', 'md:flex', 'h-14', 'whitespace-nowrap']));
    // The badge, the button and the links keep their width; what is left goes to the repository.
    const [where, nav, right] = [...wide.children];
    expect(nav?.tagName).toBe('NAV');
    expect(classes(nav)).toContain('shrink-0');
    expect(classes(right)).toEqual(expect.arrayContaining(['ml-auto', 'shrink-0']));
    expect(right?.textContent).toContain('3 need you · 10 system');
    expect(classes(where)).toContain('min-w-0');
  });

  it('cuts the repository’s name short inside its button, rather than drawing the button over the links', () => {
    const wide = container.querySelector('[data-wide-header]')!;
    const button = wide.querySelector('button[aria-expanded]')!;
    expect(classes(button)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
    expect(classes(button.parentElement)).toContain('min-w-0');
    expect([...button.querySelectorAll('span')].find((one) => one.textContent === 'All repositories')?.className).toBe('truncate');
  });

  it('says "New" on its button until 1024px, and "New request" to a screen reader at every width', () => {
    const wide = container.querySelector('[data-wide-header]')!;
    const button = [...wide.querySelectorAll('button')].find((one) => one.textContent?.startsWith('New'))!;
    expect(button.textContent).toBe('New request');
    expect(classes(button.querySelector('span'))).toEqual(['sr-only', 'lg:not-sr-only']);
  });
});

describe('the header below 768px', () => {
  it('wraps its second line between its parts, never inside one', () => {
    const phone = [...container.querySelectorAll('header')].find((one) => classes(one).includes('md:hidden'))!;
    const line = phone.querySelector('p')!;
    expect(classes(line)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'whitespace-nowrap']));
    expect(line.textContent).toContain('3 need you · 10 system');
  });
});
