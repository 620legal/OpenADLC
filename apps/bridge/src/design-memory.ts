import { audit, bots, designMemory, issues, recordEvent, repos, tasks, threads } from '@fleetadlc/db';
import { designMemoryProposals, inertMarkup, type ContextDocument, type StageKey } from '@fleetadlc/shared';
import { HttpFailure, type Router } from './router.js';
import { parseRef } from './work.js';

/**
 * Design memory: what the design stage knows about a repository from one
 * issue to the next. Design is the only stage with memory and context.
 *
 * GitHub is the record. A decision is written as an ADR under `docs/adr/` in
 * the repository, by the build that carries it out, and lives there with the
 * code it governs. What is kept here is the short form: one entry per
 * decision, constraint, convention or term, cheap enough to give every design
 * task, and editable by people in Settings → Repositories, because a summary
 * nobody can correct is a mistake that is repeated on every issue.
 *
 * - **Proposed** only by the design (spec) task on an issue: read from the
 *   last marker of a comment whose signature verifies to that task, whatever
 *   the attribution mode. Any crew comment used to propose — a builder's, a
 *   reviewer's, the bridge's echo of a person's words — and lasting
 *   instructions for every later design could be planted from any of them.
 * - **Accepted** when a person answers that design task's question, or the
 *   issue moves on to build: a design nobody objected to is the one that was
 *   built. Credited to that person, or else to the design's seat — never to
 *   someone who answered another question on the issue.
 * - **Superseding** an accepted entry is automatic too, and never silent: the
 *   issue is told, the board shows it, and a person reverts it in Settings.
 * - **Given** to design tasks only, as `design-memory.md`: accepted entries,
 *   the newest decisions first, under a size a summary has.
 */

/** Stages an issue is in once its design has been taken. */
const PAST_DESIGN: ReadonlySet<StageKey> = new Set<StageKey>(['build', 'review', 'merged', 'done']);

/** How long `design-memory.md` may be: enough for a repository's working summary, and no more. */
export const DESIGN_MEMORY_CHARS = 16_000;

/** The event the board reads for a supersede it says (`attention.ts`): `{ repo, issue, replaced, by, commentUrl }`. */
export const DESIGN_MEMORY_SUPERSEDED = 'design_memory.superseded';

/** What a comment's signature said, as `Attribution.check` read it. */
export interface CommentSignature {
  verified: boolean;
  seat: string | null;
  task: string | null;
}

/** Where a supersede is said on its issue: the automation account's comment, set at start-up (main.ts). */
let say: ((repoFullName: string, issueNumber: number, body: string) => Promise<string | null>) | null = null;

export function sayDesignMemoryWith(comment: (repoFullName: string, issueNumber: number, body: string) => Promise<string | null>): void {
  say = comment;
}

/**
 * The design task a comment speaks for, or null. Its signature must check,
 * name a spec task on this very issue, and name that task's own seat: the
 * marker's `bot` and the comment's login are only the poster's word on a
 * shared crew account. The bridge's own posts are signed for no task, so
 * what it echoes for a person never qualifies.
 */
async function designTaskOf(signature: CommentSignature | null, subject: string): Promise<{ taskId: string; seat: string } | null> {
  if (!signature?.verified || !signature.task || !signature.seat) return null;
  const task = await tasks.getTask(signature.task).catch(() => null);
  if (!task || task.kind !== 'spec' || task.subjectRef !== subject) return null;
  const bot = await bots.getBotById(task.botId).catch(() => null);
  if (!bot || bot.name.toLowerCase() !== signature.seat.toLowerCase()) return null;
  return { taskId: task.id, seat: bot.name };
}

/**
 * Records what an issue's design task proposes in its signed comment. A
 * design comment that arrives after the issue already moved to build (its
 * label can be delivered first) has its own entries accepted as they are
 * recorded, and nothing else.
 */
export async function recordDesignMemory(input: {
  repoName: string;
  issueNumber: number;
  body: string;
  commentUrl: string | null;
  signature: CommentSignature | null;
}): Promise<designMemory.DesignMemoryEntry[]> {
  const proposals = designMemoryProposals(input.body);
  if (proposals.length === 0) return [];
  const repo = await repos.getRepoByName(input.repoName);
  if (!repo) return [];
  const subject = `${repo.name}#${input.issueNumber}`;
  const source = await designTaskOf(input.signature, subject);
  if (!source) return [];
  const saved = await designMemory.propose(repo.id, proposals, { subject, url: input.commentUrl, by: source.seat, task: source.taskId });
  const issue = await issues.getIssue(repo.id, input.issueNumber).catch(() => null);
  if (issue && PAST_DESIGN.has(issue.stage) && saved.length > 0) {
    await acceptFor(repo, input.issueNumber, { sourceTask: source.taskId, ids: saved.map((entry) => entry.id) });
  }
  return saved;
}

/**
 * Accepts what design tasks proposed on an issue: one task's, when `only`
 * says so, else every one's. Each task's entries are credited to the person
 * who answered that task's own question, or else to its seat; with
 * `answeredBy` given, to them. What an entry superseded is said on the issue
 * and to the board.
 */
async function acceptFor(
  repo: { id: string; name: string; fullName: string },
  issueNumber: number,
  only: { sourceTask?: string; ids?: readonly string[]; answeredBy?: string } = {},
): Promise<number> {
  const subject = `${repo.name}#${issueNumber}`;
  const proposed = (await designMemory.listForSubjects([subject])).filter(
    (entry) => entry.repoId === repo.id && entry.state === 'proposed' && entry.sourceTask && (!only.sourceTask || entry.sourceTask === only.sourceTask),
  );
  const byTask = new Map<string, string | null>();
  for (const entry of proposed) if (!byTask.has(entry.sourceTask!)) byTask.set(entry.sourceTask!, entry.proposedBy);
  if (byTask.size === 0) return 0;
  const gates = only.answeredBy ? [] : await threads.listGatesForSubject(subject).catch(() => []);

  let count = 0;
  for (const [taskId, seat] of byTask) {
    const decidedBy =
      only.answeredBy ??
      gates.filter((gate) => gate.taskId === taskId && gate.state === 'answered' && gate.answeredBy).at(-1)?.answeredBy ??
      `${seat ?? 'the design'}, unopposed at the move to build`;
    const { accepted, superseded } = await designMemory.acceptFor(repo.id, [subject], decidedBy, {
      sourceTask: taskId,
      ...(only.ids ? { ids: only.ids } : {}),
    });
    count += accepted.length;
    if (superseded.length > 0) await announce(repo, issueNumber, accepted, superseded, decidedBy);
  }
  return count;
}

/**
 * Says a supersede out loud: a comment on the issue naming both entries and
 * how to revert, and an event the board shows as a notice. Neither holds a
 * stage, a gate or a merge. A supersede used to be silent, and a constraint a
 * person had decided could be retired by a title in a design comment.
 */
async function announce(
  repo: { name: string; fullName: string },
  issueNumber: number,
  accepted: readonly designMemory.DesignMemoryEntry[],
  superseded: readonly designMemory.DesignMemoryEntry[],
  decidedBy: string,
): Promise<void> {
  const pairs = superseded.map((old) => ({ old, by: accepted.find((entry) => entry.supersedes === old.id) ?? null }));
  const quoted = (title: string) => `“${inertMarkup(title).replace(/\s+/g, ' ')}”`;
  const lines = pairs.map(({ old, by }) => `- ${by ? quoted(by.title) : 'A new entry'} replaces ${quoted(old.title)}.`);
  const body = [
    `The design memory of ${repo.fullName} changed with this design, accepted as ${inertMarkup(decidedBy)}:`,
    '',
    ...lines,
    '',
    `Every later design is given the new entry and not the old one. If that is wrong, revert it in Settings → Repositories → ${repo.name} → Design memory: **Revert** on the new entry puts the old one back.`,
  ].join('\n');
  const commentUrl = say ? await say(repo.fullName, issueNumber, body).catch(() => null) : null;
  await recordEvent({
    source: 'platform',
    type: DESIGN_MEMORY_SUPERSEDED,
    payload: {
      repo: repo.name,
      issue: issueNumber,
      by: decidedBy,
      commentUrl,
      replaced: pairs.map(({ old, by }) => ({ id: old.id, title: old.title, byId: by?.id ?? null, byTitle: by?.title ?? null })),
    },
  }).catch((error: unknown) => console.warn(`[bridge] ${repo.name}#${issueNumber}: the design memory supersede was not recorded: ${error instanceof Error ? error.message : error}`));
}

/** A person answered a question: one asked by a design task accepts that task's proposals, as theirs. */
export async function acceptOnAnswer(taskId: string | null, answeredBy: string): Promise<number> {
  if (!taskId) return 0;
  const task = await tasks.getTask(taskId);
  if (!task || task.kind !== 'spec' || !task.repoId) return 0;
  const repo = (await repos.listRepos({ includeRemoved: true })).find((one) => one.id === task.repoId);
  const number = parseRef(task.subjectRef)?.number;
  if (!repo || !number) return 0;
  return acceptFor(repo, number, { sourceTask: task.id, answeredBy });
}

/** An issue moved on to build: its design was taken. */
export async function acceptOnStage(repoName: string, issueNumber: number, stage: StageKey): Promise<number> {
  if (!PAST_DESIGN.has(stage)) return 0;
  const repo = await repos.getRepoByName(repoName);
  if (!repo) return 0;
  return acceptFor(repo, issueNumber);
}

/**
 * The ADR a merged change added for a decision: the one whose name shares
 * most words with its title, and only one. With no word in common it is
 * taken only when it is the one ADR the change touched; the first of several
 * was taken whatever it said, and every later design was told to read an ADR
 * about something else. A tie names none: a person can say which in Settings.
 */
export function adrFor(title: string, changed: readonly string[]): string | null {
  const adrs = changed.filter((path) => /^docs\/adr\/\d{4}-[^/]+\.md$/.test(path) && !path.endsWith('0000-template.md'));
  if (adrs.length === 0) return null;
  const words = new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  const score = (path: string): number => path.toLowerCase().split(/[^a-z0-9]+/).filter((word) => words.has(word)).length;
  const best = Math.max(...adrs.map(score));
  if (best === 0) return adrs.length === 1 ? adrs[0]! : null;
  const top = adrs.filter((path) => score(path) === best);
  return top.length === 1 ? top[0]! : null;
}

/**
 * The backstop the reconciler runs: proposals on issues that have moved past
 * design are accepted, and an accepted decision whose change merged with an
 * ADR in it is pointed at that file. What the stored issue says is enough;
 * nothing here asks GitHub.
 */
export async function sweepDesignMemory(): Promise<string[]> {
  const said: string[] = [];
  for (const repo of await repos.listRepos()) {
    // A proposal no design task made (recorded before that was kept) waits
    // for a person in Settings.
    const proposed = (await designMemory.listForRepo(repo.id, ['proposed'])).filter((entry) => entry.sourceTask);
    const subjects = [...new Set(proposed.map((entry) => entry.sourceSubject).filter((one): one is string => Boolean(one)))];
    for (const subject of subjects) {
      const number = parseRef(subject)?.number;
      const issue = number ? await issues.getIssue(repo.id, number).catch(() => null) : null;
      if (number && issue && PAST_DESIGN.has(issue.stage)) {
        const accepted = await acceptFor(repo, number);
        if (accepted > 0) said.push(`${subject}: accepted ${accepted} design memory entr${accepted === 1 ? 'y' : 'ies'}, its issue having moved to ${issue.stage}`);
      }
    }
  }
  for (const entry of await designMemory.decisionsWithoutAdr()) {
    const number = entry.sourceSubject ? parseRef(entry.sourceSubject)?.number : undefined;
    const issue = number ? await issues.getIssue(entry.repoId, number).catch(() => null) : null;
    if (!issue || (issue.stage !== 'merged' && issue.stage !== 'done')) continue;
    const path = adrFor(entry.title, issue.prChangedPaths);
    if (!path) continue;
    await designMemory.setAdrPath(entry.id, path);
    said.push(`${entry.sourceSubject}: "${entry.title}" is recorded in ${path}`);
  }
  return said;
}

const KIND_ORDER = ['decision', 'constraint', 'convention', 'glossary'] as const;
const KIND_HEADINGS: Record<(typeof KIND_ORDER)[number], string> = {
  decision: 'Decisions',
  constraint: 'Constraints',
  convention: 'Conventions',
  glossary: 'Words this repository uses',
};

/** Room kept for the note that says what was left out, so the note fits under the limit too. */
const LEFT_OUT_NOTE_CHARS = 400;

/**
 * What a design task is given: the accepted entries, decisions first and the
 * newest of each kind first, with what each replaced left out. Cut at a
 * summary's size by age across every kind, and said so, kind by kind, with
 * where the whole record is. Packed by kind, a newer constraint was dropped to
 * keep older decisions, and the note said what it dropped was in the ADRs,
 * which keep decisions only.
 */
export function designMemoryDocument(entries: readonly designMemory.DesignMemoryEntry[], repoFullName: string): ContextDocument | null {
  const accepted = entries.filter((entry) => entry.state === 'accepted');
  if (accepted.length === 0) return null;
  const head = [
    `# What ${repoFullName} has decided`,
    '',
    'The design memory of this repository: decisions taken, the constraints and conventions it works within, and the',
    'words it uses, each accepted by a person or by the build that followed. The record is the ADRs under `docs/adr/`',
    'in your worktree; read the one an entry names before you design against it, and propose what your design adds',
    'or replaces in the `design_memory` marker (the spec skill says how). An entry is named by its id when you',
    'supersede it.',
  ].join('\n');
  const at = (entry: designMemory.DesignMemoryEntry): number => Date.parse(entry.decidedAt ?? entry.createdAt);
  const text = (entry: designMemory.DesignMemoryEntry): string =>
    [
      `### ${entry.title}`,
      '',
      entry.body.trim(),
      '',
      `_id ${entry.id}${entry.sourceSubject ? ` · from ${entry.sourceSubject}` : ''}${entry.adrPath ? ` · ${entry.adrPath}` : ''}_`,
    ].join('\n');
  const known = accepted.filter((entry) => (KIND_ORDER as readonly string[]).includes(entry.kind));
  const headings = KIND_ORDER.reduce((sum, kind) => sum + `## ${KIND_HEADINGS[kind]}`.length + 4, 0);
  const whole = head.length + headings + known.reduce((sum, entry) => sum + text(entry).length + 2, 0);
  const budget = whole <= DESIGN_MEMORY_CHARS ? DESIGN_MEMORY_CHARS : DESIGN_MEMORY_CHARS - LEFT_OUT_NOTE_CHARS;

  // The newest first, whatever their kind, until the first that does not
  // fit: everything left out is older than everything given.
  const kept = new Set<designMemory.DesignMemoryEntry>();
  const left: Record<(typeof KIND_ORDER)[number], number> = { decision: 0, constraint: 0, convention: 0, glossary: 0 };
  let length = head.length + headings;
  let full = false;
  for (const entry of [...known].sort((a, b) => at(b) - at(a))) {
    const size = text(entry).length + 2;
    full ||= length + size > budget;
    if (full) {
      left[entry.kind as (typeof KIND_ORDER)[number]] += 1;
      continue;
    }
    kept.add(entry);
    length += size;
  }

  const sections: string[] = [];
  for (const kind of KIND_ORDER) {
    const lines = known
      .filter((entry) => entry.kind === kind && kept.has(entry))
      .sort((a, b) => at(b) - at(a))
      .map(text);
    if (lines.length > 0) sections.push(`## ${KIND_HEADINGS[kind]}\n\n${lines.join('\n\n')}`);
  }
  return {
    name: 'design-memory.md',
    title: `The design memory of ${repoFullName}`,
    content: [head, ...sections, ...leftOutNote(left)].join('\n\n'),
  };
}

/** What was left out for length, by kind, and where each kind's whole record is. */
function leftOutNote(left: Record<(typeof KIND_ORDER)[number], number>): string[] {
  const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (left.decision > 0) parts.push(`${count(left.decision, 'decision', 'decisions')} (the ADRs under docs/adr/ have them)`);
  const rest = [
    left.constraint > 0 ? count(left.constraint, 'constraint', 'constraints') : null,
    left.convention > 0 ? count(left.convention, 'convention', 'conventions') : null,
    left.glossary > 0 ? count(left.glossary, 'word', 'words') : null,
  ].filter((one): one is string => one !== null);
  if (rest.length > 0) parts.push(`${rest.join(', ')} (a person can read them in Settings → Repositories → Design memory)`);
  return parts.length > 0 ? [`_Left out for length, older than everything above: ${parts.join('; ')}._`] : [];
}

/** Reads it for a design task in a repository, or null when it has nothing accepted. */
export async function readDesignMemory(repoFullName: string): Promise<ContextDocument | null> {
  const repo = (await repos.listRepos({ includeRemoved: true })).find((one) => one.fullName.toLowerCase() === repoFullName.toLowerCase());
  if (!repo) return null;
  return designMemoryDocument(await designMemory.listForRepo(repo.id, ['accepted']), repo.fullName);
}

/** Settings → Repositories → Design memory: read it all, and correct it. Both an admin's (`roles.ts`). */
export function registerDesignMemoryRoutes(router: Router): void {
  router.get('/v1/repos/:name/design-memory', async ({ params }) => {
    const repo = await repos.getRepoByName(params.name ?? '');
    if (!repo) throw new HttpFailure(404, `there is no repository ${params.name} in OpenADLC`);
    return { entries: await designMemory.listForRepo(repo.id) };
  });

  router.patch('/v1/repos/:name/design-memory', async ({ params, body, identity }) => {
    const repo = await repos.getRepoByName(params.name ?? '');
    if (!repo) throw new HttpFailure(404, `there is no repository ${params.name} in OpenADLC`);
    const input = await body<{ id?: unknown; title?: unknown; body?: unknown; kind?: unknown; state?: unknown; supersedes?: unknown }>();
    const id = typeof input.id === 'string' ? input.id : '';
    const before = await designMemory.getEntry(id);
    if (!before || before.repoId !== repo.id) throw new HttpFailure(404, 'there is no such entry in this repository’s design memory');

    const text = (value: unknown, name: string, max: number): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || !value.trim()) throw new HttpFailure(400, `${name} needs some words`);
      return value.trim().slice(0, max);
    };
    const kind = input.kind === undefined ? undefined : String(input.kind);
    if (kind !== undefined && !(designMemory.DESIGN_MEMORY_KINDS as readonly string[]).includes(kind)) {
      throw new HttpFailure(400, `kind is one of ${designMemory.DESIGN_MEMORY_KINDS.join(', ')}`);
    }
    const state = input.state === undefined ? undefined : String(input.state);
    if (state !== undefined && !(designMemory.DESIGN_MEMORY_STATES as readonly string[]).includes(state)) {
      throw new HttpFailure(400, `state is one of ${designMemory.DESIGN_MEMORY_STATES.join(', ')}`);
    }
    let supersedes: string | null | undefined;
    if (input.supersedes !== undefined) {
      if (input.supersedes === null) supersedes = null;
      else {
        const other = await designMemory.getEntry(String(input.supersedes));
        if (!other || other.repoId !== repo.id || other.id === before.id) throw new HttpFailure(400, 'it can only supersede another entry of this repository');
        supersedes = other.id;
      }
    }
    const after = await designMemory.updateEntry(
      before.id,
      {
        ...(input.title !== undefined ? { title: text(input.title, 'a title', 140)! } : {}),
        ...(input.body !== undefined ? { body: text(input.body, 'the entry', 2000)! } : {}),
        ...(kind ? { kind: kind as designMemory.DesignMemoryKind } : {}),
        ...(state ? { state: state as designMemory.DesignMemoryState } : {}),
        ...(supersedes !== undefined ? { supersedes } : {}),
      },
      identity,
    );
    await audit({
      actor: identity,
      action: 'design_memory.updated',
      target: `${repo.name}:${before.id}`,
      payload: {
        title: before.title,
        changed: Object.keys(input).filter((key) => key !== 'id'),
        from: { state: before.state, kind: before.kind },
        to: { state: after?.state, kind: after?.kind },
      },
    });
    return { entry: after };
  });

  /**
   * Undoes a supersede the design made: the entry it replaced is in effect
   * again, and the one that replaced it is retired. Supersedes are accepted
   * with nobody asked, so this is the one action that takes one back.
   */
  router.post('/v1/repos/:name/design-memory/:id/revert', async ({ params, identity }) => {
    const repo = await repos.getRepoByName(params.name ?? '');
    if (!repo) throw new HttpFailure(404, `there is no repository ${params.name} in OpenADLC`);
    const entry = await designMemory.getEntry(params.id ?? '');
    if (!entry || entry.repoId !== repo.id) throw new HttpFailure(404, 'there is no such entry in this repository’s design memory');
    const reverted = await designMemory.revertSupersede(entry.id, identity);
    if (!reverted) throw new HttpFailure(409, `“${entry.title}” replaced nothing that is still superseded, so there is nothing to revert`);
    await audit({
      actor: identity,
      action: 'design_memory.reverted',
      target: `${repo.name}:${entry.id}`,
      payload: { retired: entry.title, restored: reverted.restored.title, restoredId: reverted.restored.id },
    });
    return reverted;
  });
}
