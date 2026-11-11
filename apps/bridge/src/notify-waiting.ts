import type { AttentionItem } from './attention.js';
import { mayNotify, routedPeople } from './needs-you-audience.js';
import { itemLink, type Notifier } from './notify.js';

/** The Needs-you kinds sent as they appear, each under the notification of the same name. */
export const WAITING_KINDS = ['merge_waiting', 'review_stalled'] as const;
type WaitingKind = (typeof WAITING_KINDS)[number];

export const WAITING_EVERY_MS = 60_000;

/** The `look` of the row an install's first look records, whose time is the baseline's. */
const FIRST_LOOK = 'first';

export interface WaitingNoticesDeps {
  notifier: Pick<Notifier, 'send' | 'store'>;
  /**
   * Needs you's items, read as `GET /v1/attention` reads them, so the ids are
   * the ones it shows, but for everyone: each with its audience
   * (`withAudiences`), and none left out for not being one viewer's.
   */
  items(): Promise<AttentionItem[]>;
  consoleUrl: string;
  say?: (line: string) => void;
}

function isWaiting(item: AttentionItem): item is AttentionItem & { kind: WaitingKind } {
  return (WAITING_KINDS as readonly string[]).includes(item.kind);
}

/** One occurrence: the same pull request held again, or stalled again, is a new `since`. */
export function occurrenceOf(item: AttentionItem): string {
  return `${item.id}@${item.since}`;
}

/** "Pull request #12 waits for you to merge it. Merge it on GitHub." */
export function waitingText(item: AttentionItem): string {
  const headline = item.headline.replace(/[.\s]+$/, '');
  const action = item.actions[0]?.label.replace(/[.\s]+$/, '');
  return action ? `${headline}. ${action}.` : `${headline}.`;
}

/**
 * Whether an item is a held approval routed to people other than its named
 * person: the admins and approvers, or everyone, when the login is not in
 * People. For the approvers it is under Waiting on others, not counted, and so
 * not pushed either (ADR 0058); the admins, who can add the person, are told
 * once on their own (`notInPeopleNotice`, ADR 0059). Left unrecorded under its
 * own key, it is sent once it routes to the person, as when they are added to
 * People. A local install routes nothing, and is sent as before.
 */
export function waitsOnOthers(item: Pick<AttentionItem, 'decision' | 'audience'>): boolean {
  return Boolean(item.decision && item.audience && item.audience.for !== 'person');
}

/** The record of the admins' push about an occurrence, apart from the person's own, which goes out once they are in People. */
export function notInPeopleKey(item: AttentionItem): string {
  return `${occurrenceOf(item)}#not-in-people`;
}

/** "@dana is not in People, so pull request #12 waits with no one to approve it. Add them in Settings → People." */
export function notInPeopleText(login: string, pr: number): string {
  return `@${login} is not in People, so pull request #${pr} waits with no one to approve it. Add them in Settings → People.`;
}

/** The admins a held approval for someone not in People is pushed to; null when it is not one, or there are none. */
function notInPeopleAdmins(item: AttentionItem): { login: string; pr: number; admins: string[] } | null {
  const audience = item.audience;
  if (!item.decision || !audience?.notInPeople || !audience.admins?.length) return null;
  return { login: audience.notInPeople, pr: item.decision.pr, admins: [...audience.admins] };
}

/**
 * Sends a pull request waiting on a person and a review that stopped, once
 * each, read from Needs you.
 *
 * Neither is one event: a stalled review is written in four places, and a
 * merge held for a person is decided in the merge line, whose paths a person
 * reviews. Needs you already turns both into items with stable ids, so this
 * reads those every minute, as the board does (ADR 0021: events are read from
 * where they happen, so a writer that forgets to emit leaves no gap).
 *
 * What was sent is the event log's `notify.<kind>` with the occurrence as its
 * `item`, so a restart sends nothing twice. The first pass an install ever
 * runs records its time and what already waits as a baseline and sends none
 * of it, nor anything later seen whose `since` is before it: an upgrade would
 * otherwise page a person once for every pull request that was already
 * waiting.
 */
export class WaitingNotices {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: WaitingNoticesDeps) {}

  start(everyMs = WAITING_EVERY_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pass(), everyMs);
    this.timer.unref();
    // The first look is the baseline: left to the first tick, a merge or a
    // stall that began in the bridge's first minute would be taken for one
    // that already waited, and never sent.
    void this.pass();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One look at Needs you. A pass still running when the next comes round is not overlapped: that tick is skipped. */
  async pass(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.look();
    } catch (error) {
      (this.deps.say ?? console.warn)(`[bridge] could not look for waiting work to notify about: ${error instanceof Error ? error.message : error}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async look(): Promise<number> {
    const store = this.deps.notifier.store;
    const items = (await this.deps.items()).filter(isWaiting);
    let sent = 0;
    for (const kind of WAITING_KINDS) {
      const type = `notify.${kind}`;
      const ofKind = items.filter((item) => item.kind === kind);
      if (!(await store.recorded(type))) {
        // The look itself first, so a pass that throws part way still has
        // its time to judge the rest by.
        await store.record(type, { baseline: true, look: FIRST_LOOK });
        for (const item of ofKind) await store.record(type, { item: occurrenceOf(item), baseline: true });
        continue;
      }
      // What waited before the first look is the baseline too, whether or not
      // that look saw it. Attention's reads fail open to an empty list, so a
      // first look that saw nothing may only have failed to read, and taking
      // its list for the whole would send every pull request already waiting
      // on the next pass.
      const baselineAt = await store.lastAt(type, { look: FIRST_LOOK });
      for (const item of ofKind) {
        const key = occurrenceOf(item);
        if (await store.recorded(type, { item: key })) continue;
        if (baselineAt !== null && Date.parse(item.since) <= Date.parse(baselineAt)) {
          await store.record(type, { item: key, baseline: true });
          continue;
        }
        // Who it is routed to was not read on this pass: it is left unrecorded,
        // so the next pass that reads them sends it, rather than sent to the
        // wrong people now or to no one for good.
        if (!mayNotify(item.audience)) continue;
        const subject = item.subject.item ?? item.subject.ref;
        const link = subject ? itemLink(this.deps.consoleUrl, subject) : this.deps.consoleUrl;
        const missing = notInPeopleAdmins(item);
        if (missing) {
          // Under a key of its own: recorded under the occurrence's, the
          // person would never be pushed once an admin adds them.
          const adminsKey = notInPeopleKey(item);
          if (await store.recorded(type, { item: adminsKey })) continue;
          await this.deps.notifier.send({ event: kind, to: null, item: adminsKey, people: missing.admins, text: notInPeopleText(missing.login, missing.pr), link });
          sent += 1;
          continue;
        }
        if (waitsOnOthers(item)) continue;
        // To the item's people when it is routed to some, each on their own
        // channel; one record per occurrence either way, so none is sent twice.
        const people = routedPeople(item);
        await this.deps.notifier.send({
          event: kind,
          to: null,
          item: key,
          ...(people ? { people } : {}),
          text: waitingText(item),
          link,
        });
        sent += 1;
      }
    }
    return sent;
  }
}
