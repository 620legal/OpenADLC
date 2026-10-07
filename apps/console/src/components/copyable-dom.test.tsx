// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Copyable } from './copyable';

/**
 * A value to copy says "copied" only when it was: over plain HTTP there is no
 * clipboard, and the person pasted whatever was on it before.
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function press(value: string): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () => createRoot(host).render(<Copyable value={value} />));
  await act(async () => host.querySelector('button')!.click());
  return host;
}

/** What the button says of the copy, beside the value. */
function said(host: HTMLElement): string | null | undefined {
  return host.querySelector('button > span:last-child')?.textContent;
}

describe('copying a value', () => {
  it('says copied when the clipboard took it', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const host = await press('s3cret-password');
    expect(writeText).toHaveBeenCalledWith('s3cret-password');
    expect(said(host)).toBe('copied');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('copies the older way where there is no clipboard, and says so only when that worked', async () => {
    vi.stubGlobal('navigator', {});
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    const host = await press('s3cret-password');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(said(host)).toBe('copied');
  });

  it('says it did not copy, and shows the whole value to select, when nothing worked', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => Promise.reject(new Error('NotAllowedError')) } });
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
    const host = await press('gh api repos/exampleco/api/invitations --paginate');
    expect(said(host)).toBe('not copied');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('select it and copy');
    expect(host.querySelector('code.select-all')?.textContent).toBe('gh api repos/exampleco/api/invitations --paginate');
  });
});
