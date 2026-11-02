// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeysHelp } from './keys-help';

/** `?` lists the console's keys on any page, and is a question mark in a field. */

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <input aria-label="A field" />
        <KeysHelp />
      </>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function press(key: string, target: EventTarget = document.activeElement ?? document.body): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;

describe('the keys list', () => {
  it('opens on ?, titled for a screen reader, with every key, and closes on Esc', async () => {
    await press('?', document.body);
    const open = dialog()!;
    expect(document.getElementById(open.getAttribute('aria-labelledby')!)?.textContent).toBe('Keyboard shortcuts');
    const keys = [...open.querySelectorAll('dt')].map((one) => one.textContent);
    expect(keys).toEqual(['⌘K', '?', 'Esc', 'j', 'k', '1–9', 'Enter']);
    expect(open.textContent).toContain('Needs you');

    await press('Escape');
    expect(dialog()).toBeNull();
  });

  it('opens nothing for ? typed in a text field', async () => {
    const field = container.querySelector('input')!;
    field.focus();
    await press('?', field);
    expect(dialog()).toBeNull();
  });

  it('says Ctrl K off a Mac', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
    await press('?', document.body);
    expect(dialog()!.querySelector('dt')?.textContent).toBe('CtrlK');
  });
});
