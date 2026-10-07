import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { headerData } from '@/lib/header';

/**
 * One repository's settings on a page of its own: everything the settings
 * page used to show for each repository in turn, with a way back.
 */
const builder = {
  name: 'fleetadlc-atlas-janedoe',
  slot: 'builder',
  displayName: 'builder',
  role: 'implement',
  engine: 'claude',
  model: 'newest:opus',
  status: 'stopped',
  container: 'bot-builder',
  githubLogin: 'fleetadlc-atlas-janedoe',
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

vi.mock('@/lib/api', () => ({
  readMe: async () => who.me,
  api: {
    repos: async () => ({
      repos: [
        { name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed', concurrency: 1, owner: 'fleetadlc-atlas-janedoe', stageModes: { merged: 'assist' }, color: 'blue' },
        { name: 'website', fullName: 'janedoe/website', concurrency: 1, owner: 'fleetadlc-atlas-janedoe', stageModes: {}, color: 'amber' },
      ],
      maxReviewRounds: 3,
    }),
    crew: async () => ({ bots: [builder] }),
    costs: async () => null,
    workPauses: async () => ({ paused: null, repos: { 'fleetadlc-testbed': { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: null } } }),
    designMemory: async () => [
      { id: 'd-1', repoId: 'repo-1', kind: 'convention', title: 'Times are stored in UTC', body: 'And shown in the reader’s zone.', state: 'accepted', supersedes: null, sourceSubject: 'fleetadlc-testbed#4', sourceUrl: null, adrPath: null, proposedBy: null, decidedBy: 'janedoe', decidedAt: null, createdAt: '2026-09-29T10:00:00.000Z', updatedAt: '2026-09-29T10:00:00.000Z' },
    ],
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: ['fleetadlc-testbed'], crew: [], budget: { spentUsd: 0, capUsd: 1500 }, needsYou: 0 }),
}));
vi.mock('next/navigation', () => ({
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
    const html = await page('fleetadlc-testbed');
    expect(html).toContain('Design memory');
    expect(html).toContain('Times are stored in UTC');
  });

  it('holds that repository’s settings — who builds it, tasks at once, the stages, its colour, removing it — and only its', async () => {
    const html = await page('fleetadlc-testbed');
    const said = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(html).toMatch(/<h3[^>]*><span[^>]*bg-repo-blue[^>]*><\/span>fleetadlc-testbed<\/h3>/);
    expect(said).toContain('Who builds it');
    expect(said).toContain('fleetadlc-atlas-janedoe');
    expect(said).toContain('Tasks at once');
    expect(said).toContain('What each stage may do without asking');
    expect(html).toContain('aria-label="Color"');
    expect(html).toContain('>Remove from OpenADLC</button>');
    expect(said).not.toContain('website');
  });

  it('shows its own pause, with Resume', async () => {
    const said = (await page('fleetadlc-testbed')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(said).toContain('Paused by janedoe at 2026-09-29 10:00 UTC.');
    expect(said).toContain('Resume');
  });

  it('says a setting written in config/repos.yaml is put back at the next start', async () => {
    const said = (await page('fleetadlc-testbed')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(said).toContain('A setting written for this repository in config/repos.yaml is put back at the next start.');
  });

  it('links back to settings', async () => {
    expect(await page('fleetadlc-testbed')).toMatch(/<a [^>]*href="\/settings#repository"[^>]*>.*Settings<\/a>/);
  });

  it('is not found for a repository OpenADLC does not have', async () => {
    await expect(page('nowhere')).rejects.toThrow('NOT_FOUND');
  });

  it('is an admin’s: a user is told so, and shown none of its controls', async () => {
    who.me = { known: true, email: 'bob@example.com', role: 'user', identityMode: 'iap' };
    try {
      const html = await page('fleetadlc-testbed');
      expect(html).toContain('Repository settings need an admin');
      expect(html).toContain('bob@example.com');
      expect(html).not.toContain('Times are stored in UTC');
    } finally {
      who.me = ADMIN;
    }
  });
});
