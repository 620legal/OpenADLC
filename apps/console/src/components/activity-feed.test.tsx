import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BoardEvent } from '@/lib/activity';
import { ActivityFeed, ActivityFilters, ActivityRow } from './activity-feed';

/** The Activity page's parts as the server draws them. */

const CREW = [
  { name: 'builder', slot: 'builder' },
  { name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second', githubLogin: 'irisexampleco' },
];
const NOW = Date.parse('2026-11-02T01:00:00.000Z');

function row(event: BoardEvent): string {
  return renderToStaticMarkup(
    <ul>
      <ActivityRow event={event} crew={CREW} now={NOW} />
    </ul>,
  ).replace(/<!-- -->/g, '');
}

describe('a row', () => {
  const event: BoardEvent = {
    id: 'pull_request.opened:620legal/OpenADLC#412',
    type: 'pull_request.opened',
    at: '2026-11-02T00:58:00.000Z',
    bot: 'builder',
    item: { ref: 'OpenADLC#412', repo: '620legal/OpenADLC', url: 'https://github.com/620legal/OpenADLC/pull/412' },
    text: 'builder opened #412: Show the crew’s activity',
  };

  it('is a link to its item with the bot, the repository, the text and the time', () => {
    const html = row(event);
    expect(html).toContain('href="/items/OpenADLC%23412"');
    expect(html).toMatch(/data-activity-bot="true"[^>]*>builder</);
    expect(html).toMatch(/<span class="truncate">OpenADLC<\/span>/);
    expect(html).toContain('builder opened #412: Show the crew’s activity');
    expect(html).toMatch(/<time dateTime="2026-11-02T00:58:00.000Z"[^>]*>2 min ago<\/time>/);
  });

  it('names a bot no seat did as OpenADLC, and a request filed nowhere as a request', () => {
    const html = row({ ...event, bot: null, item: { ref: 'request:ab12cd34', repo: null, url: null } });
    expect(html).toMatch(/data-activity-bot="true"[^>]*>OpenADLC</);
    expect(html).toMatch(/<span class="truncate">request<\/span>/);
    expect(html).toContain('href="/items/request%3Aab12cd34"');
  });
});

describe('the filters', () => {
  it('offer every repository and every bot, with all of them first', () => {
    const html = renderToStaticMarkup(<ActivityFilters repos={['OpenADLC', 'website']} crew={CREW} repo="website" bot="" onRepo={() => undefined} onBot={() => undefined} />);
    expect(html).toContain('<option value="">All repositories</option>');
    expect(html).toContain('<option value="website" selected="">website</option>');
    expect(html).toContain('<option value="" selected="">Every bot</option>');
    expect(html).toContain('<option value="builder">');
    expect(html).toContain('<option value="irisexampleco">irisexampleco</option>');
  });
});

describe('the list, before it has read anything', () => {
  it('says it is reading, with no Load more and no end yet', () => {
    const html = renderToStaticMarkup(<ActivityFeed repos={['OpenADLC']} crew={CREW} initialRepo="OpenADLC" />);
    expect(html).toContain('Reading activity…');
    expect(html).not.toContain('data-activity-more');
    expect(html).not.toContain('data-activity-end');
    expect(html).toContain('<option value="OpenADLC" selected="">OpenADLC</option>');
  });
});
