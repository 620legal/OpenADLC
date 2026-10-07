import { describe, expect, it } from 'vitest';
import { SubjectTitles } from './subject-titles.js';

/**
 * A pull request the board has no row for is named by its own title, read
 * from GitHub once and kept — the list of what needs you is read every
 * fifteen seconds.
 */
describe('the title of a subject the board does not know', () => {
  function titles(answer: (repo: string, number: number) => Promise<{ title: string; htmlUrl: string }>) {
    const asked: string[] = [];
    let now = Date.parse('2026-09-25T12:00:00.000Z');
    const subject = new SubjectTitles({
      client: async () => ({
        getIssue: async (repo: string, number: number) => {
          asked.push(`${repo}#${number}`);
          return answer(repo, number);
        },
      }),
      fullName: async (name) => (name === 'fleetadlc-testbed' ? 'janedoe/fleetadlc-testbed' : null),
      now: () => now,
    });
    return { subject, asked, advance: (ms: number) => (now += ms) };
  }

  it('is read from GitHub, says whether it is a pull request, and is not read again for hours', async () => {
    const { subject, asked, advance } = titles(async (_repo, number) => ({
      title: 'Add a health endpoint',
      htmlUrl: `https://github.com/janedoe/fleetadlc-testbed/pull/${number}`,
    }));

    expect(await subject.lookup(['fleetadlc-testbed#2'])).toEqual(
      new Map([['fleetadlc-testbed#2', { title: 'Add a health endpoint', url: 'https://github.com/janedoe/fleetadlc-testbed/pull/2', pullRequest: true }]]),
    );
    await subject.lookup(['fleetadlc-testbed#2']);
    advance(60 * 60 * 1000);
    await subject.lookup(['fleetadlc-testbed#2']);
    expect(asked).toEqual(['janedoe/fleetadlc-testbed#2']);
  });

  it('asks again soon after GitHub could not say, and never about a repository it does not manage', async () => {
    const { subject, asked, advance } = titles(async () => {
      throw new Error('fetch failed');
    });
    expect(await subject.lookup(['fleetadlc-testbed#2', 'elsewhere#4', 'request:a4b02784'])).toEqual(new Map());
    advance(11 * 60 * 1000);
    await subject.lookup(['fleetadlc-testbed#2']);
    expect(asked).toEqual(['janedoe/fleetadlc-testbed#2', 'janedoe/fleetadlc-testbed#2']);
  });
});
