import { attachments, issues, repos, requests, threads } from '@fleetadlc/db';
import { pathMatches } from '@fleetadlc/dispatcher';
import {
  DEFAULT_PATH_POLICY,
  declaredPathsFrom,
  deliveryRulesFrom,
  hasIgnoreLabel,
  type ContextDocument,
  type Gate,
  type Message,
  type PathPolicy,
  type StageKey,
  type StageMode,
} from '@fleetadlc/shared';
import { readUnowned, settingsStore, type UnownedIssue, type UnownedStore } from './unowned-issues.js';

/**
 * What a console request's triage reads.
 *
 * A request filed from the console's New request form is a row, not an issue:
 * the issue is what triage makes of it. Its task's subject is
 * `request:<the first eight characters of its id>`, and every task on an issue
 * is briefed by reading that issue from GitHub — so a request's triage was
 * briefed with nothing at all, and the bot said, correctly, that the request
 * was nowhere it could reach.
 */

/** The name the triage skill knows the request by. */
export const REQUEST_DOCUMENT = 'request.md';

/**
 * The same request as design reads it, once intake has filed it: what the
 * person asked for and every answer they gave, which the issue summarises
 * and design needs whole: design is the only stage with memory and context.
 */
export const INTAKE_DOCUMENT = 'intake.md';

/** The id prefix a request's subject carries, or null when the subject is not a request. */
export function requestPrefixOf(subjectRef: string): string | null {
  const match = /^request:([0-9a-f-]+)$/i.exec(subjectRef.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * The line the issue triage files carries in its body, which is how the bridge
 * finds that issue again once the task has ended.
 */
export function requestLineFor(subjectRef: string): string {
  return `OpenADLC request: ${subjectRef}`;
}

/** The request a subject names. A prefix two requests share is refused by the store. */
export async function requestFor(subjectRef: string): Promise<requests.RequestRecord | null> {
  const prefix = requestPrefixOf(subjectRef);
  return prefix ? requests.findRequestByPrefix(prefix) : null;
}

function renderGate(gate: Gate): string {
  const options =
    gate.options.length > 0
      ? gate.options.map((option, index) => `${index + 1}. ${option}`).join('\n')
      : '_None: the answer was theirs to word._';
  return [
    `### A question, answered by ${gate.answeredBy ?? 'somebody'} at ${gate.answeredAt ?? 'an unrecorded time'}`,
    '',
    '**Asked:**',
    '',
    gate.question.trim(),
    '',
    '**Choices offered:**',
    '',
    options,
    '',
    `**Answer:** ${gate.answer?.trim() || '_empty_'}`,
  ].join('\n');
}

function renderMessage(message: Message): string {
  return [`### ${message.author} wrote, at ${message.at}`, '', message.text.trim()].join('\n');
}

export interface RequestBriefing {
  request: requests.RequestRecord;
  subjectRef: string;
  /** `owner/name`, or null when the request named no repository. */
  repoFullName: string | null;
  /** The answered gates on the subject's tasks. */
  gates: Gate[];
  /** What the person wrote in the thread, other than their answers to those gates. */
  messages: Message[];
  /** The files given with it, by name; the files themselves are in the task's `attachments.md`. */
  files?: readonly { name: string; mediaType: string; sizeBytes: number }[];
  /** Its work item in the console, which the filed issue links to instead of to any file. */
  itemLink?: string | null;
}

/** The request as triage reads it (`request.md`), or as design reads it once filed (`intake.md`). */
export type RequestReading = 'triage' | 'design';

/**
 * The request as a document: what was asked, by whom and where, and the
 * conversation since — each question with its answer, and anything else the
 * person wrote — in the order it happened. A resumed triage starts a fresh
 * session, so this is how it learns what it was told.
 */
export function renderRequest(input: RequestBriefing, reading: RequestReading = 'triage'): ContextDocument {
  const { request, subjectRef } = input;
  const files = input.files ?? [];
  const filesSection = [
    '## Files given with it',
    '',
    files.length > 0
      ? [
          ...files.map((file) => `- ${file.name} (${file.mediaType}, ${Math.max(1, Math.round(file.sizeBytes / 1024))} kB)`),
          '',
          'Each is in `attachments.md` with where it is; open it with your file tool. They are kept in OpenADLC and are',
          'never on GitHub: name them, and link to the work item below rather than to a file.',
        ].join('\n')
      : '_None._',
  ];
  const linkLine = input.itemLink ? [`- **Work item in the console:** ${input.itemLink}`] : [];
  if (reading === 'design') {
    return {
      name: INTAKE_DOCUMENT,
      title: `What intake learned from the person who asked: ${subjectRef}`,
      content: [
        `# ${subjectRef}: the request this issue was filed from`,
        '',
        'Intake clarified this with the person who asked before it filed the issue. The issue is its summary; this is',
        'what was said, whole: read it for what the issue leaves out, and do not ask again what was answered here.',
        '',
        `- **Asked by:** ${request.requestedBy}, at ${request.createdAt}`,
        `- **Kind:** ${request.kind?.trim() || '_not given_'}`,
        `- **Repository:** ${input.repoFullName ?? '_none named_'}`,
        ...linkLine,
        '',
        '## What they asked for',
        '',
        request.text.trim(),
        '',
        '## The detail they gave',
        '',
        request.context?.trim() || '_None._',
        '',
        ...filesSection,
        '',
        '## What intake asked, and what they answered',
        '',
        conversation(input),
      ].join('\n'),
    };
  }

  const filed =
    request.issueNumber !== null
      ? [
          '',
          `It has already been filed as ${input.repoFullName ?? 'its repository'}#${request.issueNumber}. Do not file it again.`,
        ]
      : [];

  return {
    name: REQUEST_DOCUMENT,
    title: `The request you are triaging: ${subjectRef}`,
    content: [
      `# ${subjectRef}: a request from the console`,
      '',
      'Somebody filed this from the console. There is no issue for it yet; it becomes one when you file it.',
      '',
      `- **Asked by:** ${request.requestedBy}, at ${request.createdAt}`,
      `- **Kind:** ${request.kind?.trim() || '_not given_'}`,
      `- **Repository:** ${input.repoFullName ?? '_none named_'}`,
      `- **Request id:** ${request.id}`,
      ...linkLine,
      ...filed,
      '',
      'The issue you file carries this line in its body, exactly as written, so the request can be linked to it:',
      '',
      `    ${requestLineFor(subjectRef)}`,
      '',
      '## What they asked for',
      '',
      request.text.trim(),
      '',
      '## The context they added',
      '',
      request.context?.trim() || '_None._',
      '',
      ...filesSection,
      '',
      '## The conversation so far',
      '',
      conversation(input),
    ].join('\n'),
  };
}

/** Each question with its answer, and anything else the person wrote, in the order it happened. */
function conversation(input: Pick<RequestBriefing, 'gates' | 'messages'>): string {
  const said = [
    ...input.gates.map((gate) => ({ at: gate.answeredAt ?? '', text: renderGate(gate) })),
    ...input.messages.map((message) => ({ at: message.at, text: renderMessage(message) })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return said.length > 0
    ? said.map((entry) => entry.text).join('\n\n---\n\n')
    : '_Nothing yet: no question has been answered, and nobody has written in this thread._';
}

/** The console's address of a work item: what an issue links to in place of a file. */
export function itemLinkFor(consoleUrl: string | null | undefined, subjectRef: string): string | null {
  if (!consoleUrl) return null;
  return `${consoleUrl.replace(/\/+$/, '')}/?${new URLSearchParams({ item: subjectRef }).toString()}`;
}

/**
 * Reads a request and its conversation for a task about to start on it, or
 * null when the subject names no request. What the person wrote is read from
 * every thread about the subject, so a request a second bot picked up keeps
 * what was said to the first.
 */
export async function requestDocument(
  subjectRef: string,
  options: { consoleUrl?: string | null } = {},
): Promise<ContextDocument | null> {
  let request: requests.RequestRecord | null;
  try {
    request = await requestFor(subjectRef);
  } catch (error) {
    if (!(error instanceof requests.AmbiguousRequestPrefix)) throw error;
    return ambiguousRequest(subjectRef);
  }
  if (!request) return null;
  return briefingDocument(request, subjectRef, options, 'triage');
}

/**
 * `request.md` for a subject two requests share: a pair sent before migration
 * 0144 made a new one draw a fresh id. Neither is given, since a bot briefed
 * with somebody else's request files somebody else's issue, and an empty brief
 * left the bot saying the request was nowhere it could reach. Sending it again
 * gives it a subject of its own.
 */
function ambiguousRequest(subjectRef: string): ContextDocument {
  return {
    name: REQUEST_DOCUMENT,
    title: `The request you are triaging: ${subjectRef}`,
    content: [
      `# ${subjectRef}: more than one request`,
      '',
      `\`${subjectRef}\` names more than one request from the console, so OpenADLC cannot tell which one this is,`,
      'and it gives you neither rather than the wrong one.',
      '',
      'Do not file an issue, and do not ask a question. Say in your last message that this request could not be read',
      'because its subject names more than one request, and that the person should send it again from the console:',
      'sent again, it gets a subject of its own.',
    ].join('\n'),
  };
}

/**
 * The request an issue was filed from, as design reads it (`intake.md`), or
 * null for an issue nobody filed from the console. The newest, when one issue
 * was filed from two.
 */
export async function intakeDocument(
  issue: { repoId: string; number: number },
  options: { consoleUrl?: string | null } = {},
): Promise<ContextDocument | null> {
  const filed = await requests.listRequestsForIssue(issue.repoId, issue.number);
  const request = filed.at(-1);
  if (!request) return null;
  return briefingDocument(request, `request:${request.id.slice(0, 8)}`, options, 'design');
}

async function briefingDocument(
  request: requests.RequestRecord,
  subjectRef: string,
  options: { consoleUrl?: string | null },
  reading: RequestReading,
): Promise<ContextDocument> {
  const [repoList, gates, subjectThreads, files] = await Promise.all([
    request.repoId ? repos.listRepos() : Promise.resolve([]),
    threads.listGatesForSubject(subjectRef),
    threads.listThreadsForSubject(subjectRef),
    // A database a release behind has no table yet; the request is still read.
    (async () => attachments.listForSubjects([subjectRef]))().catch(() => [] as attachments.AttachmentMeta[]),
  ]);
  const messages = await threads.listMessages(subjectThreads.map((thread) => thread.id));

  const answered = gates.filter((gate) => gate.state === 'answered');
  // An answer is written into the thread as well as onto its gate. It is shown
  // once, under the question it answers.
  const answers = new Set(answered.map((gate) => gate.id));
  const written = messages.filter(
    (message) => message.kind === 'you' && !answers.has(String(message.payload?.gateId ?? '')),
  );

  return renderRequest(
    {
      request,
      subjectRef,
      repoFullName: repoList.find((repo) => repo.id === request.repoId)?.fullName ?? null,
      gates: answered,
      messages: written,
      files,
      itemLink: itemLinkFor(options.consoleUrl, subjectRef),
    },
    reading,
  );
}

/** The open work intake compares a draft with: `open-issues.md`. */
export const OPEN_WORK_DOCUMENT = 'open-issues.md';

/** An open issue as `open-issues.md` lists it. */
export interface OpenIssue {
  number: number;
  title: string;
  stage: StageKey;
  /** Its `Expected paths`, as the dispatcher leases them. */
  paths: string[];
}

/**
 * Every open issue in the repository with the files it will touch, for a
 * triage to compare its draft with before it asks to file it.
 *
 * Intake looked for duplicates and nothing else: a hello page and a snake
 * game were filed as two issues that both create `index.html` and both
 * rewrite the Makefile's checks, and whichever was built second would have
 * undone the first. The dispatcher only holds overlapping work apart in time;
 * how the two should fit is the person's to say.
 */
/**
 * The repository's spec rule, as triage is told it: which labels send an issue
 * to Design. Triage's skill said to label `adlc:spec` "when the repository's
 * spec rule matches" and nothing told it the rule, so it guessed, and the
 * bridge, which decides by the labels, moved its guesses on to Build.
 */
export function renderSpecRule(spec: { mode: StageMode; labels: readonly string[] }): string[] {
  const named = spec.labels.length > 0 ? spec.labels.map((label) => `\`${label}\``).join(', ') : '_none_';
  const rule =
    spec.mode === 'untouched'
      ? 'This repository does not design: every issue goes to Build. Never label one `adlc:spec`.'
      : spec.mode === 'autonomous'
        ? 'Every issue in this repository goes to Design before it is built: label it `adlc:spec`.'
        : 'An issue goes to Design only when it carries one of these labels, and to Build otherwise: label it `adlc:spec` if it does, `adlc:build` if not.';
  return [
    '## Design or Build',
    '',
    `Spec mode: \`${spec.mode}\`. The labels that send an issue to Design: ${named}.`,
    `Put on each of those labels that fits the issue. ${rule}`,
    'When your task ends the bridge sets the stage from these labels by this rule, whatever stage label you chose.',
  ];
}

export function renderOpenWork(
  repoFullName: string,
  open: readonly OpenIssue[],
  policy: PathPolicy = DEFAULT_PATH_POLICY,
  spec: { mode: StageMode; labels: readonly string[] } | null = null,
): ContextDocument {
  // Each path marked as the repository's path policy reads it, so intake asks
  // only about overlap that holds work back until merge — an exclusive path —
  // and says the rest: it asked how every request should fit with the Makefile.
  const marked = (path: string) => {
    if (policy.exclusive.some((pattern) => pathMatches(path, pattern))) return `\`${path}\` (exclusive)`;
    if (policy.shared.some((pattern) => pathMatches(path, pattern))) return `\`${path}\` (shared)`;
    return `\`${path}\``;
  };
  const lines = open.map((issue) => {
    const paths = issue.paths.length > 0 ? issue.paths.map(marked).join(', ') : '_none listed_';
    return `- **#${issue.number}** ${issue.title} (${issue.stage}): ${paths}`;
  });
  return {
    name: OPEN_WORK_DOCUMENT,
    title: `Open issues in ${repoFullName}, with their Expected paths`,
    content: [
      `The open issues in ${repoFullName} and the files each will touch, as their Expected paths say.`,
      "Before you ask to file, compare your draft's Expected paths with these: the triage skill says what to do when they overlap.",
      'A path marked (exclusive) is one two changes in flight break each other on: overlap there is worth asking about. A path marked (shared) never holds work back, and any other overlap holds it back only while the other change is being built: say those, do not ask.',
      '',
      ...(lines.length > 0 ? lines : ['_No open issues._']),
      ...(spec ? ['', ...renderSpecRule(spec)] : []),
    ].join('\n'),
  };
}

/** `open-issues.md` for a request's repository, or null when it names none. */
export async function openWorkDocument(subjectRef: string, unownedStore: UnownedStore = settingsStore): Promise<ContextDocument | null> {
  const request = await requestFor(subjectRef);
  if (!request?.repoId) return null;
  const repo = (await repos.listRepos()).find((one) => one.id === request.repoId);
  if (!repo) return null;
  return openWorkDocumentFor(repo, { unownedStore });
}

/**
 * `open-issues.md` for a repository: a console request's triage, and the
 * triage of an issue filed on GitHub, which leaves itself out (`except`).
 */
export async function openWorkDocumentFor(
  repo: { id: string; name: string; fullName: string; stageModes?: Record<string, StageMode>; specRequiredLabels?: string[] },
  options: { except?: number; unownedStore?: UnownedStore } = {},
): Promise<ContextDocument> {
  const unownedStore = options.unownedStore ?? settingsStore;
  // Not what nobody will build: an issue marked to ignore, or one OpenADLC
  // will not take on its own and a person has not decided about yet. Intake
  // asked how every request should fit with two such issues, filed by an old
  // crew account, that nothing was ever going to build.
  const unowned = new Set(((await readUnowned(unownedStore).catch(() => ({}) as Record<string, UnownedIssue[]>))[repo.name] ?? []).map((one) => one.number));
  const open = (await issues.listIssues(repo.name))
    .filter((issue) => issue.stage !== 'merged' && issue.stage !== 'done')
    .filter((issue) => !hasIgnoreLabel(issue.labels ?? []) && !unowned.has(issue.number) && issue.number !== options.except)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      stage: issue.stage,
      // The cached paths, else the body's, read the way the dispatcher reads them.
      paths: issue.declaredPaths.length > 0 ? issue.declaredPaths : declaredPathsFrom(issue.body),
    }))
    .sort((a, b) => a.number - b.number);
  // The repository's path policy as it was last stored, else the default:
  // reading the file itself needs GitHub, and this is a briefing.
  const stored = await (async () => repos.getDelivery(repo.id))().catch(() => null);
  // Both intake paths read this document, so this is where triage learns the
  // rule the bridge applies when it ends (`StageHandoff.afterIntake`).
  const spec = { mode: repo.stageModes?.spec ?? 'conditional', labels: repo.specRequiredLabels ?? [] };
  return renderOpenWork(repo.fullName, open, deliveryRulesFrom(null, stored?.deliveryRules ?? null).paths, spec);
}
