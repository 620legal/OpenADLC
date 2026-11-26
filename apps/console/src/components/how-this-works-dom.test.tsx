// @vitest-environment happy-dom
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripKey } from '@/lib/how-this-works-preferences';
import { DOCS_BASE, HOW_THIS_WORKS, HowThisWorks } from './how-this-works';
import { ViewerProvider } from './viewer';

/**
 * A strip is open on a person's first visit, stays the way they left it on the
 * next, and starts open for someone else signed in on the same browser.
 */

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  unmount();
  container.remove();
  vi.restoreAllMocks();
});

function mount(identity: string | null | 'no provider') {
  unmount();
  root = createRoot(container);
  const strip = <HowThisWorks {...HOW_THIS_WORKS.costs} />;
  act(() => root!.render(identity === 'no provider' ? strip : <ViewerProvider identity={identity}>{strip}</ViewerProvider>));
}

function unmount() {
  if (!root) return;
  const leaving = root;
  root = null;
  act(() => leaving.unmount());
}

function toggle(): HTMLButtonElement {
  return container.querySelector('button')!;
}

function steps(): HTMLElement {
  return document.getElementById(toggle().getAttribute('aria-controls')!)!;
}

function click() {
  act(() => toggle().click());
}

function isOpen(): boolean {
  const expanded = toggle().getAttribute('aria-expanded');
  expect(steps().hidden).toBe(expanded !== 'true');
  return expanded === 'true';
}

describe('a How this works strip', () => {
  it('is open on a first visit', () => {
    mount('a@x');
    expect(isOpen()).toBe(true);
    expect(steps().querySelectorAll('li')).toHaveLength(HOW_THIS_WORKS.costs.steps.length);
  });

  it('is still collapsed after it is drawn again, and open again once reopened', () => {
    mount('a@x');
    click();
    expect(isOpen()).toBe(false);
    mount('a@x');
    expect(isOpen()).toBe(false);
    click();
    mount('a@x');
    expect(isOpen()).toBe(true);
  });

  it('starts open for another person on the same browser', () => {
    mount('a@x');
    click();
    mount('b@x');
    expect(isOpen()).toBe(true);
    expect(localStorage.getItem(stripKey('costs', 'a@x'))).toBe('closed');
    expect(localStorage.getItem(stripKey('costs', 'b@x'))).toBeNull();
  });

  it('is open with no one signed in, toggles for the page, and stores nothing', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    mount('no provider');
    expect(isOpen()).toBe(true);
    click();
    expect(isOpen()).toBe(false);
    mount('no provider');
    expect(isOpen()).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('is open when storage throws, and its toggle still works for the page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    mount('a@x');
    expect(isOpen()).toBe(true);
    click();
    expect(isOpen()).toBe(false);
    click();
    expect(isOpen()).toBe(true);
  });

  it('follows another strip of its kind collapsed in the same tab', () => {
    mount('a@x');
    const other = document.createElement('div');
    document.body.appendChild(other);
    const otherRoot = createRoot(other);
    act(() =>
      otherRoot.render(
        <ViewerProvider identity="a@x">
          <HowThisWorks {...HOW_THIS_WORKS.costs} />
        </ViewerProvider>,
      ),
    );
    act(() => other.querySelector('button')!.click());
    expect(isOpen()).toBe(false);
    act(() => otherRoot.unmount());
    other.remove();
  });

  it('is a real button that names what it controls, with a link to the record on GitHub', () => {
    mount('a@x');
    expect(toggle().tagName).toBe('BUTTON');
    expect(toggle().type).toBe('button');
    expect(toggle().textContent).toContain(HOW_THIS_WORKS.costs.title);
    expect(steps().id).not.toBe('');
    const link = steps().querySelector('a')!;
    expect(link.getAttribute('href')!.startsWith(DOCS_BASE)).toBe(true);
    expect(link.getAttribute('target')).toBe('_blank');
  });
});

describe('the strips’ content', () => {
  it('gives every strip three or four steps and a link to OpenADLC’s file on GitHub', () => {
    for (const [id, strip] of Object.entries(HOW_THIS_WORKS)) {
      expect(strip.strip).toBe(id);
      expect(strip.steps.length).toBeGreaterThanOrEqual(3);
      expect(strip.steps.length).toBeLessThanOrEqual(4);
      expect(strip.link.href.startsWith(DOCS_BASE)).toBe(true);
    }
  });

  it('links only to files this repository has, so a renamed record breaks the test, not the link', () => {
    // Under happy-dom `import.meta.url` is not a file URL, so the repository
    // is found from where the run started: the package, or the root.
    let repoRoot = process.cwd();
    while (!existsSync(join(repoRoot, 'AGENTS.md')) && dirname(repoRoot) !== repoRoot) repoRoot = dirname(repoRoot);
    for (const strip of Object.values(HOW_THIS_WORKS)) {
      const file = strip.link.href.slice(DOCS_BASE.length).split('#')[0]!;
      expect(existsSync(join(repoRoot, file)), file).toBe(true);
    }
  });
});
