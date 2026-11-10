import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The console's service worker, run as a browser would run it, against a
 * stand-in `self`. It is there for push alone (ADR 0048): it caches nothing,
 * so a signed-out person sees nothing from it, and it stays quiet on a tab
 * that already shows the same thing.
 */

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const SOURCE = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
const ORIGIN = 'https://openadlc.example.com';
const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

interface FakeClient {
  url: string;
  focused: boolean;
  visibilityState: 'visible' | 'hidden';
  posted: unknown[];
  navigated: string[];
  postMessage(message: unknown): void;
  focus(): Promise<FakeClient>;
  navigate(url: string): Promise<FakeClient>;
}

function client(url: string, focused: boolean, visible = focused): FakeClient {
  const one: FakeClient = {
    url,
    focused,
    visibilityState: visible ? 'visible' : 'hidden',
    posted: [],
    navigated: [],
    postMessage: (message) => one.posted.push(message),
    focus: async () => one,
    navigate: async (to) => {
      one.navigated.push(to);
      return one;
    },
  };
  return one;
}

function worker(options: { clients?: FakeClient[]; agent?: string } = {}) {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const shown: { title: string; options: { tag: string; body: string; data: { link: string } }; closed: boolean }[] = [];
  const opened: string[] = [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    navigator: { userAgent: options.agent ?? CHROME },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      (listeners[type] ??= []).push(listener);
    },
    skipWaiting: () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () => options.clients ?? [],
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
    registration: {
      showNotification: async (title: string, opts: (typeof shown)[number]['options']) => {
        shown.push({ title, options: opts, closed: false });
      },
      getNotifications: async ({ tag }: { tag: string }) =>
        shown
          .filter((one) => one.options.tag === tag && !one.closed)
          .map((one) => ({
            close: () => {
              one.closed = true;
            },
          })),
    },
  };
  runInNewContext(SOURCE, { self, URL, console });
  const fire = async (type: string, event: Record<string, unknown>) => {
    let waited: Promise<unknown> = Promise.resolve();
    for (const listener of listeners[type] ?? []) {
      listener({
        ...event,
        waitUntil: (promise: Promise<unknown>) => {
          waited = promise;
        },
      });
    }
    await waited;
  };
  const push = (payload: unknown) => fire('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } });
  const click = (link: string) => fire('notificationclick', { notification: { data: { link }, close: () => undefined } });
  return { listeners, shown, opened, push, click };
}

const ITEM = { v: 1, title: 'OpenADLC', body: 'The builder asks about #7', link: `${ORIGIN}/?item=acme%2Fweb%237`, tag: 'openadlc-needs-you:task:2' };

describe('the service worker caches nothing', () => {
  it('has no fetch handler, and never opens Cache Storage', () => {
    expect(Object.keys(worker().listeners).sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
    expect(SOURCE).not.toMatch(/\bcaches\b/);
    expect(SOURCE).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
  });
});

describe('a push', () => {
  it('shows one notification, tagged as the open page’s own alert for that item, when no tab is focused', async () => {
    const sw = worker({ clients: [client(`${ORIGIN}/`, false)] });
    await sw.push(ITEM);
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]).toMatchObject({ title: 'OpenADLC', options: { tag: 'openadlc-needs-you:task:2', body: ITEM.body, data: { link: ITEM.link } } });
  });

  it('shows nothing on a focused, visible tab, and tells the tab', async () => {
    const tab = client(`${ORIGIN}/needs-you`, true);
    const sw = worker({ clients: [tab] });
    await sw.push(ITEM);
    expect(sw.shown).toEqual([]);
    expect(tab.posted).toEqual([{ type: 'openadlc-push', tag: ITEM.tag }]);
  });

  it('on WebKit, which revokes a subscription that shows nothing, shows it and closes it at once', async () => {
    const tab = client(`${ORIGIN}/`, true);
    const sw = worker({ clients: [tab], agent: SAFARI });
    await sw.push(ITEM);
    expect(sw.shown.map((one) => one.closed)).toEqual([true]);
  });

  it('is shown on a tab that is focused but hidden', async () => {
    const sw = worker({ clients: [client(`${ORIGIN}/`, true, false)] });
    await sw.push(ITEM);
    expect(sw.shown).toHaveLength(1);
  });
});

describe('a tap on a notification', () => {
  it('brings an open console forward on the item', async () => {
    const tab = client(`${ORIGIN}/board`, false);
    const sw = worker({ clients: [tab] });
    await sw.click(ITEM.link);
    expect(tab.navigated).toEqual([ITEM.link]);
    expect(sw.opened).toEqual([]);
  });

  it('opens the console when none is open', async () => {
    const sw = worker();
    await sw.click(ITEM.link);
    expect(sw.opened).toEqual([ITEM.link]);
  });

  it('opens Needs you, on the console, for a link anywhere else', async () => {
    const sw = worker();
    await sw.click('https://attacker.example/phish');
    expect(sw.opened).toEqual([`${ORIGIN}/needs-you`]);
  });
});

describe('the web app manifest', () => {
  const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
    display: string;
    start_url: string;
    name: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };

  it('installs standalone, from the start, with a 192 and a 512 icon and a maskable one', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.name).toBe('OpenADLC');
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });

  it('names icons that are there, as PNGs of the size they say', () => {
    for (const icon of manifest.icons) {
      const png = readFileSync(join(PUBLIC, icon.src));
      expect(png.subarray(1, 4).toString('latin1'), icon.src).toBe('PNG');
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.src).toBe(icon.sizes);
    }
  });
});
