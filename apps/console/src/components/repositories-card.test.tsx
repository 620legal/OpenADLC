import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BotAccess, RepoAccess } from '@/lib/crew-access';

// Trying again refreshes the page it is on; there is no page here.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
import { newerAccess, RepositoriesCard, type CardRepository } from './repositories-card';

const bot = (name: string, state: BotAccess['state'], detail = ''): BotAccess => ({ bot: name, login: name, state, changed: false, detail });
const looked = (bots: BotAccess[], extra: Partial<RepoAccess> = {}): RepoAccess => ({
  repository: 'x',
  running: false,
  trigger: 'reconcile',
  checkedAt: '2026-09-25T09:00:00.000Z',
  error: null,
  bots,
  ...extra,
});
const NINE = Array.from({ length: 9 }, (_, index) => bot(`bot-${index}`, 'in'));

const REPOSITORIES: CardRepository[] = [
  { name: 'api', fullName: 'acme/api', color: 'teal', access: looked(NINE) },
  { name: 'docs', fullName: 'acme/docs', color: 'amber', access: looked([], { running: true, trigger: 'added', checkedAt: null }) },
  {
    name: 'website',
    fullName: 'acme/website',
    color: 'pink',
    access: looked([...NINE.slice(0, 8), bot('lead-reviewer', 'invited')]),
  },
  { name: 'infra', fullName: 'acme/infra', color: 'violet', access: looked([], { error: 'the app is not installed on acme/infra' }) },
];

/** Each repository's line: its name, what it says, why, and the button when there is one. */
function rows(html: string): string[] {
  const list = /<ul aria-label="Whether the crew can work in each repository"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
  return [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) =>
    match[1]!.replace(/<[^>]+>/g, ' | ').replace(/(\s*\|\s*)+/g, ' | ').replace(/^ \| | \| $/g, '').trim(),
  );
}

describe('whether the crew can work in each repository, in settings', () => {
  const html = renderToStaticMarkup(
    <RepositoriesCard
      repositories={REPOSITORIES}
      crew={[{ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: null, authorization: 'unauthorized' }]}
    />,
  ).replace(/<!-- -->/g, '');

  it('says it for every repository, in words', () => {
    expect(rows(html)).toEqual([
      'api | 9 of 9 bots can work here',
      'docs | Inviting the crew…',
      'website | 8 of 9 bots can work here | The lead reviewer is invited, and accepts once it is connected | Try again',
      'infra | The crew could not be let in | the app is not installed on acme/infra | Try again',
    ]);
  });

  it('pairs each with its colour', () => {
    const list = /<ul aria-label="Whether the crew can work in each repository"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    expect([...list.matchAll(/bg-repo-([a-z]+)/g)].map((match) => match[1])).toEqual(['teal', 'amber', 'pink', 'violet']);
  });

  it('says what to do for one the app cannot reach, with GitHub’s page, not the JSON GitHub answered', () => {
    // exampleco/infra: added while the app lived on janedoe only.
    const waiting = renderToStaticMarkup(
      <RepositoriesCard
        repositories={[
          {
            name: 'infra',
            fullName: 'exampleco/infra',
            color: 'amber',
            access: looked([], {
              error: 'The OpenADLC app is private to janedoe',
              needs: {
                need: 'make-public',
                title: 'The OpenADLC app is private to janedoe',
                detail: 'GitHub installs a private app only on the account that owns it, so it cannot go on exampleco yet.',
                action: { label: 'Make the app public', url: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced' },
                steps: [],
              },
            }),
          },
        ]}
      />,
    ).replace(/<!-- -->/g, '');

    expect(rows(waiting)).toEqual([
      'infra | The OpenADLC app is private to janedoe | GitHub installs a private app only on the account that owns it, so it cannot go on exampleco yet. | Make the app public',
    ]);
    expect(waiting).toMatch(/<a href="https:\/\/github.com\/settings\/apps\/fleetadlc-janedoe\/advanced" target="_blank"[^>]*>Make the app public/);
    expect(waiting).not.toContain('Try again');
    expect(waiting).not.toContain('404');
  });

  it('lists nothing before there is a repository, and offers to add one', () => {
    const empty = renderToStaticMarkup(<RepositoriesCard repositories={[]} />);
    expect(empty).not.toContain('Whether the crew can work in each repository');
    expect(empty).toContain('No repository yet');
  });
});

describe('a Try again’s answer, and the page’s later reads', () => {
  it('says the answer until the page reads a newer one, then the newer one', () => {
    const answer = looked([bot('builder', 'in'), bot('reviewer', 'invited')], { checkedAt: '2026-09-25T10:00:00.000Z' });
    const older = looked([bot('builder', 'in')], { checkedAt: '2026-09-25T09:00:00.000Z' });
    const newer = looked([bot('builder', 'in'), bot('reviewer', 'in')], { checkedAt: '2026-09-25T10:05:00.000Z' });
    expect(newerAccess(answer, older)).toBe(answer);
    expect(newerAccess(answer, { ...older, checkedAt: null })).toBe(answer);
    // Kept for good, the line said "1 of 2" after the reviewer had connected.
    expect(newerAccess(answer, newer)).toBe(newer);
    expect(newerAccess(null, newer)).toBe(newer);
  });
});
