import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain script with no types; it is run directly as well.
import { anchorOf, brokenLinks, brokenLinksIn } from './check-links.mjs';

describe('the links in the repository’s Markdown', () => {
  it('all resolve, anchors included', () => {
    expect(brokenLinks()).toEqual([]);
  });

  it('turns a heading into the anchor GitHub gives it', () => {
    expect(anchorOf('One request, start to finish')).toBe('one-request-start-to-finish');
    expect(anchorOf('`openadlc up` and the `--driver` flag')).toBe('openadlc-up-and-the---driver-flag');
    expect(anchorOf('Who OpenADLC acts for')).toBe('who-openadlc-acts-for');
    // GitHub keeps an underscore inside a word, and drops emphasis markers.
    expect(anchorOf('$OPENADLC_HOME')).toBe('openadlc_home');
    expect(anchorOf('`MANUAL_STEPS` and more')).toBe('manual_steps-and-more');
    expect(anchorOf('An _emphasised_ word')).toBe('an-emphasised-word');
  });

  it('checks the targets of HTML in Markdown, as it does Markdown links', () => {
    // A README that centred its pictures with <picture> and <img> was not
    // checked at all: renaming a screenshot would have left a broken image on
    // the repository's front page with every test green.
    const root = mkdtempSync(join(tmpdir(), 'links-'));
    try {
      writeFileSync(join(root, 'ok.png'), '');
      writeFileSync(join(root, 'other.md'), '# Other\n\n## A real heading\n');
      writeFileSync(
        join(root, 'page.md'),
        [
          '# Page',
          '',
          '## A real heading',
          '',
          '<a id="x"></a>',
          '<img alt="gone" src="missing.png">',
          '<picture>',
          '  <source media="(prefers-color-scheme: dark)" srcset="ok.png 1x, missing-2x.png 2x">',
          "  <img alt='fine' src='ok.png'>",
          '</picture>',
          '<a href="other.md#nope">no such heading there</a>',
          '<a',
          '  href="#nope">no such heading here, on a tag over two lines</a>',
          '<a href="other.md#a-real-heading">fine</a>',
          '<a href="#a-real-heading">fine</a>',
          '<a href="#x">fine, an a id</a>',
          '<a href="https://example.com/missing.png">external</a>',
          '<img src="data:image/png;base64,AAAA,BBBB">',
          '<a href="mailto:someone@example.com">mail</a>',
          'In a code span: `<img src="missing-in-code.png">`.',
          '<!-- <img src="missing-in-comment.png">',
          '     <a href="#missing-in-comment">over two lines</a> -->',
          '```html',
          '<img src="missing-in-fence.png">',
          '```',
          '',
        ].join('\n'),
      );
      expect(brokenLinksIn(root, 'page.md')).toEqual([
        'page.md:6 → missing.png (no such file)',
        'page.md:8 → missing-2x.png (no such file)',
        'page.md:11 → other.md#nope (no heading #nope in other.md)',
        'page.md:13 → #nope (no heading #nope in page.md)',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
