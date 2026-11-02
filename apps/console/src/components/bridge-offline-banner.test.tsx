import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BridgeOfflineBanner, sinceWords } from './bridge-offline-banner';

const NOW = Date.parse('2026-11-02T14:10:00Z');

describe('the banner while the bridge does not answer', () => {
  it('says since when, on the reader’s clock, and that the page may be out of date', () => {
    const html = renderToStaticMarkup(<BridgeOfflineBanner since={Date.parse('2026-11-02T14:02:30Z')} now={NOW} timeZone="UTC" />);
    expect(html).toContain('role="status"');
    expect(html.replace(/<[^>]+>/g, '')).toBe('Can&#x27;t reach OpenADLC since 14:02. What you see may be out of date.');
  });

  it('says the time in the reader’s zone', () => {
    expect(sinceWords(Date.parse('2026-11-02T14:02:00Z'), NOW, 'Europe/Berlin')).toBe('15:02');
  });

  it('adds the date when it was not today', () => {
    expect(sinceWords(Date.parse('2026-11-01T23:50:00Z'), NOW, 'UTC')).toBe('1 Nov, 23:50');
  });
});
