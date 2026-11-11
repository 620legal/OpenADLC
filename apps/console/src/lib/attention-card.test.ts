import { describe, expect, it } from 'vitest';
import type { AttentionItem } from './api';
import {
  alarming,
  audienceLine,
  clockTime,
  decisionButtons,
  faceActions,
  groupCounts,
  groupOf,
  hasMore,
  heldMergeButtons,
  noMergeReason,
  plainDetail,
  rejectReady,
  remindAgainLine,
  remindedLine,
  remindLabel,
  requestLine,
  reviewerName,
  reviewVerdict,
  unblockedOf,
  unblocksLine,
} from './attention-card';

const ITEM: AttentionItem = {
  id: 'task:t-1',
  kind: 'task_failed',
  headline: 'The builder (janedoe-builds) could not finish the change',
  subject: { repo: 'api', number: 16, title: 'Let the board filter by label', ref: 'api#16', url: null },
  bot: null,
  since: '2026-09-29T10:00:00.000Z',
  detail: 'Engine claude is not available on this host.',
  actions: [{ kind: 'retry_task', label: 'Try again', taskId: 't-1' }],
};

describe('whom a Needs-you card says it is for', () => {
  it('names its role, the approvers, the admins or you, and says why it is everyone’s', () => {
    expect(audienceLine({ audience: { for: 'role', name: 'Legal', people: ['p-a'] } })).toBe('For Legal');
    expect(audienceLine({ audience: { for: 'approvers', name: 'approvers', people: ['p-a'] } })).toBe('For approvers');
    expect(audienceLine({ audience: { for: 'admins', name: 'admins', people: ['p-a'] } })).toBe('For admins');
    expect(audienceLine({ audience: { for: 'person', name: 'Alice', people: ['p-a'] } })).toBe('For you');
    expect(audienceLine({ audience: { for: 'everyone', name: 'everyone', people: [], why: 'the question names no role' } })).toBe(
      'For everyone: the question names no role',
    );
    expect(audienceLine({})).toBeNull();
  });

  it('says why a held approval came to the approvers, or to everyone, when People has no one by its login', () => {
    expect(audienceLine({ audience: { for: 'approvers', name: 'approvers', people: ['p-a'], notInPeople: 'Dana' } })).toBe('@Dana is not in People, so this came to the approvers.');
    expect(audienceLine({ audience: { for: 'everyone', name: 'everyone', people: [], why: 'no one approves yet', notInPeople: 'Dana' } })).toBe(
      '@Dana is not in People and no one approves yet, so this is for everyone.',
    );
  });
});

describe('what a held approval’s card says about GitHub’s request and Remind', () => {
  const NOW = Date.parse('2026-11-11T04:00:00.000Z');
  const HOUR = 60 * 60_000;

  it('says whether GitHub asked the person, and since when', () => {
    expect(requestLine({ login: 'Dana', request: { state: 'requested', since: new Date(NOW - 3 * HOUR).toISOString() } }, NOW)).toBe('GitHub asked @Dana to review 3 h ago.');
    expect(requestLine({ login: 'Dana', request: { state: 'requested', since: null } }, NOW)).toBe('GitHub has asked @Dana to review.');
    expect(requestLine({ login: 'Dana', request: { state: 'none' } }, NOW)).toBe('GitHub has no review request out to @Dana.');
    expect(requestLine({ login: 'Dana', request: { state: 'unknown', why: 'the pull request’s timeline is too long to read' } }, NOW)).toBe(
      'OpenADLC could not read whether GitHub asked @Dana: the pull request’s timeline is too long to read.',
    );
  });

  it('says who reminded them and when, and when Remind can be pressed again', () => {
    expect(remindedLine({ reminded: { at: new Date(NOW - 5 * 60_000).toISOString(), by: 'Ana' } }, NOW)).toBe('Reminded 5 min ago by Ana.');
    expect(remindedLine({ reminded: { at: new Date(NOW - 10_000).toISOString(), by: 'Ana' } }, NOW)).toBe('Reminded just now by Ana.');
    expect(remindedLine({ reminded: null }, NOW)).toBeNull();
    expect(remindLabel('Dana')).toBe('Remind @Dana');
    const after = NOW + 40 * 60_000;
    expect(remindAgainLine(new Date(after).toISOString(), NOW)).toBe(`You can remind them again at ${clockTime(after)}, in 40 min.`);
    expect(remindAgainLine(new Date(NOW - 1).toISOString(), NOW)).toBeNull();
    expect(remindAgainLine(null, NOW)).toBeNull();
  });
});

describe('a Needs-you card’s face', () => {
  it('says the detail without its markdown, so two lines cut a sentence', () => {
    expect(plainDetail('**Fix it.**\n\n1. Open [the page](https://example.com).\n2. Run `make ci`.')).toBe(
      'Fix it. Open the page. Run make ci.',
    );
  });

  it('offers the first action, and none for a question answered by its choices', () => {
    expect(faceActions(ITEM)[0]).toEqual({ kind: 'retry_task', label: 'Try again', taskId: 't-1' });
    expect(
      faceActions({ ...ITEM, kind: 'question', question: { gateId: 'g', options: ['yes', 'no'] }, actions: [{ kind: 'answer', label: 'Something else…', bot: 'b' }] }),
    ).toEqual([]);
  });

  it('has nothing more when its face is all of it', () => {
    expect(hasMore(ITEM)).toBe(false);
  });

  it('has more for a long detail, the raw reason, members, other buttons, or choices past three', () => {
    expect(hasMore({ ...ITEM, detail: 'x '.repeat(100) })).toBe(true);
    expect(hasMore({ ...ITEM, raw: 'hostd refused: 500' })).toBe(true);
    expect(hasMore({ ...ITEM, members: [{ ...ITEM, id: 'a' } as never, { ...ITEM, id: 'b' } as never] })).toBe(true);
    expect(hasMore({ ...ITEM, actions: [...ITEM.actions, { kind: 'stop_task', label: 'Stop', taskId: 't-1' }] })).toBe(true);
    const question = { ...ITEM, kind: 'question' as const, actions: [{ kind: 'answer' as const, label: 'Something else…', bot: 'b' }] };
    expect(hasMore({ ...question, question: { gateId: 'g', options: ['a', 'b', 'c'] } })).toBe(false);
    expect(hasMore({ ...question, question: { gateId: 'g', options: ['a', 'b', 'c', 'd'] } })).toBe(true);
  });
});

describe('a promote held for a person', () => {
  it('has both its choices on the card', () => {
    const held = {
      id: 'promote:app@abc1234',
      kind: 'promote_held' as const,
      headline: 'app@abc1234 waits for you to release it to production',
      subject: { repo: 'app', number: null, title: null, ref: null, url: null },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: 'Held.',
      actions: [
        { kind: 'promote_release' as const, label: 'Release to production', repo: 'app', sha: 'abc1234' },
        { kind: 'promote_automatic' as const, label: 'Switch to automatic delivery', repo: 'app', sha: 'abc1234' },
      ],
    };
    expect(faceActions(held).map((action) => action.label)).toEqual(['Release to production', 'Switch to automatic delivery']);
    expect(groupOf(held)).toBe('work');
  });

  it('keeps Keep holding and Discuss off the face, for its decision to draw', () => {
    const held = {
      id: 'promote:app@abc1234',
      kind: 'promote_held' as const,
      headline: 'Release app@abc1234 to production?',
      subject: { repo: 'app', number: null, title: null, ref: null, url: null },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: 'Held.',
      actions: [
        { kind: 'promote_release' as const, label: 'Release', repo: 'app', sha: 'abc1234' },
        { kind: 'promote_keep_holding' as const, label: 'Keep holding', repo: 'app', sha: 'abc1234' },
        { kind: 'promote_discuss' as const, label: 'Discuss', repo: 'app', sha: 'abc1234', subject: 'app#40' },
        { kind: 'promote_automatic' as const, label: 'Switch to automatic delivery', repo: 'app', sha: 'abc1234' },
      ],
    };
    expect(faceActions(held).map((action) => action.label)).toEqual(['Release', 'Switch to automatic delivery']);
  });
});

describe('a held merge', () => {
  const HEAD = '692cd1f88f3e45093ad9ba4e68e84d590af3b595';
  const next = { merge: 'Merges it.', leave: 'Leaves it.', discuss: 'Discusses it.' };
  const held = (merge: { merge: true } | { merge: false; why: string }, yours?: boolean, whyNot?: string): AttentionItem => ({
    id: 'merge:www#46',
    kind: 'merge_waiting',
    headline: 'Pull request #46 is held for a person: merge it, leave it, or discuss it',
    subject: { repo: 'www', number: 46, title: null, ref: 'www#46', url: null },
    bot: null,
    since: '2026-09-24T11:59:00.000Z',
    detail: 'Held.',
    actions: [
      ...(merge.merge ? [{ kind: 'held_merge_merge' as const, label: 'Merge', subject: 'www#46', head: HEAD }] : []),
      { kind: 'held_merge_leave', label: 'Leave it', subject: 'www#46', head: HEAD },
      { kind: 'held_merge_discuss', label: 'Discuss', subject: 'www#46', head: HEAD },
      { kind: 'open_url', label: 'Open on GitHub', url: 'https://github.com/620legal/www/pull/46' },
    ],
    heldMerge: { repo: 'www', pr: 46, head: HEAD, why: 'Held.', merge, next, prUrl: null, ...(yours !== undefined ? { yours } : {}), ...(whyNot ? { whyNot } : {}) },
  });

  it('offers Merge only where the bridge offers it and says the viewer may press it', () => {
    expect(heldMergeButtons(held({ merge: true }, true))).toEqual(['merge', 'leave', 'discuss']);
    expect(heldMergeButtons(held({ merge: true }, false, '@sam cannot merge in 620legal/www (GitHub says read).'))).toEqual(['leave', 'discuss']);
    expect(heldMergeButtons(held({ merge: true }))).toEqual(['leave', 'discuss']);
    expect(heldMergeButtons(held({ merge: false, why: 'There is no Merge: a required check has not passed on this head.' }, true))).toEqual(['leave', 'discuss']);
  });

  it('says why there is no Merge: the hold’s reason first, then the viewer’s', () => {
    expect(noMergeReason(held({ merge: true }, true).heldMerge!)).toBeNull();
    expect(noMergeReason(held({ merge: false, why: 'There is no Merge: a required check has not passed on this head.' }, false, 'nope').heldMerge!)).toBe(
      'There is no Merge: a required check has not passed on this head.',
    );
    expect(noMergeReason(held({ merge: true }, false, '@sam cannot merge in 620legal/www (GitHub says read).').heldMerge!)).toContain('GitHub says read');
  });

  it('keeps only Open on GitHub on the face, for its decision to draw the rest', () => {
    expect(faceActions(held({ merge: true }, true)).map((action) => action.label)).toEqual(['Open on GitHub']);
    expect(hasMore(held({ merge: true }, true))).toBe(false);
  });
});

describe('an approved plan change waiting on another lease', () => {
  const waiting: AttentionItem = {
    id: 'plan-change:gate-1',
    kind: 'plan_change_waiting',
    headline: 'The builder (janedoe-builds) waits for #71 to let go of the approved paths',
    subject: { repo: 'api', number: 27, title: 'Show work items', ref: 'api#27', url: null },
    bot: null,
    since: '2026-10-22T16:24:00.000Z',
    detail: 'janedoe approved adding `packages/db/src/store/work-items.ts`.',
    actions: [
      { kind: 'answer_gate', label: 'Refuse', gateId: 'gate-1', answer: 'Refuse' },
      { kind: 'open_url', label: 'Open pull request #72', url: 'https://github.com/acme/api/pull/72' },
      { kind: 'open_thread', label: 'Open thread', bot: 'janedoe-builds' },
    ],
  };

  it('never has Refuse on its face, wherever the bridge puts it, and keeps it behind Show more', () => {
    // Approved three times on 2026-10-22 from a card that still offered the
    // choices: the face has what it waits on, and nothing that answers it.
    expect(faceActions(waiting)).toEqual([{ kind: 'open_url', label: 'Open pull request #72', url: 'https://github.com/acme/api/pull/72' }]);
    expect(hasMore(waiting)).toBe(true);
  });

  it('is work, and not an alarm', () => {
    expect(groupOf(waiting)).toBe('work');
    expect(groupOf({ kind: 'plan_change_waiting' })).toBe('work');
    expect(alarming(waiting)).toBe(false);
  });
});

describe('a blocked issue waiting on one closed without merging', () => {
  it('has both ways to settle it on the card, and is work', () => {
    const waiting: AttentionItem = {
      id: 'dependency-abandoned:api#20',
      kind: 'dependency_abandoned',
      headline: '#20 waits on #11, which was closed without merging',
      subject: { repo: 'api', number: 20, title: 'Show the limit on the card', ref: 'api#20', url: 'https://github.com/acme/api/issues/20' },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: 'Drop or change #11 in its Dependencies, or reopen #11.',
      actions: [
        { kind: 'open_url', label: 'Edit #20', url: 'https://github.com/acme/api/issues/20' },
        { kind: 'open_url', label: 'Reopen #11', url: 'https://github.com/acme/api/issues/11' },
      ],
    };
    expect(faceActions(waiting).map((action) => action.label)).toEqual(['Edit #20', 'Reopen #11']);
    expect(hasMore(waiting)).toBe(false);
    expect(groupOf(waiting)).toBe('work');
    // From a bridge that sends no group, by its kind.
    expect(groupOf({ kind: 'dependency_abandoned' })).toBe('work');
  });
});

// A week of these was counted in the header's badge as work waiting on a
// person, with nothing for anyone to do about them.
describe('a design memory supersede', () => {
  const SUPERSEDED: AttentionItem = {
    id: 'design-memory:api#12:2026-09-24T10:30:00.000Z',
    kind: 'design_memory_superseded',
    headline: 'The design memory of api changed',
    subject: { repo: 'api', number: 12, title: 'Cost per round', ref: 'api#12', url: null },
    bot: null,
    since: '2026-09-24T10:30:00.000Z',
    detail: '“B” was replaced by “C”, unopposed at the move to build. Nothing waits on this; revert it in Settings if it is wrong.',
    actions: [
      { kind: 'open_url', label: 'On GitHub', url: 'https://github.com/acme/api/issues/12#issuecomment-9' },
      { kind: 'dismiss_notice', label: 'Dismiss', notice: 'design-memory:api#12', repo: 'api', issue: 12, occurrence: '2026-09-24T10:30:00.000Z' },
      { kind: 'open_page', label: 'Design memory', href: '/settings/repositories/api#api-memory' },
    ],
  };

  it('is a system notice, from a bridge that sends no group too, and is not counted as work', () => {
    expect(groupOf(SUPERSEDED)).toBe('system');
    expect(groupOf({ ...SUPERSEDED, group: 'system' })).toBe('system');
    expect(groupCounts([SUPERSEDED, ITEM])).toEqual({ work: 1, system: 1 });
  });

  it('offers its Dismiss on the face, beside the link to its comment', () => {
    expect(faceActions(SUPERSEDED).map((action) => action.kind)).toEqual(['dismiss_notice', 'open_url']);
  });
});

describe('a signing key OpenADLC did not register', () => {
  const card = {
    ...ITEM,
    id: 'check:signing-key:account:openadlc-vega-janedoe',
    kind: 'check_failed' as const,
    actions: [
      { kind: 'signing_key_revoke' as const, label: 'Revoke key 6', login: 'openadlc-vega-janedoe', keyId: 6, title: 'laptop' },
      { kind: 'signing_key_dismiss' as const, label: 'Key 6 is used elsewhere', login: 'openadlc-vega-janedoe', keyId: 6, title: 'laptop' },
      { kind: 'signing_key_revoke' as const, label: 'Revoke key 8', login: 'openadlc-vega-janedoe', keyId: 8, title: null },
      { kind: 'signing_key_dismiss' as const, label: 'Key 8 is used elsewhere', login: 'openadlc-vega-janedoe', keyId: 8, title: null },
      { kind: 'signing_key_undo' as const, label: 'Count key 4 again', login: 'openadlc-vega-janedoe', keyId: 4, title: null },
      { kind: 'open_url' as const, label: 'Open the account’s keys', url: 'https://github.com/settings/keys' },
      { kind: 'recheck' as const, label: 'Check again', checkId: 'signing-key' },
    ],
  };

  it('has the first key’s Revoke and Dismiss on the card, and the rest behind Show more', () => {
    expect(faceActions(card).map((action) => action.label)).toEqual(['Revoke key 6', 'Key 6 is used elsewhere']);
    expect(hasMore(card)).toBe(true);
  });

  it('leads with Dismiss where the check offered no Revoke', () => {
    const blocked = { ...card, actions: card.actions.filter((action) => action.kind !== 'signing_key_revoke') };
    expect(faceActions(blocked).map((action) => action.label)).toEqual(['Key 6 is used elsewhere']);
  });
});

describe('an unsigned post’s card', () => {
  const unsigned: AttentionItem = {
    ...ITEM,
    kind: 'check_failed',
    actions: [
      { kind: 'open_url', label: 'Open the post', url: 'https://github.com/exampleco/api/pull/31#pullrequestreview-77' },
      { kind: 'acknowledge', label: 'This was me', checkId: 'unattributed-post', occurrence: 'post:77' },
      { kind: 'incident', label: 'What to do' },
    ],
    incident: {
      repo: 'exampleco/api',
      login: 'janedoe-reviews',
      seat: null,
      did: 'review',
      postUrl: null,
      target: null,
      counted: true,
      mode: 'audit',
    },
  };

  it('offers This was me, the post and What to do, in that order', () => {
    expect(faceActions(unsigned).map((action) => action.label)).toEqual(['This was me', 'Open the post', 'What to do']);
  });

  it('always has more: its steps', () => {
    expect(hasMore({ ...unsigned, detail: 'Short.' })).toBe(true);
  });
});

describe('the card for a post OpenADLC refused to sign', () => {
  // The bridge offers no acknowledge on it (`dismissable: false`): it is
  // OpenADLC's gap, not the account's, so nobody says it was them.
  const refused: AttentionItem = {
    ...ITEM,
    kind: 'check_failed',
    actions: [
      { kind: 'open_url', label: 'Open the post', url: 'https://github.com/exampleco/www/pull/12#issuecomment-5' },
      { kind: 'incident', label: 'What to do' },
    ],
    incident: {
      repo: 'exampleco/www',
      login: 'janedoe-ship',
      seat: 'ship',
      did: 'comment',
      postUrl: 'https://github.com/exampleco/www/pull/12#issuecomment-5',
      target: { kind: 'pr', number: 12, url: 'https://github.com/exampleco/www/pull/12' },
      counted: true,
      mode: 'audit',
      refusal: { reason: 'a task on www@20b84446 may sign a post only on its own issue or pull request, not #12', seat: 'ship', taskId: 'task-1', status: 403 },
    },
  };

  it('offers the post and What to do, and no Dismiss or This was me', () => {
    const labels = faceActions(refused).map((action) => action.label);
    expect(labels).toEqual(['Open the post', 'What to do']);
    expect(faceActions(refused).some((action) => action.kind === 'acknowledge')).toBe(false);
  });
});

describe('a detail built to be slow', () => {
  it('reads eighty thousand characters of brackets and line breaks at once', () => {
    const started = performance.now();
    plainDetail('[\n'.repeat(40_000));
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('a builder asking for more paths (#77)', () => {
  const asking: AttentionItem = {
    ...ITEM,
    id: 'gate:g-1',
    kind: 'question',
    headline: 'The builder (janedoe-builds) has a question',
    detail: 'Add `apps/hostd/src/x.ts` to this issue’s Expected paths?',
    question: { gateId: 'g-1', options: ['Approve', 'Refuse'] },
    actions: [
      { kind: 'approve_all', label: 'Approve, and any more paths for #16', gateId: 'g-1' },
      { kind: 'ask_designer', label: 'Ask the designer', gateId: 'g-1' },
      { kind: 'answer', label: 'Something else…', bot: 'janedoe-builds' },
      { kind: 'stop_task', label: 'Stop', taskId: 't-1' },
      { kind: 'approve_all_off', label: 'Turn off approve all for #16', subject: 'api#16' },
    ],
  };

  it('offers approve all and the designer on its face, beside Approve and Refuse', () => {
    expect(faceActions(asking).map((action) => action.label)).toEqual(['Approve, and any more paths for #16', 'Ask the designer']);
  });

  it('keeps turning approve all off, and stopping, in its sheet', () => {
    expect(hasMore(asking)).toBe(true);
    expect(faceActions(asking).map((action) => action.kind)).not.toContain('approve_all_off');
  });
});

describe('what an item unblocks', () => {
  const behind = (repo: string, number: number) => ({ ref: `${repo}#${number}`, repo, number, title: `Issue ${number}` });

  it('names the cards waiting behind it, in the order the bridge gave', () => {
    const root = { ...ITEM, unblocks: { count: 4, items: [behind('api', 207), behind('api', 217), behind('api', 216), behind('api', 214)] } };
    expect(unblocksLine(root)).toBe('4 items wait on this: #207, #217, #216, #214.');
    expect(unblockedOf(root)?.items[0]).toEqual({ ref: 'api#207', label: '#207', title: 'Issue 207' });
  });

  it('says one, and one in another repository by its repository', () => {
    expect(unblocksLine({ ...ITEM, unblocks: { count: 1, items: [behind('web', 3)] } })).toBe('1 item waits on this: web#3.');
  });

  it('says nothing when nothing waits behind it, or the bridge is older', () => {
    expect(unblocksLine(ITEM)).toBeNull();
    expect(unblocksLine({ ...ITEM, unblocks: { count: 0, items: [] } })).toBeNull();
  });
});

describe('a held Human-review approval’s card', () => {
  const HEAD = '692cd1f88f3e45093ad9ba4e68e84d590af3b595';
  const HELD: AttentionItem = {
    ...ITEM,
    id: 'approval:api#40@janedoe',
    kind: 'merge_waiting',
    detail: 'The lead approved 692cd1f.',
    actions: [
      { kind: 'human_review_approve', label: 'Approve', subject: 'api#40', login: 'janedoe', head: HEAD },
      { kind: 'human_review_reject', label: 'Reject', subject: 'api#40', login: 'janedoe', head: HEAD },
      { kind: 'human_review_discuss', label: 'Discuss', subject: 'api#40', login: 'janedoe', head: HEAD },
      { kind: 'open_url', label: 'Review it on GitHub', url: 'https://github.com/acme/api/pull/40/files' },
    ],
    decision: {
      repo: 'api',
      pr: 40,
      head: HEAD,
      login: 'janedoe',
      change: null,
      why: 'Because.',
      reviews: null,
      prUrl: 'https://github.com/acme/api/pull/40',
      diffUrl: 'https://github.com/acme/api/pull/40/files',
      next: { approve: 'a', reject: 'r', discuss: 'd' },
    },
  };

  it('gives the person it waits on Approve, Reject and Discuss, and anyone else Discuss alone', () => {
    expect(decisionButtons({ ...HELD, decision: { ...HELD.decision!, yours: true } })).toEqual(['approve', 'reject', 'discuss']);
    expect(decisionButtons({ ...HELD, decision: { ...HELD.decision!, yours: false } })).toEqual(['discuss']);
    // A bridge that does not say whose it is: not yours.
    expect(decisionButtons(HELD)).toEqual(['discuss']);
    expect(decisionButtons(ITEM)).toEqual([]);
  });

  it('keeps its decision buttons off the face row, and counts no Show more for them', () => {
    expect(faceActions(HELD).map((action) => action.kind)).toEqual(['open_url']);
    expect(hasMore(HELD)).toBe(false);
  });

  it('has a Show more for its reviews, which only the sheet shows whole (#305)', () => {
    const review = { login: 'reviewer-bot', seat: 'lead-reviewer', state: 'approved', summary: 'The limit is per client.', url: 'https://github.com/acme/api/pull/40#r-1' };
    expect(hasMore({ ...HELD, decision: { ...HELD.decision!, reviews: [review] } })).toBe(true);
    // A review with nothing to read in full adds no Show more.
    expect(hasMore({ ...HELD, decision: { ...HELD.decision!, reviews: [{ ...review, summary: '' }] } })).toBe(false);
    expect(hasMore({ ...HELD, decision: { ...HELD.decision!, reviews: [] } })).toBe(false);
  });

  it('sends a Reject only with a reason', () => {
    expect(rejectReady('')).toBe(false);
    expect(rejectReady('  \n ')).toBe(false);
    expect(rejectReady('Keep the old timeout.')).toBe(true);
  });

  it('names a review by its seat, else its account, with its verdict in words', () => {
    expect(reviewerName({ login: 'reviewer-bot', seat: 'lead-reviewer' })).toBe('lead-reviewer');
    expect(reviewerName({ login: 'reviewer-bot', seat: null })).toBe('@reviewer-bot');
    expect(reviewVerdict('approved')).toBe('approved');
    expect(reviewVerdict('changes_requested')).toBe('asked for changes');
    expect(reviewVerdict('commented')).toBe('commented');
  });
});
