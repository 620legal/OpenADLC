import { describe, expect, it } from 'vitest';
import { parseDeliveryRules } from './delivery-rules.js';
import { compileTemplate, orderPullActions, outputIsCurrent, pullRequestRules, readOutput } from './pull-commands.js';

const WWW = `
testing:
  on: none
pullRequests:
  commands:
    - name: preview
      comment: /preview
      label: Preview
      answer: preview
    - name: approve-pages
      comment: /approve-pages
      label: Approve pages
      by: reviewer
      reviewers: [orzelig]
      unblocks: visual-review
  outputs:
    - name: preview
      kind: link
      match: "Preview of #{pr} at {sha}: {url}"
    - name: screenshots
      kind: images
      marker: "<!-- visual-review -->"
      head: "at {sha}"
`;

describe('pullRequestRules', () => {
  it('gives nothing for a file with no pullRequests section, or no file', () => {
    expect(pullRequestRules('testing:\n  on: none\n')).toEqual({ commands: [], outputs: [], errors: [] });
    expect(pullRequestRules(null)).toEqual({ commands: [], outputs: [], errors: [] });
  });

  it("reads www's commands and outputs", () => {
    const rules = pullRequestRules(WWW);
    expect(rules.errors).toEqual([]);
    expect(rules.commands).toEqual([
      { name: 'preview', comment: '/preview', label: 'Preview', by: 'anyone', reviewers: [], answer: 'preview', unblocks: null },
      { name: 'approve-pages', comment: '/approve-pages', label: 'Approve pages', by: 'reviewer', reviewers: ['orzelig'], answer: null, unblocks: 'visual-review' },
    ]);
    expect(rules.outputs.map((one) => [one.name, one.kind, one.from])).toEqual([
      ['preview', 'link', ['github-actions[bot]']],
      ['screenshots', 'images', ['github-actions[bot]']],
    ]);
  });

  it('drops an entry that does not parse, says why, and keeps the rest', () => {
    const rules = pullRequestRules(`
pullRequests:
  commands:
    - name: ok
      comment: /ok
    - name: two-lines
      comment: "/a\\n/b"
    - name: nobody
      comment: /sign
      by: reviewer
    - name: ok
      comment: /again
  outputs:
    - name: rx
      kind: link
      match: "(.*)+ {url}"
    - name: bad
      kind: link
      match: "{evil} {url}"
`);
    expect(rules.commands.map((one) => one.name)).toEqual(['ok']);
    expect(rules.outputs.map((one) => one.name)).toEqual(['rx']);
    expect(rules.errors).toHaveLength(4);
    expect(rules.errors.join(' ')).toMatch(/two-lines.*one line/);
    expect(rules.errors.join(' ')).toMatch(/nobody: by: reviewer needs reviewers/);
    expect(rules.errors.join(' ')).toMatch(/used twice/);
    expect(rules.errors.join(' ')).toMatch(/only \{pr\}, \{sha\} and \{url\}/);
  });

  it('is never read by the delivery rules: the section changes nothing about how a repository ships', () => {
    const without = parseDeliveryRules('testing:\n  on: none\n');
    const withSection = parseDeliveryRules(WWW);
    expect(withSection).toEqual(without);
    // And a broken section leaves the delivery rules as they were.
    expect(parseDeliveryRules('testing:\n  on: none\npullRequests: 7\n')).toEqual(without);
  });
});

describe('templates', () => {
  it('matches every character but a placeholder literally', () => {
    const compiled = compileTemplate('(.*)+ {url}');
    if (typeof compiled === 'string') throw new Error(compiled);
    expect(compiled.pattern.test('aaaa https://x.test')).toBe(false);
    expect(compiled.pattern.test('(.*)+ https://x.test')).toBe(true);
  });
});

describe('readOutput', () => {
  const [preview, screenshots] = pullRequestRules(WWW).outputs as [never, never];
  const bot = 'github-actions[bot]';

  it('reads the preview address and its commit from a declared author', () => {
    expect(readOutput(preview, { user: bot, body: 'Deployed.\nPreview of #46 at abc1234: https://review.example.test/46/\n' }, 46)).toEqual({
      url: 'https://review.example.test/46/',
      sha: 'abc1234',
    });
  });

  it('reads nothing from another author, or for another pull request', () => {
    expect(readOutput(preview, { user: 'mallory', body: 'Preview of #46 at abc1234: https://evil.test/' }, 46)).toBeNull();
    expect(readOutput(preview, { user: bot, body: 'Preview of #45 at abc1234: https://review.example.test/45/' }, 46)).toBeNull();
  });

  it('reads the screenshots comment by its marker, with the commit it names', () => {
    expect(readOutput(screenshots, { user: bot, body: '<!-- visual-review -->\nScreenshots at def5678\n![before](x)' }, 46)).toEqual({ sha: 'def5678' });
    expect(readOutput(screenshots, { user: bot, body: 'no marker here' }, 46)).toBeNull();
  });
});

describe('outputIsCurrent', () => {
  it('is current when the commit it names is the head, and older otherwise', () => {
    expect(outputIsCurrent({ sha: 'abc1234' }, 'abc1234ffffffffffffffffffffffffffffffff0', null, '2026-10-29T00:00:00Z')).toBe(true);
    expect(outputIsCurrent({ sha: 'abc1234' }, 'fed9876ffffffffffffffffffffffffffffffff0', null, '2026-10-29T00:00:00Z')).toBe(false);
  });

  it('without a commit, goes by whether the comment came after the head', () => {
    expect(outputIsCurrent({}, 'abc', '2026-10-29T10:00:00Z', '2026-10-29T10:05:00Z')).toBe(true);
    expect(outputIsCurrent({}, 'abc', '2026-10-29T10:00:00Z', '2026-10-29T09:55:00Z')).toBe(false);
  });
});

describe('orderPullActions', () => {
  const commands = pullRequestRules(WWW).commands;

  it('puts the command that unblocks a red check first, then Preview, and the merge last', () => {
    expect(orderPullActions({ commands, checks: { 'visual-review': 'failure' }, held: true })).toEqual([
      { kind: 'command', name: 'approve-pages' },
      { kind: 'command', name: 'preview' },
      { kind: 'merge' },
    ]);
    // A check that has not reported yet is not green either.
    expect(orderPullActions({ commands, checks: {}, held: false })[0]).toEqual({ kind: 'command', name: 'approve-pages' });
  });

  it('keeps the declared order once the check is green', () => {
    expect(orderPullActions({ commands, checks: { 'visual-review': 'success' }, held: true })).toEqual([
      { kind: 'command', name: 'preview' },
      { kind: 'command', name: 'approve-pages' },
      { kind: 'merge' },
    ]);
  });
});
