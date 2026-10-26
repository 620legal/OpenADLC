// @vitest-environment happy-dom
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { Component, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleUpdatedNotice } from '@/components/console-updated';
import { PauseWorkCard } from '@/components/pause-work';
import { sayConsoleUpdated } from '@/lib/console-updated';
import PageError from './error';

/**
 * What happened on the cloud install: Settings was open while the console
 * updated, and Pause work → Confirm was the next action. The action's id
 * belonged to the build the page came from, Next rejected it, and the
 * rejection, inside the card's transition, reached the page's error boundary.
 */

const reload = vi.hoisted(() => vi.fn());
vi.mock('@/app/actions', () => ({
  pauseWork: vi.fn(async () => {
    throw new UnrecognizedActionError(
      'Server Action "60a4dd1dc477e939b91262212479c9ac135159a0e9" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    );
  }),
  resumeWork: vi.fn(async () => ({ ok: true })),
}));

/** Next's boundary around a page, drawing `error.tsx` with what was thrown. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? <PageError error={this.state.error} reset={() => this.setState({ error: null })} /> : this.props.children;
  }
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // React reports the error it caught; that is not what is under test.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__openadlcConsoleUpdated;
});

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')];
}

async function press(label: string): Promise<void> {
  const found = buttons().find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no button says ${label}: ${buttons().map((one) => one.textContent).join(', ')}`);
  await act(async () => {
    found.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('Pause work pressed on a page from before an update', () => {
  it('says the console was updated and the work was not paused, and offers only a reload', async () => {
    await act(async () =>
      root.render(
        <Boundary>
          <PauseWorkCard initial={{ paused: null, repos: {} }} />
        </Boundary>,
      ),
    );
    await press('Pause work');
    await press('Confirm');

    const text = container.textContent ?? '';
    expect(text).toContain('The console was updated');
    expect(text).toContain('what you just did was not done');
    expect(text).not.toContain('Server Action');
    expect(text).not.toContain('60a4dd1d');
    // Try again would send the same refused id again.
    expect(buttons().map((one) => one.textContent?.trim())).toEqual(['Reload the page']);

    await press('Reload the page');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps one reload on screen when the notice over the page had already said it', async () => {
    // The page's own check found the update first, and the person pressed on.
    await act(async () =>
      root.render(
        <>
          <Boundary>
            <PauseWorkCard initial={{ paused: null, repos: {} }} />
          </Boundary>
          <ConsoleUpdatedNotice />
        </>,
      ),
    );
    await act(async () => sayConsoleUpdated());
    expect(buttons().filter((one) => one.textContent?.trim() === 'Reload the page')).toHaveLength(1);

    await press('Pause work');
    await press('Confirm');
    expect(container.textContent).toContain('what you just did was not done');
    expect(buttons().map((one) => one.textContent?.trim())).toEqual(['Reload the page']);
  });
});
