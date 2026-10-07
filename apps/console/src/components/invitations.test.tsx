import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Invitations } from './invitations';

type Bot = Parameters<typeof Invitations>[0]['bots'][number];

function bot(partial: Partial<Bot> & Pick<Bot, 'bot'>): Bot {
  return {
    displayName: partial.bot,
    login: `fleetadlc-${partial.bot}-acme`,
    connected: false,
    inRepository: null,
    repositoryRole: 'write',
    accessReason: 'reviews count only with write access',
    accountExists: null,
    ...partial,
  };
}

function page(bots: Bot[]): string {
  return renderToStaticMarkup(
    <Invitations bots={bots} isOrganization={false} inviteUrl={null} canInvite={true} />,
  ).replace(/<!-- -->/g, '');
}

describe('letting the crew into the repository', () => {
  const html = page([
    bot({
      bot: 'irisexampleco',
      slot: 'second-reviewer',
      role: 'review_second',
      roleLabel: 'second reviewer',
      login: 'irisexampleco',
      connected: true,
      inRepository: true,
      accountExists: true,
    }),
    bot({ bot: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', roleLabel: 'lead reviewer' }),
    bot({ bot: 'qa', slot: 'qa', role: 'qa', roleLabel: 'QA', accountExists: false }),
  ]);

  it('shows a connected bot by its handle, with its role beside it', () => {
    expect(html).toMatch(/>irisexampleco<\/span><span class="[^"]*">second reviewer<\/span>/);
  });

  it('says which are not connected yet by their roles, not by a username nobody holds', () => {
    expect(html).toContain('The lead reviewer is not connected yet.');
    expect(html).toContain('The QA bot has no GitHub account yet.');
    expect(html).not.toContain('fleetadlc-lead-reviewer-acme');
    expect(html).not.toContain('lead-reviewer');
  });
});

describe('letting the crew into every repository', () => {
  const REPOSITORIES = ['acme/widgets', 'acme/api'];
  const crew = [
    bot({
      bot: 'irisexampleco',
      roleLabel: 'second reviewer',
      login: 'irisexampleco',
      connected: true,
      accountExists: true,
      inRepository: false,
      access: [
        { repository: 'acme/widgets', inRepository: true },
        { repository: 'acme/api', inRepository: false },
      ],
    }),
    bot({
      bot: 'fleetadlc-atlas-janedoe',
      roleLabel: 'builder',
      login: 'fleetadlc-atlas-janedoe',
      connected: true,
      accountExists: true,
      inRepository: true,
      access: [
        { repository: 'acme/widgets', inRepository: true },
        { repository: 'acme/api', inRepository: true },
      ],
    }),
  ];

  function several(): string {
    return renderToStaticMarkup(
      <Invitations bots={crew} repositories={REPOSITORIES} isOrganization={false} inviteUrl={null} canInvite={true} />,
    ).replace(/<!-- -->/g, '');
  }

  it('counts a bot as in only when it is in every one of them', () => {
    expect(several()).toContain('1 of 2 in every repository');
  });

  it('says for each bot where it is in and where it is not yet', () => {
    const where = [...several().matchAll(/<ul aria-label="Where ([^"]+) is in"[^>]*>([\s\S]*?)<\/ul>/g)].map((match) => [
      match[1],
      [...match[2]!.matchAll(/<li[^>]*>([^<]+)<\/li>/g)].map((line) => line[1]),
    ]);
    expect(where).toEqual([
      ['the second reviewer (irisexampleco)', ['acme/widgets: in', 'acme/api: not yet']],
      ['the builder (fleetadlc-atlas-janedoe)', ['acme/widgets: in', 'acme/api: in']],
    ]);
    expect(several()).toContain('That is done for each repository OpenADLC works in.');
  });

  it('keeps its words for a single repository', () => {
    const html = renderToStaticMarkup(
      <Invitations bots={crew} repositories={['acme/widgets']} isOrganization={false} inviteUrl={null} canInvite={true} />,
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('1 of 2 in the repository');
    expect(html).not.toContain('Where irisexampleco is in');
  });
});
