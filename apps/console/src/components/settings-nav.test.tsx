import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsNav } from './settings-nav';

/**
 * Settings' navigation, the same on `/settings` and on Hosts' and
 * Notifications' pages, and Notifications alone for someone who is not an
 * admin (ADR 0053).
 */

const links = (html: string) => [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].map((match) => ({ attrs: match[1]!, label: match[2]! }));
const href = (attrs: string) => /href="([^"]*)"/.exec(attrs)?.[1];

describe('Settings’ navigation', () => {
  it('lists Hosts and Notifications as pages beside the sections, on /settings', () => {
    const html = renderToStaticMarkup(<SettingsNav />);
    const all = links(html);
    expect(href(all.find((link) => link.label === 'Hosts')!.attrs)).toBe('/settings/hosts');
    expect(href(all.find((link) => link.label === 'Notifications')!.attrs)).toBe('/settings/notifications');
    expect(href(all.find((link) => link.label === 'System')!.attrs)).toBe('#system');
    expect(html).not.toContain('aria-current="page"');
    expect(html).toContain('Run the setup again');
  });

  it('marks the page open, and links each section to /settings, on a page of its own', () => {
    for (const [on, label] of [
      ['hosts', 'Hosts'],
      ['notifications', 'Notifications'],
    ] as const) {
      const all = links(renderToStaticMarkup(<SettingsNav on={on} />));
      expect(all.filter((link) => link.attrs.includes('aria-current="page"')).map((link) => link.label), on).toEqual([label]);
      expect(href(all.find((link) => link.label === 'System')!.attrs), on).toBe('/settings#system');
    }
  });

  it('is one link, Notifications, and no Run the setup again, for someone who is not an admin', () => {
    const html = renderToStaticMarkup(<SettingsNav admin={false} on="notifications" />);
    expect(html).toMatch(/<nav [^>]*aria-label="Settings"/);
    const all = links(html);
    expect(all.map((link) => link.label)).toEqual(['Notifications']);
    expect(all[0]!.attrs).toContain('aria-current="page"');
    expect(html).not.toContain('Run the setup again');
  });
});
