import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query, queryOne } from '../client.js';
import {
  approvalsIn,
  askedIn,
  dbNow,
  handsOffAuditIn,
  heldAuditIn,
  heldLineIn,
  liveTasks,
  mergedIn,
  pullsOpenedIn,
  releasesPublishedIn,
  startedIn,
} from './board-events.js';

const since = new Date('2026-11-02T00:00:00Z');
const until = new Date('2026-11-03T00:00:00Z');
const sql = (): string => String(vi.mocked(query).mock.calls[0]![0]);
const params = (): unknown[] => vi.mocked(query).mock.calls[0]![1] as unknown[];

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

/** Every windowed read: newest first, to the millisecond, with the tie rule. */
function expectWindowed(column: string): void {
  // `from` inclusive, `to` inclusive at the millisecond a cursor carries.
  expect(sql()).toContain(`${column} >= $1`);
  expect(sql()).toContain(`($2::timestamptz is null or date_trunc('milliseconds', ${column}) <= $2)`);
  // At most `limit` rows and every row tied at the last one's time.
  expect(sql()).toMatch(/rank\(\) over \(order by date_trunc\('milliseconds', x\.at\) desc\)/);
  expect(sql()).toMatch(/\$3::int is null or y\.event_rank <= \$3/);
  expect(sql()).toMatch(/order by date_trunc\('milliseconds', y\.at\) desc, y\.id desc/);
}

describe('the board feed’s reads', () => {
  it('takes now from the database, whose clock every window is compared with', async () => {
    vi.mocked(queryOne).mockResolvedValue({ now: since });
    expect(await dbNow()).toEqual(since);
    expect(String(vi.mocked(queryOne).mock.calls[0]![0])).toMatch(/select now\(\)/);
  });

  it('passes the window as from, to and limit, and leaves to and limit open for the live feed', async () => {
    vi.mocked(query).mockResolvedValue([]);
    await startedIn({ from: since, to: until, limit: 100 });
    expect(params()).toEqual([since, until, 100]);
    vi.mocked(query).mockReset().mockResolvedValue([]);
    await startedIn({ from: since });
    expect(params()).toEqual([since, null, null]);
  });

  it('reads tasks started in the window, with the seat’s name', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 't1', at: since, bot: 'builder', subject_ref: 'OpenADLC#227', kind: 'implement', skill: 'implement' }]);
    expect(await startedIn({ from: since })).toEqual([{ taskId: 't1', at: since.toISOString(), bot: 'builder', subjectRef: 'OpenADLC#227', kind: 'implement', skill: 'implement' }]);
    expect(sql()).toMatch(/t\.started_at as at/);
    expectWindowed('t.started_at');
  });

  it('reads questions asked in the window, with their choices, about their task’s subject or else their thread’s', async () => {
    vi.mocked(query).mockResolvedValue([
      { id: 'g1', at: since, bot: 'system-engineer', subject_ref: 'OpenADLC#227', question: 'Which?', options: ['a', 'b'] },
      { id: 'g2', at: since, bot: null, subject_ref: null, question: 'Open?', options: null },
    ]);
    expect(await askedIn({ from: since })).toEqual([
      { gateId: 'g1', at: since.toISOString(), bot: 'system-engineer', subjectRef: 'OpenADLC#227', question: 'Which?', options: ['a', 'b'] },
      { gateId: 'g2', at: since.toISOString(), bot: null, subjectRef: null, question: 'Open?', options: [] },
    ]);
    expect(sql()).toMatch(/coalesce\(t\.subject_ref, h\.subject_ref\)/);
    expect(sql()).toMatch(/g\.options/);
    expectWindowed('g.created_at');
  });

  it('reads merges as forward moves into Merged, or into Done from anywhere but Merged', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'm1', at: since, repo_name: 'OpenADLC', issue_number: 227, pr_number: 231, actor: 'orzelig', bot: null }]);
    expect(await mergedIn({ from: since })).toEqual([{ moveId: 'm1', at: since.toISOString(), repoName: 'OpenADLC', issueNumber: 227, prNumber: 231, actor: 'orzelig', bot: null }]);
    // A Merged → Done move is the deploy, not a second merge.
    expect(sql()).toMatch(/m\.kind = 'forward'/);
    expect(sql()).toMatch(/m\.to_stage = 'merged' or \(m\.to_stage = 'done' and m\.from_stage is distinct from 'merged'\)/);
    // An abandon is a forward move into Done as well, and not a merge.
    expect(sql()).toMatch(/and coalesce\(m\.reason, ''\) not like 'Abandoned: %'/);
    // `moveClosedByMerge` records no number; the issue's is the fallback.
    expect(sql()).toMatch(/coalesce\(m\.pr_number, i\.pr_number\)/);
    expectWindowed('m.created_at');
  });

  it('reads the pull requests a person held', async () => {
    vi.mocked(query).mockResolvedValue([{ id: '42', at: since, actor: 'orzelig', target: '620legal/OpenADLC#231', why: 'an unsigned crew post' }]);
    expect(await heldAuditIn({ from: since })).toEqual([{ auditId: '42', at: since.toISOString(), actor: 'orzelig', target: '620legal/OpenADLC#231', why: 'an unsigned crew post' }]);
    expect(sql()).toMatch(/action = 'pull\.held'/);
    expectWindowed('at');
  });

  it('reads hands-off windows turned on and off, and the gates they answered, with each answer’s question', async () => {
    vi.mocked(query).mockResolvedValue([
      { id: '7', at: since, action: 'hands_off.on', actor: 'jane@example.com', repo: '620legal/OpenADLC', set_by_login: 'janedoe', duration: '8h', by: null, why: null, subject: null, question: null, answer: null },
      { id: '8', at: since, action: 'gate.answer', actor: 'jane@example.com', repo: null, set_by_login: 'janedoe', duration: null, by: null, why: null, subject: 'OpenADLC#383', question: 'Which?', answer: 'B' },
    ]);
    expect(await handsOffAuditIn({ from: since })).toEqual([
      { auditId: '7', at: since.toISOString(), action: 'hands_off.on', actor: 'jane@example.com', repo: '620legal/OpenADLC', setByLogin: 'janedoe', duration: '8h', by: null, why: null, subject: null, question: null, answer: null },
      { auditId: '8', at: since.toISOString(), action: 'gate.answer', actor: 'jane@example.com', repo: null, setByLogin: 'janedoe', duration: null, by: null, why: null, subject: 'OpenADLC#383', question: 'Which?', answer: 'B' },
    ]);
    expect(sql()).toMatch(/a\.action in \('hands_off\.on', 'hands_off\.off'\)/);
    expect(sql()).toMatch(/a\.action = 'gate\.answer' and a\.payload->>'channel' = 'hands_off'/);
    expect(sql()).toMatch(/left join gates g/);
    expectWindowed('a.at');
  });

  it('reads merge-line entries in merging, timed when their row last changed', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'e1', at: since, repo_name: 'OpenADLC', pr_number: 231, state: 'merging', detail: 'waiting' }]);
    expect(await heldLineIn({ from: since })).toEqual([{ id: 'e1', at: since.toISOString(), repoName: 'OpenADLC', prNumber: 231, state: 'merging', detail: 'waiting' }]);
    expect(sql()).toMatch(/m\.state = 'merging'/);
    expect(sql()).toMatch(/m\.updated_at as at/);
    expectWindowed('m.updated_at');
  });

  it('reads pull requests the crew opened from GitHub’s deliveries, taking only the fields the event needs', async () => {
    vi.mocked(query).mockResolvedValue([
      { id: '7', at: since, login: 'openadlc-builder', repo_name: 'OpenADLC', repo_full_name: '620legal/OpenADLC', pr_number: 412, head_ref: 'agent/builder/374-x', title: 'Add a bell', url: 'https://github.com/620legal/OpenADLC/pull/412' },
    ]);
    expect(await pullsOpenedIn({ from: since }, ['OpenADLC-Builder', 'openadlc-lead'])).toEqual([
      {
        eventId: '7',
        at: since.toISOString(),
        login: 'openadlc-builder',
        repoName: 'OpenADLC',
        repoFullName: '620legal/OpenADLC',
        prNumber: 412,
        headRef: 'agent/builder/374-x',
        title: 'Add a bell',
        url: 'https://github.com/620legal/OpenADLC/pull/412',
      },
    ]);
    // The crew's logins, compared as GitHub compares them, in SQL.
    expect(params()[3]).toEqual(['openadlc-builder', 'openadlc-lead']);
    expect(sql()).toMatch(/lower\(e\.payload->'pull_request'->'user'->>'login'\) = any\(\$4::text\[\]\)/);
    expect(sql()).toMatch(/e\.source = 'github' and e\.type = 'pull_request\.opened'/);
    // A managed repository's delivery holds the repository as an object; an unmanaged one's, its name alone.
    expect(sql()).toMatch(/r\.removed_at is null/);
    expect(sql()).toMatch(/jsonb_typeof\(e\.payload->'repository'\) = 'object'/);
    // Each pull request once, at its first delivery, and the window outside that.
    expect(sql()).toMatch(/select \* from \(select distinct on \(r\.full_name, \(e\.payload->'pull_request'->>'number'\)::int\)/);
    expect(sql()).toMatch(/\) d where d\.at >= \$1/);
    // Never the whole payload.
    expect(sql()).not.toMatch(/e\.payload(?!-)/);
    expectWindowed('d.at');
  });

  it('asks nothing when the crew has no account', async () => {
    expect(await pullsOpenedIn({ from: since }, [])).toEqual([]);
    expect(await approvalsIn({ from: since }, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads approving reviews by the crew, each review once', async () => {
    vi.mocked(query).mockResolvedValue([
      { id: '9001', at: since, login: 'openadlc-lead', body: 'LGTM\n<!-- openadlc-seat:lead-reviewer -->', repo_name: 'OpenADLC', repo_full_name: '620legal/OpenADLC', pr_number: 412, url: null },
    ]);
    expect(await approvalsIn({ from: since }, ['openadlc-lead'])).toEqual([
      { reviewId: '9001', at: since.toISOString(), login: 'openadlc-lead', body: 'LGTM\n<!-- openadlc-seat:lead-reviewer -->', repoName: 'OpenADLC', repoFullName: '620legal/OpenADLC', prNumber: 412, url: null },
    ]);
    expect(sql()).toMatch(/e\.type = 'pull_request_review\.submitted'/);
    expect(sql()).toMatch(/lower\(e\.payload->'review'->>'state'\) = 'approved'/);
    expect(sql()).toMatch(/lower\(e\.payload->'review'->'user'->>'login'\) = any\(\$4::text\[\]\)/);
    expect(sql()).toMatch(/distinct on \(e\.payload->'review'->>'id'\)/);
    expect(sql()).not.toMatch(/e\.payload(?!-)/);
    expectWindowed('d.at');
  });

  it('reads published releases at the time they were published', async () => {
    vi.mocked(query).mockResolvedValue([
      { id: 'run-1', at: since, repo_name: 'OpenADLC', repo_full_name: '620legal/OpenADLC', tag: 'v1.4.2', version: '1.4.2', release_url: 'https://github.com/620legal/OpenADLC/releases/tag/v1.4.2', requested_by_login: 'orzelig' },
    ]);
    expect(await releasesPublishedIn({ from: since })).toEqual([
      {
        runId: 'run-1',
        at: since.toISOString(),
        repoName: 'OpenADLC',
        repoFullName: '620legal/OpenADLC',
        tag: 'v1.4.2',
        version: '1.4.2',
        url: 'https://github.com/620legal/OpenADLC/releases/tag/v1.4.2',
        cutBy: 'orzelig',
      },
    ]);
    // Built, failed to publish or anything else is not a release published.
    expect(sql()).toMatch(/x\.state = 'published'/);
    expect(sql()).toMatch(/x\.published_at as at/);
    expectWindowed('x.published_at');
  });

  it('reads live tasks oldest first, each since it came into its state', async () => {
    vi.mocked(query).mockResolvedValue([
      { id: 't1', bot: 'builder', kind: 'implement', skill: 'implement', subject_ref: 'OpenADLC#227', state: 'running', since, cost_usd: '1.2000', cost_cap_usd: '15.0000' },
      { id: 't2', bot: 'builder', kind: 'implement', skill: null, subject_ref: 'OpenADLC#228', state: 'running', since: null, cost_usd: '0', cost_cap_usd: '15' },
    ]);
    const live = await liveTasks();
    expect(live[0]).toEqual({ id: 't1', bot: 'builder', kind: 'implement', skill: 'implement', subjectRef: 'OpenADLC#227', state: 'running', since: since.toISOString(), costUsd: 1.2, capUsd: 15 });
    expect(live[1]!.since).toBeNull();
    expect(sql()).toMatch(/t\.state in \('queued', 'running', 'paused'\)/);
    // runningSince's rule: the newest answer after its pause, once it paused.
    expect(sql()).toMatch(/g\.answered_at > t\.paused_at/);
    expect(sql()).toMatch(/when 'paused' then t\.paused_at/);
    expect(sql()).toMatch(/when 'queued' then t\.created_at/);
    expect(sql()).toMatch(/order by t\.created_at/);
  });
});
