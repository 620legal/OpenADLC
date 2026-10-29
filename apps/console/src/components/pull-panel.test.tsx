import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PullCommandView, PullView } from '@/lib/api';
import { PullActionsView, PullPanelView } from './pull-panel';

/**
 * A pull request's commands and what its workflows posted, on its work item
 * and its Needs-you card: in the bridge's order, a reviewer's sign-off only
 * for them, the preview and screenshots for the head, marked older otherwise,
 * and every image from the console's own address.
 */

const HEAD = 'abc1234' + 'f'.repeat(33);

const preview: PullCommandView = { name: 'preview', label: 'Preview', comment: '/preview', by: 'anyone', reviewers: [], unblocks: null, offered: true, state: 'ready' };
const approve: PullCommandView = {
  name: 'approve-pages',
  label: 'Approve pages',
  comment: '/approve-pages',
  by: 'reviewer',
  reviewers: ['orzelig'],
  unblocks: 'visual-review',
  offered: true,
  state: 'ready',
};

function view(overrides: Partial<PullView> = {}): PullView {
  return {
    repo: 'www',
    number: 46,
    url: 'https://github.com/620legal/www/pull/46',
    open: true,
    head: HEAD,
    checks: { 'visual-review': 'failure' },
    commands: [approve, preview],
    outputs: [
      {
        name: 'preview',
        kind: 'link',
        found: { commentId: 11, commentUrl: 'https://github.com/c/11', at: '2026-10-29T10:05:00Z', url: 'https://review.example.test/46/', sha: 'abc1234', current: true },
      },
      {
        name: 'screenshots',
        kind: 'images',
        found: {
          commentId: 12,
          commentUrl: 'https://github.com/c/12',
          at: '2026-10-29T10:06:00Z',
          sha: 'abc1234',
          current: true,
          images: [
            { index: 0, alt: 'home before' },
            { index: 1, alt: 'home after' },
          ],
        },
      },
    ],
    errors: [],
    ...overrides,
  };
}

const render = (given: PullView) => renderToStaticMarkup(<PullPanelView subject="www#12" view={given} pending={null} onPress={() => undefined} />);

describe('the pull panel', () => {
  it('draws nothing for a repository that declares nothing', () => {
    expect(render(view({ commands: [], outputs: [], checks: {} }))).toBe('');
  });

  it('shows the buttons in the bridge’s order, the sign-off first while its check is red', () => {
    const html = render(view());
    expect(html.indexOf('data-pull-command="approve-pages"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-pull-command="approve-pages"')).toBeLessThan(html.indexOf('data-pull-command="preview"'));
  });

  it('shows a sent command as sent until its workflow answers, and then the answer', () => {
    const html = render(view({ commands: [{ ...preview, state: 'sent' }, { ...approve, state: 'answered', answer: 'visual-review passed' }] }));
    expect(html).toMatch(/data-pull-command="preview"[^>]*disabled[^>]*>Preview: sent</);
    expect(html).toContain('visual-review passed');
  });

  it('says why a sign-off is not this person’s, with GitHub as the way to send it', () => {
    const html = render(
      view({
        commands: [{ ...approve, offered: false, why: "Approve pages is @orzelig's to send; nobody here has linked @orzelig's GitHub account. Link it in Settings, or send /approve-pages on GitHub." }, preview],
      }),
    );
    expect(html).not.toContain('data-pull-command="approve-pages"');
    expect(html).toContain('nobody here has linked @orzelig');
    expect(html).toContain('href="https://github.com/620legal/www/pull/46"');
  });

  it('shows the preview address with its commit, and the screenshots from the console’s own address', () => {
    const html = render(view());
    expect(html).toContain('href="https://review.example.test/46/"');
    expect(html).toContain('abc1234');
    expect(html).toContain('src="/api/item/www%2312/pull/images/12/0"');
    expect(html).toContain('src="/api/item/www%2312/pull/images/12/1"');
    expect(html).not.toContain('data-pull-older');
    // No GitHub or signed address reaches the browser as an image.
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
  });

  it('marks the preview and the screenshots as older when they are for an older head', () => {
    const older = view();
    for (const output of older.outputs) output.found = { ...output.found!, current: false };
    const html = render(older);
    expect(html.match(/data-pull-older/g)).toHaveLength(2);
    expect(html).toContain('older: built from abc1234');
  });

  it('says what the repository’s declaration got wrong', () => {
    expect(render(view({ errors: ['pullRequests.commands[1]: nobody: by: reviewer needs reviewers.'] }))).toContain('.github/openadlc.yml: pullRequests.commands[1]');
  });
});

describe('the buttons on a Needs-you card', () => {
  it('shows why a sign-off is not this person’s only when it unblocks a red check', () => {
    const notMine = { ...approve, offered: false, why: 'Approve pages is @orzelig’s to send.' };
    const red = renderToStaticMarkup(<PullActionsView view={view({ commands: [notMine, preview] })} pending={null} onPress={() => undefined} />);
    expect(red).toContain('data-pull-why="approve-pages"');
    const green = renderToStaticMarkup(<PullActionsView view={view({ commands: [preview, notMine], checks: { 'visual-review': 'success' } })} pending={null} onPress={() => undefined} />);
    expect(green).not.toContain('data-pull-why');
    expect(green).toContain('data-pull-command="preview"');
  });
});
