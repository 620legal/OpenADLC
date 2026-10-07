import {
  collaboratorsUrl,
  fileLineUrl,
  isTemplatePlaceholder,
  loginsNamed,
  type ConfigFiles,
  type ReviewerStanding,
} from '@fleetadlc/github';
import { unreadableHumanReviewLines, type HealthAction, type HealthSeverity } from '@fleetadlc/shared';
import { GITHUB_CALLS_AT_ONCE, SLOW_CHECK_MS, mapLimited } from '../limited.js';
import type { CheckResult, HealthCheck } from '../types.js';
import type { RepoRef } from './crew.js';

/** One thing wrong in a repository's configuration, where it is, and what fixes it. */
export interface ConfigFinding {
  /**
   * What kind of mistake: `reviewer-placeholder`, `reviewer-missing`,
   * `reviewer-not-a-person`, `reviewer-cannot-review`, `mention-missing`,
   * `human-review-unreadable`.
   */
  kind: string;
  severity: HealthSeverity;
  file: string;
  /** Counting from 1. */
  line: number;
  login?: string;
  /** What is wrong, in the sentence a person reads first. */
  problem: string;
  /** What to do about it. */
  fix: string;
  /** Where it is done, on GitHub. */
  actions: { label: string; url: string }[];
}

/** What an inspection is given: one repository and its configuration files as they are on its default branch. */
export interface ConfigSubject {
  repo: RepoRef;
  files: ConfigFiles;
}

/**
 * One kind of mistake the configuration check looks for. Each reads the same
 * files, read once per run, and says what it found and what it could not
 * verify. Another kind of mistake is another inspection in the list
 * `repoConfigCheck` is given; nothing else changes.
 */
export interface ConfigInspection {
  id: string;
  /**
   * `unverified` is the reviewers GitHub did not say can review there;
   * `unverifiedMentions` the mentioned logins it did not say exist, which is
   * all a mention is asked.
   */
  inspect(subject: ConfigSubject): Promise<{ findings: ConfigFinding[]; unverified: string[]; unverifiedMentions?: string[] }>;
}

/**
 * Every login the configuration names, asked of GitHub: a reviewer (a Human
 * review rule, a code owner) must be a person's account that can review in
 * the repository; a mention only has to exist, and is asked only that, which
 * costs one call rather than two.
 *
 * A reviewer who cannot is blocking, because GitHub refuses to ask them and the
 * review gate would wait on them for ever. A mention of nobody stops nothing,
 * and is a warning. A login GitHub could not be asked about is unverified, never
 * a finding: a rate limit is not a missing account.
 *
 * `@owner` in AGENTS.md's Human review is not asked about at all: it is the
 * placeholder from OpenADLC's template, and what fixes it is naming somebody.
 */
export function namedLoginsInspection(
  standing: (repo: string, login: string) => Promise<ReviewerStanding>,
  exists: (login: string) => Promise<boolean | null>,
): ConfigInspection {
  return {
    id: 'named-logins',
    async inspect({ repo, files }) {
      const findings: ConfigFinding[] = [];
      const unverified = new Set<string>();
      const unverifiedMentions = new Set<string>();
      const standings = new Map<string, ReviewerStanding>();
      const existing = new Map<string, boolean | null>();
      const standingOf = async (login: string): Promise<ReviewerStanding> => {
        const key = login.toLowerCase();
        let answer = standings.get(key);
        if (!answer) {
          answer = await standing(repo.fullName, login).catch(
            (error: unknown): ReviewerStanding => ({ state: 'unknown', reason: error instanceof Error ? error.message : String(error) }),
          );
          standings.set(key, answer);
        }
        return answer;
      };
      const existsNow = async (login: string): Promise<boolean | null> => {
        const key = login.toLowerCase();
        // A reviewer's answer already says whether the account exists.
        const known = standings.get(key);
        if (known && known.state !== 'unknown') return known.state !== 'no-account';
        if (!existing.has(key)) existing.set(key, await exists(login).catch(() => null));
        return existing.get(key) ?? null;
      };

      for (const named of loginsNamed(files)) {
        const fileLink = { label: `Open ${named.file} on GitHub`, url: fileLineUrl(repo.fullName, repo.defaultBranch, named.file, named.line) };
        const where = `${repo.fullName}’s ${named.file}`;

        if (named.as === 'mention') {
          const found = await existsNow(named.login);
          if (found === null) unverifiedMentions.add(named.login);
          else if (!found) {
            findings.push({
              kind: 'mention-missing',
              severity: 'warning',
              file: named.file,
              line: named.line,
              login: named.login,
              problem: `\`${named.login}\` is mentioned in ${where}, but there is no such GitHub account`,
              fix: `Change or remove the name on line ${named.line} of ${named.file}.`,
              actions: [fileLink],
            });
          }
          continue;
        }

        if (named.as === 'human-review' && isTemplatePlaceholder(named.login)) {
          findings.push({
            kind: 'reviewer-placeholder',
            severity: 'blocking',
            file: named.file,
            line: named.line,
            login: named.login,
            problem: `${where} doesn’t say who approves its human-review paths yet — line ${named.line} still has the template’s \`@${named.login}\``,
            fix: `Say who approves them on the Protect the repositories step, which writes them here — or replace it on line ${named.line} with the logins who must approve these paths.`,
            actions: [fileLink],
          });
          continue;
        }

        const answer = await standingOf(named.login);
        if (answer.state === 'unknown') {
          unverified.add(named.login);
        } else if (answer.state === 'no-account') {
          findings.push({
            kind: 'reviewer-missing',
            severity: 'blocking',
            file: named.file,
            line: named.line,
            login: named.login,
            problem: `\`${named.login}\` is named as a reviewer in ${where}, but there is no such GitHub account`,
            fix: `Change or remove the name on line ${named.line} of ${named.file}.`,
            actions: [fileLink],
          });
        } else if (answer.state === 'not-a-person') {
          // Never an invitation: an organization cannot be one, and cannot review.
          findings.push({
            kind: 'reviewer-not-a-person',
            severity: 'blocking',
            file: named.file,
            line: named.line,
            login: named.login,
            problem: `\`${named.login}\` is named as a reviewer in ${where}, but ${answer.reason}`,
            fix:
              // The repository's own organization in CODEOWNERS is what OpenADLC
              // wrote while nobody was named, and the Protect step repairs it.
              named.as === 'code-owner' && named.login.toLowerCase() === repo.fullName.split('/')[0]!.toLowerCase()
                ? `Set the repository up again on the Protect the repositories step, which names the lead reviewer and the people who approve there — or name them on line ${named.line} of ${named.file}, or a team as \`@${named.login}/<team>\`.`
                : named.as === 'code-owner'
                  ? `Name the people who must approve on line ${named.line} of ${named.file}, or a team as \`@${named.login}/<team>\`.`
                  : `Name the people who must approve on line ${named.line} of ${named.file} instead.`,
            actions: [fileLink],
          });
        } else if (answer.state === 'cannot-review') {
          findings.push({
            kind: 'reviewer-cannot-review',
            severity: 'blocking',
            file: named.file,
            line: named.line,
            login: named.login,
            // GitHub's reason: someone with triage or read is a collaborator
            // already, and an invitation, all this card offered them, was
            // nothing GitHub could send.
            problem: `\`${named.login}\` is named as a reviewer in ${where}, but cannot review: ${answer.reason}`,
            fix:
              `Invite them as a collaborator with write, or raise their role to write or more, on ${repo.fullName}’s ` +
              `Collaborators and teams page. Or change the name on line ${named.line} of ${named.file}.`,
            actions: [{ label: `Give ${named.login} write access`, url: collaboratorsUrl(repo.fullName) }, fileLink],
          });
        }
      }
      // A login named both ways is said once, as the reviewer it is.
      const reviewers = new Set([...unverified].map((login) => login.toLowerCase()));
      return {
        findings,
        unverified: [...unverified],
        unverifiedMentions: [...unverifiedMentions].filter((login) => !reviewers.has(login.toLowerCase())),
      };
    },
  };
}

/**
 * A line of AGENTS.md's `## Human review` the bridge cannot read: two paths, a
 * team, no path. The whole section then reads as unknown, so the review gate
 * and the merge line hold every pull request in the repository — the safe
 * reading of a rule nobody can read — and the only sign was a gate that said
 * it could not read the rules. This names the line and what is wrong with it.
 */
export function humanReviewLinesInspection(): ConfigInspection {
  return {
    id: 'human-review-lines',
    async inspect({ repo, files }) {
      const findings = unreadableHumanReviewLines(files.text.get('AGENTS.md') ?? null).map(
        (unreadable): ConfigFinding => ({
          kind: 'human-review-unreadable',
          severity: 'blocking',
          file: 'AGENTS.md',
          line: unreadable.line,
          problem: `${repo.fullName}’s AGENTS.md has a Human review rule OpenADLC cannot read on line ${unreadable.line}: ${unreadable.reason}`,
          fix:
            `Write line ${unreadable.line} as one path or glob, then the logins who must approve it. Until then every pull request ` +
            `in ${repo.fullName} waits, because a rule that cannot be read is taken to apply.`,
          actions: [
            { label: 'Open AGENTS.md on GitHub', url: fileLineUrl(repo.fullName, repo.defaultBranch, 'AGENTS.md', unreadable.line) },
          ],
        }),
      );
      return { findings, unverified: [] };
    },
  };
}

export interface RepoConfigReader {
  repositories(): Promise<RepoRef[]>;
  /** The configuration files on the default branch; null when GitHub cannot be asked at all. */
  files(repo: RepoRef): Promise<ConfigFiles | null>;
  /** The install's own people (`FLEETADLC_HUMANS`), whose logins are checked too. */
  humans(): Promise<string[]>;
  /** Whether a GitHub account by this login exists; null when GitHub did not say. */
  exists(login: string): Promise<boolean | null>;
  /**
   * Of the install's people, the logins pinned to one GitHub account that now
   * name another, or none (`movedHumans` in human-ids.ts), and those GitHub
   * did not answer for.
   */
  movedHumans?(humans: readonly string[]): Promise<{ moved: { login: string; pinned: number; now: number | false }[]; unknown: string[] }>;
}

/** The subject of the install's own people, beside one per repository. */
export const HUMANS_SUBJECT = 'FLEETADLC_HUMANS';

/** The subject of the install's people's pinned accounts. */
export const HUMAN_IDS_SUBJECT = 'FLEETADLC_HUMANS accounts';

/** A finding's line on the card: where, what, and the fix. */
function findingLine(finding: ConfigFinding): string {
  return `- **${finding.file}, line ${finding.line}:** ${finding.problem}. ${finding.fix}`;
}

/**
 * Each managed repository's configuration says what OpenADLC and GitHub can do:
 * the files on its default branch name nobody who does not exist, and every
 * reviewer they name can review there.
 *
 * Found by OpenADLC itself, rather than by a pull request that waits for good:
 * a Human review rule naming an account that did not exist held every pull
 * request touching its path, and the only sign was a gate that never finished.
 *
 * Every answer from GitHub is written to the shared kept answers (the
 * `standing` that namedLoginsInspection is given), which is how a pull request's gate learns of it without asking
 * GitHub itself.
 */
export function repoConfigCheck(reader: RepoConfigReader, inspections: readonly ConfigInspection[]): HealthCheck {
  return {
    id: 'repo-config',
    proves: 'Each repository’s configuration names only people who exist, and reviewers who can review there',
    how: 'reads AGENTS.md, CODEOWNERS, the pull request template and the workflow on each default branch, and asks GitHub about every login they name',
    everyMinutes: 30,
    steps: [],
    timeoutMs: SLOW_CHECK_MS,
    async run(): Promise<CheckResult[]> {
      // Several reads per repository, and two per login it names: asked a
      // few repositories at a time, not one by one.
      const results = await mapLimited(await reader.repositories(), GITHUB_CALLS_AT_ONCE, async (repo): Promise<CheckResult> => {
        const subject = repo.fullName;
        const files = await reader.files(repo).catch(() => null);
        if (!files) {
          return { subject, ok: null, reason: `GitHub could not be asked for ${repo.fullName}’s configuration` };
        }
        const findings: ConfigFinding[] = [];
        const unverified: string[] = [];
        const unverifiedMentions: string[] = [];
        for (const inspection of inspections) {
          const found = await inspection.inspect({ repo, files });
          findings.push(...found.findings);
          unverified.push(...found.unverified);
          unverifiedMentions.push(...(found.unverifiedMentions ?? []));
        }
        if (findings.length === 0) {
          if (unverified.length > 0 || unverifiedMentions.length > 0 || files.unreadable.length > 0) {
            // A mention is only asked whether the account exists, and "can
            // review there" said of it was a question nobody had asked.
            const parts = [
              ...(files.unreadable.length > 0 ? [`GitHub would not give ${files.unreadable.join(', ')}`] : []),
              ...(unverified.length > 0 ? [`GitHub did not say whether ${unverified.join(', ')} can review there`] : []),
              ...(unverifiedMentions.length > 0 ? [`GitHub did not say whether ${unverifiedMentions.join(', ')} ${unverifiedMentions.length === 1 ? 'exists' : 'exist'}`] : []),
            ];
            return { subject, ok: null, reason: `Could not verify ${repo.fullName}’s configuration: ${parts.join('; ')}. Nothing is called wrong on a guess.` };
          }
          return { subject, ok: true, fixed: `Everyone ${repo.fullName}’s configuration names can review there again` };
        }
        const first = findings.find((finding) => finding.severity === 'blocking') ?? findings[0]!;
        const actions: HealthAction[] = [];
        for (const action of findings.flatMap((finding) => finding.actions)) {
          if (!actions.some((seen) => 'url' in seen && seen.url === action.url)) actions.push(action);
        }
        // Only a reviewer holds a pull request up, and only an invitation lets
        // one who cannot review do so: said of a card of missing mentions,
        // both sent a person after a wait and an invitation that were not there.
        const reviewers = findings.some((finding) => finding.kind.startsWith('reviewer-'));
        const invitable = findings.some((finding) => finding.kind === 'reviewer-cannot-review');
        return {
          subject,
          ok: false,
          severity: findings.some((finding) => finding.severity === 'blocking') ? 'blocking' : 'warning',
          title: findings.length === 1 ? first.problem : `${first.problem} (and ${findings.length - 1} more in ${repo.fullName}’s configuration)`,
          detail:
            `${findings.map(findingLine).join('\n')}\n\n` +
            (reviewers ? 'A pull request that needs one of these reviewers waits for good: GitHub will not ask them. ' : '') +
            `This clears on the next check once the file is changed on the default branch${invitable ? ' or the person can write to the repository' : ''}.`,
          action: actions[0]!,
          facts: {
            repository: repo.fullName,
            subject: { repo: repo.name },
            findings,
            // The rest of what fixes it, after `action`; see `attention.ts`.
            actions: actions.slice(1, 4),
          },
        };
      });

      const humans = await reader.humans().catch(() => []);
      if (humans.length > 0) {
        const missing: string[] = [];
        const unknown: string[] = [];
        for (const login of humans) {
          const exists = await reader.exists(login).catch(() => null);
          if (exists === false) missing.push(login);
          else if (exists === null) unknown.push(login);
        }
        if (missing.length > 0) {
          results.push({
            subject: HUMANS_SUBJECT,
            ok: false,
            severity: 'warning',
            title: `\`${missing[0]}\` is one of this install’s people (FLEETADLC_HUMANS), but there is no such GitHub account`,
            detail:
              `${missing.map((login) => `- \`${login}\``).join('\n')}\n\n` +
              'Nobody by that name can answer a question from GitHub or be asked for a review. ' +
              'A list saved in the console (the Protect the repositories step’s approvers) wins over FLEETADLC_HUMANS, and Settings has no field for it: ' +
              'as an admin, send PATCH /v1/install {"humans": "<login>,…"}, or an empty value to go back to FLEETADLC_HUMANS. ' +
              'Without a saved list, correct FLEETADLC_HUMANS, or humans in install.json, and restart the bridge.',
            action: { label: 'Open settings', href: '/settings' },
            facts: { missing },
          });
        } else if (unknown.length > 0) {
          results.push({ subject: HUMANS_SUBJECT, ok: null, reason: `GitHub did not say whether ${unknown.join(', ')} exist` });
        } else {
          results.push({ subject: HUMANS_SUBJECT, ok: true, fixed: 'Every one of the install’s people has a GitHub account again' });
        }

        // A login is only a name: once its account is renamed or deleted,
        // anyone can register it, and they would have answered gates as one
        // of the install's people. Each is pinned to its account, and a
        // login that names another one now is said here.
        const pins = reader.movedHumans ? await reader.movedHumans(humans).catch(() => null) : null;
        if (pins && pins.moved.length > 0) {
          const first = pins.moved[0]!;
          results.push({
            subject: HUMAN_IDS_SUBJECT,
            ok: false,
            severity: 'warning',
            title:
              first.now === false
                ? `\`${first.login}\`, one of this install’s people, no longer has a GitHub account`
                : `\`${first.login}\`, one of this install’s people, now belongs to a different GitHub account`,
            detail:
              `${pins.moved.map((moved) => `- \`${moved.login}\`: pinned to account ${moved.pinned}, ${moved.now === false ? 'and there is no account by that login now' : `and the login names account ${moved.now} now`}`).join('\n')}\n\n` +
              'OpenADLC counts nothing from that login now: not a reply to a question on GitHub, not an approval it acts on. ' +
              'If it is still the same person, under an account they made again, re-confirm them: take the login out of the install’s people in Settings, save, then put it back, which pins the account it names now. ' +
              'Otherwise remove it.',
            action: { label: 'Open settings', href: '/settings' },
            facts: { moved: pins.moved },
          });
        } else if (pins && pins.unknown.length > 0) {
          results.push({ subject: HUMAN_IDS_SUBJECT, ok: null, reason: `GitHub did not say which account ${pins.unknown.join(', ')} ${pins.unknown.length === 1 ? 'is' : 'are'} now` });
        } else if (pins) {
          results.push({ subject: HUMAN_IDS_SUBJECT, ok: true, fixed: 'Each of the install’s people is the GitHub account it was pinned to again' });
        }
      }
      return results;
    },
  };
}
