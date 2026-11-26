import { rulesetSettingsUrl, tagBlockedDetail, tagCreationBlockers, type RuleApi } from '@openadlc/github';
import type { CheckResult, HealthCheck } from '../types.js';

export const RELEASE_TAG_RULES_CHECK = 'release-tag-rules';

export interface ReleaseTagRulesReader {
  /** Every repository set to release, with where it publishes (`repos.releasing`). */
  releasing(): Promise<{ fullName: string; releaseRepo: string | null }[]>;
  /** The app's own client on a repository (`AppGate.client`), or null where it is not installed. */
  app(repoFullName: string): Promise<RuleApi | null>;
  /** The last published release's version on a repository, `v` taken off, or null for none; throws when it cannot be read. */
  lastVersion(repoFullName: string): Promise<string | null>;
}

/**
 * The tag the next release would most likely take: `v` and the last
 * published version with its last number raised by one, else `v0.0.1`. The
 * publish's preflight judges the exact tag; this is for the card, which a
 * ruleset over `v*` answers the same for either.
 */
export function likelyNextTag(last: string | null): string {
  if (!last) return 'v0.0.1';
  const raised = last.replace(/(\d+)(?!.*\d)/, (digits) => String(Number(digits) + 1));
  return `v${raised}`;
}

/**
 * Whether OpenADLC's app may create a release's tag (#344, docs/adr/0071): a
 * step only a person can do, where a tag ruleset lets only its bypass list
 * create tags. The app is added as a bypass actor, set to Always.
 *
 * Quiet while nothing releases, so it is not in `MANUAL_STEPS`: like the
 * release account's card, it shows only for a repository that releases. For
 * each one it judges the source repository, where the built commit is
 * tagged, and the release repository, where the release is made; and it says
 * when the app is not installed on a separate release repository, which no
 * other check covers.
 *
 * Proved by its effect: the rulesets GitHub applies to the tag, read with the
 * app's own token, and GitHub's `current_user_can_bypass` for the app. A
 * ruleset whose read carries none is no answer, never "fine".
 */
export function releaseTagRulesCheck(reader: ReleaseTagRulesReader): HealthCheck {
  return {
    id: RELEASE_TAG_RULES_CHECK,
    proves: 'OpenADLC’s app may create release tags in every repository that releases, and where it publishes them',
    how:
      'reads, as the app, each tag ruleset GitHub applies to the repository (its own and its organization’s) and whether the app may bypass it, ' +
      'for the tag the next release would most likely take',
    everyMinutes: 30,
    steps: [],
    async run() {
      const releasing = await reader.releasing();
      const results: CheckResult[] = [];
      const judged = new Set<string>();
      for (const { fullName: source, releaseRepo } of releasing) {
        const target = releaseRepo ?? source;
        let tag: string;
        try {
          tag = likelyNextTag(await reader.lastVersion(target));
        } catch (error) {
          for (const name of new Set([source, target])) {
            if (judged.has(name.toLowerCase())) continue;
            judged.add(name.toLowerCase());
            results.push({ subject: name, ok: null, reason: `the last release of ${target} could not be read: ${error instanceof Error ? error.message : String(error)}` });
          }
          continue;
        }
        for (const name of new Set([source, target])) {
          if (judged.has(name.toLowerCase())) continue;
          judged.add(name.toLowerCase());
          results.push(await judgeReleaseTag(reader, name, source, tag, name !== source));
        }
      }
      return results;
    },
  };
}

/**
 * Whether the app may create `tag` on `name`: the card's judgement of one
 * repository, exported so the release page's readiness (#371, docs/adr/0084)
 * judges the head's tag the same way.
 */
export async function judgeReleaseTag(
  reader: Pick<ReleaseTagRulesReader, 'app'>,
  name: string,
  source: string,
  tag: string,
  isReleaseRepo: boolean,
): Promise<CheckResult> {
  const api = await reader.app(name).catch(() => null);
  if (!api) {
    if (!isReleaseRepo) return { subject: name, ok: null, reason: `OpenADLC's app cannot be asked about ${name}; the app's own checks say why` };
    return {
      subject: name,
      ok: false,
      severity: 'warning',
      title: `OpenADLC's app is not installed on ${name}; releases of ${source} cannot publish there`,
      detail: `${source} publishes its releases to ${name}, and OpenADLC's app is not installed there, so a release is built and signed, then publishes nothing. Install the app on ${name}.`,
      action: { label: 'Install the app', url: `https://github.com/${name}/settings/installations` },
    };
  }
  let found: Awaited<ReturnType<typeof tagCreationBlockers>>;
  try {
    found = await tagCreationBlockers(api, name, tag);
  } catch (error) {
    return { subject: name, ok: null, reason: `the tag rulesets of ${name} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const block = found.blocked[0];
  if (block) {
    return {
      subject: name,
      ok: false,
      severity: 'warning',
      title: `OpenADLC's app cannot create release tags on ${name}`,
      detail: tagBlockedDetail(block, tag, source),
      action: { label: 'Open the ruleset', url: rulesetSettingsUrl(block, name) },
      facts: { ruleset: block.id, bypass: block.bypass, tag },
    };
  }
  const unknown = found.unknown[0];
  if (unknown) {
    return { subject: name, ok: null, reason: `GitHub did not say whether OpenADLC's app may bypass the tag ruleset “${unknown.name}” of ${name}, which covers ${tag}` };
  }
  return { subject: name, ok: true, says: `OpenADLC's app may create v… tags on ${name} (judged for ${tag})`, fixed: `OpenADLC's app may create release tags on ${name} again` };
}
