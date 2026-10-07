import type { ConfigFiles, ReviewerStanding } from '@fleetadlc/github';
import { describe, expect, it } from 'vitest';
import { HUMANS_SUBJECT, HUMAN_IDS_SUBJECT, humanReviewLinesInspection, namedLoginsInspection, repoConfigCheck, type RepoConfigReader } from './repo-config.js';

const REPO = { name: 'api', fullName: 'exampleco/api', defaultBranch: 'main' };

const AGENTS = ['# Agent notes', '', '## Human review', '', '- `config/` @janedoe-reviewer', '- `infra/` @janedoe', ''].join('\n');

function files(text: Record<string, string>, unreadable: string[] = []): ConfigFiles {
  return { text: new Map(Object.entries(text)), absent: [], unreadable };
}

/** A check over one repository whose logins GitHub answers as `standings` says; anyone else is unknown. */
function check(
  config: ConfigFiles | null,
  standings: Record<string, ReviewerStanding>,
  people: {
    humans?: string[];
    exists?: Record<string, boolean | null>;
    moved?: { moved: { login: string; pinned: number; now: number | false }[]; unknown: string[] };
  } = {},
) {
  const reader: RepoConfigReader = {
    repositories: async () => [REPO],
    files: async () => config,
    humans: async () => people.humans ?? [],
    exists: async (login) => people.exists?.[login] ?? null,
    ...(people.moved ? { movedHumans: async () => people.moved! } : {}),
  };
  const asked: string[] = [];
  const result = repoConfigCheck(reader, [
    namedLoginsInspection(
      async (_repo, login) => {
        asked.push(`standing ${login}`);
        return standings[login] ?? { state: 'unknown', reason: 'rate limited' };
      },
      async (login) => {
        asked.push(`exists ${login}`);
        const known = standings[login];
        return known ? known.state !== 'no-account' : null;
      },
    ),
  ]);
  return Object.assign(result, { asked });
}

const CAN: ReviewerStanding = { state: 'can-review' };
const MISSING: ReviewerStanding = { state: 'no-account', reason: 'there is no such GitHub account' };
const NOT_INVITED: ReviewerStanding = { state: 'cannot-review', reason: 'janedoe is not a collaborator on exampleco/api' };
const ORGANIZATION: ReviewerStanding = { state: 'not-a-person', reason: 'exampleco is an organization, not a person' };

describe('the repository configuration check', () => {
  it('fails, blocking, on a Human review rule naming an account that does not exist, with the file and line and the fix', async () => {
    const [result] = await check(files({ 'AGENTS.md': AGENTS }), { 'janedoe-reviewer': MISSING, janedoe: CAN }).run(new Date());
    expect(result).toMatchObject({
      subject: 'exampleco/api',
      ok: false,
      severity: 'blocking',
      title: '`janedoe-reviewer` is named as a reviewer in exampleco/api’s AGENTS.md, but there is no such GitHub account',
      action: { label: 'Open AGENTS.md on GitHub', url: 'https://github.com/exampleco/api/blob/main/AGENTS.md#L5' },
    });
    expect(result && 'detail' in result ? result.detail : '').toContain('**AGENTS.md, line 5:**');
    expect(result?.facts).toMatchObject({ subject: { repo: 'api' }, findings: [{ kind: 'reviewer-missing', file: 'AGENTS.md', line: 5, login: 'janedoe-reviewer' }] });
  });

  it('offers write access for an account that exists but cannot review there', async () => {
    const [result] = await check(files({ 'AGENTS.md': AGENTS }), { 'janedoe-reviewer': CAN, janedoe: NOT_INVITED }).run(new Date());
    expect(result).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: '`janedoe` is named as a reviewer in exampleco/api’s AGENTS.md, but cannot review: janedoe is not a collaborator on exampleco/api',
      action: { label: 'Give janedoe write access', url: 'https://github.com/exampleco/api/settings/access' },
      facts: { actions: [{ label: 'Open AGENTS.md on GitHub', url: 'https://github.com/exampleco/api/blob/main/AGENTS.md#L6' }] },
    });
    expect(result && 'detail' in result ? result.detail : '').toContain(
      'Invite them as a collaborator with write, or raise their role to write or more, on exampleco/api’s Collaborators and teams page. Or change the name on line 6 of AGENTS.md.',
    );
  });

  it('says why a collaborator with triage cannot review, rather than to invite them', async () => {
    // They are in already: GitHub has no invitation to send them, and only a
    // higher role lets their approval count.
    const triage: ReviewerStanding = {
      state: 'cannot-review',
      reason: 'janedoe has triage on exampleco/api, and an approval counts only from write or more',
    };
    const [result] = await check(files({ 'AGENTS.md': AGENTS }), { 'janedoe-reviewer': CAN, janedoe: triage }).run(new Date());
    expect(result).toMatchObject({
      title: '`janedoe` is named as a reviewer in exampleco/api’s AGENTS.md, but cannot review: janedoe has triage on exampleco/api, and an approval counts only from write or more',
    });
    expect(result && 'detail' in result ? result.detail : '').not.toContain('invite them as a collaborator:');
  });

  it('reads a code owner as a reviewer, and a mere mention of nobody as a warning', async () => {
    const owners = await check(files({ '.github/CODEOWNERS': '* @janedoe\n' }), { janedoe: NOT_INVITED }).run(new Date());
    expect(owners[0]).toMatchObject({ ok: false, severity: 'blocking' });
    const mention = await check(files({ '.github/pull_request_template.md': 'Ask @janedoe-reviewer.\n' }), { 'janedoe-reviewer': MISSING }).run(new Date());
    expect(mention[0]).toMatchObject({ ok: false, severity: 'warning' });
    // A mention only has to exist: not being a collaborator is no fault.
    const invited = check(files({ '.github/pull_request_template.md': 'Ask @janedoe.\n' }), { janedoe: NOT_INVITED });
    expect((await invited.run(new Date()))[0]).toMatchObject({ ok: true });
    // And it is asked only whether the account exists.
    expect(invited.asked).toEqual(['exists janedoe']);
  });

  // OpenADLC's own template names `@owner`, and GitHub has an organization by
  // that name: the card called it "cannot review" and offered to invite it.
  it('names the template’s placeholder as such, without asking GitHub or offering an invitation', async () => {
    const template = AGENTS.replace('@janedoe-reviewer', '@owner');
    const subject = check(files({ 'AGENTS.md': template }), { owner: ORGANIZATION, janedoe: CAN });
    const [result] = await subject.run(new Date());
    expect(result).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: 'exampleco/api’s AGENTS.md doesn’t say who approves its human-review paths yet — line 5 still has the template’s `@owner`',
      action: { label: 'Open AGENTS.md on GitHub', url: 'https://github.com/exampleco/api/blob/main/AGENTS.md#L5' },
      facts: { actions: [], findings: [{ kind: 'reviewer-placeholder', fix: 'Say who approves them on the Protect the repositories step, which writes them here — or replace it on line 5 with the logins who must approve these paths.' }] },
    });
    expect(subject.asked).not.toContain('standing owner');
  });

  it('says an organization named as a reviewer is not a person, and never offers to invite it', async () => {
    const [result] = await check(files({ 'CODEOWNERS': '* @exampleco\n' }), { exampleco: ORGANIZATION }).run(new Date());
    expect(result).toMatchObject({
      ok: false,
      severity: 'blocking',
      title: '`exampleco` is named as a reviewer in exampleco/api’s CODEOWNERS, but exampleco is an organization, not a person',
      action: { label: 'Open CODEOWNERS on GitHub' },
      facts: { actions: [] },
    });
    expect(JSON.stringify(result)).not.toContain('Invite ');
    // The repository's own organization is OpenADLC's old fallback: the Protect step repairs it.
    expect(JSON.stringify(result)).toContain('Protect the repositories step');
  });

  it('says a pull request waits, and an invitation helps, only where a finding is a reviewer’s', async () => {
    const detailOf = (result: unknown) => (result && typeof result === 'object' && 'detail' in result ? String(result.detail) : '');
    const [mentions] = await check(files({ '.github/pull_request_template.md': 'Ask @janedoe-reviewer.\n' }), { 'janedoe-reviewer': MISSING }).run(new Date());
    expect(detailOf(mentions)).not.toContain('waits for good');
    expect(detailOf(mentions)).not.toContain('can write to the repository');
    expect(detailOf(mentions)).toContain('This clears on the next check once the file is changed on the default branch.');

    const [missing] = await check(files({ 'AGENTS.md': AGENTS }), { 'janedoe-reviewer': MISSING, janedoe: CAN }).run(new Date());
    expect(detailOf(missing)).toContain('A pull request that needs one of these reviewers waits for good');
    expect(detailOf(missing)).not.toContain('can write to the repository');

    const [uninvited] = await check(files({ 'AGENTS.md': AGENTS }), { 'janedoe-reviewer': CAN, janedoe: NOT_INVITED }).run(new Date());
    expect(detailOf(uninvited)).toContain('or the person can write to the repository.');
  });

  it('asks only whether a mention GitHub did not answer for exists, not whether it can review', async () => {
    const [result] = await check(files({ '.github/pull_request_template.md': 'Ask @janedoe.\n' }), {}).run(new Date());
    expect(result).toMatchObject({ ok: null });
    const reason = result && 'reason' in result ? result.reason : '';
    expect(reason).toContain('GitHub did not say whether janedoe exists');
    expect(reason).not.toContain('can review');
  });

  it('calls nothing wrong when GitHub cannot be asked, and says it could not verify', async () => {
    const [unasked] = await check(files({ 'AGENTS.md': AGENTS }), {}).run(new Date());
    expect(unasked).toMatchObject({ ok: null });
    expect(unasked && 'reason' in unasked ? unasked.reason : '').toMatch(/could not verify/i);
    const [unread] = await check(null, {}).run(new Date());
    expect(unread).toMatchObject({ ok: null });
    // A file GitHub would not give is not a file that names nobody.
    const [partial] = await check(files({}, ['AGENTS.md']), {}).run(new Date());
    expect(partial).toMatchObject({ ok: null });
  });

  it('passes once the name is corrected or the person invited', async () => {
    const before = await check(files({ 'AGENTS.md': AGENTS }), { 'janedoe-reviewer': MISSING, janedoe: CAN }).run(new Date());
    expect(before[0]?.ok).toBe(false);
    const corrected = AGENTS.replace('@janedoe-reviewer', '@janedoe');
    const after = await check(files({ 'AGENTS.md': corrected }), { janedoe: CAN }).run(new Date());
    expect(after[0]).toMatchObject({ subject: 'exampleco/api', ok: true, fixed: 'Everyone exampleco/api’s configuration names can review there again' });
  });

  it('checks that each of the install’s people has an account', async () => {
    const results = await check(files({}), {}, { humans: ['janedoe', 'janedoe-reviewer'], exists: { janedoe: true, 'janedoe-reviewer': false } }).run(new Date());
    expect(results.find((result) => result.subject === HUMANS_SUBJECT)).toMatchObject({ ok: false, severity: 'warning' });
    const unknown = await check(files({}), {}, { humans: ['janedoe'] }).run(new Date());
    expect(unknown.find((result) => result.subject === HUMANS_SUBJECT)).toMatchObject({ ok: null });
  });

  it('says when one of the install’s people now names another GitHub account, or none, and to re-confirm or remove them', async () => {
    // A login freed by a rename or a deletion, registered by somebody else.
    const people = { humans: ['janedoe', 'alexsmith'], exists: { janedoe: true, alexsmith: false } };
    const moved = { moved: [{ login: 'janedoe', pinned: 101, now: 999 as number | false }, { login: 'alexsmith', pinned: 202, now: false as number | false }], unknown: [] };
    const results = await check(files({}), {}, { ...people, moved }).run(new Date());
    const card = results.find((result) => result.subject === HUMAN_IDS_SUBJECT);
    expect(card).toMatchObject({ ok: false, severity: 'warning', title: '`janedoe`, one of this install’s people, now belongs to a different GitHub account' });
    const detail = (card as { detail: string }).detail;
    expect(detail).toContain('`janedoe`: pinned to account 101, and the login names account 999 now');
    expect(detail).toContain('`alexsmith`: pinned to account 202, and there is no account by that login now');
    expect(detail).toContain('re-confirm');
    expect(detail).toContain('Otherwise remove it');

    const same = await check(files({}), {}, { ...people, moved: { moved: [], unknown: [] } }).run(new Date());
    expect(same.find((result) => result.subject === HUMAN_IDS_SUBJECT)).toMatchObject({ ok: true });
    const unasked = await check(files({}), {}, { ...people, moved: { moved: [], unknown: ['janedoe'] } }).run(new Date());
    expect(unasked.find((result) => result.subject === HUMAN_IDS_SUBJECT)).toMatchObject({ ok: null });
  });
});

describe('a Human review rule the bridge cannot read', () => {
  const reader = (agents: string): RepoConfigReader => ({
    repositories: async () => [REPO],
    files: async () => files({ 'AGENTS.md': agents }),
    humans: async () => [],
    exists: async () => null,
  });

  it('raises a blocking card naming the line and what is wrong with it', async () => {
    const agents = ['# Agent notes', '', '## Human review', '', '- `config/` @janedoe', '- `.github/` @exampleco/platform', ''].join('\n');
    const [result] = await repoConfigCheck(reader(agents), [humanReviewLinesInspection()]).run(new Date());
    expect(result).toMatchObject({
      ok: false,
      severity: 'blocking',
      action: { label: 'Open AGENTS.md on GitHub', url: 'https://github.com/exampleco/api/blob/main/AGENTS.md#L6' },
      facts: { findings: [{ kind: 'human-review-unreadable', file: 'AGENTS.md', line: 6 }] },
    });
    expect(result && 'title' in result ? result.title : '').toContain('cannot read on line 6');
    expect(result && 'detail' in result ? result.detail : '').toContain('is a team');
  });

  it('says nothing of a section it can read', async () => {
    const [result] = await repoConfigCheck(reader(AGENTS), [humanReviewLinesInspection()]).run(new Date());
    expect(result).toMatchObject({ ok: true });
  });
});
