import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelRead } from '@/lib/api';

/**
 * The panel is drawn by the root layout beside every page for someone the
 * install knows, and is hidden below md by its class alone, so the server's
 * drawing and a phone's agree.
 */

const me = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  readMe: vi.fn(async () => me.value),
  readBrand: vi.fn(async () => null),
}));

import RootLayout from '../app/layout';
import { SidePanel } from './side-panel';

const READ: PanelRead = {
  attention: [],
  tasks: { running: [], recent: [] },
};

beforeEach(() => {
  me.value = null;
});

async function layoutMarkup(): Promise<string> {
  return renderToStaticMarkup(await RootLayout({ children: <main>the page</main> }));
}

describe('the side panel in the root layout (#376)', () => {
  it('sits beside the page for someone the install knows', async () => {
    me.value = { known: true, email: 'jane@example.com', role: 'user' };
    const html = await layoutMarkup();
    // The page in its own column, and the panel's place beside it: the panel
    // draws nothing on the server, before its first read.
    expect(html).toMatch(/<div class="md:flex"><div class="min-w-0 flex-1"><main>the page<\/main><\/div><\/div>/);
  });

  it('is not drawn for someone the install does not know, whom the bridge refuses', async () => {
    me.value = { known: false, email: 'stranger@example.com', admins: [] };
    const html = await layoutMarkup();
    expect(html).not.toContain('md:flex');
    expect(html).not.toContain('the page');
  });
});

describe('the side panel’s width (#376)', () => {
  function asideClasses(html: string): string[] {
    const match = /<aside[^>]*class="([^"]*)"/.exec(html);
    return match?.[1]?.split(/\s+/) ?? [];
  }

  it('is hidden below md and a flex column from md up, open or collapsed, with no other display class', () => {
    const html = renderToStaticMarkup(<SidePanel initial={READ} />);
    expect(html).toContain('aria-label="Crew panel"');
    const classes = asideClasses(html);
    expect(classes).toContain('hidden');
    expect(classes).toContain('md:flex');
    const display = /^(?:[a-z0-9]+:)*(block|inline|inline-block|flex|inline-flex|grid|inline-grid|contents|table|hidden)$/;
    expect(classes.filter((one) => display.test(one)).sort()).toEqual(['hidden', 'md:flex']);
  });

  it('draws nothing at all before it has read anything', () => {
    expect(renderToStaticMarkup(<SidePanel />)).toBe('');
    expect(renderToStaticMarkup(<SidePanel initial={{ tasks: null, attention: [] }} />)).toBe('');
  });
});
