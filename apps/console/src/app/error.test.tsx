import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GlobalError from './global-error';
import PageError from './error';

/** What Next rejected Pause work → Confirm with, once the console was updated under the page. */
const refused = () =>
  new UnrecognizedActionError(
    'Server Action "60a4dd1dc477e939b91262212479c9ac135159a0e9" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
  );

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);

describe('a page that stopped working', () => {
  it('says why, and offers to try again and to reload, in place of Next’s bare “Application error”', () => {
    const html = renderToStaticMarkup(<PageError error={Object.assign(new Error('boom'), { digest: 'd1' })} reset={() => undefined} />);
    expect(html).toContain('This page stopped working');
    expect(html).toContain('boom');
    expect(html).toContain('(d1)');
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(html).toMatch(/<button[^>]*>Reload the page<\/button>/);
  });

  it('draws its own document under a layout that failed', () => {
    const html = renderToStaticMarkup(<GlobalError error={new Error('')} reset={() => undefined} />);
    expect(html).toContain('<html');
    expect(html).toContain('no reason was given');
  });
});

describe('an action from a page the console was updated under', () => {
  // The cloud install showed Next's own words, an action id, and Try again,
  // which sent the same id to the same refusal; the work was not paused and
  // nothing said so.
  it('says the console was updated and nothing was done, and offers only a reload', () => {
    const html = renderToStaticMarkup(<PageError error={refused()} reset={() => undefined} />);
    expect(html).toContain('The console was updated');
    expect(html).toContain('since this page loaded, so what you just did was not done');
    expect(buttons(html)).toEqual(['Reload the page']);
    expect(html).not.toContain('Server Action');
    expect(html).not.toContain('60a4dd1d');
    expect(html).not.toContain('nextjs.org');
  });

  it('says the same under a layout that failed, in its own document', () => {
    const html = renderToStaticMarkup(<GlobalError error={refused()} reset={() => undefined} />);
    expect(html).toContain('<html');
    expect(html).toContain('The console was updated');
    expect(html).toContain('was not done');
    expect(buttons(html)).toEqual(['Reload the page']);
    expect(html).not.toContain('Server Action');
    expect(html).not.toContain('60a4dd1d');
  });
});
