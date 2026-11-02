import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { headerData } from '@/lib/header';

/**
 * `/settings/notifications` is where a person says where they are notified,
 * and proves it with Send a test. The notifications health card links here.
 */

type Me = { known: true; email: string; role: 'admin' | 'user'; identityMode: 'local' | 'iap' };
const ADMIN: Me = { known: true, email: 'janedoe@example.com', role: 'admin', identityMode: 'iap' };
const who = vi.hoisted(() => ({ me: null as unknown as Me }));
who.me = ADMIN;

vi.mock('@/app/actions', () => ({ saveNotifications: vi.fn(), testNotifications: vi.fn() }));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  readMe: async () => who.me,
  api: {
    repos: async () => ({ repos: [], maxReviewRounds: 3 }),
    crew: async () => ({ bots: [] }),
    costs: async () => null,
    notifications: async () => ({
      source: 'settings',
      kind: 'slack',
      server: null,
      target: 'https://hooks.slack.com/…a1b2',
      switches: { gate_opened: true, merge_waiting: true, review_stalled: true, cap_warning: false, promote_waiting: true, check_failing: true },
      last: null,
    }),
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: [], crew: [], budget: null, needsYou: 0 } as never),
}));

describe('the notifications page', () => {
  it('shows where they go, masked, each switch, Save and Send a test, and links back to Settings', async () => {
    const { default: NotificationSettingsPage } = await import('./page');
    const html = renderToStaticMarkup(await NotificationSettingsPage()).replace(/<!-- -->/g, '');
    expect(html).toMatch(/<a [^>]*href="\/settings#notifications"[^>]*>/);
    expect(html).toContain('<input type="radio" name="notify-kind" checked="" value="slack"/>');
    expect(html).toContain('placeholder="https://hooks.slack.com/…a1b2 (saved; type to replace)"');
    // Never the whole target: the bridge does not send it, and the field starts empty.
    expect(html).toMatch(/<input aria-label="Incoming-webhook URL"[^>]*value=""\/>/);
    expect(html).toContain('A bot asks you a question');
    expect(html).toContain('A pull request waits for you to merge or approve it');
    expect(html).toContain('>Save<');
    expect(html).toContain('>Send a test<');
  });

  it('is an admin’s: a user is told so, and shown nothing to change', async () => {
    who.me = { known: true, email: 'bob@example.com', role: 'user', identityMode: 'iap' };
    try {
      const { default: NotificationSettingsPage } = await import('./page');
      const html = renderToStaticMarkup(await NotificationSettingsPage()).replace(/<!-- -->/g, '');
      expect(html).toContain('Notifications need an admin');
      expect(html).not.toContain('Send a test');
    } finally {
      who.me = ADMIN;
    }
  });
});
