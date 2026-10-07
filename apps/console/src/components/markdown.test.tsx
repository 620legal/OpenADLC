import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FORMATTED_LIMIT, Markdown, parseMarkdown } from './markdown';

/**
 * The intake bot's questions arrived as a wall of asterisks and backticks:
 * the bots write markdown for GitHub, and the console showed it as text.
 */

const QUESTION = [
  'The repo is a bare testbed: it has a one-line `README.md`, no HTML.',
  '',
  '1. **Where does the page go?** I would assume `index.html` at the root.',
  '2. **The README already exists.** Add a section, or replace it?',
  '',
  '<!-- fleetadlc:{"event":"question"} -->',
].join('\n');

function html(text: string): string {
  return renderToStaticMarkup(<Markdown text={text} />);
}

describe('a bot’s markdown', () => {
  it('shows bold, code and a numbered list instead of their markers', () => {
    const page = html(QUESTION);

    expect(page).toContain('<code class="rounded bg-well');
    expect(page).toContain('>README.md</code>');
    expect(page).toContain('<ol start="1"');
    expect(page).toContain('<strong class="font-semibold">Where does the page go?</strong>');
    expect(page).not.toContain('**');
    expect(page).not.toContain('`');
  });

  it('drops the fleetadlc marker a person was never meant to read', () => {
    expect(html(QUESTION)).not.toContain('fleetadlc:');
    expect(parseMarkdown('<!-- fleetadlc:{"event":"stopped"} -->')).toEqual([]);
  });

  it('keeps a numbered list numbered from where it starts', () => {
    expect(parseMarkdown('3. third\n4. fourth')).toEqual([
      { kind: 'list', ordered: true, start: 3, items: ['third', 'fourth'] },
    ]);
  });

  it('follows only http and https links, and shows any other as the text it was', () => {
    expect(html('[the pull request](https://github.com/o/r/pull/31)')).toContain(
      '<a href="https://github.com/o/r/pull/31" target="_blank" rel="noreferrer"',
    );
    const unsafe = html('[click](javascript:alert(1))');
    expect(unsafe).not.toContain('<a');
    expect(unsafe).toContain('[click](javascript:alert(1))');
  });

  it('never turns what a bot wrote into markup', () => {
    const page = html('<img src=x onerror=alert(1)> and <b>bold</b>');
    expect(page).not.toContain('<img');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('keeps a fenced block as code, without reading markers inside it', () => {
    expect(parseMarkdown('```\nmake ci **not bold**\n```')).toEqual([{ kind: 'code', text: 'make ci **not bold**' }]);
  });

  it('keeps single line breaks, as GitHub does in a comment', () => {
    expect(html('first line\nsecond line')).toContain('first line</span><span><br/>second line');
  });

  it('keeps bold that holds inline code bold, with the code inside it', () => {
    // The intake bot's third question: bold wrapping a command. Split on the
    // backticks first, it came out as `**What about` … `?**`.
    const page = html('3. **What about `make ci`?** A builder has to get it green.');

    expect(page).toContain('<strong class="font-semibold">What about <code');
    expect(page).toContain('>make ci</code>?</strong>');
    expect(page).not.toContain('**');
  });

  it('leaves markers inside a code span alone', () => {
    expect(html('run `a **b** c` now')).toContain('>a **b** c</code>');
  });
});

describe('what OpenADLC posted to GitHub, shown in the console', () => {
  it('leaves out the header, since the console already says which bot wrote it', () => {
    const posted = '**OpenADLC_example · intake agent**<!-- fleetadlc-header -->\n\nThe issue is filed.';
    expect(parseMarkdown(posted)).toEqual([{ kind: 'paragraph', lines: ['The issue is filed.'] }]);
  });

  it('keeps a bold first line a person wrote', () => {
    expect(parseMarkdown('**Heads up**\n\nMine.')[0]).toEqual({ kind: 'paragraph', lines: ['**Heads up**'] });
  });
});

describe('a line built to be slow', () => {
  it('draws a long line of unmatched brackets at once, not in seconds', () => {
    // GitHub's comment limit of `[`: about six and a half seconds to draw, on
    // the console's one server process, before the patterns were bounded.
    for (const length of [3_999, 65_536]) {
      const started = performance.now();
      const html = renderToStaticMarkup(<Markdown text={'['.repeat(length)} />);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(html.split('[').length - 1).toBe(length);
    }
  });

  it('still reads markup in a line of an ordinary length', () => {
    const html = renderToStaticMarkup(<Markdown text={`See [the plan](https://example.com/plan) and **this**. ${'x'.repeat(3_000)}`} />);
    expect(html).toContain('<a href="https://example.com/plan"');
    expect(html).toContain('<strong');
  });

  it('parses a heading with ten thousand spaces in linear time', () => {
    // A heading, a few thousand spaces and a letter: seconds to read, cubic
    // in its length, while the closing hashes were part of the pattern.
    const spaces = ' '.repeat(10_000);
    const started = performance.now();
    const blocks = parseMarkdown(`# a${spaces}x`);
    expect(performance.now() - started).toBeLessThan(50);
    expect(blocks).toEqual([{ kind: 'heading', text: `a${spaces}x` }]);
  });

  it('draws forty thousand unclosed comments at once', () => {
    const started = performance.now();
    renderToStaticMarkup(<Markdown text={'<!--'.repeat(40_000)} />);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('draws forty thousand brackets at once', () => {
    const started = performance.now();
    renderToStaticMarkup(<Markdown text={'['.repeat(40_000)} />);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('headings', () => {
  it('reads a heading with or without its closing hashes', () => {
    for (const line of ['# Title', '## Title ##', '### Title #', '#  Title  ', '# Title###   ']) {
      expect(parseMarkdown(line)).toEqual([{ kind: 'heading', text: 'Title' }]);
    }
    expect(parseMarkdown('## ##')).toEqual([{ kind: 'heading', text: '' }]);
    expect(parseMarkdown('# a #b')).toEqual([{ kind: 'heading', text: 'a #b' }]);
  });

  it('leaves a hashtag a paragraph', () => {
    expect(parseMarkdown('#hashtag')).toEqual([{ kind: 'paragraph', lines: ['#hashtag'] }]);
  });
});

describe('a very long message', () => {
  it('formats up to the limit and shows the rest as plain text, not dropped', () => {
    const head = `**bold** ${'x'.repeat(100)}\n`.repeat(Math.ceil(FORMATTED_LIMIT / 110));
    const tail = '**not bold past the limit** <!-- fleetadlc:{"event":"x"} -->';
    const page = renderToStaticMarkup(<Markdown text={`${head}${tail}`} />);
    expect(page).toContain('<strong class="font-semibold">bold</strong>');
    expect(page).toContain('<p class="whitespace-pre-wrap">**bold**');
    expect(page).toContain('**not bold past the limit**</p></div>');
    expect(page).not.toContain('fleetadlc:');
  });
});
