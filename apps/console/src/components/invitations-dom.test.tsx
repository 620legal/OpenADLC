// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Invitations, readResults } from './invitations';

/**
 * Accepting invitations by hand, on an install without the app's private
 * key: what `gh api` printed is pasted, and the answer says who got in, who
 * was refused and why, and what was not the crew's to accept.
 */

type Bot = Parameters<typeof Invitations>[0]['bots'][number];

const bot = (name: string, login: string): Bot => ({
  bot: name,
  displayName: name,
  login,
  connected: true,
  inRepository: false,
  repositoryRole: 'write',
  accessReason: 'reviews count only with write access',
  accountExists: true,
});

const BOTS = [bot('builder', 'fleetadlc-atlas-janedoe'), bot('lead-reviewer', 'fleetadlc-vega-janedoe')];

let posted: unknown[];
let answer: () => Response;
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  posted = [];
  answer = () => Response.json({ results: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) {
        return Response.json({
          repository: 'janedoe/api',
          pending: [{ id: 2, invitee: 'fleetadlc-vega-janedoe' }],
          reason: null,
          repositories: [
            { repository: 'janedoe/api', pending: [], reason: null },
            { repository: 'janedoe/site', pending: [], reason: null },
          ],
        });
      }
      posted.push({ url, body: JSON.parse(String(init.body)) });
      return answer();
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function draw(): Promise<void> {
  await act(async () => root.render(<Invitations bots={BOTS} repositories={['janedoe/api', 'janedoe/site']} isOrganization={false} inviteUrl={null} canInvite={false} />));
  await settle();
}

async function paste(text: string): Promise<void> {
  const area = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const accept = [...container.querySelectorAll('button')].find((one) => one.textContent === 'accept what is in there')!;
  await act(async () => accept.click());
  await settle();
}

describe('accepting invitations pasted by hand', () => {
  it('says who got in, who was refused and why, and what was not the crew’s', async () => {
    answer = () =>
      Response.json({
        results: [
          { bot: 'builder', invitee: 'fleetadlc-atlas-janedoe', id: 1, outcome: { action: 'accepted' } },
          { bot: 'lead-reviewer', invitee: 'fleetadlc-vega-janedoe', id: 2, outcome: { action: 'refused', detail: 'this invitation has expired; send a new one' } },
          { bot: null, invitee: 'somebody-else', id: 3, outcome: { action: 'none', detail: "somebody-else is not one of this install's bots" } },
        ],
      });
    await draw();
    await paste('[]');
    // Read as access, the answer had no state: "Nothing changed this time".
    expect(container.textContent).toContain('1 bot is now in the repositories.');
    expect(container.textContent).not.toContain('Nothing changed this time.');
    expect(container.textContent).toContain('this invitation has expired; send a new one');
    expect(container.textContent).toContain("somebody-else: somebody-else is not one of this install's bots");
  });

  it('says the bridge’s refusal in its own words, not its JSON', async () => {
    answer = () => Response.json({ error: 'nothing to accept' }, { status: 400 });
    await draw();
    await paste('gh api repos/janedoe/api/invitations --paginate');
    expect(container.textContent).toContain('nothing to accept');
    expect(container.textContent).not.toContain('{"error"');
  });

  it('points an invited, connected bot at the paste, since there is no button to press', async () => {
    await draw();
    expect(container.textContent).toContain('invited, and connected. Paste what gh prints below to let it in.');
    expect(container.textContent).not.toContain('Press the button');
  });
});

describe('a run whose invitation a connected bot could not accept', () => {
  it('says why, and does not call the bot not connected or offer to connect it', async () => {
    answer = () =>
      Response.json({
        results: [{ bot: 'builder', login: 'fleetadlc-atlas-janedoe', state: 'invited', changed: false, detail: 'GitHub refused the acceptance: 403' }],
      });
    await act(async () =>
      root.render(
        <Invitations bots={BOTS} repositories={['janedoe/api']} isOrganization={false} inviteUrl={null} canInvite onGoToCrew={() => undefined} />,
      ),
    );
    await settle();
    const invite = [...container.querySelectorAll('button')].find((one) => one.textContent === 'invite them and let them in')!;
    await act(async () => invite.click());
    await settle();
    expect(container.textContent).toContain('fleetadlc-atlas-janedoe: GitHub refused the acceptance: 403');
    expect(container.textContent).not.toContain('invited but not connected');
    expect([...container.querySelectorAll('button')].some((one) => one.textContent?.startsWith('connect '))).toBe(false);
  });
});

describe('the two routes’ answers', () => {
  it('are read as each bot’s access, keyed by the invitee where there is no bot', () => {
    expect(
      readResults([
        { bot: 'builder', login: 'atlas', state: 'in', changed: false, detail: '' },
        { bot: null, invitee: 'atlas-2', id: 4, outcome: { action: 'refused', detail: 'not connected' } },
      ]),
    ).toEqual({
      access: [
        { bot: 'builder', login: 'atlas', state: 'in', changed: false, detail: '' },
        { bot: 'atlas-2', login: 'atlas-2', state: 'refused', changed: false, detail: 'not connected' },
      ],
      skipped: [],
    });
  });
});
