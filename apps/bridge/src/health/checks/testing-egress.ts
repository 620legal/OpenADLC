import { EGRESS_NAMES_PER_ASK, egressListAllows, type EgressAnswer, type EgressReport } from '@openadlc/shared';
import type { CheckResult, HealthCheck } from '../types.js';

/** The check's id, which a save in Settings → Egress asks to run again. */
export const TESTING_EGRESS_CHECK = 'testing-egress';

/**
 * The step the card names, in the words the `qa` skill's "not run" uses too
 * (tests/skills.test.ts holds them to it): Settings, which hostd puts on the
 * proxy at once, or the operator's own fixed list and an apply.
 */
export const EGRESS_STEPS = ['Settings → Egress', 'extra_allowed_domains', 'openadlc cloud apply'] as const;

/** Where the card's button goes: Settings → Egress, with the host offered for a person to allow, not allowed. */
export function allowHostHref(host: string): string {
  return `/settings?allow-host=${encodeURIComponent(host)}#egress`;
}

export interface TestingEgressReader {
  repos(): Promise<{ name: string; fullName: string }[]>;
  /** Where the repository's testing is served, as its QA task is given it; null for none. Throws when that could not be read. */
  testingUrl(repo: { name: string; fullName: string }): Promise<string | null>;
  /** What the host's egress proxy says of each name, asked through hostd, at most `EGRESS_NAMES_PER_ASK` at once. Throws when hostd could not be asked. */
  egress(hosts: string[]): Promise<EgressReport>;
  /** The names an admin allowed in Settings, to say so of a refused one already among them. */
  allowed(): Promise<string[]>;
}

/**
 * Each managed repository's testing URL is a host a cloud host's tasks may
 * reach.
 *
 * A cloud host's tasks leave only through its egress proxy. On the first
 * cloud install a repository's `testing.url` was on none of its lists, every
 * request its QA task made there was refused, the task reported "not run",
 * and nobody was told the fix; the merge's only evidence was the Actions
 * smoke. Judged by effect: hostd asks the proxy what it would do with a
 * task's CONNECT to the host (`apps/hostd/src/egress.ts`), which answers for
 * the module's list, `extra_allowed_domains` and Settings' list at once, as
 * the proxy holds them now. A laptop's tasks leave through no proxy, so it
 * says nothing there. It only reads: the host goes on a list when a person
 * puts it there, never because a repository's file names it.
 */
export function testingEgressCheck(reader: TestingEgressReader): HealthCheck {
  return {
    id: TESTING_EGRESS_CHECK,
    proves: 'The QA tasks of each repository with a testing URL can reach it through the cloud host’s egress proxy',
    how: 'asks hostd to put the CONNECT a task would make to each testing URL’s host to the egress proxy, and reads whether the proxy refuses it',
    everyMinutes: 15,
    steps: [],
    timeoutMs: 45_000,
    async run() {
      const results: CheckResult[] = [];
      const testing: { repo: { name: string; fullName: string }; url: string; host: string }[] = [];
      for (const repo of await reader.repos()) {
        let url: string | null;
        try {
          url = await reader.testingUrl(repo);
        } catch (error) {
          results.push({ subject: repo.fullName, ok: null, reason: `where its testing is served could not be read: ${messageOf(error)}` });
          continue;
        }
        if (!url) continue;
        let host: string;
        try {
          host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
        } catch {
          results.push({ subject: repo.fullName, ok: null, reason: `its testing URL, ${url}, is not a URL` });
          continue;
        }
        testing.push({ repo, url, host });
      }
      if (testing.length === 0) return results;

      // In batches: hostd asks about at most so many names at once, and a
      // host past them would get no answer and never raise a card.
      const hosts = [...new Set(testing.map((one) => one.host))];
      const answers: EgressAnswer[] = [];
      let report: EgressReport | undefined;
      try {
        for (let start = 0; start < hosts.length; start += EGRESS_NAMES_PER_ASK) {
          report = await reader.egress(hosts.slice(start, start + EGRESS_NAMES_PER_ASK));
          // A laptop: nothing is refused, and there is no list to put a host on.
          if (!report.proxied) return [];
          answers.push(...report.hosts);
        }
      } catch (error) {
        const reason = `the egress proxy could not be asked: ${messageOf(error)}`;
        return [...results, ...testing.map(({ repo }): CheckResult => ({ subject: repo.fullName, ok: null, reason }))];
      }
      const listed = await reader.allowed().catch(() => [] as string[]);

      for (const { repo, url, host } of testing) {
        const answer = answers.find((one) => one.host === host);
        if (!answer || answer.allowed === null) {
          results.push({ subject: repo.fullName, ok: null, reason: answer?.reason ?? `hostd said nothing of ${host}` });
          continue;
        }
        if (answer.allowed) {
          results.push({ subject: repo.fullName, ok: true, fixed: `QA can reach ${repo.fullName}’s testing environment at ${host} now` });
          continue;
        }
        results.push(refused(repo.fullName, url, host, egressListAllows(listed, host), report?.settingsList !== false));
      }
      return results;
    },
  };
}

/** The card for a testing host the proxy refuses. */
function refused(fullName: string, url: string, host: string, listedAs: string | null, readsSettings: boolean): CheckResult {
  const said =
    `${fullName}’s testing URL is ${url}, and this install’s egress proxy, the only way out for its tasks, refuses ${host}: ` +
    'every QA task there reaches nothing and reports “not run”, so a merge’s only evidence is the Actions smoke. ';
  const facts = { host, testingUrl: url };
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':')) {
    return {
      subject: fullName,
      ok: false,
      severity: 'warning',
      title: `QA cannot reach ${fullName}’s testing environment: the egress proxy refuses an address`,
      detail: said + 'The proxy refuses a destination given as an address whatever its lists say. Serve testing on a host name, put it in testing.url, and allow that name.',
      action: { label: 'Open its delivery rules', url: `https://github.com/${fullName}/blob/HEAD/.github/openadlc.yml` },
      facts,
    };
  }
  const how = listedAs
    ? `${EGRESS_STEPS[0]} lists ${listedAs}, and the proxy still refuses it: hostd puts the list on the proxy when it starts and at every save, so save the list again, and if that fails it says why. `
    : `An admin allows ${host} in ${EGRESS_STEPS[0]}, which hostd puts on the proxy at once, with no restart; ` +
      `or the operator adds it to ${EGRESS_STEPS[1]} in the install’s cloud settings and runs ${EGRESS_STEPS[2]}, which resets the host. ` +
      `Allow ${host} itself, not a domain above it: every name under a listed one gets through. `;
  const once = readsSettings
    ? ''
    : 'This host’s proxy reads Settings’ list once the module is applied with this release: pause work, let the running tasks finish, then run openadlc cloud apply, which resets the host once. ';
  return {
    subject: fullName,
    ok: false,
    severity: 'warning',
    title: `QA cannot reach ${fullName}’s testing environment: the egress proxy refuses ${host}`,
    detail: (said + how + once).trim(),
    action: { label: `Allow ${host} in Settings`, href: allowHostHref(host) },
    facts,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
