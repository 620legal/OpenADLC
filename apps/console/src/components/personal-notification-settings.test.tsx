import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/actions', () => ({ savePersonalNotifications: vi.fn(), testPersonalNotifications: vi.fn() }));

import { PersonalNotificationSettings } from './personal-notification-settings';

/**
 * Your channel: a person's own ntfy topic or Slack webhook, where the items
 * routed to them go. The saved target is shown masked, never whole.
 */
function render(initial: Parameters<typeof PersonalNotificationSettings>[0]['initial']): string {
  return renderToStaticMarkup(<PersonalNotificationSettings initial={initial} />).replace(/<!-- -->/g, '');
}

describe('Your channel', () => {
  it('shows a saved channel masked, with Send a test and Stop', () => {
    const html = render({ kind: 'ntfy', server: 'https://ntfy.sh', target: '…9z8y', last: null });
    expect(html).toContain('Your channel');
    expect(html).toContain('<input type="radio" name="personal-notify-kind" checked="" value="ntfy"/>');
    expect(html).toContain('placeholder="…9z8y (saved; type to replace)"');
    expect(html).toMatch(/<input aria-label="Your Topic"[^>]*value=""\/>/);
    expect(html).toContain('>Send a test<');
    expect(html).toContain('>Stop<');
  });

  it('offers no test or Stop before a channel is saved, and says what reaches a person without one', () => {
    const html = render({ kind: null, server: null, target: null, last: null });
    expect(html).not.toContain('>Stop<');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send a test<\/button>/);
    expect(html).toContain('you still have the badge, desktop alerts and GitHub’s mention');
  });

  // Anyone signed in sets this: a webhook, or an ntfy server of their own,
  // would have the bridge post to any address they typed.
  it('offers ntfy and Slack only, and no server field: a topic goes to the install’s own server', () => {
    const html = render({ kind: 'ntfy', server: 'https://ntfy.example.com', target: '…9z8y', last: null });
    expect(html).toContain('value="ntfy"');
    expect(html).toContain('value="slack"');
    expect(html).not.toContain('value="webhook"');
    expect(html).not.toContain('aria-label="Your server"');
    expect(html).toContain('Sent to the install’s ntfy server, https://ntfy.example.com');
  });
});
