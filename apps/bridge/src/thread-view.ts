import { inertMarkup, type Gate } from '@fleetadlc/shared';
import { requestPrefixOf } from './request-context.js';
import { issueForSubject, parseRef, repoOfSubject, type IssueFacts } from './work.js';

/**
 * What a bot's thread is about, and where a message written in it goes.
 *
 * A thread is filed under a subject, `fleetadlc-testbed#31` or `request:a4b02784`,
 * which is an address rather than something a person reads. The console named
 * its filter chips with them, and a message written in the panel went to no
 * subject at all: it landed in a thread nothing reads, so a person's words
 * about a console request never reached its `request.md`. These are plain
 * functions over rows the route has already read.
 */

/** One subject a bot's thread is about, as a person would pick it. */
export interface ThreadTopic {
  ref: string;
  /**
   * `issue` and `pull_request` are on GitHub, where a message is posted as a
   * comment; `request` is a console request, whose thread its triage reads;
   * `other` is anything else, a deploy of a commit or no subject at all.
   */
  kind: 'issue' | 'pull_request' | 'request' | 'other';
  /**
   * The repository it is in, by name, for a thread whose subjects span several.
   * A console request's is the one it was made for, if any.
   */
  repo: string | null;
  /** The issue's title: its own, or the one the pull request closes. Null when the issue is not known here. */
  title: string | null;
  issue: { number: number; url: string | null } | null;
  pullRequest: { number: number; url: string | null } | null;
  /** What a console request asked for, and the issue it became once filed. */
  request: { text: string; issueNumber: number | null; state: string } | null;
}

interface RepoFacts {
  id: string;
  name: string;
  fullName: string;
}

interface RequestFacts {
  id: string;
  text: string;
  repoId: string | null;
  issueNumber: number | null;
  state: string;
}

/** An issue's page, for an issue the store has no link for. GitHub sends a pull request's number there on to the pull request. */
function issueUrl(repo: RepoFacts | undefined, number: number): string | null {
  return repo ? `https://github.com/${repo.fullName}/issues/${number}` : null;
}

function pullUrl(repo: RepoFacts | undefined, issue: Pick<IssueFacts, 'url'> | null, number: number): string | null {
  // The issue's own link says which GitHub it is on; the repository's name is the fallback.
  const fromIssue = issue?.url?.replace(/\/issues\/\d+$/, `/pull/${number}`);
  if (fromIssue && fromIssue !== issue?.url) return fromIssue;
  return repo ? `https://github.com/${repo.fullName}/pull/${number}` : null;
}

/** The request a `request:<prefix>` subject names, or null when none does or two might. */
export function requestNamed<T extends Pick<RequestFacts, 'id'>>(subjectRef: string, requests: readonly T[]): T | null {
  const prefix = requestPrefixOf(subjectRef);
  if (!prefix) return null;
  const matches = requests.filter((request) => request.id.toLowerCase().startsWith(prefix));
  return matches.length === 1 ? matches[0]! : null;
}

export function describeSubject(
  ref: string,
  facts: {
    issues: readonly Pick<IssueFacts, 'repoName' | 'number' | 'prNumber' | 'title' | 'url'>[];
    repos: readonly RepoFacts[];
    requests: readonly RequestFacts[];
  },
): ThreadTopic {
  const none = { title: null, issue: null, pullRequest: null, request: null };

  const parsed = parseRef(ref);
  if (parsed) {
    const repo = facts.repos.find((one) => one.name === parsed.repo);
    // Only a repository this install manages has a GitHub the bridge can post to.
    if (!repo) return { ref, kind: 'other', repo: parsed.repo, ...none };
    const issue = issueForSubject(ref, facts.issues);
    if (!issue) {
      return { ref, kind: 'issue', repo: repo.name, ...none, issue: { number: parsed.number, url: issueUrl(repo, parsed.number) } };
    }
    const isPullRequest = issue.number !== parsed.number;
    return {
      ref,
      kind: isPullRequest ? 'pull_request' : 'issue',
      repo: repo.name,
      title: issue.title,
      issue: { number: issue.number, url: issue.url ?? issueUrl(repo, issue.number) },
      pullRequest: issue.prNumber ? { number: issue.prNumber, url: pullUrl(repo, issue, issue.prNumber) } : null,
      request: null,
    };
  }

  const request = requestNamed(ref, facts.requests);
  if (request) {
    const repo = facts.repos.find((one) => one.id === request.repoId);
    return {
      ref,
      kind: 'request',
      repo: repo?.name ?? null,
      title: null,
      issue: request.issueNumber !== null ? { number: request.issueNumber, url: issueUrl(repo, request.issueNumber) } : null,
      pullRequest: null,
      request: { text: request.text, issueNumber: request.issueNumber, state: request.state },
    };
  }

  return { ref, kind: requestPrefixOf(ref) ? 'request' : 'other', repo: repoOfSubject(ref), ...none };
}

/**
 * The question a message from a person answers.
 *
 * A reply while the bot waits on a person has always been that question's
 * answer. It was the answer whatever the reply was about, though: a message
 * about #16 answered a question about #15, and the panel had said it would be
 * posted on #16. With a subject, only a question about that subject is
 * answered; without one, as an older console sends it, any question this bot
 * is waiting on is.
 */
export function gateToAnswer<G extends Pick<Gate, 'id'>>(
  open: readonly { gate: G; task: { botId: string; subjectRef: string } | null }[],
  botId: string,
  subject: string | null,
): G | null {
  const mine = open.filter((entry) => entry.task?.botId === botId);
  const found = subject === null ? mine[0] : mine.find((entry) => entry.task?.subjectRef === subject);
  return found?.gate ?? null;
}

/** What an install that does not know who is asking calls them: the console's fallback, and the bridge's. */
const NOBODY_IN_PARTICULAR = new Set(['console', 'local operator']);

/** What a comment calls a console person when the install does not know who it was. */
export const SOMEONE_IN_THE_CONSOLE = 'a person in the OpenADLC console';

/**
 * How anything the bridge posts on GitHub names a person: by name, never by
 * address. Behind IAP a console identity is the person's verified email, and
 * a comment is public, so `jane@example.com answered` put a staff address in
 * front of anyone reading the repository. A GitHub login has no `@` and is
 * shown as it is. The full identity stays in the audit log, the gate record
 * and the console thread.
 */
export function publicNameOf(identity: string): string {
  const name = identity.replace(/^accounts\.google\.com:/, '').split('@')[0]?.trim() ?? '';
  return !name || NOBODY_IN_PARTICULAR.has(name) ? SOMEONE_IN_THE_CONSOLE : name;
}

/**
 * How a message posted on GitHub for somebody says who wrote it. The bot's
 * account posts it, because that is the account the bridge can act as, so the
 * comment has to name the person (`publicNameOf`).
 */
export function consoleMessageBody(identity: string, text: string): string {
  const name = publicNameOf(identity);
  const heading = name === SOMEONE_IN_THE_CONSOLE ? '**Written in the OpenADLC console:**' : `**${name}** wrote in the OpenADLC console:`;
  // Posted as the bot, with its seat tag and signature: a marker in the
  // person's words would read as the bot's own (`inertMarkup`).
  return `${heading}\n\n${inertMarkup(text.trim())}`;
}
