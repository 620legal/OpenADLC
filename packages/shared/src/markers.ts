/**
 * Skills speak to the bridge through GitHub comments: the comment is the durable
 * record, the event is derived from it. Every structured comment carries one
 * HTML-comment marker holding JSON.
 */
export const MARKER_PREFIX = 'fleetadlc:';

export const FLEETADLC_EVENTS = [
  'plan_posted',
  'question',
  'plan_change',
  'answered',
  'pr_opened',
  'pr_ready',
  'review_posted',
  'deploy_done',
  'verified',
  'stopped',
  'design_memory',
  'send_back',
] as const;
export type FleetEventType = (typeof FLEETADLC_EVENTS)[number];

export interface FleetMarker {
  event: FleetEventType;
  taskId?: string;
  bot?: string;
  /** A `question`'s own words; the text around the marker is its context. */
  question?: string;
  options?: string[];
  /** A `question` no set of choices could cover, so it is answered in the person's own words. */
  open?: boolean;
  addressedTo?: string;
  reason?: string;
  /** On `send_back`: the stage the work goes back to, and on the bridge's record, the stage it left. */
  to?: string;
  from?: string;
  /** On `review_posted` by an advisory seat: what it would have decided (`approve`, `request_changes`), and its lens. */
  verdict?: string;
  lens?: string;
  /**
   * On the lead's `review_posted` approval: `cross-cutting` accepts a change
   * that goes past its issue's declared paths, which the bridge then labels
   * `scope:cross-cutting` as the app, once the review's signature checks
   * (`acceptsCrossCutting`).
   */
  scope?: string;
  [key: string]: unknown;
}

/**
 * `fleet:` is the prefix markers had before the rename. Comments already on
 * GitHub carry it, and the bridge reads its history from them, so both are read;
 * only the current one is written.
 */
export const LEGACY_MARKER_PREFIX = 'fleet:';

const MARKER_RE = /<!--\s*(?:fleetadlc|fleet):(\{[\s\S]*?\})\s*-->/;

export function renderMarker(marker: FleetMarker): string {
  return `<!-- ${MARKER_PREFIX}${JSON.stringify(marker)} -->`;
}

function markerFrom(json: string | undefined): FleetMarker | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as FleetMarker;
    return typeof parsed?.event === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function parseMarker(body: string): FleetMarker | null {
  return markerFrom(MARKER_RE.exec(body)?.[1]);
}

/** Every marker a message carries, in the order it carries them. */
export function parseMarkers(body: string): FleetMarker[] {
  return [...body.matchAll(new RegExp(MARKER_RE.source, 'g'))]
    .map((match) => markerFrom(match[1]))
    .filter((marker): marker is FleetMarker => marker !== null);
}

/**
 * What may follow a review's own marker: the seat tag and the signature
 * `signBody` puts at the end, as `SEAT_TAG` in `stamp.ts` reads them; copied
 * here so this module, which every package reads, depends on nothing.
 */
const AFTER_OWN_MARKER = /^\s*(?:<!-- fleet(?:adlc)?-seat:[a-z0-9][a-z0-9._-]* -->\s*)?(?:<!-- fleet(?:adlc)?-sig:[^>]*-->\s*)?$/i;

/**
 * The `review_posted` marker a review ends with, which is its verdict, or null
 * when the review does not end with one.
 *
 * A marker quoted earlier in a review — a line of the diff it reviews, a skill
 * that describes the marker, a code block — is not the verdict. The merge gate
 * for a change to how CI runs read the first marker, so an `approve` a builder
 * planted in the diff and the security reviewer quoted while asking for
 * changes let the change merge. And the last marker is not enough on its own:
 * in a review with no marker of its own, the last one is a quoted one.
 */
export function ownReviewMarker(body: string | null | undefined): FleetMarker | null {
  const text = body ?? '';
  const last = [...text.matchAll(new RegExp(MARKER_RE.source, 'g'))].at(-1);
  if (!last || !AFTER_OWN_MARKER.test(text.slice((last.index ?? 0) + last[0].length))) return null;
  const marker = markerFrom(last[1]);
  return marker?.event === 'review_posted' ? marker : null;
}

/**
 * Whether a review's own marker accepts a widening of the change's scope:
 * `"scope":"cross-cutting"` on the `review_posted` it ends with. Who wrote
 * the review, and whether its signature checks, is the caller's to ask.
 */
export function acceptsCrossCutting(body: string | null | undefined): boolean {
  return ownReviewMarker(body)?.scope === 'cross-cutting';
}

/** A stage asking to send its work back to the one before it, and why. */
export interface SendBackRequest {
  to: string;
  reason: string;
}

/**
 * The send-back a session's output asks for, or null when it asks none.
 *
 * A task that finds its input cannot be worked from — a design that misses
 * what the issue asks, an issue that cannot be built as filed, a deploy that
 * fails on the change itself — ends with
 *
 *     <!-- fleetadlc:{"event":"send_back","to":"spec","reason":"the design names no migration for the new column"} -->
 *
 * Only the runner reads this, from its own session's output, and posts it to
 * the bridge with the task's token. A marker in a comment on GitHub is a
 * record of a send-back that already happened, never a request for one:
 * anyone who can comment could write it. A marker with no reason asks for
 * nothing, because the receiving stage acts on the reason.
 */
export function parseSendBack(body: string): SendBackRequest | null {
  const marker = parseMarkers(body).find((one) => one.event === 'send_back');
  if (!marker) return null;
  const to = typeof marker.to === 'string' ? marker.to.trim() : '';
  const reason = typeof marker.reason === 'string' ? marker.reason.trim() : '';
  if (!to || !reason) return null;
  return { to, reason };
}

/**
 * Text a person wrote, made safe to post through a crew account.
 *
 * What the console posts for a person goes out as the bot, with the bot's
 * seat tag and signature, and was posted as written: a hidden
 * `<!-- fleetadlc:{...} -->` in it reached the webhook as the bot's own
 * marker. A `design_memory` one rewrote the repository's accepted decisions,
 * which only an admin may edit, and a trailing seat tag replaced the real
 * one. Every `<!--` becomes `&lt;!--`, which GitHub shows as the characters
 * typed, so the words stay readable and quoted markup stays quoted; nothing
 * in it opens a comment any more. Only the person's part of a post goes
 * through this: the bridge's own markers around it stay live.
 */
export function inertMarkup(text: string): string {
  return text.replace(/<!--/g, '&lt;!--');
}

/**
 * What a message says to a person, with its markers taken out.
 *
 * A bot asking in its own words ends the message with a `question` marker, and
 * the gate that opens shows the question to whoever answers it. The marker is
 * addressed to the bridge; left in, it is an HTML comment the console prints
 * as text. A line that held nothing but a marker goes with it.
 */
export function withoutMarker(body: string): string {
  return body
    .replace(/^[ \t]*<!--\s*(?:fleetadlc|fleet):\{[\s\S]*?\}\s*-->[ \t]*(?:\r?\n|$)/gm, '')
    .replace(/[ \t]*<!--\s*(?:fleetadlc|fleet):\{[\s\S]*?\}\s*-->/g, '')
    .trim();
}

/**
 * The choices a marker offers, in its order, or none, which asks for an answer
 * in the person's own words. A choice offered twice is offered once: a model
 * repeating itself is not a second answer to pick.
 */
export function markerOptions(marker: FleetMarker): string[] {
  if (!Array.isArray(marker.options)) return [];
  const seen = new Set<string>();
  return marker.options
    .filter((option): option is string => typeof option === 'string')
    .map((option) => option.trim())
    .filter((option) => {
      const key = option.toLowerCase();
      if (option.length === 0 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The paths a task asks to add to what its lease lets it write, and why. */
export interface PlanChangeRequest {
  paths: string[];
  reason: string;
}

/** The answers to a plan-change request. Only the first grants anything. */
export const PLAN_CHANGE_APPROVE = 'Approve';
export const PLAN_CHANGE_REFUSE = 'Refuse';

/** The cost-cap gate's two answers that end the task rather than resuming it. */
export const COST_CAP_HAND_OFF = 'hand to a person';
export const COST_CAP_ABANDON = 'abandon this task';

const CONTINUE_FOR = /^continue for another \$(\d+(?:\.\d+)?)$/;

/**
 * The question a task at its cost cap asks, and its choices.
 *
 * The runner asks it and the bridge acts on the answer, so both read it from
 * here. Answering "continue" used to change nothing: the cap stayed where it
 * was, and the resumed session stopped on its first headroom check with no
 * question left open to answer.
 *
 * `stepUsd` is the install's per-task cap, which is what "continue" adds. It
 * is not the task's cap: that grows with every yes, and offering it would
 * double the offer each time.
 */
export function costCapGate(input: { capUsd: number; stepUsd: number; spentUsd: number; subjectRef: string }): {
  question: string;
  options: string[];
} {
  return {
    question: `Stopped at the $${input.capUsd} cap on ${input.subjectRef} after $${input.spentUsd.toFixed(2)}. How should I proceed?`,
    options: [`continue for another $${input.stepUsd}`, COST_CAP_HAND_OFF, COST_CAP_ABANDON],
  };
}

/**
 * What an answer to a cost-cap gate asks for: more money, the end of the task,
 * or nothing this gate knows (`null`: not a cost-cap gate, or words that are
 * not one of its choices, which go to the bot as they are).
 */
export function costCapAnswer(
  answer: string,
  options: readonly string[],
): { raiseUsd: number } | { end: typeof COST_CAP_HAND_OFF | typeof COST_CAP_ABANDON } | null {
  const [more, handOff, abandon] = options;
  const offered = more ? CONTINUE_FOR.exec(more) : null;
  if (options.length !== 3 || !offered || handOff !== COST_CAP_HAND_OFF || abandon !== COST_CAP_ABANDON) return null;
  if (answer === more) return { raiseUsd: Number(offered[1]) };
  if (answer === COST_CAP_HAND_OFF || answer === COST_CAP_ABANDON) return { end: answer };
  return null;
}

/**
 * The paths a request names that can be granted, in the order it names them.
 *
 * Every path is written into the issue's Expected paths, one line each, so one
 * that could carry a second line, a heading or a sentence is refused, as is one
 * that leaves the repository or names nothing a glob has been taken off.
 */
export function normalisePlanPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const seen = new Set<string>();
  const granted: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== 'string') continue;
    const path = entry.trim().replace(/^\.\//, '');
    if (path.length === 0 || path.length > 200) continue;
    // A brace group is expanded when the issue is read. One line of `{a,b}`
    // repeated named millions of paths and exhausted the bridge. A plan
    // change lists the files; it does not carry the expansion.
    if (/[\s`\\{}\u0000-\u001f\u007f]/.test(path)) continue;
    if (path.startsWith('/') || path.split('/').includes('..')) continue;
    if (path.replace(/\*+$/, '').length === 0) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    granted.push(path);
  }
  return granted;
}

/** A question a bot asked a person, as the message that asked it says. */
export interface AskedQuestion {
  /** What the person is asked. */
  question: string;
  /** The choices as the bot ordered them, the likely answer first. None for an open question. */
  options: string[];
  /**
   * Whether it offers no choices, so the person answers in their own words.
   * Every question takes their own words; an open one takes nothing else.
   */
  open: boolean;
  /** What the bot said before it asked: what it found, and why it asks. Empty when the whole message is the question. */
  context: string;
  /** The person it is for, when the marker names one. */
  addressedTo: string | null;
  /** Question markers after the first, which are not asked: one message asks one question. */
  ignored: number;
  /** Set when the message asks to widen the task's paths rather than a question of its own. */
  planChange: PlanChangeRequest | null;
}

/**
 * The question a message asks, or null when it asks none.
 *
 * A bot asks one question at a time, because the answer can change what it
 * assumed and so what it needs to ask next. The marker carries the question and
 * its choices, and the text before it is the context:
 *
 *     The repository has no web root yet.
 *     <!-- fleetadlc:{"event":"question","question":"Where should the page go?","options":["index.html at the root","A different path"]} -->
 *
 * A marker with no choices asks in the person's own words, which is what
 * `"open": true` says it means to. A marker with no `question` is the older
 * kind, whose whole message is the question, so a skill written for it still
 * asks. Only the first question marker is asked.
 *
 * A `plan_change` marker is asked the same way, as a question with two choices:
 * a task that needs to write outside its lease's paths names the paths and why,
 * and pauses until a person approves or refuses.
 *
 *     <!-- fleetadlc:{"event":"plan_change","paths":["apps/hostd/src/skill-runner.ts"],"reason":"the runner drops the field"} -->
 */
export function parseQuestion(body: string): AskedQuestion | null {
  const questions = parseMarkers(body).filter((marker) => marker.event === 'question' || marker.event === 'plan_change');
  const marker = questions[0];
  if (!marker) return null;

  const said = withoutMarker(body);
  const addressedTo = typeof marker.addressedTo === 'string' ? marker.addressedTo.trim() : '';
  const ignored = questions.length - 1;

  if (marker.event === 'plan_change') {
    const paths = normalisePlanPaths(marker.paths);
    const reason = typeof marker.reason === 'string' ? marker.reason.trim() : '';
    const context = [said, reason ? `Reason: ${reason}` : ''].filter(Boolean).join('\n\n');
    if (paths.length === 0) {
      return {
        question: 'A plan change named no path that can be granted. How should I proceed?',
        options: [],
        open: true,
        context,
        addressedTo: addressedTo || null,
        ignored,
        planChange: null,
      };
    }
    return {
      question: `Add ${paths.map((path) => `\`${path}\``).join(', ')} to this issue's Expected paths?`,
      options: [PLAN_CHANGE_APPROVE, PLAN_CHANGE_REFUSE],
      open: false,
      context,
      addressedTo: addressedTo || null,
      ignored,
      planChange: { paths, reason },
    };
  }

  const asked = typeof marker.question === 'string' ? marker.question.trim() : '';
  const options = markerOptions(marker);

  return {
    question: asked || said,
    options,
    open: options.length === 0,
    context: asked ? said : '',
    addressedTo: addressedTo || null,
    ignored,
    planChange: null,
  };
}

/** A question of one line, as a question asked in its marker is, stands out; one asked the older way is left as it was written. */
function emphasised(question: string): string {
  const text = question.trim();
  return text.includes('\n') || text.includes('**') ? text : `**${text}**`;
}

/**
 * A gate is a question that holds one bot's work until a person answers.
 *
 * On an issue this comment is all of the question a person sees: the context
 * the bot gave, the question, and its choices. Every question takes an answer
 * in the person's own words, so the comment says so; a question with choices
 * takes a number too.
 */
export function renderGateComment(input: {
  bot: string;
  taskId: string;
  question: string;
  options: string[];
  /** What the bot found and why it asks, said before the question. */
  context?: string | null;
  addressedTo?: string;
}): string {
  const options = input.options.map((option, index) => `${index + 1}. ${option}`).join('\n');
  const to = input.addressedTo ? ` @${input.addressedTo}` : '';
  const context = input.context?.trim();
  return [
    `**${input.bot} needs a decision.**${to}`,
    '',
    ...(context ? [context, ''] : []),
    emphasised(input.question),
    '',
    ...(options ? [options, ''] : []),
    options
      ? 'Reply with a number, or in your own words. This task is paused until you do.'
      : 'Reply in your own words. This task is paused until you do.',
    renderMarker({
      event: 'question',
      taskId: input.taskId,
      bot: input.bot,
      options: input.options,
      ...(input.addressedTo ? { addressedTo: input.addressedTo } : {}),
    }),
  ].join('\n');
}

/** Map a human reply back onto the option list; free text passes through. */
export function resolveAnswer(reply: string, options: readonly string[]): string {
  const trimmed = reply.trim();
  const asNumber = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(asNumber) && String(asNumber) === trimmed) {
    const chosen = options[asNumber - 1];
    if (chosen) return chosen;
  }
  const matched = options.find((option) => option.toLowerCase() === trimmed.toLowerCase());
  return matched ?? trimmed;
}

/**
 * Where an event belongs in a bot's thread.
 *
 * The kinds already exist and the console already renders them differently, so
 * an event that is a milestone reads as one rather than as more narration. A
 * comment with no marker keeps whatever kind its caller chose — an operator's
 * own comment is never reinterpreted.
 */
export function messageKindFor(event: FleetEventType): 'sys' | 'bot' | 'gate' | 'draft' {
  switch (event) {
    case 'question':
    case 'plan_change':
      return 'gate';
    // The plan is what the work is going to be, posted before it happens.
    case 'plan_posted':
      return 'draft';
    // Milestones: things that happened, rather than things the bot said.
    case 'pr_opened':
    case 'pr_ready':
    case 'review_posted':
    case 'deploy_done':
    case 'verified':
    case 'answered':
    case 'stopped':
    // What the design asks the repository to remember; the design itself is the comment it ends.
    case 'design_memory':
    case 'send_back':
      return 'sys';
    default:
      return 'bot';
  }
}

/** One line a person reads, for each event. */
const HEADLINES: Record<FleetEventType, string> = {
  plan_posted: 'posted the plan',
  question: 'needs a decision',
  plan_change: 'asked to widen its paths',
  answered: 'got an answer',
  pr_opened: 'opened a pull request',
  pr_ready: 'marked the pull request ready',
  review_posted: 'posted a review',
  deploy_done: 'finished a deploy',
  verified: 'verified the change',
  stopped: 'stopped',
  design_memory: 'proposed what the repository should remember',
  send_back: 'sent the work back',
};

export function headlineFor(event: FleetEventType): string {
  return HEADLINES[event];
}

/**
 * The marker an issue OpenADLC files for itself carries, so a job, an alert or
 * a failed deploy that fires again finds the issue it already filed.
 */
export function dedupeMarker(kind: string, key: string): string {
  return `<!-- ${MARKER_PREFIX}${kind}:${key} -->`;
}

/** Whether a body carries that marker, under the current prefix or the one issues were filed with before the rename. */
export function carriesDedupeMarker(body: string | null | undefined, kind: string, key: string): boolean {
  const text = body ?? '';
  return text.includes(dedupeMarker(kind, key)) || text.includes(`<!-- ${LEGACY_MARKER_PREFIX}${kind}:${key} -->`);
}

/** What a design asks a repository to remember, as one entry of a `design_memory` marker. */
export interface DesignMemoryProposal {
  kind: 'decision' | 'constraint' | 'convention' | 'glossary';
  title: string;
  body: string;
  /** The id, or the title, of an entry in effect that this one replaces. */
  supersedes?: string;
}

const MEMORY_KINDS = new Set(['decision', 'constraint', 'convention', 'glossary']);

/** The most entries one design comment proposes; more is a design that is a document, not a summary. */
export const DESIGN_MEMORY_PER_COMMENT = 12;

/**
 * The entries a design comment proposes, from its `design_memory` marker.
 *
 * The design stage's comment ends with it:
 * `<!-- fleetadlc:{"event":"design_memory","entries":[{"kind":"decision","title":"…","body":"…"}]} -->`.
 * Only the comment's last marker is read. An entry the bridge cannot use — no kind it knows, no title, no body — is
 * dropped rather than stored half-read, and a title or a body is cut to a
 * length a summary has, because every one is given to every design task.
 */
export function designMemoryProposals(body: string): DesignMemoryProposal[] {
  // The comment's own marker is its last. The first anywhere took one quoted
  // further up — from another comment, an issue, a person's words — and a
  // quote planted lasting instructions for every later design.
  const marker = parseMarkers(body).at(-1);
  if (!marker || marker.event !== 'design_memory' || !Array.isArray(marker.entries)) return [];
  const proposals: DesignMemoryProposal[] = [];
  for (const raw of marker.entries as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const kind = typeof entry.kind === 'string' ? entry.kind.trim().toLowerCase() : '';
    const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, 140) : '';
    const text = typeof entry.body === 'string' ? entry.body.trim().slice(0, 2000) : '';
    if (!MEMORY_KINDS.has(kind) || !title || !text) continue;
    const supersedes = typeof entry.supersedes === 'string' && entry.supersedes.trim() ? entry.supersedes.trim() : undefined;
    proposals.push({ kind: kind as DesignMemoryProposal['kind'], title, body: text, ...(supersedes ? { supersedes } : {}) });
    if (proposals.length === DESIGN_MEMORY_PER_COMMENT) break;
  }
  return proposals;
}
