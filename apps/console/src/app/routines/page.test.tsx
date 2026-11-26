import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RoutinesView, RoutineView } from '@/lib/api';
import { headerData } from '@/lib/header';

/** Routines (#369): each routine, when it runs next, what it last did, and the controls an approver gets. */

const bridge = vi.hoisted(() => ({ view: null as unknown }));

vi.mock('@/lib/api', () => ({
  api: { routines: async () => bridge.view },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: ['app'], crew: [], budget: { spentUsd: 0, capUsd: 1500 }, needsYou: 0 }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => '/routines',
}));

const ROUTINE: RoutineView = {
  id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc',
  repo: 'app',
  repoFullName: 'acme/app',
  text: 'Review this repository’s dependencies',
  details: null,
  kind: 'chore',
  cadence: { every: 'week', weekday: 1 },
  time: '09:00',
  timeZone: 'Europe/Berlin',
  paused: false,
  owner: { identity: 'ada@example.com', login: 'ada', githubId: 1 },
  nextRunAt: '2026-11-30T08:00:00.000Z',
  lastRunAt: '2026-11-23T08:00:10.000Z',
  lastRequestId: 'c71c09e2-3ae8-450b-abe9-0c93eb4d67dc',
  lastRequestState: 'filed',
  lastOutcome: 'skipped',
  lastSkipReason: 'Its last request request:c71c09e2 is still open',
};

const view = (patch: Partial<RoutinesView> = {}): RoutinesView => ({ routines: [ROUTINE], templates: [], mayEdit: true, ...patch });

async function page(): Promise<{ html: string; text: string }> {
  const { default: RoutinesPage } = await import('./page');
  const html = renderToStaticMarkup(await RoutinesPage()).replace(/<!-- -->/g, '');
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
}

describe('the routines page', () => {
  it('lists each routine with its repository, cadence, next run, last run linking to its request, and why it skipped', async () => {
    bridge.view = view();
    const { html, text } = await page();
    expect(text).toContain('acme/app');
    expect(text).toContain('Every Monday at 09:00 (Europe/Berlin)');
    expect(html).toMatch(/data-next-run[^>]*>Next run: <span>[^<—]+<\/span>/);
    expect(html).toContain('href="/?item=request%3Ac71c09e2"');
    expect(text).toContain('Its last request request:c71c09e2 is still open');
    expect(text).toContain('files as @ada');
  });

  it('gives an approver New routine, and Edit, Pause and Delete on each', async () => {
    bridge.view = view();
    const { html, text } = await page();
    expect(html).toContain('data-routine-new');
    expect(html).toContain('data-routine-actions');
    expect(text).toMatch(/Edit\s+Pause\s+Delete/);
  });

  it('shows a paused routine with no next run, and Resume', async () => {
    bridge.view = view({ routines: [{ ...ROUTINE, paused: true, nextRunAt: null }] });
    const { html, text } = await page();
    expect(html).toMatch(/Next run: <span>—<\/span>/);
    expect(text).toContain('paused');
    expect(text).toContain('Resume');
  });

  it('draws no create or edit controls for someone who may not change routines, and says why', async () => {
    bridge.view = view({ mayEdit: false, why: 'Only someone in People with Approves on can change routines: an admin turns it on in Settings → People.', url: '/settings#people' });
    const { html, text } = await page();
    expect(html).not.toContain('data-routine-new');
    expect(html).not.toContain('data-routine-actions');
    expect(html).not.toContain('data-routine-form');
    expect(text).toContain('Only someone in People with Approves on can change routines');
    // The list is still there to watch.
    expect(text).toContain('Every Monday at 09:00');
  });
});
