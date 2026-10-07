import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Where a repository keeps its delivery rules: on its default branch, so a
 * change to them is a pull request. One that touches `.github/` changes how CI
 * runs (`changesCi`), so `mergeDecision` in the bridge merges it only once the
 * security reviewer approves that diff, or leaves it to a person where
 * `ciMergeByPerson` lists the repository or no security seat is set up.
 */
export const DELIVERY_RULES_PATH = '.github/fleetadlc.yml';

/**
 * Files nearly every change adds a line to. Two changes to one of them rarely
 * truly conflict, and when they do the merge line catches it on the up-to-date
 * head; holding every other build back for them made a repository build one
 * thing at a time — #3 waited for #2 on the Makefile, #6 for #1 on README.md.
 */
export const DEFAULT_SHARED_PATHS: readonly string[] = [
  'Makefile',
  'makefile',
  'GNUmakefile',
  'README*',
  'CHANGELOG*',
  'docs/**/index*',
  'package.json',
  '.gitignore',
  'AGENTS.md',
];

/**
 * Files where two changes in flight break each other even when they merge
 * cleanly: migrations numbered in order, lockfiles, generated code, schemas.
 */
export const DEFAULT_EXCLUSIVE_PATHS: readonly string[] = [
  '**/migrations/**',
  '*lock*.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'go.sum',
  '**/generated/**',
  '*.schema.*',
];

/**
 * Which overlap holds a build back (`paths:` in `.github/fleetadlc.yml`). A
 * pattern without a `/` names a file by its name at any depth; one with a `/`
 * is a path from the repository's root, `*` and `**` as wildcards.
 *
 * - `shared`: overlap here never holds anything back.
 * - `exclusive`: overlap holds the next change back until the one in flight
 *   has merged, through its review.
 * - anything else holds it back only while the other change is being built.
 */
export const pathPolicySchema = z.object({
  shared: z.array(z.string().min(1)).default([...DEFAULT_SHARED_PATHS]),
  exclusive: z.array(z.string().min(1)).default([...DEFAULT_EXCLUSIVE_PATHS]),
});
export type PathPolicy = z.output<typeof pathPolicySchema>;

/** The policy a repository that says nothing gets: optimistic. */
export const DEFAULT_PATH_POLICY: PathPolicy = pathPolicySchema.parse({});

/**
 * How a repository ships, as `.github/fleetadlc.yml` says.
 *
 * Shipping used to be a person's step: the deploy bot opened a task, and a
 * person approved production in GitHub. These rules make it the repository's:
 * a merge deploys to testing, a green smoke run promotes, and production waits
 * only on what GitHub's environment holds it for — its required reviewers, or
 * its wait timer as the soak. OpenADLC dispatches the workflows as the app and
 * never approves an environment for anybody.
 *
 *     version: 1
 *     testing:
 *       on: merge                    # or none: merging is shipping
 *       url: https://testing.example.com
 *       workflow: deploy-testing
 *       smoke: smoke-testing
 *     production:
 *       on: after-testing            # or none: testing is as far as it goes
 *       approval: reviewers          # or auto: the environment's wait timer is the soak
 *       soakMinutes: 0
 *       workflow: promote-production
 *       rollback: rollback-production
 *     paths:
 *       shared: [Makefile, README*]    # overlap here never holds a build back
 *       exclusive: [db/migrations/**]  # overlap here waits for the change in flight to merge
 *
 * The same file's `stacking:` is read by `path-policy.ts`, not by this schema.
 */
export const deliveryRulesSchema = z.object({
  version: z.literal(1),
  /** Which overlapping changes may be built side by side; see `pathPolicySchema`. */
  paths: pathPolicySchema.default({ shared: [...DEFAULT_SHARED_PATHS], exclusive: [...DEFAULT_EXCLUSIVE_PATHS] }),
  testing: z
    .object({
      on: z.enum(['merge', 'none']).default('merge'),
      /**
       * Where testing is served. Without one the bridge opens no QA run, and
       * with one it names it in what it reports. http(s) only, as the console's
       * setting is: `url()` alone took `file:` and `javascript:` too.
       */
      url: z
        .string()
        .url()
        .refine((url) => /^https?:\/\//i.test(url), 'testing.url is an http(s) address')
        .optional(),
      workflow: z.string().min(1).default('deploy-testing'),
      smoke: z.string().min(1).default('smoke-testing'),
    })
    .default({ on: 'merge', workflow: 'deploy-testing', smoke: 'smoke-testing' }),
  production: z
    .object({
      on: z.enum(['after-testing', 'none']).default('after-testing'),
      /**
       * `auto` (the default): nobody is asked, and the environment's wait
       * timer (`soakMinutes`) is the soak; the smoke and the rollback on a
       * failed deploy do the rest. `reviewers`: the `production` environment's
       * required reviewers hold the deploy until a person approves it in
       * GitHub, or, where the plan cannot hold one, OpenADLC holds it for a
       * person in Needs you.
       *
       * The default was `reviewers` with nobody to name: production was
       * written with no reviewer and a promote ran unseen. A repository asks
       * how production ships when it is set up instead (`repos.production_*`),
       * and a field the rules leave out takes that answer before this default
       * (`ProductionChoice`).
       */
      approval: z.enum(['reviewers', 'auto']).default('auto'),
      soakMinutes: z.number().int().min(0).max(43_200).default(30),
      workflow: z.string().min(1).default('promote-production'),
      rollback: z.string().min(1).default('rollback-production'),
    })
    .default({ on: 'after-testing', approval: 'auto', soakMinutes: 30, workflow: 'promote-production', rollback: 'rollback-production' }),
});
export type DeliveryRules = z.output<typeof deliveryRulesSchema>;

/** What a repository with no rules of its own gets: deploy to testing on merge, and production after a 30-minute soak and the smoke. */
export const DEFAULT_DELIVERY_RULES: DeliveryRules = deliveryRulesSchema.parse({ version: 1 });

/** Rules that ship by merging: no testing deploy, nothing to promote. */
export const MERGE_IS_SHIPPING: DeliveryRules = deliveryRulesSchema.parse({ version: 1, testing: { on: 'none' }, production: { on: 'none' } });

/**
 * The rules a `.github/fleetadlc.yml` holds, or why it holds none.
 *
 * A file that does not parse is said, not guessed around: a typo that turned
 * `approval: reviewers` into nothing must not read as the default, and the
 * caller falls back on the repository's stored rules with the error shown
 * where the rules are.
 */
export function parseDeliveryRules(text: string, choice: ProductionChoice = {}): { rules: DeliveryRules } | { error: string } {
  return parseDeliveryRulesText(text, choice);
}

/**
 * A repository's recorded answer to "how does production ship", asked when
 * it is set up (`repos.production_approval`, `production_soak_minutes`). It
 * fills what the rules leave out — `production.approval` or
 * `production.soakMinutes` absent from the file or the stored rules — before
 * the schema's default does. So a repository that was there before the
 * default changed keeps `reviewers`, as recorded, rather than changing mode
 * in silence.
 */
export interface ProductionChoice {
  approval?: 'reviewers' | 'auto' | null;
  soakMinutes?: number | null;
}

/**
 * The raw rules with the recorded choice put where they say nothing. Read
 * from the raw object: once parsed, an absent field and the default look the
 * same.
 */
function withChoice(raw: unknown, choice: ProductionChoice): unknown {
  const fill: Record<string, unknown> = {};
  if (choice.approval) fill.approval = choice.approval;
  if (typeof choice.soakMinutes === 'number') fill.soakMinutes = choice.soakMinutes;
  if (Object.keys(fill).length === 0 || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const rules = raw as Record<string, unknown>;
  const production = rules.production;
  if (production !== undefined && (production === null || typeof production !== 'object' || Array.isArray(production))) return raw;
  return { ...rules, production: { ...fill, ...((production as Record<string, unknown> | undefined) ?? {}) } };
}

/**
 * Whether a `.github/fleetadlc.yml` says how production is approved itself
 * (`production.approval`). Where it does, repository setup shows that rule
 * as the file's and asks nothing: the file wins over a recorded choice.
 */
export function rulesSetApproval(text: string | null): boolean {
  if (!text) return false;
  try {
    const raw = parseYaml(text) as { production?: { approval?: unknown } } | null;
    return Boolean(raw && typeof raw === 'object' && raw.production && typeof raw.production === 'object' && raw.production.approval !== undefined);
  } catch {
    return false;
  }
}

/** The default rules with the recorded choice applied. */
export function defaultDeliveryRules(choice: ProductionChoice = {}): DeliveryRules {
  return deliveryRulesSchema.parse(withChoice({ version: 1 }, choice));
}

/**
 * The rules from what there is: the file's text when it is there and parses,
 * else the repository's stored rules when they parse, else the default. For a
 * caller with no settings choice to fall back on — `fleetadlc github apply`,
 * which writes the production environment the rules call for.
 */
export function deliveryRulesFrom(fileText: string | null, stored: unknown | null, choice: ProductionChoice = {}): DeliveryRules {
  if (fileText !== null) {
    const parsed = parseDeliveryRulesText(fileText, choice);
    if ('rules' in parsed) return parsed.rules;
  }
  if (stored !== null && stored !== undefined) {
    const parsed = deliveryRulesSchema.safeParse(withChoice(stored, choice));
    if (parsed.success) return parsed.data;
  }
  return defaultDeliveryRules(choice);
}

/** The stored rules (`repos.delivery_rules`) as rules, with the recorded choice where they say nothing; null when they do not parse. */
export function storedDeliveryRules(stored: unknown, choice: ProductionChoice = {}): DeliveryRules | null {
  const parsed = deliveryRulesSchema.safeParse(withChoice(stored, choice));
  return parsed.success ? parsed.data : null;
}

function parseDeliveryRulesText(text: string, choice: ProductionChoice = {}): { rules: DeliveryRules } | { error: string } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return { error: `${DELIVERY_RULES_PATH} is not YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
  }
  const parsed = deliveryRulesSchema.safeParse(withChoice(raw ?? {}, choice));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? first.path.join('.') : 'the file';
    return { error: `${DELIVERY_RULES_PATH}: ${where}: ${first?.message ?? 'not valid'}` };
  }
  return { rules: parsed.data };
}
