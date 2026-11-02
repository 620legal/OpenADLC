// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_KEYS, storeAlert } from '@/lib/alert-preferences';
import type { HeaderData, NeedsItem } from '@/lib/header';
import { faviconSvg } from '@/lib/needs-you-alerts';
import { BrandProvider } from './app-header';
import { AlertsMenu, forgetSeenItems, NeedsYouAlerts } from './needs-you-alerts';

/**
 * A console tab in the background: its title and icon say what waits, and,
 * when switched on, a notification says what is new and opens it.
 */

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

/** The browser's notifications, as a stand-in that records what was raised. */
class FakeNotification {
  static permission = 'granted';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static raised: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  closed = false;
  constructor(
    readonly title: string,
    readonly options: { tag?: string },
  ) {
    FakeNotification.raised.push(this);
  }
  close() {
    this.closed = true;
  }
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  forgetSeenItems();
  localStorage.clear();
  document.title = '';
  FakeNotification.permission = 'granted';
  FakeNotification.raised = [];
  FakeNotification.requestPermission.mockClear();
  router.push.mockClear();
  vi.stubGlobal('Notification', FakeNotification);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const ASKED: NeedsItem = { id: 'gate:1', text: 'The builder has a question about #42', item: 'OpenADLC#42' };
const FAILED: NeedsItem = { id: 'task:2', text: 'The builder could not finish about #7', item: 'OpenADLC#7' };
const STUCK: NeedsItem = { id: 'task:3', text: 'The reviewer could not finish', item: null };

function data(needsItems: NeedsItem[] | null, needsYou: number | null = needsItems?.length ?? null): Pick<HeaderData, 'needsYou' | 'needsItems'> {
  return { needsYou, needsItems };
}

async function show(read: Pick<HeaderData, 'needsYou' | 'needsItems'>, brand: string | null = null): Promise<void> {
  await act(async () =>
    root.render(
      <BrandProvider brand={{ name: brand, logoUrl: null }}>
        <NeedsYouAlerts data={read} />
      </BrandProvider>,
    ),
  );
}

const icons = () => [...document.head.querySelectorAll('link[rel="icon"][data-needs-you]')] as HTMLLinkElement[];

/** As the menu does: stored, and said to the page. */
function switchOn(...keys: (keyof typeof ALERT_KEYS)[]): void {
  act(() => {
    for (const key of keys) storeAlert(key, true);
  });
}

describe('the tab title and icon', () => {
  it('carry the count and a dot while anything waits, and go back to plain at nothing', async () => {
    await show(data([ASKED, FAILED]));
    expect(document.title).toBe('(2) OpenADLC');
    expect(icons()).toHaveLength(1);
    expect(icons()[0]!.href).toBe(faviconSvg());

    await show(data([ASKED, FAILED]), 'Acme');
    expect(document.title).toBe('(2) Acme');

    await show(data([], 0));
    expect(document.title).toBe('OpenADLC');
    expect(icons()).toHaveLength(0);
  });

  it('say nothing for a bridge that did not answer', async () => {
    await show(data(null, null));
    expect(document.title).toBe('OpenADLC');
    expect(icons()).toHaveLength(0);
  });

  it('stay plain with the switch off', async () => {
    localStorage.setItem(ALERT_KEYS.tab, 'off');
    await show(data([ASKED]));
    expect(document.title).toBe('OpenADLC');
    expect(icons()).toHaveLength(0);
  });
});

describe('a notification', () => {
  it('says nothing on the first read after load, and names the one that is new after', async () => {
    switchOn('notify');
    await show(data([ASKED]));
    expect(FakeNotification.raised).toEqual([]);

    await show(data([ASKED, FAILED]));
    expect(FakeNotification.raised.map((one) => [one.title, one.options.tag])).toEqual([
      ['The builder could not finish about #7', 'openadlc-needs-you:task:2'],
    ]);

    // The same read again, and an item that went and came back: nothing more.
    await show(data([ASKED, FAILED]));
    await show(data([ASKED]));
    await show(data([ASKED, FAILED]));
    expect(FakeNotification.raised).toHaveLength(1);
  });

  it('opens the item it is about when clicked', async () => {
    switchOn('notify');
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    await show(data([]));
    await show(data([ASKED]));
    const raised = FakeNotification.raised[0]!;
    raised.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith('/needs-you?item=OpenADLC%2342');
    expect(raised.closed).toBe(true);
  });

  it('is one for several at once, which opens the list', async () => {
    switchOn('notify');
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    await show(data([]));
    await show(data([ASKED, FAILED, STUCK]));
    expect(FakeNotification.raised.map((one) => [one.title, one.options.tag])).toEqual([['3 new items need you', 'openadlc-needs-you:batch']]);
    FakeNotification.raised[0]!.onclick!();
    expect(router.push).toHaveBeenCalledWith('/needs-you');
  });

  it('is not raised with the switch off, without permission, or for a bridge that did not answer', async () => {
    await show(data([]));
    await show(data([ASKED]));
    expect(FakeNotification.raised).toEqual([]);

    switchOn('notify');
    FakeNotification.permission = 'denied';
    await show(data([ASKED, FAILED]));
    expect(FakeNotification.raised).toEqual([]);

    FakeNotification.permission = 'granted';
    await show(data(null, null));
    expect(FakeNotification.raised).toEqual([]);
    // Nor did a read with nothing in it move the baseline: what follows is new against the last one.
    await show(data([ASKED, FAILED, STUCK]));
    expect(FakeNotification.raised.map((one) => one.title)).toEqual(['The reviewer could not finish']);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('follows the stored switches when the header is drawn again on another page', async () => {
    // The first page: its read is the baseline.
    localStorage.setItem(ALERT_KEYS.notify, 'on');
    localStorage.setItem(ALERT_KEYS.tab, 'off');
    await show(data([ASKED]));
    expect(FakeNotification.raised).toEqual([]);

    // A move to another page draws the shell again, and its read brings a new item.
    act(() => root.unmount());
    root = createRoot(container);
    const titles: string[] = [];
    let proto: object | null = document;
    while (proto && !Object.getOwnPropertyDescriptor(proto, 'title')) proto = Object.getPrototypeOf(proto);
    const { get, set } = Object.getOwnPropertyDescriptor(proto!, 'title')!;
    Object.defineProperty(document, 'title', {
      configurable: true,
      get: () => get!.call(document),
      set: (value: string) => {
        titles.push(value);
        set!.call(document, value);
      },
    });
    await show(data([ASKED, FAILED]));
    expect(FakeNotification.raised.map((one) => one.title)).toEqual(['The builder could not finish about #7']);
    // The count was off before the page was drawn, and never showed.
    expect(titles).toEqual(['OpenADLC']);
    expect(icons()).toHaveLength(0);
    delete (document as { title?: string }).title;
  });

  it('is left to the tab that claimed it first', async () => {
    switchOn('notify');
    localStorage.setItem('openadlc.alerts.claimed', JSON.stringify({ 'gate:1': Date.now() }));
    await show(data([]));
    await show(data([ASKED]));
    expect(FakeNotification.raised).toEqual([]);
  });
});

describe('the sound', () => {
  function audio() {
    const played = vi.fn();
    const Context = class {
      currentTime = 0;
      destination = {};
      resume = async () => undefined;
      close = async () => undefined;
      createOscillator() {
        return { type: '', frequency: { value: 0 }, connect: () => undefined, start: played, stop: () => undefined, onended: null };
      }
      createGain() {
        return { gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: () => undefined };
      }
    };
    vi.stubGlobal('AudioContext', Context);
    return played;
  }

  it('plays only for a new item, and only when switched on', async () => {
    const played = audio();
    await show(data([]));
    await show(data([ASKED]));
    expect(played).not.toHaveBeenCalled();

    switchOn('sound');
    await show(data([ASKED, FAILED]));
    expect(played).toHaveBeenCalledTimes(1);
    await show(data([ASKED, FAILED]));
    expect(played).toHaveBeenCalledTimes(1);
  });
});

describe('the alerts menu', () => {
  async function menu(): Promise<void> {
    await act(async () => root.render(<AlertsMenu />));
    await act(async () => (container.querySelector('button[aria-label="Alerts"]') as HTMLButtonElement).click());
  }
  const toggle = (key: string) => container.querySelector(`[data-alert="${key}"]`) as HTMLButtonElement;
  const on = (key: string) => toggle(key).getAttribute('aria-checked');

  it('has the count on and the sound and notifications off, and keeps a change in this browser', async () => {
    FakeNotification.permission = 'default';
    await menu();
    expect([on('tab'), on('sound'), on('notify')]).toEqual(['true', 'false', 'false']);

    await act(async () => toggle('tab').click());
    await act(async () => toggle('sound').click());
    expect([on('tab'), on('sound')]).toEqual(['false', 'true']);
    expect(localStorage.getItem(ALERT_KEYS.tab)).toBe('off');
    expect(localStorage.getItem(ALERT_KEYS.sound)).toBe('on');
    // Nothing asked the browser for notifications on the way.
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('asks the browser from the notification switch, and is on once allowed', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockImplementationOnce(async () => (FakeNotification.permission = 'granted'));
    await menu();
    await act(async () => toggle('notify').click());
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(on('notify')).toBe('true');
    expect(localStorage.getItem(ALERT_KEYS.notify)).toBe('on');
  });

  it('stays off, and says why, where the browser blocks or lacks notifications', async () => {
    FakeNotification.permission = 'denied';
    switchOn('notify');
    await menu();
    expect(on('notify')).toBe('false');
    expect(container.querySelector('[data-alert-reason]')?.textContent).toBe('Blocked in this browser’s site settings');
    await act(async () => toggle('notify').click());
    expect(on('notify')).toBe('false');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    vi.stubGlobal('Notification', undefined);
    await menu();
    expect(on('notify')).toBe('false');
    expect(container.querySelector('[data-alert-reason]')?.textContent).toBe('This browser does not offer desktop notifications');
  });

  it('is followed at once by the alerts on the page', async () => {
    await act(async () =>
      root.render(
        <>
          <AlertsMenu />
          <NeedsYouAlerts data={data([ASKED])} />
        </>,
      ),
    );
    expect(document.title).toBe('(1) OpenADLC');
    await act(async () => (container.querySelector('button[aria-label="Alerts"]') as HTMLButtonElement).click());
    await act(async () => toggle('tab').click());
    expect(document.title).toBe('OpenADLC');
    expect(icons()).toHaveLength(0);
  });
});
