import { audit as writeAudit, handsOff as handsOffStore, type HandsOffDuration, type HandsOffEnd, type HandsOffWindow } from '@openadlc/db';
import { CROSS_CUTTING_LABEL, hasIgnoreLabel, keepsForPerson, type PlanChangeRequest, type TaskKind } from '@openadlc/shared';
import type { HumanReviewRead } from './human-review-read.js';
import { isCostCapGate, viewerOf, type Audience, type AudienceFacts } from './needs-you-audience.js';
import { keptFor } from './plan-changes.js';

/**
 * Hands-off mode (#383,
 * docs/adr/0093-a-hands-off-window-answers-routine-gates-and-never-the-excluded-ones.md).
 *
 * A person with Approves on, after a fresh device-code sign-in
 * (`hands-off-routes.ts`), opens a window on one repository for 1 hour,
 * 8 hours, 24 hours or until turned off. While it is open, `Gates.open`
 * answers two kinds of gate as they are asked, and nothing else:
 *
 * - a plan change none of whose paths is under Human review on the base
 *   branch, approved as a standing approval approves one (#77); and
 * - a question from an intake, spec, implement or request task on an issue
 *   or a console request, answered with the option its marker recommended,
 *   when the person who opened the window could have answered it in Needs
 *   you, and its issue is not labelled `scope:cross-cutting` or
 *   `openadlc:ignore` and declares no path under Human review.
 *
 * This is an allow-list. `Gates.open` is the only caller of the cover, and
 * everything the issue keeps for a person — the merge decision, a held
 * approval, a release, deploy or promote, a host check, a label, a setting,
 * a cost-cap question — is decided somewhere that never reads it
 * (`hands-off-exclusions.test.ts` holds that). A new kind of gate asks a
 * person until someone decides otherwise.
 *
 * A window ends when its time runs out, when a monthly cap on its repository
 * is reached, or when anyone in the console turns it off. Each start and end
 * is audited as `hands_off.on` and `hands_off.off`, and each answer as
 * `gate.answer` with channel `hands_off`, naming who opened the window.
 */

/** The task kinds whose questions a window may answer: the crew working an issue or a request, never judging work under review. */
export const HANDS_OFF_KINDS: readonly TaskKind[] = ['intake', 'request', 'spec', 'implement'];

/** The subjects it answers on: an issue, or a console request with no issue yet. A pull request's questions are the review's. */
const HANDS_OFF_SUBJECTS: readonly string[] = ['issue', 'request'];

/** The audit actions a window writes. */
export const HANDS_OFF_ON = 'hands_off.on';
export const HANDS_OFF_OFF = 'hands_off.off';
export const HANDS_OFF_REFUSED = 'hands_off.refused';

/** The audit target of a repository's window. */
export function handsOffTarget(fullName: string): string {
  return `${fullName}:hands-off`;
}

/** A duration as people say it. */
export function durationWords(duration: HandsOffDuration): string {
  switch (duration) {
    case '1h':
      return '1 hour';
    case '8h':
      return '8 hours';
    case '24h':
      return '24 hours';
    case 'until_off':
      return 'until turned off';
  }
}

/** A time as the issue says it: `2026-11-25 10:00 UTC`. */
export function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export interface HandsOffRepo {
  id: string;
  name: string;
  fullName: string;
  defaultBranch?: string | null;
}

/** What `Gates.open` knows about a gate as it opens it. */
export interface HandsOffAsk {
  task: { id: string; kind: TaskKind; subjectType: string; subjectRef: string; botId: string; repoId: string | null };
  repo: HandsOffRepo;
  /** The issue the question is asked on; 0 for a console request. */
  issueNumber: number;
  /** The plan change it asks, or null for a question. */
  planChange: PlanChangeRequest | null;
  options: readonly string[];
  /** The option the bot recommended, as `Gates.open` was given it; matched against `options` here. */
  recommended: string | null;
  /** The person role the question names, as asked, or null. */
  role: string | null;
  /** Who the question is routed to, as Needs you would route it; null on a local install, or with no audience wired. */
  audience: Audience | null;
  facts: AudienceFacts | null;
  /** Whether the install is local, with one console identity and no routing. */
  local: boolean;
  /** The login the question is addressed to, if any. */
  addressedTo: string | null;
  /** Whether `Gates.open` found the issue labelled `openadlc:ignore`. */
  ignored: boolean;
}

/** Null when no window is open; otherwise whether it answers this gate, and with what or why not. */
export type HandsOffVerdict = { covers: true; window: HandsOffWindow; reply: string } | { covers: false; window: HandsOffWindow; why: string } | null;

export type HandsOffCover = (ask: HandsOffAsk) => Promise<HandsOffVerdict>;

export interface HandsOffDeps {
  store: Pick<typeof handsOffStore, 'openFor' | 'listOpen' | 'turnOn' | 'end' | 'endExpired'>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
  /** The repository a window is on, by id; null when it is gone. */
  repoById(repoId: string): Promise<HandsOffRepo | null>;
  /** The global or this repository's month total, when it is reached (`spendingLimits.repositoryRefusal`). */
  repositoryRefusal(repo: HandsOffRepo): Promise<string | null>;
  /** The monthly cap that refuses this task's bot more spend, if any (`spendingLimits.refusal`). */
  taskRefusal(task: { botId: string; repoId: string | null }): Promise<string | null>;
  /** The Human-review rules on a repository's base branch. */
  humanReviewRules(repoFullName: string, baseRef: string): Promise<HumanReviewRead>;
  /** The issue's labels and Expected paths, from the stored row or GitHub; throws when neither can be read. */
  issueFacts(repo: HandsOffRepo, issueNumber: number): Promise<{ labels: readonly string[]; declaredPaths: readonly string[] }>;
  warn?(message: string): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HandsOff {
  constructor(private readonly deps: HandsOffDeps) {}

  private warn(message: string): void {
    (this.deps.warn ?? console.warn)(message);
  }

  private payloadOf(window: HandsOffWindow, repo: HandsOffRepo | null): Record<string, unknown> {
    return {
      windowId: window.id,
      repo: repo?.fullName ?? null,
      setBy: window.setBy,
      setByLogin: window.setByLogin,
      setByGithubId: window.setByGithubId,
      setAt: window.setAt,
      endsAt: window.endsAt,
      duration: window.duration,
    };
  }

  /** Audits a window's start or end. A row that cannot be written is said in the log: the window is what it is. */
  private async audited(action: string, actor: string, window: HandsOffWindow, repo: HandsOffRepo | null, more: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.deps.audit({
        actor,
        action,
        target: handsOffTarget(repo?.fullName ?? window.repoId),
        payload: { ...this.payloadOf(window, repo), ...more },
      });
    } catch (error) {
      this.warn(`[bridge] ${action} on ${repo?.fullName ?? window.repoId} was not audited: ${messageOf(error)}`);
    }
  }

  /** Audits a window's end as the store recorded it, which may be expired rather than what was asked. */
  private auditedEnd(window: HandsOffWindow, repo: HandsOffRepo | null, asked: { by: string; why: HandsOffEnd; note?: string | null }): Promise<void> {
    const by = window.endedBy ?? asked.by;
    const why = window.endedWhy ?? asked.why;
    const note = window.endedWhy ? window.endedNote : (asked.note ?? null);
    return this.audited(HANDS_OFF_OFF, by, window, repo, { by, why, note });
  }

  /**
   * Opens a window, audited as `hands_off.on`; `created` false when one was
   * already open, which is left as it was. A window the store ended first
   * because its time had passed is audited as `hands_off.off` before the new
   * one's `hands_off.on`, so every end leaves a row and a feed event.
   */
  async turnOn(input: { repo: HandsOffRepo; setBy: string; setByLogin: string; setByGithubId: number; duration: HandsOffDuration }): Promise<{ window: HandsOffWindow; created: boolean }> {
    const opened = await this.deps.store.turnOn({
      repoId: input.repo.id,
      setBy: input.setBy,
      setByLogin: input.setByLogin,
      setByGithubId: input.setByGithubId,
      duration: input.duration,
    });
    for (const lapsed of opened.expired) await this.auditedEnd(lapsed, input.repo, { by: 'openadlc', why: 'expired', note: null });
    if (opened.created) await this.audited(HANDS_OFF_ON, input.setBy, opened.window, input.repo);
    return { window: opened.window, created: opened.created };
  }

  /** Ends the window on a repository, audited as `hands_off.off`; null when none was open. */
  async end(repo: HandsOffRepo, input: { by: string; why: HandsOffEnd; note?: string | null }): Promise<HandsOffWindow | null> {
    const ended = await this.deps.store.end({ repoId: repo.id, by: input.by, why: input.why, note: input.note ?? null });
    if (ended) await this.auditedEnd(ended, repo, input);
    return ended;
  }

  /** A person turning it off from the console: at once, whoever they are, since it only tightens. */
  turnOff(repo: HandsOffRepo, identity: string): Promise<HandsOffWindow | null> {
    return this.end(repo, { by: identity, why: 'turned_off' });
  }

  /** The window open on a repository now. */
  openFor(repoId: string): Promise<HandsOffWindow | null> {
    return this.deps.store.openFor(repoId);
  }

  listOpen(): Promise<HandsOffWindow[]> {
    return this.deps.store.listOpen();
  }

  /** Ends every window whose time has passed, each audited. */
  async expire(): Promise<HandsOffWindow[]> {
    const ended = await this.deps.store.endExpired();
    for (const window of ended) {
      const repo = await this.deps.repoById(window.repoId).catch(() => null);
      await this.audited(HANDS_OFF_OFF, 'openadlc', window, repo, { by: 'openadlc', why: 'expired', note: null });
    }
    return ended;
  }

  /**
   * The bridge's minute timer: ends windows whose time has passed, then any
   * whose repository is at a monthly cap. A cap that cannot be read leaves
   * the window on: the gate's own check (`cover`) asks again on every gate.
   */
  async sweep(): Promise<void> {
    await this.expire().catch((error: unknown) => this.warn(`[bridge] expired hands-off windows were not ended: ${messageOf(error)}`));
    const open = await this.deps.store.listOpen().catch((error: unknown) => {
      this.warn(`[bridge] open hands-off windows could not be read: ${messageOf(error)}`);
      return [] as HandsOffWindow[];
    });
    for (const window of open) {
      try {
        const repo = await this.deps.repoById(window.repoId);
        if (!repo) continue;
        const refusal = await this.deps.repositoryRefusal(repo);
        if (refusal) await this.end(repo, { by: 'openadlc', why: 'cap', note: refusal });
      } catch (error) {
        this.warn(`[bridge] whether a cap ends the hands-off window on ${window.repoId} could not be read: ${messageOf(error)}`);
      }
    }
  }

  /**
   * How `Gates.open` asks whether the window settles a gate. Every read that
   * fails answers "does not cover", so the person is asked as before.
   */
  cover(): HandsOffCover {
    return async (ask) => {
      await this.expire().catch(() => []);
      const window = await this.deps.store.openFor(ask.repo.id);
      if (!window) return null;
      const no = (why: string): HandsOffVerdict => ({ covers: false, window, why });
      try {
        // A cost-cap question raises a cap, which is never the window's to do,
        // and it does not end the window: the per-task cap is not the month's.
        if (isCostCapGate(ask.options)) return no('this question raises a cost cap, which only a person does');
        const refusal = await this.deps.taskRefusal(ask.task);
        if (refusal) {
          await this.end(ask.repo, { by: 'openadlc', why: 'cap', note: refusal });
          return no(`a monthly cap is reached (${refusal}), so hands-off mode turned itself off`);
        }
        if (ask.planChange) return this.planChange(ask, window);
        return await this.question(ask, window);
      } catch (error) {
        this.warn(`[bridge] whether hands-off mode answers a gate on ${ask.task.subjectRef} could not be read, so a person is asked: ${messageOf(error)}`);
        return no(`whether it covers this could not be read (${messageOf(error)})`);
      }
    };
  }

  private async planChange(ask: HandsOffAsk, window: HandsOffWindow): Promise<HandsOffVerdict> {
    const paths = ask.planChange?.paths ?? [];
    const kept = await keptFor(this.deps.humanReviewRules, ask.repo, paths);
    if (kept.rulesUnread) return { covers: false, window, why: `${kept.rulesUnread.what}. ${kept.rulesUnread.fix}` };
    if (keepsForPerson(kept)) {
      return { covers: false, window, why: `${kept.humanReview.map((path) => `\`${path}\``).join(', ')} ${kept.humanReview.length === 1 ? 'is' : 'are'} under Human review in AGENTS.md` };
    }
    return { covers: true, window, reply: 'Approve' };
  }

  private async question(ask: HandsOffAsk, window: HandsOffWindow): Promise<HandsOffVerdict> {
    const no = (why: string): HandsOffVerdict => ({ covers: false, window, why });
    if (!HANDS_OFF_KINDS.includes(ask.task.kind)) return no(`a ${ask.task.kind} task's question is the crew judging work, which a person answers`);
    if (!HANDS_OFF_SUBJECTS.includes(ask.task.subjectType)) return no('a question on a pull request is answered by a person');
    const wanted = ask.recommended?.trim() ?? '';
    if (ask.options.length === 0) return no('it is an open question, with no option to recommend');
    if (!wanted) return no('the bot recommended no answer');
    const reply = ask.options.find((option) => option === wanted);
    if (!reply) return no('the answer the bot recommended is not one of its options');

    // Only what the person who opened the window could have answered in Needs you.
    if (ask.addressedTo && ask.addressedTo.toLowerCase() !== window.setByLogin.toLowerCase()) {
      return no(`it is addressed to @${ask.addressedTo}`);
    }
    const routed = this.routedElsewhere(ask, window);
    if (routed) return no(routed);

    if (ask.ignored) return no('the issue is labelled openadlc:ignore');
    if (ask.task.subjectType === 'issue') {
      if (!ask.issueNumber) return no('the issue it is asked on cannot be told');
      const facts = await this.deps.issueFacts(ask.repo, ask.issueNumber);
      if (facts.labels.includes(CROSS_CUTTING_LABEL)) return no(`the issue is labelled ${CROSS_CUTTING_LABEL}`);
      if (hasIgnoreLabel(facts.labels)) return no('the issue is labelled openadlc:ignore');
      const kept = await keptFor(this.deps.humanReviewRules, ask.repo, facts.declaredPaths);
      if (kept.rulesUnread) return no(`${kept.rulesUnread.what}. ${kept.rulesUnread.fix}`);
      if (keepsForPerson(kept)) {
        return no(`the issue's Expected paths name ${kept.humanReview.map((path) => `\`${path}\``).join(', ')}, under Human review in AGENTS.md`);
      }
    }
    return { covers: true, window, reply };
  }

  /** Why the question is someone else's to answer, by the role it names; null when the window's setter could answer it. */
  private routedElsewhere(ask: HandsOffAsk, window: HandsOffWindow): string | null {
    if (ask.local) return null;
    const audience = ask.audience;
    if (!audience) return ask.role ? `who holds ${ask.role} could not be read` : null;
    if (audience.for === 'everyone') return null;
    if (audience.unread) return `who it is for (${audience.name}) could not be read now`;
    const facts = ask.facts;
    const setter =
      (facts ? viewerOf(window.setBy, facts) : null) ??
      facts?.people.find((person) => person.githubLogin !== null && person.githubLogin.toLowerCase() === window.setByLogin.toLowerCase()) ??
      null;
    if (setter && audience.people.includes(setter.id)) return null;
    return `it is for ${audience.name}, which @${window.setByLogin} does not hold`;
  }
}

/** The live store and audit; the rest is the bridge's (`api.ts`). */
export function liveHandsOff(deps: Omit<HandsOffDeps, 'store' | 'audit'>): HandsOff {
  return new HandsOff({
    store: handsOffStore,
    audit: async (entry) => {
      await writeAudit(entry);
    },
    ...deps,
  });
}
