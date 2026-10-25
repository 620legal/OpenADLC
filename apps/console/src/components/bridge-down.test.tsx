import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BridgeAnswered, DatabaseDown } from '@/lib/bridge-answered';
import { BridgeDown } from './bridge-down';

const LINE = "the install's database (openadlc-db) isn't answering on 127.0.0.1:47432: start it with `docker start openadlc-db`, or run `openadlc up`";

/** Rendered text, with React's escapes undone, so a line can be looked for as the bridge said it. */
const text = (node: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(node).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('a page that could not read the bridge', () => {
  // It read `connect ECONNREFUSED 127.0.0.1:47432`, and sent people to the bridge's log.
  it('says the install’s database is not answering, in the bridge’s line, when that is why', () => {
    const html = text(<BridgeDown error={new DatabaseDown('/v1/board', 500, LINE)} />);
    expect(html).toContain('The install’s database isn’t answering');
    expect(html).toContain(LINE);
    expect(html).not.toContain('The bridge answered with an error');
  });

  it('still says the bridge answered with an error for anything else, and that it cannot be reached when it did not answer', () => {
    expect(text(<BridgeDown error={new BridgeAnswered('/v1/board', 500, 'boom')} />)).toContain('The bridge answered with an error');
    expect(text(<BridgeDown error={new Error('fetch failed')} />)).toContain('The console cannot reach the bridge');
  });
});
