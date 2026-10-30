import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceCode, UserToken } from '@openadlc/github';
import { PersonFlows, type PersonGitHubDeps } from './person-github.js';
import { isDeclaredCommand, PullCommands, PullRules, sentTarget, useDeclaredCommands, type PullCommandDeps, type PullReader, type SentRecord } from './pull-commands.js';

/**
 * A pull request's declared commands, posted from the console: exactly the
 * declared text, as the app for anyone's, and as the reviewer's own account,
 * from a sign-in held for one post, for a sign-off. Never a crew account, and
 * the reviewer's token is in nothing that is kept or said.
 */

const RULES = `
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

const HEAD = 'abc1234' + 'f'.repeat(33);
const NEWER = 'fed9876' + 'e'.repeat(33);
const REPO = { name: 'www', fullName: '620legal/www', defaultBranch: 'main' };
const TOKEN = 'ghu_SECRET_once';
const ORZELIG_ID = 4242;

interface Fake {
  file: string | null;
  head: string;
  comments: { id: number; user: { login: string }; body: string; body_html: string; html_url: string; created_at: string; updated_at: string; issue_url: string }[];
  visualReview: { status: string; conclusion: string | null; completed_at: string | null } | null;
}

function fakeReader(fake: Fake): PullReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readFileIfPresent: async () => fake.file,
    request: async <T,>(method: string, path: string): Promise<T> => {
      calls.push(`${method} ${path}`);
      if (/\/pulls\/46$/.test(path)) return { state: 'open', html_url: 'https://github.com/620legal/www/pull/46', head: { sha: fake.head } } as T;
      if (/\/commits\/[0-9a-f]+$/.test(path)) return { commit: { committer: { date: '2026-10-29T10:00:00Z' } } } as T;
      if (/\/status\?/.test(path)) return { statuses: [] } as T;
      if (/\/check-runs\?/.test(path)) return { check_runs: fake.visualReview ? [fake.visualReview] : [] } as T;
      if (/\/issues\/46\/comments\?/.test(path)) return fake.comments as T;
      const one = /\/issues\/comments\/(\d+)$/.exec(path);
      if (one) {
        const found = fake.comments.find((comment) => comment.id === Number(one[1]));
        if (found) return found as T;
      }
      if (/\/contents\//.test(path)) return { type: 'file', size: 12, encoding: 'base64', content: PNG.toString('base64') } as T;
      throw Object.assign(new Error(`not found: ${path}`), { status: 404 });
    },
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

const bot = 'github-actions[bot]';
const comment = (id: number, body: string, at = '2026-10-29T10:05:00Z', user = bot, bodyHtml = '') => ({
  id,
  user: { login: user },
  body,
  body_html: bodyHtml,
  html_url: `https://github.com/620legal/www/pull/46#issuecomment-${id}`,
  created_at: at,
  updated_at: at,
  issue_url: 'https://api.github.com/repos/620legal/www/issues/46',
});

function personDeps(overrides: Partial<PersonGitHubDeps> = {}): PersonGitHubDeps & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    revoked,
    clientId: async () => 'Iv1.client',
    clientSecret: async () => 'client-secret',
    requestCode: async (): Promise<DeviceCode> => ({ deviceCode: 'dev', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    pollToken: async (): Promise<UserToken> => ({ accessToken: TOKEN, expiresAt: null, refreshToken: null, refreshExpiresAt: null, scopes: [], tokenType: 'bearer' }),
    viewer: async () => ({ login: 'orzelig', id: ORZELIG_ID }),
    revoke: async ({ accessToken }) => (revoked.push(accessToken), true),
    isCrew: async (login) => login === 'fleet-atlas-orzelig',
    store: { link: vi.fn(), unlink: vi.fn(), ofIdentity: vi.fn() } as never,
    audit: async () => undefined,
    ...overrides,
  };
}

function setUp(input: { fake?: Partial<Fake>; linked?: Record<string, number>; person?: Partial<PersonGitHubDeps>; app?: boolean; sent?: SentRecord | null; now?: number } = {}) {
  const fake: Fake = { file: RULES, head: HEAD, comments: [], visualReview: { status: 'completed', conclusion: 'failure', completed_at: '2026-10-29T10:01:00Z' }, ...input.fake };
  const reader = fakeReader(fake);
  const person = personDeps(input.person);
  const flows = new PersonFlows(person);
  const appPosts: { method: string; path: string; body: unknown }[] = [];
  const personPosts: { token: string; repo: string; number: number; body: string }[] = [];
  const audits: { action: string; target: string; payload: Record<string, unknown> }[] = [];
  const linked = input.linked ?? {};
  const deps: PullCommandDeps = {
    reader: async () => reader,
    app: async () =>
      input.app === false
        ? null
        : {
            request: async <T,>(method: string, path: string, body?: unknown) => {
              appPosts.push({ method, path, body });
              return { id: 901, html_url: 'https://github.com/620legal/www/pull/46#issuecomment-901' } as T;
            },
          },
    flows,
    person: {
      isCrew: person.isCrew,
      store: {
        ofIdentity: async (identity: string) => (identity in linked ? { identity, githubLogin: 'someone', githubUserId: linked[identity]!, linkedAt: '' } : null),
        ofUserId: async (id: number) => (Object.values(linked).includes(id) ? { githubLogin: 'someone' } : null),
      },
    },
    userIdOf: async (login) => (login === 'orzelig' ? ORZELIG_ID : null),
    postAsPerson: async (token, repo, number, body) => {
      personPosts.push({ token, repo, number, body });
      return { id: 902, htmlUrl: 'https://github.com/620legal/www/pull/46#issuecomment-902' };
    },
    lastSent: async () => input.sent ?? null,
    audit: async (entry) => void audits.push(entry),
    ...(input.now ? { now: () => input.now! } : {}),
  };
  const commands = new PullCommands(deps, new PullRules(async () => reader));
  return { commands, fake, reader, person, flows, appPosts, personPosts, audits };
}

afterEach(() => {
  vi.restoreAllMocks();
  useDeclaredCommands(null);
});

describe('a repository that declares nothing', () => {
  it('shows no commands and no outputs, and reads nothing about the pull request', async () => {
    const { commands, reader } = setUp({ fake: { file: 'testing:\n  on: none\n' } });
    const view = await commands.read(REPO, 46, 'jane@example.com');
    expect(view.commands).toEqual([]);
    expect(view.outputs).toEqual([]);
    expect(reader.calls).toEqual([]);
  });
});

describe('a command anyone may send', () => {
  it('posts exactly its text, once, as the app, on the right pull request, and records it', async () => {
    const { commands, appPosts, personPosts, audits } = setUp();
    const sent = await commands.send({ repo: REPO, number: 46, name: 'preview', head: HEAD, identity: 'jane@example.com' });
    expect(sent).toEqual({ state: 'sent', commentUrl: 'https://github.com/620legal/www/pull/46#issuecomment-901' });
    expect(appPosts).toEqual([{ method: 'POST', path: '/repos/620legal/www/issues/46/comments', body: { body: '/preview' } }]);
    expect(personPosts).toEqual([]);
    expect(audits).toEqual([
      {
        actor: 'jane@example.com',
        action: 'pull.command_sent',
        target: sentTarget(REPO, 46, 'preview'),
        payload: expect.objectContaining({ repo: '620legal/www', pr: 46, command: 'preview', head: HEAD, as: 'app', commentId: 901 }),
      },
    ]);
  });

  it('posts nothing again while the same command on this head waits for its answer', async () => {
    const sent = { head: HEAD, commentUrl: null, at: '2026-10-29T10:10:00Z' };
    const waiting = setUp({ sent, now: Date.parse('2026-10-29T10:12:00Z') });
    await expect(waiting.commands.send({ repo: REPO, number: 46, name: 'preview', head: HEAD, identity: 'jane@example.com' })).rejects.toMatchObject({ status: 409 });
    expect(waiting.appPosts).toEqual([]);

    // Answered, quiet, or sent on another head: it may be sent again.
    const answered = setUp({ sent, now: Date.parse('2026-10-29T10:12:00Z'), fake: { comments: [comment(11, 'Preview of #46 at abc1234: https://review.example.test/46/', '2026-10-29T10:11:00Z')] } });
    const quiet = setUp({ sent, now: Date.parse('2026-10-29T10:45:00Z') });
    const elsewhere = setUp({ sent: { ...sent, head: NEWER }, now: Date.parse('2026-10-29T10:12:00Z') });
    for (const one of [answered, quiet, elsewhere]) {
      await one.commands.send({ repo: REPO, number: 46, name: 'preview', head: HEAD, identity: 'jane@example.com' });
      expect(one.appPosts).toHaveLength(1);
    }
  });

  it('posts nothing when it cannot read whether the command was already sent', async () => {
    // A failed read was taken as "never sent", and a second press posted again.
    const { commands, appPosts } = setUp();
    (commands as unknown as { deps: PullCommandDeps }).deps.lastSent = async () => Promise.reject(new Error('database is down'));
    await expect(commands.send({ repo: REPO, number: 46, name: 'preview', head: HEAD, identity: 'jane@example.com' })).rejects.toMatchObject({ status: 503 });
    expect(appPosts).toEqual([]);
  });

  it('posts nothing when the head moved since the person looked', async () => {
    const { commands, appPosts } = setUp({ fake: { head: NEWER } });
    await expect(commands.send({ repo: REPO, number: 46, name: 'preview', head: HEAD, identity: 'jane@example.com' })).rejects.toMatchObject({ status: 409 });
    expect(appPosts).toEqual([]);
  });

  it('says what to fix when the app cannot post there', async () => {
    const { commands } = setUp({ app: false });
    await expect(commands.send({ repo: REPO, number: 46, name: 'preview', head: HEAD, identity: 'jane@example.com' })).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(/Settings → GitHub App, or send \/preview on GitHub/),
    });
  });
});

describe('a command only a reviewer may send', () => {
  it('is not offered to a person with no link, or linked to another account, and is refused to them', async () => {
    for (const linked of [{}, { 'bob@example.com': 77 }] as Record<string, number>[]) {
      const { commands, personPosts, appPosts } = setUp({ linked });
      const view = await commands.read(REPO, 46, 'bob@example.com');
      const approve = view.commands.find((one) => one.name === 'approve-pages')!;
      expect(approve.offered).toBe(false);
      expect(approve.why).toMatch(/@orzelig's to send; nobody here has linked @orzelig's GitHub account\. Link it in Settings, or send \/approve-pages on GitHub\./);
      await expect(commands.send({ repo: REPO, number: 46, name: 'approve-pages', head: HEAD, identity: 'bob@example.com' })).rejects.toMatchObject({ status: 403 });
      expect([...personPosts, ...appPosts]).toEqual([]);
    }
  });

  it('looks the reviewer’s account up again after a lookup that failed', async () => {
    // A null from a missing client or a GitHub error was kept for the life of
    // the bridge, and the sign-off was offered to nobody until it restarted.
    const { commands } = setUp({ linked: { 'or@example.com': ORZELIG_ID } });
    const lookups = vi.fn<(login: string) => Promise<number | null>>().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('502')).mockResolvedValue(ORZELIG_ID);
    (commands as unknown as { deps: PullCommandDeps }).deps.userIdOf = lookups;
    const offered = async () => (await commands.read(REPO, 46, 'or@example.com')).commands.find((one) => one.name === 'approve-pages')!.offered;
    expect(await offered()).toBe(false);
    expect(await offered()).toBe(false);
    expect(await offered()).toBe(true);
    // Once GitHub has said it, it is not asked again.
    expect(await offered()).toBe(true);
    expect(lookups).toHaveBeenCalledTimes(3);
  });

  it('says it is linked to someone else when another person holds the reviewer’s account', async () => {
    const { commands } = setUp({ linked: { 'or@example.com': ORZELIG_ID } });
    const approve = (await commands.read(REPO, 46, 'bob@example.com')).commands.find((one) => one.name === 'approve-pages')!;
    expect(approve.why).toMatch(/linked to another person here/);
  });

  it('is offered to the person whose linked account is the reviewer, posted with the flow’s token, then revoked', async () => {
    const { commands, flows, person, personPosts, appPosts, audits } = setUp({ linked: { 'or@example.com': ORZELIG_ID } });
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    const approve = (await commands.read(REPO, 46, 'or@example.com')).commands.find((one) => one.name === 'approve-pages')!;
    expect(approve.offered).toBe(true);

    const started = await commands.send({ repo: REPO, number: 46, name: 'approve-pages', head: HEAD, identity: 'or@example.com' });
    expect(started).toEqual({ flow: expect.objectContaining({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' }) });
    await flows.lastRun;

    expect(personPosts).toEqual([{ token: TOKEN, repo: '620legal/www', number: 46, body: '/approve-pages' }]);
    expect(appPosts).toEqual([]);
    expect(person.revoked).toEqual([TOKEN]);
    const flowId = (started as { flow: { flowId: string } }).flow.flowId;
    // Only the person who started it reads how it went.
    expect(flows.state(flowId, 'bob@example.com')).toEqual({ state: 'none' });
    const done = flows.state(flowId, 'or@example.com');
    expect(done).toMatchObject({ state: 'done', result: { commentUrl: 'https://github.com/620legal/www/pull/46#issuecomment-902' } });

    // The token is in nothing kept or said.
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
    expect(JSON.stringify(started)).not.toContain(TOKEN);
    expect(JSON.stringify(done)).not.toContain(TOKEN);
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    expect(audits[0]!.payload).toMatchObject({ as: 'person', login: 'orzelig', command: 'approve-pages' });
  });

  it('posts nothing when another account, or a crew login, approves the code, and still revokes the token', async () => {
    for (const viewer of [{ login: 'mallory', id: 1 }, { login: 'fleet-atlas-orzelig', id: ORZELIG_ID }]) {
      const { commands, flows, person, personPosts } = setUp({ linked: { 'or@example.com': ORZELIG_ID }, person: { viewer: async () => viewer } });
      const started = (await commands.send({ repo: REPO, number: 46, name: 'approve-pages', head: HEAD, identity: 'or@example.com' })) as { flow: { flowId: string } };
      await flows.lastRun;
      expect(personPosts).toEqual([]);
      expect(person.revoked).toEqual([TOKEN]);
      expect(flows.state(started.flow.flowId, 'or@example.com')).toMatchObject({ state: 'failed', error: expect.stringMatching(/nothing was posted/) });
    }
  });

  it('starts no second sign-in while the person’s first for this command is still waiting', async () => {
    // The row is written only after the code is approved, so a press from the
    // card while the work item's sign-in waited started a second flow and
    // posted /approve-pages twice.
    let approve: (token: UserToken) => void = () => undefined;
    const requestCode = vi.fn(async (): Promise<DeviceCode> => ({ deviceCode: 'dev', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }));
    const { commands, flows, personPosts } = setUp({
      linked: { 'or@example.com': ORZELIG_ID },
      person: { requestCode, pollToken: () => new Promise<UserToken>((resolve) => (approve = resolve)) },
    });
    const press = () => commands.send({ repo: REPO, number: 46, name: 'approve-pages', head: HEAD, identity: 'or@example.com' });
    await press();
    await expect(press()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/still waiting for you/) });
    expect(requestCode).toHaveBeenCalledTimes(1);

    approve({ accessToken: TOKEN, expiresAt: null, refreshToken: null, refreshExpiresAt: null, scopes: [], tokenType: 'bearer' });
    await flows.lastRun;
    expect(personPosts).toHaveLength(1);
    // Once it has ended, the next press is the waiting-for-its-answer rule's to judge.
    await press();
    expect(requestCode).toHaveBeenCalledTimes(2);
  });

  it('says a failure without the token in it', async () => {
    const { commands, flows } = setUp({
      linked: { 'or@example.com': ORZELIG_ID },
      person: { viewer: async () => Promise.reject(new Error(`bad credentials for ${TOKEN}`)) },
    });
    const started = (await commands.send({ repo: REPO, number: 46, name: 'approve-pages', head: HEAD, identity: 'or@example.com' })) as { flow: { flowId: string } };
    await flows.lastRun;
    const failed = flows.state(started.flow.flowId, 'or@example.com');
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
    expect(failed).toMatchObject({ state: 'failed', error: 'bad credentials for [token]' });
  });
});

describe('what the workflows posted', () => {
  const preview = comment(11, 'Preview of #46 at abc1234: https://review.example.test/46/');
  const shots = comment(
    12,
    '<!-- visual-review -->\nScreenshots at abc1234',
    '2026-10-29T10:06:00Z',
    bot,
    '<p><img src="https://camo.githubusercontent.com/x" data-canonical-src="https://github.com/620legal/www/raw/abc1234/.visual/home.png" alt="home before"></p>',
  );

  it('reads the preview address and the screenshots for the current head', async () => {
    const { commands } = setUp({ fake: { comments: [preview, shots, comment(13, 'Preview of #46 at abc1234: https://evil.test/', '2026-10-29T11:00:00Z', 'mallory')] } });
    const view = await commands.read(REPO, 46, 'jane@example.com');
    expect(view.outputs).toEqual([
      { name: 'preview', kind: 'link', found: expect.objectContaining({ commentId: 11, url: 'https://review.example.test/46/', sha: 'abc1234', current: true }) },
      { name: 'screenshots', kind: 'images', found: expect.objectContaining({ commentId: 12, sha: 'abc1234', current: true, images: [{ index: 0, alt: 'home before' }] }) },
    ]);
  });

  it('marks both as older once the head has moved on', async () => {
    const { commands } = setUp({ fake: { head: NEWER, comments: [preview, shots] } });
    const view = await commands.read(REPO, 46, 'jane@example.com');
    expect(view.outputs.map((one) => one.found?.current)).toEqual([false, false]);
  });

  it('shows the head’s own output over a newer one for an older head', async () => {
    // A rerun of an old commit posts last, and taking the newest showed only
    // its preview, marked older, while the head's sat unshown.
    const rerun = comment(15, 'Preview of #46 at dead000: https://review.example.test/old/', '2026-10-29T12:00:00Z');
    const { commands } = setUp({ fake: { comments: [preview, rerun] } });
    const found = (await commands.read(REPO, 46, 'jane@example.com')).outputs.find((one) => one.name === 'preview')!.found;
    expect(found).toMatchObject({ commentId: 11, current: true });

    const onlyOlder = await setUp({ fake: { comments: [rerun] } }).commands.read(REPO, 46, 'jane@example.com');
    expect(onlyOlder.outputs.find((one) => one.name === 'preview')!.found).toMatchObject({ commentId: 15, current: false });
  });

  it('orders a red check’s command first, and says a sent command’s answer once it comes', async () => {
    const { commands } = setUp({
      fake: { comments: [comment(11, 'Preview of #46 at abc1234: https://review.example.test/46/', '2026-10-29T10:20:00Z')] },
      sent: { head: HEAD, commentUrl: 'https://github.com/x', at: '2026-10-29T10:10:00Z' },
      now: Date.parse('2026-10-29T10:21:00Z'),
    });
    const view = await commands.read(REPO, 46, 'jane@example.com');
    expect(view.commands.map((one) => one.name)).toEqual(['approve-pages', 'preview']);
    expect(view.checks).toEqual({ 'visual-review': 'failure' });
    expect(view.commands.find((one) => one.name === 'preview')).toMatchObject({ state: 'answered', answer: 'Preview at https://review.example.test/46/' });
  });

  it('is sent until answered, and quiet after half an hour with no answer', async () => {
    const sent = { head: HEAD, commentUrl: null, at: '2026-10-29T10:10:00Z' };
    const soon = await setUp({ sent, now: Date.parse('2026-10-29T10:15:00Z') }).commands.read(REPO, 46, 'jane@example.com');
    expect(soon.commands.find((one) => one.name === 'preview')!.state).toBe('sent');
    const later = await setUp({ sent, now: Date.parse('2026-10-29T10:41:00Z') }).commands.read(REPO, 46, 'jane@example.com');
    expect(later.commands.find((one) => one.name === 'preview')!.state).toBe('quiet');
  });

  it('serves an image from a declared screenshots comment through the contents API, and refuses any other comment', async () => {
    const { commands, reader } = setUp({ fake: { comments: [preview, shots] } });
    const image = await commands.image(REPO, 46, 12, 0);
    expect(image.mediaType).toBe('image/png');
    expect(image.bytes.equals(PNG)).toBe(true);
    expect(reader.calls).toContain('GET /repos/620legal/www/contents/.visual/home.png?ref=abc1234');
    await expect(commands.image(REPO, 46, 11, 0)).rejects.toMatchObject({ status: 404 });
    await expect(commands.image(REPO, 46, 12, 5)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an image in a comment on another pull request', async () => {
    const elsewhere = { ...shots, id: 14, issue_url: 'https://api.github.com/repos/620legal/www/issues/47' };
    const { commands } = setUp({ fake: { comments: [elsewhere] } });
    await expect(commands.image(REPO, 46, 14, 0)).rejects.toMatchObject({ status: 404 });
  });
});

describe('a comment that is a declared command', () => {
  it('is recognised exactly, once the rules are known', async () => {
    const { commands } = setUp();
    expect(await isDeclaredCommand(REPO, '/approve-pages')).toBe(false);
    useDeclaredCommands(commands.rules);
    expect(await isDeclaredCommand(REPO, ' /approve-pages\n')).toBe(true);
    expect(await isDeclaredCommand(REPO, '/approve-pages please')).toBe(false);
    expect(await isDeclaredCommand(REPO, 'lgtm')).toBe(false);
  });
});
