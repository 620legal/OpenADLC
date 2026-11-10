// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.hoisted(() => ({
  turnOn: vi.fn(),
  currentSubscription: vi.fn(async () => null),
}));
vi.mock('@/app/actions', () => ({ addPushDevice: vi.fn(), removePushDevice: vi.fn(), testPushDevice: vi.fn() }));
vi.mock('@/lib/push', async (original) => ({
  ...(await original<typeof import('@/lib/push')>()),
  turnOn: pushMock.turnOn,
  currentSubscription: pushMock.currentSubscription,
}));

import { addPushDevice, removePushDevice, testPushDevice } from '@/app/actions';
import type { PushDevicesView } from '@/lib/api';
import { LOCAL_LINE, PushDevices, SUPPORT_WORDS } from './push-devices';

/**
 * Turning notifications on for the device a person is on, and seeing their
 * others by name and date only. Asking for the permission happens in the tap
 * and nowhere else: Safari and Firefox refuse it otherwise.
 */

const VIEW: PushDevicesView = {
  key: 'BKEY',
  devices: [
    { id: 'd1', name: 'iPhone · Safari', addedAt: '2026-11-01T10:00:00Z', last: null },
    { id: 'd2', name: 'Mac · Chrome', addedAt: '2026-11-02T10:00:00Z', last: { at: '2026-11-03T10:00:00Z', ok: true, status: 201, error: null } },
  ],
  allFailing: false,
  dropped: [],
};

function render(props: Partial<Parameters<typeof PushDevices>[0]> = {}): string {
  return renderToStaticMarkup(<PushDevices initial={VIEW} local={false} support="ok" {...props} />).replace(/<!-- -->/g, '');
}

async function mount(props: Partial<Parameters<typeof PushDevices>[0]> = {}): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () => createRoot(host).render(<PushDevices initial={VIEW} local={false} support="ok" {...props} />));
  return host;
}

function button(host: HTMLElement, label: string, nth = 0): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].filter((one) => one.textContent === label)[nth];
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('what the page says this browser can do', () => {
  it('offers the button only where push can work', () => {
    expect(render()).toContain('>Turn on notifications on this device<');
    for (const [support, words] of Object.entries(SUPPORT_WORDS)) {
      const html = render({ support: support as keyof typeof SUPPORT_WORDS });
      expect(html, support).toContain(words);
      expect(html, support).not.toContain('Turn on notifications on this device');
    }
  });

  it('tells an iPhone to add the console to its Home Screen first', () => {
    expect(render({ support: 'ios-add-to-home-screen' })).toContain('Add OpenADLC to your Home Screen first (Share → Add to Home Screen), then open it from there');
  });

  it('says on a local install that a phone cannot reach it', () => {
    expect(render({ local: true })).toContain(LOCAL_LINE);
    expect(render()).not.toContain(LOCAL_LINE);
  });

  it('asks for nothing until it is tapped', () => {
    render();
    expect(pushMock.turnOn).not.toHaveBeenCalled();
  });
});

describe('the list of devices', () => {
  it('shows each device by its name and when it was added', () => {
    const html = render();
    expect(html).toContain('iPhone · Safari');
    expect(html).toContain('Mac · Chrome');
    expect(html).toContain('Added ');
    expect(html).not.toContain('https://');
  });

  it('says when none of the devices took the last notification, and which were removed', () => {
    const html = render({
      initial: {
        ...VIEW,
        devices: [{ ...VIEW.devices[0]!, last: { at: '2026-11-04T10:00:00Z', ok: false, status: 500, error: 'Internal Server Error' } }],
        allFailing: true,
        dropped: [{ name: 'Old phone', at: '2026-11-05T10:00:00Z', status: 410 }],
      },
    });
    expect(html).toContain('None of your devices took the last notification: Internal Server Error');
    expect(html).toContain('Removed Old phone on ');
    expect(html).toContain('its browser stopped taking notifications. Turn notifications on there again.');
  });
});

describe('the buttons', () => {
  it('turns notifications on from the tap, saves the device and lists it as this one', async () => {
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BP', auth: 'AA' } };
    pushMock.turnOn.mockResolvedValue({ ok: true, subscription });
    vi.mocked(addPushDevice).mockResolvedValue({ ok: true, device: { id: 'd3', name: 'Linux · Chrome', addedAt: '2026-11-10T10:00:00Z' } });
    const host = await mount();
    await act(async () => button(host, 'Turn on notifications on this device').click());
    expect(pushMock.turnOn).toHaveBeenCalledWith('BKEY');
    expect(addPushDevice).toHaveBeenCalledWith(subscription, expect.any(String));
    expect(host.textContent).toContain('(this device)');
    expect(host.textContent).toContain('Notifications are on for this device');
    expect(window.localStorage.getItem('openadlc-push-device')).not.toContain('https://');
  });

  it('says what went wrong when the browser would not', async () => {
    pushMock.turnOn.mockResolvedValue({ ok: false, error: 'Notifications were not allowed' });
    const host = await mount();
    await act(async () => button(host, 'Turn on notifications on this device').click());
    expect(addPushDevice).not.toHaveBeenCalled();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Notifications were not allowed');
  });

  it('sends a test to one device and removes one', async () => {
    vi.mocked(testPushDevice).mockResolvedValue({ ok: true, result: { ok: true, status: 201, error: null } });
    vi.mocked(removePushDevice).mockResolvedValue({ ok: true });
    const host = await mount();
    await act(async () => button(host, 'Send a test', 1).click());
    expect(testPushDevice).toHaveBeenCalledWith('d2');
    await act(async () => button(host, 'Remove', 0).click());
    expect(removePushDevice).toHaveBeenCalledWith('d1');
    expect(host.textContent).not.toContain('iPhone · Safari');
  });
});
