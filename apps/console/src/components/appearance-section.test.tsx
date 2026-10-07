// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember } from '@/lib/api';

/** Settings → Appearance: the color mode, each repository's color and each crew member's. */

const saved = vi.hoisted(() => ({
  repos: [] as unknown[][],
  crew: [] as unknown[][],
  refuse: null as string | null,
  hold: null as (() => Promise<{ ok: boolean; error?: string }>) | null,
}));
vi.mock('@/app/actions', () => ({
  updateRepoSettings: vi.fn(async (...args: unknown[]) => {
    saved.repos.push(args);
    return saved.hold ? saved.hold() : { ok: true };
  }),
  setCrewColor: vi.fn(async (...args: unknown[]) => {
    saved.crew.push(args);
    return saved.refuse ? { ok: false, error: saved.refuse } : { ok: true };
  }),
}));
import { AppearanceSection } from './settings-sections';

const REPOS = [
  { name: 'api', color: 'blue' },
  { name: 'website', color: 'amber' },
];

const CREW = [
  { name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', authorization: 'active', githubLogin: 'fleetadlc-atlas-janedoe', color: null },
  { name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', authorization: 'unauthorized', githubLogin: null, color: 'rose' },
  { name: 'ottoexampleco', slot: 'intake', role: 'intake', authorization: 'active', githubLogin: 'ottoexampleco' },
] as unknown as CrewMember[];

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  saved.repos.length = 0;
  saved.crew.length = 0;
  saved.refuse = null;
  saved.hold = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(): Promise<void> {
  await act(async () => root.render(<AppearanceSection repositories={REPOS} crew={CREW} />));
}

function group(label: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${label}"]`);
  if (!found) {
    const labels = [...container.querySelectorAll('[role="radiogroup"]')].map((one) => one.getAttribute('aria-label'));
    throw new Error(`no radiogroup ${label}: ${labels.join(', ')}`);
  }
  return found;
}

function checked(label: string): string | null {
  return group(label).querySelector('[aria-checked="true"]')?.getAttribute('aria-label') ?? null;
}

async function choose(label: string, swatch: string): Promise<void> {
  const button = group(label).querySelector<HTMLButtonElement>(`[aria-label="${swatch}"]`);
  if (!button) throw new Error(`no ${swatch} in ${label}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The row a radiogroup is on, for the avatar beside it. */
function avatarBeside(label: string): HTMLElement {
  return group(label).closest('.border-t, .first-of-type\\:border-t-0')!.querySelector<HTMLElement>('span[aria-hidden].rounded-full')!;
}

describe('Settings → Appearance', () => {
  it('says Color, in American spelling', async () => {
    await mount();
    expect(container.textContent).toContain('Color mode');
    expect(container.querySelector('[aria-label="Color mode"]')).not.toBeNull();
    expect(container.textContent).toContain('Repository colors');
    expect(container.textContent).toContain('Crew colors');
    expect(container.innerHTML).not.toMatch(/colour/i);
  });
});

describe('repository colors, in Appearance', () => {
  it('lists each repository with its name and the palette, its color checked', async () => {
    await mount();
    expect(container.textContent).toContain('api');
    expect(container.textContent).toContain('website');
    const swatches = [...group('api color').querySelectorAll('[role="radio"]')].map((one) => one.getAttribute('aria-label'));
    expect(swatches).toEqual(['Blue', 'Amber', 'Pink', 'Teal', 'Violet', 'Orange']);
    expect(checked('api color')).toBe('Blue');
    expect(checked('website color')).toBe('Amber');
  });

  it('saves a swatch through the repository’s own PATCH, and only that repository', async () => {
    await mount();
    await choose('api color', 'Teal');
    expect(saved.repos).toEqual([['api', { color: 'teal' }]]);
    expect(checked('api color')).toBe('Teal');
    expect(checked('website color')).toBe('Amber');
    expect(container.textContent).toContain('Saved');
  });

  it('saves nothing when the color chosen is the one it has', async () => {
    await mount();
    await choose('api color', 'Blue');
    expect(saved.repos).toEqual([]);
  });

  async function bothInFlight(): Promise<Array<(result: { ok: boolean; error?: string }) => void>> {
    const pending: Array<(result: { ok: boolean; error?: string }) => void> = [];
    saved.hold = () => new Promise((resolve) => pending.push(resolve));
    await mount();
    const teal = group('api color').querySelector<HTMLButtonElement>('[aria-label="Teal"]');
    const pink = group('api color').querySelector<HTMLButtonElement>('[aria-label="Pink"]');
    if (!teal || !pink) throw new Error('missing swatch');
    await act(async () => {
      teal.click();
    });
    await act(async () => {
      pink.click();
    });
    return pending;
  }

  it('keeps Teal when Pink on the same row is refused after Teal was saved', async () => {
    const pending = await bothInFlight();
    await act(async () => {
      pending[0]!({ ok: true });
    });
    await act(async () => {
      pending[1]!({ ok: false, error: 'refused' });
    });
    expect(checked('api color')).toBe('Teal');
  });

  it('keeps Teal when the refusal arrives before Teal’s save does', async () => {
    const pending = await bothInFlight();
    await act(async () => {
      pending[1]!({ ok: false, error: 'refused' });
    });
    await act(async () => {
      pending[0]!({ ok: true });
    });
    expect(checked('api color')).toBe('Teal');
  });

  it('puts an earlier row back when the bridge refuses it, even while a later row is still saving', async () => {
    const pending = new Map<string, (result: { ok: boolean; error?: string }) => void>();
    saved.hold = () =>
      new Promise((resolve) => {
        const name = String(saved.repos.at(-1)?.[0]);
        pending.set(name, resolve);
      });
    await mount();
    const teal = group('api color').querySelector<HTMLButtonElement>('[aria-label="Teal"]');
    const pink = group('website color').querySelector<HTMLButtonElement>('[aria-label="Pink"]');
    if (!teal || !pink) throw new Error('missing swatch');
    await act(async () => {
      teal.click();
    });
    await act(async () => {
      pink.click();
    });
    await act(async () => {
      pending.get('api')!({ ok: false, error: 'refused' });
    });
    expect(checked('api color')).toBe('Blue');
    await act(async () => {
      pending.get('website')!({ ok: true });
    });
    expect(checked('api color')).toBe('Blue');
    expect(checked('website color')).toBe('Pink');
    expect(container.textContent).toContain('Saved');
  });
});

describe('crew colors, in Appearance', () => {
  it('lists each crew member in pipeline order with its avatar, name and role, and By role then the eight tints', async () => {
    await mount();
    const groups = [...container.querySelectorAll('[role="radiogroup"]')].map((one) => one.getAttribute('aria-label'));
    expect(groups.filter((label) => label?.endsWith(' color') && !label.startsWith('api') && !label.startsWith('website'))).toEqual([
      'ottoexampleco color',
      'fleetadlc-atlas-janedoe color',
      'Lead reviewer color',
    ]);
    expect(container.textContent).toContain('Builder');
    expect(container.textContent).toContain('Not connected yet');
    const swatches = [...group('fleetadlc-atlas-janedoe color').querySelectorAll('[role="radio"]')].map((one) => one.getAttribute('aria-label'));
    expect(swatches).toEqual(['By role', 'Sand', 'Blue', 'Mint', 'Violet', 'Rose', 'Sky', 'Olive', 'Green']);
  });

  it('outlines every crew swatch in dim, which keeps 3:1 against the panel, so a quiet tint is still seen', async () => {
    await mount();
    const fills = [...group('fleetadlc-atlas-janedoe color').querySelectorAll('[role="radio"] > span')].map((one) => one.className);
    expect(fills).toHaveLength(9);
    for (const fill of fills) expect(fill).toContain('border-dim');
    expect(fills[0]).toContain('border-dashed');
  });

  it('tells two unconnected seats of one role apart by name', async () => {
    const second = { ...CREW[0]!, name: 'builder-2', slot: 'builder-2', githubLogin: null, authorization: 'unauthorized' } as CrewMember;
    await act(async () => root.render(<AppearanceSection repositories={REPOS} crew={[...CREW, second]} />));
    // roleTitle numbers the seat added beside the first, so the two are not both "Builder color".
    expect(group('Builder 2 color')).toBeTruthy();
  });

  it('checks By role for a bot with no color, and the stored one for a bot with one', async () => {
    await mount();
    expect(checked('fleetadlc-atlas-janedoe color')).toBe('By role');
    expect(checked('ottoexampleco color')).toBe('By role');
    expect(checked('Lead reviewer color')).toBe('Rose');
    expect(avatarBeside('Lead reviewer color').className).toContain('bg-tint-rose');
    expect(avatarBeside('fleetadlc-atlas-janedoe color').className).toContain('bg-tint-mint');
  });

  it('saves a tint for that bot, and draws its avatar in it', async () => {
    await mount();
    await choose('fleetadlc-atlas-janedoe color', 'Sky');
    expect(saved.crew).toEqual([['fleetadlc-atlas-janedoe', 'sky']]);
    expect(checked('fleetadlc-atlas-janedoe color')).toBe('Sky');
    expect(avatarBeside('fleetadlc-atlas-janedoe color').className).toContain('bg-tint-sky');
  });

  it('goes back to the role’s tint with By role, saved as null', async () => {
    await mount();
    await choose('Lead reviewer color', 'By role');
    expect(saved.crew).toEqual([['lead-reviewer', null]]);
    expect(avatarBeside('Lead reviewer color').className).toContain('bg-tint-violet');
  });

  it('puts the swatch back and says why when the bridge refuses', async () => {
    saved.refuse = "a crew member's color is one of sand, blue";
    await mount();
    await choose('fleetadlc-atlas-janedoe color', 'Olive');
    expect(checked('fleetadlc-atlas-janedoe color')).toBe('By role');
    expect(container.textContent).toContain("Not saved: a crew member's color is one of sand, blue");
  });
});
