// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember } from '@/lib/api';
import { headerData } from '@/lib/header';
import { NAV_PINS_KEY } from '@/lib/nav-pins';
import { AppHeader, AppShell, BottomNav, BrandProvider } from './app-header';

// The shell's live refresh and the palette's links read the router.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }) }));

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
  localStorage.clear();
});

const classes = (element: Element | null | undefined): string[] => (element?.getAttribute('class') ?? '').split(/\s+/);

describe('the header from 768px up', () => {
  it('is one row in which nothing wraps', () => {
    const wide = container.querySelector('[data-wide-header]')!;
    expect(classes(wide)).toEqual(expect.arrayContaining(['hidden', 'md:flex', 'h-14', 'whitespace-nowrap']));
    // The badge, the button and the links keep their width; what is left goes to the repository.
    const [where, nav, right] = [...wide.children];
    expect(nav?.tagName).toBe('NAV');
    // Seven pins scroll inside their row rather than push the right side off; More stays outside it.
    expect(classes(nav)).toContain('min-w-0');
    expect(classes(nav?.querySelector('[data-pinned]'))).toEqual(expect.arrayContaining(['min-w-0', 'overflow-x-auto']));
    expect(nav?.lastElementChild?.querySelector('button')?.textContent).toBe('More');
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

describe('the pinned navigation', () => {
  /**
   * The header and the phone's bar, as a page draws them, on `page`, freshly
   * mounted on the same storage: what loading the page is. Drawn into the
   * outer root instead, the header would keep the pins it read before.
   */
  async function draw(page: 'crew' | 'costs' | 'needs-you' = 'crew'): Promise<void> {
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(
        <>
          <AppHeader page={page} repo="all" data={DATA} />
          <BottomNav page={page} repo="all" />
        </>,
      ),
    );
  }
  const reload = draw;
  const wideNav = () => container.querySelector('[data-wide-header] nav')!;
  const bar = () => [...container.querySelectorAll('nav')].find((one) => classes(one).includes('md:hidden'))!;
  const pinned = (nav: Element) => [...nav.querySelector('[data-pinned]')!.querySelectorAll('a')].map((link) => link.textContent);
  const bothBars = () => ({ wide: pinned(wideNav()), phone: pinned(bar()) });
  const more = (nav: Element = wideNav()) => [...nav.querySelectorAll('button')].find((one) => one.textContent === 'More')!;
  const panel = (nav: Element = wideNav()) => document.getElementById(more(nav).getAttribute('aria-controls')!)!;
  const toggle = (name: string, nav: Element = wideNav()) => panel(nav).querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  const rows = (nav: Element = wideNav()) => [...panel(nav).querySelectorAll('li')].map((row) => row.querySelector('a')!.textContent);
  async function click(element: Element | null): Promise<void> {
    await act(async () => (element as HTMLElement).click());
  }
  async function type(input: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('shows Board, Needs you, Crew and Releases in both bars when nothing is stored, then More', async () => {
    await draw();
    expect(bothBars()).toEqual({ wide: ['Board', 'Needs you', 'Crew', 'Releases'], phone: ['Board', 'Needs you', 'Crew', 'Releases'] });
    expect(more(wideNav())).toBeDefined();
    expect(more(bar())).toBeDefined();
    expect(classes(bar())).not.toEqual(expect.arrayContaining(['grid-cols-4']));
  });

  it('shows what this browser pinned, in the order it was pinned', async () => {
    localStorage.setItem(NAV_PINS_KEY, '["costs","board"]');
    await draw();
    expect(bothBars()).toEqual({ wide: ['Costs', 'Board'], phone: ['Costs', 'Board'] });
  });

  it('falls back to the defaults for a value it cannot read, and drops a page it does not know', async () => {
    localStorage.setItem(NAV_PINS_KEY, 'not json');
    await draw();
    expect(bothBars().wide).toEqual(['Board', 'Needs you', 'Crew', 'Releases']);
    localStorage.setItem(NAV_PINS_KEY, '["insights","nope"]');
    await reload();
    expect(bothBars()).toEqual({ wide: ['Insights'], phone: ['Insights'] });
  });

  it('opens a list of every page from More, each with a pin named for it, and pins and unpins at once in both bars', async () => {
    await draw();
    expect(more().getAttribute('aria-expanded')).toBe('false');
    await click(more());
    expect(more().getAttribute('aria-expanded')).toBe('true');
    expect(panel().hidden).toBe(false);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Find a page');
    expect(rows()).toEqual(['Board', 'Needs you', 'Crew', 'Costs', 'Insights', 'Security', 'Releases', 'Map', 'Activity', 'Routines', 'Settings']);
    expect(toggle('Pin Costs')?.getAttribute('aria-pressed')).toBe('false');
    expect(toggle('Unpin Crew')?.getAttribute('aria-pressed')).toBe('true');

    await click(toggle('Pin Costs'));
    expect(bothBars()).toEqual({ wide: ['Board', 'Needs you', 'Crew', 'Releases', 'Costs'], phone: ['Board', 'Needs you', 'Crew', 'Releases', 'Costs'] });
    expect(JSON.parse(localStorage.getItem(NAV_PINS_KEY)!)).toEqual(['board', 'needs-you', 'crew', 'releases', 'costs']);
    // The list stays open, to pin several in a row, and the toggle now unpins.
    expect(panel().hidden).toBe(false);
    expect(toggle('Unpin Costs')?.getAttribute('aria-pressed')).toBe('true');

    await click(toggle('Unpin Crew'));
    expect(bothBars().wide).not.toContain('Crew');
    expect(bothBars().phone).not.toContain('Crew');

    await reload();
    expect(bothBars()).toEqual({ wide: ['Board', 'Needs you', 'Releases', 'Costs'], phone: ['Board', 'Needs you', 'Releases', 'Costs'] });
  });

  it('follows a pin made from the phone’s More in the wide header too', async () => {
    await draw();
    await click(more(bar()));
    await click(toggle('Pin Settings', bar()));
    expect(bothBars().wide.at(-1)).toBe('Settings');
  });

  it('filters the list by label as the person types, and says when nothing matches', async () => {
    await draw();
    await click(more());
    const search = panel().querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search.getAttribute('aria-label')).toBe('Find a page');
    await type(search, 'COS');
    expect(rows()).toEqual(['Costs']);
    await type(search, 'zzz');
    expect(rows()).toEqual([]);
    expect(panel().textContent).toContain('No page matches');
  });

  it('closes on Escape and gives the focus back to More', async () => {
    await draw();
    await click(more());
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(more().getAttribute('aria-expanded')).toBe('false');
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(more());
  });

  it('closes on a click outside and gives the focus back to More', async () => {
    await draw();
    await click(more());
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Find a page');
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(more().getAttribute('aria-expanded')).toBe('false');
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(more());
  });

  it('leaves the focus on a control clicked outside More, rather than taking it back', async () => {
    await draw();
    await click(more());
    const board = wideNav().querySelector('[data-pinned] a') as HTMLAnchorElement;
    await act(async () => {
      board.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      board.focus();
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(board);
  });

  it('marks More as where the person is when their page is not pinned', async () => {
    await draw('costs');
    expect(classes(more())).toContain('bg-well');
    await draw('crew');
    expect(classes(more())).not.toContain('bg-well');
  });

  it('links Needs you, when pinned, beside the chip that stays as it was', async () => {
    await draw('needs-you');
    const link = [...wideNav().querySelectorAll('a')].find((one) => one.textContent === 'Needs you')!;
    expect(link.getAttribute('href')).toBe('/needs-you');
    expect(link.getAttribute('aria-current')).toBe('page');
    const chip = [...container.querySelectorAll('[data-wide-header] a')].find((one) => one.textContent === '3 need you · 10 system');
    expect(chip?.getAttribute('href')).toBe('/needs-you');
  });
});

describe('the activity button (#374)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sits beside the alerts menu in both headers', () => {
    const wide = container.querySelector('[data-wide-header]')!;
    const phone = [...container.querySelectorAll('header')].find((one) => classes(one).includes('md:hidden'))!;
    for (const header of [wide, phone]) {
      const bell = header.querySelector('[data-activity-bell]');
      expect(bell).not.toBeNull();
      expect(bell?.nextElementSibling?.querySelector('button[aria-label="Alerts"]')).not.toBeNull();
    }
  });

  it('says the history cannot be read inside its panel, and the header draws as it did', async () => {
    act(() => root.unmount());
    // A stream the bridge refuses: the button reads the history to say why.
    vi.stubGlobal(
      'EventSource',
      class {
        static readonly CLOSED = 2;
        readyState = 0;
        private listeners = new Map<string, () => void>();
        constructor() {
          setTimeout(() => this.listeners.get('error')?.(), 0);
        }
        addEventListener(type: string, listener: () => void) {
          this.listeners.set(type, listener);
        }
        close() {}
      },
    );
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'the bridge is not answering' }, { status: 502 })));
    root = createRoot(container);
    await act(async () => root.render(<AppHeader page="crew" repo="all" data={DATA} />));
    await act(async () => {
      for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const wide = container.querySelector('[data-wide-header]')!;
    expect(wide.querySelector('[data-activity-error]')?.textContent).toBe('Activity can’t be read: the bridge is not answering');
    expect(wide.querySelector('[data-activity-badge]')).toBeNull();
    expect(wide.querySelector('nav[aria-label="Console"]')).not.toBeNull();
    expect(wide.textContent).toContain('3 need you · 10 system');
    expect(wide.textContent).toContain('New request');
  });
});

describe('the header below 768px', () => {
  it('wraps its second line between its parts, never inside one', () => {
    const phone = [...container.querySelectorAll('header')].find((one) => classes(one).includes('md:hidden'))!;
    // The header's own second line, not a paragraph inside the activity panel.
    const line = phone.querySelector(':scope > p')!;
    expect(classes(line)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'whitespace-nowrap']));
    expect(line.textContent).toContain('3 need you · 10 system');
  });
});

describe('the console’s name and logo, at their longest', () => {
  const NAME = 'Acme Legal and Associates of Springfield';

  beforeEach(async () => {
    await act(async () =>
      root.render(
        <BrandProvider brand={{ name: NAME, logoUrl: '/api/brand/logo?v=0123456789ab' }}>
          <AppHeader page="crew" repo="all" data={DATA} />
        </BrandProvider>,
      ),
    );
  });

  it('keeps the wide header on one line, the name cut short with the whole of it in its title', () => {
    expect(NAME).toHaveLength(40);
    const wide = container.querySelector('[data-wide-header]')!;
    expect(classes(wide)).toContain('whitespace-nowrap');
    const link = wide.querySelector('a')!;
    expect(classes(link)).toEqual(expect.arrayContaining(['flex', 'min-w-0', 'shrink', 'items-center']));
    const name = link.querySelector('[data-brand-name]')!;
    expect(name.textContent).toBe(NAME);
    expect(name.getAttribute('title')).toBe(NAME);
    expect(classes(name)).toEqual(expect.arrayContaining(['truncate', 'max-w-[9rem]', 'lg:max-w-[14rem]']));
    const logo = link.querySelector<HTMLImageElement>('img[data-brand-logo]')!;
    expect(logo.getAttribute('src')).toBe('/api/brand/logo?v=0123456789ab');
    expect(classes(logo)).toEqual(expect.arrayContaining(['h-7', 'w-auto', 'max-w-[7rem]', 'object-contain', 'shrink-0']));
  });

  it('draws both in the phone’s header too', () => {
    const phone = [...container.querySelectorAll('header')].find((one) => classes(one).includes('md:hidden'))!;
    const link = phone.querySelector('a')!;
    expect(link.querySelector('img[data-brand-logo]')).not.toBeNull();
    expect(classes(link.querySelector('[data-brand-name]'))).toContain('truncate');
    expect(link.textContent).toBe(NAME);
  });
});

describe('the shell’s keys', () => {
  async function shell(page: 'crew' | 'costs'): Promise<void> {
    await act(async () =>
      root.render(
        <AppShell page={page} data={DATA}>
          <p>{page}</p>
        </AppShell>,
      ),
    );
  }
  async function press(init: KeyboardEventInit): Promise<void> {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [], numbered: true, itemsError: null, paused: false })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mounts one palette and one keys list, which a page drawn again does not double', async () => {
    await shell('crew');
    await shell('costs');
    await press({ key: 'k', metaKey: true });
    expect(document.querySelectorAll('[data-command-palette]')).toHaveLength(1);
    await press({ key: 'Escape' });
    expect(document.querySelectorAll('[data-command-palette]')).toHaveLength(0);

    await press({ key: '?' });
    expect([...document.querySelectorAll('[role="dialog"]')].map((one) => one.textContent?.includes('Keyboard shortcuts'))).toEqual([true]);
  });
});
