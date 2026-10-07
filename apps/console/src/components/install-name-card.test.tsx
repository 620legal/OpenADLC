// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoleProvider } from '@/components/app-header';
import { IncidentSteps } from '@/components/incident-steps';
import type { UnsignedIncident } from '@/lib/api';
import {
  ABOUT_SIGNED_POSTS,
  COUNT_ONLY_SIGNED_CHANGES,
  RECORDING_ONLY,
  SIGNATURE_DOES_NOT,
  SIGNATURE_PROVES,
  SIGNED_POSTS_LINE,
  TRADEOFFS,
  UNSIGNED_IGNORED,
  WHEN_TO_TURN_ON,
  sharedReviewerConsequence,
  sharedReviewersFromAccounts,
  thisPostCounted,
} from '@/lib/signed-posts';
import { SignedPosts } from './install-name-card';

vi.mock('@/app/actions', () => ({
  holdPull: vi.fn(async () => ({ ok: true, autoMergeOff: true })),
  countOnlySignedPosts: vi.fn(async () => ({ ok: true })),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }) }));

/**
 * Settings → GitHub → Signed posts: one line on why signing matters, and an
 * (i) that opens what a signature proves, what counting only signed posts
 * changes, and the trade-offs. The unsigned-post steps say the same thing.
 */

const THREE = { login: 'irisexampleco', count: 3 };

const INCIDENT: UnsignedIncident = {
  repo: 'exampleco/api',
  login: 'janedoe-reviews',
  seat: 'lead-reviewer',
  did: 'review',
  postUrl: null,
  target: { kind: 'pr', number: 31, url: 'https://github.com/exampleco/api/pull/31' },
  counted: true,
  mode: 'audit',
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function about(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`[aria-label="${ABOUT_SIGNED_POSTS}"]`);
  if (!found) throw new Error('no About signed posts button');
  return found;
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error('no dialog');
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function escape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('signed posts, under Settings → GitHub', () => {
  it('says in one line why signing matters, with an (i) that is not open yet', async () => {
    await render(<SignedPosts mode="audit" save={async () => undefined} shared={null} />);
    expect(container.textContent).toContain('Signed posts');
    expect(container.textContent).toContain(SIGNED_POSTS_LINE);
    expect(SIGNED_POSTS_LINE).toContain('can’t be forged by anyone signed in as a crew account');
    expect(about().textContent?.trim()).toBe('i');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens the explanation, and Escape closes it', async () => {
    await render(<SignedPosts mode="audit" save={async () => undefined} shared={null} />);
    await click(about());
    const open = dialog();
    expect(open.textContent).toContain(SIGNED_POSTS_LINE);
    expect(open.textContent).toContain('What a signature proves');
    for (const line of SIGNATURE_PROVES) expect(open.textContent).toContain(line);
    // Not every signature names an issue or pull request: a new one has no number yet.
    for (const line of SIGNATURE_PROVES) expect(line).not.toContain('repository and issue or pull request');
    expect(open.textContent).toContain(SIGNATURE_DOES_NOT);
    expect(open.textContent).toContain('What “Count only signed posts” changes');
    expect(open.textContent).toContain(UNSIGNED_IGNORED);
    expect(open.textContent).toContain('It is shown on the board.');
    expect(open.textContent).toContain(RECORDING_ONLY);
    expect(open.textContent).toContain('Trade-offs');
    for (const line of TRADEOFFS) expect(open.textContent).toContain(line);
    expect(open.textContent).toContain(WHEN_TO_TURN_ON);

    await escape();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('names the shared-reviewer consequence when three reviewer seats share an account', async () => {
    await render(<SignedPosts mode="audit" save={async () => undefined} shared={THREE} />);
    await click(about());
    const said = dialog().textContent ?? '';
    expect(said).toContain('The three reviewers sign in as irisexampleco.');
    expect(said).toContain('the lead’s review from that account counts only when OpenADLC signed it.');
    expect(said).toContain('the lead’s review and a blocking reviewer’s count only when signed, whether or not this is on.');
    expect(said).not.toContain('Without enforcement the merge refuses two required reviewers on one account.');
    expect(said).not.toContain('do not share an account');
  });

  it('says shared reviewers do not apply when each reviewer has their own account', async () => {
    await render(<SignedPosts mode="enforce" save={async () => undefined} shared={null} />);
    await click(about());
    expect(dialog().textContent).toContain('This install’s reviewers do not share an account, so that does not apply today.');
  });

  it('reads this install’s accounts when the page did not pass them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            accounts: [
              { login: 'fleetadlc-builder', seats: [{ role: 'implement' }, { role: 'qa' }] },
              {
                login: 'irisexampleco',
                seats: [{ role: 'review_lead' }, { role: 'review_second' }, { role: 'review_security' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await render(<SignedPosts mode="audit" save={async () => undefined} />);
    await click(about());
    expect(dialog().textContent).toContain(sharedReviewerConsequence(THREE));
  });

  it('does not claim reviewers are separate when the accounts could not be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })));
    await render(<SignedPosts mode="audit" save={async () => undefined} />);
    await click(about());
    const said = dialog().textContent ?? '';
    expect(said).toContain('Whether that applies to this install could not be read.');
    expect(said).not.toContain('do not share an account');
  });
});

describe('the signed posts switch', () => {
  it('says the mode, and labels the button by what it does', async () => {
    await render(<SignedPosts mode="audit" save={async () => undefined} shared={null} />);
    expect(container.textContent).toContain('Recording only: unsigned posts still count.');
    expect([...container.querySelectorAll('button')].map((one) => one.textContent)).toContain('Count only signed posts');

    await render(<SignedPosts mode="enforce" save={async () => undefined} shared={null} />);
    expect(container.textContent).toContain('Counting only signed posts.');
    expect(container.textContent).not.toContain('Only record unsigned posts');
  });

  it('asks before turning enforcement off, since unsigned posts count again', async () => {
    const saved: [string, string][] = [];
    await render(<SignedPosts mode="enforce" save={async (key, value) => void saved.push([key, value])} shared={null} />);
    const button = (text: string) => [...container.querySelectorAll('button')].find((one) => one.textContent === text)!;
    await click(button('Count unsigned posts too'));
    expect(saved).toEqual([]);
    await click(button('Yes, count unsigned posts too'));
    expect(saved).toEqual([['attributionMode', 'audit']]);
  });
});

describe('what counting only signed posts changes, in one place', () => {
  it('is the same words on an unsigned post’s steps as in the explanation', async () => {
    await render(<IncidentSteps incident={INCIDENT} thisWasMe={<button type="button">This was me</button>} />);
    const steps = container.querySelector('[aria-label="What to do"]');
    expect(steps?.textContent).toContain(COUNT_ONLY_SIGNED_CHANGES);
    expect(steps?.textContent).toContain(thisPostCounted(true));
    expect(COUNT_ONLY_SIGNED_CHANGES).toContain(UNSIGNED_IGNORED);

    await render(
      <IncidentSteps incident={{ ...INCIDENT, counted: false, mode: 'enforce' }} thisWasMe={<span />} />,
    );
    expect(container.textContent).toContain(thisPostCounted(false));
    expect(container.textContent).toContain('It did not count');
  });

  it('tells a user to ask an admin, rather than offering what the bridge refuses them', async () => {
    await render(
      <RoleProvider role="user">
        <IncidentSteps incident={INCIDENT} thisWasMe={<span />} />
      </RoleProvider>,
    );
    const said = container.textContent ?? '';
    const buttons = [...container.querySelectorAll('button')].map((one) => one.textContent);
    expect(buttons).not.toContain('Hold this PR');
    expect(buttons).not.toContain('Count only signed posts');
    expect(container.querySelector('a[href^="/settings"]')).toBeNull();
    expect(said).toContain('Ask an admin to hold #31');
    expect(said).toContain('An admin changes this in Settings');

    await render(<IncidentSteps incident={INCIDENT} thisWasMe={<span />} />);
    expect([...container.querySelectorAll('button')].map((one) => one.textContent)).toContain('Hold this PR');
  });

  it('counts only reviewer seats, and only when two of them share a login', () => {
    expect(
      sharedReviewersFromAccounts([
        { login: 'fleetadlc-builder', seats: [{ role: 'implement' }, { role: 'qa' }] },
        { login: 'reviewer-one', seats: [{ role: 'review_lead' }] },
        { login: 'irisexampleco', seats: [{ role: 'review_second' }, { role: 'review_security' }] },
      ]),
    ).toEqual({ login: 'irisexampleco', count: 2 });
    expect(sharedReviewersFromAccounts([{ login: 'a', seats: [{ role: 'review_lead' }] }])).toBeNull();
    expect(sharedReviewerConsequence({ login: 'irisexampleco', count: 2 })).toContain('Two reviewers sign in as irisexampleco.');
  });

  it('counts only the seats the merge needs an approval from, when the bridge says which', () => {
    // The lead and the second reviewer on one account, the second advisory as
    // config/review.yaml leaves it: the merge asks the lead alone, and works.
    const advisory = [
      { login: 'irisexampleco', seats: [{ role: 'review_lead', approves: true }, { role: 'review_second', approves: false }] },
    ];
    expect(sharedReviewersFromAccounts(advisory)).toBeNull();
    const blocking = [
      { login: 'irisexampleco', seats: [{ role: 'review_lead', approves: true }, { role: 'review_security', approves: true }] },
    ];
    const shared = sharedReviewersFromAccounts(blocking);
    expect(shared).toEqual({ login: 'irisexampleco', count: 2, required: true });
    expect(sharedReviewerConsequence(shared)).toContain('Two reviewers whose approval the merge needs sign in as irisexampleco.');
  });

  it('says it matters only for the lead and blocking seats when the bridge does not say which approve', () => {
    expect(sharedReviewerConsequence({ login: 'irisexampleco', count: 2 })).toContain(
      'That matters only for the lead and seats marked blocking',
    );
  });
});

describe('the install name, when the settings could not be read', () => {
  it('says why, offers to try again, and shows the controls once a read works', async () => {
    const { InstallNamePart } = await import('./install-name-card');
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        reads += 1;
        if (reads === 1) throw new TypeError('Failed to fetch');
        return Response.json({
          organization: 'exampleco',
          installName: 'OpenADLC_exampleco',
          githubClientId: '',
          automationBot: '',
          humans: '',
          publicUrl: '',
          operatorEmail: '',
          webhookSecretConfigured: false,
          appPrivateKeyConfigured: false,
          storedKeys: [],
          webhookUrl: '',
        });
      }),
    );
    await act(async () => root.render(<InstallNamePart />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    // "Reading the install’s settings…" for good, with the failure hidden.
    const said = container.querySelector('[role="alert"]');
    expect(said?.textContent).toContain('Could not read the install’s settings: the bridge is not answering');
    expect(said?.textContent).not.toContain('Failed to fetch');

    const again = [...said!.querySelectorAll('button')].find((one) => one.textContent === 'try again')!;
    await act(async () => again.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(reads).toBe(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('OpenADLC_exampleco');
  });
});
