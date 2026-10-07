// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateApp, createAppNote } from './create-app';

/**
 * What the app step says will happen when the button is pressed.
 *
 * Whether the app's webhook starts switched on is decided here and nowhere
 * else — afterwards only its settings page can switch it on — so the page
 * says which it will be, and why.
 */
describe('what creating the app says will happen', () => {
  it('says a tunnel is raised first, so that the webhook starts switched on', () => {
    const note = createAppNote('tunnel');
    expect(note).toContain('OpenADLC first raises a tunnel');
    expect(note).toContain('creates the app with its webhook switched on');
  });

  it('says plainly when it will start switched off, and what would change that', () => {
    const note = createAppNote('none');
    expect(note).toContain('with its webhook switched off');
    expect(note).toContain('the webhook step will show you how to switch it on');
    expect(note).toContain('brew install cloudflared');
    expect(note).toContain('on Linux, Cloudflare’s package');
  });

  it('says, whatever the address, that a name GitHub refuses can be changed on GitHub’s page', () => {
    for (const address of ['have', 'tunnel', 'none', undefined] as const) {
      expect(createAppNote(address), String(address)).toMatch(
        /If GitHub says the name is taken or too long, change it on GitHub’s page: OpenADLC keeps the app’s id and key, not its name\.$/,
      );
    }
  });

  it('says nothing of tunnels to an install that has an address', () => {
    expect(createAppNote('have')).toContain('the webhook points at this bridge');
    expect(createAppNote('have')).not.toContain('tunnel');
  });
});

describe('pressing create', () => {
  const looked = { postUrl: 'https://github.com/settings/apps/new', manifest: { name: 'OpenADLC' }, address: 'have' };
  const prepared = { postUrl: 'https://github.com/settings/apps/new?state=abc', manifest: { name: 'OpenADLC' }, address: 'have' };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The step rendered, with GitHub's form caught rather than submitted. */
  async function rendered(answers: (path: string, init?: RequestInit) => Response) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => answers(path, init));
    vi.stubGlobal('fetch', fetchMock);
    const posted: string[] = [];
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
      posted.push(this.action);
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<CreateApp organization={null} />));
    const press = async (text: string) => {
      const button = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes(text));
      await act(async () => button?.click());
    };
    return { fetchMock, posted, press, done: () => act(() => root.unmount()) };
  }

  it('gets a state from prepare before posting to GitHub, even with an address in hand', async () => {
    const { fetchMock, posted, press, done } = await rendered((path) =>
      new Response(JSON.stringify(path === '/api/app-manifest/prepare' ? prepared : looked), { status: 200 }),
    );

    await press('create the OpenADLC app on GitHub');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/app-manifest', '/api/app-manifest/prepare']);
    expect(posted).toEqual([prepared.postUrl]);
    done();
  });

  it('creates it without an address through prepare too, and never posts the manifest it only looked at', async () => {
    let prepares = 0;
    const { fetchMock, posted, press, done } = await rendered((path) => {
      if (path !== '/api/app-manifest/prepare') return new Response(JSON.stringify({ ...looked, address: 'tunnel' }), { status: 200 });
      prepares += 1;
      return prepares === 1 ? new Response('{"error":"cloudflared did not start"}', { status: 400 }) : new Response(JSON.stringify(prepared), { status: 200 });
    });

    await press('create the OpenADLC app on GitHub');
    await press('create it without an address');

    const last = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(last[0]).toBe('/api/app-manifest/prepare');
    expect(JSON.parse(String(last[1].body))).toEqual({ withoutAddress: true });
    expect(posted).toEqual([prepared.postUrl]);
    done();
  });
});
