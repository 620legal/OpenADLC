// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember } from '@/lib/api';

const saved = vi.hoisted(() => [] as unknown[][]);
vi.mock('@/app/actions', () => ({
  setCrewAvatar: vi.fn(async (...args: unknown[]) => (saved.push(args), { ok: true })),
  setCrewColor: vi.fn(async () => ({ ok: true })),
  updateRepoSettings: vi.fn(async () => ({ ok: true })),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
import { AvatarPicker, BotAvatar } from './avatar';
import { AVATARS, avatarOf, EngineMarkSvg, MARK_FLOOR, type EngineMark } from './engine-avatars';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const BUILDER = { name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', authorization: 'active', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude' };

/** Whether the person's system asks for less motion, as `matchMedia` answers it. */
let reduced = false;

beforeEach(() => {
  reduced = false;
  saved.length = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduced : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a crew member’s avatar', () => {
  it('is drawn in its role’s tint when nobody chose a color', () => {
    const html = renderToStaticMarkup(<BotAvatar bot={BUILDER} />);
    expect(html).toContain('bg-tint-mint');
  });

  it('is drawn in the color a person chose over its role’s tint', () => {
    const html = renderToStaticMarkup(<BotAvatar bot={{ ...BUILDER, color: 'rose' }} />);
    expect(html).toContain('bg-tint-rose');
    expect(html).not.toContain('bg-tint-mint');
  });
});

describe('the avatars a crew member can show', () => {
  it('are the ones the bridge stores, in the same order', () => {
    // Two copies of one list: the console does not depend on @fleetadlc/shared.
    const shared = /AVATARS = \[([^\]]+)\]/.exec(read('../../../../packages/shared/src/avatars.ts'))?.[1];
    expect(shared?.split(',').map((entry) => entry.trim().replace(/'/g, ''))).toEqual([...AVATARS]);
  });

  it('are its engine’s mark by default', () => {
    expect(avatarOf({ engine: 'claude' })).toBe('petals');
    expect(avatarOf({ engine: 'codex' })).toBe('dots');
    expect(avatarOf({ engine: 'grok' })).toBe('orbit');
    expect(avatarOf({ engine: 'none' })).toBe('gear');
    expect(avatarOf({ role: 'automation' })).toBe('gear');
    // A view that does not say what the bot thinks with shows its letters.
    expect(avatarOf({})).toBe('initials');
    expect(avatarOf({ engine: 'claude', avatar: 'a-logo' })).toBe('petals');
  });

  it('render the engine’s design by default, with no letters', () => {
    const html = renderToStaticMarkup(<BotAvatar bot={BUILDER} size="lg" />);
    expect(html).toContain('data-avatar="petals"');
    expect(html).toContain('<svg');
    expect(html).not.toContain('>AJ<');
    expect(renderToStaticMarkup(<BotAvatar bot={{ ...BUILDER, engine: 'codex' }} />)).toContain('data-avatar="dots"');
  });

  it('render the initials when a person chose them, and another design when they chose one', () => {
    const initials = renderToStaticMarkup(<BotAvatar bot={{ ...BUILDER, avatar: 'initials' }} size="lg" status="working" />);
    expect(initials).toContain('>AJ<');
    expect(initials).not.toContain('<svg');
    expect(renderToStaticMarkup(<BotAvatar bot={{ ...BUILDER, avatar: 'orbit' }} />)).toContain('data-avatar="orbit"');
  });

  it('stay hidden from a screen reader, which reads the name beside them', () => {
    const html = renderToStaticMarkup(<BotAvatar bot={BUILDER} size="xl" />);
    expect(html).toMatch(/^<span aria-hidden="true"/);
    expect(html).toContain('<svg viewBox="0 0 24 24" aria-hidden="true"');
  });
});

describe('an avatar’s motion', () => {
  const moving = (html: string): boolean => /avatar-(moving|breathe|ripple|orbit|tick)/.test(html);

  it('moves only while the bot works, at a large size', () => {
    for (const size of ['lg', 'xl', 'chat'] as const) {
      expect(moving(renderToStaticMarkup(<BotAvatar bot={BUILDER} size={size} status="working" />)), size).toBe(true);
      expect(moving(renderToStaticMarkup(<BotAvatar bot={BUILDER} size={size} status="idle" />)), size).toBe(false);
      expect(moving(renderToStaticMarkup(<BotAvatar bot={BUILDER} size={size} status="waiting" />)), size).toBe(false);
    }
    // A crew card has no dot, and says it works in its pill.
    expect(moving(renderToStaticMarkup(<BotAvatar bot={BUILDER} size="lg" working />))).toBe(true);
  });

  it('stays on its resting frame at small sizes even while the bot works', () => {
    for (const size of ['xs', 'sm', 'md'] as const) {
      expect(moving(renderToStaticMarkup(<BotAvatar bot={BUILDER} size={size} status="working" />)), size).toBe(false);
    }
  });

  it('renders no animation class under prefers-reduced-motion, even while the bot works', async () => {
    reduced = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    for (const engine of ['claude', 'codex', 'grok', 'none']) {
      await act(async () => root.render(<BotAvatar bot={{ ...BUILDER, engine }} size="xl" status="working" />));
      expect(container.querySelector('svg'), engine).not.toBeNull();
      expect(moving(container.innerHTML), engine).toBe(false);
    }
    reduced = false;
    await act(async () => root.render(<BotAvatar bot={{ ...BUILDER, engine: 'grok' }} size="lg" status="working" />));
    expect(moving(container.innerHTML)).toBe(true);
    act(() => root.unmount());
    container.remove();
  });

  it('is stopped by the stylesheet under reduced motion before the page has read the setting', () => {
    const css = read('../app/globals.css');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.avatar-moving,\s*\.avatar-moving \* \{\s*animation: none !important;/);
  });
});

describe('each mark, drawn', () => {
  // A snapshot of each resting frame, so a change to one is a deliberate one.
  const drawn = (mark: EngineMark): string => {
    const html = renderToStaticMarkup(<EngineMarkSvg mark={mark} />);
    expect(html.length, 'a few hundred bytes, give or take').toBeLessThan(1600);
    expect(html).not.toMatch(/<image|href=|url\(/);
    // No part fainter than the floor contrast.test.ts measures at 3:1.
    for (const [, opacity] of html.matchAll(/opacity="([\d.]+)"/g)) expect(Number(opacity)).toBeGreaterThanOrEqual(MARK_FLOOR);
    return html;
  };

  it('never fade below the floor while they move', () => {
    const css = read('../app/globals.css');
    const ripple = /@keyframes avatar-ripple \{[\s\S]*?opacity: ([\d.]+);/.exec(css)?.[1];
    expect(Number(ripple)).toBeGreaterThanOrEqual(MARK_FLOOR);
    // The petals are drawn at 0.72 and breathe down to this.
    const breathe = /@keyframes avatar-breathe \{[\s\S]*?opacity: ([\d.]+);/.exec(css)?.[1];
    expect(0.72 * Number(breathe)).toBeGreaterThanOrEqual(MARK_FLOOR);
  });

  it('orbit has nothing crossing its ring corner to corner', () => {
    const html = drawn('orbit');
    expect(html).not.toMatch(/<(line|path) [^>]*d="M[\d.]+ [\d.]+ L/);
  });

  it('petals', () => {
    expect(drawn('petals')).toMatchInlineSnapshot(`"<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="size-[78%] overflow-visible" fill="currentColor"><g><ellipse cx="12" cy="6.6" rx="2.7" ry="3.6" opacity="0.72" transform="rotate(0 12 12)"></ellipse><ellipse cx="12" cy="6.6" rx="2.7" ry="3.6" opacity="0.72" transform="rotate(60 12 12)"></ellipse><ellipse cx="12" cy="6.6" rx="2.7" ry="3.6" opacity="0.72" transform="rotate(120 12 12)"></ellipse><ellipse cx="12" cy="6.6" rx="2.7" ry="3.6" opacity="0.72" transform="rotate(180 12 12)"></ellipse><ellipse cx="12" cy="6.6" rx="2.7" ry="3.6" opacity="0.72" transform="rotate(240 12 12)"></ellipse><ellipse cx="12" cy="6.6" rx="2.7" ry="3.6" opacity="0.72" transform="rotate(300 12 12)"></ellipse><circle cx="12" cy="12" r="2.4"></circle></g></svg>"`);
  });

  it('dots', () => {
    expect(drawn('dots')).toMatchInlineSnapshot(`"<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="size-[78%] overflow-visible" fill="currentColor"><circle cx="6" cy="6" r="2.1" opacity="0.6"></circle><circle cx="12" cy="6" r="2.1" opacity="0.8"></circle><circle cx="18" cy="6" r="2.1" opacity="1"></circle><circle cx="6" cy="12" r="2.1" opacity="0.8"></circle><circle cx="12" cy="12" r="2.1" opacity="1"></circle><circle cx="18" cy="12" r="2.1" opacity="0.6"></circle><circle cx="6" cy="18" r="2.1" opacity="1"></circle><circle cx="12" cy="18" r="2.1" opacity="0.6"></circle><circle cx="18" cy="18" r="2.1" opacity="0.8"></circle></svg>"`);
  });

  it('orbit', () => {
    expect(drawn('orbit')).toMatchInlineSnapshot(`"<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="size-[78%] overflow-visible" fill="currentColor"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="1.4 2.6" stroke-linecap="round" opacity="0.8"></circle><path d="M7 12 A5 5 0 0 1 12 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path><circle cx="12" cy="12" r="1.5"></circle><g><circle cx="12" cy="4" r="1.9"></circle></g></svg>"`);
  });

  it('gear', () => {
    expect(drawn('gear')).toMatchInlineSnapshot(`"<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="size-[78%] overflow-visible" fill="currentColor"><g><path fill-rule="evenodd" d="M12.00,3.00 L13.76,3.17 L14.60,5.72 L15.78,6.35 L18.36,5.64 L19.48,7.00 L18.28,9.40 L18.67,10.67 L21.00,12.00 L20.83,13.76 L18.28,14.60 L17.65,15.78 L18.36,18.36 L17.00,19.48 L14.60,18.28 L13.33,18.67 L12.00,21.00 L10.24,20.83 L9.40,18.28 L8.22,17.65 L5.64,18.36 L4.52,17.00 L5.72,14.60 L5.33,13.33 L3.00,12.00 L3.17,10.24 L5.72,9.40 L6.35,8.22 L5.64,5.64 L7.00,4.52 L9.40,5.72 L10.67,5.33 Z M12 9.2 A2.8 2.8 0 1 0 12 14.8 A2.8 2.8 0 1 0 12 9.2 Z"></path></g></svg>"`);
  });
});

describe('choosing an avatar', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function options(): string[] {
    return [...container.querySelectorAll('[role="radio"]')].map(
      (one) => `${one.getAttribute('aria-label')}${one.getAttribute('aria-checked') === 'true' ? ' *' : ''}`,
    );
  }

  it('offers by engine first, then each design and the initials, each drawn as the avatar would be', async () => {
    const chose: unknown[] = [];
    await act(async () => root.render(<AvatarPicker label="builder avatar" bot={BUILDER} value={null} onChoose={(one) => chose.push(one)} />));
    expect(options()).toEqual(['By engine (Petals) *', 'Petals', 'Dot grid', 'Orbit', 'Gear', 'Initials']);
    expect(container.textContent).toContain('By engine');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Initials"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="By engine (Petals)"]')!.click());
    expect(chose).toEqual(['initials', null]);
    // The previews never move, whatever the bot is doing.
    expect(container.innerHTML).not.toMatch(/avatar-moving/);
  });

  it('marks the stored choice', async () => {
    await act(async () => root.render(<AvatarPicker label="builder avatar" bot={BUILDER} value="dots" onChoose={() => undefined} />));
    expect(options()).toContain('Dot grid *');
  });

  it('is not offered on the crew page to a user, only to an admin', async () => {
    const { CrewView } = await import('./crew-view');
    const { RoleProvider } = await import('./app-header');
    const { headerData } = await import('@/lib/header');
    const member = { ...BUILDER, displayName: 'Builder', model: 'claude-sonnet-5', status: 'stopped', container: 'bot-x', tokenExpiresAt: null, now: '', paused: false, sessions: [], avatar: null } as unknown as CrewMember;
    const header = headerData({ repos: ['fleetadlc'], crew: [member], budget: null, needsYou: 0 });
    await act(async () =>
      root.render(
        <RoleProvider role="user">
          <CrewView crew={[member]} accounts={[]} byBot={[]} header={header} now="2026-09-30T10:00:00.000Z" />
        </RoleProvider>,
      ),
    );
    expect(container.querySelector('[data-avatar="petals"]')).not.toBeNull();
    expect(container.querySelector('[role="radiogroup"][aria-label$=" avatar"]')).toBeNull();
    expect(container.textContent).not.toContain('By engine');
  });

  it('is saved from the seat’s settings on the crew page, not from its card', async () => {
    // It took a row of every card for something set once; it is in the seat's panel now.
    const { seatTabs } = await import('./seat-controls');
    const member = { ...BUILDER, displayName: 'Builder', model: 'claude-sonnet-5', status: 'stopped', container: 'bot-x', tokenExpiresAt: null, now: '', paused: false, sessions: [], avatar: null } as unknown as CrewMember;
    const settings = seatTabs({ bot: member, accounts: [], listings: null, now: '2026-09-30T10:00:00.000Z' }).find((tab) => tab.value === 'settings')!;
    await act(async () => root.render(<>{settings.content}</>));
    expect(options()).toContain('By engine (Petals) *');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="radiogroup"][aria-label="fleetadlc-atlas-janedoe avatar"] [aria-label="Initials"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(saved).toEqual([['fleetadlc-atlas-janedoe', 'initials']]);
    expect(options()).toContain('Initials *');
    expect(container.textContent).toContain('Saved');
  });
});
