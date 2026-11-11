import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { headerData } from '@/lib/header';

/**
 * `/settings/notifications` is push to the console app and the kinds'
 * switches, and nothing else: ntfy, Slack and the webhook are retired (ADR
 * 0049). The notifications health card links here.
 */

type Me = { known: true; email: string; role: 'admin' | 'user'; identityMode: 'local' | 'iap' };
const ADMIN: Me = { known: true, email: 'janedoe@example.com', role: 'admin', identityMode: 'iap' };
const USER: Me = { known: true, email: 'bob@example.com', role: 'user', identityMode: 'iap' };
const who = vi.hoisted(() => ({ me: null as unknown as Me }));
who.me = ADMIN;

vi.mock('@/app/actions', () => ({
  saveNotifications: vi.fn(),
  addPushDevice: vi.fn(),
  removePushDevice: vi.fn(),
  testPushDevice: vi.fn(),
  testAllPushDevices: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  readMe: async () => who.me,
  api: {
    repos: async () => ({ repos: [], maxReviewRounds: 3 }),
    crew: async () => ({ bots: [] }),
    costs: async () => null,
    egressHosts: async () => ({ hosts: [], proxied: false, settingsList: false, reason: null }),
    peopleRoles: async () => ({ people: [], roles: [] }),
    notifications: async () => ({
      switches: { gate_opened: true, merge_waiting: true, review_stalled: true, cap_warning: false, promote_waiting: true, check_failing: true },
    }),
    pushDevices: async () => ({ key: 'BKEY', devices: [{ id: 'd1', name: 'iPhone · Safari', addedAt: '2026-11-10T10:00:00Z', last: null }], allFailing: false, dropped: [] }),
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: [], crew: [], budget: null, needsYou: 0 } as never),
}));

async function render(me: Me): Promise<string> {
  who.me = me;
  try {
    const { default: NotificationSettingsPage } = await import('./page');
    return renderToStaticMarkup(await NotificationSettingsPage()).replace(/<!-- -->/g, '');
  } finally {
    who.me = ADMIN;
  }
}

const navOf = (html: string) => html.slice(html.indexOf('<nav aria-label="Settings"'), html.indexOf('</nav>', html.indexOf('<nav aria-label="Settings"')));

const RETIRED = [/ntfy/i, /slack/i, /webhook/i, /Your channel/, /name="notify-kind"/];

describe('the notifications page', () => {
  it('shows an admin their devices, then the switches and Save, beside Settings’ navigation with Notifications marked', async () => {
    const html = await render(ADMIN);
    const nav = navOf(html);
    expect(nav).toMatch(/<a (?=[^>]*href="\/settings\/notifications")(?=[^>]*aria-current="page")[^>]*>Notifications<\/a>/);
    expect(nav).toMatch(/<a [^>]*href="\/settings\/hosts"[^>]*>Hosts<\/a>/);
    expect(nav).toContain('>System<');
    expect(html).not.toContain('href="/settings#notifications"');
    expect(html).toContain('>Send a test notification<');
    expect(html).toContain('Notifications on your devices');
    expect(html).toContain('iPhone · Safari');
    expect(html).toContain('A bot asks you a question');
    expect(html).toContain('>Save<');
    expect(html.indexOf('Notifications on your devices')).toBeLessThan(html.indexOf('A bot asks you a question'));
  });

  it('shows a user their devices and not the install’s switches, with Notifications the only part of Settings', async () => {
    const html = await render(USER);
    const nav = navOf(html);
    expect([...nav.matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((match) => match[1])).toEqual(['Notifications']);
    expect(nav).not.toContain('Run the setup again');
    expect(html).toContain('>Send a test notification<');
    expect(html).toContain('Notifications on your devices');
    expect(html).toContain('iPhone · Safari');
    expect(html).not.toContain('A bot asks you a question');
  });

  it('names no retired channel, for an admin, a user or a local install', async () => {
    for (const me of [ADMIN, USER, { ...ADMIN, identityMode: 'local' } as Me]) {
      const html = await render(me);
      for (const word of RETIRED) expect(html, `${me.email} ${me.identityMode} ${word}`).not.toMatch(word);
    }
  });

  it('says a phone cannot reach a local install', async () => {
    expect(await render({ ...ADMIN, identityMode: 'local' })).toContain('A phone cannot reach this install at http://127.0.0.1');
    expect(await render(ADMIN)).not.toContain('A phone cannot reach this install at http://127.0.0.1');
  });
});
