import type { insights } from '@fleetadlc/db';
import { hasIgnoreLabel } from '@fleetadlc/shared';
import { FULL_REVIEW_WHY } from './conflict-round.js';

type InsightData = insights.InsightData;

/**
 * How fast work moves, and what holds it up, over a window: what the Insights
 * page reads. Counted here, from plain rows, so it can be tested without a
 * database.
 *
 * Its reason to exist is the overlap rule. Issues that touch the same file
 * wait for each other, and a Makefile or a README touched by every change made
 * a repository build one thing at a time; whether a change to that rule helps
 * is only known by measuring the waiting before and after.
 */
export interface StageTimes {
  intake: number | null;
  design: number | null;
  build: number | null;
  review: number | null;
  mergeLine: number | null;
}

export interface HotFile {
  path: string;
  /** How many times an issue waited on it. */
  waits: number;
  /** How long those waits took, where they have ended, in ms. */
  waitedMs: number;
}

export interface InsightSummary {
  /** Issues merged in the window. */
  merged: number;
  /** Merged per day over the window. */
  perDay: number;
  /** Median time from the request (or the issue's first stage) to its merge, in ms; null with nothing merged. */
  cycleMs: number | null;
  /** Median time in each stage, in ms, over issues that left it in the window. */
  stages: StageTimes;
  overlap: {
    waits: number;
    /** By why it waited: on another's exclusive file, or on a file being built. */
    byKind: { exclusive: number; building: number };
    totalWaitMs: number;
    medianWaitMs: number | null;
    hotFiles: HotFile[];
  };
  conflicts: { resolvedLeadOnly: number; resolvedFull: number; sentBack: number; resolving: number };
  /** Send-backs in the window, by the stage they left. */
  sendBacks: Record<string, number>;
  /** Builds running at once: the most, and the average while any ran. */
  parallel: { max: number; average: number };
}

export interface Insights {
  days: number;
  since: string;
  overall: InsightSummary;
  repos: ({ repo: string } & InsightSummary)[];
  /** A file that held up three or more builds in the window, as the page suggests splitting it. */
  suggestions: { repo: string; path: string; waits: number; text: string }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_REVIEWED: ReadonlySet<string> = new Set(Object.values(FULL_REVIEW_WHY));

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

interface Payload {
  repo?: unknown;
  issue?: unknown;
  paths?: unknown;
  kind?: unknown;
  waitedMs?: unknown;
  review?: unknown;
  why?: unknown;
}

const asPayload = (value: unknown): Payload => (value && typeof value === 'object' ? (value as Payload) : {});
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asPaths = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []);

/** The window's numbers for one repository, or for all of them when `repoId` is null. */
function summarise(data: InsightData, options: { since: number; now: number; repoId: string | null; repoName: string | null }): InsightSummary {
  const { since, now, repoId, repoName } = options;
  const mine = <T extends { repoId: string | null }>(rows: readonly T[]) => (repoId ? rows.filter((row) => row.repoId === repoId) : rows);
  // Events name a repository by name; one without a name counts only overall.
  const eventsHere = data.events.filter((event) => {
    const repo = asString(asPayload(event.payload).repo);
    return !repoName || repo === repoName || repo?.endsWith(`/${repoName}`);
  });

  // Moves per issue, in order.
  const byIssue = new Map<string, InsightData['moves']>();
  for (const move of mine(data.moves)) {
    const key = `${move.repoId}#${move.issueNumber}`;
    byIssue.set(key, [...(byIssue.get(key) ?? []), move]);
  }

  // What merged in the window, and how long it took from the request.
  const requested = new Map(mine(data.requests).map((request) => [`${request.repoId}#${request.issueNumber}`, Date.parse(request.createdAt)]));
  const cycles: number[] = [];
  let merged = 0;
  const stageSpans: Record<keyof StageTimes, number[]> = { intake: [], design: [], build: [], review: [], mergeLine: [] };
  const STAGE_KEY: Record<string, keyof StageTimes | undefined> = { intake: 'intake', spec: 'design', build: 'build', review: 'review' };
  for (const [key, moves] of byIssue) {
    // Merged, or straight from review to done: a repository that deploys
    // nothing ships by merging, and its issues never pass through `merged` —
    // read only as moves to merged, eight merges in a day counted as none.
    const landed = moves.find(
      (move) =>
        (move.to === 'merged' || (move.to === 'done' && move.from === 'review')) && Date.parse(move.at) >= since && Date.parse(move.at) <= now,
    );
    if (landed) {
      merged += 1;
      const start = requested.get(key) ?? Date.parse(moves[0]!.at);
      cycles.push(Date.parse(landed.at) - start);
    }
    // Time in a stage: from the move into it to the move out of it, for a
    // stay that ended in the window.
    for (let index = 0; index < moves.length - 1; index += 1) {
      const stay = moves[index]!;
      const left = moves[index + 1]!;
      const stage = STAGE_KEY[stay.to];
      if (!stage || Date.parse(left.at) < since) continue;
      stageSpans[stage].push(Date.parse(left.at) - Date.parse(stay.at));
    }
  }
  for (const entry of mine(data.landed)) stageSpans.mergeLine.push(Date.parse(entry.mergedAt) - Date.parse(entry.enteredAt));

  // Waiting on overlap: each wait, attributed to the paths it waited on; how
  // long, from the event that says it cleared. Read in order, each clear
  // credits the wait it ended: read all waits first, every clear went to the
  // issue's last wait, so a later minute on README.md took the hundred an
  // earlier wait spent on Makefile. A wait whose holder changed has several
  // waited events and one clear, and the time goes to every path it waited on.
  const waited = eventsHere.filter((event) => event.type === 'overlap.waited');
  const overlapEvents = eventsHere
    .filter((event) => event.type === 'overlap.waited' || event.type === 'overlap.cleared')
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const durations: number[] = [];
  const files = new Map<string, HotFile>();
  const openWaits = new Map<string, Set<string>>();
  for (const event of overlapEvents) {
    const payload = asPayload(event.payload);
    const key = `${asString(payload.repo)}#${asNumber(payload.issue)}`;
    if (event.type === 'overlap.waited') {
      const paths = asPaths(payload.paths);
      const open = openWaits.get(key) ?? new Set<string>();
      for (const path of paths) {
        open.add(path);
        const file = files.get(path) ?? { path, waits: 0, waitedMs: 0 };
        file.waits += 1;
        files.set(path, file);
      }
      openWaits.set(key, open);
      continue;
    }
    const ms = asNumber(payload.waitedMs);
    const open = openWaits.get(key);
    openWaits.delete(key);
    if (ms === null) continue;
    durations.push(ms);
    for (const path of open ?? []) {
      const file = files.get(path);
      if (file) file.waitedMs += ms;
    }
  }
  const byKind = { exclusive: 0, building: 0 };
  for (const event of waited) {
    const kind = asString(asPayload(event.payload).kind);
    if (kind === 'exclusive' || kind === 'building') byKind[kind] += 1;
  }

  const conflicts = { resolvedLeadOnly: 0, resolvedFull: 0, sentBack: 0, resolving: 0 };
  for (const event of eventsHere) {
    if (event.type === 'conflict.resolving') conflicts.resolving += 1;
    // A resolution reviewed again in full records one too, with its reason;
    // that pull request did not go back to Build, and is counted as reviewed in full.
    if (event.type === 'conflict.sent_back' && !FULL_REVIEWED.has(asString(asPayload(event.payload).why) ?? '')) conflicts.sentBack += 1;
    if (event.type === 'conflict.resolved') {
      if (asString(asPayload(event.payload).review) === 'full') conflicts.resolvedFull += 1;
      else conflicts.resolvedLeadOnly += 1;
    }
  }

  const sendBacks: Record<string, number> = {};
  for (const move of mine(data.moves)) {
    if (move.kind !== 'send_back' || Date.parse(move.at) < since) continue;
    const from = move.from ?? 'unknown';
    sendBacks[from] = (sendBacks[from] ?? 0) + 1;
  }

  return {
    merged,
    perDay: Math.round((merged / Math.max(1, (now - since) / DAY_MS)) * 100) / 100,
    cycleMs: median(cycles),
    stages: {
      intake: median(stageSpans.intake),
      design: median(stageSpans.design),
      build: median(stageSpans.build),
      review: median(stageSpans.review),
      mergeLine: median(stageSpans.mergeLine),
    },
    overlap: {
      waits: waited.length,
      byKind,
      totalWaitMs: durations.reduce((total, ms) => total + ms, 0),
      medianWaitMs: median(durations),
      hotFiles: [...files.values()].sort((a, b) => b.waits - a.waits || b.waitedMs - a.waitedMs).slice(0, 10),
    },
    conflicts,
    sendBacks,
    parallel: parallelBuilds(mine(data.builds), since, now),
  };
}

/** The most builds running at one moment in the window, and the average while at least one ran. */
export function parallelBuilds(builds: readonly { startedAt: string | null; endedAt: string | null }[], since: number, now: number): { max: number; average: number } {
  const edges: { at: number; change: number }[] = [];
  for (const build of builds) {
    if (!build.startedAt) continue;
    const start = Math.max(since, Date.parse(build.startedAt));
    const end = Math.min(now, build.endedAt ? Date.parse(build.endedAt) : now);
    if (end <= start) continue;
    edges.push({ at: start, change: 1 }, { at: end, change: -1 });
  }
  // Ends before starts at one moment, so back-to-back builds are not two at once.
  edges.sort((a, b) => a.at - b.at || a.change - b.change);
  let running = 0;
  let max = 0;
  let busy = 0;
  let weighted = 0;
  let last = 0;
  for (const edge of edges) {
    if (running > 0) {
      busy += edge.at - last;
      weighted += (edge.at - last) * running;
    }
    running += edge.change;
    max = Math.max(max, running);
    last = edge.at;
  }
  return { max, average: busy > 0 ? Math.round((weighted / busy) * 100) / 100 : 0 };
}

/**
 * The data without the issues labelled `fleetadlc:ignore` and their pull
 * requests: a person's work, which no count on the console includes
 * (`ignoredSubjects`). The builds carry no issue, and stay.
 */
export function withoutIgnored(
  data: InsightData,
  issues: readonly { repoId: string; repoName: string; number: number; prNumber: number | null; labels: readonly string[] }[],
): InsightData {
  const ignored = issues.filter((issue) => hasIgnoreLabel(issue.labels));
  if (ignored.length === 0) return data;
  const issueKeys = new Set(ignored.map((issue) => `${issue.repoId}#${issue.number}`));
  const pullKeys = new Set(ignored.filter((issue) => issue.prNumber !== null).map((issue) => `${issue.repoId}#${issue.prNumber}`));
  // An event names its repository by name or as owner/name.
  const inEvent = (payload: unknown): boolean => {
    const { repo, issue } = asPayload(payload);
    const name = typeof repo === 'string' ? repo.slice(repo.lastIndexOf('/') + 1) : null;
    return ignored.some((one) => one.repoName === name && one.number === issue);
  };
  return {
    ...data,
    moves: data.moves.filter((move) => !issueKeys.has(`${move.repoId}#${move.issueNumber}`)),
    requests: data.requests.filter((request) => !issueKeys.has(`${request.repoId}#${request.issueNumber}`)),
    landed: data.landed.filter((entry) => !pullKeys.has(`${entry.repoId}#${entry.prNumber}`)),
    events: data.events.filter((event) => !inEvent(event.payload)),
  };
}

export function aggregateInsights(data: InsightData, options: { days: number; now?: Date; repo?: string | null }): Insights {
  const now = (options.now ?? new Date()).getTime();
  const since = now - options.days * DAY_MS;
  const named = options.repo ? data.repos.filter((repo) => repo.name === options.repo) : data.repos;
  const overall = options.repo && named[0]
    ? summarise(data, { since, now, repoId: named[0].id, repoName: named[0].name })
    : summarise(data, { since, now, repoId: null, repoName: null });
  const repos = named.map((repo) => ({ repo: repo.name, ...summarise(data, { since, now, repoId: repo.id, repoName: repo.name }) }));
  const period = options.days === 7 ? 'this week' : `in the last ${options.days} days`;
  const suggestions = repos.flatMap((repo) =>
    repo.overlap.hotFiles
      .filter((file) => file.waits >= 3)
      .map((file) => ({
        repo: repo.repo,
        path: file.path,
        waits: file.waits,
        text: `${file.path} held up ${file.waits} builds ${period}${splitHint(file.path)}`,
      })),
  );
  return { days: options.days, since: new Date(since).toISOString(), overall, repos, suggestions };
}

/** How a file that holds work up is usually split, where there is a usual way. */
function splitHint(path: string): string {
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  if (name === 'makefile' || name === 'gnumakefile') return ' — consider splitting it (include mk/*.mk, one file per feature)';
  if (name === 'readme.md') return ' — consider per-feature pages under docs/, linked from it';
  if (name === 'package.json') return ' — consider one script per feature, or a workspace per package';
  return ' — consider splitting it so each change adds a file rather than editing this one';
}
