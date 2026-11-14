import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { headerData } from '@/lib/header';

/**
 * One repository's settings on a page of its own: everything the settings
 * page used to show for each repository in turn, with a way back.
 */
const builder = {
  name: 'openadlc-atlas-janedoe',
  slot: 'builder',
  displayName: 'builder',
  role: 'implement',
  engine: 'claude',
  model: 'newest:opus',
  status: 'stopped',
  container: 'bot-builder',
  githubLogin: 'openadlc-atlas-janedoe',
  authorization: 'active',
  tokenExpiresAt: null,
  now: 'nothing running',
  paused: false,
  sessions: [],
};

type Me = { known: true; email: string; role: 'admin' | 'user'; identityMode: 'local' | 'iap' };
const ADMIN: Me = { known: true, email: 'janedoe@example.com', role: 'admin', identityMode: 'iap' };
const who = vi.hoisted(() => ({ me: null as unknown as Me }));
who.me = ADMIN;

/** What the host check form sent the bridge, what the bridge answers, and where the page went after. */
const saved = vi.hoisted(() => ({
  calls: [] as { repo: string; hostCheck: unknown }[],
  answer: { ok: true } as { ok: boolean; error?: string },
  redirects: [] as string[],
}));

vi.mock('@/lib/api', () => ({
  readMe: async () => who.me,
  saveHostCheck: async (repo: string, hostCheck: unknown) => {
    saved.calls.push({ repo, hostCheck });
    return saved.answer;
  },
  api: {
    repos: async () => ({
      repos: [
        { name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed', concurrency: 1, owner: 'openadlc-atlas-janedoe', stageModes: { merged: 'assist' }, color: 'blue' },
        {
          name: 'website',
          fullName: 'janedoe/website',
          concurrency: 1,
          owner: 'openadlc-atlas-janedoe',
          stageModes: {},
          color: 'amber',
          hostCheck: { command: 'make host-ci', timeoutMinutes: 90, required: false },
        },
      ],
      maxReviewRounds: 3,
    }),
    crew: async () => ({ bots: [builder] }),
    costs: async () => null,
    workPauses: async () => ({ paused: null, repos: { 'openadlc-testbed': { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: null } } }),
    designMemory: async () => [
      { id: 'd-1', repoId: 'repo-1', kind: 'convention', title: 'Times are stored in UTC', body: 'And shown in the reader’s zone.', state: 'accepted', supersedes: null, sourceSubject: 'openadlc-testbed#4', sourceUrl: null, adrPath: null, proposedBy: null, decidedBy: 'janedoe', decidedAt: null, createdAt: '2026-09-29T10:00:00.000Z', updatedAt: '2026-09-29T10:00:00.000Z' },
    ],
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: ['openadlc-testbed'], crew: [], budget: { spentUsd: 0, capUsd: 1500 }, needsYou: 0 }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    saved.redirects.push(to);
  },
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

async function page(name: string): Promise<string> {
  const { default: RepositorySettingsPage } = await import('./page');
  return renderToStaticMarkup(await RepositorySettingsPage({ params: Promise.resolve({ name }) })).replace(/<!-- -->/g, '');
}

describe('a repository’s settings page', () => {
  it('holds its design memory, which a person corrects there', async () => {
    const html = await page('openadlc-testbed');
    expect(html).toContain('Design memory');
    expect(html).toContain('Times are stored in UTC');
  });

  it('holds that repository’s settings — who builds it, tasks at once, the stages, its colour, removing it — and only its', async () => {
    const html = await page('openadlc-testbed');
    const said = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(html).toMatch(/<h3[^>]*><span[^>]*bg-repo-blue[^>]*><\/span>openadlc-testbed<\/h3>/);
    expect(said).toContain('Who builds it');
    expect(said).toContain('openadlc-atlas-janedoe');
    expect(said).toContain('Tasks at once');
    expect(said).toContain('What each stage may do without asking');
    expect(html).toContain('aria-label="Color"');
    expect(html).toContain('>Remove from OpenADLC</button>');
    expect(said).not.toContain('website');
  });

  it('shows its own pause, with Resume', async () => {
    const said = (await page('openadlc-testbed')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(said).toContain('Paused by janedoe at 2026-09-29 10:00 UTC.');
    expect(said).toContain('Resume');
  });

  it('says a setting written in config/repos.yaml is put back at the next start', async () => {
    const said = (await page('openadlc-testbed')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(said).toContain('A setting written for this repository in config/repos.yaml is put back at the next start.');
  });

  it('links back to settings', async () => {
    expect(await page('openadlc-testbed')).toMatch(/<a [^>]*href="\/settings#repository"[^>]*>.*Settings<\/a>/);
  });

  it('is not found for a repository OpenADLC does not have', async () => {
    await expect(page('nowhere')).rejects.toThrow('NOT_FOUND');
  });

  describe('its host check (#327)', () => {
    /** The page's host check form's action, as the section draws it. */
    async function hostCheckAction(name: string): Promise<(form: FormData) => Promise<void>> {
      const { default: RepositorySettingsPage } = await import('./page');
      const tree = await RepositorySettingsPage({ params: Promise.resolve({ name }) });
      const find = (node: unknown): ((form: FormData) => Promise<void>) | null => {
        if (!node || typeof node !== 'object') return null;
        if (Array.isArray(node)) {
          for (const child of node) {
            const found = find(child);
            if (found) return found;
          }
          return null;
        }
        const element = node as { type?: unknown; props?: { action?: unknown; children?: unknown } };
        if (element.type === 'form' && typeof element.props?.action === 'function') return element.props.action as (form: FormData) => Promise<void>;
        if (typeof element.type === 'function' && (element.type as { name?: string }).name === 'HostCheckSection') {
          return find((element.type as (props: unknown) => unknown)(element.props));
        }
        return find(element.props?.children);
      };
      const action = find(tree);
      if (!action) throw new Error('no host check form');
      return action;
    }

    const form = (fields: Record<string, string>) => {
      const data = new FormData();
      for (const [key, value] of Object.entries(fields)) data.set(key, value);
      return data;
    };

    it('says what it is, with a command, a time limit and Required for merge on by default', async () => {
      const html = await page('openadlc-testbed');
      const said = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      expect(said).toContain('Host check');
      expect(said).toContain('as an account of its own, once the crew approves a head');
      expect(said).toContain('docs/self-hosting.md#host-checks');
      expect(html).toMatch(/<input[^>]*name="command"[^>]*value=""/);
      expect(html).toMatch(/<input[^>]*name="timeoutMinutes"[^>]*value="60"/);
      expect(html).toMatch(/<input[^>]*name="required"[^>]*checked=""/);
      expect(html).not.toContain('>Clear</button>');
    });

    it('shows the one set, and offers Clear', async () => {
      const html = await page('website');
      expect(html).toMatch(/<input[^>]*name="command"[^>]*value="make host-ci"/);
      expect(html).toMatch(/<input[^>]*name="timeoutMinutes"[^>]*value="90"/);
      expect(html).not.toMatch(/<input[^>]*name="required"[^>]*checked=""/);
      expect(html).toContain('>Clear</button>');
    });

    it('saves what was typed, and an empty command or Clear takes it away', async () => {
      saved.calls.length = 0;
      saved.redirects.length = 0;
      saved.answer = { ok: true };
      const save = await hostCheckAction('openadlc-testbed');
      await save(form({ command: ' make host-ci ', timeoutMinutes: '120', required: 'on', intent: 'save' }));
      await save(form({ command: '', timeoutMinutes: '60', intent: 'save' }));
      await save(form({ command: 'make host-ci', timeoutMinutes: '60', intent: 'clear' }));
      await save(form({ command: 'make host-ci', timeoutMinutes: '30', intent: 'save' }));
      expect(saved.calls).toEqual([
        { repo: 'openadlc-testbed', hostCheck: { command: 'make host-ci', timeoutMinutes: 120, required: true } },
        { repo: 'openadlc-testbed', hostCheck: null },
        { repo: 'openadlc-testbed', hostCheck: null },
        { repo: 'openadlc-testbed', hostCheck: { command: 'make host-ci', timeoutMinutes: 30, required: false } },
      ]);
      expect(saved.redirects[0]).toBe('/settings/repositories/openadlc-testbed#host-check');
    });

    it('says the bridge’s refusal beside the form', async () => {
      saved.redirects.length = 0;
      saved.answer = { ok: false, error: 'timeoutMinutes is 1 to 1440' };
      const save = await hostCheckAction('openadlc-testbed');
      await save(form({ command: 'make host-ci', timeoutMinutes: '5000', intent: 'save' }));
      expect(saved.redirects[0]).toBe('/settings/repositories/openadlc-testbed?hostCheckError=timeoutMinutes%20is%201%20to%201440#host-check');
      saved.answer = { ok: true };

      const { default: RepositorySettingsPage } = await import('./page');
      const html = renderToStaticMarkup(
        await RepositorySettingsPage({ params: Promise.resolve({ name: 'openadlc-testbed' }), searchParams: Promise.resolve({ hostCheckError: 'timeoutMinutes is 1 to 1440' }) }),
      );
      expect(html).toContain('timeoutMinutes is 1 to 1440');
    });
  });

  it('is an admin’s: a user is told so, and shown none of its controls', async () => {
    who.me = { known: true, email: 'bob@example.com', role: 'user', identityMode: 'iap' };
    try {
      const html = await page('openadlc-testbed');
      expect(html).toContain('Repository settings need an admin');
      expect(html).toContain('bob@example.com');
      expect(html).not.toContain('Times are stored in UTC');
    } finally {
      who.me = ADMIN;
    }
  });
});
