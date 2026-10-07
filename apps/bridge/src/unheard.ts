import { listEventsOfType, recordEvent } from '@fleetadlc/db';

/**
 * What happened on GitHub that GitHub never told OpenADLC about.
 *
 * Whether GitHub is sending is not a setting anybody can read back. An app's
 * webhook has an **Active** switch, `PATCH /app/hook/config` cannot turn it
 * on, and `GET /app/hook/config` does not say whether it is. An app created
 * from the manifest before the install had an address is made with it off —
 * the manifest has nowhere to point it — and from then on the webhook looks
 * configured, the address and the secret are both right, and GitHub sends
 * nothing at all.
 *
 * What can be seen is the effect. Reconcile reads the repository every quarter
 * hour; when it finds something a delivery should have told OpenADLC about — an
 * issue in a stage the board never had, an issue or pull request opened with
 * nothing delivered since — it records it here. Beside GitHub's own list of
 * deliveries being empty, that is the difference between "nothing has
 * happened yet" and "GitHub is not sending".
 */
export const UNHEARD = 'webhook.unheard';

/**
 * How recent a finding has to be to count.
 *
 * GitHub lists an app's deliveries for three days. Something newer than two
 * days would still be in that list had GitHub sent it, so a list without any
 * means it did not — whereas an older finding may only have aged out of it.
 */
export const UNHEARD_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * How far this machine's clock may be from GitHub's before an opening and the
 * delivery that followed it are read the wrong way round. Generous, because
 * the cost of too little is telling somebody GitHub is silent when it is not.
 */
const CLOCK_SLACK_MS = 5 * 60 * 1000;

export interface Unheard {
  /** `fleetadlc-testbed#1`. */
  subject: string;
  /**
   * `imported`: in a stage, and not on the board until reconcile put it there.
   * `opened`: an issue or pull request opened with nothing delivered since.
   */
  what: 'imported' | 'opened';
  title: string;
  url: string | null;
  /** When it happened, by GitHub's clock. */
  happenedAt: string;
  /** When OpenADLC found out, by its own. */
  foundAt: string;
}

export type UnheardFinding = Omit<Unheard, 'foundAt'>;

/**
 * The issues and pull requests in a reading of a repository that were opened
 * recently and that nothing has been delivered since.
 *
 * `heardAt` is when the bridge last took a delivery from GitHub, or null for
 * never. An opening is also an `issues` or `pull_request` event, so on a
 * webhook that works a delivery follows it within seconds.
 */
export function openedUnheard(
  repoName: string,
  live: readonly { number: number; title: string; htmlUrl: string; createdAt?: string }[],
  heardAt: string | null,
  now: Date,
): UnheardFinding[] {
  const windowStart = now.getTime() - UNHEARD_WINDOW_MS;
  const heard = heardAt ? Date.parse(heardAt) : Number.NEGATIVE_INFINITY;

  return live.flatMap((item) => {
    const opened = Date.parse(item.createdAt ?? '');
    if (!Number.isFinite(opened) || opened < windowStart) return [];
    if (heard >= opened - CLOCK_SLACK_MS) return [];
    return [
      {
        subject: `${repoName}#${item.number}`,
        what: 'opened' as const,
        title: item.title,
        url: item.htmlUrl,
        happenedAt: new Date(opened).toISOString(),
      },
    ];
  });
}

function asUnheard(payload: unknown, foundAt: string): Unheard | null {
  if (!payload || typeof payload !== 'object') return null;
  const entry = payload as Record<string, unknown>;
  if (typeof entry.subject !== 'string' || typeof entry.happenedAt !== 'string') return null;
  if (entry.what !== 'imported' && entry.what !== 'opened') return null;
  return {
    subject: entry.subject,
    what: entry.what,
    title: typeof entry.title === 'string' ? entry.title : '',
    url: typeof entry.url === 'string' ? entry.url : null,
    happenedAt: entry.happenedAt,
    foundAt,
  };
}

/**
 * Records what is new among `found`, once each: a subject already recorded
 * within the window is not recorded again, so a reconcile every quarter hour
 * does not write the same finding ninety-six times a day.
 */
export async function recordUnheard(found: readonly UnheardFinding[], now = new Date()): Promise<number> {
  if (found.length === 0) return 0;

  const since = new Date(now.getTime() - UNHEARD_WINDOW_MS);
  const said = new Set(
    (await listEventsOfType(UNHEARD, since))
      .map((event) => asUnheard(event.payload, event.at)?.subject)
      .filter((subject): subject is string => Boolean(subject)),
  );

  let recorded = 0;
  for (const finding of found) {
    if (said.has(finding.subject)) continue;
    said.add(finding.subject);
    await recordEvent({ source: 'platform', type: UNHEARD, payload: finding });
    recorded += 1;
  }
  return recorded;
}

/** What has been found within the window, newest find first. */
export async function readUnheard(now = new Date()): Promise<Unheard[]> {
  const windowStart = now.getTime() - UNHEARD_WINDOW_MS;
  const events = await listEventsOfType(UNHEARD, new Date(windowStart));

  return events
    .map((event) => asUnheard(event.payload, event.at))
    .filter((entry): entry is Unheard => entry !== null && Date.parse(entry.happenedAt) >= windowStart);
}
