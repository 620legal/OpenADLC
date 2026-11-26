import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityBell, parseEvent } from './activity-bell';

/**
 * The activity button as the server draws it: no storage and nothing read
 * yet, so no count — the count is the browser's, read after mounting — and a
 * panel that is closed until it is opened.
 */

const CREW = [{ name: 'builder', slot: 'builder' }];

describe('the activity button, drawn on the server', () => {
  const html = renderToStaticMarkup(<ActivityBell repos={['OpenADLC', 'website']} crew={CREW} />).replace(/<!-- -->/g, '');

  it('is a button named Activity, with no count before the browser has read anything', () => {
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-label="Activity"/);
    expect(html).not.toContain('data-activity-badge');
  });

  it('has a panel, closed, with the filters and a way to every event', () => {
    expect(html).toMatch(/data-activity-panel="true"/);
    expect(html).toMatch(/<div id="[^"]+" hidden=""[^>]*data-activity-panel/);
    expect(html).toContain('aria-label="Repository"');
    expect(html).toContain('aria-label="Bot"');
    expect(html).toContain('<option value="website">website</option>');
    expect(html).toContain('href="/activity"');
    expect(html).toContain('All activity');
  });

  it('is touch-sized in the phone’s header', () => {
    const compact = renderToStaticMarkup(<ActivityBell repos={[]} crew={[]} compact />);
    expect(compact).toMatch(/<button[^>]*class="[^"]*size-11/);
  });
});

describe('a pushed message', () => {
  const pushed = { id: 'task.started:t1', type: 'task.started', at: '2026-11-02T00:00:01.000Z', bot: 'builder', item: { ref: 'OpenADLC#227', repo: '620legal/OpenADLC', url: null }, text: 'builder started' };

  it('is the event it carries', () => {
    expect(parseEvent(JSON.stringify(pushed))).toEqual(pushed);
  });

  it('is nothing when it is not an event', () => {
    expect(parseEvent(undefined)).toBeNull();
    expect(parseEvent('not json')).toBeNull();
    expect(parseEvent('{"id":"x"}')).toBeNull();
  });
});
