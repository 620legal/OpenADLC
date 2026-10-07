// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { isPlainClick, PrivateLink } from './create-account';

async function mount(): Promise<{ container: HTMLElement; link: HTMLAnchorElement; done: () => void }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<PrivateLink href="https://github.com/signup">github.com/signup</PrivateLink>);
  });
  return {
    container,
    link: container.querySelector('a')!,
    done: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('a link to open in a private window', () => {
  it('asks first on a plain click, and does not open the page here', async () => {
    const { container, link, done } = await mount();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Open it in a private window');
    done();
  });

  it('lets a click that asks for a tab or a window through, from somebody who knows', () => {
    expect(isPlainClick({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBe(true);
    expect(isPlainClick({ button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false);
    expect(isPlainClick({ button: 0, metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toBe(false);
    expect(isPlainClick({ button: 1, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false);
  });

  it('copies the link and says the keys for a private window, or opens it here when asked', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { container, link, done } = await mount();
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    const button = (text: string) => [...container.querySelectorAll('button')].find((el) => el.textContent === text);
    await act(async () => {
      button('Copy link')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith('https://github.com/signup');
    expect(container.textContent).toMatch(/Copied\. Press (⌘⇧N|Ctrl\+Shift\+N) for a private window and paste it\./);
    await act(async () => {
      button('Open here anyway')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(open).toHaveBeenCalledWith('https://github.com/signup', '_blank', 'noreferrer');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    open.mockRestore();
    done();
  });

  it('says Firefox’s keys for a private window in Firefox, where ⇧N reopens a closed window', async () => {
    const agent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0');
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
    const { container, link, done } = await mount();
    expect(container.textContent).toContain('Right-click → open the link in a private window');
    expect(container.textContent).not.toContain('Incognito');
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((el) => el.textContent === 'Copy link')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Press Ctrl+Shift+P for a private window');
    agent.mockRestore();
    platform.mockRestore();
    done();
  });

  it('goes away when dismissed, when the link is right-clicked, or when this window loses the focus to another', async () => {
    const dialog = (container: HTMLElement) => container.querySelector('[role="dialog"]');
    const open = async (link: HTMLAnchorElement) =>
      act(async () => {
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      });

    const { container, link, done } = await mount();
    await open(link);
    await act(async () => {
      container.querySelector('button[aria-label="Dismiss"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(dialog(container)).toBeNull();

    await open(link);
    await act(async () => {
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    });
    expect(dialog(container)).toBeNull();

    await open(link);
    expect(dialog(container)).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(dialog(container)).toBeNull();
    done();
  });
});

