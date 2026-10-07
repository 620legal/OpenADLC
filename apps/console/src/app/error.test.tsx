import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GlobalError from './global-error';
import PageError from './error';

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
